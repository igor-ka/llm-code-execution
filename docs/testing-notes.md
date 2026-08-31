# Testing notes

What the `test-driven-development` skill's *This repository's commands* section used to say, kept
here because that skill is now carried from [`igor-ka/acb`](https://github.com/igor-ka/acb) and is
stack-agnostic. [`../CLAUDE.md`](../CLAUDE.md) holds the command table; this holds what needs more
than a table row — the traps, and where a test's oracle may legitimately come from.

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

## Property-based tests, and why the seed is pinned

`isolation.test.ts` asserts INV-1..8 over cases a human or a model chose. That is the weakness:
whoever picked the cases picked them from the same understanding that produced the code, so a
shared misunderstanding survives every one of them.

`isolation.property.test.ts` inverts it. You state the rule and `fast-check` generates hundreds of
operation sequences trying to break it, then **shrinks** any failure to the smallest input that
still fails. Dropping the owner filter from `memoryStore.listSessions` reduces a random 25-operation
sequence to `[{ kind: "append", owner: A, prompt: " " }]` in three shrinks.

**Assert both directions, or the property is half a test.** The first version of these properties
only walked the returned sessions checking that none belonged to the other owner — which a
`listSessions` returning *nothing at all* also satisfies, vacuously. Review caught it and it was
verified: destroying the listing entirely made both properties pass. They now compare the sorted id
sets, so "shows me everything of mine" and "shows me nothing of theirs" are one assertion that
neither a leak nor a wholesale deletion survives. A one-sided assertion is the decorative-test shape
this whole section is about, and it is easy to write by accident when the invariant is phrased as a
prohibition.

The generator does not share the model's misunderstanding — it is not reasoning, it is trying
things — which is the uncorrelated evidence hand-picked examples cannot provide.

**The seed is pinned in [`../backend/tests/fc.ts`](../backend/tests/fc.ts), and that is deliberate.**
fast-check defaults to a fresh seed per run, so a property can pass ninety-nine times and fail on
the hundredth. That failure is real — a counterexample, not a flake — but a gate that fails for a
reason unrelated to the change under review is the one thing that gets a gate ignored. It is worse
here than elsewhere: the mutation gate reads a test failure as a **kill**, so an unrelated failure
makes *that* gate pass for the wrong reason.

So CI is a deterministic regression suite over a fixed seed, and the search happens locally:

```bash
cd backend && FC_SEED=$RANDOM npm run test
```

A counterexample found that way is a bug to fix, and the seed that found it is worth pinning in
`fc.ts` alongside the original.

**One long-lived server per owner, not one per assertion.** Handing supertest an app makes it create
and tear down an ephemeral server per request; at `numRuns: 200` these two properties would make
roughly 2,000 of them in a single worker, which fails on socket churn rather than on logic. The
servers are created once in `beforeAll` on port 0, and the store stays fresh per run behind a
delegating proxy whose target is swapped — resetting with `clearAll()` would use the very method
INV-5 tests to set up INV-5.
