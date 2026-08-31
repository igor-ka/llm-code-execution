# 6. Trusting AI-written tests

- **Status:** Accepted
- **Date:** 2026-08-29
- **Tracking:** not yet filed. Decided (2026-08-31): **one epic with three children**, one per PR — the rules, the mutation gate, the property-based invariants. The plan's Task 0 files them and records the numbers.
- **Related:** spec [2026-08-28-trusting-ai-written-tests](../specs/2026-08-28-trusting-ai-written-tests.md); ADR [0002](0002-agentic-auth-security-testing.md) (whose retained artifact is the mutation-covered auth battery); [`sdlc.md`](../sdlc.md) phases 3–5 and [`sdlc-local.md`](../sdlc-local.md)

## Context

Most of the tests in this repository were written by an LLM, and that will continue. The evidence
currently offered for them is a green suite and line coverage, and neither answers the only
question that matters: **would this test notice if the code were wrong?**

The trigger was a proposal to add a mutation testing gate to CI. Investigating it surfaced that
mutation testing answers half the question, and not the half that hurts here.

A test makes two independent claims. **Sensitivity** — it fails when the code is wrong.
**Oracle correctness** — the **oracle**, whatever decides pass from fail, encodes what was actually
wanted. Only sensitivity is mechanizable: a tool has nothing to compare an oracle against except
the code, which is the very thing the oracle must be independent of.

And oracle correctness is where LLM-written tests fail, structurally rather than lazily. Ask a
model to test existing code and it reads the implementation and writes tests describing it. If
`auth.ts` compares expiry backwards, the test asserts the backwards behaviour, because the
implementation *was* the specification. That suite scores 100% on coverage **and 100% on mutation
testing** — every mutant dies, because the tests are precisely sensitive to a behaviour that is
wrong. A gate alone would have certified it.

Two pieces of local evidence shaped the decision:

**This repository has been bitten four times by gates that existed and did not fire.** The CSP was
attached only by the Vite dev and preview servers, so a static deploy of `dist/` shipped with no
CSP at all. `! grep -q …` under `set -e` does not abort — POSIX exempts a negated command from
errexit — so the negated image assertions passed on a bad image. A bare `python3` resolved on
`PATH` and proved nothing about a sandbox that runs with `PATH` empty, which is how
[#185](https://github.com/igor-ka/llm-code-execution/issues/185) reached production green. And
`npm audit` honours `npm_config_offline` and `npm_config_omit`, giving the audit gate two
environment-driven bypasses that both failed **open**. Every one was found by review, not by the
gate noticing.

**And it has independently invented the right pattern three times without naming it.**
[`contractTests.ts`](../../backend/tests/history/contractTests.ts) runs one suite against both
`MemoryHistoryStore` and `PgHistoryStore`, so neither implementation gets to define the answer;
[`quotaContract.ts`](../../backend/tests/limits/quotaContract.ts) does the same across memory and
Redis. INV-1..8 in [`isolation.test.ts`](../../backend/tests/history/isolation.test.ts) assert a
written specification of isolation rather than a reading of the router.
[`mutants.ts`](../../backend/tests/mutants.ts) and
[`historyMutants.ts`](../../backend/tests/history/historyMutants.ts) plant holes derived from a
threat model. Three different oracles, none taken from the code under test. The decision below
mostly names an existing practice and makes it binding.

## Decision

1. **Gate sensitivity; rule the oracle.** One automated gate for the half a machine can check, and
   process rules for the half it cannot. Not one mechanism, and not weighted toward the tooling.

2. **The mutation gate is diff-scoped, with no mutation score and no baseline.** The rule is *every
   mutant generated on a line this PR changed must be killed*. A repository-wide score measures the
   suite when the question is about this change; it can sit flat while a PR adds forty untested
   lines. This follows Google's published approach (*State of Mutation Testing at Google*, Petrović
   and Ivanković, ICSE-SEIP 2018), which is diff-based and computes no score at all.

3. **An oracle may not come from the implementation.** The test: *if the implementation were
   deleted, could you still write this assertion?* Three legal sources — written first (RED), a
   document (a spec criterion, a named invariant, a threat), or a second implementation (the
   contract suites).

4. **Never ask for tests after the code.** "Write the implementation, now add tests" guarantees an
   implementation-derived oracle, because there is nowhere else for a model to get one. This is the
   single highest-leverage line in the decision and it costs nothing.

5. **Enforcement of (3) and (4) is process and review, deliberately not CI.** RED must be observed
   and recorded; review carries one question per new test — *where did this expected value come
   from?* A CI check for the presence of a PR-body section would be a box to tick, and a gate that
   cannot inspect what it gates is the decorative-assertion pattern this repo has already had to
   fix once.

6. **Semantic mutants stay committed fixtures, never generated at CI time.** A gate whose mutant
   population changes between two runs of the same commit can pass and then fail with nothing
   changed, which is not a gate. Authoring them belongs in the `security-and-hardening` threat-model
   pass those files already require.

7. **Property-based tests carry the invariants**, with the seed pinned in CI and free locally. The
   generator does not share the model's misunderstanding, which is exactly the uncorrelated evidence
   hand-picked examples cannot provide.

8. **Rules ship before tooling**, and **`docs/escaped-defects.md` is the calibration loop** — one
   line per defect that reached `main`, naming the gate that should have caught it. It is the only
   empirical evidence that trust is rising rather than holding still, and it is why the reversal
   conditions below are checkable.

The spec's remaining open questions are parameters — whether survivors block or are surfaced,
whether uncovered changed lines count as survivors, the runtime budget. They do not move the
architecture above.

## Alternatives considered

- **A repository-wide mutation score held to a ratchet.** The first proposal, and rejected on the
  reasoning in (2): it answers a different question, and it carries a standing cost — re-measuring
  1,630 lines to move the number, and arguing about whether a 0.4% drop is noise.
- **Stryker's `--incremental` as the scoping mechanism.** It is a performance cache
  (`stryker-incremental.json`), not a scope control; a missing file makes the run a full fresh
  analysis, so it fails slow rather than open. Stryker has **no `--since` flag** at all — verified
  against the 10.0.0 docs on 2026-08-28 — so git-diff scoping is ours to build regardless. It is
  buildable deterministically because `mutate` accepts a line range (`src/auth.ts:40-47`).
- **Coverage thresholds.** Measures execution, not sensitivity. It is the instrument that already
  failed here: every one of the four escaped defects sat in covered code.
- **CI-enforced RED evidence** — a required "Prove-It" section in the PR body. Rejected per (5): a
  presence check cannot read what it checks, so it converts a real practice into a ritual.
- **LLM-generated semantic mutants at CI time.** Rejected per (6). Attractive in a repository built
  on the Anthropic SDK, and still wrong: nondeterminism in the mutant population makes the gate
  irreproducible.
- **Surfacing survivors as review comments instead of blocking**, which is what Google does. Not
  rejected — deferred to the spec's Open Question 1. Their constraint is 24,000 developers who route
  around a noisy blocker; this repository has one and already blocks on `npm audit`.
- **Human review of every generated test.** Not sustainable, and misdirected: attention pays on the
  assertions and on the test *names* read against the requirement, not on reading every body.

## Consequences

- **Legacy weakness becomes invisible.** Diff-scoping never surfaces survivors in untouched code.
  Accepted deliberately: the gate is about the change.
- **The gate will occasionally block on a mutant nobody can kill.** An **equivalent mutant** — one
  whose edit cannot change observable behaviour — is unkillable by construction. The
  `// Stryker disable next-line <mutator>: <reason>` comment is the pressure valve, and each use is
  a small, visible tax in review rather than a silent one.
- **Two of the five mechanisms cannot be enforced by machine.** (3) and (4) decay silently the
  moment review stops asking. This is the honest weak point of the decision, and the escaped-defect
  log is the only instrument that will show it happening.
- **`fast-check` introduces the only nondeterminism in the suite.** Pinning the seed in CI is the
  containment; local runs keep the search.
- **`Backend checks` gets slower on pull requests**, on top of the three Docker images it already
  builds.
- **The calibration loop pays off in months, not weeks.** Ten lines of the log will say more than
  any score; one line says nothing.

## Reversal

- **If the repository ever needs a suite-quality number for an external audience**, add a periodic
  non-gating full-repo run. Do not reintroduce the score as a gate — that is the decision in (2),
  and the audience, not the mechanism, would have changed.
- **If the gate blocks on unkillable mutants more than about once a month**, switch (2) from
  blocking to surfacing, which is Google's posture and is cheaply reversible in either direction.
- **The process rules reverse on evidence, not on friction.** If `docs/escaped-defects.md` shows
  defects escaping *through* covered, mutation-clean, oracle-independent tests, the model of trust
  in this ADR is wrong and should be rewritten. If it shows nothing escaping, the rules are working
  and their cost is the point rather than a complaint.
