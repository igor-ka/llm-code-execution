# Phase 3: Continuous Deployment Implementation Plan

**Goal:** A push to `main` builds the image, deploys a Cloud Run revision that receives **no
traffic**, proves that revision is correct against the deployed service, and only then promotes it
— authenticated by Workload Identity Federation, with no service-account key anywhere.

**Architecture:** Two scripts and one workflow. `scripts/deploy-cloud-run.sh` holds the deploy
command that [ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md) makes the service's
specification, so the human and CI run the identical thing — the same contract `verify.sh` already
has. `scripts/verify-deployment.sh` reads the deployed service back and asserts its shape, its HTTP
surface and its logs. `.github/workflows/deploy.yml` authenticates via the Phase 1 WIF pool and
calls those targets in order. CD deploys the **application** only; it never runs `terraform apply`
and never reads Terraform state.

**Tech Stack:** GitHub Actions, `google-github-actions/auth` in direct-WIF mode (no impersonated
service account — P1-D4), `gcloud beta run deploy`, Cloud Build, Terraform (`infra/wif.tf`),
Bash + `python3` for the assertions, the existing fake-`gcloud`-on-`PATH` test harness.

**PR boundaries:** six PRs, one child issue each. Child issues are filed once this plan is
approved (`docs/sdlc.md`: children come after the plan), in this order:

| PR | Deliverable | Depends on |
| --- | --- | --- |
| 1 | `scripts/deploy-cloud-run.sh` — the deploy as one script, human and CI alike | — |
| 2 | `scripts/verify-deployment.sh` — the post-deploy assertion battery | — |
| 3 | `roles/logging.viewer` for CI, and federation that survives a session-end teardown | — |
| 4 | Dependabot auto-merges under a GitHub App, so they fire workflows like any other merge | — |
| 5 | `.github/workflows/deploy.yml` — the pipeline | PRs 1–3 |
| 6 | Exercise it end to end, ADR-0006, README and epic close-out | PRs 4–5 |

PRs 1–4 are independent of each other and can be worked in any order or in parallel worktrees.
PR 5 needs 1–3: it calls both scripts and reads logs with the grant PR 3 adds. PR 6 needs a live
environment and a real push to `main`, and needs PR 4 for the claim that *every* merge deploys.

PR 4 is not obviously CD work, and it is here on purpose. `docs/sdlc.md:673` already records that
an auto-merged Dependabot commit produces **no push-side run on `main` at all**, and warns that
"anything built later that keys off *CI ran on main* must not assume otherwise". Phase 3 is that
later thing. Fixing the merge identity is what makes Dependabot non-exceptional rather than
bounded-exceptional — see P3-D11.

The child issues **exist**: #197, #198, #199, #200, #201 and #202, in the order above. They were
filed after the plan review, per `docs/sdlc.md` — the review is what can still change the split, and
it did: finding 1 added PR 4, which did not exist when this plan was first written.


---

## Why there is no separate Phase 3 spec

`docs/sdlc.md` says a spec earns its existence by surfacing open questions. Phase 3 has several —
they are **P3-D1 … P3-D10** below. They are recorded here rather than in a second spec document
because [the epic's spec](../specs/2026-08-09-deploy-to-gcp.md) already covers this problem and
Phase 2 set the precedent: its six open questions were raised by the plan, escalated by the staff
review, decided by the human, and folded back into that spec as **D11–D16**. A second spec for the
same epic would be a second place for decisions to live. The ones below follow the same route and
become **D18+** in the parent spec once decided.

## What this plan inherits

Verified against `main` @ `a28a09e` and against the live project on 2026-08-17.

- **The WIF pool and provider exist and nothing uses them** (`infra/wif.tf`). The attribute
  condition pins `repository_owner_id`, `repository_id`, `ref == refs/heads/main` and
  `ref_type == branch`. There is **no deployer service account and no key** (P1-D4).
- **The federated principal already holds three grants**: `artifactregistry.writer` on the one
  repository, `roles/run.admin` project-scoped (and `wif.tf` explains why it cannot be narrowed —
  creating a service is a project-level permission and the service does not survive teardown), and
  `iam.serviceAccountUser` on `app-runtime` only.
- **The service is not in Terraform and must not be** — ADR-0005. The provider does not model
  `sandboxLauncher` and strips it on every apply.
- **Builds run as `app-build`** with its own staging bucket (`infra/build.tf`), never the Compute
  Engine default account, which holds project Editor. `_TAG` is a required substitution with no
  default.
- **The environment is destroyed between working sessions** (spec D17). It happens to be **live
  right now** — service `app` at `https://app-530312723651.us-central1.run.app`, revision
  `app-00005-dpz` serving 100%, Cloud SQL `app-db` RUNNABLE, Valkey up, all six secrets present.
- **`#195` is open and undecided** (cold-start quota bypass). Nothing in this plan fixes it or
  assumes it fixed; P3-D6 states plainly that CD cannot detect its class of failure.
- **Terraform 1.15.8 has no `-exclude` flag** — checked, not assumed:
  `terraform plan -exclude=foo.bar` fails with *"flag provided but not defined: -exclude"*. This
  is why P3-D7 uses `-target` on the billable set instead.

---

## Decisions this plan makes

**P3-D1 — CD deploys the application. It never runs `terraform apply`.** Infrastructure stays a
human step in [`gcp-bootstrap.md`](../runbooks/gcp-bootstrap.md), exactly as `infra/verify.sh`
already says (*"a plan needs credentials against a live project … planning is a human step"*).
Two reasons, and the second is the load-bearing one. ADR-0005 already puts the service outside
Terraform, so there is nothing about the service for an apply to do. And applying the *rest* of
`infra/` from CI would need Cloud SQL, Compute, Memorystore, Secret Manager and IAM admin plus
read-write on the state bucket — the same grant `infra/build.tf` explicitly refuses the build
identity, because state holds the generated Cloud SQL password in cleartext. CD's blast radius
stays "can deploy a revision of one service, running as one account".

**P3-D2 — Nothing in CD reads Terraform state.** Follows from P3-D1, and it is a constraint on the
deploy script rather than a preference: the human runbook resolves `--service-account`,
`--gcs-source-staging-dir` and `--add-cloudsql-instances` with `terraform output`, and CD cannot.
Every one of those values is deterministic from the names Terraform itself uses, so the script
derives them:

| Value | Derived as | Declared in |
| --- | --- | --- |
| Build identity | `app-build@$PROJECT_ID.iam.gserviceaccount.com` | `infra/build.tf` `account_id = "app-build"` |
| Staging bucket | `gs://$PROJECT_ID-build-source` | `infra/build.tf` `name = "${var.project_id}-build-source"` |
| Runtime identity | `app-runtime@$PROJECT_ID.iam.gserviceaccount.com` | `infra/identity.tf` |
| Cloud SQL instance | `$PROJECT_ID:$REGION:app-db` | `infra/sql.tf` `name = "app-db"` |
| Registry | `$REGION-docker.pkg.dev/$PROJECT_ID/app` | `infra/registry.tf` |

A rename in Terraform therefore breaks the deploy loudly at the next run rather than silently, and
that is the right failure: these five names are part of the service's specification too.

**P3-D3 — One deploy script, run by the human and by CI.** `scripts/deploy-cloud-run.sh`. ADR-0005
obligation 1 says *"the deploy command is the specification"* and puts it in the runbook; a CD
pipeline that re-types that command in YAML creates a second copy, and the copy is the one that
goes stale. This is the contract `verify.sh` already has in this repo — *CI runs the same script,
so local and CI cannot drift* — applied to the one command ADR-0005 made load-bearing. The runbook
keeps the annotations (why each flag exists, what breaks without it) and points at the script for
the command itself.

**P3-D4 — CI builds the image in the runner with `docker build`; Cloud Build stays as the by-hand
path.** Decided 2026-08-17, reversing this plan's first draft.

`ubuntu-latest` is amd64, so the emulation problem that put builds on Cloud Build in the first
place — a `linux/amd64` build on Apple Silicon takes over ten minutes and was OOM-killed twice —
simply does not exist in a runner. The federated principal already holds
`artifactregistry.writer`, so the runner path needs **no new IAM at all**, and it removes the
source upload to GCS and the Cloud Build queue from the critical path.

*The security argument for Cloud Build does not survive inspection, and the first draft of this
plan repeated it anyway.* It ran: on Cloud Build the image is produced by `app-build`, which
`infra/build.tf` explicitly denies `run.admin` and `actAs` on the runtime account, so the builder
cannot deploy. True — and it constrains nothing here, because the federated principal holds
`artifactregistry.writer` **directly** and can already push an arbitrary image and then deploy it.
`build.tf`'s separation is real, but what it protects against is a malicious `cloudbuild.yaml`
running as project Editor, and that threat does not change based on who invokes the build.

*The one real cost, and how it is paid:* `cloudbuild.yaml` is currently the single build
definition, and a runner build is a second invocation of the same Dockerfile with the same three
build args. Both live in `scripts/deploy-cloud-run.sh` as two targets — `build` (docker, what CI
runs) and `build:remote` (`gcloud builds submit`, what a human on Apple Silicon runs). Same
Dockerfile, same build args, same `linux/amd64` platform; two transports, one file, one test
harness. `cloudbuild.yaml` is untouched and stays the definition `build:remote` submits.

*What this decision deletes:* the custom `cloudbuild.builds.*` role, `actAs` on `app-build`,
`storage.objectUser` on the staging bucket for CI — and with them the open question of whether
`roles/storage.objectUser` even carries `storage.buckets.get` (it does not; the role has no
`storage.buckets.*` permission at all), which was a grant nothing could exercise until PR 5 had
already merged to `main`.

**P3-D5 — The image tag is the commit SHA.** `_TAG=$GITHUB_SHA` (full, not shortened — a
short SHA is one collision away from overwriting a tag a working revision points at, which is the
exact hazard the runbook's *"bump it rather than overwriting"* note describes). The human path
still accepts an explicit `TAG=`.

**P3-D6 — Deploy with no traffic, verify the candidate, then promote — and CD verifies only what
it can verify without credentials.** Two halves.

*The first half is the safety model.* Five defects have reached this service and every one passed a
fully green `verify.sh`. A revision is therefore not trusted because it deployed; it is trusted
because `verify-deployment.sh` passed against it while nobody was being served by it. A failed
verification promotes nothing, and the previous revision keeps serving — a strictly better failure
mode than deploy-then-roll-back, and it never touches the pinning trap the rollback drill found
(`--to-latest`, never `--to-revisions`).

**And the invariant has no exceptions, which costs CD the create path.** Cloud Run gives a brand-new
service's first revision 100% of traffic; `--no-traffic` is meaningless when there is no other
revision to serve. So the first deploy after every rebuild is live-before-verified *by
construction* — and that is not a rare path, because teardown step 1 deletes the service at the end
of every session and `terraform apply` does not bring it back (ADR-0005).

Rather than carry an exception, **CD refuses to create the service**: `preflight` requires it to
exist and exits 3 if it does not. Creating it stays the one command a human runs after a rebuild,
which is what the spec's D4/S9 asks for anyway — *never automate a deploy that has not been done by
hand*. The script exposes that as its own target, `create`, so the intent is named rather than
inferred from a flag, and CI simply never calls it. Rejected: letting CD create and then delete the
service on a failed verification, which destroys the revision and logs you would want for debugging
and leaves a broken service publicly reachable until the delete lands.

*Accepted cost:* `workflow_dispatch` is no longer a one-button rebuild. After a teardown the
sequence is `./scripts/deploy-cloud-run.sh create` once, by hand, and CD takes over from the next
push.

*The second half is what CD does not do.* The credential-free assertions are: the served revision's
**shape** read back from the API (`sandboxLauncher: true`, gen2, the VPC interfaces, the Cloud SQL
instance, the runtime service account, concurrency 8, cpu/memory, all five env vars with
`FRONTEND_ORIGIN` equal to the service URL, all six secrets bound), `/api/health`, the production
CSP header, and an unauthenticated `POST /api/execute` returning **401**. Those catch a dropped
`--sandbox-launcher`, a dropped `--network`, and #188's localhost origin.

They do **not** catch #191 or #195. Both live on the quota path, the quota keys on the verified
`sub`, and auth runs first — so no credential-free request reaches the quota at all. Detecting them
needs an Auth0 machine-to-machine credential held permanently in GitHub, for an endpoint that
spends money, and [`gcp-isolation-probes.md`](../runbooks/gcp-isolation-probes.md) explicitly says
to **delete those applications when the probes are done**. So CD does not hold one, the probes
runbook stays the authority for the quota and the isolation battery, and the workflow's own summary
says so rather than implying coverage it does not have.

**P3-D7 — The session-end teardown must stop destroying the WIF pool, or CD dies for a month.**
`terraform destroy` destroys `google_iam_workload_identity_pool.github`, and
[`gcp-teardown.md`](../runbooks/gcp-teardown.md) §4 already records the consequence: pools
soft-delete, the ID is reserved for ~30 days, and a rebuild *cannot re-create a pool with the same
ID inside that window* — which is why the Phase 1 S7 rehearsal deliberately spared it. Before Phase
3 that was a curiosity. After it, the first ordinary session-end teardown leaves CD unable to
authenticate until mid-September.

The fix is to make the **between-sessions** teardown a targeted destroy of the billable set rather
than a full destroy. `-exclude` would be the natural expression and Terraform 1.15.8 does not have
it (checked above), so it is `-target`:

```
google_sql_database_instance.main
google_memorystore_instance.quota
google_network_connectivity_service_connection_policy.valkey
google_compute_subnetwork.main
google_compute_network.main
```

Everything else in the root is free or near-free — service accounts, budgets, secret *containers*,
the WIF pool, the registry (a few images, cents/month), the staging bucket (7-day lifecycle). The
full day-91 teardown is unchanged and still ends in `gcloud projects delete`. **A side effect worth
having:** the four static secret payloads survive too, so a rebuild repopulates only `database-url`
and `redis-url` — the two the teardown runbook already flags as changing on every rebuild.

**P3-D8 — Trigger on `push` to `main` and on `workflow_dispatch`; it is not a required check; and
"no environment" is a green no-op, while "no credential" is not.**

Not `workflow_run` on `CI`: a `workflow_run` trigger fires only when the referenced workflow
actually runs, and CI does not run on `main` for a merge performed with `GITHUB_TOKEN`. **Note
carefully that `push` has the same blind spot** — the mechanism `docs/sdlc.md:667` records is that
*no* workflow starts for such a push, not that CI specifically is skipped. The first draft of this
plan cited the missing CI run at `8211ee8` as a reason to prefer `push`, which had the reasoning
backwards. `push` is chosen because it is the direct expression of "deploy what is on `main`", and
the blind spot is closed at its source by P3-D11 rather than worked around here.

Not a required status check: it never runs on `pull_request`, so requiring it would block every
merge on a check that can never report — the same trap `docs/sdlc.md` records for workflow-level
`paths:` filters, reached by a different road.

The environment is torn down most of the time (D17), so the pipeline preflights for it and exits
**3** — a distinct code the workflow reads — reporting *"the environment is torn down; nothing to
deploy"* and finishing **green**. A red X on every push during a torn-down week trains a reader to
ignore the one that matters.

**But the preflight probes in two stages, and only the second one is allowed to be green.** A
single `gcloud artifacts repositories describe` treats every non-zero exit as "torn down",
including `PERMISSION_DENIED`, an expired federated token, a disabled API and a network failure —
which would report *"the environment is torn down"* and finish green for a **wrong grant or a wrong
`workload_identity_provider` variable**, the exact failure PR 6 Step 1 exists to observe. That is
the decorative-assertion pattern applied to the one step that decides whether anything else runs.
So: `gcloud projects describe` proves the credential works and **fails** the job if it does not;
only then does the registry probe decide whether there is an environment. Rejected: pattern-matching
`NOT_FOUND` out of gcloud's stderr, which is not a stable interface.

**P3-D9 — Migrations run at boot, so a candidate migrates before it is verified.** `index.ts:62`
calls `migrate()` in the composition root, so a `--no-traffic` candidate takes the advisory lock
and applies its migrations while the old revision is still serving. That is safe only for
forward-compatible migrations. It is an accepted constraint recorded in the runbook, not a
mechanism this plan builds: every migration this repository has is additive, and a
backward-incompatible one would already have been a problem for Cloud Run's rolling deploys.

**P3-D11 — Dependabot's auto-merge moves to a GitHub App, so its merges are not an exception.**
Decided 2026-08-17.

GitHub does not start a workflow run for a push made with `GITHUB_TOKEN`, and
`dependabot-auto-merge.yml` arms native auto-merge with exactly that token — so today an
auto-merged bump lands on `main` with **no push-side CI run and, once Phase 3 ships, no deploy**.
The first half of that is not new and is not a Phase 3 defect: `docs/sdlc.md:667–675` documents it,
points at `8211ee8` as the proof, and closes with the sentence this phase collides with —
*"anything built later that keys off 'CI ran on main' must not assume otherwise."*

The root cause is the merge identity, not the trigger, so that is what changes. A minimal GitHub
App installed on this repository, holding `contents: write` and `pull_requests: write`, mints an
**installation token that expires in an hour**; the `apply` job uses it instead of `GITHUB_TOKEN`.
Both gaps close at once — CI runs on `main` and `Deploy` runs with the full verify-then-promote —
and Dependabot stops being special in any respect.

*Rejected: a fine-grained PAT.* It is less setup and it works, but it is a long-lived
write-scoped credential living in the repository — the precise thing Phase 1 went out of its way to
avoid on the GCP side by having no service account for CI to hold a key for (P1-D4). Using one here
to fix a *workflow-triggering* problem would trade a documented gap for an undocumented standing
credential.

*Rejected: a daily `schedule:` sweep on `Deploy`.* It reaches the same end state within a day
without touching `dependabot-auto-merge.yml`, and it was the cheaper answer while the merge identity
was assumed fixed. It leaves Dependabot an exception — just a bounded one — and it deploys `main`
unattended at a moment nobody chose.

*Scope, stated plainly:* this edits a workflow with a deliberate security design — two jobs, split
scopes, the one third-party action SHA-pinned and confined to the read-only job, and the only
writable token in this repository's CI. It gets its own child issue and its own PR rather than
riding along with the pipeline, and the `gate` job keeps `GITHUB_TOKEN` — only `apply` changes.

**P3-D10 — The scripts' unit tests are hosted by the `SDLC docs` job.** `deploy.yml` runs only on
push to `main`, so a PR that edits `scripts/deploy-cloud-run.sh` never executes it and the tests
would have no host — precisely the situation `docs/sdlc.md` already documents for
`dependabot-auto-merge-disarm.test.sh`, which `SDLC docs` runs for the same reason. Same file
locally and in CI, so the two cannot drift.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `scripts/deploy-cloud-run.sh` | The deploy: preflight, build, no-traffic deploy, verify, promote. Exit 3 = no environment. |
| `scripts/tests/deploy-cloud-run.test.sh` | Drives the above against a fake `gcloud` on `PATH`; asserts on the recorded call log. |
| `scripts/verify-deployment.sh` | Post-deploy assertions: service shape, HTTP surface, application logs. |
| `scripts/tests/verify-deployment.test.sh` | Same harness, plus a fake `curl`; proves each assertion goes RED. |
| `.github/workflows/deploy.yml` | The pipeline. WIF auth, the five targets in order, a job summary. |
| `docs/adr/0006-continuous-deployment-scope.md` | What CD does, what it deliberately does not, and the reversal conditions. |

**Modified**

| File | Change |
| --- | --- |
| `infra/wif.tf` | One new grant: `roles/logging.viewer`, for the post-deploy log check. |
| `.github/workflows/dependabot-auto-merge.yml` | The `apply` job merges under a GitHub App token, not `GITHUB_TOKEN` (P3-D11). |
| `docs/runbooks/gcp-deploy.md` | §1–§2 and §4 point at the scripts; the annotations stay; a CD section is added. |
| `docs/runbooks/gcp-teardown.md` | The between-sessions teardown becomes a targeted destroy (P3-D7), and the rebuild names `create`. |
| `docs/sdlc.md` | A "Continuous deployment" section — required, `.github/workflows/**` and `scripts/**` are watched paths. |
| `README.md` | Verification and Roadmap: CD exists, and what it does not verify. |

---

## PR 1 — the deploy, as one script

> **The script below is the plan's draft, not the merged implementation.** Review of #197 found
> twelve real defects in it and the merged version differs materially — existence probing uses
> `gcloud … list --filter` rather than `describe` (which fails identically for "missing" and
> "denied"), `promote` refuses an absent candidate and pins the verified revision before moving
> traffic, `verify` takes an explicit candidate/live mode with no silent fallback, the default
> target is `help`, and the verifier is checked before anything deploys. The reasoning for each is
> in #197's commits. Read the merged `scripts/deploy-cloud-run.sh` as the current article; this
> section records what was planned and why.


Closes the first child issue. **Nothing in this PR runs in CI**; it makes the by-hand deploy
reproducible so that PR 5 has one thing to call.

### Task 1: The script, test-first

**Files:**
- Create: `scripts/deploy-cloud-run.sh`, `scripts/tests/deploy-cloud-run.test.sh`
- Modify: `docs/runbooks/gcp-deploy.md`, `docs/sdlc.md`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/deploy-cloud-run.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for scripts/deploy-cloud-run.sh, driven by a fake `gcloud` on PATH.
#
# Same harness as infra/tests/bootstrap.test.sh and for the same reason: running the real script
# against the real project proves it worked that day, not that the next edit is safe. The fake
# records every invocation and the assertions read that log. No network, no project, no
# credentials.
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
# $2 service_state  — "absent", "serving" (a candidate tag exists), or "fresh" (no candidate)
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
  local describe_json
  if [[ "$service_state" == absent ]]; then
    describe_json=""
  else
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
  # verify-deployment.sh is PR 2's deliverable and is not under test here.
  cat >"$work/bin/verify-deployment-stub.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$work/bin/verify-deployment-stub.sh"
}

run_deploy() {
  PATH="$work/bin:$PATH" \
    PROJECT_ID=test-project REGION=us-central1 SERVICE=app TAG=abc123 \
    VITE_AUTH0_DOMAIN=t.auth0.com VITE_AUTH0_CLIENT_ID=cid \
    VITE_AUTH0_AUDIENCE=https://api.test/ \
    VERIFY_SCRIPT="$work/bin/verify-deployment-stub.sh" \
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

# The service is the third stage: CD does not create it (P3-D6).
make_fake_gcloud 0 absent
run_deploy preflight && rc=0 || rc=$?
if [[ "${rc:-0}" -eq 3 ]]; then
  ok "preflight exits 3 when the service does not exist"
else
  bad "preflight exits 3 when the service does not exist" "got $rc: $(cat "$work/out.txt")"
fi

make_fake_gcloud 0 serving
if run_deploy preflight; then ok "preflight exits 0 when credential, registry and service exist"; else
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
  if logged "$arg"; then ok "build passes $arg"; else
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
if logged "_TAG=abc123"; then ok "build:remote passes the required _TAG substitution"; else
  bad "build:remote passes _TAG" "$(cat "$work/calls.log")"
fi

# --- build refuses to produce a bundle that cannot log in -------------------------------------
make_fake_gcloud 0 serving
if PATH="$work/bin:$PATH" PROJECT_ID=test-project TAG=abc123 \
     VITE_AUTH0_DOMAIN= VITE_AUTH0_CLIENT_ID=cid VITE_AUTH0_AUDIENCE=https://api.test/ \
     "$DEPLOY" build >"$work/out.txt" 2>&1; then
  bad "build refuses an empty VITE_AUTH0_DOMAIN" "$(cat "$work/out.txt")"
else
  ok "build refuses an empty VITE_AUTH0_DOMAIN"
fi

# --- deploy onto an existing service: a candidate that serves nobody ---------------------------
make_fake_gcloud 0 serving
run_deploy deploy || true
if logged "--no-traffic"; then ok "deploy onto an existing service takes no traffic"; else
  bad "deploy onto an existing service takes no traffic" "$(cat "$work/calls.log")"
fi
for flag in "--sandbox-launcher" "--execution-environment gen2" "--network app-net" \
  "--subnet app-subnet" "--vpc-egress private-ranges-only" "--concurrency 8" \
  "app-runtime@test-project.iam.gserviceaccount.com" \
  "test-project:us-central1:app-db"; do
  if logged "$flag"; then ok "deploy passes $flag"; else
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

# --- deploy REFUSES to create the service (P3-D6) ----------------------------------------------
# The invariant is that no user ever reaches an unverified revision. Cloud Run gives a new
# service's first revision 100% of traffic, so the only way to keep that absolute is for CD not to
# create services at all.
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
if run_deploy promote; then ok "promote succeeds when the latest revision holds 100%"; else
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
  bad "promote fails when update-traffic exits 0 but the split did not move"
else
  ok "promote fails when update-traffic exits 0 but the split did not move"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chmod +x scripts/tests/deploy-cloud-run.test.sh
./scripts/tests/deploy-cloud-run.test.sh
```

Expected: FAIL — `scripts/deploy-cloud-run.sh: No such file or directory`.

- [ ] **Step 3: Write the script**

Create `scripts/deploy-cloud-run.sh`:

```bash
#!/usr/bin/env bash
# The Cloud Run deploy, as ONE script the human and CI both run.
#
# ADR-0005 makes this command the SPECIFICATION for the service's shape, because the Terraform
# provider does not model `sandboxLauncher` and strips it on every apply. A specification that
# exists only as prose in a runbook drifts the moment CI grows its own copy of the command — so
# the command lives here, docs/runbooks/gcp-deploy.md keeps the annotations that say why each flag
# is there and what breaks without it, and .github/workflows/deploy.yml calls these targets. Same
# contract verify.sh already has in this repo: CI runs the same script, so the two cannot drift.
#
# NOTHING HERE READS TERRAFORM STATE, deliberately. State holds the generated Cloud SQL password
# in cleartext — infra/build.tf refuses the build identity project-level storage access for
# exactly that reason — so giving CI the state bucket would hand every future pipeline the
# database password. Every value below is a constant or is derived from the resource names
# Terraform itself uses (plan P3-D2). A rename in infra/ therefore breaks this loudly on the next
# run instead of silently.
#
# Usage: ./scripts/deploy-cloud-run.sh [target]
#   all           (default) preflight + build + deploy + verify + promote
#   preflight     does the credential work, and is there a service to deploy a revision of?
#   build         docker build + push, linux/amd64. What CI runs.
#   build:remote  the same Dockerfile via Cloud Build. What a human on Apple Silicon runs.
#   deploy        gcloud beta run deploy — always a NO-TRAFFIC candidate. Refuses to create.
#   create        the FIRST deploy after a rebuild. By hand only; CI never calls this.
#   verify        scripts/verify-deployment.sh against whichever URL the deploy produced
#   promote       100% of traffic to the latest ready revision, then CHECK THE SPLIT
#
# Exit contract — the workflow branches on it, so it is interface, not implementation detail:
#   0  the target succeeded
#   3  nothing to deploy: the Terraform layer is torn down, or the service does not exist yet
#      (spec D17 — the environment is destroyed between sessions). NOT a failure.
#   2  unknown target
#   1  anything else, including a credential that does not work
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-llm-code-exec-260815}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-app}"
TAG="${TAG:-}"
CANDIDATE_TAG="candidate"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-./scripts/verify-deployment.sh}"

# Derived, never read from `terraform output` — see the header.
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/app"
BUILD_SA="app-build@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_BUCKET="gs://${PROJECT_ID}-build-source"
RUNTIME_SA="app-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SQL_INSTANCE="${PROJECT_ID}:${REGION}:app-db"

run() {
  echo
  echo "==> $*"
  "$@"
}

require_tag() {
  if [[ -z "$TAG" ]]; then
    echo "TAG is required and has no default." >&2
    echo "  It is what this deploy and any rollback name, so it must be a decision rather than a" >&2
    echo "  leftover. CI passes the commit SHA; by hand, pass TAG=v4 or similar." >&2
    exit 1
  fi
}

service_url() {
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)' 2>/dev/null
}

# The URL of the no-traffic candidate, or empty when there is none. Selected by TAG rather than by
# position: the traffic list also carries the serving entry, and `[0]` is a coin flip that happens
# to work today — the same mistake infra/valkey.tf's endpoint selection had to avoid.
candidate_url() {
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
for t in d.get("status", {}).get("traffic", []):
    if t.get("tag") == "candidate" and t.get("url"):
        print(t["url"])
        break
'
}

preflight() {
  echo
  echo "==> preflight"

  # STAGE 1 — does the credential work? This must FAIL the job, never report "torn down".
  #
  # A single registry probe would treat every non-zero exit as "the environment is gone", including
  # PERMISSION_DENIED, an expired federated token, a disabled API and a network failure — so a wrong
  # IAM grant or a wrong workload_identity_provider variable would finish GREEN saying the
  # environment is torn down. That is the decorative-assertion pattern applied to the one step that
  # decides whether anything else runs.
  if ! gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' >/dev/null; then
    echo "    cannot read project ${PROJECT_ID}." >&2
    echo "    This is a CREDENTIAL problem, not a torn-down environment: the federated identity" >&2
    echo "    could not authenticate or lacks resourcemanager.projects.get. Check the" >&2
    echo "    GCP_WORKLOAD_IDENTITY_PROVIDER variable and infra/wif.tf." >&2
    exit 1
  fi
  echo "    credential works"

  # STAGE 2 — is there an environment? The Artifact Registry repository is the cheapest proof that
  # the Terraform layer exists, and it is destroyed between working sessions (spec D17), so this is
  # the EXPECTED state most of the time rather than a failure.
  if ! gcloud artifacts repositories describe app \
    --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "    no Artifact Registry repository 'app' in ${PROJECT_ID}/${REGION}."
    echo "    The environment is torn down — see docs/runbooks/gcp-teardown.md."
    echo "    Rebuild it with docs/runbooks/gcp-bootstrap.md, then run the 'create' target."
    exit 3
  fi

  # STAGE 3 — is there a SERVICE? Cloud Run gives a brand-new service's first revision 100% of
  # traffic, so `--no-traffic` cannot exist on a create and the phase's one invariant — no user
  # ever sees an unverified revision — would have to carry an exception. It does not: creating the
  # service is the `create` target, run by hand after a rebuild (spec D4/S9), and CI stops here.
  if [[ -z "$(service_url)" ]]; then
    echo "    service '${SERVICE}' does not exist yet."
    echo "    CD does not create it: the first revision of a new service takes 100% of traffic"
    echo "    immediately, so it cannot be verified before users reach it. Run this once by hand:"
    echo "      TAG=<tag> ./scripts/deploy-cloud-run.sh create"
    exit 3
  fi
  echo "    environment and service present"
}

require_auth0_args() {
  # The three VITE_AUTH0_* values are inlined into the SPA bundle at build time. A bundle built
  # without them is valid, has a strict CSP, passes every check, and cannot log in — so this is a
  # guard rather than tidiness. The Dockerfile refuses them too, but that failure arrives minutes
  # later inside a remote build.
  local missing=0 v
  for v in VITE_AUTH0_DOMAIN VITE_AUTH0_CLIENT_ID VITE_AUTH0_AUDIENCE; do
    if [[ -z "${!v:-}" ]]; then
      echo "$v is empty — it is baked into the SPA bundle and login breaks silently without it." >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    echo "  Locally: set -a; . frontend/.env.local; set +a" >&2
    echo "  In CI:   repository variables, not secrets — these ship in a public JS bundle." >&2
    exit 1
  fi
}

# What CI runs. `ubuntu-latest` is amd64, so this is a native build with no emulation — the reason
# builds went to Cloud Build in the first place does not apply there (P3-D4). Needs no IAM beyond
# the artifactregistry.writer the federated principal already holds.
build() {
  require_tag
  require_auth0_args

  # --platform is explicit rather than implied by the host. Cloud Run rejects an arm64 image with a
  # manifest error that never mentions architecture, and this script is also run from a laptop.
  run docker build --platform linux/amd64 \
    --build-arg "VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN}" \
    --build-arg "VITE_AUTH0_CLIENT_ID=${VITE_AUTH0_CLIENT_ID}" \
    --build-arg "VITE_AUTH0_AUDIENCE=${VITE_AUTH0_AUDIENCE}" \
    -t "${REGISTRY}/${SERVICE}:${TAG}" .

  run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  run docker push "${REGISTRY}/${SERVICE}:${TAG}"
}

# The by-hand path on Apple Silicon, where the build above is emulated: it took over ten minutes and
# was OOM-killed twice. Cloud Build does the same Dockerfile natively in about two minutes. Same
# image, different transport — cloudbuild.yaml is the definition it submits.
build:remote() {
  require_tag
  require_auth0_args

  run gcloud builds submit --config=cloudbuild.yaml \
    --project="$PROJECT_ID" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
    --gcs-source-staging-dir="${BUILD_BUCKET}/source" \
    --substitutions=_TAG="$TAG",_AUTH0_DOMAIN="$VITE_AUTH0_DOMAIN",_AUTH0_CLIENT_ID="$VITE_AUTH0_CLIENT_ID",_AUTH0_AUDIENCE="$VITE_AUTH0_AUDIENCE"
}

# One deploy command, two intents. `deploy` is what CI runs and always produces a candidate that
# serves nobody; `create` is the by-hand first deploy after a rebuild, where Cloud Run gives the
# first revision 100% and there is no alternative. Sharing the body is what keeps the service's
# shape identical either way — ADR-0005 makes that shape the specification, so it must not have two
# definitions. $1 is `candidate` or `live`.
deploy_revision() {
  require_tag
  local project_number origin
  project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  # FRONTEND_ORIGIN must be the service's own URL, and on a create the service has no URL yet — so
  # it is computed from the project number rather than read back, and verify-deployment.sh asserts
  # afterwards that the computed value equals status.url. #188 is what a wrong value looks like:
  # nothing visibly breaks, because Cloud Run serves the SPA and the API from one origin and
  # same-origin requests never consult CORS.
  origin="https://${SERVICE}-${project_number}.${REGION}.run.app"

  # `local -a x=()` plus `"${x[@]}"` is an unbound-variable error under `set -u` on bash 3.2, which
  # is what /bin/bash still is on macOS. The `${x[@]+…}` form is the portable expansion.
  local -a traffic_flags=()
  if [[ "${1:?deploy_revision needs 'candidate' or 'live'}" == candidate ]]; then
    # A candidate that receives no traffic. This is the whole safety model of this pipeline: five
    # defects have reached this service and every one passed a fully green verify.sh, so a
    # revision is not trusted because it deployed — it is trusted because verify-deployment.sh
    # passed against it while nobody was being served by it.
    traffic_flags=(--no-traffic "--tag=${CANDIDATE_TAG}")
  fi

  run gcloud beta run deploy "$SERVICE" \
    --image "${REGISTRY}/${SERVICE}:${TAG}" \
    --region "$REGION" --project "$PROJECT_ID" \
    --execution-environment gen2 --sandbox-launcher \
    --service-account "$RUNTIME_SA" \
    --add-cloudsql-instances "$SQL_INSTANCE" \
    --set-env-vars "SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,SANDBOX_MAX_CONCURRENT=4,FRONTEND_ORIGIN=${origin}" \
    --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,OIDC_ISSUER=oidc-issuer:latest,OIDC_AUDIENCE=oidc-audience:latest,OIDC_JWKS_URL=oidc-jwks-url:latest \
    --cpu 2 --memory 2Gi --concurrency 8 --max-instances 2 \
    --network app-net --subnet app-subnet --vpc-egress private-ranges-only \
    --allow-unauthenticated \
    ${traffic_flags[@]+"${traffic_flags[@]}"}

  # The invoker binding, explicitly and every time. Domain Restricted Sharing makes
  # --allow-unauthenticated print a warning and carry on rather than fail (deploy runbook §3), so
  # a create that looked fine can leave a URL that 403s for everyone. Idempotent.
  run gcloud run services add-iam-policy-binding "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" \
    --member=allUsers --role=roles/run.invoker
}

# What CI runs. Refuses to create the service, on purpose: the first revision of a new service
# takes 100% of traffic immediately, so it cannot be verified before users reach it, and this
# pipeline's one invariant does not get an exception (P3-D6). `preflight` already catches this;
# the check is repeated here so calling `deploy` directly cannot skip it.
deploy() {
  if [[ -z "$(service_url)" ]]; then
    echo "service '${SERVICE}' does not exist — CD does not create it." >&2
    echo "  Run the first deploy after a rebuild by hand:" >&2
    echo "    TAG=${TAG:-<tag>} ./scripts/deploy-cloud-run.sh create" >&2
    exit 3
  fi
  deploy_revision candidate
}

# The by-hand first deploy after a rebuild. Never called by CI. It verifies immediately afterwards
# because there is no candidate window to verify inside — the revision is already serving, so the
# check is a smoke test rather than a gate, and a failure means deleting the service by hand.
create() {
  if [[ -n "$(service_url)" ]]; then
    echo "service '${SERVICE}' already exists — use 'deploy', which produces a candidate that" >&2
    echo "serves nobody until it has been verified." >&2
    exit 1
  fi
  echo
  echo "==> creating ${SERVICE}. Cloud Run gives the first revision 100% of traffic, so this one"
  echo "    is live before it is verified. That is why CD refuses this path (P3-D6). If the"
  echo "    verification below fails, delete it rather than leaving it public:"
  echo "      gcloud run services delete ${SERVICE} --region=${REGION} --project=${PROJECT_ID}"
  deploy_revision live
  verify
}

verify() {
  local url
  url="$(candidate_url)"
  if [[ -z "$url" ]]; then
    url="$(service_url)"
  fi
  if [[ -z "$url" ]]; then
    echo "no service URL to verify — is ${SERVICE} deployed?" >&2
    exit 1
  fi
  # Scope the log check to the revision just deployed. Without this the query covers the whole
  # service, and the OLD revision — the one still serving live traffic during candidate
  # verification — can veto promotion of a candidate that is fine.
  local revision
  revision="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
    --format='value(status.latestCreatedRevisionName)' 2>/dev/null)"

  # `env`, not a bare assignment prefix: PROJECT_ID and friends are shell variables here, not
  # exported ones, so a child process would otherwise fall back to verify-deployment.sh's own
  # defaults — which are the right values today and silently wrong the first time this script is
  # pointed at a second project.
  run env PROJECT_ID="$PROJECT_ID" REGION="$REGION" SERVICE="$SERVICE" REVISION="$revision" \
    "$VERIFY_SCRIPT" all "$url"
}

promote() {
  if [[ -z "$(candidate_url)" ]]; then
    echo
    echo "==> no candidate revision — the deploy created the service and it is already serving."
    return 0
  fi
  # --to-latest, NEVER --to-revisions. Pinning traffic to a named revision makes the *next* deploy
  # serve nobody: gcloud reports Done and the only hint is one word in its own success line,
  # "serving 0 percent of traffic" (deploy runbook §5).
  #
  # And the exit code is ignored on purpose. The 2026-08-17 rollback drill recorded update-traffic
  # moving traffic correctly and THEN exiting non-zero on a stale service template. A pipeline that
  # trusts the exit code concludes the promote failed while it succeeded, and whatever it does next
  # is worse than doing nothing. The split below is the actual answer.
  run gcloud run services update-traffic "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --to-latest || true

  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json \
    | python3 -c '
import json, sys
d = json.load(sys.stdin)
traffic = d.get("status", {}).get("traffic", [])
serving = [t for t in traffic
           if t.get("latestRevision") and t.get("percent") == 100 and not t.get("tag")]
if not serving:
    print("traffic is NOT 100% on the latest revision:", json.dumps(traffic), file=sys.stderr)
    print("update-traffic may have exited 0 without moving anything. Read the split, then see",
          file=sys.stderr)
    print("docs/runbooks/gcp-deploy.md §5.", file=sys.stderr)
    sys.exit(1)
print("    100% of traffic on", serving[0].get("revisionName"))
'
}

all() {
  preflight
  build
  deploy
  verify
  promote
}

case "${1:-all}" in
all) all ;;
preflight) preflight ;;
build) build ;;
build:remote) build:remote ;;
deploy) deploy ;;
create) create ;;
verify) verify ;;
promote) promote ;;
*)
  echo "unknown target: $1" >&2
  exit 2
  ;;
esac
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
chmod +x scripts/deploy-cloud-run.sh
./scripts/tests/deploy-cloud-run.test.sh
```

Expected: PASS — the closing line reads `N passed, 0 failed`.

- [ ] **Step 5: Prove the suite can go RED**

A check nobody has seen fail is not a check. Point the suite at a mutated copy:

```bash
# Redirect rather than `sed -i`, whose in-place syntax differs between BSD and GNU sed.
sed 's/--to-latest/--to-revisions=app-00001=100/' scripts/deploy-cloud-run.sh > /tmp/mutant.sh
chmod +x /tmp/mutant.sh
DEPLOY=/tmp/mutant.sh ./scripts/tests/deploy-cloud-run.test.sh; echo "exit: $?"
rm /tmp/mutant.sh
```

Expected: the `promote uses --to-latest` case reports FAIL and the script exits non-zero.

- [ ] **Step 5a: Run it against the live service**

The fixtures above are hand-written, and `promote()`'s readback —
`t.get("latestRevision") and t.get("percent") == 100 and not t.get("tag")` — depends on the real
shape of `status.traffic`: whether `latestRevision` appears in *status* as well as in spec, and
whether `percent` comes back as an integer. If that is wrong, CD breaks on its first real run, on
`main`. The environment is up, so settle it now:

```bash
PROJECT_ID=llm-code-exec-260815 REGION=us-central1 SERVICE=app \
  ./scripts/deploy-cloud-run.sh preflight     # expect exit 0, "environment present"

PROJECT_ID=llm-code-exec-260815 REGION=us-central1 SERVICE=app \
  ./scripts/deploy-cloud-run.sh promote
```

`promote` is a no-op against a service already serving its latest revision — there is no candidate
tag, so it takes the early return. Expected: `no candidate revision — the deploy created the
service and it is already serving.` To exercise the readback itself, temporarily comment out the
early return and re-run: expected `100% of traffic on app-00005-dpz`, then restore it.

- [ ] **Step 6: Rewrite the runbook around the script**

In `docs/runbooks/gcp-deploy.md`, replace the command block in §1 with:

```bash
# The three VITE_AUTH0_* values are shell variables and nothing has exported them yet. `set -a`
# marks everything sourced for export; without it they expand to empty strings and the script's
# guard aborts before the build starts.
set -a; . frontend/.env.local; set +a

# build:remote, not build. `build` is a native `docker build`, which is what CI runs on an amd64
# runner; on Apple Silicon that same build is emulated, takes over ten minutes and was OOM-killed
# twice. build:remote submits the identical Dockerfile to Cloud Build, which does it natively in
# about two minutes.
TAG=v4 ./scripts/deploy-cloud-run.sh build:remote
```

and the command block in §2 with:

```bash
# First deploy after a rebuild — the service does not exist yet, so this one is live before it is
# verified and CD deliberately refuses to do it (see "Continuous deployment" below).
TAG=v4 ./scripts/deploy-cloud-run.sh create

# Every deploy after that. `deploy` produces a revision serving nobody; `promote` moves traffic
# once §4's checks pass. CD runs exactly these two.
TAG=v4 ./scripts/deploy-cloud-run.sh deploy
TAG=v4 ./scripts/deploy-cloud-run.sh verify
TAG=v4 ./scripts/deploy-cloud-run.sh promote
```

**Keep every annotation** — the "flags that are not optional, and what breaks without them" list,
the `--service-account` rationale, the `--gcs-source-staging-dir` rationale, the `_TAG` note,
`--allow-unauthenticated`. They are why the command has the shape it has, and the script cannot
carry them. Add one paragraph above §1:

```markdown
**The command lives in [`scripts/deploy-cloud-run.sh`](../../scripts/deploy-cloud-run.sh), not in
this file.** ADR-0005 makes it the specification for the service's shape, and CI runs the same
script (`.github/workflows/deploy.yml`), so a copy here would be a second specification — and the
copy is the one that goes stale. This section says *why* each flag is there; the script says what
is run. The script derives every project-specific value from the resource names Terraform uses and
deliberately reads no Terraform state (plan P3-D2), which is the one place it differs from the
`terraform output` calls this runbook used to make.
```

- [ ] **Step 7: Update `docs/sdlc.md` — required, not optional**

`scripts/**` is in `scripts/check-sdlc-sync.sh`'s watched set, so `SDLC docs` fails without this.
Add to the *Changing this SDLC* section, after the `scripts/worktree-new.sh` paragraph:

```markdown
`scripts/deploy-cloud-run.sh` is the other piece of developer tooling here that is not a CI check.
It holds the `gcloud beta run deploy` command that [ADR-0005](adr/0005-cloud-run-service-outside-terraform.md)
makes the Cloud Run service's specification — the provider strips `sandboxLauncher` on every apply,
so the service is deployed by this command rather than by Terraform. A human runs it from
`docs/runbooks/gcp-deploy.md` and `.github/workflows/deploy.yml` runs the same targets, which is
the same "one script, two callers" contract the `verify.sh` scripts have. Its unit tests,
`scripts/tests/deploy-cloud-run.test.sh`, run against a fake `gcloud` on `PATH` — no project, no
credentials — and are hosted by the `SDLC docs` job for the same reason
`dependabot-auto-merge-disarm.test.sh` is: `deploy.yml` runs only on push to `main`, so a pull
request that edits the script never executes it and the tests would otherwise have no host.
```

**And fix the now-false sentence in *How this meets CI/CD*.** `docs/sdlc.md:334` reads *"A third
suite, `./scripts/tests/dependabot-auto-merge-disarm.test.sh`, is run by `SDLC docs` even though it
belongs to a different workflow."* After this PR there are more. Change the opening to:

```markdown
  Further suites are run by `SDLC docs` even though they belong to other workflows:
  `./scripts/tests/dependabot-auto-merge-disarm.test.sh` and
  `./scripts/tests/deploy-cloud-run.test.sh`. Each of their own workflows gates itself so that a PR
  editing it never executes it — `dependabot-auto-merge.yml` to `dependabot/npm_and_yarn/*`
  branches, `deploy.yml` to pushes on `main` — so the tests would have no host otherwise. Same file
  locally and in CI, like the other two. See
  [Auto-merging dependency bumps](#auto-merging-dependency-bumps) and
  [Continuous deployment](#continuous-deployment).
```

- [ ] **Step 8: Host the tests in the `SDLC docs` job**

In `.github/workflows/sdlc-docs.yml`, immediately after the existing
`Test the Dependabot auto-merge disarm logic` step and before `Check docs/sdlc.md is in sync`:

```yaml
      # A second lodger, for the same reason as the one above: deploy.yml runs only on push to
      # main, so a pull request that edits scripts/deploy-cloud-run.sh never executes it. The test
      # drives a fake gcloud on PATH and reads only files — no project, no credentials, no token.
      - name: Deploy script self-test
        run: ./scripts/tests/deploy-cloud-run.test.sh
```

- [ ] **Step 9: Full verification**

```bash
./scripts/tests/check-sdlc-sync.test.sh
./scripts/tests/deploy-cloud-run.test.sh
cd infra && ./verify.sh && cd ..
```

Expected: all three green. The backend and frontend suites are untouched by this PR, but run
`cd backend && ./verify.sh` before pushing anyway — CI does not skip.

- [ ] **Step 10: Commit and open the PR**

```bash
git add scripts/deploy-cloud-run.sh scripts/tests/deploy-cloud-run.test.sh \
        .github/workflows/sdlc-docs.yml docs/runbooks/gcp-deploy.md docs/sdlc.md
git commit -m "feat(deploy): the deploy command as one script, human and CI alike"
git push -u origin feat/deploy-script
gh pr create --title "feat(deploy): the deploy command as one script" --body "Closes #197. …"
```

---

## PR 2 — what the pipeline owes beyond "it exited 0"

Closes the second child issue. Independent of PR 1; the two meet in PR 5.

### Task 2: The post-deploy assertion battery, test-first

**Files:**
- Create: `scripts/verify-deployment.sh`, `scripts/tests/verify-deployment.test.sh`
- Modify: `docs/runbooks/gcp-deploy.md`, `docs/sdlc.md`, `.github/workflows/sdlc-docs.yml`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/verify-deployment.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for scripts/verify-deployment.sh, driven by a fake `gcloud` and a fake `curl`.
#
# Every assertion in that script exists because a defect got past a green verify.sh, so every one
# of them is tested from BOTH sides here: it passes on a healthy readback, and it FAILS on the
# readback that the corresponding real defect produced. An assertion nobody has seen fail is the
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
mkdir -p "$work/bin"
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

# $1 = the service JSON, $2 = log output (empty means a clean run)
make_fakes() {
  printf '%s' "$1" >"$work/service.json"
  printf '%s' "${2:-}" >"$work/logs.txt"
  : >"$work/calls.log"
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"logging read"*) cat "$work/logs.txt"; exit 0 ;;
  *)                cat "$work/service.json"; exit 0 ;;
esac
EOF
  chmod +x "$work/bin/gcloud"
}

logged() { grep -qF -- "$1" "$work/calls.log"; }

# $1 = health status, $2 = CSP header value ("" means the header is ABSENT, not empty), $3 =
# /api/execute status. The values go through files rather than interpolation so that an empty CSP
# suppresses the whole header line — a fake that emits a bare `content-security-policy:` would let
# the "no CSP at all" case pass, which is the exact bug this suite exists to catch elsewhere.
make_curl() {
  printf '%s' "$1" >"$work/health_status"
  printf '%s' "${2:-}" >"$work/csp"
  printf '%s' "$3" >"$work/execute_status"
  cat >"$work/bin/curl" <<EOF
#!/usr/bin/env bash
case "\$*" in
  *"/api/health"*)  printf '{"status":"ok"}\n%s' "\$(cat "$work/health_status")"; exit 0 ;;
  *"/api/execute"*) printf '%s' "\$(cat "$work/execute_status")"; exit 0 ;;
  *)
    csp="\$(cat "$work/csp")"
    if [[ -n "\$csp" ]]; then printf 'content-security-policy: %s\n' "\$csp"; fi
    exit 0 ;;
esac
EOF
  chmod +x "$work/bin/curl"
}

run_verify() {
  PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app \
    "$VERIFY" "$1" "$URL" >"$work/out.txt" 2>&1
}

CSP_OK="default-src 'self'; script-src 'self'; connect-src 'self' https://t.auth0.com"

# --- the healthy case passes every target ------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 200 "$CSP_OK" 401
for target in shape http logs all; do
  if run_verify "$target"; then ok "healthy service passes '$target'"; else
    bad "healthy service passes '$target'" "$(cat "$work/out.txt")"
  fi
done

# --- each assertion, from the failing side -----------------------------------------------------
# ADR-0005's whole premise: a terraform apply strips this and the service still looks healthy.
make_fakes "$(healthy_json | sed 's/"sandboxLauncher": true/"sandboxLauncher": false/')" ""
if run_verify shape; then
  bad "shape fails when sandboxLauncher is absent"
else
  ok "shape fails when sandboxLauncher is absent"
fi

# #188: the deployed service advertised Access-Control-Allow-Origin: http://localhost:5173.
make_fakes "$(healthy_json | sed "s|\"value\": \"$URL\"|\"value\": \"http://localhost:5173\"|")" ""
if run_verify shape; then
  bad "shape fails when FRONTEND_ORIGIN is not the service URL"
else
  ok "shape fails when FRONTEND_ORIGIN is not the service URL"
fi

# Without Direct VPC egress the service starts healthy and fails every quota lookup silently.
make_fakes "$(healthy_json | sed 's/app-subnet/wrong-subnet/')" ""
if run_verify shape; then
  bad "shape fails when the VPC interface is wrong"
else
  ok "shape fails when the VPC interface is wrong"
fi

# spec D12: at concurrency 4 the sandbox cap can never fire and its 503 path is dead code.
make_fakes "$(healthy_json | sed 's/"containerConcurrency": 8/"containerConcurrency": 4/')" ""
if run_verify shape; then
  bad "shape fails when containerConcurrency is not 8"
else
  ok "shape fails when containerConcurrency is not 8"
fi

make_fakes "$(healthy_json | sed 's/"name": "redis-url"/"name": "wrong-secret"/')" ""
if run_verify shape; then
  bad "shape fails when a secret is bound to the wrong container"
else
  ok "shape fails when a secret is bound to the wrong container"
fi

# --- the HTTP surface --------------------------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 503 "$CSP_OK" 401
if run_verify http; then bad "http fails when /api/health is not 200"; else
  ok "http fails when /api/health is not 200"
fi

make_curl 200 "$CSP_OK" 200
if run_verify http; then
  bad "http fails when an unauthenticated /api/execute is not 401"
else
  ok "http fails when an unauthenticated /api/execute is not 401"
fi

# The dev policy shipped once already: a static deploy of dist/ carried no CSP at all.
make_curl 200 "default-src 'self'; script-src 'self' 'unsafe-eval'" 401
if run_verify http; then bad "http fails when the CSP permits unsafe-eval"; else
  ok "http fails when the CSP permits unsafe-eval"
fi

make_curl 200 "" 401
if run_verify http; then bad "http fails when there is no CSP header at all"; else
  ok "http fails when there is no CSP header at all"
fi

# --- the logs ----------------------------------------------------------------------------------
make_fakes "$(healthy_json)" ""
make_curl 200 "$CSP_OK" 401
if run_verify logs; then ok "logs passes on a clean window"; else
  bad "logs passes on a clean window" "$(cat "$work/out.txt")"
fi

# #191: the quota was rejected on every call and fail-open turned that into unmetered requests.
make_fakes "$(healthy_json)" \
  "2026-08-17T14:00:00Z ERROR quota store unavailable — FAILING OPEN, requests are unmetered"
if run_verify logs; then
  bad "logs fails when the application logged a warning"
else
  ok "logs fails when the application logged a warning"
fi

# REVISION scoping. Unscoped, the OLD revision — the one still serving traffic while a candidate is
# being verified — can veto promotion of a candidate that is fine.
make_fakes "$(healthy_json)" ""
PATH="$work/bin:$PATH" PROJECT_ID=test-project REGION=us-central1 SERVICE=app \
  REVISION=app-00009-abc "$VERIFY" logs "$URL" >"$work/out.txt" 2>&1 || true
if logged "resource.labels.revision_name=app-00009-abc"; then
  ok "logs scopes the query to REVISION when it is set"
else
  bad "logs scopes the query to REVISION when it is set" "$(cat "$work/calls.log")"
fi

make_fakes "$(healthy_json)" ""
run_verify logs || true
if logged "revision_name"; then
  bad "logs is service-wide when REVISION is empty" "$(cat "$work/calls.log")"
else
  ok "logs is service-wide when REVISION is empty — the right scope after promotion"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chmod +x scripts/tests/verify-deployment.test.sh
./scripts/tests/verify-deployment.test.sh
```

Expected: FAIL — `scripts/verify-deployment.sh: No such file or directory`.

- [ ] **Step 3: Write the script**

Create `scripts/verify-deployment.sh`:

```bash
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
# WHAT THIS DELIBERATELY DOES NOT COVER, because saying so is the point (plan P3-D6):
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
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-all}"
URL="${2:-}"
PROJECT_ID="${PROJECT_ID:-llm-code-exec-260815}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-app}"
LOG_FRESHNESS="${LOG_FRESHNESS:-10m}"
# Scope the log query to one revision. Set for the pre-promotion call, empty for the post-promotion
# one — see logs() for why those want different scopes.
REVISION="${REVISION:-}"

if [[ -z "$URL" ]]; then
  echo "usage: $0 [all|shape|http|logs] <service-url>" >&2
  exit 2
fi

shape() {
  echo
  echo "==> shape (${SERVICE} in ${PROJECT_ID}/${REGION})"
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json \
    | PROJECT_ID="$PROJECT_ID" REGION="$REGION" python3 -c '
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
        print(f"    ok   {label} = {actual!r}")
    else:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}\n         {why}")


want("sandboxLauncher", c.get("sandboxLauncher"), True,
     "no /usr/local/gcp/bin/sandbox in the container, so every execution takes the exit-126 "
     "path. This is the flag Terraform strips on every apply (ADR-0005).")
want("execution-environment", ann.get("run.googleapis.com/execution-environment"), "gen2",
     "--sandbox-launcher requires gen2.")
want("vpc-access-egress", ann.get("run.googleapis.com/vpc-access-egress"),
     "private-ranges-only",
     "Valkey is a private PSC address; without Direct VPC egress the service starts healthy and "
     "fails every quota lookup silently.")
want("cloudsql-instances", ann.get("run.googleapis.com/cloudsql-instances"),
     f"{project}:{region}:app-db", "no Unix socket, so history has no database.")
want("maxScale", ann.get("autoscaling.knative.dev/maxScale"), "2",
     "max-instances bounds a runaway bill on a fixed budget.")
want("serviceAccountName", spec.get("serviceAccountName"),
     f"app-runtime@{project}.iam.gserviceaccount.com",
     "omitting it runs the service as the Compute Engine default account, which holds project "
     "Editor.")
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
    want(f"env {name}", env.get(name, {}).get("value"), value, "deploy runbook §2.")

# #188 in one assertion. The default is http://localhost:5173, and nothing visibly breaks with a
# wrong value because Cloud Run serves the SPA and the API from one origin.
want("env FRONTEND_ORIGIN", env.get("FRONTEND_ORIGIN", {}).get("value"), service_url,
     "a wrong origin is invisible from outside: same-origin requests never consult CORS (#188).")

for name in ("ANTHROPIC_API_KEY", "DATABASE_URL", "REDIS_URL", "OIDC_ISSUER", "OIDC_AUDIENCE",
             "OIDC_JWKS_URL"):
    ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
    want(f"secret {name}", (ref.get("name"), ref.get("key")),
         (name.lower().replace("_", "-"), "latest"), "bound from Secret Manager, never baked in.")

if failures:
    print("\n  shape assertions failed:", file=sys.stderr)
    for f in failures:
        print(f"    - {f}", file=sys.stderr)
    sys.exit(1)
print("    all shape assertions passed")
'
}

http() {
  echo
  echo "==> http (${URL})"
  local body status csp

  body="$(curl -s -w '%{http_code}' "${URL}/api/health")"
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
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}/api/execute" \
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
  csp="$(curl -sI "$URL" | grep -i '^content-security-policy:' || true)"
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
  # REVISION scopes the query to ONE revision, and it is not optional for the pre-promotion call.
  # Without it the filter covers the whole service — and during candidate verification the OLD
  # revision is the one serving live traffic, so any warning it emits in the window (including
  # #191's fail-open line, or anything logged before this deploy started) would block promotion of
  # a candidate that is fine. Post-promotion the service-wide scope is the right one, because the
  # question has changed from "is this candidate sound" to "is the service healthy now".
  #
  # Honest scope either way: a --no-traffic candidate has served nobody, so this catches boot-time
  # problems and nothing else. The fail-open quota line appears only once AUTHENTICATED traffic
  # arrives, which is why #191's real detection lives in the probes runbook and not here.
  local out revision_filter=""
  if [[ -n "${REVISION:-}" ]]; then
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
  echo "    ok   no application warnings"
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
chmod +x scripts/verify-deployment.sh
./scripts/tests/verify-deployment.test.sh
```

Expected: PASS — `N passed, 0 failed`.

- [ ] **Step 5: Run it against the live service**

The environment is up. This is the step that proves the fixtures match reality:

```bash
PROJECT_ID=llm-code-exec-260815 REGION=us-central1 SERVICE=app \
  ./scripts/verify-deployment.sh all https://app-530312723651.us-central1.run.app
```

Expected: every `ok` line, and `all shape assertions passed`. **If any assertion fails against the
currently-serving revision, the assertion is wrong or the service is** — stop and find out which
before continuing. That is the whole value of this step.

- [ ] **Step 6: Point the runbook's §4 at the script**

In `docs/runbooks/gcp-deploy.md` §4, replace the two `curl` commands and the `gcloud logging read`
block with:

```bash
./scripts/verify-deployment.sh all "$(gcloud run services describe app \
  --region=us-central1 --project=llm-code-exec-260815 --format='value(status.url)')"
```

Keep the surrounding prose — *"neither of the commands above says anything about Valkey or Cloud
SQL"*, the fail-open warning, the Fibonacci check, and the Auth0 callback note. Add:

```markdown
`verify-deployment.sh` replaces the hand-run curls with assertions that fail rather than print, and
it adds the one thing curl cannot do: it reads the deployed service's **shape** back from the API
and checks it against this section's flag list — `sandboxLauncher`, the VPC interfaces, the Cloud
SQL instance, the runtime identity, concurrency 8, and `FRONTEND_ORIGIN`. What it still does not
cover is everything behind the auth gate: a real execution, the cross-owner 404, and the quota
burst all need an authenticated caller, and those stay in
[`gcp-isolation-probes.md`](gcp-isolation-probes.md).
```

- [ ] **Step 7: Update `docs/sdlc.md` and host the tests**

`scripts/**` is a watched path, so `SDLC docs` fails without this. Write it **self-contained** —
PRs 1 and 2 are independent and either may land first, so neither may assume the other's paragraph
exists. Add to the *Changing this SDLC* section:

```markdown
`scripts/verify-deployment.sh` holds the post-deploy assertions: it reads the deployed Cloud Run
service back from the API and checks its shape against `docs/runbooks/gcp-deploy.md`'s flag list,
then checks the endpoints an anonymous caller can reach and the application's own log window. A
human runs it from that runbook's §4 and `.github/workflows/deploy.yml` runs it against a revision
that is receiving no traffic yet. Its tests, `scripts/tests/verify-deployment.test.sh`, drive a fake
`gcloud` and a fake `curl` and exercise every assertion from **both** sides — passing on a healthy
readback and failing on the readback the corresponding real defect produced. They are hosted by the
`SDLC docs` job for the same reason `dependabot-auto-merge-disarm.test.sh` is: `deploy.yml` runs
only on push to `main`, so a pull request that edits the script never executes it and the tests
would otherwise have no host.
```

**And fix the now-false sentence in *How this meets CI/CD*.** `docs/sdlc.md:334` reads *"A third
suite … is run by `SDLC docs`"*. This PR adds another. Change the opening to *"Further suites are
run by `SDLC docs` even though they belong to other workflows"* and name
`./scripts/tests/verify-deployment.test.sh` alongside
`./scripts/tests/dependabot-auto-merge-disarm.test.sh`. If PR 1 has already landed, its edit is
already there and this is a one-line addition to the list; if not, write the full replacement and
PR 1 adds its name to the list instead.

In `.github/workflows/sdlc-docs.yml`, after the `Test the Dependabot auto-merge disarm logic` step:

```yaml
      - name: Deployment verification self-test
        run: ./scripts/tests/verify-deployment.test.sh
```

- [ ] **Step 8: Full verification and commit**

```bash
./scripts/tests/verify-deployment.test.sh
./scripts/tests/check-sdlc-sync.test.sh
git add scripts/verify-deployment.sh scripts/tests/verify-deployment.test.sh \
        .github/workflows/sdlc-docs.yml docs/runbooks/gcp-deploy.md docs/sdlc.md
git commit -m "feat(deploy): assert the deployed service's shape, not just its exit code"
git push -u origin feat/verify-deployment
gh pr create --title "feat(deploy): post-deploy verification battery" --body "Closes #198. …"
```

---

## PR 3 — the grants, and keeping federation alive across a teardown

Closes the third child issue. Terraform and runbooks only; no CI, no application code.

### Task 3: The IAM the pipeline needs

**Files:**
- Modify: `infra/wif.tf`, `docs/runbooks/gcp-teardown.md`

- [ ] **Step 1: Add the build-submitter role and the three grants**

Append to `infra/wif.tf`:

```hcl
# --- What Phase 3's pipeline needs, on top of the three grants above -----------------------------
#
# Exactly one grant, and the shortness of this list is a decision rather than luck. CI builds the
# image with `docker build` in the runner and pushes it with the artifactregistry.writer above
# (P3-D4), so nothing here touches Cloud Build: no builds.create, no actAs on app-build, no write
# on the staging bucket. `gcloud builds submit` stays the by-hand path, run by a human as
# themselves, and app-build's grants in build.tf are unchanged.

# Read the service's own logs after a deploy. scripts/verify-deployment.sh's `logs` target is the
# only check that can see a boot-time application warning at all — everything else observes the
# service from outside, where a failing-open quota looks identical to a healthy one. Viewer, not
# admin: CI never writes, exports or deletes a log.
#
# Project-scoped, which P1-D5 would rather it were not, and the honest reason is that Cloud Logging
# has no per-service log resource to bind to. It is broader than it looks: roles/logging.viewer
# also reads the project's Admin Activity audit log, so this principal can see the IAM history.
# Accepted because the alternative — a log view binding on _Default — trades that for a
# configuration nothing else in this project uses, and the entries it reads are already visible to
# anyone who can read the repository's deploy logs.
resource "google_project_iam_member" "ci_log_viewer" {
  project = var.project_id
  role    = "roles/logging.viewer"
  member  = local.github_principal
}
```

- [ ] **Step 2: Verify the configuration**

```bash
cd infra && ./verify.sh
```

Expected: green. `fmt` will reformat the block if the alignment is off — run
`terraform fmt` and re-check rather than hand-aligning.

- [ ] **Step 2a: Get `terraform.tfvars` into the worktree**

`CLAUDE.md` requires this child to be worked in a worktree from `scripts/worktree-new.sh`, and that
script links `.env.shared`, `.claude/settings.local.json`, `.env` and `frontend/.env.local` — **not**
`infra/terraform.tfvars`, which is gitignored (`infra/.gitignore` ignores every `*.tfvars`) and
holds `project_id` and `billing_account`. Without it every command below fails with *"No value for
required variable"*:

```bash
cp /Users/igorkamenetsky/Workspaces/Claude/llm-code-execution/infra/terraform.tfvars infra/terraform.tfvars
```

`infra/.gitignore` keeps it untracked in the worktree too, and `infra/verify.sh`'s
`gate_no_state_in_git` is the backstop if it ever is not.

- [ ] **Step 3: Apply, and read the plan first**

```bash
cd infra
terraform plan       # expect: 1 to add, 0 to change, 0 to destroy
terraform apply
```

If `terraform init` fails with `invalid_grant … reauth related error`, the application-default
credentials have expired: `gcloud auth application-default login`.

- [ ] **Step 4: Prove the principal is what you think it is**

```bash
gcloud projects get-iam-policy llm-code-exec-260815 \
  --flatten="bindings[].members" \
  --filter="bindings.members:workloadIdentityPools" \
  --format="table(bindings.role, bindings.members)"
```

Expected exactly **two** project-level roles against the
`attribute.repository/igor-ka/llm-code-execution` principalSet: `roles/run.admin` and
`roles/logging.viewer`. **A `roles/editor`, `roles/owner`, any `cloudbuild.*`, or any `*.admin`
beyond `run.admin` is the finding this step exists to surface** — the first three would mean the
Cloud Build grants P3-D4 removed came back, and the last would mean a binding was granted to the
pool rather than to the repository attribute.

The other two grants are deliberately **absent** from this output, and that is P1-D5 working rather
than a missing apply: `ci_writer` is on the Artifact Registry repository and `ci_act_as_runtime` is
on a service account. `gcloud projects get-iam-policy` returns the project policy only. Check them
individually:

```bash
gcloud artifacts repositories get-iam-policy app --location=us-central1 \
  --project=llm-code-exec-260815
gcloud iam service-accounts get-iam-policy app-runtime@llm-code-exec-260815.iam.gserviceaccount.com \
  --project=llm-code-exec-260815
```

- [ ] **Step 5: Stop the session-end teardown from destroying federation**

This is P3-D7, and it is the step this PR exists for as much as the grants are.

**Three edits, and all three are required** — a reader following `gcp-teardown.md` top to bottom
must not be able to reach a bare `terraform destroy` on the between-sessions path. Today the
*Two different teardowns* section (line 9) says *"Run steps 1 and 2 only"* and §2's first command
block is an unlabelled `terraform destroy` (line 55), so adding the targeted form further down would
leave the trap intact. So:

1. In *Two different teardowns*, change *"Run steps 1 and 2 only"* to **"Run step 1 and the
   *targeted* destroy in step 2 only"**.
2. In §2, put the new `### Between working sessions` block **before** the existing `terraform
   plan -destroy` / `terraform destroy` pair.
3. Give that existing pair the heading **`### At the end (day 91, or for good)`**, and move the
   *"If this is a between-sessions teardown, stop here"* paragraph into the new block, where it now
   belongs.

The new block:

````markdown
### The between-sessions destroy is targeted, and that is not an optimisation

`terraform destroy` with no arguments destroys `google_iam_workload_identity_pool.github`. Pools
**soft-delete**: the ID is reserved for about 30 days and cannot be reused (see §4), so the next
`terraform apply` cannot re-create it — and since Phase 3, that pool is how GitHub Actions
authenticates. A full destroy at the end of a working session therefore leaves **continuous
deployment broken until the reservation lapses**, with a rebuild that looks fine right up to the
`auth` step of the next push.

So the between-sessions teardown destroys the things that bill by the hour, and nothing else:

```bash
cd infra
terraform plan -destroy \
  -target=google_sql_database_instance.main \
  -target=google_memorystore_instance.quota \
  -target=google_network_connectivity_service_connection_policy.valkey \
  -target=google_compute_subnetwork.main \
  -target=google_compute_network.main       # read it

terraform destroy \
  -target=google_sql_database_instance.main \
  -target=google_memorystore_instance.quota \
  -target=google_network_connectivity_service_connection_policy.valkey \
  -target=google_compute_subnetwork.main \
  -target=google_compute_network.main
```

Terraform prints a warning that resource targeting is not a recommended practice. It is right in
general and wrong here: the alternative is a month without CD.

Everything left standing is free or close to it — the service accounts, both budgets, the six
secret **containers**, the workload identity pool, the Artifact Registry repository (a few images,
cents a month) and the staging bucket (7-day lifecycle). One consequence is worth having: the four
static secret payloads survive, so the rebuild repopulates only `database-url` and `redis-url` —
the two [`gcp-bootstrap.md`](gcp-bootstrap.md) §10 already flags as changing on every rebuild.

`-exclude` would express this better than five `-target`s. Terraform 1.15.8 does not have it;
`terraform plan -exclude=…` fails with *"flag provided but not defined"*. Revisit when the pinned
version gains it.

**The full teardown is unchanged**: everything below still runs a plain `terraform destroy`, and
still ends at `gcloud projects delete`, which is what actually disposes of the pool.
````

- [ ] **Step 6: Exercise it — a session-end teardown and rebuild**

The claim above is worth nothing untested. Run the real thing:

```bash
gcloud run services delete app --region=us-central1 --project=llm-code-exec-260815 --quiet
cd infra && terraform destroy -target=google_sql_database_instance.main \
  -target=google_memorystore_instance.quota \
  -target=google_network_connectivity_service_connection_policy.valkey \
  -target=google_compute_subnetwork.main -target=google_compute_network.main

gcloud iam workload-identity-pools list --location=global --project=llm-code-exec-260815
gcloud artifacts repositories list --project=llm-code-exec-260815
gcloud secrets versions list anthropic-api-key --project=llm-code-exec-260815
```

Expected: the pool **ACTIVE**, the repository present, and `anthropic-api-key` still holding its
version. Then rebuild:

```bash
terraform apply
printf 'postgresql://app:%s@localhost/app?host=/cloudsql/%s' \
  "$(terraform output -raw db_password)" "$(terraform output -raw sql_connection_name)" \
  | gcloud secrets versions add database-url --data-file=-
printf 'redis://%s' "$(terraform output -raw valkey_endpoint)" \
  | gcloud secrets versions add redis-url --data-file=-
```

Record the elapsed time and the observed output in the teardown runbook's appendix, in the style of
the existing S7 rehearsal. **Redeploy the service before finishing** — `docs/runbooks/gcp-deploy.md`
§2 by hand, or `./scripts/deploy-cloud-run.sh create` if PR 1 has already landed. **`create`, not
`deploy`** — step 1 above deleted the service, and `deploy` deliberately exits 3 when there is no
service to deploy a revision of. PRs 1–3 are independent and may be worked in any order, so do not
assume the script exists. `terraform apply` does not bring the service back either way (ADR-0005).

- [ ] **Step 7: Commit and open the PR**

```bash
git add infra/wif.tf docs/runbooks/gcp-teardown.md
git commit -m "feat(infra): the grants CD needs, and federation that survives a teardown"
git push -u origin feat/infra-cd-grants
gh pr create --title "feat(infra): grants for CD, and federation across a teardown" \
             --body "Closes #199. …"
```

---

## PR 4 — Dependabot stops being an exception

Closes the fourth child issue. Independent of PRs 1–3 and of the pipeline; it must land before PR 6
can claim that *every* merge to `main` deploys. This is P3-D11.

### Task 4: Merge under a GitHub App, not `GITHUB_TOKEN`

**Files:**
- Modify: `.github/workflows/dependabot-auto-merge.yml`, `docs/sdlc.md`

- [ ] **Step 1: Create the app and record its credentials**

In GitHub → Settings → Developer settings → GitHub Apps → New GitHub App. Name it
`llm-code-execution-automerge`. Repository permissions: **Contents: Read and write**, **Pull
requests: Read and write**, nothing else. No webhook. Install it on `igor-ka/llm-code-execution`
only.

Then generate a private key and store both values as repository **secrets** — these are genuine
secrets, unlike the `VITE_AUTH0_*` variables:

```bash
# --app dependabot is NOT optional, and getting it wrong is a silent failure.
#
# This workflow runs on `pull_request` events raised BY Dependabot, and GitHub does not pass
# ordinary Actions secrets to those runs — they get the separate *Dependabot* secret store. Plain
# `gh secret set` would leave both inputs empty at run time, the token-minting step would fail with
# an unhelpful error, and the auto-merge would simply stop working.
gh secret set AUTOMERGE_APP_ID --app dependabot --body "<the numeric App ID>"
gh secret set AUTOMERGE_APP_PRIVATE_KEY --app dependabot \
  < ~/Downloads/llm-code-execution-automerge.*.private-key.pem
rm ~/Downloads/llm-code-execution-automerge.*.private-key.pem

gh secret list --app dependabot   # both must appear here, not under `gh secret list`
```

The downloaded `.pem` is the credential. Delete it locally once it is in the secret; GitHub cannot
show it again, and regenerating is one click if it is ever lost.

- [ ] **Step 2: Mint a token in the `apply` job**

In `.github/workflows/dependabot-auto-merge.yml`, add to the `apply` job's steps, before the `gh`
call:

```yaml
      # An installation token that expires in an hour, in place of GITHUB_TOKEN. This is not about
      # scope — GITHUB_TOKEN has contents: write here already — it is about what GitHub does with
      # the resulting push: a push made with GITHUB_TOKEN starts NO workflow run, so an auto-merged
      # bump has always landed on main with no push-side CI run (docs/sdlc.md, confirmed at
      # 8211ee8), and since Phase 3 it would land with no deploy either. An App token pushes as a
      # first-class actor, so CI and Deploy both run and Dependabot stops being a special case.
      - name: Mint an installation token
        id: apptoken
        uses: actions/create-github-app-token@df432ceedc7162793a195dd1713ff69aefc7379e # v2.0.6
        with:
          app-id: ${{ secrets.AUTOMERGE_APP_ID }}
          private-key: ${{ secrets.AUTOMERGE_APP_PRIVATE_KEY }}
```

and change the `gh` steps' `GH_TOKEN` from `${{ secrets.GITHUB_TOKEN }}` to
`${{ steps.apptoken.outputs.token }}`.

**The `gate` job is not touched.** It runs the one third-party action under `pull-requests: read`
and publishes a verdict; handing it an App token would undo the scope split that
[`docs/sdlc.md`](../sdlc.md) calls the point of the two-job design.

- [ ] **Step 3: Resolve the action pin**

The SHA above must be verified rather than trusted from this plan:

```bash
gh api repos/actions/create-github-app-token/commits/v2.0.6 --jq '.sha'
```

Paste the result with the version as a trailing comment, matching how this repository pins
`dependabot/fetch-metadata`. If it differs from the SHA above, the plan is stale and the command
wins.

- [ ] **Step 4: Update `docs/sdlc.md`**

`.github/workflows/**` is a watched path. In *Auto-merging dependency bumps*, replace the paragraph
beginning **"An auto-merge does not re-run `CI` on `main`"** — it is about to stop being true — with:

```markdown
**An auto-merge now does re-run `CI` on `main`, and triggers `Deploy`.** It did not until Phase 3.
A `push` event triggered by `GITHUB_TOKEN` starts no workflow run at all (`workflow_dispatch` and
`repository_dispatch` are the documented exceptions), and auto-merge armed by this workflow used to
merge as `app/github-actions` — so `8211ee8` (PR #117) has no `push`-side CI run while every
human-merged commit around it does. That was harmless while nothing keyed off "CI ran on main"; it
stopped being harmless the moment a deploy did. The `apply` job therefore merges with a GitHub App
installation token, which pushes as a first-class actor. The gap in `main`'s push-side history
before that change is real and stays in the record.
```

- [ ] **Step 4a: Confirm the secrets are readable from a Dependabot-triggered run**

The store distinction above cannot be checked by reading the repository settings — Actions and
Dependabot secrets look identical there. Add a temporary step to the `apply` job that echoes
whether each input is non-empty (never the value), let it run on one Dependabot PR, then remove it.
An empty `app-id` here is the whole finding, and it fails in a way that looks like a broken App
rather than a misplaced secret.

- [ ] **Step 5: Verify on the next Dependabot PR**

There are seventeen open Dependabot PRs, so this is testable within a day rather than in theory.
Watch one patch/minor npm bump through to merge and confirm **both** a push-side `CI` run and a
`Deploy` run appear for the merge commit:

```bash
gh run list --branch main --limit 10 \
  --json workflowName,headSha,event,createdAt --jq '.[] | [.workflowName,.event,.headSha[0:7]] | @tsv'
```

Expected: a `push` event for the merge SHA under both `CI` and `Deploy`. Before this change there
would be neither.

- [ ] **Step 6: Commit and open the PR**

```bash
git add .github/workflows/dependabot-auto-merge.yml docs/sdlc.md
git commit -m "fix(ci): auto-merge under a GitHub App, so its merges trigger workflows"
git push -u origin fix/automerge-app-token
gh pr create --title "fix(ci): auto-merge under a GitHub App token" --body "Closes #200. …"
```

---

## PR 5 — the pipeline

Closes the fifth child issue. Needs PRs 1–3 on `main`.

### Task 5: The workflow

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `docs/sdlc.md`, `docs/runbooks/gcp-deploy.md`

- [ ] **Step 1: Set the repository variables**

These are **variables, not secrets**. All five ship in a public JavaScript bundle or in a public
Terraform file; calling them secrets would mask them in logs for no benefit and make the workflow
harder to debug.

```bash
gh variable set GCP_PROJECT_ID --body "llm-code-exec-260815"
gh variable set GCP_REGION --body "us-central1"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --body "$(cd infra && terraform output -raw workload_identity_provider)"
set -a; . frontend/.env.local; set +a
gh variable set VITE_AUTH0_DOMAIN --body "$VITE_AUTH0_DOMAIN"
gh variable set VITE_AUTH0_CLIENT_ID --body "$VITE_AUTH0_CLIENT_ID"
gh variable set VITE_AUTH0_AUDIENCE --body "$VITE_AUTH0_AUDIENCE"
gh variable list
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

# Continuous deployment for the Cloud Run service. It runs the SAME scripts a human runs from
# docs/runbooks/gcp-deploy.md — scripts/deploy-cloud-run.sh and scripts/verify-deployment.sh — so
# the pipeline and the runbook cannot drift. See docs/sdlc.md, "Continuous deployment".
#
# TRIGGERS, and the one that is deliberately absent:
#   push to main      — the direct expression of "deploy what is on main".
#   workflow_dispatch — redeploy a tag. NOT a rebuild button: after a teardown the service does not
#                       exist, and CD refuses to create it (see the preflight step).
#   NOT workflow_run on CI. It would fire only when CI runs on main, and CI does not run on main for
#   a merge performed with GITHUB_TOKEN. Note that `push` shares that blind spot — the mechanism in
#   docs/sdlc.md is that NO workflow starts for such a push — which is why the auto-merge job now
#   merges under a GitHub App token instead. Fixing it at the source beats routing around it.
#   The PR's own checks already ran against this base: strict_required_status_checks_policy is on.
#
# THIS IS NOT A REQUIRED STATUS CHECK and must not be added to the "Protect main" ruleset. It never
# runs on pull_request, so requiring it would block every merge on a check that can never report —
# the trap docs/sdlc.md records for workflow-level `paths:` filters, reached by a different road.
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      tag:
        description: "Image tag to build and deploy. Defaults to the commit SHA."
        required: false
        type: string

# Never cancel a deploy in flight. ci.yml uses cancel-in-progress correctly for checks, where a
# superseded run is waste. Here it could kill the job between `update-traffic` and the assertion
# that reads the split back — the one window where an interrupted run leaves the service in a state
# nobody has looked at.
concurrency:
  group: deploy-cloud-run
  cancel-in-progress: false

# id-token: write is the OIDC token Workload Identity Federation exchanges. Nothing else — this
# workflow writes nothing to the repository and reads no other repository's contents.
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    name: Deploy to Cloud Run
    runs-on: ubuntu-latest
    steps:
      # persist-credentials: false keeps the token out of .git/config. This is the one workflow
      # here holding id-token: write, and it runs repository scripts; sdlc-docs.yml sets the same
      # flag for the same reason.
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      # Direct Workload Identity Federation: no `service_account` input, because there is no
      # deployer service account to impersonate and therefore no key to leak (P1-D4). The roles are
      # granted straight to the principalSet in infra/wif.tf, scoped by attribute.repository.
      #
      # Pinned by SHA with the version in the trailing comment, matching how this repository pins
      # dependabot/fetch-metadata. Dependabot bumps SHA pins by that comment, and `github_actions`
      # is deliberately outside its auto-merge allow-list, so a new SHA here is always read by a
      # human before it merges.
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          project_id: ${{ vars.GCP_PROJECT_ID }}
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}

      # `version:` is not decoration: it forces setup-gcloud to install its own SDK. The runner's
      # preinstalled google-cloud-cli comes from apt, where the component manager is DISABLED, and
      # `install_components: beta` against it fails with "The component manager is disabled for this
      # installation". `gcloud beta run deploy` needs the component, so this cannot be skipped.
      - name: Set up gcloud
        uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1
        with:
          version: "540.0.0"
          install_components: beta

      # Three stages, and only the last two may report "nothing to deploy". A credential failure
      # exits 1 and fails the job — see P3-D8. Exit 3 means the environment is torn down (spec D17)
      # or the service has not been created yet, both of which are expected states rather than
      # failures, and this step turns them into a green no-op rather than a red X that trains
      # people to ignore red Xs.
      - name: Preflight — credential, environment, service
        id: preflight
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
        run: |
          set +e
          ./scripts/deploy-cloud-run.sh preflight
          rc=$?
          set -e
          if [[ "$rc" -eq 3 ]]; then
            echo "present=false" >> "$GITHUB_OUTPUT"
            {
              echo "### No deploy"
              echo
              echo "Nothing was built or deployed: either the GCP environment is torn down"
              echo "(spec D17) or the Cloud Run service has not been created yet."
              echo
              echo "Rebuild with \`docs/runbooks/gcp-bootstrap.md\`, then create the service by"
              echo "hand — CD does not create it, because a new service's first revision serves"
              echo "100% of traffic immediately and cannot be verified first:"
              echo '```'
              echo "TAG=<tag> ./scripts/deploy-cloud-run.sh create"
              echo '```'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          [[ "$rc" -eq 0 ]] || exit "$rc"
          echo "present=true" >> "$GITHUB_OUTPUT"

      - name: Build the image
        if: steps.preflight.outputs.present == 'true'
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
          TAG: ${{ inputs.tag || github.sha }}
          VITE_AUTH0_DOMAIN: ${{ vars.VITE_AUTH0_DOMAIN }}
          VITE_AUTH0_CLIENT_ID: ${{ vars.VITE_AUTH0_CLIENT_ID }}
          VITE_AUTH0_AUDIENCE: ${{ vars.VITE_AUTH0_AUDIENCE }}
        run: ./scripts/deploy-cloud-run.sh build

      # Deploys a revision that receives NO traffic when the service already exists. Nothing a user
      # can reach changes until the verify step below has passed.
      - name: Deploy a candidate revision
        if: steps.preflight.outputs.present == 'true'
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
          TAG: ${{ inputs.tag || github.sha }}
        run: ./scripts/deploy-cloud-run.sh deploy

      # The gate. Five defects have reached this service and every one passed a fully green
      # verify.sh, so a revision is not trusted because it deployed.
      - name: Verify the candidate
        if: steps.preflight.outputs.present == 'true'
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
        run: ./scripts/deploy-cloud-run.sh verify

      - name: Promote it
        if: steps.preflight.outputs.present == 'true'
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
        run: ./scripts/deploy-cloud-run.sh promote

      # The candidate was verified through its tag URL. This re-runs the same assertions against
      # the URL users actually hit, after the traffic split moved — cheap, and it is the only thing
      # that observes the end state rather than an intermediate one.
      - name: Confirm the promoted service
        if: steps.preflight.outputs.present == 'true'
        env:
          PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
          REGION: ${{ vars.GCP_REGION }}
        run: |
          url="$(gcloud run services describe app --region="${REGION}" \
            --project="${PROJECT_ID}" --format='value(status.url)')"
          ./scripts/verify-deployment.sh all "$url"
          {
            echo "### Deployed"
            echo
            echo "- URL: $url"
            echo "- Image tag: \`${{ inputs.tag || github.sha }}\`"
            echo
            echo "**Not verified here**, and deliberately: that generated code actually runs, the"
            echo "cross-owner history 404, and the quota's 429. All three need an authenticated"
            echo "caller, and this pipeline holds no Auth0 credential. Run"
            echo "\`docs/runbooks/gcp-isolation-probes.md\` after any change that could touch them."
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 3: Update `docs/sdlc.md`**

`.github/workflows/**` is a watched path. Add a **Continuous deployment** section after
*How this meets CI/CD*, and delete the sentence *"There is no CD yet. Deployment is roadmap (GCP
Cloud Run); the release and observability phases arrive with it."* — it is no longer true, and a
stale line in the contract document is worse than none.

```markdown
## Continuous deployment

`Deploy` (`.github/workflows/deploy.yml`) builds and deploys the Cloud Run service on every push to
`main`, and on demand. It is **not a check**: it never runs on `pull_request`, it is not in the
"Protect main" ruleset, and it gates no merge.

It runs the same scripts a human runs — `scripts/deploy-cloud-run.sh` and
`scripts/verify-deployment.sh` — for the same reason CI runs `verify.sh`: one definition, two
callers, no drift. `docs/runbooks/gcp-deploy.md` explains why each flag exists; the script is what
executes.

Four details are load-bearing rather than stylistic:

- **A candidate revision receives no traffic until it has been verified.** `gcloud beta run deploy
  --no-traffic --tag=candidate`, then `verify-deployment.sh` against the tag URL, then
  `update-traffic --to-latest`. Five defects have reached this deployed service — #185, #188, #191,
  #195 and a rollback that reports failure after succeeding — and **every one passed a fully green
  `verify.sh`**. That is a fact about the gates, not about carelessness: a check that cannot fail
  the way production fails is not a gate. So the pipeline treats "the deploy command exited 0" as
  no evidence at all.
- **"Nothing is deployed" is a green no-op, not a failure.** The environment is destroyed between
  working sessions (spec D17), so the preflight exits **3** when the Terraform layer is absent and
  the job reports why and stops. A red X on every push during a torn-down week trains a reader to
  ignore the one that matters.
- **The trigger is `push`, never `workflow_run` on `CI`.** An auto-merged Dependabot PR produces no
  push-side CI run at all (see *Auto-merging dependency bumps*), so a `workflow_run` trigger would
  silently never fire for exactly the merges nobody watched.
- **What CD does not verify, it says out loud.** A real execution, the cross-owner 404 and the
  quota's 429 all need an authenticated caller. Holding an Auth0 machine-to-machine credential
  permanently in GitHub, for an endpoint that spends money, is a worse trade than leaving those to
  [`docs/runbooks/gcp-isolation-probes.md`](runbooks/gcp-isolation-probes.md) — which itself says to
  delete those applications when the probes are done. The job summary prints the gap on every run.

CD authenticates with the Phase 1 workload identity pool and **no service account**: roles are
granted directly to the `principalSet`, so there is no key anywhere (S9, P1-D4). The consequence
for teardown is in [`gcp-teardown.md`](runbooks/gcp-teardown.md) — a full `terraform destroy` at the
end of a session would soft-delete the pool and leave CD unable to authenticate for ~30 days, so the
between-sessions teardown is targeted at the billable resources only.

`deploy.yml` is **not** subject to the `verify.sh` mirroring rule: that rule binds gates, and this
gates nothing. Its scripts' unit tests do have a local equivalent and it is the same file CI runs —
`./scripts/tests/deploy-cloud-run.test.sh` and `./scripts/tests/verify-deployment.test.sh`, both
hosted by the `SDLC docs` job because `deploy.yml` itself never runs on a pull request.
```

- [ ] **Step 4: Say in the runbook that CI runs this too**

Under the paragraph PR 1 added above §1 of `docs/runbooks/gcp-deploy.md`:

```markdown
**CI runs the same script.** `.github/workflows/deploy.yml` calls these targets on every push to
`main`, so a deploy by hand and a deploy by pipeline produce the same revision shape. The one thing
the pipeline does that this runbook does not is deploy the revision with `--no-traffic --tag=candidate`
first, verify it, and only then move traffic — by hand you are looking at the output, and the
pipeline is not. Reach for this runbook when CD cannot run: no environment, a broken pipeline, or a
deploy from a branch other than `main` (the workload identity provider's attribute condition pins
`refs/heads/main`, so CD physically cannot deploy anything else).
```

- [ ] **Step 5: Verify and commit**

```bash
./scripts/tests/check-sdlc-sync.test.sh
git add .github/workflows/deploy.yml docs/sdlc.md docs/runbooks/gcp-deploy.md
git commit -m "feat(ci): continuous deployment via workload identity federation"
git push -u origin feat/cd-workflow
gh pr create --title "feat(ci): continuous deployment to Cloud Run" --body "Closes #201. …"
```

The workflow does not run on this pull request — it only runs on `push` to `main` — so the first
real execution is the merge itself. That is expected and is what PR 6 watches.

---

## PR 6 — exercise it, then write down what happened

Closes the sixth child issue. This is the Phase 2 lesson applied to Phase 3: the artefact that
matters is the record of what the pipeline actually did, not the pipeline.

### Task 6: Prove it, then close out

**Files:**
- Create: `docs/adr/0006-continuous-deployment-scope.md`
- Modify: `docs/runbooks/gcp-deploy.md`, `README.md`, `docs/plans/2026-08-17-deploy-to-gcp-phase3.md`

- [ ] **Step 1: Watch the first real run**

The merge of PR 5 is the first execution.

```bash
gh run watch "$(gh run list --workflow=Deploy --limit=1 --json databaseId --jq '.[0].databaseId')"
```

Record: whether `auth` succeeded on the first attempt (the attribute condition has never been
exercised by a real token — Phase 1 explicitly did not verify this), the build time against the
runbook's *"about two minutes"*, and whether the candidate URL was reachable.

- [ ] **Step 2: Prove the gate can refuse**

A pipeline whose gate has never refused anything is the decorative-assertion pattern with more
steps. Deploy a revision that verification must reject, by hand:

```bash
gcloud beta run deploy app \
  --image "us-central1-docker.pkg.dev/llm-code-exec-260815/app/app:$(git rev-parse HEAD)" \
  --region us-central1 --project llm-code-exec-260815 \
  --execution-environment gen2 --sandbox-launcher \
  --service-account app-runtime@llm-code-exec-260815.iam.gserviceaccount.com \
  --add-cloudsql-instances llm-code-exec-260815:us-central1:app-db \
  --set-env-vars SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,SANDBOX_MAX_CONCURRENT=4,FRONTEND_ORIGIN=https://app-530312723651.us-central1.run.app \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,OIDC_ISSUER=oidc-issuer:latest,OIDC_AUDIENCE=oidc-audience:latest,OIDC_JWKS_URL=oidc-jwks-url:latest \
  --cpu 2 --memory 2Gi --concurrency 4 --max-instances 2 \
  --network app-net --subnet app-subnet --vpc-egress private-ranges-only \
  --no-traffic --tag=candidate
```

The single difference from the real command is `--concurrency 4`, which spec D12 says makes the
sandbox concurrency cap unreachable — a control that reads as present and can never fire. Then:

```bash
./scripts/verify-deployment.sh shape "https://app-530312723651.us-central1.run.app"; echo "exit: $?"
```

Expected: `containerConcurrency: expected 8, got 4` and a non-zero exit. Then confirm the serving
revision never moved:

```bash
gcloud run services describe app --region=us-central1 --format="value(status.traffic)"
curl -s -o /dev/null -w '%{http_code}\n' https://app-530312723651.us-central1.run.app/api/health
```

Expected: 100% still on the previous revision, health `200`. **That is the claim this phase makes**
— record the output verbatim.

- [ ] **Step 3: Record the run in the deploy runbook**

Add a `### Recorded CD run — <date>` table to `docs/runbooks/gcp-deploy.md`, in the same shape as
the existing rollback drill: step, command, elapsed, outcome. Include the refusal from Step 2 and
whatever surprised you. Phase 2's outcome log is the model — the value is in what the plan did
**not** anticipate.

- [ ] **Step 4: Write ADR-0006**

Create `docs/adr/0006-continuous-deployment-scope.md`. Contents, in the repository's ADR shape
(Context / Decision / Alternatives considered / Consequences / Reversal):

- **Context:** ADR-0005 put the service outside Terraform and made a `gcloud` command its
  specification; Phase 2 shipped five defects that a fully green `verify.sh` could not have caught;
  the environment is destroyed between sessions. CD has to be designed around all three.
- **Decision:** CD deploys the application and never runs `terraform apply` (P3-D1); it reads no
  Terraform state (P3-D2); one script serves the human and CI (P3-D3); a candidate receives no
  traffic until verified, and promotion is `--to-latest` with the split read back (P3-D6); CD
  verifies only what needs no credentials, and prints what it does not verify (P3-D6); a torn-down
  environment is a green no-op (P3-D8).
- **Alternatives considered:** `terraform apply` from CI (rejected: needs the state bucket, which
  holds the database password in cleartext); deploy-then-roll-back instead of verify-then-promote
  (rejected: the rollback drill showed `update-traffic` exits non-zero after succeeding, so the
  recovery path is the one you least want on the critical path); an Auth0 M2M credential in GitHub
  so CD can run a real execution (rejected: a permanent third-party credential for an endpoint that
  spends money, when the probes runbook says to delete those applications after use); **building on
  Cloud Build rather than in the runner** (rejected under P3-D4 — write down that the security
  argument for it does not survive inspection, because it is the argument someone will re-propose);
  **letting CD create the service and delete it on a failed verification** (rejected under P3-D6).
- **Consequences:** an #185-class defect (nothing executes) is still only caught by a human running
  the probes runbook; the workflow is not a required check, so a red CD run blocks nothing; the
  session-end teardown is now targeted, so a rebuild is cheaper but "prove zero" applies only to the
  full teardown; the first deploy after every rebuild stays a human command, so CD is not a
  one-button recovery from a torn-down environment.
- **Consequences — the security one, which is the reason this ADR exists at all.** Before Phase 3,
  a commit on `main` still needed a human to run `gcloud` before it reached the public service.
  After it, **merging to `main` is production deploy authority**: the pipeline builds arbitrary
  repository content and deploys it running as `app-runtime`, which holds
  `secretmanager.secretAccessor` on all six secrets and `cloudsql.client`. Nothing about the grants
  changed — they pre-date this phase and the WIF attribute condition correctly pins
  `refs/heads/main` — what changed is *who can reach production without a human*. Record alongside
  it what the "Protect main" ruleset actually requires as of 2026-08-17:
  `required_approving_review_count: 0`, five required status checks, and
  `required_review_thread_resolution: true`. So a pull request that passes the checks with no
  unresolved Copilot comment deploys with **no human approval anywhere in the path**. That is a
  standing decision to write down, not a defect to fix in this PR — but it should be written down
  where the next reader will find it rather than left implicit.
- **Reversal:** if the Google provider ever models `sandboxLauncher` (ADR-0005's own reversal
  condition), the deploy script becomes a Terraform apply and most of this ADR goes with it.

- [ ] **Step 5: Update the README**

Two edits, both in sections a reader would otherwise be misled by:

In *Verification*, after the `SDLC docs` / `PR shape` paragraph:

```markdown
A fifth workflow, **`Deploy`**, is not a check either: on every push to `main` it builds the image,
deploys a Cloud Run revision that receives **no traffic**, asserts the deployed service's shape and
HTTP surface with `scripts/verify-deployment.sh`, and only then moves traffic to it. It
authenticates with Workload Identity Federation and holds no key. Two things it deliberately does
not do. It does not **create** the service: a new service's first revision takes 100% of traffic
immediately and so cannot be verified first, which makes the first deploy after a rebuild a human
command (`./scripts/deploy-cloud-run.sh create`). And it does not verify anything behind the auth
gate — a real execution, the cross-owner 404, the quota's 429 all need an authenticated caller, and
those stay in [`docs/runbooks/gcp-isolation-probes.md`](docs/runbooks/gcp-isolation-probes.md). The
job summary prints the gap on every run.
```

In *Roadmap*, replace *"the rollback drill (#163) is what remains"* with a line stating that Phases
0–3 have landed and what Phase 3 added.

- [ ] **Step 6: Close out the epic**

The Children list and the D18–D23 decisions were added to #79 and to the spec when the plan was
approved, so what remains here is the closing edit: add ADR-0006 to **Artifacts**, tick the six
children, and state explicitly that **S9 is now fully met** — CD performs the same steps as the
by-hand deploy, and no long-lived service-account key exists anywhere. Leave the still-open
governance question (`required_approving_review_count: 0`) named rather than silently dropped.

- [ ] **Step 7: Add the outcome log to this plan**

Append an `## Outcome log` section here recording plan-vs-applied differences, in the shape Phase 2
used. Then commit:

```bash
git add docs/adr/0006-continuous-deployment-scope.md docs/runbooks/gcp-deploy.md README.md \
        docs/plans/2026-08-17-deploy-to-gcp-phase3.md
git commit -m "docs(cd): record the first pipeline run, ADR-0006, and the epic close-out"
git push -u origin docs/cd-closeout
gh pr create --title "docs(cd): first pipeline run, ADR-0006, epic close-out" \
             --body "Closes #202. …"
```

---

## Definition of done for Phase 3

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S9 | **Closes here.** The by-hand deploy came first (Phase 2); CD performs the same steps by running the same script, and no long-lived service-account key exists — roles are granted to the federated principalSet directly (P1-D4). |
| S10 | Strengthened rather than re-proven: the rollback drill's two findings — check the split not the exit code, and never `--to-revisions` — are now assertions in `deploy-cloud-run.sh` instead of prose. |
| S11 | `scripts/**` and `.github/workflows/**` are watched paths, so every PR here updates `docs/sdlc.md`. The two new test suites run locally and in `SDLC docs` from the same file. |
| — | **Not a spec criterion, but the gap PR 4 closes:** an auto-merged Dependabot bump has never produced a push-side `CI` run on `main`. After PR 4 it produces both `CI` and `Deploy`, so no merge path is unverified. |

**Not claimed.** S1–S6, S8 and S12 closed in Phases 1–2. S7's *zero billable resources* half still
closes at the day-91 teardown, and P3-D7 narrows the between-sessions teardown without touching
that claim.

## Explicitly out of scope

- **Fixing #195.** It is open and undecided, and this plan neither fixes it nor assumes it fixed.
  CD cannot detect its class of failure at all (P3-D6), which is a reason to keep the probes
  runbook, not a reason to widen this phase.
- **Putting the Cloud Run service in Terraform.** ADR-0005; the reversal condition is upstream.
- **`terraform plan` in CI.** A real design question, and a different one: it needs credentials
  against a live project and a decision about what a plan on a torn-down environment means.
- **A merge queue, environments with required reviewers, or a staging service.** One user reaching
  the app is still the bar.
- **Narrowing `roles/run.admin`.** `infra/wif.tf` already records why it cannot be: creating a
  service is a project-level permission and the service does not survive teardown.

---

## Plan review log

Staff-engineer review 2026-08-17 — **applied without asking** (mechanical; each verified against the
codebase or a live command before transcribing):

- **PR 1 Task 1 Step 1 and PR 2 Task 2 Step 1** — `bad()` ended in `[[ -n "${2:-}" ]] && printf …`,
  which returns 1 on a single-argument call. `bad` is called from inside a `then` branch, which is
  **not** exempt from errexit, so the suite would die on its first one-argument failure and never
  print the summary. Reproduced on `/bin/bash` 3.2.57 here: exit 1, no summary line. Both now use an
  explicit `if`, with the reason in a comment. (`infra/tests/bootstrap.test.sh` has the same shape
  and escapes it only because every call there passes two non-empty arguments.)
- **PR 1 Task 1, new Step 5a** — nothing ran the script against the live service, so `promote()`'s
  `status.traffic` readback was only ever exercised against a hand-written fixture; a wrong
  assumption there would surface as a red first run on `main`. Added a step that runs `preflight`
  and `promote` against the live service, mirroring PR 2's Step 5.
- **PR 3, new Step 2a** — `infra/terraform.tfvars` is gitignored and `scripts/worktree-new.sh` does
  not link it (verified: it handles `.env.shared`, `.claude/settings.local.json`, `.env` and
  `frontend/.env.local` only), so every Terraform command in this PR would fail in the worktree
  `CLAUDE.md` requires with *"No value for required variable"*. Added the `cp` step.
- **PR 3 Step 4** — "exactly four project-level roles" was wrong; there are **three**.
  `gcloud projects get-iam-policy` returns the project policy only, and four of the seven grants are
  resource-scoped by design (P1-D5). Corrected the count, named the three, and added the four
  per-resource `get-iam-policy` commands.
- **PR 3 Step 5** — the runbook edit was incomplete: *Two different teardowns* still said "run steps
  1 and 2 only" and §2's first block is an unlabelled `terraform destroy`, so a reader going top to
  bottom would destroy the WIF pool before reaching the new prose — the exact failure P3-D7 exists to
  prevent. The step is now three explicit edits, with the targeted block placed **before** the full
  destroy and the full destroy given its own heading.
- **PR 3 Step 6** — "redeploy with PR 1's script" contradicted the header's claim that PRs 1–3 are
  independent. Now names the by-hand runbook path first, with the script as the "if PR 1 landed"
  option.
- **PR 1 Step 7 and PR 2 Step 7** — `docs/sdlc.md:334` ("A third suite … is run by `SDLC docs`")
  becomes false once either PR adds a lodger suite. Both steps now carry the edit to that paragraph.
- **File Structure table** — `infra/wif.tf` said "three new grants"; the HCL adds four
  (`ci_build_submitter`, `ci_act_as_build`, `ci_build_source_writer`, `ci_log_viewer`) plus the
  custom role, which is why Step 3 expects "5 to add".

**Escalated to the user** — seven judgment findings and ten advisory recommendations. All seven were
decided on 2026-08-17 and are recorded below; they become **D18–D23** in
[the spec](../specs/2026-08-09-deploy-to-gcp.md), which is where decisions live.

### Judgment findings decided 2026-08-17

| # | Finding | Decision | Where it landed |
| --- | --- | --- | --- |
| 1 | `push` has the same Dependabot blind spot as `workflow_run`, and the plan's justification was inverted | **Fix it at the source.** The auto-merge moves to a GitHub App token so its merges fire workflows like any other. Not a schedule sweep, not a PAT. | New **P3-D11**, new **PR 4**, rewritten **P3-D8** |
| 2 | Cloud Build vs. building in the runner | **Build in the runner.** The security argument for Cloud Build does not survive inspection — the federated principal already holds `artifactregistry.writer` and can push and deploy regardless. `gcloud builds submit` stays as `build:remote` for Apple Silicon. | Rewritten **P3-D4**; `build` / `build:remote` targets; PR 3 loses three grants |
| 3 | The create path deploys unverified code to 100% of the public URL | **CD refuses to create the service.** `preflight` requires it to exist; creating it is the by-hand `create` target (spec D4/S9). `workflow_dispatch` stops being a rebuild button. | **P3-D6** extended; `create` target; preflight stage 3 |
| 4 | `preflight` reported credential and permission failures as "environment torn down", green | **Two-stage probe.** `gcloud projects describe` proves the credential and exits **1** on failure; only then does the registry probe decide. Not stderr pattern-matching. | **P3-D8** extended; preflight stages 1–2 |
| 5 | The log check was service-scoped, so the old revision could veto a good candidate | **Revision-scoped before promotion, service-scoped after.** `REVISION` is set for the candidate call and empty for the confirmation. The misleading comment is corrected. | `logs()` in PR 2; `verify()` in PR 1 |
| 6 | ADR-0006 omitted that merging `main` becomes production deploy authority | **Record it**, together with what the ruleset actually requires — verified as `required_approving_review_count: 0`. Whether to change that setting is a separate, still-open question. | PR 6 Step 4, Consequences |
| 7 | `roles/storage.objectUser` may not carry `storage.buckets.get`, and nothing could test it pre-merge | **Moot.** Confirmed the role has no `storage.buckets.*` permission at all — and finding 2 removes the grant entirely. | Deleted along with the Cloud Build grants |

Advisory items applied while making the above edits, because the surrounding code was being
rewritten anyway: `persist-credentials: false` on the checkout, an explicit `version:` on
`setup-gcloud` (the runner's apt gcloud disables the component manager, so `install_components:
beta` fails without it), and the corrected exit contract in the script header. The rest are noted
for the PR that touches the relevant file.

**Still open, deliberately:** whether "Protect main" should require an approving review now that it
gates deploys and not just merges. Not a blocker for this plan.
