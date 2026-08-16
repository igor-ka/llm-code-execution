# Software development lifecycle

How a change gets from an idea to `main` in this repository, and which skill governs each step.

This document is a **contract**. If you change the development process — the skills in
`.claude/skills/`, any of the three `verify.sh` scripts, `infra/tests/`, anything in
`scripts/`, or a workflow in `.github/workflows/` — update this file in the same change. The `SDLC docs` CI job enforces it,
and `CLAUDE.md` points here as the source of truth.
See [Changing this SDLC](#changing-this-sdlc).

---

## The three layers

The single most useful idea here: **an instruction is a request; a check is a guarantee.** Work
is allocated to the weakest layer that can still hold it.

| Layer | Where it lives | Property |
| --- | --- | --- |
| **Enforced** | `verify.sh`, `.github/workflows/ci.yml`, the "Protect main" ruleset | Deterministic. Cannot be talked out of, forgotten, or skipped under deadline pressure. |
| **Procedural** | `.claude/skills/*` | Loaded on demand, only when relevant. Keeps long procedure out of always-on context. |
| **Always-on** | `CLAUDE.md` | Policy and routing only. Every line competes for attention, so it stays small. |

If something *must* happen, it belongs in the enforced layer. `CLAUDE.md` explains the gates;
it is not itself a gate.

---

## The loop

```
                        ┌──── debug ────┐
                        ▼               │
 TRACK ─▶ SPEC ─▶ PLAN ─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─▶ MERGE ─▶ DOCUMENT
   │                                                     │
   └── epic issue                        "Closes #N" ────┘
       child issues (after the plan)
```

`BUILD → VERIFY` is a tight inner loop run once per slice, not a single pass. Everything before
`MERGE` is repeatable; only merge is one-way. Each phase below names the skill that governs it.

---

## Phases

### 0. Track — *does an issue need to exist?*

**Not a skill — a judgment call, made before anything else.**

An issue is a unit of **commitment**; a PR is a unit of **change**. They are not 1:1, and
treating them as if they were is what turns a tracker into noise.

**Create an issue when someone other than you needs to know the work exists** — a future reader
wondering why the code looks this way, a decision parked until later, or work that will span
more than one PR. The trigger is *informational, not size*: a one-line change to `auth.ts` earns
a ticket; a large refactor of throwaway code may not.

**Do not create an issue for work you are about to do right now in a single PR.** The PR is
already the record. Ticket-per-commit fills the tracker until nothing in it can be found.

| Artifact | Captures | Lives in |
| --- | --- | --- |
| **Epic issue** | the *problem*, and why it matters | GitHub, unlabelled |
| **Plan** | the *solution* | `docs/plans/YYYY-MM-DD-<name>.md` |
| **Child issue** | one independently deliverable slice | GitHub, `enhancement` |
| **PR** | one change, closing a child *(enforced — [One child per PR](#one-child-per-pr))* | GitHub |

Three rules that keep this honest:

- **Order matters: problem before solution.** The epic must be fileable without knowing how —
  "a burst of requests can exhaust host resources" is a complete issue. Writing the plan first
  and back-filling issues inverts it: you committed to a solution before recording the problem.
- **Children only when independently deliverable.** If a slice can't be worked, reviewed, and
  merged on its own, it's a checklist item — put it in the epic body, not its own issue.
- **Design does not live in the tracker.** ADRs and plans are versioned alongside the code they
  explain; issues link to them. Design written into issue comments is design you will lose.

Close children from the PR body with `Closes #N` so the link is automatic rather than manual.

#### Bugs are the exception

The rule above does **not** apply to defects that reached a deployed environment. A feature issue
tracks work that *will* happen; a bug issue records that a defect **existed** — so file it even
when the fix is a ten-minute PR. The PR captures the fix; only the issue captures when it broke,
who was affected, and what the workaround was while it was open.

- **Never block a production fix on filing a ticket.** For a Sev-1, fix first and file
  immediately after or in parallel. The record matters; it does not matter more than the outage.
- **File before fixing** for anything non-urgent — the issue is where duplicate reports converge.
- **Bug issues want different fields**: symptom, blast radius, how it was detected, repro steps,
  workaround. Not acceptance criteria.
- **The reproduction test is the acceptance criterion.** `test-driven-development`'s Prove-It
  pattern says reproduce the defect with a failing test before fixing it; the issue closes when
  that test passes.

A bug you catch in your own branch before merge is not this. Just fix it.

*(This repo has no deployed environment yet — see the README's security posture. This rule
arrives with the Cloud Run work.)*

#### The epic is an index, not a design doc

**A one-line epic is correct at creation.** Its only job is to record that a problem exists.
*"A burst of requests can exhaust host resources and API budget"* is complete — findable,
fileable, and committed to nothing.

As artifacts appear, update it with **links, never copies**: Problem, an Artifacts list pointing
at the spec / plan / ADR, a short Resolved list of closed decisions, and the children checklist.
Nothing else — pasted content becomes a second copy that goes stale, and the stale copy is the
one people read.

Test: **an epic should be readable in 30 seconds and tell you where everything else is.** The
[worked example](#worked-example-adding-per-user-rate-limiting) shows one evolving.

> **Why this repo carries the ceremony.** Solo, a tracker's coordination value is close to zero —
> nobody is going to duplicate your work. It is kept here deliberately anyway: this is a learning
> project, and **rehearsing the discipline is the point**. The habit is what transfers to a
> setting where coordination isn't optional; the tracker here is practice, and practice only
> works if you do it when it isn't strictly necessary.

### 1. Spec — *what are we building, and what's out of scope?*

**Skill:** `spec-driven-development`

Used when requirements are vague or a change is significant enough that building the wrong thing
is the main risk. Produces objective, boundaries, success criteria, and — most importantly —
**open questions**, which get answered before planning starts.

Skip for small, obvious changes. A one-line bug fix does not need a spec.

**Specs are saved to `docs/specs/YYYY-MM-DD-<name>.md`** — in the repo, never in an issue. Same
reasoning as ADRs and plans: versioned alongside the code they describe, reviewable in a PR, and
they outlive any tracker. The epic *links* to the spec; it never contains it.

**Only write a separate spec when there are real open questions.** The `writing-plans` header
already carries Goal, Architecture, and Tech Stack. When requirements are clear, the plan absorbs
the spec and a separate document is ceremony. A spec earns its existence by surfacing something
you do not yet know — if it has no Open Questions section worth reading, you did not need it.

**The skill's template is greenfield-shaped.** Its six areas include Tech Stack, Commands,
Project Structure, Code Style, and Testing Strategy — all of which already live in `CLAUDE.md`
and `README.md` here. For a *feature* spec in this repo the parts that earn their keep are
**Objective, Boundaries, Success Criteria, and Open Questions**. Link out for the rest rather
than restating it and letting the copy rot.

### 2. Plan — *what are the ordered, verifiable steps?*

**Skill:** `writing-plans`

Plans are saved to `docs/plans/YYYY-MM-DD-<feature-name>.md`, written as bite-sized steps with
exact file paths, real code, and exact commands — no placeholders.

**Every plan header names its PR boundaries** — the pull requests the plan will produce, one
child issue each. This is where decomposition is decided, because it is the last point at which
splitting is free: once a branch is finished, the choices are re-slicing completed work or
reaching for an escape hatch. The staff-engineer review checks the boundaries against the task
graph, so a human sees "seven PRs" before a line is written. The `PR shape` job enforces the same
rule at merge time, but it is a backstop, not the decision point.

**The mandatory gate:** every plan gets a **staff-engineer review by a fresh subagent** using
`planning-reviewer-prompt.md`, and the review is **surfaced to the human before implementation
starts**. A fresh reviewer has no authorship bias — but it is another instance of the same model,
so its blind spots correlate with the author's. The human is the only uncorrelated signal, which
is why the gate exists and why it is not delegated.

**The reviewer sorts its own findings into two buckets**, at the point of writing each one — the
author can't be trusted to sort them afterwards, having the exact bias the fresh reviewer was
dispatched to counter.

| Bucket | What lands here | What happens |
| --- | --- | --- |
| **Mechanical** | Wrong file paths, name/signature mismatches between tasks, placeholders that slipped the no-placeholders rule, a missing verification step, a missing test for behaviour the plan already commits to | The author **applies it and lists it** in what's surfaced, so the human can audit and reverse it. A finding qualifies only if the reviewer wrote the exact correction. |
| **Judgment** | Scope, cost, risk posture, architecture, the security invariants (auth, isolation, sandbox), reviewer-vs-author disagreement, anything the reviewer is unsure of | **Escalated and blocking.** The plan is not touched until the human decides. |

**Tie-break: when in doubt, escalate.** A false escalation costs a few seconds of reading; a
false auto-apply silently changes the plan the human thought they approved. The author may
demote a mechanical finding to judgment, never the reverse.

This narrows *what reaches* the human; it does not remove the gate. The applied edits are
recorded in the plan document under `## Plan review log` — the plan is committed and reviewed in
a PR, so the audit trail outlives the conversation — and **implementation still waits for the
human**, even when both buckets come back empty.

### 3. Build — *implement in thin, working slices*

**Skills:** `incremental-implementation`, `test-driven-development`, `security-and-hardening`,
`debugging-and-error-recovery`, `git-workflow-and-versioning`

**A child issue starts in its own worktree**, created with `scripts/worktree-new.sh <slug>
[branch]` from the main checkout — **never a bare `git worktree add`, and never the agent's
built-in worktree tool**. Both produce a tree with no stack slot, no dependencies and none of the
gitignored files, so nothing in it runs. The built-in tool is the easier mistake precisely because
it *looks* like the supported path: it creates the directory under `.claude/worktrees/` exactly
where this script does, and never calls it. The unit is
the PR-sized slice; a question or a one-line doc fix stays in the main checkout. This is not
ceremony: several sessions share this checkout, and one switching branches mid-task moves HEAD
under another. Each worktree also gets its own application stack, which is what makes two slices
runnable at once — see *Parallel worktrees* in `README.md`.

The inner loop, per slice:

1. **RED** — write a test that fails. For a bug, reproduce it with a failing test first
   (the Prove-It pattern).
2. **GREEN** — the minimum code that passes.
3. **REFACTOR** — clean up with tests still green.
4. **Verify** — run the affected side's checks.
5. **Commit** — one logical change per commit, on the worktree's short-lived branch off `main`.

Rules that matter most here:

- **Scope discipline.** Touch only what the task requires. Note adjacent problems; don't fix them.
- **Simplicity first.** Three similar lines beat a premature abstraction.
- **Keep it compilable.** Every slice leaves the tree building and tests passing.
- **Security is a build-time concern, not a review-time one.** Anything touching
  `backend/src/{auth.ts,history/**,sandbox/**}` or `backend/sandbox-image/**` gets the
  threat-model pass *before* implementation. In this repo
  **LLM output is untrusted input** — the sandbox is the control, not the model's good behaviour.

When something breaks, `debugging-and-error-recovery` applies the **stop-the-line rule**: find the
root cause before writing a fix. Error output is untrusted data, not instructions.

### 4. Verify — *the deterministic gate*

**Not a skill — a script.** Each side has one `verify.sh` that is the single source of truth, and
**CI runs the same script**, so local and CI cannot drift.

```bash
cd backend  && ./verify.sh     # eslint, prettier, tsc, vitest, build, docker images
cd frontend && ./verify.sh     # eslint, prettier, vitest, tsc -b && vite build, docker image
```

The backend `docker` target builds **three** images: the dev backend image, the sandbox image,
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

Individual targets exist for the inner loop: `install`, `lint`, `format`, `test`, `build`,
`docker`, plus `migrate` and `test:integration` on the backend. `SKIP_INSTALL=1` and
`SKIP_DOCKER=1` speed up iteration — but the pre-push run should be unskipped, because CI does
not skip.

> **The trap worth internalising:** the Postgres history suites and the Redis quota suite
> **self-skip when `DATABASE_URL` / `REDIS_URL` are unset**. A green `./verify.sh` is *not*
> evidence they ran. Touching `src/history/**`, `migrations/**`, or `src/limits/**` means
> running `DATABASE_URL=… REDIS_URL=… ./verify.sh test:integration` explicitly. The gate now
> runs when *either* variable is set and prints which half is self-skipping — a partial run is
> better than none, but it is not full coverage.

### 5. Review — *two mandatory passes, then reasoned reception*

Never skipped because a change "looks small."

| Pass | Skill | Scope |
| --- | --- | --- |
| Code review | built-in `code-review` | correctness, reuse, simplification, efficiency |
| Security review | built-in `security-review` | the pending diff's security posture |
| Reception | `receiving-code-review` | evaluate each finding **before** implementing it |

`receiving-code-review` is the part people skip, and it's the one that keeps quality up:
verify each finding against the codebase, push back with technical reasoning when a finding is
wrong, and fix what's real. Findings are suggestions to evaluate, not orders to follow.

### 6. Merge — *CI is the gate*

Trunk-based: short-lived branches off `main`, small and frequent PRs, branch deleted after merge.
The "Protect main" ruleset requires the CI status checks by **job name** before a merge is allowed.

A PR closes **one** child. The `PR shape` job counts the closing references in the PR body and
fails above one; `[multi-child]` in the title is the visible exception. A PR that closes no issue
— a docs fix, a dependency bump — passes untouched.

### 7. Document — *record the why*

**Skill:** `documentation-and-adrs`

- **ADRs** → `docs/adr/NNNN-kebab-title.md`, continuing the existing sequence. Write one for any
  decision that would be expensive to reverse. Never delete an old ADR; supersede it.
- **README** → updated *in the same change* when a change alters commands, layout, verification
  steps, security posture, or the roadmap. Keep the judgment tight — internal refactors don't
  touch it.
- **This file** → updated when the process itself changes (enforced; see below).

[`docs/README.md`](README.md) indexes every subfolder here — what each holds, when to write one,
and whether it's mutable.

---

## How this meets CI/CD

CI is not a separate process — it is the same `verify.sh` the developer already ran, executed
where it cannot be skipped.

```
 developer                          GitHub Actions
 ─────────                          ──────────────
 ./verify.sh  ───── same script ──▶  Backend checks   (install→lint→format→test→build→
                                                       integration→docker)
                                     Frontend checks  (install→lint→format→test→build→docker)
                                     Terraform checks (selftest→fmt→init→validate→gates)
                                     SDLC docs        (process changes must update docs/sdlc.md)
                                     PR shape         (a PR closes at most one child issue)
                                            │
                                            ▼
                                     "Protect main" ruleset
                                     required checks must pass
```

Details that are easy to get wrong:

- **Job `name:` values are a contract.** The ruleset requires `Backend checks`,
  `Frontend checks`, `Terraform checks`, `SDLC docs` and `PR shape` by name. Renaming or removing a job silently
  blocks all merges until the ruleset is updated to match. Change what runs *inside* a job
  freely; keep the name stable, or update the ruleset in the same PR.
- **Never add a CI check without adding it to the matching `verify.sh`, or vice versa.** That
  mirroring is what stops local and CI drifting apart. Two jobs are deliberate exceptions, both
  metadata-level: `SDLC docs` diffs a PR against its base, and `PR shape` reads the PR body —
  neither has a meaningful single-working-tree equivalent. Both live in their own workflows so
  they can listen for `pull_request: edited` without re-running the full suites on every
  PR-title change. Both jobs' *unit tests* do have a local equivalent, and it is the same file
  CI runs: `./scripts/tests/check-pr-shape.test.sh` and
  `./scripts/tests/check-sdlc-sync.test.sh`.

  A third suite, `./scripts/tests/dependabot-auto-merge-disarm.test.sh`, is run by `SDLC docs`
  even though it belongs to a different workflow. That workflow gates itself to
  `dependabot/npm_and_yarn/*` branches, so a PR editing it never executes it, and the test would
  have no host otherwise. Same file locally and in CI, like the other two. See
  [Auto-merging dependency bumps](#auto-merging-dependency-bumps).
- **Dependabot PRs are exempt from `SDLC docs`, and need no exemption from `PR shape`.** The
  first is because `github-actions` bumps touch watched workflow files; the second is because
  bot PRs close no issue and the rule is *at most* one. If someone proposes an actor exemption
  for `PR shape`, that is a sign the rule drifted — see
  [One child per PR](#one-child-per-pr).
- **One workflow is not a check: `Dependabot auto-merge`.** It runs on every pull request but
  does nothing unless the author is `dependabot[bot]`, and all it does then is press "enable
  auto-merge" on patch and minor bumps. The four required checks still decide whether the PR is
  mergeable. It is therefore **not** in the ruleset's required checks and **not** subject to the
  `verify.sh` mirroring rule above — that rule binds gates, and this gates nothing. It also holds
  the only writable `GITHUB_TOKEN` in this repository's CI, which is why it checks nothing out;
  see [Auto-merging dependency bumps](#auto-merging-dependency-bumps).
- **CI splits `verify.sh` into named steps** (Install / Audit / Lint / Format / Test / Build / …) purely
  so each gets its own pass/fail and timing in the log. That is presentation, not a second
  definition of the checks.
- **The `Audit` step fails on high and critical advisories only.** `npm audit --audit-level=high`,
  the same command locally and in CI. Moderate and below stay visible in the output and are
  Dependabot's job; blocking every merge on a moderate transitive advisory buys noise rather than
  safety. It reads the lockfile, so `SKIP_INSTALL=1` does not weaken it.

  It is a **hard fail, not `|| true`**. A check that cannot fail is the decorative-assertion
  pattern this repo has already shipped once and had to fix — it reads as coverage and provides
  none. When a high advisory lands with no upstream patch, the honest response is an explicit,
  dated exception in the `audit()` function, where review can see it; not a permanently green
  check. The threshold is a judgment call, so it is written down here rather than left in a flag.
- **Postgres and Redis run as service containers**, and only the `Integration test` step sets
  `DATABASE_URL` / `REDIS_URL` — which is exactly why the service-free `Test` step still skips
  those suites.
- **Docker builds run on pull requests only**, to keep pushes to `main` fast.

**There is no CD yet.** Deployment is roadmap (GCP Cloud Run); the release and observability
phases arrive with it.

---

## Worked example: adding per-user rate limiting

A real roadmap item (README, *Known limitations*): no rate limiting or concurrency cap, so a
burst of requests can exhaust host resources and API budget.

**0. Track** — the gap is already public in the README's *Known limitations*, so it's information
someone could act on. File the epic. The entire body at this point:

```markdown
# Epic: per-user rate limiting and quotas

## Problem
A burst of requests can exhaust host resources (one container per execution) and API
budget. There is no per-user cap and no sandbox concurrency limit.
```

That is a **complete epic**. No solution, no spec, no children — nothing knows what the slices
are yet. It can sit untouched for weeks, and that is fine: it exists so the gap lives somewhere
searchable instead of only in a README bullet.

**1. Spec** — `spec-driven-development` writes `docs/specs/2026-08-08-per-user-rate-limiting.md`.
Objective: cap concurrent sandbox executions and requests per user. Boundaries: keyed on the
verified `sub`, limits centralised in `config.ts`, no new external dependency. Success criteria:
a user exceeding the cap gets `429`; a second user is unaffected. Open question surfaced:
*in-process counter or Postgres-backed?* — answered before planning, because it changes the whole
design. That open question is what earns the spec — without one, this step is skipped and the
plan absorbs it.

**2. Plan** — `writing-plans` writes `docs/plans/2026-08-08-per-user-rate-limiting.md` as ordered
steps. A fresh subagent reviews it and returns both buckets. *Mechanical:* Task 5 calls the limiter
`checkLimit()` where Task 2 defined it as `consume()` — one right answer, so it is applied on the
spot and listed in the plan's `Plan review log`. *Judgment:* the plan never says what happens when
`AUTH_REQUIRED=false` and there is no `sub` to key on — that is scope, so it **goes to the human
and blocks**. The human decides whether to handle it now or scope it out; only then is the plan
revised. The plan's header also names its **PR boundaries** — here, four PRs, one per child — and
the reviewer checks that split against the task graph.

**2b. Children** — *now* the slices are known, so batch-create them under the epic, one per
PR boundary the plan review approved, labelled `enhancement`:

```
#61  R1 — Limit configuration in config.ts
#62  R2 — Per-user limiter keyed on the verified sub
#63  R3 — Enforce on /api/execute (429 + Retry-After)
#64  R4 — Concurrency cap on sandbox launches
```

The reviewer's anonymous-`sub` finding could have collapsed R2 and R3 into one, or added a fifth
child — unknowable before the plan review. Children created earlier would already be wrong.

What did *not* get an issue: the README wording update in step 7. One edit in an existing PR, so
the PR is its own record.

**2c. The epic becomes an index** — the spec, plan, and children now exist, so the epic is
updated to point at them:

```markdown
# Epic: per-user rate limiting and quotas

## Problem
A burst of requests can exhaust host resources (one container per execution) and API
budget. There is no per-user cap and no sandbox concurrency limit.

## Artifacts
- Spec:     docs/specs/2026-08-08-per-user-rate-limiting.md
- Plan:     docs/plans/2026-08-08-per-user-rate-limiting.md
- Decision: docs/adr/0003-rate-limiting-approach.md   ← added at step 7

## Resolved
- In-process counter, not Postgres-backed — see ADR-0003.
- Anonymous mode (AUTH_REQUIRED=false) is out of scope — raised by the plan review,
  scoped out by the human at step 2.

## Children
- [ ] #61 R1 — Limit configuration in config.ts
- [ ] #62 R2 — Per-user limiter keyed on the verified sub
- [ ] #63 R3 — Enforce on /api/execute (429 + Retry-After)
- [ ] #64 R4 — Concurrency cap on sandbox launches
```

The Problem section is byte-identical to step 0 — the epic grew an *index*, not a body. No
design, no task steps, no code: those live under `docs/` and the epic holds paths to them.

`Resolved` is the one section worth hand-writing. Without the anonymous-mode line, the next
reader re-litigates a decision that was already made at step 2.

**3. Build** — `incremental-implementation` slices it, one child issue per branch:

- *Slice 1:* limit config in `config.ts` + unit tests. RED → GREEN → verify → commit.
- *Slice 2:* the limiter itself, keyed on `sub`, with tests for the anonymous case decided above.
- *Slice 3:* wire into `/api/execute`, return `429`.
- *Slice 4:* concurrency cap on sandbox launches.

`security-and-hardening` applies throughout: this touches the auth path, so the threat-model pass
runs first. Rate limiting is the **D** in STRIDE — the abuse case ("one user starves everyone
else") becomes the first test, and a cross-user test proves one user's limit can't affect another,
mirroring the existing isolation battery.

**4. Verify** — `cd backend && ./verify.sh`. No `src/history/**` change here, so the Postgres
suites aren't required — but if the limiter ends up Postgres-backed, `test:integration` becomes
mandatory.

**5. Review** — `code-review` and `security-review` against the diff. Suppose security review
flags that the limiter keys on a header when auth is off. `receiving-code-review` says: verify it
first. It's real → fix it. Had it instead claimed the in-memory counter was a cross-user leak when
the tests already prove otherwise, the right response is a pushback citing the test, not a change.

**6. Merge** — PR body carries `Closes #62` so the child closes itself; all four checks green;
branch deleted. Four PRs land this way, one child each — the `PR shape` job would fail a PR that
tried to close two — and the epic closes when the last child does.

**7. Document** — README's *Known limitations* and *Roadmap* both describe this gap, so both are
updated **in the same PR**. The in-process-vs-Postgres question was close enough to earn
`docs/adr/0003-rate-limiting-approach.md`, and the epic's **Artifacts** list gains that one line
— the last edit the epic ever needs. No `.claude/skills/`, `verify.sh`, or `ci.yml` change, so
this file is untouched and the `SDLC docs` job stays green.

---

## Where the skills come from

Every skill in `.claude/skills/` is **vendored** — copied in, adapted to this repo, pinned to an
upstream commit, and reviewed in-diff. No plugin marketplace is wired into this repository,
nothing is fetched at runtime, and there is no `SessionStart` hook.

Skills are prompts, and prompts are behaviour, so a change to one is a code change: it goes
through a PR and the gates above.

`.claude/skills/NOTICE.md` is the record — both upstreams, their pinned commits, the local
modifications, and **which upstream skills were rejected and why**. Read it before adding one
back; some were excluded because they actively conflict with the CI design described above.

---

## Changing this SDLC

This file is the contract, and it is enforced deterministically rather than by good intentions.

**The rule:** a PR that touches any of

- `.claude/skills/**`
- `backend/verify.sh`, `frontend/verify.sh` or `infra/verify.sh`
- The production-image assertions in `backend/verify.sh` also require a `python3` interpreter in
  the image, because a Cloud Run sandbox executes against the application image's own filesystem
- `infra/tests/**` — the self-tests `infra/verify.sh` runs first: the gates, and `bootstrap.sh`
  against a fake `gcloud` (a live run proves the script worked that day, not that the next edit is safe)
- `.github/workflows/**`
- `scripts/**`

must also touch `docs/sdlc.md`.

That last entry is deliberate: this document describes the exact semantics of the checks in
`scripts/` — their watched paths, failure messages and escape hatches — so a change to one that
skipped the doc would leave the two silently disagreeing.

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

One consequence of that tooling reaches the `verify.sh` scripts. Docker image tags are
daemon-wide, and `backend/verify.sh`'s `docker` target *builds* a tag and then *runs* it. With two
worktrees verifying at once a fixed `…:verify` tag lets one tree's assertions execute the other
tree's image — a pass or fail belonging to a different branch. `backend/verify.sh` and
`frontend/verify.sh` therefore derive their throwaway tags from the checkout's directory name
(`verify-<dirname truncated>-<cksum of the full path>` — the basename alone is neither unique, since
a worktree may share it with the main checkout, nor bounded against Docker's 128-character tag
limit), which is unique per worktree and deterministic in CI. `infra/verify.sh`
needs no equivalent: it builds no image.

**The enforcement:** the `SDLC docs` job — in its own workflow, `.github/workflows/sdlc-docs.yml`
— runs `scripts/check-sdlc-sync.sh`, which diffs the PR against its base and fails with a message
naming the files that changed. Pull requests only, since it needs a base to compare against.

It resolves that base from the **merge ref's first parent**, not the event payload's `base.sha`.
Those differ once `main` advances mid-PR, and the payload version would drag in commits the PR
author never touched — failing PRs over someone else's files, and passing PRs whose `docs/sdlc.md`
was updated by a different change.

**Escape hatch:** for a genuine no-op — a typo fix in a skill, a comment reflow — put
`[skip-sdlc-sync]` in the PR title. That's deliberately visible in the PR list rather than a
silent bypass. The workflow listens for `pull_request: edited` so that editing the title
actually re-runs the check; without that type the hatch would be documented but unusable.

**Dependabot is exempt.** The `github-actions` ecosystem bumps `uses:` pins inside
`.github/workflows/*.yml` — a watched path — so without an exemption every action update would
fail a required check that a bot can never satisfy. `scripts/check-sdlc-sync.sh` exits 0 when
`PR_ACTOR` is exactly `dependabot[bot]`. A pin bump is not a process change.

That exemption is an early `exit 0` **inside the script**, not a job-level `if:` — and the reason
is worth stating precisely, because the intuitive one is wrong. A job skipped by an `if:` does
**not** block a required check: GitHub reports it as *Success* and it satisfies the requirement.
The case that hangs a merge forever is a workflow-level `paths:` or `branches:` filter, where the
check never reports at all.

The actual reasons are narrower. A job-level `if:` would skip the `Self-test` step too, so the
suite guarding the exemption would not run on the very PRs the exemption exists for. And a
skipped job says nothing in the checks list, where this prints why it passed — which matters for
a bypass, the one outcome you want to be able to see.

Both early exits are covered by `scripts/tests/check-sdlc-sync.test.sh`, which the job runs as
its first step and which is also the local pre-push command. The base-resolution logic below
them is not covered — it needs git fixtures, and no change has yet warranted building them.

To take an upstream skill update: re-vendor the file, update the pinned commit in
`.claude/skills/NOTICE.md`, re-apply the local modifications listed there, and open a PR. The
prompt diff gets reviewed like code, because that is exactly what it is.

### Auto-merging dependency bumps

`.github/workflows/dependabot-auto-merge.yml` arms GitHub's native auto-merge on Dependabot PRs
where **every** dependency is a patch or minor bump. Majors are always merged by a human, because
a major is where a peer range breaks — #78 raised `vite` without `@vitejs/plugin-react` and died
at `npm ci`.

Four details in that rule are not decoration:

- **Every dependency, not the PR's highest reported update type.** On security updates Dependabot
  omits `update-type:` from the commit trailer, so the action falls back to parsing versions out
  of the PR body and yields nothing for an entry it cannot parse — #78's `esbuild` line reads
  "Removes `esbuild`". The summary output is the *max* across entries and skips those blanks, so a
  security PR whose only major is an unparseable entry reports minor. The gate reads the
  per-dependency JSON instead and fails closed on a blank, a missing key or malformed input.
- **An allow-list of ecosystems, not a deny-list, and it is applied *before* any step runs.** Only
  `npm_and_yarn` auto-merges. `github_actions` must not: the workflow pins its own action by SHA
  with the version in a trailing comment, and Dependabot bumps SHA pins by that comment, so a new
  third-party action SHA would arrive as a *patch* and merge unread — and `SDLC docs` exits 0 for
  `dependabot[bot]` while no `verify.sh` reads workflow files. An allow-list also fails closed on
  ecosystems added later: `docker` is proposed in #110, where a base-image digest bump has the
  same property.

  The check lives in the **job-level `if:`**, on `github.head_ref`, not in the gate that reads the
  action's output — and that placement is the whole point. For `pull_request` the workflow file is
  read from the merge ref, so a Dependabot PR bumping this workflow's own `fetch-metadata` pin
  would execute the *replacement* action under the job's writable token and only afterwards reach
  a gate that rejects it. Any rule that depends on metadata the third-party action produces is too
  late by construction. The gate repeats the check as defence in depth.
- **One commit, or nothing.** `fetch-metadata` verifies the PR author and then reads and
  signature-checks only `commits[0]`; auto-merge merges HEAD. Requiring a single commit closes the
  gap between what was inspected and what would merge. Every Dependabot PR this repository has
  seen carries exactly one commit, so the rule costs nothing.
- **Arming is undone when a PR stops qualifying — but only what the workflow itself armed.**
  GitHub disables auto-merge only when someone *without* write permission pushes to the head
  branch, and Dependabot has write. A grouped PR armed while patch-only and later updated in place
  to carry a major would otherwise stay armed and merge that major unattended, so the workflow
  calls `gh pr merge --disable-auto` on an already-armed PR that no longer qualifies.

  It decides whose arming it is from **both** `autoMergeRequest.enabledBy.is_bot` and the login,
  and **fails closed** when it cannot tell. `allow_auto_merge` is repository-wide, so a human can
  read a major and arm it by hand, and silently revoking that would be its own defect.

  Each half of that rule cost a defect to learn. Keying on the **login alone** failed: the first
  version compared it against `github-actions[bot]` and never matched, because `gh` renders a Bot
  actor as `app/github-actions` while the underlying GraphQL `Bot.login` is bare `github-actions`
  — so every bot-armed PR read as "a human did this, leave it alone". Keying on **`is_bot` alone**
  fails the other way: it matches *any* app, so a maintainer who runs `@dependabot merge` on a
  major after reading it would be silently overridden. And `enabledBy` is a **nullable** Actor —
  a deleted account, an uninstalled app — so `is_bot` can be *absent* rather than false; a bare
  `// false` would read absent as "human" and leave an ineligible PR armed. The check tests
  `is_bot | type == "boolean"`.

  When it comes back indeterminate the step **disarms anyway**, then fails the job. Exiting
  without disarming would not be failing closed, which is what an earlier version called it: this
  workflow is deliberately not a required check, so a red job blocks nothing and the PR would stay
  armed and merge. Refusing to act is fail-*open* with a red light nobody has to obey. Revoking a
  possible human decision is visible and one click to undo; an unattended merge of an ineligible
  PR is neither.

  Its tests are `scripts/tests/dependabot-auto-merge-disarm.test.sh`, ten cases, run by the
  **`SDLC docs`** job. That job is a host, not the owner: this workflow gates itself to
  `dependabot/npm_and_yarn/*` branches, so a PR that edits it never executes it, and the logic
  would otherwise ship with no automated coverage — which is how a wrong actor constant survived
  two reviews. `SDLC docs` already has a checkout and a read-only token, runs on every PR, and
  exists to check that a process change is self-consistent.

  The test extracts the script from the YAML rather than keeping a copy, so the two cannot drift,
  and stubs `gh` in a way that still runs the real `--jq` expression over payloads captured from
  real `gh` output. A hand-written stub can only encode what its author already believes, which is
  exactly how `github-actions[bot]` got past review.

**An auto-merge does not re-run `CI` on `main`.** A `push` or `pull_request` event triggered by
`GITHUB_TOKEN` does not start a new workflow run (`workflow_dispatch` and `repository_dispatch`
are the documented exceptions, and neither applies here), and auto-merge armed by this workflow
merges as `app/github-actions`. Confirmed
on the first unattended merge: `8211ee8` (PR #117) has no `push`-side CI run, while every
human-merged commit around it does. That is harmless here — `strict_required_status_checks_policy`
means the PR's own checks already ran against exactly this base — but it does mean the `main`
history has gaps in its push-side runs, and anything built later that keys off "CI ran on main"
must not assume otherwise.

**What it is not.** It does not weaken any gate. Native auto-merge waits for all four required
checks *and* for every review thread to be resolved. Copilot reviews every PR including
Dependabot's, so a single inline comment parks the merge until someone answers it. That is the
intended behaviour and was chosen deliberately over dropping
`required_review_thread_resolution` (issue #94): the feature is "auto-merge when nothing
objects", not "unattended merges". A parked PR is a correct outcome, not a bug to design around.

**Why it does not update stale branches.** `strict_required_status_checks_policy` is on, so a
merge to `main` leaves every other open PR out of date, and auto-merge will not update a branch
itself — that is what a merge queue is for. For Dependabot PRs the update arrives from Dependabot,
which rebases its own PRs by default and gives up after 30 days. The queue therefore drains on
Dependabot's cadence rather than instantly. If that becomes the bottleneck, the fix is a merge
queue, not dropping `strict` — but note that the built-in `GITHUB_TOKEN` cannot add a pull request
to a merge queue, so adopting one means re-authenticating this workflow with a PAT or a GitHub App
token.

**Security posture — different from every other job here.** `SDLC docs` and `PR shape` run
scripts from the PR branch under a read-only token. This workflow inverts that: it holds
`contents: write`, and so it checks nothing out and runs no repository code. It uses
`pull_request`, never `pull_request_target`.

**It is two jobs, and the split is the point.** `gate` runs the one third-party action —
`dependabot/fetch-metadata`, pinned to a full commit SHA — under `pull-requests: read`, and
publishes a verdict as a job output. `apply` holds `contents: write` and runs nothing but `gh`.
In a single job the write scope would be handed to the third-party action, leaving the SHA pin as
the only thing between a compromised release and a push to `main`. The split turns that
supply-chain assumption into a scope boundary; the pin stays as defence in depth.

`contents: write` was first shipped omitted, on the reasoning that `gh pr merge --auto` only
*enables* auto-merge and GitHub performs the merge later. The first real run disproved it:
`Resource not accessible by integration (enablePullRequestAutoMerge)`, and the same on
`disablePullRequestAutoMerge`. Those runs prove `pull-requests: write` alone is insufficient; that
`contents` is the scope that closes it comes from GitHub's documented example. Do not narrow it
again without a run to point at.

**Two `if:` details that are load-bearing, not style.** A step or job `if:` without a status
function is implicitly ANDed with `success()`, so the disarm path carries `!cancelled()` — if
`gate` fails, its verdict is empty, which is not `eligible`, and the one mechanism that un-arms a
PR must still run. And GitHub invokes `run:` steps as `bash -e {0}`, so `set -uo pipefail` does
**not** clear errexit; the disarm step says `set +e` explicitly because it handles its own `gh`
failures.

---

## One child per PR

`docs/sdlc.md` has always said a PR is "one change, closing a child". It drifted on its first
real test — #71 closed all seven children of epic #62 in one 1,362-line change — so the rule
moved out of the instruction layer.

**The rule:** a PR body may contain closing references (`Closes`, `Fixes`, `Resolves`, and their
tenses) to **at most one** issue. Zero is fine — a docs fix or a dependency bump closes nothing.

**The enforcement:** the `PR shape` job — in its own workflow, `.github/workflows/pr-shape.yml` —
runs `scripts/check-pr-shape.sh`, which strips HTML comments and fenced blocks from the body,
folds all three GitHub reference forms (`#N`, `owner/repo#N`, the issue URL) to one canonical
form, deduplicates, and fails above one. Quoting another PR's body is therefore safe as long as
the quotation sits in a fence. Its unit tests are `scripts/tests/check-pr-shape.test.sh`; the job
runs that file as its first step, and it is also the local pre-push command.

**Escape hatch:** put `[multi-child]` in the PR title. Visible in the PR list, exactly like
`[skip-sdlc-sync]`.

**Why *at most* one and not exactly one.** Exactly-one would also catch a PR that batches
children while writing no `Closes` line at all — but it would need a second marker on every PR
that legitimately closes nothing (~30% here) and an actor exemption for `dependabot[bot]`, whose
titles are rewritten on every rebase. The concealment it guards against has no precedent here:
#71 declared all seven closing references openly. A backstop should be dumb.

**It is a discipline backstop, not a security control.** On `pull_request` the workflow and the
script both come from the PR's head, so a fork PR can edit the gate to pass itself — the same
posture as `SDLC docs`. Both jobs hold a read-only token and reach no secrets. Do not build
anything on the assumption that either is tamper-proof.

**Where the real decision is made:** the `PR boundaries` field in the plan header (see
[Plan](#2-plan--what-are-the-ordered-verifiable-steps)). This check is what happens when that
decision is not honoured.
