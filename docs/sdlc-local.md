# This repository's process specifics

[`sdlc.md`](sdlc.md) is the shared process — the part `acb` carries into every repository that
uses it, byte-identical. This file is the other half: what *this* repository does that the shared
document deliberately does not know about.

**It is the contract the `SDLC docs` gate enforces.** A pull request that changes
`.claude/skills/**`, any component's `verify.sh`, `infra/tests/**`, `.github/workflows/**` or
anything in `scripts/` must update this file in the same pull request. The watched list is
`process.watched` in [`.acb.json`](../.acb.json), read at run time.

Why this file and not `sdlc.md`: `sdlc.md` is a **carried** file, byte-identical in every consumer
of `acb`. Requiring an edit to it on every local process change would make this repository
permanently *ahead* of the toolkit, and `acb pull` would revert the edit on its next run. The
shared half is not the document a change to `backend/verify.sh` invalidates; this one is.

## Changing this SDLC

**The rule:** a PR that touches any of

- `.claude/skills/**`
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


## Tests: the oracle must not come from the implementation

The rules are in [`../CLAUDE.md`](../CLAUDE.md) under *Testing standards*; the reasoning and the
three legal oracle sources are in [`testing-notes.md`](testing-notes.md). Neither is restated here —
this section is only **where they bind in the process**, which is the part specific to this
repository.

| Phase | What it adds |
| --- | --- |
| **Spec** | Success criteria written as observable behaviour. "The quota resets at the window boundary" is an oracle; "the quota works correctly" is not |
| **Plan** | Every task that writes a test names the oracle it asserts. "Matches the implementation" is not an acceptable answer |
| **Build — RED** | The failure is recorded in the PR body, not claimed |
| **Build — threat model** | For each threat on a *Sensitive path*, ask whether it is expressible as a planted hole; if so, author it as a committed fixture alongside `backend/tests/mutants.ts` |
| **Review** | The three questions in `CLAUDE.md`'s *Review process* |
| **After a defect reaches `main`** | Append a row to [`escaped-defects.md`](escaped-defects.md) naming the gate that missed it |

**The last row is the one that gets skipped**, because it happens after the work feels finished.
It is also the only one that produces evidence over time: without it ADR 0006's calibration loop
never runs, and the log stays at its four seeded entries forever.

**Two things are deliberately not enforced by CI.** RED-recording, because a check for the presence
of a PR-body section cannot read what it checks. And the named-oracle requirement in Plan: the
staff-engineer reviewer prompt is carried from `acb` and says nothing about oracles, so **this is a
convention the human review upholds, not a gate** — do not write it up as one until the prompt is
proposed upstream.

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

**Concurrency is chosen from the scope, by an allowlist.** Stryker forks N vitest processes against
the one CI Postgres, and the Postgres suites share a schema, so a collision produces a spurious
failure — which *kills* a mutant and makes the gate pass for the wrong reason. Anything not provably
datastore-free (`auth.ts`, `schemas.ts`, `sandbox/`) runs single-worker. An allowlist rather than a
denylist because a denylist fails open on the next file nobody thought about.

**The backend job checks out with `fetch-depth: 0`.** Without a merge base there is nothing to diff,
and `scripts/mutation-scope.sh` hard-fails rather than reporting an empty scope — the likeliest way
this gate would silently check nothing.

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

Required, not merely present: `SDLC docs` **is** a required check, so hosting these in a job that
was not would silently downgrade gating that already existed. The ruleset entry is added *the
moment this job lands on `main`* and not in the pull request that creates it — a required check
whose job does not yet exist on the default branch blocks every merge, including its own. `Terraform checks` is wrong by
subject and `Backend checks` already means something else, which is why it is a sixth name rather
than a third home.

**No `paths:` filter, deliberately.** A workflow-level path filter on a required check makes it
never report at all, which hangs every merge forever — the same trap `.github/workflows/terraform.yml`
carries a comment about. Both suites drive fakes on `PATH` and run in seconds; they run on
everything.

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
