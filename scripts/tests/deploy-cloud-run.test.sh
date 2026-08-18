#!/usr/bin/env bash
# Unit tests for scripts/deploy-cloud-run.sh, driven by a fake `gcloud` and a fake `docker` on PATH.
#
# Same harness as infra/tests/bootstrap.test.sh and for the same reason: running the real script
# against the real project proves it worked that day, not that the next edit is safe. The fakes
# record every invocation and the assertions read that log. No network, no project, no credentials.
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

# $1 registry_exit  — 0 when the Terraform layer exists, non-zero when it is torn down
# $2 service_state  — "absent" or "serving" (a candidate tag exists alongside the serving revision)
# $3 projects_exit  — 0 when the credential works; non-zero simulates a bad token or grant
make_fake_gcloud() {
  local registry_exit="$1" service_state="$2" projects_exit="${3:-0}"
  mkdir -p "$work/bin"
  # `docker` is faked into the same call log, so the build assertions read like the gcloud ones.
  cat >"$work/bin/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> "$work/calls.log"
exit 0
EOF
  chmod +x "$work/bin/docker"

  local url="https://app-530312723651.us-central1.run.app"
  local candidate=""
  if [[ "$service_state" == serving ]]; then
    candidate="{\"tag\":\"candidate\",\"percent\":0,\"url\":\"https://candidate---app-530312723651.us-central1.run.app\",\"revisionName\":\"app-00009-abc\"},"
  fi
  local describe_json=""
  if [[ "$service_state" != absent ]]; then
    describe_json="{\"status\":{\"url\":\"$url\",\"traffic\":[${candidate}{\"latestRevision\":true,\"percent\":100,\"revisionName\":\"app-00009-abc\"}]}}"
  fi
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"artifacts repositories describe"*) exit $registry_exit ;;
  *"projects describe"*)               echo "530312723651"; exit $projects_exit ;;
  *"run services describe"*"latestCreatedRevisionName"*)
      [[ -n '$describe_json' ]] || exit 1
      echo "app-00009-abc"; exit 0 ;;
  *"run services describe"*"status.url"*)
      [[ -n '$describe_json' ]] || exit 1
      echo "$url"; exit 0 ;;
  *"run services describe"*)
      [[ -n '$describe_json' ]] || exit 1
      printf '%s' '$describe_json'; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$work/bin/gcloud"
  : >"$work/calls.log"
  # verify-deployment.sh is a separate deliverable and is not under test here.
  cat >"$work/bin/verify-stub.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$work/bin/verify-stub.sh"
}

run_deploy() {
  PATH="$work/bin:$PATH" \
    PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG=abc123 \
    VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid \
    VITE_AUTH0_AUDIENCE=https://api.test/ \
    VERIFY_SCRIPT="$work/bin/verify-stub.sh" \
    "$DEPLOY" "$@" >"$work/out.txt" 2>&1
}

logged() { grep -qF -- "$1" "$work/calls.log"; }

# --- preflight: three stages, and only one of them may be green -------------------------------
make_fake_gcloud 1 absent
run_deploy preflight && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 3 ]]; then
  ok "preflight exits 3 when the registry is absent"
else
  bad "preflight exits 3 when the registry is absent" "got $rc: $(cat "$work/out.txt")"
fi

# The regression that matters most here: a credential failure must NOT read as "torn down". Exit 1,
# not 3 — otherwise a wrong grant or a wrong workload_identity_provider finishes the job green.
make_fake_gcloud 0 serving 1
run_deploy preflight && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 1 ]]; then
  ok "preflight exits 1, not 3, when the credential does not work"
else
  bad "preflight exits 1 when the credential does not work" "got $rc: $(cat "$work/out.txt")"
fi

# The service is the third stage: CD does not create it.
make_fake_gcloud 0 absent
run_deploy preflight && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 3 ]]; then
  ok "preflight exits 3 when the service does not exist"
else
  bad "preflight exits 3 when the service does not exist" "got $rc: $(cat "$work/out.txt")"
fi

make_fake_gcloud 0 serving
if run_deploy preflight; then
  ok "preflight exits 0 when credential, registry and service exist"
else
  bad "preflight exits 0 when credential, registry and service exist" "$(cat "$work/out.txt")"
fi

# --- build: what CI runs is a native amd64 docker build ---------------------------------------
make_fake_gcloud 0 serving
run_deploy build || true
if logged "docker build --platform linux/amd64"; then
  ok "build pins linux/amd64 — Cloud Run rejects arm64 with a manifest error naming no architecture"
else
  bad "build pins linux/amd64" "$(cat "$work/calls.log")"
fi
for arg in "VITE_AUTH0_DOMAIN=t.auth0.com" "VITE_AUTH0_CLIENT_ID=cid" \
  "VITE_AUTH0_AUDIENCE=https://api.test/"; do
  if logged "$arg"; then
    ok "build passes $arg"
  else
    bad "build passes $arg" "$(cat "$work/calls.log")"
  fi
done
if logged "docker push us-central1-docker.pkg.dev/test-project/app/app:abc123"; then
  ok "build pushes the tag the deploy will name"
else
  bad "build pushes the tag the deploy will name" "$(cat "$work/calls.log")"
fi

# --- build:remote: the by-hand path keeps app-build's least privilege --------------------------
make_fake_gcloud 0 serving
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

# --- a build that cannot log in must not happen at all ------------------------------------------
make_fake_gcloud 0 serving
if PATH="$work/bin:$PATH" PROJECT_ID=test-project TAG=abc123 \
  VITE_AUTH0_DOMAIN= VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  "$DEPLOY" build >"$work/out.txt" 2>&1; then
  bad "build refuses an empty VITE_AUTH0_DOMAIN" "$(cat "$work/out.txt")"
else
  ok "build refuses an empty VITE_AUTH0_DOMAIN"
fi

# TAG has no default anywhere, deliberately: it is what the deploy and any rollback name.
make_fake_gcloud 0 serving
if PATH="$work/bin:$PATH" PROJECT_ID=test-project TAG= \
  VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
  "$DEPLOY" build >"$work/out.txt" 2>&1; then
  bad "build refuses an empty TAG" "$(cat "$work/out.txt")"
else
  ok "build refuses an empty TAG"
fi

# --- deploy onto an existing service: a candidate that serves nobody ---------------------------
make_fake_gcloud 0 serving
run_deploy deploy || true
if logged "--no-traffic"; then
  ok "deploy onto an existing service takes no traffic"
else
  bad "deploy onto an existing service takes no traffic" "$(cat "$work/calls.log")"
fi
for flag in "--sandbox-launcher" "--execution-environment gen2" "--network app-net" \
  "--subnet app-subnet" "--vpc-egress private-ranges-only" "--concurrency 8" \
  "app-runtime@test-project.iam.gserviceaccount.com" \
  "test-project:us-central1:app-db"; do
  if logged "$flag"; then
    ok "deploy passes $flag"
  else
    bad "deploy passes $flag" "$(cat "$work/calls.log")"
  fi
done
if logged "FRONTEND_ORIGIN=https://app-530312723651.us-central1.run.app"; then
  ok "deploy sets FRONTEND_ORIGIN to the service's own URL (#188)"
else
  bad "deploy sets FRONTEND_ORIGIN to the service's own URL" "$(cat "$work/calls.log")"
fi
if logged "add-iam-policy-binding"; then
  ok "deploy binds allUsers explicitly, because --allow-unauthenticated only warns in this org"
else
  bad "deploy binds allUsers explicitly" "$(cat "$work/calls.log")"
fi

# --- deploy REFUSES to create the service --------------------------------------------------------
# The invariant is that no user ever reaches an unverified revision. Cloud Run gives a new service's
# first revision 100% of traffic, so the only way to keep that absolute is for CD not to create
# services at all.
make_fake_gcloud 0 absent
run_deploy deploy && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 3 ]]; then
  ok "deploy exits 3 rather than creating the service"
else
  bad "deploy exits 3 rather than creating the service" "got $rc: $(cat "$work/out.txt")"
fi
if logged "beta run deploy"; then
  bad "deploy runs no gcloud deploy when the service is absent" "$(cat "$work/calls.log")"
else
  ok "deploy runs no gcloud deploy when the service is absent"
fi

# --- create IS the by-hand path, and it does not pass --no-traffic -----------------------------
make_fake_gcloud 0 absent
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

# create must refuse to touch a service that already exists — that is deploy's job, and deploy is
# the one that keeps the candidate window.
make_fake_gcloud 0 serving
run_deploy create && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 1 ]]; then
  ok "create refuses when the service already exists"
else
  bad "create refuses when the service already exists" "got $rc: $(cat "$work/out.txt")"
fi

# --- promote: the split is checked, not the exit code ------------------------------------------
make_fake_gcloud 0 serving
if run_deploy promote; then
  ok "promote succeeds when the latest revision holds 100%"
else
  bad "promote succeeds when the latest revision holds 100%" "$(cat "$work/out.txt")"
fi
if logged "--to-latest"; then
  ok "promote uses --to-latest, never --to-revisions (the pinning trap)"
else
  bad "promote uses --to-latest" "$(cat "$work/calls.log")"
fi

# The regression that matters: update-traffic can move traffic and STILL exit non-zero, and it can
# also exit ZERO having moved nothing. Only reading the split back distinguishes them.
make_fake_gcloud 0 serving
cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"artifacts repositories describe"*) exit 0 ;;
  *"projects describe"*) echo "530312723651"; exit 0 ;;
  *"run services describe"*"status.url"*) echo "https://app-530312723651.us-central1.run.app"; exit 0 ;;
  *"run services describe"*)
      printf '%s' '{"status":{"url":"https://app-530312723651.us-central1.run.app","traffic":[{"tag":"candidate","percent":0,"url":"https://candidate---app.run.app","revisionName":"app-00009-abc"},{"latestRevision":false,"percent":100,"revisionName":"app-00008-old"}]}}'
      exit 0 ;;
  *"update-traffic"*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$work/bin/gcloud"
if run_deploy promote; then
  bad "promote fails when update-traffic exits 0 but the split did not move" "$(cat "$work/out.txt")"
else
  ok "promote fails when update-traffic exits 0 but the split did not move"
fi

# --- an unknown target is a usage error, not a silent success ----------------------------------
make_fake_gcloud 0 serving
run_deploy frobnicate && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 2 ]]; then
  ok "an unknown target exits 2"
else
  bad "an unknown target exits 2" "got $rc: $(cat "$work/out.txt")"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
