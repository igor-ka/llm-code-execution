# Software development lifecycle

How a change gets from an idea to `main` in this repository, and which skill governs each step.

This document is a **contract**. If you change the development process — the skills in
`.claude/skills/`, any component's `verify.sh`, anything in `scripts/`, or a workflow in
`.github/workflows/` — update **the document `process.doc` names in `.acb.json`** in the same
change. That is usually this file; where a repository keeps its own process specifics separate, it
is that companion instead. The `SDLC docs` CI job enforces it, and `CLAUDE.md` points at both.
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

*(This rule applies once a repository has an environment defects can reach. Before that, a
defect caught in your own branch is just a fix.)*

#### The epic is an index, not a design doc

**A one-line epic is correct at creation.** Its only job is to record that a problem exists.
*"A burst of requests can exhaust host resources and API budget"* is complete — findable,
fileable, and committed to nothing.

As artifacts appear, update it with **links, never copies**: Problem, an Artifacts list pointing
at the spec / plan / ADR, a short Resolved list of closed decisions, and the children checklist.
Nothing else — pasted content becomes a second copy that goes stale, and the stale copy is the
one people read.

Test: **an epic should be readable in 30 seconds and tell you where everything else is.** The
[worked example](sdlc-example.md) shows one evolving.

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
  the paths `CLAUDE.md` marks sensitive gets the threat-model pass *before* implementation. Where
  a repository runs model-generated code, **LLM output is untrusted input** — the sandbox is the
  control, not the model's good behaviour.

When something breaks, `debugging-and-error-recovery` applies the **stop-the-line rule**: find the
root cause before writing a fix. Error output is untrusted data, not instructions.

### 4. Verify — *the deterministic gate*

**Not a skill — a script.** Each side has one `verify.sh` that is the single source of truth, and
**CI runs the same script**, so local and CI cannot drift.

```bash
cd <component> && ./verify.sh   # audit, lint, format, typecheck, test, build, package
```

**Three things are a contract, not a convention**, because `scripts/check-conformance.sh` enforces
them on every pull request and a component that breaks one turns a required check red:

| | Requirement | Why it is not negotiable |
| --- | --- | --- |
| `./verify.sh <target>` | dispatches every target the component declares in `.acb.json` | A declared target the dispatcher does not know is a CI step that fails on every pull request |
| `./verify.sh <unknown>` | exits **64** | 64 means "no such target". Reusing 2 — "declared but not implemented" — makes the check unable to tell a missing target from a stub, and it reports the missing one as fine |
| `./verify.sh --targets` | prints the known target names, one per line, and exits | It is how the check learns what a script knows *without running it*. Probing by execution re-runs the install, the build and the image push inside a metadata job on every pull request |

Nothing dictates how the targets are *named internally* — `target_lint`, `lint_`, `lint` and
`do_the_lint` are all fine. The check patches every function rather than guessing one name, which
is what lets a hand-written script keep whatever convention it already had.

An existing repository adopting a newer toolkit gets `--targets` as the one breaking change:
`verify.sh` is generated once at `acb init` and is yours thereafter, so `acb pull` will not add it
for you. Four lines, once per component:

```bash
TARGETS="lint test build"                 # near the top
--targets) printf '%s\n' "$TARGETS" | tr ' ' '\n'; exit 0 ;;   # in the dispatcher's case
```

**The `package` target should build the artifact you actually deploy, and assert against it.**
Two lessons behind that, both paid for:

- Assert *inside* the built artifact — that the security headers shipped, that the runtime user is
  not root, that no build-time placeholder survived. A unit test on a policy builder cannot catch
  "the server forgot the header", and that is exactly the defect that reaches production.
- If the deployable artifact spans components, building it means one job depends on another's
  source. That makes the job slower and lets an unrelated regression fail it. Accept it or split
  the artifact, but decide deliberately rather than discovering it.

Individual targets exist for the inner loop — the canonical vocabulary is `install`, `audit`,
`lint`, `format`, `typecheck`, `test`, `test:integration`, `build`, `package`, `migrate`,
`publish`, `eval` and `selftest`, and a component declares the ones it has. `SKIP_INSTALL=1` and
`SKIP_PACKAGE=1` speed up iteration — but the pre-push run should be unskipped, because CI does
not skip.

> **The trap worth internalising:** suites that need a live service **self-skip when their
> connection variable is unset**. A green `./verify.sh` is *not* evidence they ran. Touching the
> code they cover means running `./verify.sh test:integration` with those variables set,
> explicitly. Where several services are involved, the gate should run when *any* of them is
> configured and print which half is self-skipping — a partial run reported as a full one is the
> failure mode.

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
 ./verify.sh  ───── same script ──▶  <Component> checks   one job per component in .acb.json,
                                                          one step per declared target
                                     SDLC docs            process changes must update process.doc
                                     PR shape             a PR closes at most one child issue
                                            │
                                            ▼
                                     branch ruleset
                                     required checks must pass
```

Details that are easy to get wrong:

- **Job `name:` values are a contract.** The ruleset requires each one *by name*, so renaming or
  removing a job silently blocks every merge until the ruleset is updated to match. Change what
  runs *inside* a job freely; keep the name stable, or update the ruleset in the same change. The
  names come from each component's `checkName` in `.acb.json`, never from its directory — those
  two disagree more often than you would expect, and deriving one from the other is how a required
  check gets renamed by accident.
- **Never add a CI check without adding it to the matching `verify.sh`, or vice versa.** That
  mirroring is what stops local and CI drifting apart. Two jobs are deliberate exceptions, both
  metadata-level: `SDLC docs` diffs a pull request against its base, and `PR shape` reads the PR
  body — neither has a meaningful single-working-tree equivalent. Both live in their own workflows
  so they can listen for `pull_request: edited` without re-running the full suites on every
  PR-title change. Both jobs' *unit tests* do have a local equivalent, and it is the same file CI
  runs.
- **Watch for suites that lodge in another workflow.** A workflow that gates itself — to a branch
  prefix, or to pushes on the default branch — never runs on a pull request that edits it, so its
  own tests would have no host. Hosting them in a job that always runs is correct; hosting a test
  whose *subject* is not carried alongside it is not, and produces a required check that fails on
  a missing file forever.
- **Bot pull requests are exempt from `SDLC docs`, and need no exemption from `PR shape`.** The
  first because dependency bumps touch watched workflow files; the second because bot PRs close no
  issue and the rule is *at most* one. A proposal to add an actor exemption to `PR shape` is a
  sign the rule has drifted — see [One child per PR](#one-child-per-pr).
- **One workflow is not a check: `Dependabot auto-merge`.** It runs on every pull request and does
  nothing unless the author is the bot, and then only presses "enable auto-merge" on patch and
  minor bumps. The required checks still decide whether the PR is mergeable. It is therefore
  **not** in the ruleset's required checks and **not** subject to the mirroring rule above — that
  rule binds gates, and this gates nothing. It also holds the only writable token in CI, which is
  why it checks nothing out.
- **CI splits `verify.sh` into named steps** purely so each gets its own pass/fail and timing in
  the log. That is presentation, not a second definition of the checks.
- **The `audit` target fails on high and critical advisories only.** The same invocation locally
  and in CI. Moderate and below stay visible in the output and are the dependency bot's job;
  blocking every merge on a moderate transitive advisory buys noise rather than safety.

  **The lesson that generalises: dependency auditors are configurable from the environment, and
  their bypasses fail *open*.** In one ecosystem alone there are three — an offline flag that
  makes the auditor report "found 0 vulnerabilities" and exit 0; a production/omit setting that
  silently drops every dev-dependency advisory, which is the scope the gate claims to cover; and
  the `|| true` that is tempting when a build goes red. All were found by review rather than by
  the gate noticing, which is the point: **state the intent in explicit flags rather than
  inheriting whatever the environment says.** Whatever your ecosystem, find its equivalents before
  trusting the target.

  Audit **first**, before the install target. Installing executes dependency lifecycle scripts, so
  auditing afterwards lets a package with a known install-time vulnerability run before the gate
  can reject it. The cost is that a registry outage aborts the pass before the offline checks —
  reach for a single target then.

  It is a **hard fail, not `|| true`**. A check that cannot fail is the decorative-assertion
  pattern — it reads as coverage and provides none. When a high advisory lands with no upstream
  patch, the honest response is an explicit, dated exception inside the `audit` function where
  review can see it; not a permanently green check. The threshold is a judgment call, so write it
  down rather than leaving it in a flag.
- **Services run as containers, and only the integration step sets their connection variables** —
  which is exactly why the service-free `test` step still skips those suites. A suite that
  self-skips on a missing variable is correct; a green `test` treated as evidence it ran is not.
- **Pull the base image on every build.** Without it a builder reuses whatever is cached locally,
  so the identical script yields different artifacts on two machines: CI starts cold and gets the
  current tag, a laptop can be months behind and still report green. That is drift arriving
  through the *inputs* rather than the commands — the one gap the single-`verify.sh` design does
  not otherwise close.

  It narrows the gap rather than closing it, and the difference is deliberate. Mutable tags are
  re-resolved at each build, so two builds still differ if upstream republishes between them. Only
  digest pins make them provably identical, and those turn every upstream rebuild into a pull
  request. The residual window is upstream-republish timing; the one it replaces was a laptop
  months behind CI.

  Cost is a manifest check, not a download, when the cached digest is current.
- **Image builds run on pull requests only**, to keep pushes to the default branch fast.

**CD is out of scope for this document.** A repository that deploys should describe its release
path in its own runbooks; the phases above end at merge.

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

The process document is a contract, and it is enforced deterministically rather than by good
intentions. Which document that is comes from `process.doc` in `.acb.json` — usually this file,
sometimes a local companion to it, for the reason set out below.

**The rule:** a PR that touches any of

- `.claude/skills/**`
- any component's `verify.sh`, and the self-tests it runs first
- `.github/workflows/**`
- `scripts/**`

must also touch **the document `process.doc` names in `.acb.json`**, and the watched list itself
is `process.watched` in the same file — both read at run time, so a repository tunes them without
editing the gate.

Pointing `process.doc` at a local companion is the right answer whenever this file is carried and
a consumer's process changes are its own: a change to one component's `verify.sh` has nothing to
say in a document shared with every other repository, and requiring an edit here would make that
repository permanently *ahead* of the toolkit — `acb pull` would revert it on the next run.

> **A check that cannot fail the way production fails is not a gate.** One worked example, because
> the shape recurs: an image assertion that ran `command -v python3` passed in a shell that *has* a
> `PATH`, while the runtime it modelled inherits no environment and resolves bare command names
> against nothing. The assertion proved the packaging was right and the deployment still broke.
> Name interpreters by absolute path, and make the check run the way the failure runs.

That last entry is deliberate: this document describes the exact semantics of the checks in
`scripts/` — their watched paths, failure messages and escape hatches — so a change to one that
skipped the doc would leave the two silently disagreeing.

`scripts/` also holds **developer tooling that is not a CI check**: the worktree helper creates a
git worktree ready to work in. The watched-path rule covers it too, and that is the right outcome
rather than an accident — whatever contract it encodes is process, and a change that skipped the
docs would leave the documentation describing a scheme the script no longer implements.

Its unit tests, `scripts/tests/worktree-new.test.sh`, run **locally only** — CI never creates a
worktree, so there is nothing there for them to protect. That is why they are absent from the two
jobs named above, and why they are **not** an exception to the `verify.sh` mirroring rule: there
is no CI check to mirror. Run them before pushing a change to the script.

A second consequence of that tooling reaches the `verify.sh` scripts, and it generalises to any
builder with a shared daemon. **Image tags are daemon-wide.** A `package` target that builds a tag
and then runs it will, with two worktrees verifying at once, have one tree's assertions execute the
other tree's image — a pass or a fail belonging to a different branch. Derive throwaway tags from
something unique per checkout rather than from a fixed name, and make it deterministic so CI
reproduces it. A component that builds no image needs no equivalent.

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
a major is where a peer range breaks — one such PR raised a build tool without its companion
plugin and died at install.

Four details in that rule are not decoration:

- **Every dependency, not the PR's highest reported update type.** On security updates Dependabot
  omits `update-type:` from the commit trailer, so the action falls back to parsing versions out
  of the PR body and yields nothing for an entry it cannot parse — #78's `esbuild` line reads
  "Removes `esbuild`". The summary output is the *max* across entries and skips those blanks, so a
  security PR whose only major is an unparseable entry reports minor. The gate reads the
  per-dependency JSON instead and fails closed on a blank, a missing key or malformed input.
- **An allow-list of ecosystems, not a deny-list, and it is applied *before* any third-party step
  runs.** The list lives in `ACB_DEPENDABOT_ECOSYSTEMS`, and an unset variable allows nothing.
  `github_actions` must never be on it: the workflow pins its own action by SHA
  with the version in a trailing comment, and Dependabot bumps SHA pins by that comment, so a new
  third-party action SHA would arrive as a *patch* and merge unread — and `SDLC docs` exits 0 for
  `dependabot[bot]` while no `verify.sh` reads workflow files. An allow-list also fails closed on
  ecosystems added later, with no exclusion rule to write or remember. That matters most for
  container base images: where one forms a containment boundary around untrusted code, it must
  never merge unread.

  The check is the **first step of the job**, before any third-party action runs — and that
  placement is the whole point. For `pull_request` the workflow file is read from the merge ref,
  so a Dependabot pull request bumping this workflow's own `fetch-metadata` pin would execute the
  *replacement* action under the job's writable token and only afterwards reach a gate that
  rejects it. Any rule that depends on metadata the third-party action produces is too late by
  construction. It was a job-level `if:` while the list was a literal in the file, and became a
  step when the list moved to a repository variable — **not** because a job-level `if:` cannot
  read a variable (`vars` is available in that context) but because workflow expressions cannot
  split `github.head_ref` on `/` to extract the ecosystem, nor test membership of a
  space-separated list. A shell step does both in four lines. The cost of moving it is that a
  step's position is not self-enforcing the way a job-level `if:` was, so
  `scripts/tests/dependabot-auto-merge-disarm.test.sh` asserts the ordering. The gate repeats the
  check as defence in depth.
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
  `dependabot/*` branches, so a PR that edits it never executes it, and the logic
  would otherwise ship with no automated coverage — which is how a wrong actor constant survived
  two reviews. `SDLC docs` already has a checkout and a read-only token, runs on every PR, and
  exists to check that a process change is self-consistent.

  The test extracts the script from the YAML rather than keeping a copy, so the two cannot drift,
  and stubs `gh` in a way that still runs the real `--jq` expression over payloads captured from
  real `gh` output. A hand-written stub can only encode what its author already believes, which is
  exactly how `github-actions[bot]` got past review.

**An auto-merge will re-run `CI` on `main`, and trigger `Deploy` — it did neither before Phase 3,
and it does neither until the App below is created.**
A `push` or `pull_request` event triggered by `GITHUB_TOKEN` does not start a new workflow run
(`workflow_dispatch` and `repository_dispatch` are the documented exceptions), and auto-merge armed
with that token merges as `app/github-actions`. Confirmed on the first unattended merge: `8211ee8`
(PR #117) has no `push`-side CI run, while every human-merged commit around it does.

That was harmless while nothing keyed off "CI ran on main", and this document said so — adding that
**anything built later that keys off it must not assume otherwise**. Phase 3's `Deploy` workflow is
that later thing, and it keys off exactly that: an auto-merged security patch would have reached
`main` and never been deployed, silently, until the next human push.

The fix is at the source rather than routed around. The `apply` job mints a **GitHub App
installation token** — an hour-lived credential, from an app holding `contents: write` and
`pull-requests: write` on this repository alone — and merges with that instead of `GITHUB_TOKEN`.
An App pushes as a first-class actor, so both gaps close at once and Dependabot stops being a
special case in any respect — **once the App exists**. Until its credentials are present the mint
step fails, the arm step is skipped, and auto-merge simply does not happen; the disarm path keeps
working, because it deliberately uses `GITHUB_TOKEN` rather than the App token.

**What the App is, so this is recoverable without reading a merged pull request.** A GitHub App
installed on this repository alone, holding `contents: write` and `pull-requests: write` and
nothing else, with no webhook. Three repository settings feed it, and the first two are
**Dependabot** secrets rather than Actions secrets — `pull_request` events raised by Dependabot are
not given Actions secrets, and the two stores look identical in the UI:

| Setting | Store | Why |
| --- | --- | --- |
| `AUTOMERGE_APP_CLIENT_ID` | Dependabot secret | the App's Client ID. `app-id` is deprecated in the action. |
| `AUTOMERGE_APP_PRIVATE_KEY` | Dependabot secret | the App's private key, in PEM form. |
| `AUTOMERGE_APP_SLUG` | Actions **variable** | the App's slug, so the disarm step can recognise this workflow's own arming even on runs where minting failed. |

Rotating the key means replacing `AUTOMERGE_APP_PRIVATE_KEY`; nothing else changes. `gate` is untouched and keeps `GITHUB_TOKEN` at `pull-requests: read`,
so the two-job scope split is unchanged.

**The disarm path deliberately does NOT use the App token**, and that asymmetry is the load-bearing
part. Disarming is the only mechanism that un-arms an ineligible PR, and this workflow is not a
required check — so a red job blocks nothing. Routing it through a credential that can be absent,
rotated or unreachable means a run where minting failed leaves the PR armed and merges it: fail-open
with a red light nobody has to obey. It keeps `GITHUB_TOKEN`, which is always present. Only the arm
path needs App identity, because only the arm path produces the push that must fire `CI` and
`Deploy`.

That asymmetry has a consequence the disarm step has to handle: it must know **which login means
"this workflow armed it"** even on the runs where minting failed, which is why `AUTOMERGE_APP_SLUG`
is a plain Actions variable rather than read from the mint step alone. Guessing instead — treating
any unrecognised bot as ours — would revoke a maintainer's deliberate `@dependabot merge`, and the
disarm suite fails if you try it.

A long-lived fine-grained PAT would also have worked and was rejected — but not for the reason
that first suggests itself, and the distinction is worth recording because the wrong version of it
would lead someone to under-protect the key. **The App private key is also a standing repository
secret**: it does not expire, it mints write-scoped tokens on demand, and revoking it means
regenerating the key rather than deleting a token. What the App actually buys over a PAT is that it
is scoped to this one repository rather than to a user's whole account, that the tokens it mints
are hour-lived and narrowed at mint, and that it is not tied to an individual who might leave. Those
are sufficient; "no standing credential" is not true of either. The gap in `main`'s push-side history before
this change is real and stays in the record.

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

**It is two jobs, and the split is the point.** `gate` runs `dependabot/fetch-metadata`, pinned to
a full commit SHA, under `pull-requests: read`, and publishes a verdict as a job output. `apply`
holds `contents: write`.

`apply` used to run nothing but `gh`, and since the auto-merge moved to a GitHub App it also runs
`actions/create-github-app-token` — so the write-scoped job now does execute third-party code, and
saying otherwise would misdescribe the posture. It is GitHub's own action, SHA-pinned, and it mints
a token whose permissions are narrowed at mint rather than inherited from the installation. What
the split still buys is that the *metadata* action, whose output the gate depends on, never sees
write scope.
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
