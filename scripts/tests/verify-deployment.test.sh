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
  printf '%s' "${2:-}" >"$work/state/logs.txt"
  : >"$work/calls.log"
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"logging read"*) cat "$work/state/logs.txt"; exit 0 ;;
  *)                cat "$work/state/service.json"; exit 0 ;;
esac
EOF
  chmod +x "$work/bin/gcloud"
}

# $1 health status, $2 CSP header value ("" means the header is ABSENT), $3 /api/execute status.
# The values go through files rather than interpolation so an empty CSP suppresses the whole header
# line — a fake emitting a bare `content-security-policy:` would let the "no CSP at all" case pass,
# which is the exact bug this suite exists to catch elsewhere.
make_curl() {
  printf '%s' "$1" >"$work/state/health_status"
  printf '%s' "${2:-}" >"$work/state/csp"
  printf '%s' "$3" >"$work/state/execute_status"
  cat >"$work/bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"/api/health"*)  printf '{"status":"ok"}\n%s' "\$(cat "$work/state/health_status")"; exit 0 ;;
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
if logged "--max-time" && logged "--connect-timeout"; then
  ok "every curl is bounded by --connect-timeout and --max-time"
else
  bad "every curl is bounded" "$(grep '^curl' "$work/calls.log" | head -3)"
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

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
