#!/usr/bin/env bash
# Single source of truth for the infrastructure checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/terraform.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target] [dir]
#   all       (default) selftest + fmt + init + validate + gates
#   selftest  the unit tests for the gates below
#   fmt       terraform fmt -check -recursive
#   init      terraform init -backend=false   (no credentials, no state, no network to GCS)
#   validate  terraform validate
#   gates     repo-specific invariants that terraform validate cannot express
#
# Deliberately NOT here: `terraform plan`. A plan needs credentials against a live project, and
# Phase 1 has no CI credentials by design (S9 — the keyless path arrives in Phase 3). Planning is
# a human step, documented in docs/runbooks/gcp-bootstrap.md.
set -euo pipefail

cd "$(dirname "$0")"

run() {
  echo
  echo "==> $*"
  "$@"
}

require_terraform() {
  if ! command -v terraform >/dev/null 2>&1; then
    echo "terraform not found. Install it: brew install terraform" >&2
    exit 1
  fi
}

selftest() { run ./tests/gates.test.sh; }
fmt() {
  require_terraform
  run terraform fmt -check -recursive
}
# -backend=false is what makes this runnable with no credentials and no state bucket: it installs
# providers and builds the graph without ever contacting GCS.
init() {
  require_terraform
  run terraform init -backend=false -input=false
}
validate() {
  require_terraform
  run terraform validate
}

# --- Gates: invariants `terraform validate` has no opinion about ---------------------------
#
# Each takes a directory so tests/gates.test.sh can point it at a fixture. Every one is written
# as `if <bad thing found>; then exit 1; fi` and never as `! grep …`: under `set -e`, a command
# whose failure is inverted by `!` is EXEMPT from errexit, so `! grep -q bad *.tf` reports success
# whether or not it found anything. Phase 0 shipped two decorative assertions to exactly that bug.

# S6: a secret payload must never enter Terraform state. Creating the container is fine; creating
# a version means the plaintext is in state, in the plan output, and in every CI log that prints
# a plan. Payloads arrive via `gcloud secrets versions add` — see docs/runbooks/gcp-bootstrap.md.
gate_no_secret_versions() {
  local dir="${1:-.}"
  # Both syntaxes: Terraform loads *.tf.json as configuration too, and a JSON resource keyed
  # "google_secret_manager_secret_version" passes an HCL-shaped regex while `terraform validate`
  # accepts it happily. Matching only *.tf left the S6 gate with a file extension for a bypass.
  if grep -REn '"google_secret_manager_secret_version"' \
    --include='*.tf' --include='*.tf.json' "$dir"; then
    echo "^^ a google_secret_manager_secret_version resource puts a plaintext secret in Terraform" >&2
    echo "   state, which spec S6 forbids. Add the version with 'gcloud secrets versions add'." >&2
    return 1
  fi
  return 0
}

# S7: `terraform destroy` must leave zero billable resources. A prevent_destroy lifecycle turns
# the day-91 teardown into a manual edit-and-retry under time pressure, which is when mistakes
# happen. If something genuinely must survive, it belongs outside Terraform — as the state bucket
# is (P1-D2) — not inside it with a guard rail.
gate_no_prevent_destroy() {
  local dir="${1:-.}"
  # *.tf.json for the same reason as above; in JSON the key/value pair is "prevent_destroy": true.
  if grep -REn 'prevent_destroy"?[[:space:]]*[:=][[:space:]]*true' \
    --include='*.tf' --include='*.tf.json' "$dir"; then
    echo "^^ prevent_destroy blocks the day-91 teardown (spec S7). Keep unmanaged things out of" >&2
    echo "   Terraform entirely instead." >&2
    return 1
  fi
  return 0
}

# S6 again, from the other side: state and real tfvars must never be tracked. .gitignore is a
# request; this is the check. `git ls-files` reads the index, so it catches a `git add -f` that
# .gitignore would otherwise have stopped.
gate_no_state_in_git() {
  local dir="${1:-.}"
  local tracked
  # EVERY *.tfvars, not just the auto-loaded names. `prod.tfvars` is not loaded automatically —
  # it is passed with -var-file — but it holds the same project and billing identifiers, so a
  # gate that only knows the conventional names protects the file naming rather than the secret.
  # terraform.tfvars.example survives because it does not end in .tfvars.
  tracked="$(git -C "$dir" ls-files -- '*.tfstate' '*.tfstate.*' '*.tfvars' '*.tfvars.json' \
    2>/dev/null || true)"
  if [[ -n "$tracked" ]]; then
    echo "tracked by git but must never be: $tracked" >&2
    echo "   Terraform state and real tfvars carry project and billing identifiers (spec S6)." >&2
    return 1
  fi
  return 0
}

gates() {
  local dir="${1:-.}"
  echo
  echo "==> gates ($dir)"
  local rc=0
  # Every gate runs even after one fails: a run that reports all three problems is one fix cycle,
  # a run that reports the first is three.
  gate_no_secret_versions "$dir" || rc=1
  gate_no_prevent_destroy "$dir" || rc=1
  gate_no_state_in_git "$dir" || rc=1
  # An explicit `if`, never `[[ … ]] && echo …`: as the last-but-one command that AND-list would
  # return non-zero when rc is non-zero, errexit would fire on it, and the function would exit
  # BEFORE `return "$rc"` — right answer, wrong path, and it breaks the moment a cleanup step is
  # added below.
  if [[ "$rc" -eq 0 ]]; then
    echo "    all gates passed"
  fi
  return "$rc"
}

all() {
  selftest
  fmt
  init
  validate
  gates .
}

case "${1:-all}" in
all) all ;;
selftest) selftest ;;
fmt) fmt ;;
init) init ;;
validate) validate ;;
gates) gates "${2:-.}" ;;
*)
  echo "unknown target: $1" >&2
  exit 2
  ;;
esac
