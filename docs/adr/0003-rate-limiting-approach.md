# 3. Rate limiting approach

- **Status:** Accepted
- **Date:** 2026-08-08
- **Tracking:** epic [#62](https://github.com/igor-ka/llm-code-execution/issues/62) (work items [#64](https://github.com/igor-ka/llm-code-execution/issues/64)–[#70](https://github.com/igor-ka/llm-code-execution/issues/70))
- **Related:** spec [2026-08-08-per-user-rate-limiting](../specs/2026-08-08-per-user-rate-limiting.md); auth ADR [0001](0001-authentication-approach.md)

> **Reading the `D<n>` / `S<n>` codes.** Source comments in `backend/src/limits/**` and
> `backend/src/sandbox/concurrencyLimited.ts` cite decisions as **D1–D9** and success criteria as
> **S1–S11**. The decisions are the sections below; the criteria live in
> [the spec](../specs/2026-08-08-per-user-rate-limiting.md#success-criteria). D2 (anonymous
> bucket), D3 (count requests, two windows) and D7 (SPA handling) are recorded in the spec only.

## Context

`POST /api/execute` had no cap of any kind. One authenticated user — or one client stuck in a
retry loop — could exhaust two separate resources:

- **API budget.** `llm.generate` runs on *every* accepted request, before the execute/no-execute
  decision exists. The no-code path (`should_execute: false`) never touches Docker but is fully
  billed.
- **Host capacity.** Each executing request launches a container. The per-container limits
  (256 MB, 0.5 CPU, 64 PIDs, 10 s) bound *one* execution; nothing bounded how many ran at once.
  200 concurrent prompts meant 200 containers and ~50 GB of memory commitments.

That asymmetry is the crux: the two resources are consumed at different points in the request, so
one control cannot cover both. This is the **D** in STRIDE, not a performance feature.

## Decision

Two controls, and — deliberately — two different places to keep their state.

### D1 — Per-user request quota in Redis

Keyed on the verified `sub`, checked before `llm.generate`, two fixed windows (a short burst
allowance plus a longer sustained one), enforced by a single Lua script per check.

**Rejected: in-process counters.** The deployment target is Cloud Run, which autoscales
horizontally by default, so a per-process counter would be wrong on day one — N instances would
grant N× the intended limit. In-process state also resets on restart, making a redeploy a quota
bypass.

**Rejected: Postgres.** Already a dependency, so it would avoid new infrastructure — but it puts a
transactional store on the hot path of every request, for counters that are windowed and
disposable.

**Accepted costs:** a third piece of infrastructure (Compose service, CI service container,
`verify.sh` coverage); a network round trip before every `/api/execute`; and integration tests
needing a live Redis, gated exactly like the `DATABASE_URL` history suites — with the same trap,
that a green `verify.sh` is not evidence they ran.

*Why Lua rather than `INCR`.* The store must **read** both windows, refuse without incrementing if
either is at its limit, and only then consume both. A bare `INCR`-then-compare charges callers for
requests it refused, so a client in a retry loop burns its own sustained allowance while never
succeeding. Splitting read and write across round trips would race. `EXPIRE` fires only when a key
is created, so a hammering client cannot extend its own window.

### D8 — Sandbox concurrency cap, in-process (and D9, enforced only at launch)

A `SandboxBackend` decorator holding a counter, refusing at the cap rather than queueing.

**Why in-process here, when the quota chose Redis?** Because the resource differs. A per-user
budget is **global** — the same user hitting two instances must share one allowance. Host capacity
is **local** — each instance protects the host it runs on, so a per-instance count is the correct
semantics under horizontal scaling, not a compromise. The asymmetry is the point, not an
inconsistency. *(Caveat: several backend instances sharing one Docker daemon would over-subscribe
it. There is one instance today; revisit with `CloudRunBackend`.)*

**Rejected: a bounded queue.** A queue is itself unbounded-growth surface needing its own bound and
its own tests, it adds a tuning knob to a control whose value is simplicity, and a safety limit
should refuse rather than schedule. The quota already smooths arrival rate, so the queue would be
absorbing contention the quota should have prevented.

**Rejected: a saturation check before `llm.generate`.** It would have made a refusal under load
cost nothing — but the prompt's nature is unknowable until the model answers, so it would refuse
**no-code prompts too**: *"tell me a joke"* never touches Docker, yet would get a 503 whenever the
pool happened to be full. Refusing work the service could comfortably have done is worse than the
accepted cost, which is that each saturation refusal wastes exactly one Claude call.

### D5 — Fail open when Redis is unreachable

`/api/execute` proceeds, and an error-level signal fires.

**Rejected: fail closed.** It would make Redis a hard availability dependency of `/api/execute`, so
a Redis blip becomes a service outage — a control that exists to protect availability removing it.

This is only defensible **because of the concurrency cap**. With the cap in place, a Redis outage
degrades protection rather than removing it: the host stays bounded and the exposure narrows to
Anthropic spend for the duration. The two controls were specified together for exactly this reason.

**Accepted, and real:** a long outage during abuse means an unbounded bill. That is why the log is
error-level and why silence is treated as a defect rather than an implementation detail.

*The implementation detail that makes or breaks this:* failing open requires the store to
**reject**. node-redis keeps `isOpen` true through a disconnect (`isReady` is the flag that flips),
so without `disableOfflineQueue` commands sit in an offline queue indefinitely and every
`/api/execute` hangs — strictly worse than the fail-closed option rejected above. The client also
needs a `reconnectStrategy` that eventually returns an `Error`, and a bounded timeout around the
command, since `connectTimeout` covers only the initial connect.

### D4 — Two refusals, two status codes

Over-quota → **429** (RFC 6585 §4, *the user has sent too many requests*). Saturation → **503**
(RFC 9110 §15.6.4, *temporary overload*). Both carry `Retry-After`.

The quota is checked first, so any request reaching the cap is **inside** its own allowance and is
being refused because of *other* users' load; 429 would misattribute that to the caller. Noted for
the deployment work: Cloud Run's load balancer counts container 503s as backend errors, which 429s
are not.

### D6 — No `REDIS_URL`, no boot

The backend refuses to start rather than run with the budget control absent.

**Rejected: the `historyEnabled` pattern** (*off when unconfigured*). History is a feature; this is
a security control, and a missing environment variable silently disabling one is precisely the
failure this is meant to prevent. The check lives in the composition root rather than `createApp`,
because `createApp` is the seam every backend test builds on.

## Consequences

- Redis is now required to run the backend. `docker-compose.yml`, `.env.example`, and the README
  setup steps all reflect that; a fresh clone needs the `redis` service running.
- `Retry-After` is exposed via `Access-Control-Expose-Headers`. It is not CORS-safelisted, so the
  cross-origin SPA would otherwise receive the header and be unable to read it.
- Three residual risks are accepted rather than solved: unbounded spend during a Redis outage
  (bounded by how fast the alarm is answered); a per-instance cap that would be wrong if several
  backends shared one Docker daemon; and request counting that does not distinguish a few very
  expensive prompts from many cheap ones.
- Token-spend accounting, per-tenant limits, and IP-based limiting remain out of scope.
