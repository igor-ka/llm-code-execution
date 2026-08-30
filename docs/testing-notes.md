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
