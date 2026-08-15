# Phase 1: GCP Foundation in Terraform Implementation Plan

**Goal:** Stand up every GCP resource the deploy will need — remote state, Artifact Registry, a
least-privilege runtime identity, Secret Manager containers, keyless GitHub federation, and a
budget alarm — as reviewed, gated Terraform, with **nothing deployed and nothing running**.

**Architecture:** One Terraform root at `infra/`, one project, one region, one state bucket. The
bucket is the single resource Terraform does **not** manage — a bucket cannot hold the state that
destroys it — so it is created by an idempotent `infra/bootstrap.sh` and removed last by the
teardown runbook. Terraform creates secret *containers* only; payloads are added out of band with
`gcloud`, which is what makes "no secret in state" true by construction rather than by discipline.
GitHub Actions authenticates through Workload Identity Federation directly against the resources
it needs — no deployer service account, therefore no key to leak. A new `infra/verify.sh` and a
`Terraform checks` CI job mirror each other from the first `.tf` file, per spec D10.

**Tech Stack:** Terraform ~> 1.15.0, `hashicorp/google` ~> 7.42, `gcloud` CLI, GCS remote state,
Bash (gates + bootstrap), GitHub Actions.

**PR boundaries:** six PRs, one child issue each, in this order:

| PR | Deliverable | Closes | Depends on |
| --- | --- | --- | --- |
| 1 | `infra/` root, `Terraform checks` gate, API enablement | #130 | — |
| 2 | Remote state: `bootstrap.sh`, GCS backend, bootstrap runbook | #131 | PR 1 |
| 3 | Artifact Registry + runtime service account + least-privilege IAM | #132 | PR 2 |
| 4 | Secret Manager containers + population runbook | #133 | PR 3 |
| 5 | Workload Identity Federation for GitHub Actions (keyless) | #134 | PR 3 |
| 6 | Budget alarms, teardown runbook, destroy/rebuild proof, README | #135 | PRs 1–5 |

PRs 4 and 5 are independent of each other and can land in either order. **PR 1 is one child, not
two**, even though "the Terraform root" and "the CI gate" are separable: a Terraform root with no
gate is precisely what D10 refuses, and a gate with nothing to check is not a deliverable. **PR 6
is one child, not three**, because the budget alarm, the teardown runbook and the destroy/rebuild
proof are the same claim — S7 and S8 are unprovable apart.

Only PR 1 is offline. **PR 2 is where the 90-day trial clock starts** (D2), which is why
everything that does not need a live project is front-loaded into PR 1.

---

## Why Phase 1 is its own plan

Spec [D3](../specs/2026-08-09-deploy-to-gcp.md) sequences four phases so Terraform learning stays
isolated from app debugging. Phase 0 is merged and the app is deployable anywhere. Phase 1 is the
GCP foundation with **nothing deployed**; Phase 2 is the deploy, by hand; Phase 3 is CD. Each gets
its own plan when its turn comes.

Phase 1 produces independently valuable software by the skill's scope test: after it,
`terraform apply` from an empty project yields a complete, funded, monitored, keyless foundation,
and `terraform destroy` empties it. That is true whether or not Phase 2 ever happens.

## What this plan assumes from the spec

Carried in, not re-litigated: **D1** Cloud Run (not GKE) · **D2** trial credits only, day-91
teardown · **D5** Cloud SQL · **D8** Upstash for Redis, so no Memorystore resource appears here ·
**D10** `infra/` gated by `infra/verify.sh` + a `Terraform checks` job.

## Decisions this plan makes

The spec left two items as "configuration, not architecture" and the rest follow from S6/S7. Each
is called out so a reviewer can overrule it before code exists.

**P1-D1 — Region is `us-central1`, held in one variable.** It has Cloud Run gen2, Cloud SQL, and
is where previews land first; Google publishes no region list for the sandboxes preview
([docs](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes) state the gen2
requirement and the resource-sharing limitation but no regions), so "the region previews reach
first" is the best available proxy. Cost: ~40 ms of extra latency from Montreal versus
`northamerica-northeast1`, and US data residency for disposable learning data. Every resource
reads `var.region`, so reversing this is a one-line change plus a rebuild — which is why
Prerequisite 9 probes the sandbox flag in this region *before* PR 3 pins anything to it.

**P1-D2 — The state bucket is not Terraform-managed.** It is created by `infra/bootstrap.sh` and
deleted by the teardown runbook as its last step. A bucket managed by the state it stores makes
`terraform destroy` a special case forever, and S7's "zero billable resources" then depends on
remembering a manual `terraform state rm`. One documented exception beats a permanent footnote.
The bucket costs fractions of a cent per month; the teardown runbook removes it explicitly so S7
stays honest.

**P1-D3 — Terraform never holds a secret payload.** `google_secret_manager_secret` creates the
container; versions arrive via `gcloud secrets versions add` from the runbook. S6 says no secret
may sit in state — this makes that structural, and `infra/verify.sh` gates it with a grep that
fails if a `google_secret_manager_secret_version` resource is ever added.

**P1-D4 — GitHub Actions gets roles directly on the `principalSet`; there is no deployer service
account.** S9 forbids a long-lived key, and the shortest way to guarantee that is to have no
service account for CI to hold a key for. Risk, stated plainly: some tooling still assumes an
impersonated service account, and if Phase 3 hits that, adding one is additive — the pool and
provider here do not change.

**P1-D5 — Least privilege is granted per resource, never per project.** The runtime identity gets
`roles/secretmanager.secretAccessor` on each secret individually, and **nothing on the registry**:
Cloud Run pulls images as the service agent, not as the service's identity, so a reader binding
here would only widen what a compromised application process can reach. No project-level role
bindings appear in this plan.

**P1-D6 — Two budgets, not one.** A budget that includes credits reports ≈ $0 until the credits
are gone, so a single credit-inclusive alarm fires only once the money is real — too late to be
useful. The gross budget tracks credit burn against the $300; the net budget fires at the first
dollar of actual spend. Both are cheap and both are needed.

**P1-D7 — `Terraform checks` runs on every PR with no `paths:` filter.** `docs/sdlc.md` already
documents the trap: a workflow-level path filter makes a required check never report, which hangs
merges forever. The job is a few seconds; it runs unconditionally.

## Prerequisites

**Before PR 1** — PR 1 needs only Terraform installed and network access to the provider registry.
No GCP account, no credentials.

1. `brew install terraform` (not present on this machine — verified 2026-08-10).

**Before PR 2** — everything below stands up the live project, which starts the 90-day trial
clock (D2).

2. `brew install google-cloud-sdk`.
3. Create the Google Cloud account and activate the $300/90-day trial. **Write the activation date
   down** — it is the input to the day-91 teardown in PR 6.
4. Create the project and note its ID (used as `var.project_id`; the state bucket derives from it):
   `gcloud projects create llm-code-exec-<suffix> --name="LLM code execution"`
5. Set it as the active project — `gcloud config set project <project-id>`. Several later steps
   (`gcloud secrets versions add`, the teardown checks) take no `--project` flag and read this.
6. Link billing: `gcloud billing projects link <project-id> --billing-account=<ACCOUNT_ID>`
7. Enable the two APIs Terraform needs *before* it can enable anything else:

```bash
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  --project <project-id>
```

   This is not redundant with `infra/apis.tf`. `data "google_project" "this"` is read at **plan**
   time, before any resource in `apis.tf` is created, and `user_project_override` bills that read
   to the new project — so a project without Cloud Resource Manager fails the plan with a 403 that
   `apis.tf` can never get far enough to fix. Idempotent, so it costs nothing if they were already
   on.
8. `gcloud auth login` and `gcloud auth application-default login` — Terraform reads the latter.
9. **Confirm Cloud Run sandboxes actually exist in `var.region` before anything pins it.** Five
   minutes, no meaningful spend, and it converts the epic's largest open assumption into a fact
   while reversing it is still cheap:

```bash
gcloud beta run deploy sandbox-probe --region us-central1 \
  --image us-docker.pkg.dev/cloudrun/container/hello \
  --execution-environment gen2 --sandbox-launcher --no-allow-unauthenticated --quiet
gcloud beta run services describe sandbox-probe --region us-central1 \
  --format='value(spec.template.spec.containers[0].sandboxLauncher)'   # expect: True
gcloud run services delete sandbox-probe --region us-central1 --quiet
```

   **Why here and not in Phase 2.** [D6](../specs/2026-08-09-deploy-to-gcp.md) rests the entire
   sandbox design on a **public-preview** feature, and P1-D1 picks the region by proxy because
   Google publishes no availability list for it. From PR 3 onward this plan pins `var.region` into
   the registry, the secrets and the federation; P1-D1's "one line plus a rebuild" stays true only
   while there is nothing to rebuild. Discovering in Phase 2 that the flag is rejected here would
   invalidate the region *after* the secrets are populated.

   If the deploy is rejected — unknown flag, or the region is not supported — **stop and raise it**
   rather than continuing. The choices are a different region (change `var.region`, nothing else)
   or falling back to the Cloud Run Jobs backend D6 rejected, and both are decisions, not
   adjustments.

---

## File Structure

**Created — `infra/`**

| File | Responsibility |
| --- | --- |
| `infra/versions.tf` | `required_version` and the pinned provider constraint. Nothing else. |
| `infra/providers.tf` | The `google` provider: project, region, and the ADC billing-quota settings the Billing Budgets API requires. |
| `infra/variables.tf` | Every input: project, region, billing account, GitHub identity. No defaults for anything environment-specific. |
| `infra/outputs.tf` | The handful of values Phases 2 and 3 consume — registry URL, runtime SA email, WIF provider name. |
| `infra/apis.tf` | `google_project_service` for exactly the APIs Phase 1 uses. |
| `infra/registry.tf` | The Docker repository and its cleanup policy. |
| `infra/identity.tf` | The Cloud Run runtime service account. |
| `infra/secrets.tf` | Secret **containers** and the per-secret accessor bindings. Never a version. |
| `infra/wif.tf` | Workload identity pool, GitHub provider, and the direct role grants. |
| `infra/budget.tf` | The gross and net billing budgets. |
| `infra/backend.tf` | The GCS backend block (PR 2). |
| `infra/bootstrap.sh` | Idempotent creation of the state bucket. The one thing Terraform does not own. |
| `infra/verify.sh` | The single source of truth for infra checks: self-test, fmt, validate, gates. |
| `infra/tests/gates.test.sh` | Unit tests for the three gates, with fixtures. Run first by `verify.sh`. |
| `infra/.gitignore` | State, `.terraform/`, real tfvars, crash logs. |
| `infra/terraform.tfvars.example` | The shape of the real, gitignored `terraform.tfvars`. |
| `infra/README.md` | What this root manages, how to run it, what is deliberately outside it. |
| `infra/.terraform.lock.hcl` | Provider checksums for **both** `darwin_arm64` and `linux_amd64`. Committed. |

**Created — docs**

| File | Responsibility |
| --- | --- |
| `.github/workflows/terraform.yml` | The `Terraform checks` job. Own workflow, mirroring `infra/verify.sh`. |
| `docs/runbooks/gcp-bootstrap.md` | Project → bucket → state migration → secret population. |
| `docs/runbooks/gcp-teardown.md` | The day-91 destroy, including the bucket Terraform does not own. |

**Modified**

| File | Change |
| --- | --- |
| `scripts/check-sdlc-sync.sh` | `WATCHED_RE` gains `infra/verify.sh` and `infra/tests/`. |
| `scripts/tests/check-sdlc-sync.test.sh` | A case proving `infra/verify.sh` is watched. |
| `docs/sdlc.md` | The third `verify.sh`, the new job name, the new watched paths. |
| `README.md` | Layout, Verification, Roadmap. |
| `CLAUDE.md` | "Each side has one script" becomes three. |
| `docs/README.md` | No change needed — `runbooks/` is already indexed. |

---

## PR 1 — the `infra/` root and the gate that guards it

### Task 1: The Terraform root skeleton

**Files:**
- Create: `infra/versions.tf`, `infra/providers.tf`, `infra/variables.tf`,
  `infra/terraform.tfvars.example`, `infra/.gitignore`

- [ ] **Step 1: Create the branch**

```bash
git switch -c feat/infra-terraform-root origin/main
mkdir -p infra/tests
```

- [ ] **Step 2: Pin the versions**

`infra/versions.tf`:

```hcl
# Version pinning is the whole point of this file — nothing else belongs here.
#
# `required_version` is a range, not an exact pin: Terraform refuses to run a state file written
# by a NEWER minor than the binary in hand, so pinning exactly would break the first machine that
# upgraded. The provider is pinned to a minor range because a major bump renames resources.
terraform {
  # `~> 1.15.0`, NOT `~> 1.15`: the two-component form permits 1.16, which can upgrade the
  # state file to a version a 1.15.x workstation cannot read — and CI initializes with
  # `-backend=false`, so it would never catch the mismatch. Bump this and the CI pin together.
  required_version = "~> 1.15.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.42"
    }
  }
}
```

- [ ] **Step 3: Configure the provider**

`infra/providers.tf`:

```hcl
# user_project_override + billing_project are NOT optional here, and the reason is easy to miss.
# The Billing Budgets API (budget.tf) rejects Application Default Credentials — the `gcloud auth
# application-default login` path a laptop uses — with a 403 unless requests carry a quota project.
# Without these two lines every `terraform apply` that touches a budget fails with a permissions
# error that reads like a missing IAM role and is not one.
provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

# The project NUMBER — distinct from the ID, and unavoidable: principalSet strings (wif.tf) and
# budget filters (budget.tf) are both defined in terms of the number. Declared here rather than in
# whichever file first needed it, so neither of those files owns a dependency the other has.
#
# Read at plan time via cloudresourcemanager.googleapis.com, which is enabled by hand in the
# plan's Prerequisites — because this data source is read BEFORE apis.tf can enable anything, and
# user_project_override bills the read to this project. `terraform validate` never reads it, which
# is why CI needs no credentials.
data "google_project" "this" {
  project_id = var.project_id
}
```

- [ ] **Step 4: Declare the inputs**

`infra/variables.tf`:

```hcl
variable "project_id" {
  type        = string
  description = "The GCP project ID. No default: this must be supplied per environment."

  validation {
    # Google's own rule. Caught here, it is one line of output; caught by the API it is a failed
    # apply partway through a dependency graph.
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be 6-30 chars, lowercase letters/digits/hyphens, starting with a letter."
  }
}

variable "region" {
  type        = string
  description = "The single region every regional resource uses (P1-D1)."
  default     = "us-central1"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID in NNNNNN-NNNNNN-NNNNNN form, for the budget alarms."
}

variable "trial_start_date" {
  type        = string
  description = <<-EOT
    The date the $300/90-day trial was activated, as YYYY-MM-DD. This is what makes the
    credit-burn budget measure the TRIAL rather than a calendar month — see budget.tf. It is also
    the input to the day-91 teardown, so it is recorded in docs/runbooks/gcp-bootstrap.md too.
  EOT

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.trial_start_date))
    error_message = "trial_start_date must be YYYY-MM-DD."
  }
}

variable "github_owner_id" {
  type        = string
  description = <<-EOT
    Numeric GitHub account ID of the repository owner. Numeric, not the login name: logins can be
    renamed and re-registered by someone else, and an attribute condition written against a name
    would then trust the wrong account.
  EOT
}

variable "github_repository_id" {
  type        = string
  description = "Numeric GitHub repository ID, for the same reason as github_owner_id."
}

variable "github_repository" {
  type        = string
  description = <<-EOT
    owner/repo. SECURITY-SENSITIVE: this is interpolated into local.github_principal as
    attribute.repository/<value>, so it decides which repository's Actions may assume the roles
    granted in wif.tf. It is a trust boundary, not a label.

    Renaming the repository on GitHub breaks federation until this value is updated and applied —
    the numeric github_repository_id keeps the OWNER pinned across a rename, but the principalSet
    matches on this string.
  EOT
}
```

- [ ] **Step 5: Write the example tfvars and the gitignore**

`infra/terraform.tfvars.example`:

```hcl
# Copy to terraform.tfvars (gitignored) and fill in.
# The numeric GitHub IDs come from:
#   gh api repos/igor-ka/llm-code-execution --jq '{repo: .id, owner: .owner.id}'
project_id           = "llm-code-exec-CHANGEME"
region               = "us-central1"
billing_account      = "000000-000000-000000"
trial_start_date     = "2026-08-15" # the day the $300/90-day trial was activated
github_owner_id      = "12536242"
github_repository_id = "1252938976"
github_repository    = "igor-ka/llm-code-execution"
```

`infra/.gitignore`:

```gitignore
# Terraform working directory and provider binaries.
.terraform/

# State. Never committed — it is in GCS, and it contains resource metadata for the whole project.
*.tfstate
*.tfstate.*
.terraform.tfstate.lock.info

# Real variable values (project + billing account IDs). The .example is the committed shape.
terraform.tfvars
*.auto.tfvars

crash.log
crash.*.log

# NOT ignored, deliberately: .terraform.lock.hcl. It is the provider checksum lock and it MUST be
# committed, or CI resolves a different provider build than the one reviewed here.
```

- [ ] **Step 6: Commit**

```bash
git add infra/versions.tf infra/providers.tf infra/variables.tf \
        infra/terraform.tfvars.example infra/.gitignore
git commit -m "feat(infra): terraform root skeleton with pinned versions"
```

### Task 2: The gates, test-first

**Files:**
- Create: `infra/tests/gates.test.sh`, `infra/verify.sh`

- [ ] **Step 1: Write the failing test**

`infra/tests/gates.test.sh`:

```bash
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

echo
echo "passed: $pass  failed: $fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chmod +x infra/tests/gates.test.sh
./infra/tests/gates.test.sh
```

Expected: every case reports `FAIL` (the `gates` target does not exist yet), and the script exits
non-zero.

- [ ] **Step 3: Write `infra/verify.sh`**

```bash
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
fmt()      { require_terraform; run terraform fmt -check -recursive; }
# -backend=false is what makes this runnable with no credentials and no state bucket: it installs
# providers and builds the graph without ever contacting GCS.
init()     { require_terraform; run terraform init -backend=false -input=false; }
validate() { require_terraform; run terraform validate; }

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
  if grep -REn '^[[:space:]]*resource[[:space:]]+"google_secret_manager_secret_version"' \
      --include='*.tf' "$dir"; then
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
  if grep -REn '^[[:space:]]*prevent_destroy[[:space:]]*=[[:space:]]*true' \
      --include='*.tf' "$dir"; then
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
  # '*.auto.tfvars' and '*.auto.tfvars.json' are in this list because .gitignore classifies them
  # as real variable files too; without them `git add -f infra/prod.auto.tfvars` walks straight
  # through a gate whose whole job is to stop exactly that.
  tracked="$(git -C "$dir" ls-files -- '*.tfstate' '*.tfstate.*' 'terraform.tfvars' \
    'terraform.tfvars.json' '*.auto.tfvars' '*.auto.tfvars.json' 2>/dev/null || true)"
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
  *) echo "unknown target: $1" >&2; exit 2 ;;
esac
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
chmod +x infra/verify.sh
./infra/tests/gates.test.sh
```

Expected:

```
ok   — a clean root passes
ok   — a google_secret_manager_secret_version fails the gate
ok   — a prevent_destroy lifecycle fails the gate
ok   — a tracked .tfstate fails the gate

passed: 4  failed: 0
```

- [ ] **Step 5: Commit**

```bash
git add infra/verify.sh infra/tests/gates.test.sh
git commit -m "feat(infra): verify.sh with tested repo-specific gates"
```

### Task 3: API enablement

**Files:**
- Create: `infra/apis.tf`

- [ ] **Step 1: Write the resource**

`infra/apis.tf`:

```hcl
# Exactly the APIs Phase 1 uses. Phase 2 enables its own (run, sqladmin, servicenetworking) in its
# own plan — an unused enabled API is not a cost, but it is an unexplained line in a review.
locals {
  # iamcredentials: token exchange for Workload Identity Federation.
  # sts: the endpoint WIF trades an OIDC token at.
  # Comments sit above the list, not as trailing comments inside it: `terraform fmt` aligns a run
  # of trailing comments and breaks the run at any line without one, so a partly-commented list
  # reformats on the first `fmt -check` and reddens the gate.
  phase1_apis = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_project_service" "phase1" {
  for_each = toset(local.phase1_apis)

  project = var.project_id
  service = each.value

  # Destroying the project's API enablement on `terraform destroy` is the wrong default here.
  # Enabled APIs cost nothing, disabling one can fail while dependent resources still exist, and
  # the day-91 teardown deletes the whole project anyway. Leaving them on keeps destroy boring.
  disable_on_destroy = false
}
```

- [ ] **Step 2: Verify**

```bash
cd infra && ./verify.sh && cd ..
```

Expected: `terraform init -backend=false` downloads the provider, `validate` prints
`Success! The configuration is valid.`, and all four gate tests pass.

- [ ] **Step 3: Lock the provider for both platforms**

```bash
cd infra
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
cd ..
```

Expected: `.terraform.lock.hcl` is written or updated, containing `h1:` hashes for **both**
platforms. This step is not optional and its omission is a classic CI failure: a lock file
generated only on a Mac makes `terraform init` on `ubuntu-latest` fail with *"provider ... does
not have a package available for your current platform, linux_amd64"*.

- [ ] **Step 4: Commit**

```bash
git add infra/apis.tf infra/.terraform.lock.hcl
git commit -m "feat(infra): enable the APIs phase 1 uses"
```

### Task 4: The `Terraform checks` CI job

**Files:**
- Create: `.github/workflows/terraform.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/terraform.yml`:

```yaml
name: Terraform

# Its own workflow rather than a job in ci.yml so the Terraform toolchain setup does not sit in
# the middle of the Node pipeline, and so this job's history is readable on its own.
#
# NO `paths:` filter, deliberately. This is a required check, and a workflow-level path filter
# makes a required check never report at all — which hangs every merge forever. docs/sdlc.md
# records the same trap for the SDLC docs job. The whole job runs in seconds; it runs on
# everything.
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: terraform-${{ github.ref }}
  cancel-in-progress: true

# Read-only. This job never authenticates to GCP: it runs `terraform init -backend=false` and
# `validate`, which need no credentials. `terraform plan` is deliberately absent — see
# infra/verify.sh.
permissions:
  contents: read

jobs:
  terraform:
    # The job `name:` is a contract — the "Protect main" ruleset requires it by this exact
    # string. See docs/sdlc.md.
    name: Terraform checks
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.15.8"
          # The wrapper rewrites stdout to feed step outputs, which mangles verify.sh's own
          # output for no benefit here.
          terraform_wrapper: false
      # Named steps calling targets of the shared verify.sh — the same script developers run
      # locally (`./verify.sh` runs them all). Splitting them gives per-step pass/fail in the log
      # without a second definition of the checks.
      - name: Gate self-test
        run: ./verify.sh selftest
      - name: Format check
        run: ./verify.sh fmt
      - name: Init
        run: ./verify.sh init
      - name: Validate
        run: ./verify.sh validate
      - name: Gates
        run: ./verify.sh gates
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/terraform.yml
git commit -m "ci: add the Terraform checks job mirroring infra/verify.sh"
```

### Task 5: Wire the new script into the SDLC contract

**Files:**
- Modify: `scripts/check-sdlc-sync.sh:23`, `scripts/tests/check-sdlc-sync.test.sh`

- [ ] **Step 1: Add the failing test case**

The existing suite covers only the two early-exit branches — the `[skip-sdlc-sync]` title hatch
and the dependabot exemption — and its header says the diff logic is deliberately uncovered
because exercising it needs merge refs and a moving base. **Do not build that harness here.** What
PR 1 actually changes is one regular expression, and a regular expression can be tested directly
with no git state at all.

Append to `scripts/tests/check-sdlc-sync.test.sh`, after the existing cases and before the
final summary/exit lines, using the file's own `ok`/`bad` helpers:

```bash
# --- WATCHED_RE ---
#
# The path list is the other half of this script's contract, and until now nothing checked it: a
# typo in the alternation (a missing backslash, a stray anchor) silently un-watches a path and
# the failure mode is invisible — PRs go green that should have been red.
#
# Extracted from the script rather than duplicated here, because a copy would drift and then
# assert against itself. Single-quoted assignment on its own line is the shape it has; if that
# ever changes, this extraction yields empty and every case below fails loudly, which is the
# correct outcome.
WATCHED_RE="$(sed -n "s/^WATCHED_RE='\(.*\)'\$/\1/p" "$SCRIPT")"

if [[ -z "$WATCHED_RE" ]]; then
  bad "WATCHED_RE extraction" "could not parse WATCHED_RE out of $SCRIPT" ""
fi

# Herestrings, not pipes, for the same reason check-sdlc-sync.sh:78-81 already documents: `grep -q`
# exits on first match, the writer takes SIGPIPE and returns 141, and this file's `pipefail`
# (line 17) makes 141 the pipeline's status. In `unwatched()` that inverts to a pass — a gate that
# cannot fail. The repo has paid for this lesson once already.

# watched <name> <path> — the path must be governed by the SDLC contract.
watched() {
  if grep -Eq "$WATCHED_RE" <<<"$2"; then
    ok "$1"
  else
    bad "$1" "expected '$2' to be watched" ""
  fi
}

# unwatched <name> <path> — the path must NOT drag docs/sdlc.md into every change.
unwatched() {
  if grep -Eq "$WATCHED_RE" <<<"$2"; then
    bad "$1" "expected '$2' NOT to be watched" ""
  else
    ok "$1"
  fi
}

watched   "backend/verify.sh is watched"        "backend/verify.sh"
watched   "frontend/verify.sh is watched"       "frontend/verify.sh"
watched   "infra/verify.sh is watched"          "infra/verify.sh"
watched   "infra/tests/ is watched"             "infra/tests/gates.test.sh"
watched   "workflows are watched"               ".github/workflows/terraform.yml"
watched   "scripts/ is watched"                 "scripts/check-sdlc-sync.sh"
# The Terraform CONFIG is not a process change. Watching all of infra/ would force a docs/sdlc.md
# edit on every resource added for the rest of the project's life, and a contract that fires on
# everything is one people learn to bypass.
unwatched "infra/*.tf is not watched"           "infra/wif.tf"
unwatched "infra/bootstrap.sh is not watched"   "infra/bootstrap.sh"
unwatched "backend source is not watched"       "backend/src/log.ts"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
./scripts/tests/check-sdlc-sync.test.sh
```

Expected, exactly (this was run against today's `check-sdlc-sync.sh` while writing the plan, so
it is observed output rather than a prediction):

```
  ✓ backend/verify.sh is watched
  ✓ frontend/verify.sh is watched
  ✗ infra/verify.sh is watched — expected 'infra/verify.sh' to be watched
  ✗ infra/tests/ is watched — expected 'infra/tests/gates.test.sh' to be watched
  ✓ workflows are watched
  ✓ scripts/ is watched
  ✓ infra/*.tf is not watched
  ✓ infra/bootstrap.sh is not watched
  ✓ backend source is not watched
```

Seven passes and two failures is the point: the passes prove the extraction and the matcher work,
so the two failures are about the regex and not about the harness.

- [ ] **Step 3: Extend the watched paths**

`scripts/check-sdlc-sync.sh:23`, replacing the existing `WATCHED_RE`:

```bash
WATCHED_RE='^(\.claude/skills/|\.github/workflows/|scripts/|infra/tests/|backend/verify\.sh$|frontend/verify\.sh$|infra/verify\.sh$)'
```

- [ ] **Step 4: Run it to verify it passes**

```bash
./scripts/tests/check-sdlc-sync.test.sh
```

Expected: every case passes — the nine above plus the suite's pre-existing early-exit cases.
(The nine were verified against this exact regex while the plan was written.)

- [ ] **Step 5: Update `docs/sdlc.md`** — four places, each required by the contract. The
  watched-path list is stated in four documents and all four drift together; grep
  `either \`verify.sh\`` across the repo before declaring this step done.

0. **The opening contract statement, `docs/sdlc.md:5-9`**: "either `verify.sh`" becomes "any of
   the three `verify.sh` scripts", and `infra/tests/` joins that sentence's list.

1. **"Changing this SDLC" → the watched-paths list**: `backend/verify.sh` or `frontend/verify.sh`
   becomes `backend/verify.sh`, `frontend/verify.sh` or `infra/verify.sh`, and add
   `infra/tests/**`.
2. **"Verify — the deterministic gate"**: extend the existing command block with a third line, and
   add the paragraph below it. The block becomes:

````markdown
```bash
cd backend  && ./verify.sh     # eslint, prettier, tsc, vitest, build, docker images
cd frontend && ./verify.sh     # eslint, prettier, vitest, tsc -b && vite build, docker image
cd infra    && ./verify.sh     # gate self-test, terraform fmt/init/validate, repo-specific gates
```

The infra script deliberately stops short of `terraform plan`. A plan needs credentials against a
live project, and there are none in CI by design — S9 of the deploy spec forbids a long-lived key
and the keyless path does not arrive until Phase 3. What CI can prove without credentials is that
the configuration parses, is formatted, and upholds three invariants `terraform validate` has no
opinion about: no secret payload may enter state, no `prevent_destroy` may block the day-91
teardown, and no state file or real `terraform.tfvars` may be tracked by git. Each gate has a unit
test that proves it *fails* on bad input, which is the property Phase 0 learned to check for.
````

3. **"How this meets CI/CD"**: add `Terraform checks` to the diagram and to the job-name contract
   sentence, which becomes *"The ruleset requires `Backend checks`, `Frontend checks`, `SDLC
   docs`, `PR shape` and `Terraform checks` by name."*

- [ ] **Step 6: Update `README.md`** — four places:

- **Layout** (near `README.md:47`): add the `infra/` entry with its `verify.sh`.
- **Verification** (`README.md:261`): "Each side has a single `verify.sh`" becomes three, with the
  infra one and the same "no plan, no credentials" note as above, compressed to two sentences.
- **`README.md:271`**: "Both accept `SKIP_INSTALL=1` … and `SKIP_DOCKER=1`" becomes "The backend
  and frontend scripts accept …" — the infra script accepts neither.
- **`README.md:275`**: the `SDLC docs` watched-path list — "either `verify.sh`, `scripts/**`, or
  `.github/workflows/**`" becomes "any of the three `verify.sh` scripts, `infra/tests/**`,
  `scripts/**`, or `.github/workflows/**`".

- [ ] **Step 7: Update `CLAUDE.md`** — five places:

- **"Checks before pushing"** (`CLAUDE.md:40`): add `- Infra: cd infra && ./verify.sh`.
- **`CLAUDE.md:45`**: "Both accept `SKIP_INSTALL=1` and `SKIP_DOCKER=1`" becomes "The backend and
  frontend scripts accept `SKIP_INSTALL=1` and `SKIP_DOCKER=1`."
- **`CLAUDE.md:16`**: the SDLC-sync contract's "either `verify.sh`" becomes "any of the three
  `verify.sh` scripts".
- **`CLAUDE.md:102`**: the required-check list `(Backend checks, Frontend checks, SDLC docs, PR
  shape)` gains `Terraform checks`. Task 6 adds it to the live ruleset; leaving this line stale
  breaks the repo's own "CI job names are a contract" section on the day it starts mattering.
- **The skill routing table**: add a row — *"Touching `infra/**` → `security-and-hardening`
  (threat-model first)"*. Infrastructure defines the blast radius of everything else; it belongs
  in the same row as `sandbox/**`.

- [ ] **Step 8: Verify the whole repo**

```bash
./scripts/tests/check-sdlc-sync.test.sh
cd infra && ./verify.sh && cd ..
```

Expected: both green.

- [ ] **Step 9: Commit and open the PR**

```bash
git add scripts/check-sdlc-sync.sh scripts/tests/check-sdlc-sync.test.sh \
        docs/sdlc.md README.md CLAUDE.md
git commit -m "docs(sdlc): record the third verify.sh and the Terraform checks job"
git push -u origin feat/infra-terraform-root
gh pr create --title "feat(infra): the Terraform root and the check that guards it" \
             --body "Closes #130. …"
```

### Task 6: Make `Terraform checks` required — after the merge, not before

- [ ] **Step 1: Merge PR 1 first.** The ordering matters and is the opposite of the intuition:
  adding a required check to the ruleset while its workflow exists only on a branch blocks **every
  other open PR** immediately, because the check can never report on branches that predate it. The
  contract in `CLAUDE.md` is that the ruleset changes as part of the same change — not that the
  API call precedes the merge.

- [ ] **Step 2: Back up the ruleset first.** This is a blind `PUT` over the branch protection on
  `main`. A bad transform does not error — it silently replaces the rules, and there is no undo
  without a copy of what was there.

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 > ~/ruleset-backup.json
```

- [ ] **Step 3: Add the required check**

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  | jq '{name, target, enforcement, conditions, rules, bypass_actors}
        | .rules |= map(
            if .type == "required_status_checks"
            then .parameters.required_status_checks += [{context: "Terraform checks"}]
            else . end)' \
  > ~/ruleset-with-terraform.json

gh api --method PUT repos/igor-ka/llm-code-execution/rulesets/17055903 \
  --input ~/ruleset-with-terraform.json
```

- [ ] **Step 4: Confirm, then clean up**

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

Expected: five lines — `Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape`,
`Terraform checks`.

Only once those five print, remove the working files:

```bash
rm ~/ruleset-with-terraform.json ~/ruleset-backup.json
```

To restore if anything went wrong:
`gh api --method PUT repos/igor-ka/llm-code-execution/rulesets/17055903 --input ~/ruleset-backup.json`

---

## PR 2 — remote state

Everything from here needs the live project from **Prerequisites**.

### Task 7: The bootstrap script

**Files:**
- Create: `infra/bootstrap.sh`

- [ ] **Step 1: Write it**

`infra/bootstrap.sh`:

```bash
#!/usr/bin/env bash
# Create the GCS bucket that holds Terraform's state. This is the ONE resource Terraform does not
# manage, and the reason is structural rather than stylistic (plan P1-D2): a bucket managed by the
# state it stores makes every `terraform destroy` a special case, and spec S7's "zero billable
# resources" would then rest on remembering a manual `terraform state rm` under time pressure.
#
# The teardown runbook (docs/runbooks/gcp-teardown.md) deletes this bucket as its final step.
#
# Idempotent: safe to re-run. Usage: ./bootstrap.sh <project-id> [region]
set -euo pipefail

project="${1:?usage: ./bootstrap.sh <project-id> [region]}"
region="${2:-us-central1}"
bucket="${project}-tfstate"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install it: brew install google-cloud-sdk" >&2
  exit 1
fi

# No --project on describe: bucket names are global, and the flag is not accepted here.
if gcloud storage buckets describe "gs://${bucket}" >/dev/null 2>&1; then
  echo "==> gs://${bucket} already exists"
else
  echo "==> creating gs://${bucket}"
  # --uniform-bucket-level-access: ACLs are legacy and make "who can read this" unanswerable.
  # --public-access-prevention: state names every resource in the project. Never public.
  gcloud storage buckets create "gs://${bucket}" \
    --project "$project" \
    --location "$region" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

# Versioning is the undo button for a corrupted or truncated state file, which is the one failure
# in Terraform with no other recovery path.
echo "==> enabling object versioning"
gcloud storage buckets update "gs://${bucket}" --versioning

# Without a lifecycle rule, every apply keeps a noncurrent version forever. 10 is far more history
# than this project will ever need and keeps the bucket's cost at effectively zero.
echo "==> capping noncurrent versions at 10"
lifecycle="$(mktemp)"
trap 'rm -f "$lifecycle"' EXIT
cat >"$lifecycle" <<'JSON'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"numNewerVersions": 10}
    }
  ]
}
JSON
gcloud storage buckets update "gs://${bucket}" --lifecycle-file="$lifecycle"

echo
echo "==> done. Backend config:"
echo "    bucket = \"${bucket}\""
```

- [ ] **Step 2: Run it against the real project**

```bash
chmod +x infra/bootstrap.sh
./infra/bootstrap.sh <project-id> us-central1
```

Expected: the bucket is created, versioning enabled, lifecycle set, and the final line prints the
bucket name. Re-run it once and confirm it prints `already exists` and still exits 0.

- [ ] **Step 3: Commit**

```bash
git switch -c feat/infra-remote-state origin/main
git add infra/bootstrap.sh
git commit -m "feat(infra): bootstrap the terraform state bucket"
```

### Task 8: Point Terraform at the bucket

**Files:**
- Create: `infra/backend.tf`

- [ ] **Step 1: Write the backend block**

`infra/backend.tf`:

```hcl
# Partial configuration: the bucket name is supplied at init time rather than hardcoded, because
# it derives from the project ID and this root is meant to be reproducible into a fresh project
# (spec S7). See docs/runbooks/gcp-bootstrap.md for the exact init command.
#
# `terraform init -backend=false` — what infra/verify.sh and CI run — skips this block entirely,
# which is what lets the checks run with no credentials and no bucket.
terraform {
  backend "gcs" {
    prefix = "phase1"
  }
}
```

- [ ] **Step 2: Initialise against the real bucket**

```bash
cd infra
terraform init -backend-config="bucket=<project-id>-tfstate"
```

Expected: `Successfully configured the backend "gcs"!` and `Terraform has been successfully
initialized!`. There is no local state to migrate — this root has never been applied.

- [ ] **Step 3: Apply what exists so far**

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill in the real values
terraform apply
```

Expected: 8 `google_project_service` resources created. Confirm the file is gitignored:

```bash
git check-ignore -v terraform.tfvars
```

Expected: a line naming `infra/.gitignore`.

- [ ] **Step 4: Prove the state landed in the bucket, not on disk**

```bash
ls terraform.tfstate 2>&1
gcloud storage ls "gs://<project-id>-tfstate/phase1/"
```

Expected: `No such file or directory` locally, and `default.tfstate` in the bucket.

- [ ] **Step 5: Verify and commit**

```bash
./verify.sh && cd ..
git add infra/backend.tf
git commit -m "feat(infra): store terraform state in GCS"
```

### Task 9: The bootstrap runbook

**Files:**
- Create: `docs/runbooks/gcp-bootstrap.md`

- [ ] **Step 1: Write it.** Sections, in order, each as copy-pasteable commands:

1. **Prerequisites** — `brew install terraform google-cloud-sdk`, the trial activation, and *"write
   the activation date here: `____`"* as a fill-in line, because it is the input to the teardown.
2. **Create and link the project** — the `gcloud projects create` / `gcloud billing projects link`
   pair from this plan's Prerequisites.
3. **Authenticate** — `gcloud auth login`, `gcloud auth application-default login`, and the note
   that Terraform reads the second, not the first.
4. **Bootstrap the state bucket** — `./infra/bootstrap.sh <project-id> us-central1`.
5. **Initialise Terraform** — the `-backend-config` init, and `cp terraform.tfvars.example
   terraform.tfvars`.
6. **Apply** — `terraform plan` then `terraform apply`, with *"read the plan; it is the review"*.
7. **Populate the secrets** — left as a forward reference until PR 4 fills it in.
8. **What is not managed here** — the state bucket, and why (P1-D2), with a pointer to the
   teardown runbook.

- [ ] **Step 2: Commit and open the PR**

```bash
git add docs/runbooks/gcp-bootstrap.md
git commit -m "docs(runbooks): bootstrap a GCP project for this repo"
git push -u origin feat/infra-remote-state
gh pr create --title "feat(infra): remote state in GCS" --body "Closes #131. …"
```

---

## PR 3 — registry and runtime identity

### Task 10: Artifact Registry

**Files:**
- Create: `infra/registry.tf`

- [ ] **Step 1: Write the resource**

`infra/registry.tf`:

```hcl
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "app"
  description   = "Container images for ${var.github_repository}"
  format        = "DOCKER"

  # Cleanup policies are not cosmetic on a fixed budget. Every pushed image is billed storage for
  # as long as it exists, and a CD pipeline (Phase 3) pushes one per merge. Untagged layers left
  # behind by a re-tag are pure waste.
  #
  # dry_run = false means these DELETE. That is intended: nothing here is a release artifact worth
  # keeping — Phase 2 deploys by hand from a tag, and a lost image is one `docker push` away.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state = "UNTAGGED"
      # A grace period, not zero: an untagged image is briefly the normal state during a push,
      # and deleting one mid-push is a race the registry should not be asked to win.
      older_than = "604800s" # protobuf Duration — a "7d" suffix is rejected
    }
  }

  # Without this, nothing above ever deletes a tagged image. A KEEP policy only PROTECTS artifacts
  # from DELETE policies — it deletes nothing on its own — so keep-recent-releases paired only with
  # delete-untagged would let every tagged image accumulate forever, which is the opposite of this
  # block's stated purpose. This is the policy that does the work; keep-recent-releases is what
  # stops it from eating the newest five.
  cleanup_policies {
    id     = "delete-old-tagged"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "2592000s" # protobuf Duration — a "30d" suffix is rejected
    }
  }

  depends_on = [google_project_service.phase1]
}
```

- [ ] **Step 2: Verify and apply**

```bash
cd infra && ./verify.sh && terraform apply && cd ..
```

Expected: `google_artifact_registry_repository.app` created. `terraform validate` is green.

- [ ] **Step 3: Commit**

```bash
git switch -c feat/infra-registry-identity origin/main
git add infra/registry.tf
git commit -m "feat(infra): artifact registry with a cleanup policy"
```

### Task 11: The runtime service account

**Files:**
- Create: `infra/identity.tf`

- [ ] **Step 1: Write the resources**

`infra/identity.tf`:

```hcl
# The identity the Cloud Run service RUNS as — not the identity that deploys it. Cloud Run's
# default is the Compute Engine default service account, which holds project Editor: a
# compromised app process would inherit the ability to rewrite the whole project. This account
# starts with nothing and is granted exactly two things, both per-resource (P1-D5): read the
# images it runs, and read the secrets it needs. The secret grants live in secrets.tf, next to
# the secrets they name.
resource "google_service_account" "runtime" {
  account_id   = "app-runtime"
  display_name = "Cloud Run runtime identity"
  description  = "Runs the llm-code-execution service. Deploys are performed by a federated GitHub identity, not by this account."

  depends_on = [google_project_service.phase1]
}

# NO artifactregistry.reader for the runtime identity — deliberately.
#
# Cloud Run pulls the image with the Cloud Run SERVICE AGENT
# (service-<number>@serverless-robot-prod.iam.gserviceaccount.com), not with the service's runtime
# identity, and in a same-project setup that agent already holds the access. Granting the runtime
# SA a reader role would hand a compromised application process the ability to enumerate and pull
# every image in the repository, buying nothing — which is exactly what P1-D5 exists to prevent.
#
# If Phase 2 ever pulls from a DIFFERENT project, it is the service agent of the consuming
# project that needs the grant, still not this identity.
```

- [ ] **Step 2: Write the outputs**

`infra/outputs.tf`:

```hcl
output "registry_url" {
  description = "Docker registry host/path to tag images for. Phase 2 and 3 push here."
  # The provider exports this already — hand-assembling "${var.region}-docker.pkg.dev/…" would be
  # a second copy of Google's URL format, and the copy is the one that goes stale.
  value = google_artifact_registry_repository.app.registry_uri
}

output "runtime_service_account" {
  description = "Email of the identity Cloud Run runs as. Phase 2 passes this to --service-account."
  value       = google_service_account.runtime.email
}
```

- [ ] **Step 3: Verify, apply, and check the outputs**

```bash
cd infra && ./verify.sh && terraform apply && terraform output && cd ..
```

Expected: `registry_url = "us-central1-docker.pkg.dev/<project-id>/app"` and
`runtime_service_account = "app-runtime@<project-id>.iam.gserviceaccount.com"`.

- [ ] **Step 4: Prove the account has no project-level roles**

```bash
gcloud projects get-iam-policy <project-id> \
  --flatten="bindings[].members" \
  --filter="bindings.members:app-runtime@<project-id>.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
```

Expected: **no output.** Any line here means a project-level binding crept in and P1-D5 is
violated. This is the check that makes least privilege a fact rather than an intention.

- [ ] **Step 5: Commit and open the PR**

```bash
git add infra/identity.tf infra/outputs.tf
git commit -m "feat(infra): least-privilege runtime service account"
git push -u origin feat/infra-registry-identity
gh pr create --title "feat(infra): artifact registry and the runtime identity" \
             --body "Closes #132. …"
```

---

## PR 4 — Secret Manager containers

### Task 12: The secrets

**Files:**
- Create: `infra/secrets.tf`

- [ ] **Step 1: Write the resources**

`infra/secrets.tf`:

```hcl
# CONTAINERS ONLY. No google_secret_manager_secret_version appears in this repository, and
# infra/verify.sh fails if one ever does (spec S6): a version resource puts the plaintext in
# Terraform state, in every plan output, and in any CI log that prints a plan. Payloads are added
# with `gcloud secrets versions add` — see docs/runbooks/gcp-bootstrap.md.
#
# The consequence is deliberate and belongs in the runbook, not in a surprise: `terraform destroy`
# removes the containers and every version with them, so a rebuild re-runs the population step.
locals {
  # Named for what the backend reads them as, so the mapping to backend/src/config.ts is obvious
  # at a glance and Phase 2's --set-secrets flags write themselves.
  secrets = {
    "anthropic-api-key" = "ANTHROPIC_API_KEY — Claude API key used for generation and judgment"
    "database-url"      = "DATABASE_URL — Cloud SQL connection string for chat history"
    "redis-url"         = "REDIS_URL — Upstash connection string; the backend refuses to boot without it"
    "oidc-audience"     = "OIDC_AUDIENCE — Auth0 API identifier"
    "oidc-issuer"       = "OIDC_ISSUER — Auth0 tenant issuer URL, with its trailing slash"
    # Not derived from the issuer anywhere in the backend: config.ts:106 reads OIDC_JWKS_URL with
    # an empty default and auth.ts:74 hands it straight to jwksFor(). Omit this container and a
    # Phase 2 deploy wired from this list verifies exactly zero tokens.
    "oidc-jwks-url" = "OIDC_JWKS_URL — Auth0 JWKS endpoint"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = local.secrets

  secret_id = each.key
  labels    = { component = "backend" }

  replication {
    # Automatic replication rather than pinning to var.region: Secret Manager charges per
    # replica-location for user-managed replication and nothing extra for automatic, and there is
    # no data-residency requirement here (P1-D1 already accepted US storage).
    auto {}
  }

  # Explicitly false. The default has changed across provider majors, and a secret that refuses to
  # delete would block the day-91 teardown — the same failure the prevent_destroy gate exists to
  # catch, arriving through a different door.
  deletion_protection = false

  depends_on = [google_project_service.phase1]
}

# One binding per secret, not one project-level role. If a sixth secret is added later for some
# unrelated component, the runtime account does not silently gain access to it.
resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
```

- [ ] **Step 2: Prove the gate would catch a violation**

Temporarily append to `infra/secrets.tf`:

```hcl
resource "google_secret_manager_secret_version" "should_be_rejected" {
  secret      = google_secret_manager_secret.app["anthropic-api-key"].id
  secret_data = "sk-ant-not-a-real-key"
}
```

Then:

```bash
cd infra && ./verify.sh gates
```

Expected: exit 1, with the message naming the file and line and pointing at `gcloud secrets
versions add`. **Delete the block again** before continuing. This step is the difference between
believing the gate works and knowing it does.

- [ ] **Step 3: Verify and apply**

```bash
./verify.sh && terraform apply && cd ..
```

Expected: six secrets and six IAM members created.

- [ ] **Step 4: Populate the payloads and confirm they are not in state**

```bash
# The key already lives in the repo-root .env that local dev uses; read it from there rather than
# retyping it. `set -a` exports what the file assigns so the subshell below can see it.
set -a && . ./.env && set +a
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets versions add anthropic-api-key --data-file=-
cd infra && terraform state pull | grep -c "sk-ant" ; cd ..
```

Expected: the version is created, and the `grep -c` prints `0`. `printf` rather than `echo`
because a trailing newline becomes part of the secret and produces an API key that fails
authentication for reasons nothing will explain.

- [ ] **Step 5: Extend the bootstrap runbook** — replace section 7's forward reference with the
  real `gcloud secrets versions add` commands, the `printf` warning, and the note that
  `terraform destroy` deletes them.

  **Terraform creates all six containers; Phase 1 populates only the four whose values exist.**
  `anthropic-api-key`, `oidc-issuer`, `oidc-audience` and `oidc-jwks-url` come from the repo-root
  `.env` today. `database-url` has no value until Cloud SQL exists (D5, Phase 2) and `redis-url`
  needs an Upstash instance no phase has provisioned yet — D8 notes Upstash carries its own
  provider credential and sits outside `terraform destroy`, so standing it up belongs with the
  deploy that needs it, not here. Creating the containers now is still the right split: the
  naming and the per-secret IAM bindings *are* the Phase 1 deliverable, and a secret with zero
  versions is legal and free.

  §7 must therefore say, explicitly, which two are empty and which phase fills them — an empty
  container that nobody flagged is exactly the kind of thing Phase 2 discovers at deploy time.

- [ ] **Step 6: Commit and open the PR**

```bash
git switch -c feat/infra-secrets origin/main
git add infra/secrets.tf docs/runbooks/gcp-bootstrap.md
git commit -m "feat(infra): secret containers with per-secret access"
git push -u origin feat/infra-secrets
gh pr create --title "feat(infra): secret manager containers, payloads out of band" \
             --body "Closes #133. …"
```

---

## PR 5 — keyless GitHub federation

### Task 13: The pool and provider

**Files:**
- Create: `infra/wif.tf`

- [ ] **Step 1: Write the resources**

`infra/wif.tf`:

```hcl
# Workload Identity Federation: GitHub Actions exchanges its short-lived OIDC token for a GCP
# access token. Spec S9 forbids a long-lived service-account key anywhere, and the surest way to
# honour that is for no key to exist — there is no deployer service account here at all (P1-D4).
# Roles are granted directly to the federated principalSet below.
#
# `data.google_project.this` lives in providers.tf — the project number is needed here and in
# budget.tf, and neither file should own it for the other.

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Federated identities for CI in ${var.github_repository}"

  depends_on = [google_project_service.phase1]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  # THE load-bearing line. Without an attribute condition, any GitHub Actions workflow in the
  # world can present a token this pool accepts — GitHub's issuer is shared by every repository
  # on the platform. Google's own guidance is explicit that a condition restricting the issuing
  # organisation is mandatory, not advisory.
  #
  # Numeric IDs, not names: a GitHub login or repository name can be renamed and the old name
  # re-registered by someone else, at which point a name-based condition trusts a stranger. The
  # numeric IDs are permanent.
  #
  # ref/ref_type pin it further to pushes on the default branch, so a token minted by a workflow
  # on a topic branch cannot deploy. The repository being public makes this worth having twice
  # over — though note GitHub already withholds `id-token: write` from fork pull requests, so
  # this is defence in depth rather than the only line.
  attribute_condition = <<-EOT
    assertion.repository_owner_id == "${var.github_owner_id}" &&
    assertion.repository_id == "${var.github_repository_id}" &&
    assertion.ref == "refs/heads/main" &&
    assertion.ref_type == "branch"
  EOT

  # Map only what a condition or a principalSet actually reads. Every extra mapped claim is one
  # more thing an IAM binding elsewhere could accidentally come to depend on.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
```

- [ ] **Step 2: Write the direct role grants**

Append to `infra/wif.tf`:

```hcl
locals {
  # Everything from this repository's main branch, and nothing else. Scoped by attribute.repository
  # rather than principalSet://…/* — the pool-wide form would grant these roles to any identity the
  # pool ever accepts, including a provider added later for something unrelated.
  github_principal = "principalSet://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}

# Push images. Writer, not admin: CI never needs to delete a repository or change its IAM.
resource "google_artifact_registry_repository_iam_member" "ci_writer" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = local.github_principal
}

# Deploy revisions. roles/run.admin is project-scoped by nature — there is no Cloud Run service to
# scope it to until Phase 2 creates one. This is the one binding in the plan that is broader than
# P1-D5 would like, and it is stated rather than hidden; Phase 2 should narrow it to the service
# once that service exists.
resource "google_project_iam_member" "ci_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = local.github_principal
}

# Deploying a service that RUNS AS the runtime account requires actAs on that account. Granted on
# the one account, not project-wide: without this scoping, CI could run code as any service
# account in the project, which is the standard way a deploy pipeline becomes a privilege
# escalation path.
resource "google_service_account_iam_member" "ci_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.github_principal
}
```

- [ ] **Step 3: Add the output Phase 3 needs**

Append to `infra/outputs.tf`:

```hcl
output "workload_identity_provider" {
  description = "Full resource name for google-github-actions/auth's workload_identity_provider input."
  value       = google_iam_workload_identity_pool_provider.github.name
}
```

- [ ] **Step 4: Verify and apply**

```bash
cd infra && ./verify.sh && terraform apply && terraform output workload_identity_provider && cd ..
```

Expected: the pool, provider and three bindings are created, and the output is
`projects/<number>/locations/global/workloadIdentityPools/github/providers/github-actions`.

- [ ] **Step 5: Prove the condition rejects the wrong repository**

```bash
cd infra
terraform state show google_iam_workload_identity_pool_provider.github | grep -A6 attribute_condition
cd ..
```

Expected: the condition text contains both numeric IDs. A condition that is empty, or that names
`igor-ka` as a string rather than `12536242`, is the finding this step exists to surface.

> **Not verified in this PR:** that a real GitHub Actions run can authenticate. That needs a
> workflow using `google-github-actions/auth`, which is Phase 3's deliverable — and the risk it
> carries is P1-D4's: if federated-only access turns out to be unworkable for some tool, Phase 3
> adds an impersonated service account without touching anything here.

- [ ] **Step 6: Commit and open the PR**

```bash
git switch -c feat/infra-wif origin/main
git add infra/wif.tf infra/outputs.tf
git commit -m "feat(infra): keyless GitHub federation, scoped to main"
git push -u origin feat/infra-wif
gh pr create --title "feat(infra): workload identity federation for GitHub Actions" \
             --body "Closes #134. …"
```

---

## PR 6 — the budget, the teardown, and the proof

### Task 14: Two budgets

**Files:**
- Create: `infra/budget.tf`

- [ ] **Step 1: Write the resources**

`infra/budget.tf`:

```hcl
# Two budgets, because one cannot express both questions (P1-D6).
#
# By default a budget measures spend NET of credits — which, on a $300 trial, reads ≈ $0 until the
# credits are exhausted. A single default budget therefore stays silent through the entire period
# it is supposed to be watching, then fires once the money is real. That is the wrong alarm.
#
# The OTHER default is just as load-bearing and less obvious: with neither calendar_period nor
# custom_period set, the API applies calendar_period = MONTH. A gross budget of $300 per calendar
# MONTH would never fire at this project's burn rate (~$8-10/mo), silently reproducing the exact
# failure this pair exists to prevent. custom_period pins the first budget to the trial itself.
#
# Both notify the billing account's admins and users by email, which requires no Pub/Sub topic and
# no monitoring notification channel. For a single-owner project that is the whole audience.

locals {
  # tonumber because the API wants integers, not the zero-padded strings the date splits into.
  trial_start = split("-", var.trial_start_date)
}

# 1. Credit burn. EXCLUDE_ALL_CREDITS makes this measure GROSS spend against the $300 grant, and
#    custom_period makes it accumulate across the whole trial — together, the number that answers
#    "how much of the trial is left".
resource "google_billing_budget" "credit_burn" {
  billing_account = var.billing_account
  display_name    = "llm-code-execution — trial credit burn"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"

    # No end_date: an open-ended custom period accumulates from activation onward, so the budget
    # keeps answering the question until the project is deleted. Mutually exclusive with
    # calendar_period, which is the point.
    custom_period {
      start_date {
        year  = tonumber(local.trial_start[0])
        month = tonumber(local.trial_start[1])
        day   = tonumber(local.trial_start[2])
      }
    }
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "300"
    }
  }

  threshold_rules { threshold_percent = 0.25 }
  threshold_rules { threshold_percent = 0.50 }
  threshold_rules { threshold_percent = 0.90 }

  # Forecast, not actual: at a steady burn this warns weeks before the actual rule would, which is
  # the difference between changing a decision and reading an obituary.
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  depends_on = [google_project_service.phase1]
}

# 2. Real money. Credits INCLUDED, so this stays at zero for as long as the credits cover
#    everything and fires the moment they do not — the day-91 tripwire, and the alarm that fires
#    if a resource outlives a teardown that was believed complete.
#
#    This one KEEPS the default monthly period deliberately: "did I pay anything this month" is a
#    monthly question, and a monthly reset means it can fire again next month rather than staying
#    latched after the first dollar.
resource "google_billing_budget" "real_spend" {
  billing_account = var.billing_account
  display_name    = "llm-code-execution — actual charges"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "1"
    }
  }

  threshold_rules { threshold_percent = 1.0 }

  depends_on = [google_project_service.phase1]
}
```

- [ ] **Step 2: Verify and apply**

```bash
cd infra && ./verify.sh && terraform apply && cd ..
```

Expected: two budgets created. If this fails with a 403 from the Billing Budgets API, the cause is
almost certainly the ADC quota-project requirement — confirm `user_project_override` and
`billing_project` are still present in `infra/providers.tf` (Task 1, Step 3), and that the
authenticated principal holds `roles/billing.costsManager` on the billing account.

- [ ] **Step 3: Confirm in the console**

```bash
gcloud billing budgets list --billing-account=<ACCOUNT_ID> \
  --format="table(displayName, amount.specifiedAmount.units, budgetFilter.creditTypesTreatment, budgetFilter.customPeriod.startDate, budgetFilter.calendarPeriod)"
```

Expected: two rows. The credit-burn row shows `EXCLUDE_ALL_CREDITS`, `300`, the trial start date,
and an **empty** `calendarPeriod`. The actual-charges row shows `1` and `MONTH`. A `MONTH` on the
first row means `custom_period` did not take and the alarm is back to being silent for the whole
trial — the failure this task exists to avoid.

- [ ] **Step 4: Commit**

```bash
git switch -c feat/infra-budget-teardown origin/main
git add infra/budget.tf
git commit -m "feat(infra): budget alarms for credit burn and real spend"
```

### Task 15: The teardown runbook

**Files:**
- Create: `docs/runbooks/gcp-teardown.md`

- [ ] **Step 1: Write it.** It must be executable by someone with no memory of this plan:

1. **When** — day 91 of the trial, or any time the environment is not needed. The activation date
   is recorded in `docs/runbooks/gcp-bootstrap.md`.
2. **What this destroys** — everything, including every secret payload and the entire chat
   history database. Say it in bold at the top; there are no backups by design (spec Boundaries).
3. **The destroy** — `cd infra && terraform destroy`, then read the plan before confirming.
4. **The bucket Terraform does not own** —
   `gcloud storage rm --recursive --all-versions gs://<project>-tfstate`, with the explanation
   from P1-D2 and the note that this deletes the state itself, so it is genuinely last.
   `--all-versions` is required, not decorative: `bootstrap.sh` enables object versioning, and
   without it the noncurrent versions survive and the bucket delete fails.
5. **The belt-and-braces check** — `gcloud projects delete <project-id>`, which is the only way to
   be certain nothing is left billing. Note that it is reversible for 30 days.
   **This is also what disposes of the workload identity pool.** Pools soft-delete and reserve
   their ID for ~30 days, so a `terraform destroy` alone leaves one behind — free, but present,
   and it will block re-creating a pool with the same ID inside that window. Task 16's rebuild
   rehearsal deliberately spares the pool for the same reason; say so here so the next reader
   does not mistake it for something the destroy missed.
6. **Proving zero** — how to read the billing report a day later. Note explicitly that **no budget
   survives to alarm on it**: both `google_billing_budget` resources are destroyed by the teardown
   above, so the day-later billing check is the *only* backstop and skipping it means a missed
   resource bills silently. (Keeping a budget alive would contradict "zero billable resources"
   just as much — the fix is to read the report, not to leave an alarm behind.)
7. **Rebuilding** — a one-line pointer back to the bootstrap runbook.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/gcp-teardown.md
git commit -m "docs(runbooks): the day-91 teardown"
```

### Task 16: Prove S7 — destroy and rebuild

This is the task most likely to be claimed rather than performed. The spec says so in as many
words. Do it, and paste the real output into the PR body.

> **Why this rehearsal deliberately spares the WIF pool.** Workload identity pools are
> **soft-deleted**: the ID is reserved for ~30 days and cannot be reused. A full
> `terraform destroy` followed by `terraform apply` would therefore 409 on
> `google_iam_workload_identity_pool.github` and the rebuild would be red for a reason that has
> nothing to do with whether the configuration reproduces.
>
> This does not weaken S7, and the wording matters: S7 asks that *"`terraform apply` from an empty
> project reproduces the environment"* — and an empty project has no soft-deleted pool, so a
> genuine from-scratch rebuild is unaffected. What cannot be rehearsed is destroy-and-rebuild
> **into the same project within 30 days**. The real day-91 teardown is unaffected too: it ends in
> `gcloud projects delete`, which takes the pool with it.
>
> Rejected: adding a `random_id` suffix to the pool ID so a rebuild takes a fresh one. That would
> make `terraform output workload_identity_provider` change value on every rebuild — and Phase 3
> pins that string in a workflow file. Trading a real property for a rehearsal is the wrong way
> round.

- [ ] **Step 1: Record what exists**

```bash
cd infra
terraform state list | sort > /tmp/before.txt
cat /tmp/before.txt
```

- [ ] **Step 2: Destroy everything except the federation**

**Name every address explicitly, including the IAM members.** Do not rely on `-target` sweeping up
dependents: `-target` is documented to pull in the resources a target *depends on*, and whether it
also pulls in resources that depend on it is exactly the kind of subtlety that differs between
versions and is miserable to debug against a live project. Enumerating costs one line each and is
correct under either reading. An IAM member left behind here is worse than a leftover resource: its
state entry survives while its parent is gone, and the next `apply` fails on a stale reference.

Only the pool and provider are spared, for the soft-delete reason above.

```bash
# Plan FIRST and read it. A targeted destroy is the one operation here that can silently do less
# than you meant; `terraform state list` after the fact tells you what survived, which is too late.
terraform plan -destroy \
  -target=google_artifact_registry_repository_iam_member.ci_writer \
  -target=google_service_account_iam_member.ci_act_as_runtime \
  -target=google_secret_manager_secret_iam_member.runtime_accessor \
  -target=google_artifact_registry_repository.app \
  -target=google_service_account.runtime \
  -target=google_secret_manager_secret.app \
  -target=google_billing_budget.credit_burn \
  -target=google_billing_budget.real_spend
```

Confirm the plan destroys exactly those addresses and nothing federation-related, then re-run the
same command as `terraform destroy` (same `-target` flags, `-auto-approve` omitted so you approve
it by hand).

Expected: those resources destroyed, no errors. The APIs stay enabled by design
(`disable_on_destroy = false`, Task 3), and the pool, provider and `ci_run_admin` binding are
untouched.

If an address in the list does not exist in this configuration under that exact name, fix the list
rather than dropping the flag — a `-target` for a nonexistent address is a no-op warning, not an
error, so a typo here fails silently.

- [ ] **Step 3: Confirm nothing billable survived**

```bash
gcloud artifacts repositories list --project=<project-id>
gcloud secrets list --project=<project-id>
gcloud iam service-accounts list --project=<project-id>
gcloud billing budgets list --billing-account=<ACCOUNT_ID>
gcloud iam workload-identity-pools list --location=global --project=<project-id>
```

Expected: the first four are empty or list only Google-managed defaults. The **fifth still lists
`github`** — that is the point of Step 2's scoping, not a leak; a pool is free. The state bucket
also still exists, per P1-D2, and the teardown runbook removes it separately.

- [ ] **Step 4: Rebuild**

```bash
terraform apply
terraform state list | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Expected: `diff` prints **nothing**. A non-empty diff means the configuration is not
self-reproducing and S7 is not met — investigate before proceeding rather than explaining it away.

- [ ] **Step 5: Re-populate the secrets** — the destroy removed the payloads with their
  containers. Re-run the population step from `docs/runbooks/gcp-bootstrap.md` for the four
  Phase 1 populates (`database-url` and `redis-url` stay empty until Phase 2) and confirm:

```bash
gcloud secrets versions list anthropic-api-key --project=<project-id>
```

Expected: one enabled version. This is also the first real test of that runbook section.

### Task 17: Documentation and the PR

- [ ] **Step 1: Write `infra/README.md`** — the orientation page for anyone opening this
  directory cold. Four short sections, no more:
  *what this root manages* (a list, one line each, pointing at the `.tf` file); *how to run it*
  (a pointer to `docs/runbooks/gcp-bootstrap.md`, not a second copy of it); *what is deliberately
  outside it* (the state bucket and why — P1-D2 — and the secret payloads and why — P1-D3); and
  *what the gate does and does not check* (no `plan`, no credentials, the three invariants).

- [ ] **Step 2: Update `README.md`** — the Roadmap entry for the GCP deploy gains a Phase 1
  status line, and the Layout block gains `infra/` if Task 5 did not already add it. **Do not**
  claim the app is deployed; nothing is running.

- [ ] **Step 3: Update epic #79** — check off the Phase 1 children and add a Phase 1 summary
  paragraph in the same shape as the Phase 0 one, stating explicitly that nothing is deployed and
  that Phase 2 is next.

- [ ] **Step 4: Verify everything**

```bash
cd infra && ./verify.sh && cd ..
./scripts/tests/check-sdlc-sync.test.sh
cd backend && SKIP_DOCKER=1 ./verify.sh && cd ..
```

Expected: all green. The backend run is a regression check only — nothing in Phase 1 touches it,
and a failure means something unrelated drifted.

- [ ] **Step 5: Commit and open the PR**

```bash
git add README.md infra/README.md
git commit -m "docs: record the phase 1 foundation in the roadmap"
git push -u origin feat/infra-budget-teardown
gh pr create --title "feat(infra): budget alarms and the day-91 teardown" \
             --body "Closes #135. Includes the destroy/rebuild proof for S7 — output below. …"
```

---

## Definition of done for Phase 1

Beyond `.claude/skills/references/definition-of-done.md`, this phase is done when:

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S6 (no secret in state) | Structural: only containers in Terraform, payloads via `gcloud`, and a tested gate that fails the build if a version resource is ever added. Verified by `terraform state pull \| grep`. |
| S7 (apply/destroy reproduce) | **Half proven here, half deferred.** Task 16 destroys and rebuilds all non-federation resources, diffing `terraform state list` — that is the *reproduce* half. The *zero billable resources* half is NOT proven by that rehearsal: it spares the WIF pool (soft-delete) and the state bucket (P1-D2). Both are removed only by the Task 15 teardown, which ends in `gcloud projects delete`; S7 closes when that runbook is executed on day 91, not here. |
| S8 (budget alarm, teardown runbook) | Task 14's two budgets and Task 15's runbook. |
| S9 (no long-lived key) | No deployer service account exists to hold one (P1-D4). |
| S11 (verify.sh / CI parity) | `infra/verify.sh` and `.github/workflows/terraform.yml` run the same targets; `docs/sdlc.md` updated in PR 1 with the watched-path change enforcing it. |

**Not claimed by this phase:** S1–S5, S10, S12. Nothing is deployed, so nothing is reachable and
no isolation check can be re-run. Phase 2 owns those.

**Deliberately deferred to Phase 2:** the Cloud Run instance size. The spec parked it as
configuration that follows from D7 and the concurrency cap, and there is no Cloud Run resource in
this phase to attach it to — sizing a service that does not exist would be a guess written in
Terraform. Phase 2's plan chooses it and verifies it against real sandbox executions.

## Review gate

Per `CLAUDE.md`, both `code-review` and `security-review` run against every PR above before it is
handed over. The security review matters more than usual here: PR 5 defines who may deploy, and a
weak attribute condition is the single highest-consequence defect available in this phase.

## Plan review log

Staff-engineer review 2026-08-10 — **applied without asking** (mechanical; each verified against
the codebase before transcribing):

- **Prerequisites**: split into "before PR 1" (Terraform only) and "before PR 2" (everything GCP).
  The old text claimed PR 1 was "entirely offline" while Task 3 runs `terraform init` and
  `providers lock`.
- **Prerequisites step 5**: added `gcloud config set project <project-id>`. Task 12 Step 4 calls
  `gcloud secrets versions add` with no `--project` while Task 16 Step 5 passes one — inconsistent,
  and the former errors on a fresh machine.
- **Prerequisites step 7 + `infra/providers.tf` comment**: added an explicit
  `gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com`, and
  corrected the comment that claimed Cloud Resource Manager is enabled by default. `data
  "google_project" "this"` is read at plan time, before `apis.tf` can enable anything, and
  `user_project_override` bills that read to the new project.
- **Task 12 Step 1**: added the sixth secret, `oidc-jwks-url`. `config.ts:106` reads
  `OIDC_JWKS_URL` with an empty default and `auth.ts:74` passes it straight to `jwksFor()` — it is
  derived from nothing, so five containers would have left Phase 2 verifying zero tokens. Expected
  counts in Steps 3 and 5 updated from five to six.
- **Task 5 Step 1**: `watched()` / `unwatched()` now use a herestring instead of
  `printf … | grep -q`. Under this suite's `pipefail`, `grep -q` exits early, the writer takes
  SIGPIPE and returns 141, and `unwatched()` would pass vacuously —
  `check-sdlc-sync.sh:78-81` already documents and fixes the identical trap.
- **Task 5 Step 5**: added a fourth `docs/sdlc.md` location (`:5-9`, the opening contract
  statement). The watched-path list is stated in four documents and all four drift together.
- **Task 5 Step 6**: added `README.md:271` ("Both accept `SKIP_INSTALL=1`…") and `README.md:275`
  (the `SDLC docs` watched-path list) to the edits.
- **Task 5 Step 7**: added `CLAUDE.md:16`, `:45`, and `:102`. The last matters most — Task 6 adds
  `Terraform checks` to the live ruleset, and `CLAUDE.md:102` enumerates the required checks, so
  leaving it stale breaks the repo's own "CI job names are a contract" section.
- **Task 6**: back up the ruleset before the blind `PUT`, and move the `rm` after the confirmation
  step. Added the restore command.

Also verified while applying, and left alone because the review confirmed them correct: the
provider and Terraform version pins, `deletion_protection` on `google_secret_manager_secret`,
the `repository`/`service_account_id` attribute choices, the numeric GitHub IDs, the ruleset ID
and the jq projection, and the WIF attribute condition (attacked from six angles — owner rename,
repo rename, a tag named `main`, topic branches, fork PRs, default audience — and it fails closed
on all of them).

**Escalated to the user, and decided 2026-08-10.** Four judgment findings; all four resolved as
recommended, and folded in:

- **WIF soft-delete vs. the S7 proof** → Task 16 now destroys by `-target`, sparing the pool and
  provider, and states why in the task and in the teardown runbook. Rejected: a `random_id` suffix
  on the pool ID, which would change `terraform output workload_identity_provider` on every
  rebuild — a string Phase 3 pins in a workflow. S7 itself is unaffected: it asks for a rebuild
  from an *empty project*, which has no soft-deleted pool. Step 3 gained the
  `gcloud iam workload-identity-pools list` check.
- **The credit-burn budget would never fire** → `budget_filter.custom_period` pinned to a new
  `var.trial_start_date`, replacing the API's `calendar_period = MONTH` default. The second budget
  keeps the monthly period deliberately, so it can re-fire rather than latch. Task 14 Step 3 now
  asserts an empty `calendarPeriod` on the first budget, because a silent revert to `MONTH` is the
  whole failure mode.
- **The registry cleanup policy never deleted a tagged image** → added a `delete-old-tagged`
  DELETE policy at 30d, which is what makes the KEEP-5 policy do any work.
- **Secret population scope** → all six containers in Terraform; Phase 1 populates the four whose
  values exist, and §7 of the bootstrap runbook must name `database-url` and `redis-url` as
  Phase 2's. Upstash is explicitly not pulled into Phase 1.

Advisory items also applied, being corrections to this plan's own text: `apis.tf` comments moved
above the list (trailing-comment alignment would have reddened the first `fmt -check`),
`registry_url` now reads the provider's exported `registry_uri`, and the teardown's
`gcloud storage rm` gained `--all-versions` for the versioned bucket.

**Advisory not applied:** an ADR recording P1-D2 (state bucket outside Terraform) and P1-D4 (no
deployer service account — the mechanism behind S9). Both are durable and would be expensive to
reverse, so the repo's own rule says they deserve one. Phase 0's precedent is that an ADR is its
own child issue and its own PR (ADR-0004 was #88), so adding it here would make Phase 1 seven PRs
rather than six. Left as a proposal rather than folded in silently.
