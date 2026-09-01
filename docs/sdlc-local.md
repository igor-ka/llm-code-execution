# This repository's process specifics

[`sdlc.md`](sdlc.md) is the shared process — the part `acb` carries into every repository that
uses it, byte-identical. This file is the other half: what *this* repository does that the shared
document deliberately does not know about.

**It is the contract the `SDLC docs` gate enforces.** A pull request that changes
`.claude/skills/**`, `.claude/commands/**`, any component's `verify.sh`, `infra/tests/**`,
`.github/workflows/**` or anything in `scripts/` must update this file in the same pull request. The watched list is
`process.watched` in [`.acb.json`](../.acb.json), read at run time.

Why this file and not `sdlc.md`: `sdlc.md` is a **carried** file, byte-identical in every consumer
of `acb`. Requiring an edit to it on every local process change would make this repository
permanently *ahead* of the toolkit, and `acb pull` would revert the edit on its next run. The
shared half is not the document a change to `backend/verify.sh` invalidates; this one is.

## Changing this SDLC

**The rule:** a PR that touches any of

- `.claude/skills/**`
- `.claude/commands/**` — carried, like the skills. `/loop-plan` is the only entry today: it works
  a plan to the criteria its `## Criteria coverage` table claims, reads progress from the tracker
  rather than the plan, and merges nothing unless you say so in that run, about that pull request.
  `acb status` reports a carried tree that is missing from the list below, which is how this entry
  came to exist.

  **Do not run it under `/loop` here yet.** Its tick record — the six-tick ceiling, which the
  command itself calls the only external stop the loop has — lives in a comment on a public issue,
  and [`igor-ka/acb#19`](https://github.com/igor-ka/acb/issues/19) is open on exactly that. Six
  review rounds have hardened the reads; none has moved the state somewhere a commenter cannot
  write it. That matters here specifically because `Protect main` sets
  `required_approving_review_count: 0`, so one authorising sentence can cover every pull request a
  plan produces and the ceiling is the only thing bounding it. Merge one pull request at a time
  until that issue closes.
- `.acb.json` — it holds the watched list, both escape hatches, the process-document path and
  every component's check name. Those semantics used to live in `scripts/`, which is why that
  directory is watched; they moved here, so this is watched too.
- `.github/ruleset.json` — the required-check names in prose below are enumerated by hand, and
  nothing else would notice them going stale
- `.mutation-scope.json` — it declares which files the mutation gate covers; narrowing it narrows
  the gate, and nothing else would notice
- `backend/verify.sh`, `frontend/verify.sh` or `infra/verify.sh`
- `infra/tests/**` — the self-tests `infra/verify.sh` runs first: the gates, and `bootstrap.sh`
  against a fake `gcloud` (a live run proves the script worked that day, not that the next edit is safe)
- `.github/workflows/**`
- `scripts/**`

must also touch this file.

The production-image assertions in `backend/verify.sh` also require a `python3` interpreter in
the image, because a Cloud Run sandbox executes against the application image's own filesystem.
That assertion names the interpreter by its **absolute** path, `/usr/bin/python3`, and must keep
doing so: a Cloud Run sandbox inherits no environment, so `PATH` inside it is empty and a bare
command name resolves against nothing. A `python3` or `command -v python3` check runs in a shell
that *has* a `PATH`, passes, and proves only that the packaging is right — which is how #185
reached a deployed service through a fully green gate. A check that cannot fail the way
production fails is not a gate.

## The three components

**Not a skill — a script.** Each component has one `verify.sh` that is the single source of truth,
and **CI runs the same script**, so local and CI cannot drift.

```bash
cd backend  && ./verify.sh     # npm audit, eslint, prettier, tsc, vitest, build, three images
cd frontend && ./verify.sh     # npm audit, eslint, prettier, vitest, tsc -b && vite build, one image
cd infra    && ./verify.sh     # gate self-tests, terraform fmt/init/validate, the repo-specific gates
```

The backend `package` target builds **three** images: the dev backend image, the sandbox image,
and the repo-root `Dockerfile` — the production artifact that serves the SPA and the API from
one origin with no Docker socket. It then asserts inside that image that the production CSP
shipped, that the policy contains no plaintext origin (which is how an image built without the
same-origin API base shows up), and that the runtime user is not root. **A consequence worth
stating: `Backend checks` now builds the frontend too**, so a frontend-only regression fails the
backend job and that job is slower. That is the price of building the deployable artifact on
every PR.

The frontend `build` target also asserts that `dist/csp.txt` exists and carries a production
`script-src`. That gate is not decoration: the Content-Security-Policy used to be attached only
by the Vite dev and preview servers, so a static deploy of `dist/` shipped with **no CSP at
all** — and a unit test on the policy builder cannot catch "the server forgot the header".
The build emits the policy as data and the backend serves the SPA under it.

Individual targets exist for the inner loop: `install`, `audit`, `lint`, `format`, `test`, `build`,
`package`, plus `migrate` and `test:integration` on the backend. `SKIP_INSTALL=1` and
`SKIP_PACKAGE=1` speed up iteration — but the pre-push run should be unskipped, because CI does
not skip.

> **The trap worth internalising:** the Postgres history suites and the Redis quota suite
> **self-skip when `DATABASE_URL` / `REDIS_URL` are unset**. A green `./verify.sh` is *not*
> evidence they ran. Touching `src/history/**`, `migrations/**`, or `src/limits/**` means
> running `DATABASE_URL=… REDIS_URL=… ./verify.sh test:integration` explicitly. The gate now
> runs when *either* variable is set and prints which half is self-skipping — a partial run is
> better than none, but it is not full coverage.


## Tests: what the oracle rule adds here

The rule itself now lives **upstream**, in the carried [`sdlc.md`](sdlc.md) under *The oracle must
not come from the implementation* — the three legal oracle sources, the four rules, RED-is-recorded,
assert-both-directions, and the three review questions. It was proposed from this repository
(`acb propose docs/sdlc.md`) once it had been proven here, so every consumer gets it. Nothing generic
is restated below.

What is specific to this repository:

| Phase | What it adds here |
| --- | --- |
| **Build — threat model** | For each threat on a *Sensitive path*, ask whether it is expressible as a planted hole; if so, author it as a committed fixture alongside `backend/tests/mutants.ts` and `historyMutants.ts` |
| **Build — REFACTOR** | `./verify.sh mutation` on the lines just touched; survivors are the assertions not yet written |
| **Review** | The three questions apply to `frontend/src/**` too, where the process boundary is `fetch` and the Auth0 SDK rather than a socket |
| **After a defect reaches `main`** | Append a row to [`escaped-defects.md`](escaped-defects.md) naming the gate that missed it |

**The last row is the one that gets skipped**, because it happens after the work feels finished. It
is also the only one that produces evidence over time: without it ADR 0006's calibration loop never
runs, and the log stays at its four seeded entries forever.

**None of the upstream rule is a gate here.** `./verify.sh mutation` enforces *sensitivity* —
whether a test can fail at all — which is the half the rule itself says a tool can check. The half
it cannot check has nothing behind it. "Name the oracle" in Plan is upheld by the human review: the
staff-engineer reviewer prompt is carried from `acb` and says nothing about oracles, so do not write
it up as enforced until that prompt is proposed upstream too. The same goes for RED-recording,
"never edit an existing test to make it pass", "mock only at process boundaries" and the three
review questions — [`../CLAUDE.md`](../CLAUDE.md) gives the reason the first cannot be a check, and
that reason generalises. **A green build is not evidence that any of them held.**

## The audit flags, and why they are written out

- **The `Audit` step fails on high and critical advisories only.** `npm audit --audit-level=high`,
  the same command locally and in CI. Moderate and below stay visible in the output and are
  Dependabot's job; blocking every merge on a moderate transitive advisory buys noise rather than
  safety. It reads the lockfile, so `SKIP_INSTALL=1` does not weaken it.

  **Two flags close environment-driven bypasses, and both were found by review rather than by the
  gate noticing.** `--no-offline`, because `npm_config_offline=true` otherwise makes `npm audit`
  report "found 0 vulnerabilities" and exit 0. `--include=dev`, because `npm audit` honours the
  `omit` config and both `npm_config_omit=dev` and `NODE_ENV=production` set it, silently dropping
  every dev-dependency advisory — the scope this gate claims. Counting the `|| true` rejected at
  design time, that is three bypasses of one class: `npm audit` is configurable from the
  environment in several ways, and all of them fail **open**. State the intent in flags rather
  than inheriting whatever the environment says. Scope is every dependency, dev included: neither image ships
  devDependencies, but they execute in CI. It runs FIRST in `all`, before `npm ci`: that command
  executes dependency lifecycle scripts, so auditing afterwards would let a package with a known
  install-time vulnerability run before the gate could reject it. The cost is that a registry
  outage aborts the pass before the offline checks — reach for a single target then.

  It is a **hard fail, not `|| true`**. A check that cannot fail is the decorative-assertion
  pattern this repo has already shipped once and had to fix — it reads as coverage and provides
  none. When a high advisory lands with no upstream patch, the honest response is an explicit,
  dated exception in the `audit()` function, where review can see it; not a permanently green
  check. The threshold is a judgment call, so it is written down here rather than left in a flag.
- **Postgres and Redis run as service containers**, and only the `Integration test` step sets
  `DATABASE_URL` / `REDIS_URL` — which is exactly why the service-free `Test` step still skips
  those suites.

## The mutation gate

`./verify.sh mutation` mutates only the lines the branch changes against `origin/main` and **fails
on any mutant that survived or that no test covered**. The second half is why it also catches "this
PR added a line nothing executes". Run it at the REFACTOR step: survivors are the assertions you
have not written yet, and they cost two minutes while the code is still in your head. CI runs the
identical target as a backstop, so if the workflow is working CI never finds a survivor.

The eligible set is declared in [`../.mutation-scope.json`](../.mutation-scope.json) — not counted
here, because a line count in prose goes stale the first time a file is added. That file is watched
by the `SDLC docs` gate for the same reason `.acb.json` is: narrowing it narrows the gate.

**The gate blocks everywhere, and the first PR into a weak file pays the tax.** A spike on
2026-08-31 measured the datastore-free half of the eligible set at **52%** — `dockerBackend.ts` at
11%, with 73 of its 133 mutants uncovered. Narrowing the set to the files that already sustain the
gate was considered and rejected: it would exempt exactly the code that most needs it. Kill the
mutants, or suppress with a stated reason.

An unkillable mutant — an **equivalent mutant**, whose edit cannot change observable behaviour — is
suppressed inline with `// Stryker disable next-line <mutator>: <reason>`. The reason is mandatory
and `scripts/mutation-suppressions.sh` rejects a bare one, on the same principle as the dated
exception the audit flags demand.

**It requires both datastores, and in CI it cannot run without them.** `MUTATION_REQUIRE_FULL=1`
makes a missing `DATABASE_URL` or `REDIS_URL` a hard failure rather than a partial run: the suites
covering `pgStore.ts`, `migrate.ts` and `redisQuota.ts` self-skip without those variables — see
[`testing-notes.md`](testing-notes.md) — so a DB-free run would report every mutant in them as a
survivor. That is not incomplete output, it is wrong output.

**It runs single-worker whenever a datastore is configured.** Stryker forks N vitest processes at
the one CI Postgres, and the Postgres suites share a schema, so a collision produces a spurious
failure — which *kills* a mutant and makes the gate pass for the wrong reason, indistinguishable
from a real kill. An earlier version allowlisted `auth.ts`, `schemas.ts` and `sandbox/` as provably
datastore-free; review showed that was a category error, because the allowlist named *source* files
while the hazard is which *tests* run — `schemas.ts` is imported by `server.ts`, which
`isolation.test.ts` drives while holding a real Postgres pool. Proving a file datastore-free means
proving a negative about the whole coverage graph, and getting it wrong fails open. Serializing cost
8 seconds on a measured two-line change, so the trade is not close.

**The backend job checks out with `fetch-depth: 0`.** Without a merge base there is nothing to diff,
and `scripts/mutation-scope.sh` hard-fails rather than reporting an empty scope — the likeliest way
this gate would silently check nothing.

**The self-test resolves Stryker by path, and that is not a style choice.** It runs
`backend/node_modules/.bin/stryker` explicitly and refuses to start if that file is missing. The
obvious `npx --prefix backend stryker run` does **not** fail when the local install is stale or
absent — npx downloads the deprecated standalone `stryker` package from the registry and runs
*that*, which dies with `MODULE_NOT_FOUND` and writes no report. Observed on a worktree whose
`node_modules` predated the merge that added Stryker. A gate self-test that can be satisfied by a
different program than the one under test is worse than no self-test at all, so it fails loudly and
tells you to run `npm ci`.

`mutation:selftest` is a separate target because it runs Stryker twice against a deliberately weak
fixture to prove the gate can still fail. That belongs before a push and in CI, not in the inner
loop. Neither target is in `all`: both need a merge base that a detached checkout may not have.

## The deployment scripts

`scripts/deploy-cloud-run.sh` is the other piece of tooling here that is not a CI check. It holds
the `gcloud beta run deploy` command that
[ADR-0005](adr/0005-cloud-run-service-outside-terraform.md) makes the Cloud Run service's
*specification* — the provider does not model `sandboxLauncher` and strips it on every apply, so the
service is deployed by this command rather than by Terraform. A human runs it from
[`docs/runbooks/gcp-deploy.md`](runbooks/gcp-deploy.md); the deploy workflow will run the same
targets. That is the same "one definition, two callers" contract the `verify.sh` scripts have, and
it is why the command is not written out twice.

Three things about it are process rather than implementation, which is why they are here:

- **It reads no Terraform state, ever.** State holds the generated Cloud SQL password in cleartext,
  so a pipeline that could read it would hold the database password. Every project-specific value is
  instead derived from the resource names Terraform itself uses, which means a rename in `infra/`
  breaks the deploy loudly on the next run rather than silently.
- **Its exit codes are an interface.** `0` success, `3` nothing to deploy — the environment is torn
  down between working sessions, or the service does not exist yet — `2` a usage error, `1`
  everything else *including a credential that does not work*. That last distinction is the point:
  a probe that reported a bad token as "torn down" would finish green. Two consequences follow, and
  both are enforced rather than intended. The existence probe is `gcloud run services list
  --filter`, not `describe`, because list exits 0-with-no-output for a missing service and non-zero
  only for a real failure, while `describe` fails identically for "missing" and "permission
  denied". And a child process's exit status is **normalised to 1** — the verification script has
  its own exit vocabulary, and passing its `3` straight through would tell the workflow there was
  nothing to deploy.
- **"Is there an environment?" asks about the DATA LAYER, not the registry.** The between-sessions
  teardown is a targeted destroy of the billable resources only, so the Artifact Registry
  repository, the service accounts and the secret containers all survive it — their presence proves
  nothing. The probe is the Cloud SQL instance, which that teardown does remove and without which
  the service cannot work. A change to what the session-end teardown destroys is therefore a change
  to this script's premise, which is why both live in this document.
- **The default target is `help`, not `all`.** Every other target changes production, so the thing
  that happens when someone types the script's name to see what it does must not be a deploy.
- **It will not create the service.** Cloud Run gives a brand-new service's first revision 100% of
  traffic, so it cannot be verified before users reach it. Creating the service is a separate
  `create` target, run by hand after a rebuild; automation only ever deploys a revision that serves
  nobody until it has been checked.

`scripts/verify-deployment.sh` is its companion, and the answer to a question the deploy script
cannot answer for itself: what does a pipeline owe beyond "the command exited 0"? It reads the
deployed service back from the API and asserts its shape against the deploy runbook's flag list —
`sandboxLauncher`, gen2, the VPC interfaces, the Cloud SQL instance, the runtime identity,
concurrency 8, `FRONTEND_ORIGIN` equal to the service URL, all six secret bindings — then checks the
endpoints an anonymous caller can reach and the application's own log window.

Two limits are written into it rather than left for a reader to discover. Nothing behind the auth
gate is covered: a real execution, the cross-owner 404 and the quota's 429 all need an authenticated
caller, and [`gcp-isolation-probes.md`](runbooks/gcp-isolation-probes.md) stays the authority for
those. And **an empty log window is weak evidence**, because Cloud Logging ingestion is asynchronous
and empty is exactly what the check treats as a pass — a settle wait buys some of that back without
making silence proof.

Its unit tests, `scripts/tests/deploy-cloud-run.test.sh` and
`scripts/tests/verify-deployment.test.sh`, drive their scripts against fake `gcloud`, `docker`,
`curl` and verifier executables on `PATH` — no project, no credentials, no network. They run in the
**`Deploy scripts`** job (see the last section of this document), and **the same files are the
local pre-push commands**: run `./scripts/tests/deploy-cloud-run.test.sh` and
`./scripts/tests/verify-deployment.test.sh` before pushing, because no `verify.sh` covers them —
all three components will stay green while that job goes red.

One consequence of that tooling reaches the `verify.sh` scripts. Docker image tags are
daemon-wide, and `backend/verify.sh`'s `package` target *builds* a tag and then *runs* it. With two
worktrees verifying at once a fixed `…:verify` tag lets one tree's assertions execute the other
tree's image — a pass or fail belonging to a different branch. `backend/verify.sh` and
`frontend/verify.sh` therefore derive their throwaway tags from the checkout's directory name
(`verify-<dirname truncated>-<cksum of the full path>` — the basename alone is neither unique, since
a worktree may share it with the main checkout, nor bounded against Docker's 128-character tag
limit), which is unique per worktree and deterministic in CI. `infra/verify.sh`
needs no equivalent: it builds no image.

## Worktrees

`scripts/` also holds **developer tooling that is not a CI check**: `scripts/worktree-new.sh`
creates a git worktree with its own application stack. The watched-path rule covers it too, and
that is the right outcome rather than an accident — the stack-slot contract it encodes (which
ports a slot owns, and the Auth0 origins that bound the pool) is process. A change to it that
skipped the docs would leave `README.md`'s slot table and `backend/src/config.ts`'s
`stackSlotWarnings()` describing a scheme the script no longer implements.

Its unit tests, `scripts/tests/worktree-new.test.sh`, run **locally only** — CI never creates a
worktree, so there is nothing there for them to protect. That is why they are absent from the two
jobs named above, and why they are **not** an exception to the `verify.sh` mirroring rule: there
is no CI check to mirror. Run them before pushing a change to the script.


The stack-slot contract those paragraphs encode is this repository's own: **the pool is four
slots** (the main checkout plus three), bounded by the frontend origins registered in the Auth0
SPA, whose allowed-origins list is exact-match. Each slot owns its own ports for all four
services, and `scripts/worktree-new.sh` links the gitignored files a worktree cannot inherit —
`.env.shared` (the API key), `frontend/.env.local` (Auth0), and `.claude/settings.local.json`
(the permission allowlist, whose absence makes a fresh session re-prompt for everything already
granted). See *Parallel worktrees* in [`../README.md`](../README.md) for the slot table.

## `Deploy scripts` — the sixth required check

`scripts/tests/deploy-cloud-run.test.sh` and `scripts/tests/verify-deployment.test.sh` used to
lodge in the `SDLC docs` job. The carried copy of that workflow does not host them — it cannot,
because it knows nothing about Cloud Run — so they get their own workflow and their own required
check.

**Read the name as "repo-root script tests".** The job has outgrown it: it also runs
`apply-ruleset.test.sh` (branch protection) and the three mutation-gate suites
(`mutation-scope`, `mutation-decide`, `mutation-suppressions`), none of which is a deploy. The name
is a ruleset contract, so it stays; what unites the job is *scripts in `scripts/` that no
component's `verify.sh` owns and no other workflow runs*.

The mutation suites were briefly reached only through `backend/verify.sh mutation`, which was the
wrong owner twice over: it coupled a backend-component gate to repo-root tooling, and because that
target sits outside `all` and is gated on `pull_request`, a change to `scripts/mutation-scope.sh`
landing on `main` was never re-tested. `mutation-gate.test.sh` stays behind in
`./verify.sh mutation:selftest` — it drives a real Stryker and needs `backend/node_modules`, which
this job does not install.

Required, not merely present: `SDLC docs` **is** a required check, so hosting these in a job that
was not would silently downgrade gating that already existed. The ruleset entry is added *the
moment this job lands on `main`* and not in the pull request that creates it — a required check
whose job does not yet exist on the default branch blocks every merge, including its own. `Terraform checks` is wrong by
subject and `Backend checks` already means something else, which is why it is a sixth name rather
than a third home.

**No `paths:` filter, deliberately.** A workflow-level path filter on a required check makes it
never report at all, which hangs every merge forever — the same trap `.github/workflows/terraform.yml`
carries a comment about. Every suite in the job drives fakes on `PATH` or a throwaway git
repository and runs in seconds; they run on everything.

## Branch protection is a document

`.github/ruleset.json` is the "Protect main" ruleset written down, and `scripts/apply-ruleset.sh`
is what puts it into effect:

```bash
GITHUB_REPOSITORY=igor-ka/llm-code-execution ./scripts/apply-ruleset.sh
```

Branch protection is API state rather than a file, so shipping the checks without the enforcement
would contradict this process's own maxim — an instruction is a request, a check is a guarantee —
at exactly the moment of installation.

**The live ruleset is the reference, not the document.** The document was generated once and is
this repository's own thereafter; when the two disagree, read the live one first and find out why.
The demonstrable reason for that ordering is `Deploy scripts`: `acb`'s renderer emits the two
process checks plus one per component, so regenerating this file would produce a five-check
document and silently stop gating the sixth. A generated file is the consumer's own precisely
because the generator cannot know everything about it.

**`copilot_code_review` was removed on 2026-09-01, at the repository owner's decision, because it
advertised a review that had stopped happening.** The rule was added 2026-08-09 and removed
2026-09-01 — 22 days, not the life of the ruleset, which was created 2026-05-29 with four rules.
Copilot reviewed human-authored pull requests between #71 and #203; its last review anywhere was
submitted 2026-08-17T19:22Z. Every pull request from #204 onward has none, unbroken. The stated
cause is a lapsed organisation membership carrying the entitlement; that is the owner's account,
not something this repository can verify.

**What it was, and was not.** It requested a Copilot review automatically; it was not a merge gate.
GitHub does not evaluate it in the ruleset's rule suites — #234's merge, made while the rule was
live, records five rule evaluations and not this one. `bypass_actors` has been empty and
`current_user_can_bypass` `never` in all eight versions of the ruleset, and no bypass has ever been
recorded. Dependabot pull requests #116 and #146 were auto-merged by `app/github-actions` with the
rule live and no Copilot review at all, which an app could not have done through a block. So the
earlier claim in this file — that merges after 08-17 were manual overrides — was wrong, and is
withdrawn.

**One observation that does not fit, recorded rather than explained.** On 2026-09-01,
`gh pr merge 243 --squash` was refused with *"the base branch policy prohibits the merge"* while all
six required checks were green; removing this rule was the only change made, and the merge then
succeeded. Why that pull request was blocked when #204–#241 were not is unexplained. Do not read
the removal as the fix for a block: it was removed because it promised a review nobody was
receiving.

**What actually lapsed is a real control, and it was already narrower than the carried document
says.** `required_review_thread_resolution` is `true`, so unresolved review threads do block a
merge — while Copilot reviewed, its threads had to be answered. That protection ended on
2026-08-17, when the reviews stopped, not when this rule was removed. But
[`sdlc.md`](sdlc.md)'s auto-merge section still says *"Copilot reviews every PR including
Dependabot's, so a single inline comment parks the merge"*, and that was never true of Dependabot
pull requests — #116 and #146 above merged with no review while the rule was live. It is the stated
safety argument for #94's *parked counts as passing*, and today nothing parks a Dependabot
auto-merge at all: 17 are open. `sdlc.md` is carried and cannot be corrected here, which is what
this file is for.

**If the entitlement returns**, restore the rule — and verify a review actually appears on a real
pull request before relying on it. The rule being present is exactly what made its silence
invisible for two weeks.

**Which is why `--apply` is opt-in and the diff is the default.** Running
`scripts/apply-ruleset.sh` with no arguments prints live-versus-document and writes nothing.
`scripts/tests/apply-ruleset.test.sh` covers it, hosted by the `Deploy scripts` job.

**Two things nothing checks, stated plainly rather than implied.** `acb status`'s drift check
compares the *document* against the job names in `.github/workflows/` — not the document against
the live ruleset. And nothing in CI runs it: no workflow and no `verify.sh` invokes `acb`. So the
document can drift from live — a UI edit, a partial apply — and this repository stays green while
its branch protection no longer matches the file describing it. Reading the diff before `--apply`
is the control, and it is an instruction rather than a guarantee. A CI check would need a token
that can read rulesets, which the read-only `SDLC docs` job deliberately does not have.

Six checks are required today: `Backend checks`, `Frontend checks`, `Terraform checks`,
`SDLC docs`, `PR shape` and `Deploy scripts`. Adding a seventh means adding the job first, merging
it, and only then adding the name — a required check whose job does not yet exist on `main` blocks
everything, including the pull request that would create it.
