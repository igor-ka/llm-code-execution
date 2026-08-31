# Trusting AI-Written Tests — Implementation Plan

**Goal:** Make the trustworthiness of this repository's tests measurable where a machine can measure
it (a diff-scoped mutation gate that blocks on survivors and on uncovered changed lines) and binding
where it cannot (rules that keep a test's oracle out of the implementation).

**Architecture:** Three independent mechanisms, shipped rules-first. (1) Written rules in
`CLAUDE.md` / `docs/sdlc-local.md` / `docs/testing-notes.md` plus a seeded escaped-defect log — no
code. (2) A `verify.sh mutation`
target: a shell script turns `git diff` hunk headers into Stryker line-range patterns, Stryker runs
Vitest against each mutant, and a Node decision script fails the build on any mutant whose status is
`Survived` or `NoCoverage`. CI runs the same target as a backstop. (3) `fast-check` property tests
that generalise the INV-1..8 isolation invariants from hand-picked cases to generated operation
sequences.

**Tech Stack:** `@stryker-mutator/core` 10.0.0 + `@stryker-mutator/vitest-runner` 10.0.0 (peer
`vitest >=2.0.0`; backend is on 3.2.6), `fast-check` (new), Node 22, bash, GitHub Actions.

**PR boundaries:** three PRs, one child issue each. Task 0 creates the epic and the three children
and records the assigned numbers in this header before PR 1 is opened.

- **PR 1 — the rules, docs only.** Spec + ADR + `docs/escaped-defects.md` + `CLAUDE.md` testing
  standards + `docs/testing-notes.md` reasoning + `docs/sdlc-local.md` process edits. No code, no
  CI change. Closes child 1.
- **PR 2 — the diff-scoped mutation gate.** `scripts/mutation-scope.sh`,
  `scripts/mutation-decide.mjs`, three self-tests, `backend/stryker.conf.mjs`,
  `backend/verify.sh mutation`, the `Mutation test` CI step, docs. Closes child 2.
- **PR 3 — property-based invariants.** `fast-check`, INV-1 and INV-5 as generated operation
  sequences, pinned seed. Closes child 3.

PR 2 depends on PR 1 only for the written rationale; nothing in it imports from PR 1. PR 3 is
independent of both and could land first — it is ordered last because it is the least urgent.

**Status: ready (unblocked 2026-08-30).** `acb` adoption landed in #217, #218, #223, #224 and #225,
and `acb status` reports **0 behind, 0 ahead, no drift**. This plan was re-verified against the
post-adoption tree on 2026-08-30; what changed is recorded in *Where this work lands* → *Verified
against the post-adoption tree*. Three things moved and the affected tasks were rewritten: the
process document this repository edits, the `verify.sh` target contract, and the required-check
count.

**Where the work lands:** all three PRs are in `llm-code-execution`. `acb` is not modified by this
plan — but it constrains how two of these files are written, and post-adoption it changes where two
of them are edited. See *Where this work lands* below; read it before Task 0.

**Source documents:** spec
[`2026-08-28-trusting-ai-written-tests`](../specs/2026-08-28-trusting-ai-written-tests.md), ADR
[`0006`](../adr/0006-trusting-ai-written-tests.md).

**Two decisions already made by the user (2026-08-29):** surviving mutants **block** the merge, and
changed lines with **no coverage count as survivors**.

---

## Where this work lands: `llm-code-execution` vs `acb`

**The situation, as of 2026-08-30.** [`acb`](https://github.com/igor-ka/acb) — the toolkit that
installs this repository's development process into other repositories — is built, and
**`llm-code-execution` is now consumer #1**. Adoption landed in #217 (spec), #218 (plan), #223 (the
`verify.sh` contract), #224 (the carried set and `.acb.json`) and #225 (the generated layer).
`acb status` reports **0 behind, 0 ahead, no drift**.

So the buckets are no longer a forecast. They are the tree this plan is written against:

| This work | Bucket | What that means here |
| --- | --- | --- |
| `scripts/mutation-{scope,decide,suppressions}` + their tests | **new files in a carried directory** | Not edits to carried files, so no drift. Candidates to `acb propose` upstream later |
| The eligible set | **`.mutation-scope.json`**, read at runtime | Folding it into `.acb.json` needs an upstream schema change — see (6) above |
| `CLAUDE.md` testing standards | **generated-then-owned** | Re-rendered at init, never touched again by `acb pull`. Editing it is correct |
| `docs/testing-notes.md` | **this repository's own** | Created by adoption to hold what the now-carried TDD skill had to drop |
| `docs/sdlc-local.md` | **this repository's own**, and `process.doc` | The file the `SDLC docs` gate requires a PR to update |
| `docs/sdlc.md` | **carried, byte-identical** | Off-limits. An edit makes the repo *ahead* and `acb pull` reverts it |
| Skill edits | **carried** | Not made — see concession 4 |
| `docs/escaped-defects.md` | **this repository's own** | The convention could travel; the four entries are this repository's history |
| `Mutation test` CI step | **generated-then-owned** | `ci.yml` kept its comments, services and `@v7`; a hand-edit is safe |
| `verify.sh` targets | **contract-enforced** | `TARGETS` + `.acb.json` + dispatch must agree, checked by `scripts/check-conformance.sh` |
| `stryker.conf.mjs`, the fixture, the `vitest.config.ts` exclude | **this repository's own** | Node- and Vitest-specific |
| Property tests on INV-1/INV-5 | **this repository's own** | INV-1..8 is this repository's history isolation. Nothing travels |

**Three concessions this plan makes so the work can be carried later without rework:**

1. **`scripts/mutation-scope.sh` holds no repo-specific list.** The eligible set is declared in
   `.mutation-scope.json` and read at runtime, which is the shape a carried file must already have.
   Moving it into acb later is `cp` plus folding that JSON into `.acb.json` — not the de-hardcoding
   exercise acb's own PR #2 had to do to the two existing gate scripts.
2. **The gate is a *step* inside `Backend checks`, not a new job.** `.github/ruleset.json` now
   declares **six** required checks — `Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape`,
   `Terraform checks` and `Deploy scripts` — and is itself a watched file. A step means that file
   needs no change at all, which post-adoption is verifiable rather than assumed.
3. **The three scripts are plain bash with no repo-specific paths**, so they can move into
   `carried/scripts/` unchanged. Their *test* suites deliberately differ from
   `scripts/tests/check-conformance.test.sh`: that one uses `set -uo pipefail` and counts failures
   so it reports all of them, while these use `set -euo pipefail` and exit on the first. Aligning
   them is worth doing before proposing them upstream; it is not worth doing here, where the first
   failure is the one you fix.
4. **No skill file is edited.** "RED is recorded" is arguably a `test-driven-development` change and
   the planted-hole question a `security-and-hardening` one, but `.claude/skills/**` is carried and
   was generalised in acb PR #3, so editing it here widens a gap adoption has to close. Both rules
   land in `CLAUDE.md` instead — which is generated, is the consumer's own, and is loaded every
   session rather than on demand. It is the stronger channel anyway.

**What is deliberately deferred to the adoption plan**, and should be listed in it rather than
attempted here:

- Moving the three scripts and their tests into `carried/scripts/`, and their names into `MANIFEST`.
- Folding `.mutation-scope.json` into `.acb.json`, and extending `schema/acb.schema.json` with the
  keys — most likely `components[].mutation: { root, include[], exclude[] }`.
- Adding the `Mutation test` and `Mutation gate self-test` steps to `templates/ci.yml.component`,
  gated on whether the component declares a mutation block.
- Proposing the generic half upstream with `acb propose`, now that this repository is a consumer:
  the testing standards into `templates/CLAUDE.md.tmpl` and the oracle rule into acb's carried
  `docs/sdlc.md`, so every future consumer gets them. Deliberately **after** this plan lands — the
  rules should be proven here before they are pushed at every other repository.

**RESOLVED 2026-08-29 — wait for adoption.** The open question was whether PR 1's rules should be
authored in `acb` first. Neither: adoption is close, so the plan waits for it. Once this repository
is a consumer, "author here, `acb propose` upstream" stops being a compromise and becomes the
designed workflow — and PR 1 gets written once instead of twice.

### Verified against the post-adoption tree (2026-08-30)

Each point of the pre-adoption checklist, checked against what actually landed.

1. **`CLAUDE.md` is generated-then-owned, and Task 2's anchor survived.** It was re-rendered from
   `templates/CLAUDE.md.tmpl` but keeps a `## Review process` section (line 105), so the insertion
   point still exists. Generated files are the consumer's own and `acb pull` never touches them
   again — editing it here is correct and creates no drift. **No change to Task 2's mechanics**, but
   the depth moves: see (8).
2. **`docs/sdlc.md` split into THREE files, and the one this plan edits is not the one it named.**
   `docs/sdlc.md` (737 lines) is **carried and byte-identical with acb — verified with `diff`, and
   it must not be edited here**; `docs/sdlc-example.md` (119) is the worked example; and
   **`docs/sdlc-local.md` (261) is `process.doc` in `.acb.json` — the file the `SDLC docs` gate
   actually requires a PR to update.** Tasks 3 and 13 are rewritten against it. Every anchor those
   tasks used to quote lives in the carried file and is off-limits: editing it would make this
   repository *ahead*, and `acb pull` would revert it on its next run.
3. **`ci.yml` is generated-then-owned, so Task 12's hand-edit is safe.** It kept every original
   comment, the service containers and `actions/checkout@v7` — it is not re-rendered. The earlier
   worry was wrong. What *is* new is (4).
4. **The `verify.sh` contract changed, and it is now enforced.** #223 renamed `docker` → `package`
   and `SKIP_DOCKER` → `SKIP_PACKAGE` (no collision with `mutation`), and added a `TARGETS` list, a
   `--targets` flag, and **exit 64** for an unknown target. `scripts/check-conformance.sh` runs as
   the *Verify.sh contract* step in `SDLC docs` and asserts, **in both directions**, that
   `./verify.sh --targets` equals the component's `targets[]` in `.acb.json` — and that every
   declared target dispatches *and propagates failure*, probed by planting `false` inside every
   function. Task 10 is rewritten for this: a new target must be added in three places at once or
   the gate fails.
5. **The three new scripts create no drift.** `check-pr-shape.sh`, `check-sdlc-sync.sh` and
   `check-conformance.sh` are byte-identical with acb (verified); `mutation-scope.sh`,
   `mutation-decide.mjs` and `mutation-suppressions.sh` are *new files*, not edits to carried ones.
   `scripts/**` is watched, so `docs/sdlc-local.md` must be updated in the same PR — Task 13.
6. **`.mutation-scope.json` stays a separate file, for now.** Folding it into `.acb.json` needs
   `schema/acb.schema.json` extended upstream and `acb` taught to carry it; the schema sets no
   `additionalProperties: false`, so an extra key would be tolerated but not understood. Doing it
   here would put a key in `.acb.json` that only this repository knows how to read. Left as an
   upstream follow-up.
7. **There are now SIX required checks, not five** — `Backend checks`, `Frontend checks`,
   `SDLC docs`, `PR shape`, `Terraform checks` and the new **`Deploy scripts`** — and they are
   declared in-repo at `.github/ruleset.json`, which is itself watched. Keeping the mutation gate a
   *step* inside `Backend checks` means that file needs no change at all, which is now verifiable
   rather than assumed.
8. **New: `docs/testing-notes.md` exists, and it is the right home for the oracle reasoning.**
   Adoption moved the `test-driven-development` skill's repo-specific section there, because the
   skill is now carried and stack-agnostic. It already frames `memoryStore` as *"a **fake**, not a
   mock … it doubles as the **oracle** the Postgres implementation is measured against"* — this
   plan's Mechanism 2 vocabulary, already in the repository. Task 2 now splits accordingly: the four
   rules go in `CLAUDE.md` (loaded every session), the reasoning and the three oracle sources go in
   `testing-notes.md`, which is exactly the division that file already declares.

PRs 2 and 3 are largely unaffected — the Stryker config, the fixture, the `vitest.config.ts`
exclude and the property tests are consumer-owned, and adoption does not touch them.

---

## File structure

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `docs/escaped-defects.md` | New | One line per defect that reached `main` and the gate that missed it |
| `CLAUDE.md` | Modified | The four testing rules + the three review questions |
| `docs/sdlc-local.md` | Modified | Where the oracle rule binds in the process; the mutation gate. **Not `docs/sdlc.md` — that is carried** |
| `docs/testing-notes.md` | Modified | The three legal oracle sources, extending vocabulary the file already uses |
| `.acb.json` | Modified | Declares the two new targets; adds `.mutation-scope.json` to `process.watched` |
| `docs/README.md` | Modified | Index the new doc; add `Proposed` to the ADR status list |
| `.mutation-scope.json` | New | **Declares** the eligible file set. The acb seam — folds into `.acb.json` at adoption |
| `scripts/mutation-scope.sh` | New | `git diff` hunk headers → Stryker `mutate` line ranges. Repo-agnostic; reads the declaration |
| `scripts/mutation-decide.mjs` | New | Reads Stryker's JSON report; fails on `Survived` / `NoCoverage` / unknown status |
| `scripts/tests/mutation-scope.test.sh` | New | Unit test: hunk parsing, eligibility, merge-base failure |
| `scripts/tests/mutation-decide.test.sh` | New | Unit test: the decision function fails on each blocking status |
| `scripts/mutation-suppressions.sh` | New | Rejects a `Stryker disable` comment that states no reason |
| `scripts/tests/mutation-suppressions.test.sh` | New | Unit test for the suppression rule |
| `scripts/tests/mutation-gate.test.sh` | New | End-to-end negative test: a weakened test makes the real gate fail |
| `backend/stryker.conf.mjs` | New | Stryker config. Deliberately carries no `mutate` key |
| `backend/verify.sh` | Modified | New `mutation` and `mutation:selftest` targets + dispatch + usage header + `TARGETS` |
| `backend/package.json` | Modified | Stryker (PR 2); `fast-check` (PR 3) |
| `backend/.prettierignore` | Modified | Keep Stryker output out of `format` |
| `backend/tests/fixtures/mutation-selftest/**` | New | The deliberately-weak fixture the gate self-test rejects |
| `backend/vitest.config.ts` | Modified | Exclude `tests/fixtures/**` so the weak self-test fixture never runs in the real suite |
| `.github/workflows/ci.yml` | Modified | `fetch-depth: 0`, `Mutation test` step, PRs only |
| `.gitignore` | Modified | `.stryker-tmp/`, `reports/`, `.mutation-selftest-strong/` |
| `.dockerignore` | Modified | Keep Stryker output out of the production image build context |
| `backend/tests/history/isolation.property.test.ts` | New | INV-1 and INV-5 as generated operation sequences |
| `backend/tests/fc.ts` | New | One `fc.configureGlobal` call: pinned seed, `FC_SEED` override |

**One definition of the eligible set, in `.mutation-scope.json`.** `stryker.conf.mjs` deliberately
has no `mutate` key, because a CLI `--mutate` **completely replaces** the config value rather than
merging with it — a second list would rot silently. And `scripts/mutation-scope.sh` holds no list
either: it is written repo-agnostic from the start so acb can carry it unchanged.

---

## Task 0: Create the epic and its three children

**Files:** none — GitHub only.

- [ ] **Step 1: Create the epic**

```bash
gh issue create --title "Epic: trust in AI-written tests — gate sensitivity, rule the oracle" --body "$(cat <<'BODY'
Most tests here are LLM-written. The evidence offered for them is a green suite and line coverage,
and neither answers "would this test notice if the code were wrong?"

Spec: docs/specs/2026-08-28-trusting-ai-written-tests.md
ADR: docs/adr/0006-trusting-ai-written-tests.md
Plan: docs/plans/2026-08-29-trusting-ai-written-tests.md

## Children
- [ ] The rules (docs only)
- [ ] The diff-scoped mutation gate
- [ ] Property-based invariants
BODY
)"
```

- [ ] **Step 2: Create the three children**

```bash
gh issue create --title "Testing rules: keep the oracle out of the implementation" --body "Ships the written rules and the escaped-defect log. Docs only, no code. Plan: docs/plans/2026-08-29-trusting-ai-written-tests.md (PR 1). Parent: <EPIC>"
gh issue create --title "Diff-scoped mutation gate blocking on survivors and uncovered lines" --body "Plan: docs/plans/2026-08-29-trusting-ai-written-tests.md (PR 2). Parent: <EPIC>"
gh issue create --title "Property-based tests for the INV-1..8 isolation invariants" --body "Plan: docs/plans/2026-08-29-trusting-ai-written-tests.md (PR 3). Parent: <EPIC>"
```

- [ ] **Step 3: Write the four assigned numbers into this plan's `PR boundaries` header**, replacing
  "child 1/2/3" with `closes #N`. Commit that edit on the PR 1 branch.

---

# PR 1 — the rules (docs only)

Worktree: `scripts/worktree-new.sh test-trust-rules` from the main checkout.

## Task 1: Seed the escaped-defect log

**Files:**
- Create: `docs/escaped-defects.md`

- [ ] **Step 1: Write the file**

```markdown
# Escaped defects

One line per defect that reached `main`, naming **the gate that should have caught it and did
not**. This is the calibration loop for [ADR 0006](adr/0006-trusting-ai-written-tests.md): it is the
only evidence that trust in this suite is rising rather than holding still. Ten lines say more than
any score; one line says nothing.

Append, never edit. A defect belongs here whether it was found in review, in production, or by
accident — what matters is that a gate existed and stayed green.

| Date | Defect | Gate that should have caught it | What changed |
| --- | --- | --- | --- |
| 2026-08-14 | The Content-Security-Policy was attached only by the Vite dev and preview servers, so a static deploy of `dist/` shipped with **no CSP at all** | The frontend unit tests on the policy builder — they asserted the policy's content and could not see that no server sent it | `frontend/verify.sh build` now asserts `dist/csp.txt` exists and carries a production `script-src` |
| 2026-08-16 | Negated image assertions (`! grep -q …`) silently passed on a bad image — POSIX exempts a command negated with `!` from `set -e` | The `docker` target's own in-image assertions | Rewritten as `if …; then exit 1; fi` in both `verify.sh` scripts |
| 2026-08-17 | A bare `python3` in an image assertion resolved on `PATH` and proved nothing about the sandbox, which runs with `PATH` empty — [#185](https://github.com/igor-ka/llm-code-execution/issues/185) reached production green | The production-image assertion battery | The assertion now uses the absolute `/usr/bin/python3` and imports numpy |
| 2026-08-18 | `npm audit` honours `npm_config_offline` and `npm_config_omit`/`NODE_ENV=production`, so the audit gate had two environment-driven bypasses that both failed **open** | The `Audit` step itself | `--no-offline --include=dev` state the intent explicitly rather than inheriting the environment |

Every entry above was found by **review**, not by the gate noticing. That is the pattern this log
exists to make visible.
```

- [ ] **Step 2: Commit**

```bash
git add docs/escaped-defects.md
git commit -m "docs: seed the escaped-defect log with four gates that did not fire"
```

## Task 2: Add the testing standards to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — insert a new section immediately after the `## Review process` section and
  before `## Don't assume — surface it`

- [ ] **Step 1: Insert the section**

```markdown
## Testing standards — keep the oracle out of the implementation

A test's **oracle** is whatever decides pass from fail, usually the expected value in the assertion.
These rules exist because most tests here are model-written, and a model asked to test existing code
reads the implementation and writes tests describing it — so a bug becomes the expected value. Such
a suite scores 100% on coverage *and* 100% on mutation testing. See
[ADR 0006](docs/adr/0006-trusting-ai-written-tests.md).

**The test:** if the implementation were deleted, could you still write this assertion? If no, the
oracle came from the code and the test is worth close to nothing.

1. **Never ask for tests after the code.** "Write the implementation, now add tests" guarantees an
   implementation-derived oracle, because there is nowhere else to get one. Write the test first,
   run it, and see it fail.
2. **An oracle has exactly three legal sources.** Written first (a test that failed before the code
   existed cannot have been copied from it); a document (a spec success criterion, a named invariant
   such as INV-1..8, a threat); or a second implementation (`tests/history/contractTests.ts` across
   memory and Postgres, `tests/limits/quotaContract.ts` across memory and Redis).
3. **Never edit an existing test to make it pass.** Two legal moves when a test fails: fix the code,
   or state why the expectation was wrong and get sign-off. Silently adjusting an expected value is
   how a generated suite rots into a transcript of whatever the code currently does.
4. **Mock only at process boundaries** — the Docker socket, Postgres, Redis, the Anthropic API, the
   Auth0 JWKS endpoint. Never mock the unit under test. A test that mocks its subject and asserts
   the mock was called proves wiring and nothing else.

**RED is recorded, not claimed.** Paste the failing output into the PR body, or commit RED
separately so `git show` proves it. This is deliberately not a CI check: a check for the presence of
a section cannot read what it checks, and a gate that cannot inspect what it gates is the
decorative-assertion pattern this repo has already had to fix once.

**Three questions every review asks:**
- Where did this expected value come from?
- Did any existing assertion change in this PR?
- Is anything mocked that is not a process boundary?

**Semantic mutants** — hand-authored holes expressing a threat, as in `backend/tests/mutants.ts` and
`backend/tests/history/historyMutants.ts` — are committed fixtures asserted by ordinary tests, and
are **never generated at CI time**. Authoring them belongs in the `security-and-hardening`
threat-model pass: for each threat, ask whether it is expressible as a planted hole.
```

- [ ] **Step 2: Verify the file still reads correctly around the insertion**

Run: `sed -n '/## Review process/,/## Documentation upkeep/p' CLAUDE.md | head -80`
Expected: the new section sits between `## Review process` and `## Don't assume — surface it`, with
one blank line either side.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: testing standards — the oracle must not come from the implementation"
```

- [ ] **Step 4: Put the reasoning in `docs/testing-notes.md`**, which adoption created for exactly
      this purpose — the `test-driven-development` skill is now carried and stack-agnostic, so
      repo-specific testing depth lives there. It already frames `memoryStore` as *"a **fake**, not
      a mock … it doubles as the **oracle** the Postgres implementation is measured against"*, so
      this section extends vocabulary the file already uses. Append:

```markdown
## Where an oracle may come from

A test's **oracle** is whatever decides pass from fail — usually the expected value in the
assertion. Most tests here are model-written, and a model asked to test existing code reads the
implementation and writes tests describing it, so a bug becomes the expected value. That suite
scores 100% on coverage *and* 100% on mutation testing: the tests are precisely sensitive to a
behaviour that is wrong.

**The test: if the implementation were deleted, could you still write this assertion?**

Three legal sources, all three already in use here:

| Source | The oracle is | Where |
| --- | --- | --- |
| Written first | A test that failed before the code existed cannot have been copied from it | The RED step; the Prove-It pattern for bugs |
| A document | A spec success criterion, a named invariant, a threat | INV-1..8 in `backend/tests/history/isolation.test.ts` |
| A second implementation | Two implementations must agree, so neither defines the answer | The contract suites above — and this is why `memoryStore` is a fake, not a mock |

**Semantic mutants** are the third source sharpened to a point: `backend/tests/mutants.ts` plants
four holes in the auth check, and `historyMutants.ts` drops one owner filter per method (asserted as
INV-7). Their oracle is the threat model; nothing about the implementation is consulted. They are
committed fixtures asserted by ordinary tests, **never generated at CI time** — a gate whose mutant
population changes between two runs of the same commit can pass and then fail with nothing changed.

Authoring them belongs in the `security-and-hardening` threat-model pass the *Sensitive paths* in
`CLAUDE.md` already require: for each threat, ask whether it is expressible as a planted hole.
```

- [ ] **Step 5: Commit**

```bash
git add docs/testing-notes.md
git commit -m "docs(testing): where an oracle may come from"
```

## Task 3: Fold the rules into docs/sdlc-local.md

**Files:**
- Modify: `docs/sdlc-local.md`

**Not `docs/sdlc.md`.** That file is **carried** — byte-identical with `acb`, verified by `diff`.
Editing it here would make this repository *ahead* of the toolkit and `acb pull` would revert the
edit on its next run. `docs/sdlc-local.md` is `process.doc` in `.acb.json` and is the file the
`SDLC docs` gate actually requires a PR to update.

**Do not document the mutation gate here.** It does not exist until PR 2, and a process document
describing a gate that is not wired is the decorative pattern these rules warn about. Task 13 adds
it.

- [ ] **Step 1: Add a section**, after `## The three components` and before
      `## The audit flags, and why they are written out`:

```markdown
## Tests: the oracle must not come from the implementation

Most tests here are model-written. The full reasoning and the three legal oracle sources are in
[`testing-notes.md`](testing-notes.md); the rules themselves are in [`../CLAUDE.md`](../CLAUDE.md)
under *Testing standards*. What belongs in this file is where they bind in the process:

- **Spec** — success criteria are written as observable behaviour, because they are the oracle
  every downstream test copies from. "The quota resets at the window boundary" is an oracle; "the
  quota works correctly" is not.
- **Plan** — every task that writes a test names the oracle that test asserts. "Matches the
  implementation" is not an acceptable answer, and the staff-engineer review checks it.
- **Build, RED** — the failure is **recorded**, not claimed: pasted into the PR body, or committed
  separately so `git show` proves it. A test never observed failing is not known to be a test.
  This is deliberately not a CI check — a check for the presence of a section cannot read what it
  checks, which is the decorative-assertion pattern this repository has already had to fix once.
- **Build, threat model** — for each threat on a *Sensitive path*, ask whether it is expressible as
  a planted hole. If it is, author it as a committed fixture alongside `backend/tests/mutants.ts`.
- **Review** — three questions, every time: where did this expected value come from; did any
  existing assertion change in this PR; is anything mocked that is not a process boundary.
```

- [ ] **Step 2: Verify the sync checker still passes**

```bash
./scripts/tests/check-sdlc-sync.test.sh
```
Expected: PASS. This PR touches no path in `process.watched`, so the gate itself is inert here; the
test asserts the checker's own logic.

- [ ] **Step 3: Commit**

```bash
git add docs/sdlc-local.md
git commit -m "docs(sdlc-local): where the oracle rule binds in the process"
```

## Task 4: Index the new document

**Files:**
- Modify: `docs/README.md`

- [ ] **Step 1: Add a row to the table** after the `runbooks/` row:

```markdown
| [`escaped-defects.md`](escaped-defects.md) | **Calibration.** Every defect that reached `main` and the gate that missed it | After any defect reaches `main` | Append-only — never edit an entry |
```

- [ ] **Step 1a: Correct the `sdlc.md` row in the same table.** It still says `sdlc.md` is
      "**required** by the `SDLC docs` CI job", which adoption made false — `process.doc` is
      `docs/sdlc-local.md`. Set its *Mutable?* cell to:

```markdown
| **No** — carried byte-identical from `acb`; edit [`sdlc-local.md`](sdlc-local.md) instead |
```

      and add the row that is now missing:

```markdown
| [`sdlc-local.md`](sdlc-local.md) | This repository's process specifics — components, gates, watched paths | A local process change | Yes — and **required** by the `SDLC docs` CI job |
```

- [ ] **Step 2: Add `Proposed` to the ADR status convention.** The convention line currently reads
      `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`, but ADR 0002 and ADR 0006 both use
      `Proposed`. Change it to:

```markdown
- **ADRs**: `adr/NNNN-kebab-title.md`, continuing the existing sequence. Status is
  `Proposed` / `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`. A superseded ADR stays — it is
  the historical record.
```

- [ ] **Step 3: Commit**

```bash
git add docs/README.md
git commit -m "docs: index the escaped-defect log; record Proposed as an ADR status"
```

## Task 5: Land the spec and ADR, and open PR 1

**Files:**
- Add: `docs/specs/2026-08-28-trusting-ai-written-tests.md`, `docs/adr/0006-trusting-ai-written-tests.md`
  (both already exist in the working tree, untracked)

- [ ] **Step 1: Refresh the status metadata before committing**

Both files are untracked, so this is editing a draft rather than rewriting history — an ADR is
immutable only once committed.

In `docs/specs/2026-08-28-trusting-ai-written-tests.md`, **leave the existing Status paragraph in
place** — it already records the post-adoption re-verification, and replacing it would lose that.
Make two edits only: change "Open Questions 1 and 2 are resolved by decision" to read
"Open Questions 1, 2 and 6 are resolved by decision", and append one line after the paragraph:

```markdown
**Plan:** [`2026-08-29-trusting-ai-written-tests`](../plans/2026-08-29-trusting-ai-written-tests.md)
```

In `docs/adr/0006-trusting-ai-written-tests.md`, replace the Tracking line with the epic recorded in
Task 0:

```markdown
- **Tracking:** epic [#<EPIC>](https://github.com/igor-ka/llm-code-execution/issues/<EPIC>), children [#<CHILD-1>](https://github.com/igor-ka/llm-code-execution/issues/<CHILD-1>)–[#<CHILD-3>](https://github.com/igor-ka/llm-code-execution/issues/<CHILD-3>)
```

- [ ] **Step 2: Commit them**

```bash
git add docs/specs/2026-08-28-trusting-ai-written-tests.md docs/adr/0006-trusting-ai-written-tests.md docs/plans/2026-08-29-trusting-ai-written-tests.md
git commit -m "docs: spec, ADR-0006 and plan for trusting AI-written tests"
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "docs: testing standards — keep the oracle out of the implementation" --body "Closes #<CHILD-1>

Docs only. No code, no CI change.

Ships the four testing rules, the three review questions, and \`docs/escaped-defects.md\` seeded
with four gates that existed here and did not fire.

Spec: docs/specs/2026-08-28-trusting-ai-written-tests.md
ADR: docs/adr/0006-trusting-ai-written-tests.md"
```

---

# PR 2 — the diff-scoped mutation gate

Worktree: `scripts/worktree-new.sh mutation-gate` from the main checkout.

## Task 6: Prove Stryker runs at all (spike, no commit of results)

This exists because Stryker sandboxes the project into `.stryker-tmp/` and re-runs Vitest there;
this backend is ESM with `NodeNext` resolution and `.js` import specifiers, and the vitest config
pins datastore env vars. Any of those can break the first run. **Resolve it before writing the
gate**, not inside it.

**Files:**
- Modify: `backend/package.json` (devDependencies)

- [ ] **Step 1: Install**

```bash
cd backend
npm install --save-dev @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
```

- [ ] **Step 2: Run Stryker against one small, fully-covered file**

```bash
npx stryker run --testRunner vitest --coverageAnalysis perTest \
  --reporters clear-text,json --mutate 'src/limits/concurrency.ts'
```

Expected: it completes and prints a mutation score. If it fails, the likely causes in order are a
missing `testRunner` plugin resolution, the `.stryker-tmp` sandbox not carrying `tsconfig.json`, or
the vitest config's `env` pin. Do not proceed until this run completes.

- [ ] **Step 3: Record the JSON report path — the one detail this plan does not assert**

```bash
find reports -name '*.json' -newermt '-10 minutes'
```
Expected: `reports/mutation/mutation.json`. A staff review against `@stryker-mutator/core` 10.0.0
with `reporters: ["clear-text", "json"]` confirmed that is the default, so this step exists to catch
a version that changes it. **If it differs, the `mutation()` target in Task 10 is the single place
it is hard-coded** — change it there and nowhere else. `backend/stryker.conf.mjs` carries no
report-path key and does not need one.

- [ ] **Step 4: Measure, for Open Question 5**

**Measure both modes**, because the gate picks between them by scope (see Task 10):

```bash
# Parallel — the common case: auth.ts, schemas.ts, sandbox/**
time npx stryker run --mutate 'src/auth.ts' --reporters clear-text

# Single-worker — forced whenever history/** or limits/** is in scope
time npx stryker run --concurrency 1 --mutate 'src/limits/memoryQuota.ts' --reporters clear-text
```

Record both wall clocks and both mutant counts in the PR body, then extrapolate to a 60-changed-line
PR **in each mode**. The single-worker number is the one the abort criterion applies to, because it
is the mode a history or limits change will take.

Also record whether Stryker's initial dry run itself runs concurrently: if it does, a scope that
mixes datastore files with others still needs `--concurrency 1` for the dry run, which the scope
test in Task 10 already forces.

**The abort criterion, decided 2026-08-29: 5 minutes for the `Mutation test` CI step**, measured in
single-worker mode. If the
extrapolation exceeds it, do not ship the gate as designed — shrink the eligible set (drop
`migrate.ts` first, then `dockerBackend.ts`) and re-measure until it fits. `Backend checks` already
builds three Docker images; a job that doubles in length gets worked around, and a gate that gets
worked around is worse than no gate.

- [ ] **Step 5: Commit only the dependency change**

```bash
git add package.json package-lock.json
git commit -m "build(backend): add Stryker for mutation testing"
```

## Task 7: The diff-scoping script

**Files:**
- Create: `scripts/mutation-scope.sh`

- [ ] **Step 1: Write the failing test first**

Create `scripts/tests/mutation-scope.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for scripts/mutation-scope.sh — hunk parsing, eligibility, and the
# merge-base hard failure. Builds a throwaway git repository per case so nothing
# depends on this checkout's history.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-scope.sh"
pass=0

fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { echo "  ok: $1"; pass=$((pass + 1)); }

make_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  mkdir -p "$dir/backend/src/limits" "$dir/backend/src/history"
  cat > "$dir/.mutation-scope.json" <<'JSON'
{ "root": "backend", "include": ["src/limits/", "src/history/"], "exclude": ["src/history/types.ts"] }
JSON
  printf 'const a = 1;\nconst b = 2;\nconst c = 3;\n' > "$dir/backend/src/limits/quota.ts"
  printf 'export type X = 1;\n' > "$dir/backend/src/history/types.ts"
  printf 'ignore me\n' > "$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
  git -C "$dir" branch -q base-ref
  echo "$dir"
}

# 1. A changed line inside an eligible file is emitted as a backend-relative range.
repo="$(make_repo)"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ "$out" == "src/limits/quota.ts:2-2" ]] || fail "expected src/limits/quota.ts:2-2, got '$out'"
ok "one changed line becomes one backend-relative range"

# 2. A file outside the eligible set produces nothing.
repo="$(make_repo)"
printf 'changed\n' > "$repo/README.md"
git -C "$repo" commit -qam change
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ -z "$out" ]] || fail "expected empty scope for README.md, got '$out'"
ok "an ineligible file yields an empty scope"

# 3. Type-only files are excluded even though they sit under an eligible directory.
repo="$(make_repo)"
printf 'export type X = 2;\n' > "$repo/backend/src/history/types.ts"
git -C "$repo" commit -qam change
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ -z "$out" ]] || fail "expected types.ts to be excluded, got '$out'"
ok "type-only files are excluded"

# 4. A NEW file under an eligible directory is included — new code defaults IN.
repo="$(make_repo)"
printf 'export const f = () => 1;\n' > "$repo/backend/src/limits/newThing.ts"
git -C "$repo" add -A && git -C "$repo" commit -qam add
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ "$out" == "src/limits/newThing.ts:1-1" ]] || fail "expected the new file to be in scope, got '$out'"
ok "a new file under an eligible directory is in scope by default"

# 5. A pure deletion emits nothing — there are no new lines to mutate.
repo="$(make_repo)"
printf 'const a = 1;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam delete
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ -z "$out" ]] || fail "expected empty scope for a pure deletion, got '$out'"
ok "a pure deletion yields an empty scope"

# 6. An unresolvable base ref is a HARD FAILURE, never an empty scope. This is the
#    likeliest way the gate silently checks nothing (a shallow CI clone).
repo="$(make_repo)"
if (cd "$repo" && MUTATION_BASE_REF=refs/heads/does-not-exist "$SCRIPT") 2>/dev/null; then
  fail "an unresolvable base ref must exit non-zero"
fi
ok "an unresolvable base ref exits non-zero"

# 7. The pathspec is REPOSITORY-relative, so the same scope comes back from backend/ — which is
#    where verify.sh calls this from. Without ':(top)' the gate silently scopes nothing.
repo="$(make_repo)"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
out="$(cd "$repo/backend" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ "$out" == "src/limits/quota.ts:2-2" ]] || fail "expected the same scope from backend/, got '$out'"
ok "the pathspec is repository-relative, not cwd-relative"

# 8. A rename PLUS an edit must still be scoped. With -M git reports it as R, which a
#    --diff-filter of AM alone would drop entirely — every changed line escaping the gate.
repo="$(make_repo)"
git -C "$repo" mv backend/src/limits/quota.ts backend/src/limits/quotas.ts
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quotas.ts"
git -C "$repo" commit -qam rename-and-edit
out="$(cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT")"
[[ "$out" == "src/limits/quotas.ts:2-2" ]] || fail "expected the renamed file to be scoped, got '$out'"
ok "a rename plus an edit is still scoped"

# 9. A MISSING declaration is a hard failure, never an empty scope.
repo="$(make_repo)"
rm "$repo/.mutation-scope.json"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
if (cd "$repo" && MUTATION_BASE_REF=base-ref "$SCRIPT") 2>/dev/null; then
  fail "a missing .mutation-scope.json must exit non-zero"
fi
ok "a missing scope declaration exits non-zero"

echo "mutation-scope: ${pass}/9 passed"
```

- [ ] **Step 2: Run it and watch it fail**

```bash
chmod +x scripts/tests/mutation-scope.test.sh
./scripts/tests/mutation-scope.test.sh
```
Expected: FAIL — `mutation-scope.sh` does not exist.

- [ ] **Step 3: Write the scope declaration**

Create `.mutation-scope.json` at the repository root:

```json
{
  "root": "backend",
  "include": ["src/auth.ts", "src/schemas.ts", "src/history/", "src/limits/", "src/sandbox/"],
  "exclude": ["src/history/types.ts", "src/sandbox/base.ts", "src/history/cli-migrate.ts"]
}
```

**`root` is the COMPONENT directory, not the source directory.** Stryker runs with cwd `backend/`,
so `--mutate` needs `src/limits/quota.ts:2-2`; a `root` of `backend/src` would strip the `src/`
prefix and emit `limits/quota.ts:2-2`, which matches nothing and silently instruments zero files.

`include` is the set `CLAUDE.md` already forces a threat-model pass on, plus the shared request
validator — an existing rule rather than a fresh judgment call. A trailing `/` means "everything
under here", so a file added to `src/limits/` later is gated by default.

**`exclude` holds two kinds of file, and the distinction matters** (decided 2026-08-31, after a
review found the original list wrong in both directions):

- **Nothing to mutate.** `src/history/types.ts` and `src/sandbox/base.ts` are type-only — no runtime
  behaviour, so every mutant would be a compile error. **`src/history/store.ts` is NOT one of
  these** and was wrongly listed as such: it holds `titleFromPrompt()`, whose 60-character boundary,
  `slice(0, 57)` and `trimEnd()` are precisely what a mutation gate is for. It is now in scope.
- **Nothing that can kill a mutant.** `src/history/cli-migrate.ts` is a side-effecting entry-point
  script that no test imports, so every mutant in it comes back `NoCoverage` — and since this gate
  blocks on `NoCoverage`, touching that file would hard-block the PR with no remedy but a
  suppression comment on every line. Excluded because the gate has no useful signal there, not
  because the code does not matter.

**This file is the acb seam.** At adoption it folds into `.acb.json` under the `backend` component
and `scripts/mutation-scope.sh` does not change — see *Where this work lands* below.

- [ ] **Step 4: Write the script**

Create `scripts/mutation-scope.sh`:

```bash
#!/usr/bin/env bash
# Emit Stryker `mutate` patterns — one `path:start-end` per line, relative to backend/ —
# for the lines this branch changes inside the mutation-eligible file set.
#
# THIS FILE OWNS THE ELIGIBLE SET, and it is the only place that does. backend/stryker.conf.mjs
# deliberately carries no `mutate` key: a CLI --mutate COMPLETELY REPLACES the config value rather
# than merging with it, so a second list would rot without anything noticing.
#
# The set is exactly the paths CLAUDE.md already forces a threat-model pass on, plus the shared
# request validator — an existing rule rather than a fresh judgment call.
#
# Output is EMPTY when the change touches nothing eligible. That is a legitimate pass, and the
# caller must SAY SO rather than printing a bare success: an empty scope and a silent pass look
# identical in a log.
set -euo pipefail

BASE_REF="${MUTATION_BASE_REF:-origin/main}"

# THE ELIGIBLE SET IS DECLARED, NOT HARD-CODED, and that is a constraint this repository inherits
# from acb: a gate script that is byte-identical across consumers can be carried by `cp` and diffed
# against every one of them, while a script carrying a repo-specific list can never be. Variation
# belongs in a declaration read at RUNTIME, never baked in. Today that is .mutation-scope.json;
# folding it into .acb.json needs an upstream schema change, and this script would not change.
#
# Read with node rather than jq. jq is on every GitHub runner but not on every laptop, and unlike
# acb's existing gate scripts this one has a local equivalent developers run in the inner loop.
# Node is already a hard dependency here — scripts/mutation-decide.mjs is node.
CONFIG="${MUTATION_SCOPE_CONFIG:-$(git rev-parse --show-toplevel)/.mutation-scope.json}"

# A missing declaration is a FAILURE, never an empty scope: an absent config and a change that
# touches nothing eligible must not look the same to the caller.
if [[ ! -f "$CONFIG" ]]; then
  echo "mutation-scope: no scope declaration at ${CONFIG}" >&2
  exit 1
fi

config_key() {
  node -e '
    const fs = require("node:fs");
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { console.error("mutation-scope: invalid JSON in " + process.argv[1] + ": " + e.message); process.exit(1); }
    const key = process.argv[2];
    const v = cfg[key];
    if (key === "root") {
      if (typeof v !== "string" || v === "") { console.error("mutation-scope: root must be a non-empty string"); process.exit(1); }
      console.log(v);
    } else {
      // NOT `return` in the branch above: `node -e` evaluates at module top level, where a
      // return is a SyntaxError and the script dies on its very first call.
      if (!Array.isArray(v)) { console.error("mutation-scope: " + key + " must be an array"); process.exit(1); }
      for (const x of v) console.log(x);
    }
  ' "$CONFIG" "$1"
}

ROOT="$(config_key root)"          # the COMPONENT dir, e.g. "backend" — Stryker's cwd
INCLUDE=(); EXCLUDE=()
while IFS= read -r line; do [[ -n "$line" ]] && INCLUDE+=("$line"); done <<< "$(config_key include)"
while IFS= read -r line; do [[ -n "$line" ]] && EXCLUDE+=("$line"); done <<< "$(config_key exclude)"
[[ ${#INCLUDE[@]} -gt 0 ]] || { echo "mutation-scope: include is empty — nothing would ever be gated" >&2; exit 1; }

# An `include` entry ending in `/` is a directory prefix: everything under it is eligible, so a file
# ADDED there later is in scope by default. That is the fail-safe direction — forgetting to update
# the declaration over-tests rather than under-tests.
# EXCLUDE matches an exact path only, while INCLUDE also honours a trailing '/' as a prefix. That
# asymmetry is deliberate — every exclusion so far is a single named file, and a prefix exclude is
# the kind of blunt instrument that quietly removes a directory from the gate. If one is ever
# needed, add the case here rather than assuming `exclude: ["history/"]` does anything: today it
# silently matches nothing.
eligible() {
  local path="$1" pat
  for pat in "${EXCLUDE[@]}"; do [[ "$path" == "$ROOT/$pat" ]] && return 1; done
  for pat in "${INCLUDE[@]}"; do
    case "$pat" in
      */) [[ "$path" == "$ROOT/$pat"* ]] && return 0 ;;
      *)  [[ "$path" == "$ROOT/$pat"  ]] && return 0 ;;
    esac
  done
  return 1
}

# A merge base that cannot be resolved is a HARD FAILURE. `actions/checkout` shallow-clones by
# default, and without fetch-depth: 0 this is exactly how the gate ends up checking nothing while
# reporting success.
if ! merge_base="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)"; then
  echo "mutation-scope: cannot resolve a merge base between '${BASE_REF}' and HEAD." >&2
  echo "  In CI this usually means actions/checkout needs fetch-depth: 0." >&2
  exit 1
fi

# --unified=0 so each hunk header covers only changed lines, never context.
#
# ':(top)' makes the pathspec REPOSITORY-relative, and it is load-bearing. A bare 'backend/src'
# resolves against the CALLER's cwd, and backend/verify.sh cds to backend/ before invoking this —
# so it would match `backend/backend/src`, emit nothing, and the gate would report "no mutable
# lines" on every real run while its unit tests (which run from the repo root) stayed green.
#
# --diff-filter=AMR keeps additions, modifications and RENAMES. The R is load-bearing too: with -M
# on, a rename-plus-edit is reported as R, so filtering to AM alone drops every changed line in a
# moved file. That fails OPEN, which the spec's Boundaries forbid.
#
# -M enables rename detection, and it settles spec Open Question 3 in passing: a PURE rename
# produces no hunks at all (similarity 100%), so a move-only PR generates no mutants rather than
# re-mutating every moved line.
git diff --unified=0 --diff-filter=AMR -M "$merge_base" -- ":(top)${ROOT}" \
| awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^@@ / {
      plus = $3                      # the "+c,d" field
      sub(/^\+/, "", plus)
      n = split(plus, r, ",")
      start = r[1] + 0
      len   = (n < 2 ? 1 : r[2] + 0)
      if (len == 0) next             # pure deletion: no new lines exist to mutate
      printf "%s\t%d\t%d\n", file, start, start + len - 1
    }
  ' \
| while IFS=$'\t' read -r path start end; do
    eligible "$path" || continue
    # Stryker runs with cwd = the component root, so emit paths relative to it.
    printf '%s:%s-%s\n' "${path#"$ROOT"/}" "$start" "$end"
  done
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
chmod +x scripts/mutation-scope.sh
./scripts/tests/mutation-scope.test.sh
```
Expected: `mutation-scope: 9/9 passed`

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation-scope.sh scripts/tests/mutation-scope.test.sh .mutation-scope.json
git commit -m "feat(mutation): turn the diff into Stryker line ranges"
```

## Task 8: The decision script and the suppression rule

**Files:**
- Create: `scripts/mutation-decide.mjs`
- Create: `scripts/tests/mutation-decide.test.sh`

- [ ] **Step 1: Write the failing test first**

Create `scripts/tests/mutation-decide.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for scripts/mutation-decide.mjs. This is where "block AND count" is proven:
# Survived fails, NoCoverage fails, Timeout passes (Stryker counts it as detected), and an
# UNKNOWN status fails rather than being ignored.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-decide.mjs"
tmp="$(mktemp -d)"
pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { echo "  ok: $1"; pass=$((pass + 1)); }

report() { printf '%s' "$1" > "$tmp/r.json"; }
run()    { node "$SCRIPT" "$tmp/r.json"; }

report '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"EqualityOperator","status":"Killed","location":{"start":{"line":10}}}]}}}'
run >/dev/null || fail "an all-killed report must exit 0"
ok "all killed → exit 0"

report '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"EqualityOperator","status":"Survived","location":{"start":{"line":10}}}]}}}'
if run >/dev/null 2>&1; then fail "a Survived mutant must exit non-zero"; fi
ok "Survived → exit non-zero"

report '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"BooleanLiteral","status":"NoCoverage","location":{"start":{"line":42}}}]}}}'
if run >/dev/null 2>&1; then fail "a NoCoverage mutant must exit non-zero"; fi
ok "NoCoverage → exit non-zero (the 'count' half of block-and-count)"

report '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"ArithmeticOperator","status":"Timeout","location":{"start":{"line":7}}}]}}}'
run >/dev/null || fail "a Timeout is counted as detected by Stryker and must exit 0"
ok "Timeout → exit 0"

report '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"X","status":"SomethingNew","location":{"start":{"line":1}}}]}}}'
if run >/dev/null 2>&1; then fail "an unknown status must exit non-zero, not be ignored"; fi
ok "unknown status → exit non-zero"

if node "$SCRIPT" "$tmp/absent.json" >/dev/null 2>&1; then fail "a missing report must exit non-zero"; fi
ok "missing report → exit non-zero"

report '{"files":{}}'
if run >/dev/null 2>&1; then fail "a report with zero mutants must exit non-zero when invoked"; fi
ok "zero mutants → exit non-zero (the caller must not run Stryker on an empty scope)"

echo "mutation-decide: ${pass}/7 passed"
```

- [ ] **Step 2: Run it and watch it fail**

```bash
chmod +x scripts/tests/mutation-decide.test.sh
./scripts/tests/mutation-decide.test.sh
```
Expected: FAIL — `mutation-decide.mjs` does not exist.

- [ ] **Step 3: Write the script**

Create `scripts/mutation-decide.mjs`:

```javascript
/**
 * Decide the mutation gate from Stryker's JSON report.
 *
 * BLOCK AND COUNT, the two decisions taken on 2026-08-29: a mutant that SURVIVED fails the build,
 * and so does one Stryker marked NoCoverage — a line the change added that no test executes. This
 * is deliberately stricter than "score below threshold": it names the offending line.
 *
 * Timeout counts as detected (Stryker's own semantics: an infinite loop is a defect the suite
 * noticed). CompileError and RuntimeError are Stryker's own failures to build a mutant and are not
 * evidence about the tests either way.
 *
 * AN UNKNOWN STATUS IS A FAILURE, never a pass. This file hard-codes a status vocabulary read from
 * the mutation-testing-elements schema; if Stryker adds a status, the gate must stop rather than
 * silently treat it as acceptable.
 */
import { readFileSync } from "node:fs";

// `Pending` is deliberately absent from both sets: a mutant Stryker generated but never ran is not
// evidence about the tests, and it must reach the unknown-status branch below rather than be waved
// through. Do not "fix" this by adding it to ACCEPTABLE.
const BLOCKING = new Set(["Survived", "NoCoverage"]);
const ACCEPTABLE = new Set(["Killed", "Timeout", "CompileError", "RuntimeError", "Ignored"]);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: mutation-decide.mjs <path-to-stryker-mutation.json>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`mutation-decide: cannot read the Stryker report at ${reportPath}: ${err.message}`);
  console.error("  A missing or unreadable report is a FAILURE — the gate never passes on absence.");
  process.exit(1);
}

const offenders = [];
const unknown = [];
let total = 0;

for (const [file, entry] of Object.entries(report.files ?? {})) {
  for (const mutant of entry.mutants ?? []) {
    total += 1;
    const line = mutant.location?.start?.line ?? "?";
    if (BLOCKING.has(mutant.status)) {
      offenders.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    } else if (!ACCEPTABLE.has(mutant.status)) {
      unknown.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    }
  }
}

// Zero mutants here means Stryker ran and generated nothing, which is not the same as "the change
// touched no eligible file" — that case is handled by the caller BEFORE Stryker runs. Reaching
// this branch means the scope was non-empty and produced nothing, which is a wiring fault.
if (total === 0) {
  console.error("mutation-decide: the report contains no mutants, but the scope was not empty.");
  process.exit(1);
}

if (unknown.length > 0) {
  console.error(`mutation-decide: ${unknown.length} mutant(s) carry a status this gate does not know:`);
  console.error(unknown.join("\n"));
  console.error("  Update the status vocabulary in scripts/mutation-decide.mjs deliberately.");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`mutation-decide: ${offenders.length} of ${total} mutant(s) were not killed:`);
  console.error(offenders.join("\n"));
  console.error("");
  console.error("Each line above is a change this PR made that no test would notice was wrong.");
  console.error("Kill it with an assertion, or suppress it WITH A REASON:");
  console.error("  // Stryker disable next-line <mutator>: <why no test can kill this>");
  process.exit(1);
}

console.log(`mutation-decide: ${total} mutant(s), all killed.`);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
./scripts/tests/mutation-decide.test.sh
```
Expected: `mutation-decide: 7/7 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/mutation-decide.mjs scripts/tests/mutation-decide.test.sh
git commit -m "feat(mutation): block on survivors and on uncovered changed lines"
```

- [ ] **Step 6: Write the failing test for the suppression rule**

Spec success criterion 5: *a suppression comment without a reason is rejected*. Stryker's own
`// Stryker disable` syntax treats the reason as optional, so nothing enforces this but us — and an
unexplained suppression is how a gate quietly stops gating one line at a time.

Create `scripts/tests/mutation-suppressions.test.sh`:

```bash
#!/usr/bin/env bash
# A Stryker suppression must carry a reason. Stryker accepts a bare `// Stryker disable next-line
# all`; this repository does not, for the same reason the npm audit gate demands a dated exception
# in the script rather than a silent skip.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-suppressions.sh"
tmp="$(mktemp -d)"; mkdir -p "$tmp/src"
pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { echo "  ok: $1"; pass=$((pass + 1)); }

write() { printf '%s\n' "$1" > "$tmp/src/f.ts"; }

write 'const a = 1;'
"$SCRIPT" "$tmp/src" >/dev/null || fail "a file with no suppressions must pass"
ok "no suppressions → exit 0"

write '// Stryker disable next-line all: the retry delay cannot change observable behaviour'
"$SCRIPT" "$tmp/src" >/dev/null || fail "a suppression WITH a reason must pass"
ok "suppression with a reason → exit 0"

write '// Stryker disable next-line all'
if "$SCRIPT" "$tmp/src" >/dev/null 2>&1; then fail "a bare suppression must be rejected"; fi
ok "suppression with no reason → exit non-zero"

write '// Stryker disable next-line all:   '
if "$SCRIPT" "$tmp/src" >/dev/null 2>&1; then fail "a whitespace-only reason must be rejected"; fi
ok "whitespace-only reason → exit non-zero"

echo "mutation-suppressions: ${pass}/4 passed"
```

- [ ] **Step 7: Run it and watch it fail**

```bash
chmod +x scripts/tests/mutation-suppressions.test.sh
./scripts/tests/mutation-suppressions.test.sh
```
Expected: FAIL — `mutation-suppressions.sh` does not exist.

- [ ] **Step 8: Write the script**

Create `scripts/mutation-suppressions.sh`:

```bash
#!/usr/bin/env bash
# Every Stryker suppression must state WHY no test can kill the mutant.
#
# NOTE the `if grep …; then exit 1; fi` form rather than `! grep -q …`. POSIX exempts a command
# negated with `!` from `set -e`, so the negated form does not abort — that exact mistake shipped
# here once and is entry 2 in docs/escaped-defects.md.
set -euo pipefail

dir="${1:-src}"

# Fail closed on a missing directory. Without this the grep below finds nothing, `|| true`
# swallows the error, and the gate reports "every suppression states a reason" about a directory
# that does not exist.
[[ -d "$dir" ]] || { echo "mutation-suppressions: no such directory: $dir" >&2; exit 1; }

# A suppression line, with a reason: `// Stryker disable next-line all: <non-blank text>`.
# Anything matching "Stryker disable" that does NOT match that shape is unexplained.
offenders="$(grep -rn 'Stryker disable' "$dir" 2>/dev/null \
  | grep -vE 'Stryker disable [^:]*:[[:space:]]*[^[:space:]]' || true)"

if [[ -n "$offenders" ]]; then
  echo "mutation-suppressions: suppression(s) with no reason:" >&2
  printf '%s\n' "$offenders" >&2
  echo "  Write why no test can kill it: // Stryker disable next-line <mutator>: <reason>" >&2
  exit 1
fi

echo "mutation-suppressions: every suppression states a reason."
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
chmod +x scripts/mutation-suppressions.sh
./scripts/tests/mutation-suppressions.test.sh
```
Expected: `mutation-suppressions: 4/4 passed`

- [ ] **Step 10: Commit**

```bash
git add scripts/mutation-suppressions.sh scripts/tests/mutation-suppressions.test.sh
git commit -m "feat(mutation): a suppression must state a reason"
```

## Task 9: Stryker configuration

**Files:**
- Create: `backend/stryker.conf.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write the config**

```javascript
/**
 * Stryker configuration for the diff-scoped mutation gate. See
 * docs/adr/0006-trusting-ai-written-tests.md and scripts/mutation-scope.sh.
 *
 * THERE IS DELIBERATELY NO `mutate` KEY. A CLI `--mutate` COMPLETELY REPLACES the config value
 * rather than merging with it, and the gate always passes `--mutate` from scripts/mutation-scope.sh.
 * A `mutate` key here would be dead weight that looks authoritative — the eligible set lives in the
 * scope script and nowhere else.
 *
 * THERE IS ALSO NO `thresholds` KEY, and that is the same decision in a second place. A
 * `break: 100` would work — Stryker's score is `detected / valid` and NoCoverage counts against it,
 * so it fails on exactly the two statuses scripts/mutation-decide.mjs blocks. It was removed
 * deliberately: it is a mutation SCORE, which ADR 0006 decision (2) and spec criterion 10 rule out,
 * and its failure message is the non-actionable "score 97.3 is below break threshold 100" rather
 * than a named file and line. One gate, and it is the one that can tell you what to fix.
 */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  // Record which tests touch which lines once, then run only those per mutant. Without this every
  // mutant re-runs all 247 tests, and the gate becomes unaffordable.
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "json"],
  // NO `concurrency` KEY — it is passed on the command line instead, because the safe value
  // depends on which files are in scope. See the mutation() target in backend/verify.sh.
  // Default is 5000. The datastore-gated suites talk to Postgres and Redis over a socket, and
  // vitest.config.ts serializes the whole run whenever DATABASE_URL or REDIS_URL is set — so a
  // mutant's test run is slower here than the DB-free numbers suggest.
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
```

- [ ] **Step 2: Ignore the generated directories — in both ignore files**

Append to the repo-root `.gitignore` under the `# Node` block:

```
.stryker-tmp/
reports/
.mutation-selftest-strong/
```

And to `.dockerignore`, because `Mutation test` runs before `Package` in CI — without this, Stryker's
output is inside the production image's build context:

```
**/reports
**/.stryker-tmp
**/.mutation-selftest-strong
```

And to `backend/.prettierignore`, which is a separate mechanism: Prettier resolves its ignore file
relative to cwd, and `backend/` has no `.gitignore` of its own — so after one local
`./verify.sh mutation` the next `./verify.sh format` fails on `reports/mutation/mutation.json`.

```
reports
.stryker-tmp
.mutation-selftest-strong
```

- [ ] **Step 3: Verify Stryker accepts the config**

```bash
cd backend && npx stryker run --mutate 'src/limits/concurrency.ts'
```
Expected: it runs to completion and **exits 0** — with no `thresholds` key Stryker itself never
fails the build, whatever the score. The gate is `scripts/mutation-decide.mjs`, exercised in
Task 10. Confirm `reports/mutation/mutation.json` was written.

- [ ] **Step 4: Commit**

```bash
git add backend/stryker.conf.mjs .gitignore
git commit -m "build(mutation): Stryker config, break at 100, no mutate key"
```

## Task 10: The verify.sh target

**Files:**
- Modify: `backend/verify.sh`

- [ ] **Step 1: Add the target function**, immediately after `integration()`:

```bash
# The diff-scoped mutation gate. See docs/adr/0006-trusting-ai-written-tests.md.
#
# Runs its own unit tests FIRST, the way infra/verify.sh runs `selftest` before its gates: a gate
# whose decision logic is untested is a gate that reads as coverage and provides none.
#
# THE LOCAL RUN IS THE FIRST SIGNAL AND CI IS THE BACKSTOP. Run this at the REFACTOR step, on the
# lines you just touched — survivors are the assertions you have not written yet, and they are a
# two-minute fix while the code is still in your head.
mutation() {
  # The datastore precondition FIRST, before any work. It is the cheapest check here and the one
  # most likely to fail, and paying a Stryker run before reaching it wastes minutes on every
  # misconfigured invocation.
  #
  # CI must not be able to take the partial branch. pgStore.ts, migrate.ts and redisQuota.ts are
  # 580 of the 1,630 eligible lines and their suites SELF-SKIP without these variables — so a
  # DB-free run does not skip those files, it reports every mutant in them as SURVIVED. That is
  # not incomplete output, it is wrong output, and it would fail the build for the wrong reason.
  if [[ "${MUTATION_REQUIRE_FULL:-}" == "1" ]]; then
    [[ -n "${DATABASE_URL:-}" ]] || { echo "MUTATION_REQUIRE_FULL=1 but DATABASE_URL is unset" >&2; exit 1; }
    [[ -n "${REDIS_URL:-}" ]]    || { echo "MUTATION_REQUIRE_FULL=1 but REDIS_URL is unset" >&2; exit 1; }
  else
    [[ -n "${DATABASE_URL:-}" ]] || echo "==> note: DATABASE_URL unset — mutants in pgStore.ts and migrate.ts would all read as survivors"
    [[ -n "${REDIS_URL:-}" ]]    || echo "==> note: REDIS_URL unset — mutants in redisQuota.ts would all read as survivors"
  fi

  # The three UNIT suites run every time: they cost milliseconds and they are what stops the
  # decision logic rotting. The end-to-end proof lives in `mutation:selftest` — it runs Stryker
  # twice against a fixture, which is right before a push and wrong in the inner loop.
  run ../scripts/tests/mutation-scope.test.sh
  run ../scripts/tests/mutation-decide.test.sh
  run ../scripts/tests/mutation-suppressions.test.sh
  run ../scripts/mutation-suppressions.sh src

  local scope
  scope="$(../scripts/mutation-scope.sh)"
  if [[ -z "$scope" ]]; then
    echo
    echo "==> no mutable lines in this change — the eligible file set was not touched"
    echo "    (this is a pass, not a skip: there is nothing to mutate)"
    return 0
  fi

  echo
  echo "==> mutating $(printf '%s\n' "$scope" | wc -l | tr -d ' ') changed range(s):"
  printf '      %s\n' $scope

  # CONCURRENCY IS CHOSEN FROM THE SCOPE, and this is a correctness control, not a tuning knob.
  #
  # Stryker forks N worker processes, each running its own vitest. CI provides ONE Postgres and ONE
  # Redis. The Postgres suites share a single schema — migrate.test.ts drops tables and replays
  # migrations while pgStore.test.ts truncates and inserts — which is exactly why
  # vitest.config.ts sets fileParallelism:false. That setting serializes files WITHIN one vitest
  # process; it does nothing about two Stryker workers running two vitest processes at once.
  #
  # Two workers colliding is worse than slow: a spurious failure KILLS a mutant, so the collision
  # makes the gate pass for the wrong reason and no one can tell that from a real kill.
  #
  # AN ALLOWLIST, NOT A DENYLIST, and the direction is the whole point. Listing the files that
  # DO touch a datastore fails OPEN: a datastore-backed file added anywhere the pattern does not
  # anticipate would run in parallel against the shared schema, silently. Listing the ones that
  # provably DO NOT fails CLOSED: anything unrecognised — every future file included — serializes
  # until someone deliberately adds it here. Slower is a cost; silently wrong is a defect.
  #
  # The three entries are the whole eligible set outside history/ and limits/, and none of their
  # suites opens a connection: auth.ts is jose against an in-memory keypair, schemas.ts is zod,
  # and sandbox/** is dockerode and a spawned CLI, both faked in tests.
  #
  # Everything else serializes, which is broader than "the three files that talk to a datastore
  # directly" — deliberately. isolation.test.ts and the contract suites run against BOTH the
  # in-memory and the Postgres store whenever DATABASE_URL is set, so mutating memoryStore.ts
  # exercises Postgres too.
  # NOT `grep -qv`. frontend/verify.sh already carries the warning — "-qv inverts per LINE, so it
  # passes on any file with one clean line" — and the same trap applies to the exit code here: the
  # question is "is ANY line outside the allowlist", which is a test on the OUTPUT, not on whether
  # some line happened to be selected. Capture the non-allowlisted lines and test for emptiness.
  local offlist stryker_args=()
  offlist="$(printf '%s\n' "$scope" | grep -vE '^src/(auth\.ts|schemas\.ts|sandbox/)' || true)"
  if [[ -n "$offlist" ]]; then
    echo "    scope is not provably datastore-free — running single-worker to protect the shared schema"
    stryker_args+=(--concurrency 1)
  fi

  # Stryker's exit code is captured rather than left to `set -e` so the decision script always
  # runs and always explains WHY. It is not swallowed: a non-zero Stryker exit with no offending
  # mutant is treated as a crash below.
  local stryker_status=0
  # `${a[@]+"${a[@]}"}` and NOT a bare `"${stryker_args[@]}"`. macOS ships bash 3.2.57, where
  # expanding an EMPTY array under `set -u` aborts with "a[@]: unbound variable" — verified on this
  # machine. That is the common case (no datastore file in scope), so the plain form would kill the
  # gate on every developer laptop while passing on CI's bash 5. Exactly the local/CI split this
  # repository's single-verify.sh design exists to prevent.
  npx stryker run ${stryker_args[@]+"${stryker_args[@]}"} \
    --mutate "$(printf '%s\n' "$scope" | paste -sd, -)" || stryker_status=$?

  # If Stryker itself fell over, the report may be absent or stale — mutation-decide.mjs treats an
  # unreadable report as a failure, which is the fail-closed direction.
  if ! node ../scripts/mutation-decide.mjs reports/mutation/mutation.json; then
    exit 1
  fi
  if [[ "$stryker_status" -ne 0 ]]; then
    echo "stryker exited ${stryker_status} but the report names no unkilled mutant — treating as a crash" >&2
    exit 1
  fi
}
```

- [ ] **Step 2: Add the `mutation:selftest` target**, immediately after `mutation()`:

```bash
# The end-to-end proof that the gate can fail: Stryker really runs, really writes a report, and a
# test that cannot detect a bug really is rejected. Two full Stryker runs against a tiny fixture.
#
# SEPARATE FROM `mutation` deliberately. It is the difference between a proven gate and a
# decorative one, so it must run before every push and in CI — but the inner-loop REFACTOR run is
# supposed to cost seconds, and paying two fixture runs there is how a target stops being used.
mutation_selftest() { run ../scripts/tests/mutation-gate.test.sh; }
```

- [ ] **Step 3: Add both to the dispatch `case`** — `mutation) mutation ;;` and
      `mutation:selftest) mutation_selftest ;;`, before the `*)` arm.

      The unknown-target message needs no edit: adoption (#223) made it derive from `$TARGETS`, and
      the `*)` arm already exits **64**, which `scripts/check-conformance.sh` requires.

- [ ] **Step 3a: Add both to `TARGETS`, at the END of the list**

```bash
TARGETS="install audit lint format test build migrate test:integration package mutation mutation:selftest"
```

      **Append, never reorder.** The comment above `TARGETS` is explicit that the order is not
      `all()`'s order and must not be "fixed" to match — the conformance probe depends on it.

- [ ] **Step 3b: Declare both in `.acb.json`**, in the `backend` component's `targets` array, in the
      same order:

```json
        "test:integration",
        "package",
        "mutation",
        "mutation:selftest"
```

      **This is not optional bookkeeping.** `scripts/check-conformance.sh` runs as the *Verify.sh
      contract* step in `SDLC docs` and asserts `./verify.sh --targets` equals this array **in both
      directions** — a target in one and not the other fails the build. It also plants `false`
      inside every function and runs each declared target, asserting a non-zero exit: a target that
      dispatches but swallows failure is rejected. Both new functions satisfy that, because `false`
      as their first statement aborts under `set -e`.

      `.acb.json` is in `process.watched`, so this alone makes `docs/sdlc-local.md` a required edit
      for this PR — Task 13 does it.

- [ ] **Step 4: Add both to the usage header comment**, after the `test:integration` line:

```
#   mutation         diff-scoped mutation gate (blocks on survivors AND uncovered changed lines)
#   mutation:selftest  proves the gate can fail — Stryker against a deliberately weak fixture
```

- [ ] **Step 5: Deliberately NOT added to `all()`.** Say so in a comment above `all()`:

```bash
# `mutation` is deliberately absent from `all`. It needs a resolvable merge base against
# origin/main, which a detached checkout or a fresh clone may not have, and `all` must stay
# runnable anywhere. Run it explicitly at the REFACTOR step: ./verify.sh mutation
```

- [ ] **Step 6: Run both, then prove the contract holds**

```bash
cd backend && ./verify.sh mutation && ./verify.sh mutation:selftest
cd .. && ./scripts/check-conformance.sh
```
Expected from the conformance run: every assertion passes, including
`backend: 'mutation' dispatches and can fail` and
`backend: 'mutation:selftest' dispatches and can fail`, and
`backend: --targets agrees with the declaration`. A failure here means `TARGETS`, the dispatch
`case` and `.acb.json` have fallen out of step — fix all three, never just the one the message
names.
Expected on a branch with no eligible file touched: the "no mutable lines" message and exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/verify.sh .acb.json
git commit -m "feat(verify): add the mutation and mutation:selftest targets"
```

## Task 11: Prove the gate can fail (the end-to-end negative test)

Without this the gate could be deleted and every check would stay green — the exact
decorative-assertion pattern `backend/verify.sh` already guards against with its
`VITE_AUTH0_AUDIENCE` negative build.

**Files:**
- Create: `scripts/tests/mutation-gate.test.sh`
- Create: `backend/tests/fixtures/mutation-selftest/{src/toggle.ts,toggle.test.ts,stryker.conf.mjs,vitest.config.ts}`

- [ ] **Step 1: Create the fixture project — a weak test that cannot kill its mutants**

`backend/tests/fixtures/mutation-selftest/src/toggle.ts`:

```typescript
export function overLimit(count: number, limit: number): boolean {
  return count > limit;
}
```

`backend/tests/fixtures/mutation-selftest/toggle.test.ts`:

```typescript
import { it, expect } from "vitest";
import { overLimit } from "./src/toggle.js";

// DELIBERATELY WEAK: it calls the function and asserts only its type, so flipping `>` to `>=`
// changes nothing it can see. This fixture exists to be failed.
it("returns a boolean", () => {
  expect(typeof overLimit(1, 2)).toBe("boolean");
});
```

`backend/tests/fixtures/mutation-selftest/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["*.test.ts"] } });
```

`backend/tests/fixtures/mutation-selftest/stryker.conf.mjs`:

```javascript
export default {
  packageManager: "npm",
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  reporters: ["json"],
  mutate: ["src/toggle.ts"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
```

- [ ] **Step 2: Keep the deliberately-weak fixture out of the real suite**

`backend/vitest.config.ts` has `include: ["tests/**/*.test.ts"]`, so without this the fixture's
assert-nothing test ships into `npm run test` — a test written to be unable to detect a bug,
running in the suite this whole PR exists to make trustworthy.

```typescript
import { defineConfig, configDefaults } from "vitest/config";
```

and in the `test` block, alongside `include`:

```typescript
    // tests/fixtures/mutation-selftest holds a DELIBERATELY WEAK test — it asserts only a return
    // type, so mutating `>` to `>=` cannot fail it. That is the point: scripts/tests/
    // mutation-gate.test.sh runs Stryker against it and asserts the gate REJECTS it. It must
    // never run as part of the real suite. Spreading configDefaults.exclude is load-bearing:
    // setting `exclude` REPLACES the defaults rather than adding to them.
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
```

Then assert the fixture is no longer collected:

```bash
cd backend && npm run test 2>&1 | grep -c 'mutation-selftest' | grep -qx 0 \
  && echo "fixture excluded from the real suite"
```
Expected: `fixture excluded from the real suite`

- [ ] **Step 3: Write the test**

`scripts/tests/mutation-gate.test.sh`:

```bash
#!/usr/bin/env bash
# END-TO-END NEGATIVE TEST: prove the gate actually fails on a test that cannot detect a bug.
#
# The two unit suites prove the pieces; this proves the WIRING — Stryker really generates mutants,
# really runs vitest against them, really writes the report, and the report really fails the gate.
# Without it the whole target could be a no-op and every check would stay green.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$root/backend/tests/fixtures/mutation-selftest"
decide="$root/scripts/mutation-decide.mjs"

echo "==> running Stryker against the deliberately-weak fixture"
( cd "$fixture" && npx --prefix "$root/backend" stryker run ) || true

report="$fixture/reports/mutation/mutation.json"
if [[ ! -f "$report" ]]; then
  echo "FAIL: Stryker produced no report at $report — the gate's wiring is broken" >&2
  exit 1
fi

# The whole point: a weak test must leave survivors, and the decision script must reject them.
# `if` guards the assignment so `set -e` cannot abort on the expected non-zero exit, and `out`
# is captured either way.
if out="$(node "$decide" "$report" 2>&1)"; then
  echo "FAIL: the weak fixture produced no unkilled mutant — THE GATE IS NOT GATING" >&2
  exit 1
fi
# The exit code alone is not enough. Spec criterion 2 requires the gate to NAME the survivor, and
# a bare non-zero would satisfy an exit-code-only check while telling the engineer nothing.
if ! grep -q 'src/toggle.ts:.*(Survived)' <<<"$out"; then
  echo "FAIL: the gate rejected the fixture but named no survivor:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
echo "  ok: a weak test leaves survivors and the gate names and rejects them"

# And the converse, so the gate is not simply always-red: strengthen the test and it must pass.
# UNDER backend/, not in mktemp: Node resolves modules by walking up from the file, so a copy in
# /tmp never reaches backend/node_modules and Stryker's sandbox dies on `Cannot find module
# 'vitest/config'` — no report, and the test fails for the wrong reason.
strong="$root/backend/.mutation-selftest-strong"
rm -rf "$strong" && mkdir -p "$strong"
cp -R "$fixture/." "$strong/"
rm -rf "$strong/reports" "$strong/.stryker-tmp"
cat > "$strong/toggle.test.ts" <<'TS'
import { it, expect } from "vitest";
import { overLimit } from "./src/toggle.js";
it("is false at the boundary and true above it", () => {
  expect(overLimit(2, 2)).toBe(false);
  expect(overLimit(3, 2)).toBe(true);
});
TS
( cd "$strong" && npx --prefix "$root/backend" stryker run ) || true
if [[ ! -f "$strong/reports/mutation/mutation.json" ]]; then
  echo "FAIL: no report from the strengthened fixture" >&2
  exit 1
fi
node "$decide" "$strong/reports/mutation/mutation.json" >/dev/null \
  || { echo "FAIL: a boundary-asserting test still leaves survivors — the gate is always-red" >&2; exit 1; }
echo "  ok: a boundary-asserting test kills them and the gate passes"

rm -rf "$strong" "$fixture/reports" "$fixture/.stryker-tmp"
echo "mutation-gate: 2/2 passed"
```

- [ ] **Step 4: Run it**

```bash
chmod +x scripts/tests/mutation-gate.test.sh
./scripts/tests/mutation-gate.test.sh
```
Expected: `mutation-gate: 2/2 passed`. **If the first case passes the gate, stop** — the gate is
not gating and nothing else in this PR matters.

- [ ] **Step 5: Record the runtime**, since this runs on every PR:

```bash
time ./scripts/tests/mutation-gate.test.sh
```
Put the number in the PR body alongside Task 6's measurement.

- [ ] **Step 6: Commit**

```bash
git add scripts/tests/mutation-gate.test.sh backend/tests/fixtures/mutation-selftest backend/vitest.config.ts
git commit -m "test(mutation): prove the gate fails on a test that cannot detect a bug"
```

## Task 12: Wire it into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Give the backend job the full history.** Change the backend job's checkout step to:

```yaml
      - uses: actions/checkout@v7
        with:
          # The mutation gate diffs against origin/main to find the changed lines. The default
          # shallow clone has no merge base, and scripts/mutation-scope.sh hard-fails rather than
          # reporting an empty scope — but fetching the history is what makes it work at all.
          fetch-depth: 0
```

- [ ] **Step 2: Add the step** after `Integration test` and before `Package` (adoption renamed
      the old `Docker build` step):

```yaml
      # The diff-scoped mutation gate. PRs only — it needs a merge base, and a push to main has
      # nothing to diff against. MUTATION_REQUIRE_FULL=1 means a missing service container is a
      # hard failure rather than a silently partial run; without it, a Postgres that failed to
      # start would report every mutant in pgStore.ts as a survivor.
      - name: Mutation test
        if: github.event_name == 'pull_request'
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
          REDIS_URL: redis://localhost:6379
          MUTATION_REQUIRE_FULL: "1"
          MUTATION_BASE_REF: origin/${{ github.base_ref }}
        run: ./verify.sh mutation

      # The proof that the gate can fail, kept out of the inner loop but never out of CI. Without
      # it the whole target could be a no-op and every check would stay green.
      - name: Mutation gate self-test
        if: github.event_name == 'pull_request'
        run: ./verify.sh mutation:selftest
```

- [ ] **Step 3: Verify the workflow parses**

```bash
gh workflow view CI --yaml >/dev/null && echo "parsed"
```
Expected: `parsed`. (This reads the version on `main`; the real check is the first PR run.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the mutation gate on pull requests"
```

## Task 13: Documentation, in the same PR (enforced)

`SDLC docs` fails this PR otherwise — it touches `.github/workflows/`, `scripts/`,
`backend/verify.sh` **and `.acb.json`**, four watched paths.

**Files:**
- Modify: `docs/sdlc-local.md`, `README.md`

Again, **not `docs/sdlc.md`** — it is carried and byte-identical with `acb`.

- [ ] **Step 1: Add a section to `docs/sdlc-local.md`**, after
      `## The audit flags, and why they are written out`:

```markdown
## The mutation gate

`./verify.sh mutation` mutates only the lines the branch changes against `origin/main` and **fails
on any mutant that survived or that no test covered**. The second half is why it also catches "this
PR added a line nothing executes". Run it at the REFACTOR step: survivors are the assertions you
have not written yet, and they cost two minutes while the code is still in your head. CI runs the
identical target as a backstop, so if the workflow is working CI should never find a survivor.

An unkillable mutant — an **equivalent mutant**, whose edit cannot change observable behaviour — is
suppressed inline with `// Stryker disable next-line <mutator>: <reason>`. The reason is mandatory
and `scripts/mutation-suppressions.sh` rejects a bare one, on the same principle as the dated
exception the audit flags demand.

**It requires both datastores, and in CI it cannot run without them.** `MUTATION_REQUIRE_FULL=1`
makes a missing `DATABASE_URL` or `REDIS_URL` a hard failure rather than a partial run: the suites
covering `pgStore.ts`, `migrate.ts` and `redisQuota.ts` self-skip without those variables — see
[`testing-notes.md`](testing-notes.md) — so a DB-free run would report every mutant in them as a
survivor. That is not incomplete output, it is wrong output. The backend job also checks out with
`fetch-depth: 0`; without a merge base there is nothing to diff, and `scripts/mutation-scope.sh`
hard-fails rather than reporting an empty scope.

The eligible set is declared in [`../.mutation-scope.json`](../.mutation-scope.json), not counted
here — a line count in prose goes stale the first time a file is added.

`mutation:selftest` is separate because it runs Stryker twice against a deliberately weak fixture to
prove the gate can fail. That belongs before a push and in CI, not in the inner loop.
```

- [ ] **Step 2: Add `.mutation-scope.json` to the watched list.** It declares what the gate covers,
      so narrowing it silently narrows the gate — exactly the class of change `process.watched`
      exists to make visible. In `.acb.json`:

```json
      "^\\.mutation-scope\\.json$",
```

      and in the `## Changing this SDLC` list in `docs/sdlc-local.md`:

```markdown
- `.mutation-scope.json` — it declares which files the mutation gate covers; narrowing it narrows
  the gate, and nothing else would notice
```

- [ ] **Step 3: `README.md`** — two edits, and they are not the same edit.

      Line 47 (the project-layout line) enumerates target names: add `mutation` to the list.

      The backend bullet under `## Verification` (heading at line 404, bullet at line 409) names no
      targets at all, so add a sentence rather than a list item:

```markdown
  Two targets are deliberately outside `all`: `mutation` runs the diff-scoped mutation gate, and
  `mutation:selftest` proves that gate can still fail. Run them explicitly — see
  [`docs/sdlc-local.md`](docs/sdlc-local.md).
```

- [ ] **Step 4: Run the gates that police this**

```bash
./scripts/tests/check-sdlc-sync.test.sh
./scripts/check-conformance.sh
```
Expected: both pass.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/sdlc-local.md README.md .acb.json
git commit -m "docs: the mutation gate in sdlc-local.md and README"
gh pr create --title "feat: diff-scoped mutation gate blocking on survivors and uncovered lines" --body "Closes #<CHILD-2>

Measured runtime: <from Task 6 and Task 11>

Proof the gate gates: \`scripts/tests/mutation-gate.test.sh\` runs Stryker against a deliberately
weak fixture and asserts the gate REJECTS it, then strengthens the test and asserts it passes."
```

## Task 14: Run the full backend verification before pushing

- [ ] **Step 1**

```bash
cd backend && DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  REDIS_URL=redis://localhost:6379 ./verify.sh
```
Expected: every target passes. Then `./verify.sh mutation` separately, since it is not in `all`.

---

# PR 3 — property-based invariants

Worktree: `scripts/worktree-new.sh property-invariants` from the main checkout.

## Task 15: Add fast-check with a pinned seed

**Files:**
- Modify: `backend/package.json`
- Create: `backend/tests/fc.ts`

- [ ] **Step 1: Install**

```bash
cd backend && npm install --save-dev fast-check
```

- [ ] **Step 2: Write the seed module**

`backend/tests/fc.ts`:

```typescript
/**
 * One place that configures fast-check, so every property suite is deterministic by default.
 *
 * WHY PINNED RATHER THAN RANDOM. fast-check defaults to a fresh seed per run, so a property can
 * pass ninety-nine times and fail on the hundredth. The failure is real — it is a counterexample,
 * not a flake — but this repository treats a red build as a hard stop, and a gate that fails for a
 * reason unrelated to the change under review is the one thing that gets a gate ignored.
 *
 * So: CI is a deterministic regression suite over a fixed seed, and the SEARCH happens locally.
 * `FC_SEED=$RANDOM npm run test` explores; a counterexample it finds is a bug to fix, and the seed
 * that found it is worth pinning here alongside the original.
 */
import fc from "fast-check";

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20260829;
if (Number.isNaN(seed)) throw new Error(`FC_SEED is not a number: ${process.env.FC_SEED}`);

fc.configureGlobal({ seed, numRuns: 200 });

export { fc, seed };
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tests/fc.ts
git commit -m "build(backend): add fast-check with a pinned seed"
```

## Task 16: INV-1 as a generated operation sequence

**Files:**
- Create: `backend/tests/history/isolation.property.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * INV-1 and INV-5 as PROPERTIES rather than examples.
 *
 * isolation.test.ts asserts these invariants over cases a human (or a model) chose. That is exactly
 * the weakness this file addresses: whoever picked the cases picked them from the same
 * understanding that produced the code, so a shared misunderstanding survives every one of them.
 * The generator does not share it — it is not reasoning, it is trying things.
 *
 * AT THE HTTP LAYER, like the battery it generalises. Asserting against MemoryHistoryStore directly
 * would generalise the STORE's isolation; the invariant is about the SYSTEM, and the router's
 * `ownerOf(res)` derivation is the part most likely to be wrong.
 *
 * ONE LONG-LIVED SERVER PER OWNER, created once for the file. Handing supertest an app makes it
 * spin up and tear down an ephemeral server per request; at numRuns 200 these two properties would
 * make roughly 2,000 of them in one worker, and that pattern fails on socket churn rather than on
 * logic — measured as ECONNRESET after 662 requests on one run and HPE_INVALID_CONSTANT at 1,402 on
 * the next. It would surface as a property failure, which is precisely the nondeterminism
 * tests/fc.ts exists to keep out of a red build.
 *
 * The store must still be FRESH per run, so the app holds a delegating proxy whose target is
 * swapped between runs. Resetting with clearAll() instead would use the very method INV-5 is
 * testing to set up INV-5.
 *
 * The oracle is the INVARIANT, written in isolation.test.ts and docs/testing-notes.md. Never a
 * reading of memoryStore.ts or router.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { fc } from "../fc.js";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { HistoryStore } from "../../src/history/store.js";
import type { Owner } from "../../src/history/types.js";
import type { LLMService } from "../../src/llm.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";
import type { GenerationResult } from "../../src/schemas.js";
import { fakePrincipal } from "../helpers/auth.js";

const settings = loadSettings({ AUTH_REQUIRED: "false" });
const A: Owner = { userId: "auth0|A", tenantId: null };
const B: Owner = { userId: "auth0|B", tenantId: null };

const MESSAGE_GEN: GenerationResult = {
  shouldExecute: false,
  language: null,
  code: null,
  message: "not a coding task",
};

/** Swapped for a fresh store at the start of every property run. */
let inner = new MemoryHistoryStore();

/** Delegates every call to whatever `inner` currently is, so the app can outlive the store. */
const proxy: HistoryStore = {
  appendRun: (...a) => inner.appendRun(...a),
  listSessions: (...a) => inner.listSessions(...a),
  getSession: (...a) => inner.getSession(...a),
  renameSession: (...a) => inner.renameSession(...a),
  deleteSession: (...a) => inner.deleteSession(...a),
  clearAll: (...a) => inner.clearAll(...a),
  deleteRun: (...a) => inner.deleteRun(...a),
  close: () => inner.close(),
};

function appFor(userId: string) {
  return createApp({
    settings,
    history: proxy,
    requirePrincipal: fakePrincipal(userId),
    llm: { generate: async () => MESSAGE_GEN } as unknown as LLMService,
    sandbox: {
      execute: async () => {
        throw new Error("unused");
      },
    } as unknown as SandboxBackend,
  });
}

let serverA: Server;
let serverB: Server;
const servers: Record<string, Server> = {};

beforeAll(() => {
  // Port 0 lets the OS pick a free port — two of these, for the whole file.
  serverA = appFor(A.userId).listen(0);
  serverB = appFor(B.userId).listen(0);
  servers[A.userId] = serverA;
  servers[B.userId] = serverB;
});

afterAll(async () => {
  await new Promise<void>((r) => serverA.close(() => r()));
  await new Promise<void>((r) => serverB.close(() => r()));
  await inner.close();
});

/** One step in a generated sequence: who acts, and what they do. */
type Op =
  | { kind: "append"; owner: Owner; prompt: string }
  | { kind: "clear"; owner: Owner };

const ownerArb = fc.constantFrom(A, B);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("append" as const),
    owner: ownerArb,
    prompt: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({ kind: fc.constant("clear" as const), owner: ownerArb }),
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 25 });

describe("INV-1 as a property: a listing never contains another owner's session", () => {
  it("holds for any interleaving of appends and clears by two owners", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        inner = new MemoryHistoryStore();
        // The model: who owns each live session id, maintained independently of the store.
        const createdBy = new Map<string, string>();

        for (const op of ops) {
          if (op.kind === "append") {
            const { session } = await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: op.prompt,
              message: "ok",
            });
            createdBy.set(session.id, op.owner.userId);
          } else {
            await request(servers[op.owner.userId]).delete("/api/sessions");
            for (const [id, uid] of createdBy) if (uid === op.owner.userId) createdBy.delete(id);
          }
        }

        for (const owner of [A, B]) {
          const res = await request(servers[owner.userId])
            .get("/api/sessions")
            .query({ limit: 100 });
          expect(res.status).toBe(200);
          for (const session of res.body.sessions) {
            expect(createdBy.get(session.id)).toBe(owner.userId);
          }
        }
      }),
    );
  });
});

describe("INV-5 as a property: clear-all deletes only the caller's data", () => {
  it("leaves every session the other owner created, for any prior sequence", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        inner = new MemoryHistoryStore();

        for (const op of ops) {
          if (op.kind === "append") {
            await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: op.prompt,
              message: "ok",
            });
          }
        }

        const listB = async () =>
          (await request(serverB).get("/api/sessions").query({ limit: 100 })).body.sessions.map(
            (x: { id: string }) => x.id,
          );

        const before = await listB();
        await request(serverA).delete("/api/sessions");
        expect(await listB()).toEqual(before);
        expect(
          (await request(serverA).get("/api/sessions").query({ limit: 100 })).body.total,
        ).toBe(0);
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it passes against the real store**

```bash
cd backend && npx vitest run tests/history/isolation.property.test.ts
```
Expected: PASS.

- [ ] **Step 3: Prove the property has teeth — the RED that matters here.** Temporarily drop the
      owner filter from `listSessions` in `src/history/memoryStore.ts` (return every session
      regardless of owner) — the same hole `historyMutants.ts` plants as `LeakyListSessions` — and
      re-run:

```bash
npx vitest run tests/history/isolation.property.test.ts
```
Expected: FAIL, with fast-check printing a **shrunk counterexample** — the smallest operation
sequence that breaks isolation. Record that output in the PR body: it is the evidence the property
is real and not decorative. Then revert the source change with `git checkout src/history/memoryStore.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/history/isolation.property.test.ts
git commit -m "test(history): INV-1 and INV-5 as generated operation sequences"
```

## Task 17: Verify and open PR 3

- [ ] **Step 1: Full backend verification**

```bash
cd backend && DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  REDIS_URL=redis://localhost:6379 ./verify.sh
```
Expected: all targets pass.

- [ ] **Step 2: Confirm determinism** — run the suite three times and confirm identical results:

```bash
for i in 1 2 3; do
  npx vitest run tests/history/isolation.property.test.ts 2>&1 | grep -E '^ +Tests +'
done
```
Expected: the same `Tests  2 passed (2)` line each time. Grep the summary rather than `tail -3`,
which includes a duration and so differs on every run.

Then run it ten times, to catch socket exhaustion that a single pass would hide — the failure this
file's hoisted servers exist to prevent is intermittent, so one green run is not evidence:

```bash
for i in $(seq 10); do
  npx vitest run tests/history/isolation.property.test.ts >/dev/null 2>&1 || echo "FAILED on run $i"
done; echo "done"
```
Expected: `done` with no `FAILED` line. An `ECONNRESET` or `HPE_INVALID_CONSTANT` here means the
servers are not actually being reused.

- [ ] **Step 3: Confirm the search still works locally**

```bash
FC_SEED=1 npx vitest run tests/history/isolation.property.test.ts
FC_SEED=2 npx vitest run tests/history/isolation.property.test.ts
```
Expected: PASS both times, exercising different generated sequences.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "test: INV-1 and INV-5 as property-based invariants" --body "Closes #<CHILD-3>

The oracle is the invariant, not the implementation. Evidence the properties have teeth: dropping
the owner filter from memoryStore.listSessions produces this shrunk counterexample —

<paste from Task 16 Step 3>"
```

---

## Verification summary

| What | Command | Expected |
| --- | --- | --- |
| Scope script logic | `./scripts/tests/mutation-scope.test.sh` | `9/9 passed` |
| Decision logic (block AND count) | `./scripts/tests/mutation-decide.test.sh` | `7/7 passed` |
| The gate actually gates | `./scripts/tests/mutation-gate.test.sh` | `2/2 passed` |
| Suppression rule | `./scripts/tests/mutation-suppressions.test.sh` | `4/4 passed` |
| Gate on a real branch | `cd backend && ./verify.sh mutation` | Ranges listed, all mutants killed |
| Missing datastore in CI mode | `MUTATION_REQUIRE_FULL=1 DATABASE_URL= ./verify.sh mutation` | Exit non-zero |
| Unresolvable base | `MUTATION_BASE_REF=refs/heads/nope ./scripts/mutation-scope.sh` | Exit non-zero |
| Property determinism | three identical runs | Identical output |
| Property teeth | drop the owner filter | FAIL with a shrunk counterexample |
| Verify.sh contract | `./scripts/check-conformance.sh` | All assertions pass, incl. both new targets |
| Process-doc gate | `./scripts/tests/check-sdlc-sync.test.sh` | PASS |
| No carried file edited | `~/Workspaces/Claude/acb/bin/acb status` | `ahead: 0` |
| Everything | `cd backend && ./verify.sh` | All targets pass |

---

## Plan review log

Staff-engineer review 2026-08-29. The reviewer built `mutation-scope.sh`, `mutation-decide.mjs`,
`mutation-suppressions.sh`, their test suites and the Task 11 fixture verbatim from this plan and
ran them against a real `@stryker-mutator/core` 10.0.0 install. Two of the findings below were
defects that made the gate pass unconditionally in its real invocation — the exact
"gate that cannot fail" failure this plan exists to prevent.

**Applied without asking:**

- Task 7 Step 3: the git pathspec was cwd-relative. `backend/verify.sh` cds to `backend/` before
  calling the script, so `-- 'backend/src'` matched `backend/backend/src` and emitted nothing — the
  gate reported "no mutable lines" on every real run while its unit tests, which run from the repo
  root, stayed green. Changed to `-- ':(top)backend/src'`.
- Task 7 Step 3: `--diff-filter=AM` with `-M` drops renamed files entirely, so a rename-plus-edit
  escaped the gate. Changed to `--diff-filter=AMR`. Confirmed in passing that a *pure* rename
  produces no hunks, which settles spec Open Question 3 in the plan's favour.
- Task 7 Step 1: added test case 7 (running from `backend/` yields the same scope) and test case 8
  (a rename plus an edit is still scoped). Tally 6/6 → 8/8, updated in the test, in Task 7 Step 4
  and in the verification summary.
- Task 11 Step 3: the negative test checked only the exit code, so a gate that failed without
  naming the survivor would have passed it. It now captures the output and asserts
  `src/toggle.ts:.*(Survived)` appears — spec criterion 2 requires the survivor to be named.
- Task 11: new Step 2 excludes `tests/fixtures/**` in `backend/vitest.config.ts`. Without it the
  deliberately-weak fixture test — which asserts only a return type — was collected by
  `npm run test` and type-checked by `tsconfig.test.json`. Steps renumbered 2→3, 3→4, 4→5, 5→6, and
  `backend/vitest.config.ts` added to the File structure table and the Step 6 commit.
- Task 6 Step 3: cross-referenced the wrong task (said Task 8, meant Task 9) and named a config file
  with nowhere to write the value. The reviewer confirmed `reports/mutation/mutation.json` is
  Stryker 10.0.0's default with the `json` reporter; the step now names Task 10's `mutation()`
  target as the single hard-coded location.
- Task 5: new Step 1 refreshes the spec's Status line and ADR 0006's Tracking field before they are
  committed — both were carrying "planning has not started" and "none yet". Steps renumbered 1→2,
  2→3.

**Escalated to the user (unresolved at the time of writing):** the `thresholds` block in Task 9,
the runtime budget's missing abort criterion, the property tests' layer, and directory-based
eligibility versus the spec's enumerated file list.


Staff-engineer review follow-up 2026-08-29 — the four judgment findings, decided by the user and
folded in:

- **J1 (Task 9):** `thresholds` deleted from `stryker.conf.mjs`. `scripts/mutation-decide.mjs` is
  the sole gate, so there is no mutation score anywhere — ADR 0006 decision (2) and spec criterion
  10 now read cleanly. Task 9's verification step expects exit 0 and a written report.
- **J2 (Tasks 6, 10):** the abort criterion is **5 minutes** for the `Mutation test` CI step; over
  it, shrink the eligible set (drop `migrate.ts`, then `dockerBackend.ts`) and re-measure. The
  end-to-end proof moved out of the inner loop into a new `verify.sh mutation:selftest` target, run
  by CI as its own step and before every push. The `MUTATION_REQUIRE_FULL` precondition moved to the
  top of `mutation()`, which also resolves the reviewer's advisory note.
- **J3 (Task 16):** the property tests now drive assertions through the HTTP layer with supertest
  and `appFor(...)`, matching the battery they generalise, so the router's `ownerOf(res)` derivation
  is inside the invariant. Seeding still goes through the store, exactly as `isolation.test.ts`'s
  `seedA()` does.
- **J4 (Task 13):** directory-based eligibility kept (new files default IN — the fail-safe
  direction), and the "580 of 1,630 lines" claim removed from the process-document text, which now
  points at the declaration instead.

Also folded, after checking the `acb` repository (which the plan had not accounted for at all):

- The eligible set moved out of `scripts/mutation-scope.sh` into a new `.mutation-scope.json`, read
  at runtime. acb requires carried gate scripts to be byte-identical across consumers, and a
  hard-coded list would have made this file uncarryable — the same de-hardcoding acb's own PR #2 had
  to do to `check-pr-shape.sh` and `check-sdlc-sync.sh`.
- `scripts/mutation-scope.sh` now derives its pathspec and output prefix from the declared `root`,
  so it is repo-agnostic.
- Test case 9 added: a missing declaration is a hard failure, never an empty scope. Tally 8/8 → 9/9.
- New section *Where this work lands*, with the carried/generated split, the four concessions, and
  what is deferred to the adoption plan.

**Escalated and resolved (2026-08-29):** whether PR 1's rules should be authored in `acb` first.
The answer is that adoption is close, so this plan **waits for it** rather than being written
against a tree that is about to move. Status set to BLOCKED, and a seven-point re-verification
checklist added under *Where this work lands* → *Resuming after adoption*. No task content changed —
the plan is settled, only its start is deferred.


## Adoption re-verification log

2026-08-30 — `acb` adoption landed (#217, #218, #223, #224, #225). Plan re-verified against the
post-adoption tree and unblocked. Every change below is a mechanical consequence of what adoption
moved; no task's intent changed.

- **Header** — BLOCKED → ready. The pre-adoption checklist is replaced by *Verified against the
  post-adoption tree*: eight points, each recording what was actually found rather than predicted.
- **Task 2** — gained Steps 4–5. The oracle reasoning goes in `docs/testing-notes.md`, which
  adoption created to hold what the now-carried `test-driven-development` skill had to drop, and
  which already calls `memoryStore` "the oracle the Postgres implementation is measured against".
  The `## Review process` anchor in `CLAUDE.md` survived regeneration, so Task 2's insertion point
  is unchanged.
- **Task 3** — rewritten against `docs/sdlc-local.md` (`process.doc` in `.acb.json`).
  `docs/sdlc.md` is carried and byte-identical with acb, verified by `diff`; every anchor the task
  used to quote lives in that file and is off-limits.
- **Task 10** — new Steps 3a and 3b. Both targets must be appended to `TARGETS` *and* declared in
  `.acb.json`, because `scripts/check-conformance.sh` asserts the two agree in both directions and
  that every declared target dispatches and propagates a planted failure. The step that edited the
  unknown-target message was dropped: it now derives from `$TARGETS` and already exits 64.
- **Task 13** — retargeted to `docs/sdlc-local.md`, and adds `.mutation-scope.json` to
  `process.watched` — narrowing that file silently narrows the gate, which is the class of change
  the watched list exists to surface.
- **Concession 2** — six required checks now, not five, and declared in `.github/ruleset.json`.
- **Verification summary** — gained the conformance gate, the process-doc gate, and an `acb status`
  row asserting `ahead: 0`.

Three pre-adoption worries turned out to be wrong, and are recorded as such rather than quietly
dropped: `ci.yml` is generated-then-owned so a hand-edit is safe; the `CLAUDE.md` anchor survived;
and the `docker` → `package` rename does not collide with either new target name.

**Deliberately not done:** folding `.mutation-scope.json` into `.acb.json` (needs
`schema/acb.schema.json` extended upstream first) and `acb propose`-ing the generic rules upstream
(better once they are proven here).

---

## Plan review log — second round

Staff-engineer review 2026-08-30, dispatched fresh with no knowledge of the first round. The
reviewer built all three scripts, their suites and the fixture in a scratch directory, installed
Stryker 10.0.0 + the vitest runner + vitest 3.2.6, ran them, and ran `scripts/check-conformance.sh`
against a patched `backend/verify.sh` carrying both new targets (33 → 35 assertions passing).

**Three of its findings were hard, deterministic failures — the scripts could not run as written.**
Two of those (the illegal top-level `return`, and the `root` prefix) were introduced by the
post-adoption edits, which is *after* the first round ran the scripts; the first log's claim is
therefore stale rather than false. The third (the `mktemp` copy) was present all along and the first
round missed it. Treat neither log as evidence the current text runs — only a fresh run is.

**Applied without asking:**

- Task 7 Step 4: `config_key`'s `node -e` used a top-level `return`, which Node rejects with
  `SyntaxError: Illegal return statement` — so `mutation-scope.sh` died on its first call, on every
  machine. Rewritten as `if/else`, with a comment saying why.
- Task 7 Steps 1 and 3: `"root": "backend/src"` made the script emit `limits/quota.ts:2-2` where
  Stryker (cwd `backend/`) needs `src/limits/quota.ts:2-2` — it would have instrumented zero files
  while the gate reported success. `root` is now the component directory, `backend`, with `src/`
  carried in the `include` entries. The test-harness declaration matches.
- Task 11 Step 3: the strengthened fixture was copied to `mktemp -d`, from which Node can never
  resolve `backend/node_modules` — Stryker's sandbox dies on `Cannot find module 'vitest/config'`,
  no report is written, and the test fails for the wrong reason. It now lives at
  `backend/.mutation-selftest-strong`, which is gitignored.
- Task 9 Step 2: `reports` and `.stryker-tmp` added to `backend/.prettierignore`. Prettier resolves
  its ignore file from cwd and `backend/` has no `.gitignore`, so one local mutation run made the
  next `./verify.sh format` fail.
- Task 12 Step 2: the anchor step is `Package`, not `Docker build` — adoption renamed it. The same
  stale name is fixed in the spec.
- Task 5 Step 1: it would have overwritten the spec's Status paragraph, losing the post-adoption
  re-verification sentence. It now makes two surgical edits instead.
- Task 13 Step 3: the README anchors were wrong (`## Verification` is line 404, the bullet 409) and
  the bullet enumerates no targets, so the step now specifies a sentence rather than a list edit.
- File structure table: the `backend/verify.sh` row named one target where Task 10 adds two; rows
  added for `backend/package.json`, `backend/.prettierignore` and the fixture directory.
- Task 4: new Step 1a. `docs/README.md` still calls `sdlc.md` "**required** by the `SDLC docs` CI
  job", which adoption made false, and Task 4 is already editing that table.

**Escalated, blocking — see the escalation note below.** Stryker's concurrency against the single
CI Postgres and Redis; the ~2,000 ephemeral HTTP servers the property tests create; and the eligible
set's `exclude` list being wrong about `store.ts` and silent about `cli-migrate.ts`.

## Escalation resolved — the three decisions (2026-08-31)

1. **Stryker concurrency: chosen from the scope, not fixed.** `--concurrency 1` whenever the scope
   includes anything under `src/history/` or `src/limits/`; Stryker's default parallelism otherwise.
   A fixed `concurrency: 2` was considered and rejected: the collision is a race, not a load
   problem, so two workers corrupt the shared schema exactly as surely as eight — just less often,
   which is the worst outcome, because a spurious failure *kills* a mutant and makes the gate pass
   for the wrong reason.

   **The scope test is an allowlist of provably datastore-free paths — `auth.ts`, `schemas.ts`,
   `sandbox/` — not a denylist of datastore-backed ones.** A denylist fails open: a datastore-backed
   file added where the pattern does not anticipate runs in parallel, silently. The allowlist fails
   closed: anything unrecognised serializes until someone deliberately adds it. Everything else
   serializes, which is broader than the three files that talk to a datastore directly —
   `isolation.test.ts` and the contract suites run against both stores when `DATABASE_URL` is set,
   so mutating `memoryStore.ts` reaches Postgres too. Task 6 now measures both modes, and the 5-minute abort criterion applies to the
   single-worker one. The upgrade path, if that number hurts, is a per-worker database keyed on
   Stryker's `STRYKER_MUTATOR_WORKER` — documented for exactly this — set in `vitest.config.ts` so
   no file under `backend/src/**` changes.
2. **Property tests: one long-lived server per owner.** Created once in `beforeAll` on port 0 and
   closed in `afterAll`, with the app holding a delegating proxy whose target store is swapped per
   run — resetting with `clearAll()` would use the method INV-5 tests to set up INV-5. Task 17 gains
   a ten-run loop, because the failure this prevents is intermittent and one green run proves
   nothing.
3. **Eligible set corrected in both directions.** `src/history/store.ts` is now **in** scope — it
   holds `titleFromPrompt()`, not types. `src/history/cli-migrate.ts` is now **excluded**, for a
   different reason that is written down as different: no test imports it, so every mutant returns
   `NoCoverage` and the gate would hard-block with no remedy but a suppression on every line.

Also applied from the review's advisories: `exclude` matches exact paths only and now says so;
`mutation-suppressions.sh` fails closed on a missing directory; `Pending` is documented as
deliberately absent from the accepted-status set; `.dockerignore` keeps Stryker output out of the
production image build context; and concession 3 no longer claims a house style the test suites do
not follow.

One defect was found while verifying these edits and fixed in the same pass: the new
`"${stryker_args[@]}"` expansion aborts under `set -u` on macOS's bash 3.2 when the array is empty —
which is the common case — so it uses the portable `${a[@]+"${a[@]}"}` form instead. Confirmed
against `GNU bash 3.2.57(1)-release` on this machine.

**No open questions remain in this plan.** Spec Open Question 4 — whether the no-edit rule deserves
a reporting-only CI signal — is still open, and is deliberately out of scope here.
