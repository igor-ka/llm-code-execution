#!/usr/bin/env bash
# Unit tests for scripts/deploy-cloud-run.sh, driven by fake `gcloud`, `docker` and verifier
# executables on PATH.
#
# Same harness as infra/tests/bootstrap.test.sh and for the same reason: running the real script
# against the real project proves it worked that day, not that the next edit is safe. The fakes
# record every invocation and the assertions read that log. No network, no project, no credentials.
#
# The fakes read their behaviour from files under $work/state, so a test can change one condition
# without regenerating them — which is what makes the "this call errors" cases cheap enough to
# write, and those are the ones that matter: nearly every finding this suite grew out of was a
# failure being mistaken for an absence.
set -euo pipefail

cd "$(dirname "$0")"
# Overridable so the suite can be pointed at a modified copy to prove it goes RED — the repo
# standard is that a check nobody has seen fail is not a check.
DEPLOY="${DEPLOY:-$PWD/../deploy-cloud-run.sh}"

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "ok   — $1"
}
bad() {
  fail=$((fail + 1))
  echo "FAIL — $1"
  # An explicit `if`, never `[[ … ]] && printf …`. As the last command of the function that AND-list
  # returns 1 whenever $2 is absent or empty, so the function returns 1 — and `bad` is called from
  # inside a `then` branch, which is NOT exempt from errexit. The suite would die on its first
  # single-argument failure and never print the summary. infra/verify.sh's gates() carries the same
  # warning; infra/tests/bootstrap.test.sh only escapes it because every call there passes two
  # non-empty arguments.
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" | sed 's/^/      /'; fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/state"

URL="https://app-530312723651.us-central1.run.app"
CAND_URL="https://candidate---app-530312723651.us-central1.run.app"

traffic_json() { # $1 = candidate revision or "", $2 = serving revision, $3 = serving percent
  local cand=""
  if [[ -n "$1" ]]; then
    cand="{\"tag\":\"candidate\",\"percent\":0,\"url\":\"$CAND_URL\",\"revisionName\":\"$1\"},"
  fi
  printf '{"status":{"url":"%s","traffic":[%s{"latestRevision":true,"percent":%s,"revisionName":"%s"}]}}' \
    "$URL" "$cand" "$3" "$2"
}

write_fakes() {
  cat >"$work/bin/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> "$work/calls.log"
exit 0
EOF
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
s="$work/state"
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"artifacts repositories list"*)
      rc="\$(cat "\$s/registry_exit")"
      # The real gcloud prints this banner on STDERR even on success, which is why the script must
      # not fold the streams together here.
      echo "Listing items under project test-project, location us-central1." >&2
      if [[ "\$rc" != 0 ]]; then echo "ERROR: permission denied" >&2; exit "\$rc"; fi
      cat "\$s/registry_out"; exit 0 ;;
  *"projects describe"*)               cat "\$s/project_number"; exit "\$(cat "\$s/projects_exit")" ;;
  *"sql instances list"*)
      rc="\$(cat "\$s/sql_exit")"
      if [[ "\$rc" != 0 ]]; then echo "ERROR: permission denied" >&2; exit "\$rc"; fi
      cat "\$s/sql_out"; exit 0 ;;
  *"run services list"*)
      rc="\$(cat "\$s/list_exit")"
      if [[ "\$rc" != 0 ]]; then echo "ERROR: permission denied" >&2; exit "\$rc"; fi
      cat "\$s/list_out"; exit 0 ;;
  *"run services describe"*"latestCreatedRevisionName"*) cat "\$s/latest_revision"; exit 0 ;;
  *"run services describe"*"status.url"*) cat "\$s/service_url"; exit 0 ;;
  *"run services describe"*)
      rc="\$(cat "\$s/describe_exit")"
      if [[ "\$rc" != 0 ]]; then exit "\$rc"; fi
      cat "\$s/service_json"; exit 0 ;;
esac
exit 0
EOF
  # A recording verifier, so the suite can assert what `verify` actually hands it.
  cat >"$work/bin/verify-stub.sh" <<EOF
#!/usr/bin/env bash
{
  printf 'args=%s\n' "\$*"
  printf 'PROJECT_ID=%s REGION=%s SERVICE=%s REVISION=%s EXPECT_IMAGE=%s\n' \
    "\${PROJECT_ID:-}" "\${REGION:-}" "\${SERVICE:-}" "\${REVISION:-}" "\${EXPECT_IMAGE:-}"
} >> "$work/verify.log"
exit "\$(cat "$work/state/verify_exit")"
EOF
  chmod +x "$work/bin/docker" "$work/bin/gcloud" "$work/bin/verify-stub.sh"
}

# $1 service_state: "absent" | "serving" (candidate present) | "untagged" (no candidate)
setup() {
  local state="${1:-serving}"
  : >"$work/calls.log"
  : >"$work/verify.log"
  echo 0 >"$work/state/registry_exit"
  echo app >"$work/state/registry_out"
  echo 0 >"$work/state/projects_exit"
  echo 0 >"$work/state/list_exit"
  echo 0 >"$work/state/sql_exit"
  echo app-db >"$work/state/sql_out"
  echo 0 >"$work/state/describe_exit"
  echo 0 >"$work/state/verify_exit"
  echo "530312723651" >"$work/state/project_number"
  echo "app-00010-new" >"$work/state/latest_revision"
  case "$state" in
  absent)
    : >"$work/state/list_out"
    : >"$work/state/service_url"
    echo 1 >"$work/state/describe_exit"
    : >"$work/state/service_json"
    ;;
  untagged)
    echo app >"$work/state/list_out"
    echo "$URL" >"$work/state/service_url"
    traffic_json "" "app-00010-new" 100 >"$work/state/service_json"
    ;;
  *)
    echo app >"$work/state/list_out"
    echo "$URL" >"$work/state/service_url"
    traffic_json "app-00010-new" "app-00010-new" 100 >"$work/state/service_json"
    ;;
  esac
  write_fakes
}

run_deploy() {
  PATH="$work/bin:$PATH" \
    PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG=abc123 \
    VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid \
    VITE_AUTH0_AUDIENCE=https://api.test/ \
    VERIFY_SCRIPT="$work/bin/verify-stub.sh" \
    PROMOTE_POLL_ATTEMPTS=2 PROMOTE_POLL_SECONDS=0 \
    "$DEPLOY" "$@" >"$work/out.txt" 2>&1
}

logged() { grep -qF -- "$1" "$work/calls.log"; }
verified() { grep -qF -- "$1" "$work/verify.log"; }

expect_exit() { # $1 expected, $2 label, then the target args
  local want="$1" label="$2"
  shift 2
  local rc=0
  run_deploy "$@" || rc=$?
  if [[ "$rc" -eq "$want" ]]; then
    ok "$label"
  else
    bad "$label" "expected exit $want, got $rc: $(cat "$work/out.txt")"
  fi
}

# --- usage is the default; deploying is never the default --------------------------------------
setup serving
expect_exit 0 "a bare invocation prints usage instead of deploying to production"
if logged "beta run deploy"; then
  bad "a bare invocation deploys nothing" "$(cat "$work/calls.log")"
else
  ok "a bare invocation deploys nothing"
fi
if grep -q "Usage:" "$work/out.txt"; then
  ok "the default target prints the usage block"
else
  bad "the default target prints the usage block" "$(cat "$work/out.txt")"
fi
setup serving
expect_exit 0 "--help prints usage" --help
setup serving
expect_exit 2 "an unknown target exits 2" frobnicate

# --- preflight: three stages, and an ERROR is never reported as an absence ----------------------
# Preflight no longer probes Artifact Registry at all: it survives the between-sessions teardown,
# and listing it asks for a permission on the LOCATION that the repository-scoped grant does not
# carry. Cloud SQL is what that teardown removes and what the grant can cover.
setup serving
: >"$work/state/sql_out"
expect_exit 3 "preflight exits 3 when the data layer is torn down" preflight
if logged "artifacts repositories list"; then
  bad "preflight does not probe Artifact Registry" "$(cat "$work/calls.log")"
else
  ok "preflight does not probe Artifact Registry, whose grant cannot cover a location-level list"
fi

setup serving
echo 1 >"$work/state/sql_exit"
expect_exit 1 "preflight exits 1, not 3, when the Cloud SQL lookup itself errors" preflight

setup serving
echo 1 >"$work/state/projects_exit"
expect_exit 1 "preflight exits 1, not 3, when the credential does not work" preflight

setup absent
expect_exit 3 "preflight exits 3 when the service does not exist" preflight

# The finding this case exists for: `describe` fails identically for "missing" and "denied", so the
# probe uses `list --filter`, which exits 0-with-nothing for missing and non-zero for denied.
setup serving
echo 1 >"$work/state/list_exit"
expect_exit 1 "preflight exits 1, not 3, when the service lookup itself errors" preflight

setup serving
expect_exit 0 "preflight exits 0 when credential, registry and service all check out" preflight

# --- build ---------------------------------------------------------------------------------------
setup serving
run_deploy build || true
if logged "docker build --platform linux/amd64"; then
  ok "build pins linux/amd64 — Cloud Run rejects arm64 with a manifest error naming no architecture"
else
  bad "build pins linux/amd64" "$(cat "$work/calls.log")"
fi
for arg in "VITE_AUTH0_DOMAIN=t.auth0.com" "VITE_AUTH0_CLIENT_ID=cid" \
  "VITE_AUTH0_AUDIENCE=https://api.test/"; do
  if logged "$arg"; then ok "build passes $arg"; else bad "build passes $arg" "$(cat "$work/calls.log")"; fi
done
if logged "docker push us-central1-docker.pkg.dev/test-project/app/app:abc123"; then
  ok "build pushes the tag the deploy will name"
else
  bad "build pushes the tag the deploy will name" "$(cat "$work/calls.log")"
fi

setup serving
if PATH="$work/bin:$PATH" PROJECT_ID=test-project TAG=abc123 VITE_AUTH0_DOMAIN= \
  VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  "$DEPLOY" build >"$work/out.txt" 2>&1; then
  bad "build refuses an empty VITE_AUTH0_DOMAIN" "$(cat "$work/out.txt")"
else
  ok "build refuses an empty VITE_AUTH0_DOMAIN"
fi
setup serving
if PATH="$work/bin:$PATH" PROJECT_ID=test-project TAG= VITE_AUTH0_DOMAIN=t.auth0.com \
  VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  "$DEPLOY" build >"$work/out.txt" 2>&1; then
  bad "build refuses an empty TAG" "$(cat "$work/out.txt")"
else
  ok "build refuses an empty TAG"
fi

# --- build:remote ---------------------------------------------------------------------------------
setup serving
run_deploy build:remote || true
if logged "serviceAccounts/app-build@test-project.iam.gserviceaccount.com"; then
  ok "build:remote runs as app-build, never the Compute Engine default account"
else
  bad "build:remote runs as app-build" "$(cat "$work/calls.log")"
fi
if logged "gs://test-project-build-source/source"; then
  ok "build:remote stages into the dedicated bucket, not gs://<project>_cloudbuild"
else
  bad "build:remote stages into the dedicated bucket" "$(cat "$work/calls.log")"
fi
if logged "_TAG=abc123"; then
  ok "build:remote passes the required _TAG substitution"
else
  bad "build:remote passes _TAG" "$(cat "$work/calls.log")"
fi

# cloudbuild.yaml hardcodes the us-central1/app image path, so an override would push an image the
# deploy cannot pull — and a failed deploy poisons the service template.
setup serving
rc=0
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-east1 SERVICE=app TAG=abc123 \
  VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  "$DEPLOY" build:remote >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 1 ]] && ! logged "builds submit"; then
  ok "build:remote refuses a REGION cloudbuild.yaml cannot honour"
else
  bad "build:remote refuses a REGION cloudbuild.yaml cannot honour" "rc=$rc $(cat "$work/out.txt")"
fi

# --- deploy: a candidate that serves nobody ------------------------------------------------------
setup serving
run_deploy deploy || true
if logged "--no-traffic"; then
  ok "deploy onto an existing service takes no traffic"
else
  bad "deploy onto an existing service takes no traffic" "$(cat "$work/calls.log")"
fi
for flag in "--sandbox-launcher" "--execution-environment gen2" "--network app-net" \
  "--subnet app-subnet" "--vpc-egress private-ranges-only" "--concurrency 8" \
  "--cpu 2" "--memory 2Gi" "--max-instances 2" "--allow-unauthenticated" \
  "--image us-central1-docker.pkg.dev/test-project/app/app:abc123" \
  "app-runtime@test-project.iam.gserviceaccount.com" \
  "test-project:us-central1:app-db"; do
  if logged "$flag"; then ok "deploy passes $flag"; else bad "deploy passes $flag" "$(cat "$work/calls.log")"; fi
done
for secret in ANTHROPIC_API_KEY=anthropic-api-key:latest DATABASE_URL=database-url:latest \
  REDIS_URL=redis-url:latest OIDC_ISSUER=oidc-issuer:latest \
  OIDC_AUDIENCE=oidc-audience:latest OIDC_JWKS_URL=oidc-jwks-url:latest; do
  if logged "$secret"; then ok "deploy binds $secret"; else bad "deploy binds $secret" "$(cat "$work/calls.log")"; fi
done
# On an existing service the origin is READ, not reconstructed from the project number: the
# <service>-<number>.<region> URL shape is a convention, not a guarantee (#188 is the failure class).
if logged "FRONTEND_ORIGIN=${URL}"; then
  ok "deploy reads FRONTEND_ORIGIN from the live service URL"
else
  bad "deploy reads FRONTEND_ORIGIN from the live service URL" "$(cat "$work/calls.log")"
fi
if logged "add-iam-policy-binding"; then
  ok "deploy binds allUsers explicitly, because --allow-unauthenticated only warns in this org"
else
  bad "deploy binds allUsers explicitly" "$(cat "$work/calls.log")"
fi

# deploy creates a candidate that MUST be verified, so a missing verifier stops it before it
# builds or pushes anything — not after, when a tagged public revision already exists.
setup serving
rc=0
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG=abc123 \
  VERIFY_SCRIPT="$work/does-not-exist.sh" "$DEPLOY" deploy >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 1 ]] && ! logged "beta run deploy"; then
  ok "deploy refuses when the verifier is missing, before deploying anything"
else
  bad "deploy refuses when the verifier is missing" "rc=$rc calls=$(cat "$work/calls.log")"
fi

setup absent
expect_exit 3 "deploy exits 3 rather than creating the service" deploy
if logged "beta run deploy"; then
  bad "deploy runs no gcloud deploy when the service is absent" "$(cat "$work/calls.log")"
else
  ok "deploy runs no gcloud deploy when the service is absent"
fi

# A lookup ERROR must not be read as "absent" and turned into a live, full-traffic create.
setup serving
echo 1 >"$work/state/list_exit"
expect_exit 1 "deploy exits 1 when the service lookup errors, and does not deploy" deploy
if logged "beta run deploy"; then
  bad "a service-lookup error deploys nothing" "$(cat "$work/calls.log")"
else
  ok "a service-lookup error deploys nothing"
fi

# --- create ----------------------------------------------------------------------------------------
setup absent
run_deploy create || true
if logged "--no-traffic"; then
  bad "create omits --no-traffic" "$(cat "$work/calls.log")"
else
  ok "create omits --no-traffic — Cloud Run gives the first revision 100%"
fi
if logged "--sandbox-launcher"; then
  ok "create produces the same service shape as deploy"
else
  bad "create produces the same service shape as deploy" "$(cat "$work/calls.log")"
fi
if logged "FRONTEND_ORIGIN=https://app-530312723651.us-central1.run.app"; then
  ok "create synthesises FRONTEND_ORIGIN from the project number, having no URL to read"
else
  bad "create synthesises FRONTEND_ORIGIN" "$(cat "$work/calls.log")"
fi

setup serving
expect_exit 1 "create refuses when the service already exists" create

# The verifier is checked BEFORE the deploy. Discovered afterwards, a missing one would leave a
# live unverified service behind — the one outcome the whole design exists to prevent.
setup absent
rc=0
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG=abc123 \
  VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  VERIFY_SCRIPT="$work/does-not-exist.sh" \
  "$DEPLOY" create >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 1 ]] && ! logged "beta run deploy"; then
  ok "create fails fast on a missing verifier, before deploying anything"
else
  bad "create fails fast on a missing verifier" "rc=$rc calls: $(cat "$work/calls.log")"
fi

# --- verify ------------------------------------------------------------------------------------
setup serving
run_deploy verify || true
if verified "args=all ${CAND_URL}"; then
  ok "verify targets the candidate URL, not the live one"
else
  bad "verify targets the candidate URL" "$(cat "$work/verify.log")"
fi
# "Is this the artifact we just built?" — the verifier can only answer that if it is told what was
# built. Without EXPECT_IMAGE a deploy resolving to a stale tag passes every other assertion.
if verified "EXPECT_IMAGE=us-central1-docker.pkg.dev/test-project/app/app:abc123"; then
  ok "verify tells the verifier which image this run built"
else
  bad "verify passes EXPECT_IMAGE" "$(cat "$work/verify.log")"
fi
# TAG is required, so the stale-image cross-check can never be silently skipped. The earlier
# optional path bought a green "verified" with that assertion quietly absent.
setup serving
rc=0
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG= \
  VERIFY_SCRIPT="$work/bin/verify-stub.sh" "$DEPLOY" verify >"$work/out.txt" 2>&1 || rc=$?
if [[ "$rc" -eq 1 && ! -s "$work/verify.log" ]]; then
  ok "verify refuses without TAG rather than dropping the stale-image cross-check"
else
  bad "verify refuses without TAG" "rc=$rc log=$(cat "$work/verify.log")"
fi

setup serving
run_deploy verify || true
if verified "PROJECT_ID=test-project REGION=us-central1 SERVICE=app REVISION=app-00010-new"; then
  ok "verify exports PROJECT_ID/REGION/SERVICE and scopes REVISION to the candidate"
else
  bad "verify exports the environment the child needs" "$(cat "$work/verify.log")"
fi

# No silent fallback: verifying the currently-serving revision and calling it a pass is how a
# completely unverified image would reach production with a green trail behind it.
setup untagged
expect_exit 1 "verify refuses to fall back to the live URL when no candidate is tagged" verify
if [[ ! -s "$work/verify.log" ]]; then
  ok "verify runs no checks at all when the candidate is missing"
else
  bad "verify runs no checks when the candidate is missing" "$(cat "$work/verify.log")"
fi

setup serving
echo 3 >"$work/state/verify_exit"
expect_exit 1 "a child exit of 3 is normalised to 1, never re-reported as 'nothing to deploy'" verify

setup untagged
expect_exit 0 "verify live targets the service URL" verify live
if verified "args=all ${URL}"; then
  ok "verify live hands the child the service URL"
else
  bad "verify live hands the child the service URL" "$(cat "$work/verify.log")"
fi

# --- promote -------------------------------------------------------------------------------------
setup serving
expect_exit 0 "promote succeeds when the verified candidate holds 100%" promote
if logged "--to-latest"; then
  ok "promote uses --to-latest, never --to-revisions (the pinning trap)"
else
  bad "promote uses --to-latest" "$(cat "$work/calls.log")"
fi
if logged "--remove-tags=candidate"; then
  ok "promote removes the candidate tag, closing the public URL it opened"
else
  bad "promote removes the candidate tag" "$(cat "$work/calls.log")"
fi

# An absent candidate is a failed deploy, not a no-op: returning 0 here reports a green pipeline
# that moved no traffic at all.
setup untagged
expect_exit 1 "promote fails when there is no candidate to promote" promote
if logged "update-traffic"; then
  bad "promote moves no traffic when there is no candidate" "$(cat "$work/calls.log")"
else
  ok "promote moves no traffic when there is no candidate"
fi

# --to-latest promotes whatever is newest AT THAT MOMENT. If a second deploy landed between verify
# and promote, promoting would send 100% to a revision nothing verified.
setup serving
echo "app-00011-newer" >"$work/state/latest_revision"
expect_exit 1 "promote refuses when a newer revision arrived after the candidate was verified" promote
if logged "update-traffic"; then
  bad "promote moves no traffic when the candidate is not the latest" "$(cat "$work/calls.log")"
else
  ok "promote moves no traffic when the candidate is not the latest"
fi

# The regression that matters: update-traffic can exit 0 having moved nothing. Only reading the
# split back distinguishes that from success.
setup serving
traffic_json "app-00010-new" "app-00008-old" 100 >"$work/state/service_json"
echo "app-00010-new" >"$work/state/latest_revision"
expect_exit 1 "promote fails when update-traffic exits 0 but the split did not move" promote

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
