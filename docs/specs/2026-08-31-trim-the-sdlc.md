# Spec: trim the SDLC

**Status:** agreed. Epic [#249](https://github.com/igor-ka/llm-code-execution/issues/249).

## Objective

Cut the per-change cost of this repository's development process without weakening any gate that
has caught a defect. The target is the overhead *upstream* of the first commit and the process's
own maintenance burden, not the deterministic gates — those were measured and are cheap.

**Who this is for:** every session that works in this repository, and every future consumer of
`acb`. Two of the three changes are carried, so they land in `igor-ka/acb` and travel.

## The measurement this comes from

Taken on 2026-08-31 against `main` at `0609a7b`, over 107 merged PRs and 184 commits.

**Where the cost is not.** CI wall clock is 2.2 min median; the slowest step is `Package` at ~50s;
the mutation gate costs seconds. PR open→merge is 27 min median in August, down from 523 min in
June. The merge machinery got faster.

**Where the cost is.**

| Signal | Value |
| --- | --- |
| Mandatory process text | **4,707 lines** (`CLAUDE.md` 217 + `sdlc.md` 737 + `sdlc-local.md` 358 + `testing-notes.md` 136 + 9 `SKILL.md` 2,712 + 2 references 547) |
| Product source it governs | **4,235 lines** (`backend/src` + `frontend/src`, tests excluded) |
| August churn in `docs/plans` | **25,943 lines** across 27 file touches — more than `backend` (20,583 across 238) |
| Median plan length | ~1,400 lines; the two most recent are 2,356 and 2,793 |
| Plan lines per product line, August | ~2.2 |
| August churn that was process/docs | **71%** (42,250 of 59,563) |
| August merged PRs touching only process/docs/CI | **34 of 85 (40%)** |

Product output did not fall — August shipped 12,609 lines of product code, the most since the May
scaffolding month. The process did not slow the work down so much as surround it: the same output
now sits inside three to four times the overhead.

## Scope

Three changes. A fourth was considered and is **deferred by decision** — see *Out of scope*.

### C1 — What a plan contains *(carried → `acb`)*

A plan states what to build, in what order, with what verification, and where each task's oracle
comes from. It is not a second copy of the implementation. Today the `writing-plans` skill requires
the opposite in four places: `## Overview` asks for "the code"; `## No Placeholders` makes "code
blocks required for code steps" and forbids "similar to Task N" — *"repeat the code, the engineer
may read tasks out of order"*; `## Remember` asks for "complete code in every step"; and the
`## Task Structure` template demonstrates a code block per step. Those four are what produce a
2,793-line plan.

**No line limit.** A numeric cap was considered and rejected: a plan long because the work is large
is not the failure, and a cap would be gamed by writing the same content more densely. The rules
below attack what goes *in* a plan; length falls out of that.

**The new rules:**

- Every task keeps its exact file paths, its ordered steps, its verification command, and — for any
  task that writes a test — the named source of its oracle. None of this is relaxed.
- Code appears only where the exact bytes are the decision being made: a regex, a schema, a wire
  format, a security-critical assertion, a command whose flags are load-bearing. Elsewhere the plan
  names the behaviour and the signature and stops.
- "Repeat the code rather than cross-reference" is replaced by: cross-reference freely within one
  plan; never cross-reference out of it.
- Every prohibition on vagueness stays exactly as it is — "TBD", "add appropriate error handling",
  "handle edge cases", "write tests for the above", a step that names no verification. This change
  narrows what must be *shown*; it licenses nothing to go *unsaid*.
- The `## Task Structure` template is trimmed to match, because it is the shape authors copy.

**Enforcement.** The staff-engineer plan reviewer reports a code block that transcribes an
implementation the plan has already specified in prose as a *mechanical* finding, with the exact
correction being its replacement by the signature and the behaviour. No CI check — there is no
longer a number to count, and a reviewer already reads the whole document.

**Files:** `.claude/skills/writing-plans/SKILL.md`, `.claude/skills/writing-plans/planning-reviewer-prompt.md`,
`docs/sdlc.md` (Phase 2). All three are **carried**, so all three go upstream with `acb propose`.

### C3 — Narrow what the `SDLC docs` gate watches *(local, plus a carried mechanism)*

`process.watched` currently includes `^scripts/`, which covers `scripts/tests/**` — 2,354 lines
across 26 file touches in August. A change to a script's *test* does not change the contract
`sdlc-local.md` documents, so every such PR pays a documentation edit or reaches for
`[skip-sdlc-sync]`. Both outcomes are wrong: the first is busywork, the second erodes the hatch.

**The change:** exclude `^scripts/tests/` from the watched set, and leave everything else watched.

**The mechanism.** `.acb.json` gains `process.watchedExcept`, an array of regexes subtracted from
`process.watched`; `scripts/check-sdlc-sync.sh` (carried) applies it. The alternative — replacing
`^scripts/` with an enumeration of the individual scripts — is rejected: a script added later would
land outside the enumeration and the gate would **fail open**, which is the one failure mode a gate
must not have. Subtraction fails closed, because only what is named is dropped.

`watchedExcept` is optional and defaults to empty, so every other consumer's behaviour is
unchanged.

**Files:** `.acb.json`, `docs/sdlc-local.md`, `CLAUDE.md` (local); `scripts/check-sdlc-sync.sh` and
`scripts/tests/check-sdlc-sync.test.sh` (**carried** → `acb propose`); `schema/acb.schema.json` in
`acb`.

### C4 — Fold `docs/testing-notes.md` into `docs/sdlc-local.md` *(local)*

`testing-notes.md` was created by the `acb` adoption to hold what the newly-carried
`test-driven-development` skill had to drop. PR #235 has since moved the generic half — the three
legal oracle sources, the four rules, RED-is-recorded — **upstream into carried `sdlc.md`**, which
leaves `testing-notes.md` holding a repository-specific remainder that no longer justifies a file of
its own, plus a copy of a rule that now exists upstream. The file has since grown to **153 lines**
(it was 136 when the measurement above was taken), so read it whole rather than trusting either
count.

**The change:** move the repository-specific remainder — the service-backed self-skip trap, ruling
out test pollution, the one-contract-suite-two-implementations pattern, where tests live and what
covers the frontend, and the pinned `fast-check` seed — into `docs/sdlc-local.md` under its existing
*Tests* section. Delete what carried `sdlc.md` now states. Delete the file.

**Referrers that must move in the same PR:** `README.md:65`, `CLAUDE.md` (3 references),
`docs/README.md` (index row), `docs/sdlc-local.md:166`,
`backend/tests/history/isolation.property.test.ts:23`, `docs/adr/0006-trusting-ai-written-tests.md`.

**Files:** all local. Nothing goes upstream — `acb` has no `testing-notes.md` and the generic
content already landed there via PR #235.

## Out of scope

**Gating `security-review` on the sensitive paths.** Running a full security review on every PR —
including the 34 August PRs that touched only documentation — is the largest single piece of
disproportionate review cost measured. **Deferred by decision on 2026-08-31; not part of this
work.** It is recorded here so the reasoning is not re-derived later. Nothing in C1/C3/C4 forecloses
it.

Also out of scope: trimming `sdlc.md` itself beyond C1's Phase 2 edit; changing the number of
reviews per PR; changing `PR shape` or one-child-per-PR; touching the mutation gate.

## Where each change lands

`acb` has two buckets and nothing between them. **Carried** files are byte-identical in every
consumer — `MANIFEST` lists them — so a local edit must be sent upstream with `acb propose <path>`
and pulled back. **Generated** files belong to this repository. Getting this wrong is not a style
error: a carried file edited only here is reverted by the next `acb pull`.

| Change | Carried files (→ `acb`) | Local files |
| --- | --- | --- |
| C1 | `writing-plans/SKILL.md`, `writing-plans/planning-reviewer-prompt.md`, `docs/sdlc.md` | — |
| C3 | `scripts/check-sdlc-sync.sh`, `scripts/tests/check-sdlc-sync.test.sh` | `.acb.json`, `docs/sdlc-local.md`, `CLAUDE.md` |
| C4 | — | `docs/testing-notes.md` (deleted), `docs/sdlc-local.md`, `CLAUDE.md`, `README.md`, `docs/README.md`, one test comment, ADR 0006 |

Two constraints bind every carried edit, both enforced by `acb`'s own `verify.sh`:

- **`tests/carried-purity.test.sh`** — no `igor-ka`, `llm-code-execution` or `llm-sandbox` may
  appear in a carried file, and `MANIFEST` must match the `carried/` tree in both directions.
- **`tests/skills-portability.test.sh`** — a carried document may not tell the reader to run one
  ecosystem's command (`npm test`, `npx`, `vitest run`), name a single tool as though it were the
  project's (`Vitest`, `ESLint`, `tsc`), or use an application noun (`backend/src`, `HistoryStore`,
  `Auth0`, `Cloud Run`). C1's wording must therefore be ecosystem-neutral.

`acb` also needs `schema/acb.schema.json` extended for `watchedExcept`, or `acb_config_validate`
will reject a consumer that sets it.

## Commands

```
Backend    cd backend  && ./verify.sh          # SKIP_INSTALL=1 SKIP_PACKAGE=1 for the inner loop
Frontend   cd frontend && ./verify.sh
Infra      cd infra    && ./verify.sh
acb        cd ../../../../acb && ./verify.sh         # carried-purity, skills-portability, sync, render
SDLC gate  ./scripts/check-sdlc-sync.sh        # BASE_SHA=<sha> PR_TITLE=... PR_ACTOR=...
Gate unit  ./scripts/tests/check-sdlc-sync.test.sh
Upstream   acb propose <path>...               # accepts several paths; one PR per invocation
```

## Testing strategy

The only executable change in this work is `check-sdlc-sync.sh`. Everything else is documentation,
and documentation is verified by running the gates that read it.

- **`scripts/tests/check-sdlc-sync.test.sh`** is the home for `watchedExcept`, and it first needs a
  **throwaway-git-repo harness** — decided 2026-09-01. Its two existing idioms cannot express these
  cases: `asserts`/`refutes` invoke the script but deliberately ignore its watched-ness verdict, and
  `watched`/`unwatched` grep the regex alternation without invoking the script at all. A regex-level
  assertion passes whether the subtraction happens before or after the decision, so it would not
  guard the one property this design is chosen for. New cases: a path matched by
  `watched` and by `watchedExcept` does not require the doc; a path matched by `watched` alone
  still does; an absent `watchedExcept` behaves exactly as today; an empty array likewise; a
  malformed one is a hard failure, not a silent pass.
- **The oracle for every one of those cases is this spec**, written before the code — the second
  legal source in `sdlc.md`'s *The oracle must not come from the implementation*. Not the
  implementation, which does not exist yet.
- **Assert both directions.** A subtraction gate that never fires and a subtraction gate that
  always fires both pass a one-directional test. Every case above has a paired opposite.
- **RED is recorded** — the failing output goes in the PR body before the implementation lands.
- The `SDLC docs` job is exercised end-to-end by stashing `docs/sdlc-local.md` and confirming the
  check fails, then restoring it.

## Boundaries

**Always:** run `acb`'s `verify.sh` before proposing any carried file; keep `watchedExcept`
optional and defaulting to empty; keep the gate failing closed; update `docs/sdlc-local.md` in the
same PR as any watched-path change.

**Ask first:** anything that changes what the gate *covers* beyond `^scripts/tests/`; any wording
in C1 that would let a plan omit a task's oracle or its verification step; deleting content from
`testing-notes.md` rather than moving it.

**Never:** edit a carried file and leave it un-proposed; widen `[skip-sdlc-sync]` usage in place of
fixing the watched list; remove the `No Placeholders` rule wholesale — C1 narrows what must be
shown, it does not license "TBD"; delete `testing-notes.md` content that carried `sdlc.md` does not
already state.

## Success criteria

S1. `.claude/skills/writing-plans/SKILL.md` says the same thing in all four places — `## Overview`,
   `## No Placeholders`, `## Remember` and the `## Task Structure` template. No rule remains that
   asks for code a task has already specified in prose, and no prohibition on vagueness was lost.
S2. `planning-reviewer-prompt.md` lists transcribed implementation code as a mechanical finding.
S3. `docs/sdlc.md` Phase 2's "real code" is replaced by the narrowed rule, and does not contradict
   the skill.
S4. All three are merged in `igor-ka/acb` and pulled back here, with `acb status` reporting
   `behind: 0` and `ahead: 0`.
S5. `acb`'s `./verify.sh` passes, `carried-purity` and `skills-portability` included.
S6. A PR that touches only `scripts/tests/**` passes `SDLC docs` without touching
   `docs/sdlc-local.md` and without `[skip-sdlc-sync]`.
S7. A PR that touches `scripts/mutation-scope.sh` still fails `SDLC docs` until the doc is updated.
S8. `docs/testing-notes.md` no longer exists; no reference to it remains outside `docs/plans/` and
   `docs/specs/`; every fact it held is either in `docs/sdlc-local.md` or in carried `docs/sdlc.md`.
S9. Backend, frontend and infra `verify.sh` all pass; the six required checks are green.

## Dependencies and collisions

**Sequencing, decided 2026-08-31: loopable-plans went first, and this work has been rebased onto
it. That stream is complete as of 2026-09-01 and no longer blocks.**

| Dependency | Status | What it means here |
| --- | --- | --- |
| **PR #235** `chore(acb): pull the oracle rule into carried sdlc.md` | **Merged** 2026-08-31 21:00 UTC; `origin/main` is `f06ac5a` | Satisfied. C1 and C4 both assume it |
| **loopable-plans, `acb` PR 0** | **Merged** (`acb` #17) | Adds a mandatory `## Definition of done` section and a conditional `**Human dependencies:**` header field to `writing-plans/SKILL.md`; two rows to the `## What to Check` table in `planning-reviewer-prompt.md`; prose in `docs/sdlc.md` §2 between the PR-boundaries paragraph and *The mandatory gate*. **The same three carried files as C1** |
| **loopable-plans, `acb` PR 1** | **Merged** (`acb` #18, plus #21–#23) | Adds carried `.claude/commands/loop-plan.md` — `MANIFEST` **25 → 26**. Also adds `^\.claude/commands/` to `acb init`'s scaffolded watched list in `lib/render.sh`, to carried `sdlc.md`'s rule list, and to `skills-portability.test.sh` and carried `check-sdlc-sync.test.sh` |
| **loopable-plans, consumer PR 2** | **Merged** (#243, #245–#248) | Runs `acb pull` and edits `.acb.json`, `docs/sdlc-local.md`, `CLAUDE.md` — **the same three local files as C3** |
| **`acb` schema for `watchedExcept`** | Not started — the only remaining dependency | Must merge before this repository sets the key, or `acb_config_validate` rejects `.acb.json` |

**Why the ordering is not symmetric.** `acb_cmd_pull` copies the whole `MANIFEST` unconditionally,
so whichever consumer PR pulls second inherits the other stream's carried files whether it reviewed
them or not. Serializing is what keeps each pull's diff readable, which is the only review a carried
file gets.

**The substantive tension, and why it is smaller than it looks.** loopable-plans *adds* required
sections to the plan template while C1 *narrows* what a plan must contain. These are orthogonal:
C1 removes transcribed implementation code, and `## Definition of done` is a table mapping spec
criteria to the tasks that discharge them — not code, and exactly the *what* C1 preserves.
`**Human dependencies:**` is conditional and omitted when empty, so it costs an ordinary plan
nothing. The rebase is therefore expected to be mechanical: C1 is authored **on top of** both
additions, and must leave them intact.

This work is done in the worktree `.claude/worktrees/trim-the-sdlc` on branch `docs/trim-the-sdlc`,
now based on `origin/main` at `58da06b`, with `acb` at `6359b03` and `acb status` clean. Several sessions share the main checkout and it moves
without warning — do not work in it.

## Open questions

1. **Does anything besides `^scripts/tests/` belong in `watchedExcept`?** `^\.github/workflows/` is
   the other broad entry, but job names are a required-check contract and `sdlc-local.md` enumerates
   them by hand. **Proposed:** no — leave workflows watched. Recorded so it is not reopened blind.
