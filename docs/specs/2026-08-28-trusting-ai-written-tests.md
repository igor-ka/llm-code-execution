# Spec: trusting AI-written tests

**Status:** agreed. Planning complete (see the plan below) and re-verified against the tree after
`acb` adoption landed on 2026-08-30. Open Questions 1, 2 and 6 are resolved by decision; 3 is resolved
by `-M` plus `--diff-filter=AMR` in the scope script; 5 is measured in the plan's Task 6. Question 4
remains open.
**Date:** 2026-08-28
**Plan:** [`2026-08-29-trusting-ai-written-tests`](../plans/2026-08-29-trusting-ai-written-tests.md)
**Decision record:** [ADR 0006](../adr/0006-trusting-ai-written-tests.md) — the two-halves reasoning, and why a mutation score was rejected.
**Supersedes:** an earlier draft of this file scoped only to a mutation testing gate. That gate
survives as one of five mechanisms here; it was never sufficient on its own, for the reason in
"The two halves" below.

## Objective

Most of the tests in this repository were written by an LLM, and that will continue. The question
this spec answers is not "are the tests good" but **what evidence would justify trusting them**,
and how that evidence gets produced as a by-product of normal work rather than as an audit nobody
has time for.

The output is one automated gate, three process rules, and one calibration loop. Deliberately
weighted that way: the gate catches the *cheapest* failures, and the rules catch the *most common*
one.

## The two halves of a trustworthy test

A test makes a claim, and the claim has two independent parts:

1. **Sensitivity** — does it fail when the code is wrong?
2. **Oracle correctness** — the **oracle** is whatever decides pass from fail, usually the expected
   value in the assertion. Does it encode what you actually wanted?

**Only the first is mechanizable.** Sensitivity is exactly what mutation testing measures: break
the code, see whether anything complains. Oracle correctness cannot be measured by any tool,
because a tool has nothing to compare the oracle against except the code — which is the very thing
the oracle is supposed to be independent of.

**And the second is where AI-written tests predominantly fail.** The failure is not laziness; it is
structural. Ask a model to test existing code and it reads the implementation and writes tests that
describe it. If `auth.ts` compares expiry backwards, the test asserts the backwards behaviour,
because *the implementation was the specification*. That suite scores 100% on coverage **and 100%
on mutation testing** — every mutant dies, because the tests are exquisitely sensitive to a
behaviour that is wrong.

Everything below follows from that: a gate for the half a machine can check, and rules for the half
it cannot.

## How AI-written tests actually fail

Trust is only meaningful against specific failures. These are the ones worth designing for, and
what catches each:

| Failure | What it looks like | Caught by |
| --- | --- | --- |
| **Implementation-derived oracle** | The expected value was read off the code; a bug becomes the expectation | RED-first + the oracle rule + one review question. **Not the mutation gate** |
| Hand-picked examples that share the bug | Six cases, all consistent with the same misunderstanding | Property-based tests |
| Adjusted-to-green | An existing assertion was edited until it passed | The no-edit rule + review |
| Decorative assertion | Exercises the code, asserts nothing that constrains it | Mutation gate |
| Coverage-shaped test | Written to touch lines rather than to pin behaviour | Mutation gate |
| Test-the-mock | Mocks the unit under test, asserts the mock was called | Mock-boundary rule; survivors show up in the gate |
| Gate that cannot fail | `\|\| true`, `! grep -q` under `set -e`, `grep -qv` inverting per line | A negative test per gate |

Read the first row twice. **The most consequential failure is the one the tooling cannot see**,
which is why a spec that shipped only the mutation gate would have been answering the easier
question.

## Mechanism 1 — the diff-scoped mutation gate

**Mutation testing** edits the source mechanically — `>` becomes `>=`, a statement is deleted, a
returned string becomes `""` — and re-runs the tests against each edited copy. Each copy is a
**mutant**; if some test fails it is **killed**, if every test passes it **survived**, and a
survivor names a bug the suite would not notice.

**Scoped to the diff, with no score and no baseline.** The rule is *every mutant generated on a
line this PR changed must be killed*. A repository-wide **mutation score** measures the suite; the
goal here is to measure this change's tests, and a score can sit flat while a PR adds forty
untested lines. This follows Google's published approach — *State of Mutation Testing at Google*
(Petrović and Ivanković, ICSE-SEIP 2018), across 1,000+ projects and 24,000+ developers — which is
diff-based, discards mutants on uncovered and uninteresting lines, and computes no score at all.

Stryker (`@stryker-mutator/core` 10.0.0, `@stryker-mutator/vitest-runner` 10.0.0; peer
`vitest >=2.0.0`, satisfied by backend 3.2.6) has **no `--since` flag** — checked against the docs
on 2026-08-28 — so the scoping is a small script. It is deterministic and needs no cache, because
`mutate` accepts a line range:

```
git diff --unified=0 --diff-filter=AM origin/main...HEAD -- backend/src
```

Three-dot is the merge-base diff, which is what a PR proposes. Each `@@ -a,b +c,d @@` header yields
the range `c` to `c+d-1`, emitted as `src/auth.ts:40-47`. Line ranges cannot be combined with globs
in one entry, so every entry is an explicit range. `actions/checkout` shallow-clones by default, so
the workflow needs `fetch-depth: 0` — and an unresolvable merge base must be a hard failure, since
it is the likeliest way this gate silently checks nothing.

**Eligible files** — the set `CLAUDE.md` already forces a threat-model pass on, plus the shared
request validator, so the boundary is an existing rule rather than a fresh judgment:
`src/auth.ts` · `src/history/{memoryStore,pgStore,router,migrate,dto,pool}.ts` ·
`src/limits/{redisQuota,memoryQuota,middleware,quota,concurrency}.ts` ·
`src/sandbox/{dockerBackend,cloudRunSandbox,concurrencyLimited}.ts` · `src/schemas.ts` — ~1,630 of
3,036 backend lines. Type-only files hold no runtime behaviour to mutate.

**Which tests get to kill mutants: all of them, but the cost is not symmetric.** A mutant dies to
*any* failing test, so adding a tier only ever helps correctness; what it costs is runtime, roughly
`mutants × time of the tests covering each mutant`. Stryker's **per-test coverage analysis** runs
only the tests that touch a mutant, so a line covered by both a fast and a slow test costs the fast
one — but a line covered *only* by the slow tier costs the slow tier every time. Two facts here:
**there is no e2e suite** (no Playwright or Cypress in either `package.json`), so the tiers are the
unit suite (247 tests, 8.7s) and the datastore-gated integration suites; and the integration tier is
**not optional**, because `pgStore.ts`, `migrate.ts` and `redisQuota.ts` are 580 of the 1,630
eligible lines and their suites self-skip when `DATABASE_URL` / `REDIS_URL` are unset. A DB-free
mutation run does not skip those files — it reports every mutant in them as *survived*, which is
not incomplete output but wrong output.

So it is an integration-configuration run, following `verify.sh test:integration`: CI sets both
variables against the service containers `Backend checks` already starts; locally an unset variable
means those ranges are named and skipped, loudly; and the workflow sets `MUTATION_REQUIRE_FULL=1`,
under which a missing variable is a hard failure rather than a downgrade — without it the gate
fails open the moment a service container does not start.

**Escape hatch:** `// Stryker disable next-line <mutator>: <reason>`, reason mandatory, visible in
the diff — the same shape as the dated-exception rule the `npm audit` gate already uses. An
**equivalent mutant** (one whose edit cannot change observable behaviour — a mutated log message, a
retry delay) is unkillable by construction, so a hard gate needs this or it eventually blocks a PR
nobody can unblock.

**Where it runs:** a `verify.sh mutation` target invoked by a `Mutation test` step in
`Backend checks`, PRs only, like `Package`. No job `name:` changes, so the "Protect main"
ruleset is untouched. The local run is the first signal and CI is the backstop — if the workflow is
working, CI should never find a survivor.

**It must announce an empty scope.** A PR touching no eligible file has zero mutants and passes
trivially; a silent pass and an empty scope look identical in a log, and this repo has shipped a
decorative assertion once already.

## Mechanism 2 — the oracle rule

**One question decides it: if the implementation were deleted, could you still write this
assertion?** If no, the oracle came from the code and the test is worth close to nothing regardless
of who typed it.

There are exactly three legal sources for an oracle, and this repository has independently
discovered all three:

| Source | The oracle is | Already here |
| --- | --- | --- |
| **Written first** | A test that existed and failed before the code did cannot have been copied from it | The RED step of `test-driven-development`; the Prove-It pattern for bugs |
| **A document** | The spec's success criteria, a named invariant, a threat | [`isolation.test.ts`](../../backend/tests/history/isolation.test.ts) INV-1..8 |
| **A second implementation** | Two independent implementations must agree, so neither defines the answer | [`contractTests.ts`](../../backend/tests/history/contractTests.ts) across memory and Postgres; [`quotaContract.ts`](../../backend/tests/limits/quotaContract.ts) across memory and Redis |

A fourth is a special case of the second: **semantic mutants** — hand-authored holes expressing a
threat, as in [`mutants.ts`](../../backend/tests/mutants.ts) (four auth holes) and
[`historyMutants.ts`](../../backend/tests/history/historyMutants.ts) (a dropped owner filter per
method, asserted as INV-7). Their oracle is the threat model; nothing about the implementation is
consulted. **These are committed fixtures asserted by ordinary tests, never generated at CI time** —
a gate whose mutant population changes between two runs of the same commit can pass and then fail
with nothing changed, which is not a gate. Authoring them belongs in the `security-and-hardening`
threat-model pass those files already require: *is this threat expressible as a planted hole?*

**The rule that prevents the failure rather than catching it: never ask for tests after the code.**
"Write the implementation, now add tests" guarantees an implementation-derived oracle, because
there is nowhere else for a model to get one. That single ordering causes most of the risk this
spec exists to address.

**Enforcement is process and review, deliberately not CI.** The RED step must be *observed* — the
failure output recorded in the PR body, or RED committed separately so `git show` proves it. A CI
check for the presence of such a section would be a box to tick, and a gate that cannot inspect
what it is gating is the decorative-assertion pattern this repo has already had to fix once.
Review carries one question per new test: **where did this expected value come from?**

## Mechanism 3 — two hygiene rules

**Never edit an existing test to make it pass.** When a test fails there are two legal moves: fix
the code, or state why the expectation was wrong and get human sign-off. Silently adjusting an
expected value is how a generated suite rots into a transcript of whatever the code currently does,
and it is invisible in review because the diff looks like ordinary test churn. The tell worth
flagging: an assertion changing in the same PR as the source it covers.

**Mock only at process boundaries** — the Docker socket, Postgres, Redis, the Anthropic API, the
Auth0 JWKS endpoint. Never mock the unit under test. A test that mocks its subject and asserts the
mock was called proves wiring and nothing else, and it will happily survive every mutant.

Both go in `CLAUDE.md` and become review-checklist items for the `code-review` skill.

## Mechanism 4 — property-based tests on the invariants

Normally the author picks the examples. INV-1 is six cases someone thought of; if a model wrote
them and misunderstood something, it picks six examples consistent with its own misunderstanding
and they all pass. **Property-based testing** inverts this — you state a rule that must hold for
every input and a library generates hundreds of inputs trying to break it, then **shrinks** any
failure to the smallest input that still fails.

A **property** is any rule that must hold across many inputs; an **invariant** is the subset that
must hold of the system's state at every moment regardless of history. The difference is what gets
generated: random *inputs* for a property, random *sequences of operations* for an invariant.

`fast-check` is the library (new dev dependency; a plain function call inside `it()`, so no runner
changes). Targets, in order of value:

1. **INV-1..8 generalised.** "For any two owners and any interleaving of create/rename/delete/list,
   A's list never contains an id B created" — the invariant is already written, the generator
   replaces the six hand-picked cases. `fc.commands` generates operation sequences.
2. **Quota arithmetic** — the counter never goes negative; the decision is monotonic in the count.
3. **`schemas.ts` round-trips** — a genuine property rather than an invariant.

**Why it belongs on a trust list:** the generator does not share the model's misunderstanding. It
is not reasoning at all, which is exactly the uncorrelated evidence hand-picked examples cannot
provide.

**Seed policy: pinned in CI, free locally.** By default the seed is random per run, so a test can
pass ninety-nine times and fail on the hundredth — reproducible after the fact from the printed
replay seed, but still nondeterminism, and this repo treats a red build as a hard stop. Pinning in
CI makes it a deterministic regression suite; letting it vary locally is where new counterexamples
get found. A counterexample found locally is a real bug, never a flake.

## Mechanism 5 — the escaped-defect log

The only empirical evidence that trust is going up rather than sideways. `docs/escaped-defects.md`,
one line per defect that reached `main`: the date, what broke, **which gate should have caught it
and did not**, and what changed as a result. Non-gating, a document.

It starts non-empty, which is what makes it worth having — four are already recorded in comments
scattered across the repo:

- The CSP existed only as a Vite dev/preview response header, so a static deploy of `dist/` shipped
  with **no CSP at all**; a unit test on the policy builder cannot catch "the server forgot the
  header."
- `! grep -q …` under `set -e` does not abort — POSIX exempts a negated command from errexit — so
  the negated image assertions silently passed on a bad image.
- A bare `python3` in an image assertion resolved on `PATH` and proved nothing about the sandbox,
  which runs with `PATH` empty; that gap let #185 reach production green.
- `npm audit` honours `npm_config_offline` and `npm_config_omit` / `NODE_ENV=production`, so the
  audit gate had two environment-driven bypasses that both failed **open**. Found by review, not by
  the gate noticing.

Every one is a gate that existed and did not fire. Ten lines of this will say more about whether to
trust the suite than any score.

## Where each mechanism sits in the SDLC

| Phase | What happens | Mechanism |
| --- | --- | --- |
| **Spec** | Success criteria written as observable behaviour — the oracle source everything downstream copies | 2 |
| **Plan** (`writing-plans`) | Each task naming a test names the invariant it asserts. "Matches the implementation" is not an acceptable answer, and the staff review checks it | 2 |
| **Build — RED** | The test is written and **run failing** before the code. Failure output recorded in the PR body | 2 |
| **Build — threat model** (`security-and-hardening`) | For each threat: is it expressible as a planted hole? If yes it is authored and committed | 2 |
| **Build — REFACTOR** | `./verify.sh mutation` on the touched lines. Survivors are the missing assertions, written while the code is still in your head | 1 |
| **Verify** | The same diff-scoped command CI will run | 1 |
| **CI** | Backstop, not first signal. Identical command, PR-scoped | 1 |
| **Review** (`code-review`) | Three questions: where did this expected value come from; did any existing assertion change; is anything mocked that is not a process boundary | 2, 3 |
| **After an incident** | One line in the log naming the gate that should have caught it | 5 |

Property-based tests (4) are ordinary tests and run wherever tests run.

## Sequencing

Rules before tooling, because the rules catch the dominant failure and cost nothing to ship:

1. **The rules.** `CLAUDE.md` and `docs/sdlc.md` changes for mechanisms 2 and 3, plus
   `docs/escaped-defects.md` seeded with the four above. No code. Immediate effect.
2. **The mutation gate.** `verify.sh mutation`, the diff-scoping script, the CI step, the negative
   self-test, docs.
3. **Property-based tests.** `fast-check`, INV-1..8 generalised, then quota and schemas.

Later, not now: the frontend (1,208 lines; React component mutants are noisy and a noisy gate gets
ignored), and any periodic full-repo mutation run.

The plan fixes the actual PR boundaries; this is scope order.

## Success criteria

1. `cd backend && ./verify.sh mutation` mutates only lines changed against `origin/main` and exits
   non-zero when any mutant on those lines survives.
2. **The gate is proven able to fail** — a self-test in `scripts/tests/` removes an assertion from a
   real test, runs the target, and asserts a non-zero exit naming the survivor. Same discipline as
   the `VITE_AUTH0_AUDIENCE` negative test in `backend/verify.sh`, and the only thing separating
   this from a decorative assertion.
3. With `MUTATION_REQUIRE_FULL=1` and `DATABASE_URL` unset, the target exits non-zero. With an
   unresolvable merge base, it exits non-zero.
4. A PR touching no eligible file passes **and says it found no mutable lines**.
5. A suppression comment without a reason is rejected.
6. `CLAUDE.md` states the oracle rule, the never-ask-for-tests-after-the-code rule, the no-edit rule
   and the mock-boundary rule; `docs/testing-notes.md` carries the three legal oracle sources; the
   three review questions are in `docs/sdlc-local.md`. None of it is in a skill file —
   `.claude/skills/**` is carried from `acb`, and `code-review` is built-in rather than vendored.
7. INV-1 exists as a generated-sequence property, and deleting the owner filter from
   `memoryStore.ts` makes it fail with a shrunk counterexample.
8. `docs/escaped-defects.md` exists with the four seeded entries.
9. `docs/sdlc-local.md` is updated in the same PRs — mandatory, these touch `verify.sh`,
   `.github/workflows/**`, `scripts/` and `.acb.json`, four watched paths — and `README.md` gains
   both new targets. `docs/sdlc.md` is **not** touched: it is carried from `acb`, byte-identical
   with it, and an edit here would be reverted by the next `acb pull`.
10. No mutation score or baseline file exists anywhere in the repository.
11. `./scripts/check-conformance.sh` passes with `mutation` and `mutation:selftest` declared,
    dispatching and propagating failure, and `acb status` still reports **0 ahead** — no carried
    file was edited to ship this.

## Boundaries

**Always**
- Fail closed. A missing datastore, an unparseable diff, an unresolvable merge base: failure.
- Every suppression carries a one-line reason, inline, in the diff.
- Semantic mutants are committed fixtures, reviewed like code.
- RED is observed and recorded before GREEN.

**Ask first**
- Expanding the eligible file set, or adding the frontend.
- Anything touching a CI job `name:` or the required-checks ruleset.
- Adding a repository-wide mutation score — it was considered and rejected.

**Never**
- Edit a file `acb` carries — `docs/sdlc.md`, `.claude/skills/**`, `scripts/check-{pr-shape,sdlc-sync,conformance}.sh`.
  An edit makes this repository *ahead* and the next `acb pull` reverts it. Use `acb propose`.
- `|| true`, `continue-on-error`, or "report but don't block" on the gate.
- Generating semantic mutants at CI time.
- Editing an existing test to make it pass without sign-off.
- Asking for tests after the implementation is written.
- Running the mutation gate in CI without both datastores.

## Open questions

1. **RESOLVED 2026-08-29 — survivors block the merge.** Not surfaced as a comment. The gate exits
   non-zero and the PR cannot merge until every mutant on a changed line is killed or suppressed
   with a reason.
2. **RESOLVED 2026-08-29 — changed lines with no coverage count as survivors.** A mutant Stryker
   marks `NoCoverage` fails the build exactly as a `Survived` one does, so the gate also catches
   "this PR added a line no test executes." Stryker's default mutation score already counts
   `NoCoverage` against the total, so `thresholds.break = 100` implements this directly.
3. **Rename and move-only PRs** show every moved line as changed, so a no-op refactor generates a
   large mutant set. Mitigate with `git diff -M`, accept the occasional slow PR, or add a skip
   marker?
4. **Is the no-edit rule worth a reporting-only CI signal** — flagging a PR that changes an existing
   assertion and the source it covers — or does a non-blocking annotation violate the "every check
   gates something" principle and become noise?
5. **Runtime budget.** `Backend checks` already builds three Docker images. Diff-scoping should keep
   this small, but the number is unknown until measured on three representative past PRs, which is
   the first plan task.
6. **Does this become one epic with three children, or three independent issues?** The sequencing is
   real but the mechanisms are independent, and the rules PR delivers value with nothing after it.

## Glossary

**Oracle** — whatever decides pass from fail in a test, usually the expected value in the
assertion.
**Sensitivity** — whether a test fails when the code is wrong; the half a machine can measure.
**Mutation testing** — testing the tests, by making small mechanical edits to the source and
checking that some test fails for each one.
**Mutant** — one copy of the source with exactly one edit applied.
**Killed / survived** — killed when at least one test fails against the mutant; survived when every
test still passes.
**Mutation score** — the percentage of all mutants killed; deliberately not used here.
**Equivalent mutant** — a mutant whose edit cannot change observable behaviour, so no test can ever
kill it.
**Diff-scoped** — mutating only the lines a change touches, computed from `git diff`.
**Per-test coverage analysis** — Stryker recording which tests execute which lines in one initial
run, so each mutant re-runs only the tests that touch it.
**Semantic mutant** — a hand-authored hole expressing a specific threat, committed as a fixture and
asserted by an ordinary test.
**Property** — a rule that must hold across many inputs, not just a chosen example.
**Invariant** — a property of the system's state that must hold at every moment regardless of
history.
**Property-based testing** — stating the rule and letting a library generate inputs to break it,
shrinking any failure to the smallest counterexample.
**Backstop** — a check that confirms a standard already met elsewhere, rather than being where the
standard is discovered.
