#!/usr/bin/env bash
# Unit tests for scripts/verify-deployment.sh, driven by a fake `gcloud` and a fake `curl`.
#
# Every assertion in that script exists because a defect got past a green verify.sh, so every one of
# them is tested from BOTH sides here: it passes on a healthy readback, and it FAILS on the readback
# the corresponding real defect produced. An assertion nobody has seen fail is the
# decorative-assertion pattern this repo has already shipped once.
set -euo pipefail

cd "$(dirname "$0")"
VERIFY="${VERIFY:-$PWD/../verify-deployment.sh}"

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "ok   — $1"
}
bad() {
  fail=$((fail + 1))
  echo "FAIL — $1"
  # An explicit `if`, never `[[ … ]] && printf …`: as the last command of the function that AND-list
  # returns 1 when $2 is empty, and `bad` is called from inside a `then` branch, which is NOT exempt
  # from errexit. The suite would die on its first single-argument failure.
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" | sed 's/^/      /'; fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/state"
URL="https://app-530312723651.us-central1.run.app"

# A healthy readback, matching the shape of the live service on 2026-08-17. Each mutation below
# changes exactly one field of this.
healthy_json() {
  cat <<JSON
{
  "spec": {
    "template": {
      "metadata": {
        "annotations": {
          "autoscaling.knative.dev/maxScale": "2",
          "run.googleapis.com/cloudsql-instances": "test-project:us-central1:app-db",
          "run.googleapis.com/execution-environment": "gen2",
          "run.googleapis.com/network-interfaces": "[{\"network\":\"app-net\",\"subnetwork\":\"app-subnet\"}]",
          "run.googleapis.com/vpc-access-egress": "private-ranges-only"
        }
      },
      "spec": {
        "containerConcurrency": 8,
        "serviceAccountName": "app-runtime@test-project.iam.gserviceaccount.com",
        "containers": [{
          "image": "us-central1-docker.pkg.dev/test-project/app/app:abc123",
          "sandboxLauncher": true,
          "resources": {"limits": {"cpu": "2", "memory": "2Gi"}},
          "env": [
            {"name": "SANDBOX_BACKEND", "value": "cloudrun"},
            {"name": "LOG_FORMAT", "value": "json"},
            {"name": "AUTH_REQUIRED", "value": "true"},
            {"name": "SANDBOX_MAX_CONCURRENT", "value": "4"},
            {"name": "FRONTEND_ORIGIN", "value": "$URL"},
            {"name": "ANTHROPIC_API_KEY", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "anthropic-api-key"}}},
            {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "database-url"}}},
            {"name": "REDIS_URL", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "redis-url"}}},
            {"name": "OIDC_ISSUER", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "oidc-issuer"}}},
            {"name": "OIDC_AUDIENCE", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "oidc-audience"}}},
            {"name": "OIDC_JWKS_URL", "valueFrom": {"secretKeyRef": {"key": "latest", "name": "oidc-jwks-url"}}}
          ]
        }]
      }
    }
  },
  "status": {"url": "$URL"}
}
JSON
}

# $1 = the service JSON, $2 = log output ("" means a clean window)
make_fakes() {
  printf '%s' "$1" >"$work/state/service.json"
  printf '%s' "${3:-$1}" >"$work/state/revision.json"
  printf '%s' "${2:-}" >"$work/state/logs.txt"
  : >"$work/calls.log"
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf 'gcloud %s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"logging read"*)     cat "$work/state/logs.txt"; exit 0 ;;
  *"revisions describe"*) cat "$work/state/revision.json"; exit 0 ;;
  *)                    cat "$work/state/service.json"; exit 0 ;;
esac
EOF
  chmod +x "$work/bin/gcloud"
}

# $1 health status, $2 CSP header value ("" means the header is ABSENT), $3 /api/execute status.
# The values go through files rather than interpolation so an empty CSP suppresses the whole header
# line — a fake emitting a bare `content-security-policy:` would let the "no CSP at all" case pass,
# which is the exact bug this suite exists to catch elsewhere.
make_curl() {
  # Truncate: `logged` greps the whole file, so without this one bounded call would satisfy the
  # "every curl is bounded" assertion on behalf of the other two.
  : >"$work/calls.log"
  printf '%s' "$1" >"$work/state/health_status"
  printf '%s' "${2:-}" >"$work/state/csp"
  printf '%s' "$3" >"$work/state/execute_status"
  printf '%s' "${4:-{\"status\":\"ok\"}}" >"$work/state/health_body"
  cat >"$work/bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"/api/health"*)  printf '%s\n%s' "\$(cat "$work/state/health_body")" "\$(cat "$work/state/health_status")"; exit 0 ;;
  *"/api/execute"*) printf '%s' "\$(cat "$work/state/execute_status")"; exit 0 ;;
  *)
    csp="\$(cat "$work/state/csp")"
    if [[ -n "\$csp" ]]; then printf 'content-security-policy: %s\n' "\$csp"; fi
    exit 0 ;;
esac
EOF
  chmod +x "$work/bin/curl"
}

run_verify() {
  PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app \
    LOG_SETTLE_SECONDS=0 "$VERIFY" "$@" >"$work/out.txt" 2>&1
}
logged() { grep -qF -- "$1" "$work/calls.log"; }

CSP_OK="default-src 'self'; script-src 'self'; connect-src 'self' https://t.auth0.com"

# --- the healthy case passes every target ------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 200 "$CSP_OK" 401
for target in shape http logs all; do
  if run_verify "$target" "$URL"; then
    ok "healthy service passes '$target'"
  else
    bad "healthy service passes '$target'" "$(cat "$work/out.txt")"
  fi
done

# --- each shape assertion, from the failing side -----------------------------------------------
shape_mutant() { # $1 sed expr, $2 label
  make_fakes "$(healthy_json | sed "$1")" ""
  make_curl 200 "$CSP_OK" 401
  if run_verify shape "$URL"; then bad "$2"; else ok "$2"; fi
}
shape_mutant 's/"sandboxLauncher": true/"sandboxLauncher": false/' \
  "shape fails when sandboxLauncher is absent (ADR-0005's whole premise)"
shape_mutant "s|\"value\": \"$URL\"|\"value\": \"http://localhost:5173\"|" \
  "shape fails when FRONTEND_ORIGIN is not the service URL (#188)"
shape_mutant 's/app-subnet/wrong-subnet/' "shape fails when the VPC interface is wrong"
shape_mutant 's/"containerConcurrency": 8/"containerConcurrency": 4/' \
  "shape fails when containerConcurrency is not 8 (D12)"
shape_mutant 's/"name": "redis-url"/"name": "wrong-secret"/' \
  "shape fails when a secret is bound to the wrong container"
shape_mutant 's/"gen2"/"gen1"/' "shape fails when the execution environment is not gen2"
shape_mutant 's|app-runtime@test-project|other-sa@test-project|' \
  "shape fails when the service runs as the wrong identity"
shape_mutant 's|/maxScale": "2"|/maxScale": "50"|' "shape fails when max-instances drifted"
shape_mutant 's/"memory": "2Gi"/"memory": "512Mi"/' "shape fails when the memory limit drifted"
shape_mutant 's/"cpu": "2"/"cpu": "1"/' "shape fails when the cpu limit drifted"
shape_mutant 's/private-ranges-only/all-traffic/' \
  "shape fails when vpc-egress is wrong (the silent quota killer)"
shape_mutant 's|test-project:us-central1:app-db|other:us-central1:app-db|' \
  "shape fails when the Cloud SQL instance is wrong"
# ADR-0005 says the provider STRIPS the field, so the shape after a drifted apply has no key at all
# — not a false one. Asserting the premise rather than labelling it.
shape_mutant 's/"sandboxLauncher": true,//' \
  "shape fails when sandboxLauncher is STRIPPED, which is what an apply actually does"
# The env vars, one at a time. AUTH_REQUIRED is the security-critical one: it is the only control a
# deploy can switch off with an env var and nothing else would notice.
shape_mutant 's/"value": "true"/"value": "false"/' \
  "shape fails when AUTH_REQUIRED is not true"
shape_mutant 's/"SANDBOX_BACKEND", "value": "cloudrun"/"SANDBOX_BACKEND", "value": "docker"/' \
  "shape fails when SANDBOX_BACKEND is not cloudrun"
shape_mutant 's/"LOG_FORMAT", "value": "json"/"LOG_FORMAT", "value": "pretty"/' \
  "shape fails when LOG_FORMAT is not json"
shape_mutant 's/"SANDBOX_MAX_CONCURRENT", "value": "4"/"SANDBOX_MAX_CONCURRENT", "value": "99"/' \
  "shape fails when the sandbox concurrency cap drifted"
# "Is this the artifact we just built?" — every other assertion passes while a previous commit runs.
shape_mutant 's|us-central1-docker.pkg.dev/test-project/app/app:abc123|docker.io/somebody/app:abc123|' \
  "shape fails when the image is not from this project registry"

# --- the HTTP surface --------------------------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 503 "$CSP_OK" 401
if run_verify http "$URL"; then bad "http fails when /api/health is not 200"; else
  ok "http fails when /api/health is not 200"
fi
make_curl 200 "$CSP_OK" 200
if run_verify http "$URL"; then
  bad "http fails when an unauthenticated /api/execute is not 401"
else
  ok "http fails when an unauthenticated /api/execute is not 401"
fi
make_curl 200 "default-src 'self'; script-src 'self' 'unsafe-eval'" 401
if run_verify http "$URL"; then bad "http fails when the CSP permits unsafe-eval"; else
  ok "http fails when the CSP permits unsafe-eval"
fi
make_curl 200 "default-src 'self'; connect-src http://api.example.com" 401
if run_verify http "$URL"; then bad "http fails when the CSP names a plaintext origin"; else
  ok "http fails when the CSP names a plaintext origin"
fi
make_curl 200 "" 401
if run_verify http "$URL"; then bad "http fails when there is no CSP header at all"; else
  ok "http fails when there is no CSP header at all"
fi

# Every request is bounded: the deploy workflow's concurrency group never cancels in progress, so
# an unresponsive candidate would otherwise hold every later deploy until GitHub's job ceiling.
make_curl 200 "$CSP_OK" 401
run_verify http "$URL" || true
# EVERY call, counted — not "at least one". `logged` greps the whole file, so an unbounded health
# probe would hide behind the two calls that are still bounded, which is exactly what it did.
total="$(grep -c '^curl ' "$work/calls.log" || true)"
bounded="$(grep '^curl ' "$work/calls.log" | grep -c -- '--max-time' || true)"
connect="$(grep '^curl ' "$work/calls.log" | grep -c -- '--connect-timeout' || true)"
if [[ "$total" -ge 3 && "$bounded" -eq "$total" && "$connect" -eq "$total" ]]; then
  ok "all $total curl calls are bounded by --connect-timeout and --max-time"
else
  bad "every curl is bounded" "$total calls, $bounded with --max-time, $connect with --connect-timeout"
fi

# --- the logs ------------------------------------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 200 "$CSP_OK" 401
if run_verify logs "$URL"; then ok "logs passes on a clean window"; else
  bad "logs passes on a clean window" "$(cat "$work/out.txt")"
fi

# #191: the quota was rejected on every call and fail-open turned that into unmetered requests.
make_fakes "$(healthy_json)" \
  "2026-08-17T14:00:00Z ERROR quota store unavailable - FAILING OPEN, requests are unmetered"
if run_verify logs "$URL"; then
  bad "logs fails when the application logged a warning"
else
  ok "logs fails when the application logged a warning"
fi

# REVISION scoping. Unscoped, the OLD revision — still serving traffic while a candidate is being
# verified — can veto promotion of a candidate that is fine.
make_fakes "$(healthy_json)" ""
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app \
  REVISION=app-00009-abc LOG_SETTLE_SECONDS=0 "$VERIFY" logs "$URL" >"$work/out.txt" 2>&1 || true
if logged "resource.labels.revision_name=app-00009-abc"; then
  ok "logs scopes the query to REVISION when it is set"
else
  bad "logs scopes the query to REVISION when it is set" "$(cat "$work/calls.log")"
fi

make_fakes "$(healthy_json)" ""
run_verify logs "$URL" || true
if logged "revision_name"; then
  bad "logs is service-wide when REVISION is empty" "$(cat "$work/calls.log")"
else
  ok "logs is service-wide when REVISION is empty — the right scope after promotion"
fi

# Cloud Logging ingestion is asynchronous, so reading immediately can return an empty window
# because the entries have not landed — and empty is what this target treats as a pass.
make_fakes "$(healthy_json)" ""
if PATH="$work/bin:$PATH" PROJECT_ID=test-project SERVICE=app LOG_SETTLE_SECONDS=1 \
  "$VERIFY" logs "$URL" >"$work/out.txt" 2>&1 && grep -q "ingestion to settle\|ingestion settle" "$work/out.txt"; then
  ok "logs waits for ingestion before believing a quiet window"
else
  bad "logs waits for ingestion before believing a quiet window" "$(cat "$work/out.txt")"
fi

# --- `all` must actually compose: a failing member fails the run --------------------------------
# This is the only target CI invokes, and deploy-cloud-run.sh promotes on its exit 0. A regression
# in the composition promotes an unverified revision with a fully green suite.
make_fakes "$(healthy_json | sed 's/"sandboxLauncher": true/"sandboxLauncher": false/')" ""
make_curl 200 "$CSP_OK" 401
if run_verify all "$URL"; then bad "all fails when shape fails"; else ok "all fails when shape fails"; fi

make_fakes "$(healthy_json)" ""
make_curl 503 "$CSP_OK" 401
if run_verify all "$URL"; then bad "all fails when http fails"; else ok "all fails when http fails"; fi

make_fakes "$(healthy_json)" "2026-08-17T14:00:00Z ERROR quota store unavailable"
make_curl 200 "$CSP_OK" 401
if run_verify all "$URL"; then bad "all fails when logs fails"; else ok "all fails when logs fails"; fi

# --- the calls the script actually makes --------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 200 "$CSP_OK" 401
run_verify shape "$URL" || true
if logged "services describe app" && logged "--region=us-central1" && logged "--project=test-project"; then
  ok "shape reads back the service, region and project it was asked about"
else
  bad "shape reads back the right service" "$(cat "$work/calls.log")"
fi

# After a rollback the service template describes a revision that is NOT serving, so shape must
# read the revision under test rather than the template.
make_fakes "$(healthy_json)" "" "$(healthy_json)"
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app \
  REVISION=app-00009-abc LOG_SETTLE_SECONDS=0 "$VERIFY" shape "$URL" >"$work/out.txt" 2>&1 || true
if logged "revisions describe app-00009-abc"; then
  ok "shape reads the REVISION under test, not the service template"
else
  bad "shape reads the REVISION under test" "$(cat "$work/calls.log")"
fi

# The log filter is the whole check. A wrong service name makes it permanently passing.
make_fakes "$(healthy_json)" ""
run_verify logs "$URL" || true
for clause in "resource.labels.service_name=app" "severity>=WARNING" "jsonPayload.message:*" "--limit=20"; do
  if logged "$clause"; then ok "the log filter carries $clause"; else
    bad "the log filter carries $clause" "$(cat "$work/calls.log")"
  fi
done

# The auth probe must be a POST with a body: a GET to /api/execute falls through to the SPA
# fallback and answers 200, so the one security control here would silently stop being tested.
make_curl 200 "$CSP_OK" 401
run_verify http "$URL" || true
if logged "-X POST" && logged "deploy check"; then
  ok "the auth probe is a POST with a body, not a GET the SPA fallback would answer"
else
  bad "the auth probe is a POST with a body" "$(grep curl "$work/calls.log" | head -3)"
fi

# The health assertion must distinguish "the API answered" from "the SPA fallback returned 200".
make_curl 200 "$CSP_OK" 401 '<!doctype html><title>app</title>'
if run_verify http "$URL"; then
  bad "http fails when /api/health returns 200 without the ok body"
else
  ok "http fails when /api/health returns 200 without the ok body"
fi

# --- usage ---------------------------------------------------------------------------------------
make_fakes "$(healthy_json)" ""
rc=0
PATH="$work/bin:$PATH" "$VERIFY" all >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 2 ]]; then ok "a missing URL is a usage error (exit 2)"; else
  bad "a missing URL is a usage error" "got $rc: $(cat "$work/out.txt")"
fi
rc=0
PATH="$work/bin:$PATH" "$VERIFY" frobnicate "$URL" >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 2 ]]; then ok "an unknown target exits 2"; else
  bad "an unknown target exits 2" "got $rc: $(cat "$work/out.txt")"
fi

# --- the two copies of the service specification must agree ------------------------------------
#
# ADR-0005 makes the deploy command the specification for the service's shape. This script asserts
# that same shape independently, which means there are now two copies of it and nothing stops them
# drifting: bump --max-instances in the deploy script and every deploy fails at verify only after a
# candidate has been built; change only the verifier and the checks stay green against a service
# that no longer matches the runbook. This is the cheap deterrent — not a proof, but the two files
# can no longer disagree silently.
DEPLOY_SCRIPT="$PWD/../deploy-cloud-run.sh"
if [[ -r "$DEPLOY_SCRIPT" ]]; then
  agree=0
  disagree=""
  check_pair() { # $1 = literal in the deploy script, $2 = literal in this verifier
    if grep -qF -- "$1" "$DEPLOY_SCRIPT" && grep -qF -- "$2" "$VERIFY"; then
      agree=$((agree + 1))
    else
      disagree="${disagree}
      deploy has '$1' / verifier expects '$2'"
    fi
  }
  check_pair "--cpu 2"                              '"cpu", c.get'
  check_pair "--memory 2Gi"                         '"2Gi"'
  check_pair "--concurrency 8"                      '), 8,'
  check_pair "--max-instances 2"                    '"maxScale"'
  check_pair "--network app-net"                    '"app-net"'
  check_pair "--subnet app-subnet"                  '"app-subnet"'
  check_pair "--vpc-egress private-ranges-only"     '"private-ranges-only"'
  check_pair "--execution-environment gen2"         '"gen2"'
  check_pair "--sandbox-launcher"                   '"sandboxLauncher"'
  check_pair "SANDBOX_BACKEND=cloudrun"             '"SANDBOX_BACKEND", "cloudrun"'
  check_pair "AUTH_REQUIRED=true"                   '"AUTH_REQUIRED", "true"'
  check_pair "SANDBOX_MAX_CONCURRENT=4"             '"SANDBOX_MAX_CONCURRENT", "4"'
  check_pair "REDIS_URL=redis-url:latest"           '"REDIS_URL"'
  check_pair "OIDC_JWKS_URL=oidc-jwks-url:latest"   '"OIDC_JWKS_URL"'
  if [[ -z "$disagree" ]]; then
    ok "all $agree flags of the deploy command have a matching assertion here"
  else
    bad "the deploy command and this verifier describe the same service" "$disagree"
  fi
else
  ok "deploy script not present in this tree — cross-check skipped"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
