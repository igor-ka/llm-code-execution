#!/usr/bin/env bash
# Post-deploy verification: what a deploy pipeline owes beyond "the command exited 0".
#
# FIVE defects have reached this deployed service and every one of them passed a fully green
# verify.sh — #185 (the sandbox had no PATH, so no code ran at all), #188 (the service advertised a
# localhost CORS origin), #191 (the quota was rejected on every call and failed OPEN, silently),
# #195 (a cold instance's first concurrent burst is unmetered), and a rollback that reports failure
# after succeeding. docs/plans/2026-08-16-deploy-to-gcp-phase2.md draws the conclusion this script
# acts on: A CHECK THAT CANNOT FAIL THE WAY PRODUCTION FAILS IS NOT A GATE.
#
# So every assertion here is about the DEPLOYED SERVICE rather than the repository, and every one
# is the machine-readable form of a line in docs/runbooks/gcp-deploy.md's "flags that are not
# optional, and what breaks without them".
#
# WHAT THIS DELIBERATELY DOES NOT COVER, because saying so is the point:
#   * that generated code actually runs. The probe needs an authenticated caller.
#   * the quota (#191, #195) and cross-owner history isolation. Both key on the verified `sub`,
#     auth runs first, so NO credential-free request reaches them. Detecting them needs an Auth0
#     machine-to-machine credential held permanently in GitHub for an endpoint that spends money —
#     and docs/runbooks/gcp-isolation-probes.md says to delete those applications when the probes
#     are done. That runbook stays the authority; this script does not pretend otherwise.
#
# Usage: ./scripts/verify-deployment.sh [target] <url>
#   all    (default) shape + http + logs
#   shape  read the service back from the API and assert its deployed shape
#   http   the endpoints an anonymous caller can reach
#   logs   the application's own warnings since the deploy
#
# Environment:
#   PROJECT_ID REGION SERVICE   which service to read back
#   REVISION                    scope the log query to one revision. Set before promotion, empty
#                               after — see logs() for why those want different scopes.
#   LOG_SETTLE_SECONDS          how long to let Cloud Logging catch up before believing silence
#   HTTP_MAX_SECONDS            per-request ceiling, so an unresponsive candidate cannot hang CI
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-all}"
URL="${2:-}"
PROJECT_ID="${PROJECT_ID:-llm-code-exec-260815}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-app}"
REVISION="${REVISION:-}"
LOG_FRESHNESS="${LOG_FRESHNESS:-10m}"
LOG_SETTLE_SECONDS="${LOG_SETTLE_SECONDS:-20}"
HTTP_MAX_SECONDS="${HTTP_MAX_SECONDS:-30}"

if [[ -z "$URL" ]]; then
  echo "usage: $0 [all|shape|http|logs] <service-url>" >&2
  exit 2
fi

# Every curl is bounded. The deploy workflow's concurrency group never cancels in progress, so a
# candidate that accepts a connection and then never answers would hold every later deploy behind
# it until GitHub's six-hour job ceiling. --connect-timeout and --max-time together bound both the
# handshake and the whole exchange.
curl_() { curl -sS --connect-timeout 10 --max-time "$HTTP_MAX_SECONDS" "$@"; }

shape() {
  echo
  echo "==> shape (${SERVICE} in ${PROJECT_ID}/${REGION})"
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json |
    PROJECT_ID="$PROJECT_ID" REGION="$REGION" python3 -c '
import json, os, sys

d = json.load(sys.stdin)
tpl = d["spec"]["template"]
ann = tpl["metadata"].get("annotations", {})
spec = tpl["spec"]
c = spec["containers"][0]
env = {e["name"]: e for e in c.get("env", [])}
project, region = os.environ["PROJECT_ID"], os.environ["REGION"]
# The deployed origin must be the SERVICE url, not the candidate revision url this script may have
# been pointed at — status.url is the one the SPA is served from.
service_url = d.get("status", {}).get("url", "")

failures = []


def want(label, actual, expected, why):
    if actual == expected:
        print("    ok   %s = %r" % (label, actual))
    else:
        failures.append("%s: expected %r, got %r\n         %s" % (label, expected, actual, why))


want("sandboxLauncher", c.get("sandboxLauncher"), True,
     "no /usr/local/gcp/bin/sandbox in the container, so every execution takes the exit-126 "
     "path. This is the flag Terraform strips on every apply (ADR-0005).")
want("execution-environment", ann.get("run.googleapis.com/execution-environment"), "gen2",
     "--sandbox-launcher requires gen2.")
want("vpc-access-egress", ann.get("run.googleapis.com/vpc-access-egress"), "private-ranges-only",
     "Valkey is a private PSC address; without Direct VPC egress the service starts healthy and "
     "fails every quota lookup silently.")
want("cloudsql-instances", ann.get("run.googleapis.com/cloudsql-instances"),
     "%s:%s:app-db" % (project, region), "no Unix socket, so history has no database.")
want("maxScale", ann.get("autoscaling.knative.dev/maxScale"), "2",
     "max-instances bounds a runaway bill on a fixed budget.")
want("serviceAccountName", spec.get("serviceAccountName"),
     "app-runtime@%s.iam.gserviceaccount.com" % project,
     "omitting it runs the service as the Compute Engine default account, which holds Editor.")
want("containerConcurrency", spec.get("containerConcurrency"), 8,
     "at 4 the sandbox concurrency cap could never fire and its 503 path is dead code (D12).")
want("cpu", c.get("resources", {}).get("limits", {}).get("cpu"), "2",
     "sandboxes share the instance allocation (D7); it must hold four executions plus the app.")
want("memory", c.get("resources", {}).get("limits", {}).get("memory"), "2Gi", "as above.")

try:
    nics = json.loads(ann.get("run.googleapis.com/network-interfaces", "[]"))
except ValueError:
    nics = []
want("network-interfaces", [(n.get("network"), n.get("subnetwork")) for n in nics],
     [("app-net", "app-subnet")], "Valkey lives at a private PSC address inside app-net.")

for name, value in (("SANDBOX_BACKEND", "cloudrun"), ("LOG_FORMAT", "json"),
                    ("AUTH_REQUIRED", "true"), ("SANDBOX_MAX_CONCURRENT", "4")):
    want("env " + name, env.get(name, {}).get("value"), value, "deploy runbook section 2.")

# #188 in one assertion. The default is http://localhost:5173, and nothing visibly breaks with a
# wrong value because Cloud Run serves the SPA and the API from one origin.
want("env FRONTEND_ORIGIN", env.get("FRONTEND_ORIGIN", {}).get("value"), service_url,
     "a wrong origin is invisible from outside: same-origin requests never consult CORS (#188).")

for name in ("ANTHROPIC_API_KEY", "DATABASE_URL", "REDIS_URL", "OIDC_ISSUER", "OIDC_AUDIENCE",
             "OIDC_JWKS_URL"):
    ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
    want("secret " + name, (ref.get("name"), ref.get("key")),
         (name.lower().replace("_", "-"), "latest"),
         "bound from Secret Manager, never baked into the image.")

if failures:
    print("\n  shape assertions failed:", file=sys.stderr)
    for f in failures:
        print("    - " + f, file=sys.stderr)
    sys.exit(1)
print("    all shape assertions passed")
'
}

http() {
  echo
  echo "==> http (${URL})"
  local body status csp

  body="$(curl_ -w '%{http_code}' "${URL}/api/health")"
  status="${body: -3}"
  if [[ "$status" != "200" ]]; then
    echo "    /api/health returned ${status}, not 200" >&2
    return 1
  fi
  if [[ "$body" != *'"status":"ok"'* ]]; then
    echo "    /api/health returned 200 without {\"status\":\"ok\"}: ${body}" >&2
    return 1
  fi
  echo "    ok   /api/health 200 {\"status\":\"ok\"}"

  # The auth gate, from outside. Cheap, needs no credentials, and it is the one security control a
  # deploy can misconfigure without anything else noticing: AUTH_REQUIRED is an env var.
  status="$(curl_ -o /dev/null -w '%{http_code}' -X POST "${URL}/api/execute" \
    -H 'content-type: application/json' -d '{"prompt":"deploy check"}')"
  if [[ "$status" != "401" ]]; then
    echo "    unauthenticated POST /api/execute returned ${status}, not 401." >&2
    echo "    The auth gate is off or misconfigured. Do NOT promote this revision." >&2
    return 1
  fi
  echo "    ok   unauthenticated POST /api/execute 401"

  # The production CSP used to be attached only by the Vite dev and preview servers, so a static
  # deploy of dist/ shipped with no CSP at all. A unit test on the policy builder cannot catch
  # "the server forgot the header"; this can.
  csp="$(curl_ -I "$URL" | grep -i '^content-security-policy:' || true)"
  if [[ -z "$csp" ]]; then
    echo "    no Content-Security-Policy header on ${URL}" >&2
    return 1
  fi
  if [[ "$csp" == *"unsafe-eval"* ]]; then
    echo "    the CSP permits unsafe-eval — that is the DEV policy: ${csp}" >&2
    return 1
  fi
  if [[ "$csp" == *"http://"* ]]; then
    echo "    the CSP names a plaintext http:// origin: ${csp}" >&2
    return 1
  fi
  echo "    ok   production CSP present, no unsafe-eval, no plaintext origin"
}

logs() {
  echo
  echo "==> logs (last ${LOG_FRESHNESS}${REVISION:+, revision ${REVISION}})"
  # jsonPayload.message:* restricts this to the APPLICATION's own logs. Without it Cloud Run's
  # request log contributes a WARNING per 429, so a correctly rate-limited burst buries the line
  # that matters (isolation-probes runbook).
  #
  # REVISION scopes the query to ONE revision, and it is not optional before promotion. Unscoped,
  # the filter covers the whole service — and during candidate verification the OLD revision is the
  # one serving live traffic, so any warning it emits would block promotion of a candidate that is
  # fine. After promotion the service-wide scope is the right one, and its own limitation is worth
  # stating: a fixed window still reaches back into what the previous revision logged while it was
  # serving.
  #
  # THE HONEST LIMIT OF THIS CHECK. Cloud Logging ingestion is asynchronous, so reading immediately
  # can return an empty window because the entries have not landed yet — and empty is exactly what
  # this target treats as a pass. The settle wait below buys some of that back; it does not make
  # silence proof. A warning found here is strong evidence; no warning is weak evidence, and the
  # quota's fail-open line (#191, #195) only ever appears once AUTHENTICATED traffic arrives, which
  # is why that detection lives in the probes runbook and not here.
  if [[ "${LOG_SETTLE_SECONDS}" -gt 0 ]]; then
    echo "    letting ingestion settle for ${LOG_SETTLE_SECONDS}s before believing a quiet window"
    sleep "$LOG_SETTLE_SECONDS"
  fi

  local out revision_filter=""
  if [[ -n "$REVISION" ]]; then
    revision_filter="AND resource.labels.revision_name=${REVISION}"
  fi
  out="$(gcloud logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE}
     ${revision_filter}
     AND severity>=WARNING AND jsonPayload.message:*" \
    --project="$PROJECT_ID" --freshness="$LOG_FRESHNESS" --limit=20 \
    --format="value(timestamp,severity,jsonPayload.message)")"
  if [[ -n "$out" ]]; then
    echo "    the application logged warnings — a clean window has none:" >&2
    printf '%s\n' "$out" | sed 's/^/      /' >&2
    return 1
  fi
  echo "    ok   no application warnings (weak evidence — see the comment in this function)"
}

case "$TARGET" in
all)
  shape
  http
  logs
  ;;
shape) shape ;;
http) http ;;
logs) logs ;;
*)
  echo "unknown target: $TARGET" >&2
  exit 2
  ;;
esac
