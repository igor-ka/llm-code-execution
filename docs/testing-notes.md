# Testing notes

What the `test-driven-development` skill's *This repository's commands* section used to say, kept
here because that skill is now carried from [`igor-ka/acb`](https://github.com/igor-ka/acb) and is
stack-agnostic. [`../CLAUDE.md`](../CLAUDE.md) holds the command table; this holds the two traps
that need more than a table row.

## The service-backed suites self-skip, and a green `test` is not evidence they ran

The Postgres history suites and the Redis quota suite skip themselves when `DATABASE_URL` and
`REDIS_URL` are unset — which is correct, because the DB-free `./verify.sh test` must run on a
laptop with no services. It also means a green `./verify.sh` proves nothing about them.

Touching `backend/src/history/**`, `backend/migrations/**` or `backend/src/limits/**` means
running them explicitly:

```bash
cd backend
DATABASE_URL=postgres://app:app@localhost:5432/app REDIS_URL=redis://localhost:6379 \
  ./verify.sh test:integration
```

The target runs when *either* variable is set and prints which half is self-skipping. A partial
run is better than none and is **not** full coverage; the message says which you got.

## Ruling out test pollution

If a test passes alone and fails in the suite, the bug is in the tests, not the code under test.
Vitest runs files in parallel by default, so the isolating run is:

```bash
cd backend && npx vitest run tests/<path>.test.ts --no-file-parallelism
```

`git bisect` takes the same shape — `git bisect run ./verify.sh test` for the whole suite, or the
focused invocation above when the suite is slow.

## One contract suite, two implementations

`HistoryStore` has two implementations — `memoryStore` and `PostgresHistoryStore` — and one
contract suite runs the same tests against both. `memoryStore` is a **fake**, not a mock: it is a
real implementation of the interface, and it doubles as the oracle the Postgres implementation is
measured against.

When you add a store method, extend the shared contract suite rather than one implementation's
tests. Extending only one is how the fast in-memory oracle and the real backing store silently
diverge, and the divergence surfaces in production rather than in CI.

The same shape applies to `QuotaStore`, whose in-memory and Redis implementations sit behind one
interface for the same reason.

## Where the tests live, and what covers the frontend

Backend tests are in `backend/tests/`; `history/` there holds the contract, router, persistence
and cross-user isolation suites. Frontend tests sit beside their source in `frontend/src/`.

There is no `chrome-devtools` MCP server here, so an agent has no in-browser inspection loop.
Frontend behaviour is covered by Vitest; verify UI changes manually against the running app
(`npm run dev`, or the Compose stack).

## Where an oracle may come from

A test's **oracle** is whatever decides pass from fail — usually the expected value in the
assertion. Most tests here are model-written, and a model asked to test existing code reads the
implementation and writes tests describing it, so a bug becomes the expected value. That suite
scores 100% on coverage *and* 100% on mutation testing: the tests are precisely sensitive to a
behaviour that is wrong. Mutation testing measures **sensitivity** — whether a test can fail at
all — and no tool can measure whether it fails at the *right* thing.

**The test: if the implementation were deleted, could you still write this assertion?**

Three legal sources, all three already in use here:

| Source | The oracle is | Where |
| --- | --- | --- |
| Written first | A test that failed before the code existed cannot have been copied from it | The RED step; the Prove-It pattern for bugs |
| A document | A spec success criterion, a named invariant, a threat | INV-1..8 in [`../backend/tests/history/isolation.test.ts`](../backend/tests/history/isolation.test.ts) |
| A second implementation | Two implementations must agree, so neither defines the answer | The contract suites above — and this is why `memoryStore` is a fake, not a mock |

**Semantic mutants** are the third source sharpened to a point.
[`../backend/tests/mutants.ts`](../backend/tests/mutants.ts) plants four holes in the auth check —
expiry unverified, scope matched by substring, audience unverified, gate off — and
[`historyMutants.ts`](../backend/tests/history/historyMutants.ts) drops one owner filter per method,
asserted as INV-7. Their oracle is the threat model; nothing about the implementation is consulted.

They are committed fixtures asserted by ordinary tests, and are **never generated at CI time**: a
gate whose mutant population changes between two runs of the same commit can pass and then fail with
nothing changed, which is not a gate. Authoring them belongs in the `security-and-hardening`
threat-model pass that the *Sensitive paths* in [`../CLAUDE.md`](../CLAUDE.md) already require —
for each threat, ask whether it is expressible as a planted hole.
