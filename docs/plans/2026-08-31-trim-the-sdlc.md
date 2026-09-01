# Trim the SDLC — Implementation Plan

**Goal:** Cut per-change process overhead by narrowing what a plan must contain, narrowing what the
`SDLC docs` gate watches, and collapsing `testing-notes.md` into `sdlc-local.md` — with the carried half landing
in `igor-ka/acb` so it travels.

**Architecture:** Two of the three changes are **carried**, so they are edited here, sent upstream
with `acb propose`, merged in `acb`, and pulled back byte-identical. The third is purely local.
`acb pull` is all-or-nothing across `MANIFEST`, so both carried changes arrive in this repository in
a single pull — that is a property of the tool, not a bundling choice.

**Tech Stack:** Markdown; `bash` + `jq` for the gate; `gh` for the upstream PRs. No application code
changes.

**Spec:** [`docs/specs/2026-08-31-trim-the-sdlc.md`](../specs/2026-08-31-trim-the-sdlc.md) — read
its *Dependencies and collisions* table before starting.

**Ready.** loopable-plans has landed in full — `acb` PRs #17, #18, #21, #22, #23 and consumer PRs
#243, #245, #246, #247, #248. Rebased 2026-09-01 against consumer `origin/main` `58da06b` and `acb`
`origin/main` `6359b03`; `acb status` reports `behind: 0`, `ahead: 0`, `drift: none`, and every line
reference below was re-verified against those trees rather than carried forward.

**Epic:** [#249](https://github.com/igor-ka/llm-code-execution/issues/249) — its `## Children`
checklist and the open pull requests are where a pass reads its position from.

**Human dependencies:**
- **Merging the two `igor-ka/acb` pull requests.** `igor-ka/acb` declares no ruleset and `main` is
  unprotected, so the merge precondition *"the repository declares at least one required status
  check, and every one has reported success"* cannot be observed to hold there — an empty set fails
  it rather than satisfying it vacuously. Blocks Task 3 Step 5 and Task 5 Step 7; Task 6 cannot pull
  until both have landed, so criteria S1–S5 all sit behind this.

Nothing else here is human-only. Opening the epic and its children is ordinary `gh` work and is
Task 0.

**PR boundaries:**
- **PR 1 — `igor-ka/acb`:** what a plan contains — four rules across three carried files. Closes `acb` issue TBD.
- **PR 2 — `igor-ka/acb`:** `process.watchedExcept` in the carried sync gate, its test, and the
  schema. Closes `acb` issue TBD.
- **PR 3 — here:** `acb pull` + set `watchedExcept` + the local prose. Closes child issue TBD.
- **PR 4 — here:** fold `docs/testing-notes.md` into `docs/sdlc-local.md`. Closes child issue TBD.

PRs 1 and 2 are independent and can run in parallel. PR 3 requires both merged. PR 4 has no
remaining dependency — #235 landed on 2026-08-31 — and can start at any time.

**Worktree:** `.claude/worktrees/trim-the-sdlc`, branch `docs/trim-the-sdlc`, rebased onto
`origin/main` at `58da06b`. The shared checkout moves under other sessions — do not work in it.

---

## Task 0: Create the child issues

**Files:** none.

- [ ] **Step 1: Open two issues in `igor-ka/acb`** — one per upstream PR, titled for the change, each
      linking this plan by URL.
- [ ] **Step 2: Open two child issues here**, under epic #249, one for PR 3 and one for PR 4. The
      `PR shape` job requires each PR to close exactly one.
- [ ] **Step 3: Add both to the epic's children checklist**, as unchecked boxes. That checklist and
      the open pull requests are where a later pass reads its position from — this plan's own
      checkboxes are not progress, and nothing may infer position from them.
- [ ] **Step 4: Record the four issue numbers** in the `PR boundaries` header above, replacing
      `TBD`. This is the one edit to this plan that is permitted, and it is permitted only because
      this step names it.

---

## Task 1: What a plan contains — `writing-plans/SKILL.md` *(PR 1)*

**Files:**
- Modify: `.claude/skills/writing-plans/SKILL.md` — `## Overview` (the "the code" clause at line
  18), `## Task Structure` (147–194), `## No Placeholders` (195; the two rules at 202 and 203),
  `## Remember` (206; the rule at 208)

**Rebase note — verified against `acb` `origin/main` at `6359b03`.** This file already carries a
mandatory `## Criteria coverage` section at line 101 (**not** "Definition of done" — that name
belongs to `references/definition-of-done.md`, the standing bar, and the two are distinguished
explicitly at line 141), a conditional `**Human dependencies:**` header field at line 76, and a
Self-Review step 1 that builds the coverage table. Leave all three intact: they state *what* a plan
must settle, which is what the rules below preserve. Only transcribed implementation code is removed.

**One collision is real.** Commit `e3117ae` — proposed from this repository by a third session, not
by this work — edited the `## Task Structure` template's Step 1 to read
`**Step 1: Write the failing test** — *oracle: <where the expected value comes from>*` and added a
paragraph at 165–169 naming the three legal oracle sources. Step 4 below trims that template's code
blocks; **keep the oracle annotation and its paragraph**, and remove only the illustrative source.

There is **no line limit**. Four places in this file ask for the implementation to be transcribed
into the plan, and all four must change together or the document contradicts itself: `## Overview`
asks for "the code"; `## No Placeholders` requires code blocks for code steps and forbids "similar
to Task N"; `## Remember` asks for "complete code in every step"; and the `## Task Structure`
template demonstrates a code block per step, which is the shape authors copy.

- [ ] **Step 1: Fix `## Overview` (line 18)** — "which files to touch for each task, the code,
      testing, docs" becomes "which files to touch for each task, the code where the exact bytes are
      the decision, testing, docs". Without this the Overview and the rewritten `No Placeholders`
      say opposite things.
- [ ] **Step 2: Rewrite `## No Placeholders`** to keep every prohibition on vagueness — "TBD",
      "add appropriate error handling", "handle edge cases", steps that name no verification — and
      replace the code-transcription rules with: show code only where the exact bytes are the
      decision (a regex, a schema, a wire format, a security-critical assertion, a command whose
      flags are load-bearing); elsewhere name the behaviour and the signature. Replace "repeat the
      code" with "cross-reference freely within one plan; never cross-reference out of it".
- [ ] **Step 3: Update `## Remember`** — "Complete code in every step" becomes "Exact paths, exact
      commands, and code where the bytes are the decision".
- [ ] **Step 4: Trim the `## Task Structure` template** so the example matches the rule: keep the
      `**Files:**` block, the numbered steps, the run/expected lines and the commit step; replace the
      two illustrative source-code blocks with a one-line statement of the behaviour and signature
      each step produces. An example that contradicts the rule is the rule authors will follow.
- [ ] **Step 5: Keep every prohibition on vagueness.** "TBD", "add appropriate error handling",
      "handle edge cases", "write tests for the above", a step with no verification — all stay. This
      change narrows what must be shown; it licenses nothing to go unsaid.
- [ ] **Step 6: Keep the wording ecosystem-neutral.** No `npm`/`npx`/`vitest`/`tsc`, no
      `backend/src`, no `Auth0`. `acb`'s `tests/skills-portability.test.sh` fails otherwise.
- [ ] **Step 7: Verify** — `cd ../../../../acb && ./verify.sh` after Task 3's propose. Expected: pass.

**Oracle:** the spec's C1 section, written before this edit. Not the current skill text.

---

## Task 2: The same rule in the reviewer prompt and `sdlc.md` *(PR 1)*

**Files:**
- Modify: `.claude/skills/writing-plans/planning-reviewer-prompt.md`
- Modify: `docs/sdlc.md` — `### 2. Plan` (line 149); the "real code" clause is at line 154

- [ ] **Step 0: Confirm the rebase.** `planning-reviewer-prompt.md` carries `| Test oracles |`
      (line 29, from `e3117ae`), `| Criteria coverage |` (31) and `| Human dependencies |` (32);
      `docs/sdlc.md` §2 carries prose for the last two at lines 163 and 176. Add one row to that
      table; replace none of them. Re-check these line numbers before editing — three separate
      streams have moved this file today.
- [ ] **Step 1: Add one item to the reviewer's mechanical bucket** — a code block that transcribes
      an implementation the plan has already specified in prose. The correction is exact (replace it
      with the signature and the behaviour), so it needs no judgment. Do **not** add a length check;
      there is no number to check.
- [ ] **Step 2: Replace "real code" in `docs/sdlc.md` (line 154)**, in the paragraph that says plans
      are "bite-sized steps with exact file paths, real code, and exact commands", with the narrowed
      rule from Task 1. The two documents must not disagree.
- [ ] **Step 3: Check both files against `carried-purity`** — no `igor-ka`, `llm-code-execution`.
- [ ] **Step 4: Do not commit these edits here.** Task 3 proposes all three files upstream in one
      `acb propose`; they return to this repository via `acb pull` in Task 6.

**Oracle:** the spec's C1 section.

---

## Task 3: Send PR 1 upstream *(PR 1)*

**Files:** none here — the edits from Tasks 1–2 are sent, not committed to this repository.

A carried file is never merged into this repository by hand. It is edited here, proposed, merged
upstream, and pulled back byte-identical. Committing it here instead would make the next `acb pull`
either a no-op that hides the divergence or a revert.

- [ ] **Step 1: Confirm the toolkit checkout is clean** — `git -C ../../../../acb status --porcelain`
      must print nothing, or `propose` refuses.
- [ ] **Step 2: Propose all three files in one invocation**, which produces one upstream branch and
      one PR:

```bash
acb propose .claude/skills/writing-plans/SKILL.md \
            .claude/skills/writing-plans/planning-reviewer-prompt.md \
            docs/sdlc.md
```

- [ ] **Step 3: Fix the upstream PR title.** `propose` names the PR after `basename "$PWD"`, which
      in this worktree is `trim-the-sdlc`. Retitle it to name the change and link the `acb` issue.
- [ ] **Step 4: Run `acb`'s own gate** — `cd ../../../../acb && ./verify.sh`. Expected: pass, including
      `carried-purity` and `skills-portability`.
- [ ] **Step 5: Review and merge upstream**, then discard the local carried edits here:
      `git checkout -- .claude/skills/writing-plans docs/sdlc.md`. They return in PR 3.

---

## Task 4: `watchedExcept` — the failing test first *(PR 2)*

**Files:**
- Modify: `scripts/tests/check-sdlc-sync.test.sh` (carried)

Write the test before the implementation. Its oracle is the spec's C3 section — the second legal
source in `sdlc.md`'s *The oracle must not come from the implementation*.

**Rebased onto loopable-plans' `acb` PR #18, which landed.** This carried file now runs **16**
assertions, and line 156 is `watched "commands are watched" ".claude/commands/loop-plan.md"`. Add to
the fixture; do not rewrite it.

**The harness gap is confirmed, not suspected.** The file has exactly two idioms: `asserts`/`refutes`
(lines 57 and 78) invoke the script but deliberately ignore its watched-ness verdict, and
`watched`/`unwatched` (133, 142) grep the alternation and never invoke the script at all. Cases 1–4
below need a verdict against a controlled diff, which neither can express — so this task must first
build a throwaway-git-repo harness. That is the open decision recorded in the review log.

- [ ] **Step 1: Build the harness first.** Add a helper that creates a throwaway git repository in
      a `mktemp -d`, writes a fixture `.acb.json` and process document into it, commits a base,
      commits a second commit touching the paths under test, and runs `check-sdlc-sync.sh` against
      it with `BASE_SHA` set to the base commit — returning the exit status. It must clean up on
      every exit path, and must not touch the repository the suite runs from. This is what lets a
      case assert a *verdict on a diff*, which neither existing idiom can. Approved 2026-09-01.
- [ ] **Step 2: Add five cases** on that harness:
  1. a path matched by `watched` **and** by `watchedExcept` → gate passes with no doc edit;
  2. a path matched by `watched` alone → gate still fails without the doc edit;
  3. `watchedExcept` absent → behaviour identical to today;
  4. `watchedExcept: []` → behaviour identical to today;
  5. `watchedExcept` present but not an array of strings → **hard failure**, non-zero exit, no
     silent pass.
- [ ] **Step 3: Assert both directions.** Cases 1 and 2 are the pair: a subtraction that never fires
      and one that always fires both pass a one-directional test. Case 5 exists because a gate that
      fails open on malformed config is the one failure mode a gate must not have.
- [ ] **Step 4: Run it and record RED** — `./scripts/tests/check-sdlc-sync.test.sh`. Expected: 16
      existing assertions pass, new cases 1 and 5 fail, new cases 2, 3 and 4 pass. Paste the output
      into the PR body.

---

## Task 5: `watchedExcept` — the implementation *(PR 2)*

**Files:**
- Modify: `scripts/check-sdlc-sync.sh` (carried) — the config block at lines 26–35, and the
  decision at line 83 (`watched="$(printf '%s\n' "$changed" | grep -E "$WATCHED_RE" || true)"`)
- Modify: `schema/acb.schema.json` in `igor-ka/acb` (not carried; edited there directly)

- [ ] **Step 1: Read the optional key** beside the existing `WATCHED_RE`, defaulting to empty, and
      hard-fail on a malformed value the way the missing-config branch above it already does.
- [ ] **Step 2: Subtract before deciding.** The script greps the changed-file list once against
      `WATCHED_RE`; the exclusion filters that result. Order matters — subtracting after the
      decision is a no-op, and the test's case 1 is what catches it.
- [ ] **Step 3: Keep it failing closed.** An empty or absent `watchedExcept` must leave every
      currently-watched path watched. Case 3 and case 4 are the guard.
- [ ] **Step 4: Extend `schema/acb.schema.json`** with `watchedExcept` as an optional array of
      strings, so `acb_config_validate` accepts a consumer that sets it. Without this, PR 3's
      `.acb.json` is rejected.
- [ ] **Step 5: Run the test to GREEN** — `./scripts/tests/check-sdlc-sync.test.sh`. Expected: all
      cases pass.
- [ ] **Step 6: Run `shellcheck` via `acb`'s lint** — `cd ../../../../acb && ./verify.sh lint`.
- [ ] **Step 7: Propose and merge upstream:**

```bash
acb propose scripts/check-sdlc-sync.sh scripts/tests/check-sdlc-sync.test.sh
```

Then commit the schema change directly in `acb` on the same branch, retitle the PR, and merge.
Discard the local carried edits afterwards: `git checkout -- scripts/`.

---

## Task 6: Pull both carried changes down *(PR 3)*

**Files:**
- Modify: `.claude/skills/writing-plans/SKILL.md`, `.claude/skills/writing-plans/planning-reviewer-prompt.md`,
  `docs/sdlc.md`, `scripts/check-sdlc-sync.sh`, `scripts/tests/check-sdlc-sync.test.sh`, `.acb.json`
  (all written by `acb pull`)

- [ ] **Step 1: Confirm PRs 1 and 2 are merged** and `../../../../acb` is on `main` at that merge.
- [ ] **Step 2: Commit or stash anything outstanding** — `pull` refuses a dirty tree, deliberately,
      because the diff it produces is the only review there is.
- [ ] **Step 3: Pull** — `acb pull`. Expected: `✓ pulled 26 carried file(s) at <sha>` — 26, not 25:
      loopable-plans adds carried `.claude/commands/loop-plan.md`.
- [ ] **Step 4: Read the diff** — `git diff`. loopable-plans has already pulled (consumer #248,
      `acb status` clean at `6359b03`), so the diff must be exactly the five files above plus
      `.acb.json`'s `template.commit`. Anything else is a fourth stream's carried change arriving
      unreviewed — stop and report it rather than committing it.
- [ ] **Step 5: Confirm sync state** — `acb status`. Expected: `behind: 0`, `ahead: 0`.

---

## Task 7: Set `watchedExcept` and update the prose *(PR 3)*

**Files:**
- Modify: `.acb.json` — add `process.watchedExcept`
- Modify: `docs/sdlc-local.md` — `## Changing this SDLC` (17), the watched list at lines 21–47
- Modify: `CLAUDE.md` — the contract paragraph at lines 21–26 (it now names `.claude/commands/**`)

- [ ] **Step 1: Add the exclusion** to `.acb.json`, with `^scripts/tests/` as its only entry.
      **Preserve all eleven existing `watched` entries** — `^\.claude/commands/` is now among them
      (added by consumer #243) and must not be reverted.
- [ ] **Step 2: State the exclusion and its reason** in `docs/sdlc-local.md`'s bullet list: a change
      to a script's test does not change the contract this document records, and 26 file touches in
      August paid a documentation edit or reached for `[skip-sdlc-sync]` for no gain.
- [ ] **Step 3: Update `CLAUDE.md`'s contract paragraph** to name the exclusion, so a session that
      reads only `CLAUDE.md` is not surprised by a gate that stays green.
- [ ] **Step 4: Prove the gate still fires.** The gate reads `git diff --name-only "$base" HEAD` —
      **committed** state only — so a stash proves nothing. Use a scratch branch:

```bash
git checkout -b scratch/gate-proof
git add .acb.json && git commit -qm "wip: watched-except only"
BASE_SHA=origin/main ./scripts/check-sdlc-sync.sh; echo "exit=$?"     # expect exit=1
git add docs/sdlc-local.md && git commit -qm "wip: doc"
BASE_SHA=origin/main ./scripts/check-sdlc-sync.sh; echo "exit=$?"     # expect exit=0
git checkout docs/trim-the-sdlc && git branch -D scratch/gate-proof
```

- [ ] **Step 5: Prove the exclusion works, and that it measured something.** An uncommitted file
      never enters the diff, so the gate would print `✓ no SDLC-governed files changed` — the same
      output a working exclusion produces, which cannot tell success from "nothing was measured".
      Commit the file first and assert it is in the diff:

```bash
git checkout -b scratch/exclusion-proof
touch scripts/tests/worktree-new.test.sh && git add -A && git commit -qm "wip: test only"
git diff --name-only origin/main HEAD          # must print scripts/tests/worktree-new.test.sh
BASE_SHA=origin/main ./scripts/check-sdlc-sync.sh; echo "exit=$?"     # expect exit=0
git checkout docs/trim-the-sdlc && git branch -D scratch/exclusion-proof
```
- [ ] **Step 6: Verify and commit** — `cd backend && ./verify.sh` and `cd frontend && ./verify.sh`
      (no source changed, but the six required checks must be green), then commit and open PR 3.

---

## Task 8: Fold `testing-notes.md` into `sdlc-local.md` *(PR 4)*

**Files:**
- Delete: `docs/testing-notes.md`
- Modify: `docs/sdlc-local.md` — `## Tests: what the oracle rule adds here` (line 85)

PR #235 moved the generic half of this file upstream into carried `docs/sdlc.md`. What remains is a
repository-specific remainder plus a copy of a rule that now exists upstream.

- [ ] **Step 1: Move the seven repository-specific passages** into `docs/sdlc-local.md`'s existing
      *Tests* section: the service-backed self-skip trap; ruling out test pollution; one contract
      suite against two implementations; where tests live and what covers the frontend; the pinned
      `fast-check` seed; the **semantic mutants** passage (`testing-notes.md:80–90` — the four named
      holes in `mutants.ts`, and `historyMutants.ts`'s per-method owner-filter drop asserted as
      INV-7); and **"one long-lived server per owner, not one per assertion"**
      (`testing-notes.md:148–153` — the ephemeral-server, port-0 and delegating-proxy trap). The
      last two exist in neither the earlier list nor carried `sdlc.md`, so dropping them is a loss.
      The file is **153 lines**, not the 136 the spec measured on 2026-08-31; re-read it whole before
      moving anything.
- [ ] **Step 2: Delete only what carried `sdlc.md` now states** — the three legal oracle sources and
      the four rules. Diff the two documents before deleting anything; a passage that exists in
      neither is a loss, not a de-duplication.
- [ ] **Step 3: Delete the file** — `git rm docs/testing-notes.md`.

---

## Task 9: Update every referrer *(PR 4)*

**Files:**
- Modify: `README.md:65`, `CLAUDE.md` (lines 109, 159, 169), `docs/README.md:8` (the index row
  only — the "Which one am I writing?" block does not reference the file), `docs/sdlc-local.md:184`
  (in *The mutation gate*, outside the *Tests* section Task 8 rewrites),
  `backend/tests/history/isolation.property.test.ts:22`

- [ ] **Step 1: Repoint each reference** in `README.md`, `CLAUDE.md`, `docs/README.md:8`,
      `docs/sdlc-local.md:184` and the property test's comment to `docs/sdlc-local.md` or to carried
      `docs/sdlc.md`, whichever now holds the fact being cited.
- [ ] **Step 1a: ADR 0006 needs no change** — `grep -n testing-notes docs/adr/0006-*.md` returns
      nothing; it never referenced the file. An ADR is superseded, never rewritten, in any case.
- [ ] **Step 2: Prove nothing dangles:**

```bash
grep -rn "testing-notes" . --exclude-dir=node_modules --exclude-dir=.git
```

Expected: matches only inside `docs/plans/` and `docs/specs/` — historical plans and specs are not
rewritten, and this change's own spec cites the file it removes.

- [ ] **Step 3: Verify** — `cd backend && ./verify.sh test` (the property test's comment changed) and
      `cd frontend && ./verify.sh`. Expected: pass.
- [ ] **Step 4: Note that `SDLC docs` requires nothing here.** PR 4 touches no watched path — not
      `docs/**`, not `CLAUDE.md`, not `README.md`, not `backend/tests/**`. The `docs/sdlc-local.md`
      edit in Task 8 is the substance of the change, not a gate obligation. Do not reach for
      `[skip-sdlc-sync]`; the gate passes on its own.
- [ ] **Step 5: Commit and open PR 4.**

---

## Verification checkpoints

| After | Check | Expected |
| --- | --- | --- |
| Task 3 | `cd ../../../../acb && ./verify.sh` | pass, `skills-portability` included |
| Task 4 | `./scripts/tests/check-sdlc-sync.test.sh` | 16 existing pass; new cases 1 and 5 fail — RED, recorded in the PR body |
| Task 5 | `./scripts/tests/check-sdlc-sync.test.sh` | all 21 pass |
| Task 6 | `acb status` | `behind: 0`, `ahead: 0` |
| Task 7 | gate on a scratch branch, `.acb.json` committed and the doc not | `exit=1`, then `exit=0` |
| Task 7 | gate on a committed `scripts/tests/`-only diff, asserted present in `git diff` | `exit=0` |
| Task 9 | `grep -rn "testing-notes"` | `docs/plans/` and `docs/specs/` only |
| PR 3, 4 | six required checks | green |

## Rollback

Each PR is independently revertible. C1 reverts by proposing the previous text upstream and pulling.
C3 reverts by removing `watchedExcept` from `.acb.json` — the carried mechanism is inert when the
key is absent, which is why it defaults to empty. C4 reverts by `git revert`.

## Criteria coverage

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S1 | Task 1 Steps 1–5 — all four places in `SKILL.md`, plus the prohibitions kept intact. |
| S2 | Task 2 Step 1. |
| S3 | Task 2 Step 2. |
| S4 | Task 3 Step 5 and Task 6 Step 5 — `acb status` reporting `behind: 0`, `ahead: 0`. |
| S5 | Task 1 Step 7 and Task 5 Step 6. |
| S6 | Task 7 Step 5 — the exclusion proof, with its diff assertion. |
| S7 | Task 7 Step 4 — the scratch-branch proof that the gate still fires. |
| S8 | Tasks 8 and 9, verified by Task 9 Step 2's grep. |
| S9 | Task 7 Step 6 and Task 9 Step 3. |

**Not claimed:** none — this plan claims all of them.

## Plan review log

Staff-engineer review 2026-08-31 — **applied without asking:**
- Every `../../acb` → `../../../../acb` (Tasks 1, 3, 5, 6 and the checkpoint table). From this
  worktree `../..` is `.claude/`, not the workspace root; the toolkit is four levels up.
- Task 2 Step 4: "Commit both tasks together" → "Do not commit these edits here", which contradicted
  Task 3's `git checkout --` discard and its "none here" Files line.
- Task 7 Step 4: the stash proof replaced by a scratch-branch proof. The gate reads
  `git diff --name-only "$base" HEAD` — committed state only — so a stashed change is invisible and
  the step could never produce the `exit=1` it claimed.
- Task 7 Step 5: added a commit and a `git diff --name-only` assertion. An uncommitted file yields
  `✓ no SDLC-governed files changed`, the same output a working exclusion gives, so the step could
  not tell success from "nothing was measured".
- Task 8 Step 1: five passages → seven. The semantic-mutants passage (`testing-notes.md:80–90`) and
  "one long-lived server per owner" (`131–136`) are in neither the old list nor carried `sdlc.md`.
- Task 9 Files: dropped `docs/adr/0006-*` (it never referenced the file — verified by grep), scoped
  `docs/README.md` to line 8, and added the missing `docs/sdlc-local.md:166`.
- Task 9 Step 1a: reworded — the ADR needs no change rather than needing a superseding note.
- Task 9 Step 2: expected grep output now includes `docs/specs/`, which also matches.
- Task 1: added `## Overview` (line 19) to the Files list and a step fixing it, so all four places in
  `SKILL.md` say the same thing.

**Applied on the user's instruction, not the reviewer's:** the 300-line cap was dropped. C1 is now
the content rules alone, and `## Task Structure` is trimmed to match them.

**Rebased 2026-09-01 against consumer `58da06b` and `acb` `6359b03`** — loopable-plans complete.
Every file path and line number in this plan was re-verified against those trees: `SKILL.md`'s four
edit sites moved (18 / 147–194 / 195 / 206), `sdlc.md`'s "real code" clause is at 154,
`sdlc-local.md`'s watched list is at 21–47 and its `testing-notes` reference at 184, `CLAUDE.md`'s
three references are at 109 / 159 / 169, the property test's comment is at 22, and
`testing-notes.md` grew to 153 lines so the long-lived-server passage moved to 148–153. A
`**Human dependencies:**` header field was added — the plan needs four issues opened and two
upstream merges, which is exactly what the field is for and what `/loop-plan` stops on.

**Rebased 2026-08-31 against `acb` `10fc136`** — Task 1's rebase note corrected (`## Criteria
coverage`, not "Definition of done"), Task 2 Step 0 rewritten against the reviewer prompt's actual
rows, the `e3117ae` oracle annotation flagged as must-keep when Step 4 trims the template, and a
`## Criteria coverage` section added to this plan under the rule it is rebasing onto. The spec's
success criteria were renumbered `S1`–`S9` so the table can name them.

**Escalated to the user — resolved:** the loopable-plans collision. Decided 2026-08-31: that stream
lands first, this one rebases. The spec's *Dependencies and collisions* section and Tasks 1, 2, 6 and
7 were updated to match, and PR #235's row was marked merged.

**Escalated to the user — still open and blocking:** whether the `watchedExcept` test needs a
throwaway-repo harness (Task 4/5), and the spec's *Commands* line claiming `acb propose` takes one
path per invocation, which is false — `acb_cmd_propose` iterates `for p in "$@"`.
