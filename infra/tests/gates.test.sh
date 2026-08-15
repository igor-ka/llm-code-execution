#!/usr/bin/env bash
# Unit tests for the gates in infra/verify.sh.
#
# These exist because of a lesson Phase 0 taught four separate times: a check that cannot fail is
# worse than no check, because it reports success. Every gate below is proven to FAIL on bad input
# before it is trusted to pass on good input.
#
# Run directly, or via `./verify.sh selftest` (which is what CI does, first, before anything else).
set -euo pipefail

cd "$(dirname "$0")"
VERIFY="$PWD/../verify.sh"

pass=0
fail=0

# Runs a gate against a fixture directory and asserts the exit status.
expect() {
  local want="$1" desc="$2" dir="$3"
  local got=0
  "$VERIFY" gates "$dir" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    echo "ok   — $desc"
  else
    fail=$((fail + 1))
    echo "FAIL — $desc (wanted exit $want, got $got)"
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- fixture: clean ---
mkdir -p "$work/clean"
cat >"$work/clean/main.tf" <<'EOF'
resource "google_secret_manager_secret" "ok" {
  secret_id = "example"
  replication { auto {} }
}
EOF
git -C "$work/clean" init -q
git -C "$work/clean" add -A
expect 0 "a clean root passes" "$work/clean"

# --- fixture: a secret VERSION resource, which would put a payload in state (S6) ---
mkdir -p "$work/version"
cat >"$work/version/main.tf" <<'EOF'
resource "google_secret_manager_secret_version" "leak" {
  secret      = "projects/p/secrets/s"
  secret_data = "hunter2"
}
EOF
git -C "$work/version" init -q
git -C "$work/version" add -A
expect 1 "a google_secret_manager_secret_version fails the gate" "$work/version"

# --- fixture: prevent_destroy, which would break the day-91 teardown (S7) ---
mkdir -p "$work/prevent"
cat >"$work/prevent/main.tf" <<'EOF'
resource "google_storage_bucket" "keep" {
  name = "x"
  lifecycle {
    prevent_destroy = true
  }
}
EOF
git -C "$work/prevent" init -q
git -C "$work/prevent" add -A
expect 1 "a prevent_destroy lifecycle fails the gate" "$work/prevent"

# --- fixture: state committed to git (S6) ---
mkdir -p "$work/state"
echo 'resource "google_storage_bucket" "b" { name = "x" }' >"$work/state/main.tf"
echo '{"version": 4}' >"$work/state/terraform.tfstate"
git -C "$work/state" init -q
git -C "$work/state" add -A -f
expect 1 "a tracked .tfstate fails the gate" "$work/state"

# --- fixture: a force-added *.auto.tfvars (S6) ---
# .gitignore lists this pattern as a real variable file, so `git add -f` is the only way it lands
# in the index — which is exactly the case a gate reading .gitignore alone would miss. Terraform
# loads *.auto.tfvars automatically, so these carry the same project and billing identifiers as
# terraform.tfvars and must be caught by the same check.
mkdir -p "$work/autotfvars"
echo 'resource "google_storage_bucket" "b" { name = "x" }' >"$work/autotfvars/main.tf"
echo 'project_id = "llm-code-exec-real"' >"$work/autotfvars/prod.auto.tfvars"
git -C "$work/autotfvars" init -q
git -C "$work/autotfvars" add -A -f
expect 1 "a tracked *.auto.tfvars fails the gate" "$work/autotfvars"

echo
echo "passed: $pass  failed: $fail"
[[ "$fail" -eq 0 ]]
