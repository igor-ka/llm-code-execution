# Spec: per-user request quota

Epic: [#62](https://github.com/igor-ka/llm-code-execution/issues/62) · Status: **all questions
answered — ready to plan**

Stack, commands, project layout, code style, and testing strategy are not restated here; they
live in [`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md).

## Objective

Bound how many requests a single caller can make to `/api/execute`, so that one user — or one
runaway client — cannot run up the Anthropic bill. Done means a burst degrades only the user who
sent it.

**Scope was deliberately narrowed on 2026-08-08** to the per-user quota alone. The global sandbox
concurrency cap named in epic #62 is *not* part of this work; see *Boundaries* and *Residual risk*.

## Context — what the code does today

Grounding for the criteria below; no design implied.

1. [`server.ts:87`](../../backend/src/server.ts#L87) — `requirePrincipal` verifies the token, and
   nothing after it bounds how much work the caller can ask for.
2. [`server.ts:131`](../../backend/src/server.ts#L131) — `llm.generate` is called on **every**
   accepted request, before any execute/no-execute decision exists. The no-code path
   (`should_execute: false`) never touches Docker but is **fully billed**. Any control that only
   guarded sandbox launches would therefore miss the budget entirely — the quota has to sit ahead
   of the LLM call.
3. Identity already exists and is trustworthy: `res.locals.principal.userId` is the verified `sub`
   from [`auth.ts`](../../backend/src/auth.ts), never client-supplied.
4. The SPA already renders the server's `{detail}` for any non-2xx
   ([`api.ts:62`](../../frontend/src/api.ts#L62)), so a throttled response surfaces as an error
   message today with no frontend change.

**Security framing.** This is the **D** in STRIDE, not a performance feature. The abuse case —
*one authenticated user bills the owner without limit* — is the first test, and a cross-user test
proves one user's limit cannot affect another, mirroring the existing isolation battery. Per
[`CLAUDE.md`](../../CLAUDE.md), the `security-and-hardening` threat-model pass runs before
implementation because this sits on the authenticated request path.

## Boundaries

**In scope**

- `POST /api/execute` — the only endpoint that spends API budget.
- A per-user request quota keyed on the **verified `sub`**, never a header or body field.
- **SPA handling of the refusal** (D7): its own child issue, not folded into the backend slices.
- Limits centralised in [`config.ts`](../../backend/src/config.ts), which already documents itself
  as the seam where per-tenant overrides will plug in.
- Refusals returned through the existing `HttpError` → `{detail}` path, so error shapes stay
  uniform.
- **Redis as a new infrastructure dependency** (D1): a service in `docker-compose.yml`, a service
  container in CI, and matching coverage in `backend/verify.sh` — the mirroring rule in
  [`CLAUDE.md`](../../CLAUDE.md) means the CI step and the local script move together.

**Out of scope**

- **The global sandbox concurrency cap.** Deliberately cut from this spec. It defends a different
  resource (host CPU/memory/containers) through a different mechanism, and bundling the two made
  this change larger than it needed to be. The gap is real and stays recorded in epic #62 and the
  README's *Known limitations*; see *Residual risk*.
- **Token-spend accounting.** The quota counts requests, not Anthropic tokens (D3).
- **History routes** (`/api/sessions*`, `/api/runs/*`). They hit Postgres, not Claude, so they are
  outside the stated problem. Named so the omission is deliberate, not forgotten.
- **Per-tenant differentiated limits.** `tenantId` is carried but unused; the repo is single-tenant
  (#9).
- **IP-based limiting, WAF, network-layer DDoS.** Out of the application's reach.
- **Automatic client-side retry.** The SPA surfaces the refusal (D7); it does not silently re-send.

**Non-goal.** This is not a fair-share scheduler or a throughput optimiser. It is a safety limit:
the correct behaviour at the limit is to *refuse work*, not to schedule it cleverly.

## Success criteria

| # | Criterion |
| --- | --- |
| S1 | A user exceeding the quota gets **429**; requests under it succeed. |
| S2 | While user A is throttled, user B is unaffected — proven by a cross-user test. |
| S3 | A throttled request costs **zero** Anthropic spend: the decision happens before `llm.generate`. |
| S4 | Quota is consumed by **every** accepted request, including the `should_execute: false` no-code path. |
| S5 | Limiter state stays bounded as distinct identities accumulate: every key carries a TTL, so Redis is not turned into a memory-exhaustion vector by a token-minting attacker. |
| S6 | Limits are configurable with safe defaults, and behaviour when Redis is unreachable is explicit and tested — never accidental (OQ7). |
| S7 | The quota holds across a backend restart. In-process counters would reset, making redeploy a bypass; D1 exists partly to close that. |
| S8 | The backend **refuses to start** without `REDIS_URL` (D6), with an error naming the missing variable. |
| S9 | With Redis unreachable at request time, `/api/execute` returns **503** and makes no Anthropic call (D5). Proven by a test that severs the connection, not by inspection. |
| S10 | The existing backend suites still run **without a live Redis**. A hard dependency at the composition root must not become a hard dependency of every unit test. |
| S11 | Both `verify.sh` scripts green, with the cross-user, boot-refusal, and Redis-failure behaviours covered by tests rather than asserted. |

S5 and S7 are easy to *claim* and hard to *prove* — they need tests that exercise real key churn
and a real restart, not a unit test of the counter arithmetic. S10 is the constraint most likely to
be discovered late: `createApp` is the seam every backend test builds on, so the fail-fast check
belongs at the composition root, not inside it.

## Decisions

Answered 2026-08-08. Recorded here so the plan does not re-litigate them.

**D1 — Limiter state lives in Redis.**
Rejected: in-process counters, Postgres. The deciding argument is the deployment target — Cloud
Run autoscales horizontally by default, so a per-process counter would be wrong on day one, giving
N instances N× the intended limit. In-process state also resets on restart, making redeploy a
quota bypass (S7). Postgres would avoid a new dependency but puts a transactional store on the hot
path of every request. **This is expensive to reverse and gets an ADR** — including the rejected
options and the costs accepted below.

*Accepted costs:* a third piece of infrastructure (Compose service, CI service container,
`verify.sh` coverage); a network round trip before every `/api/execute`; a new failure mode when
Redis is unreachable (OQ7); and integration tests that need a live Redis, mirroring the
`DATABASE_URL`-gated history suites — with the same trap, that a green `verify.sh` is not evidence
they ran.

**D2 — Anonymous traffic shares one bucket.**
With `AUTH_REQUIRED=false` there is no `sub`, so all anonymous callers share a single bucket —
effectively a global rate limit. Rejected: IP keying (would require trusting `X-Forwarded-For`, a
spoofable header and therefore a limiter bypass) and no-limit-when-anonymous (leaves API budget
unprotected). Consistent with history's posture: anonymous is degraded, never privileged.

**D3 — The quota counts requests, in two windows.**
A short burst allowance plus a longer sustained window. Countable and refusable *before* any spend,
which is what makes S3 achievable. Token spend is the truer budget but is only known after the call
returns — a lagging control that cannot stop the first expensive request. Consciously accepted: a
few expensive prompts can cost more than many cheap ones.

**D4 — Two refusals, two status codes.**
Over-quota → **429** (RFC 6585 §4, *the user has sent too many requests*), carrying `Retry-After`.
Limiter unavailable → **503** (RFC 9110 §15.6.4, *temporary overload*), because the caller did
nothing wrong. *Revised after D5:* an earlier draft of this decision said 503 could not arise once
the sandbox cap left scope. Fail-closed reintroduced it — from a different cause.

**D5 — Fail-closed when Redis is unreachable.**
`/api/execute` returns 503 and makes no Anthropic call. Rejected: fail-open (protection vanishes
exactly when the system is already degrading, and anyone able to pressure Redis gets unlimited
access) and an in-process fallback (a second limiter to build and reason about, for a rare path).
*Accepted cost, stated plainly:* Redis becomes a hard availability dependency of `/api/execute`, so
a Redis outage is a service outage. A control meant to protect availability can now remove it —
that is the deliberate trade, chosen because silent absence of protection is judged the worse
failure. This raises the operational bar: Redis needs the monitoring a critical-path dependency
gets, and this belongs in the ADR alongside D1.

**D6 — No `REDIS_URL`, no boot.**
The backend refuses to start rather than running unprotected. Rejected: the `historyEnabled`
pattern (*off when unconfigured*), because a missing env var would silently disable a security
control — what S6 exists to prevent. Accepted cost: Redis is now required to run the backend at
all, so the README's setup steps, `.env.example`, and `docker-compose.yml` all change, and
contributors lose part of the clone-and-run story. S10 keeps this out of the unit tests.

**D7 — SPA handling is in scope, as its own child issue.**
Not folded into a backend slice. **Constraint the plan must not miss:** `Retry-After` is not a
CORS-safelisted response header, and the SPA is cross-origin
([`server.ts:43`](../../backend/src/server.ts#L43) sets `cors({ origin: frontendOrigin })` with no
`exposedHeaders`). As things stand the browser **cannot read the header at all** — so either CORS
exposes it or the retry hint travels in the JSON body. Choosing between those is the plan's job;
knowing the header is invisible today is not optional.

## Residual risk

Narrowing to the quota leaves two gaps, recorded rather than solved:

1. **Host exhaustion is only indirectly bounded.** The ceiling on concurrent containers is now
   *number of active users × their quota*, which has no fixed upper bound. A modest number of
   users acting simultaneously — entirely within their limits — can still saturate the host. Only
   the concurrency cap closes this.
2. **The quota is a single layer, and now a fragile one.** The sandbox cap would have been an
   independent second control needing no Redis. Without it, D5's fail-closed posture means a Redis
   outage stops `/api/execute` entirely — there is nothing behind it to degrade to. Host
   exhaustion, meanwhile, stays completely unguarded.

Both belong to epic #62 and neither is fixed by this spec. Together they are the argument for
building the concurrency cap next rather than never: it is the only control here that needs no
external service, and it would give D5 something to fall back on.

## Open questions

**None — all resolved (D1–D7).** One item deferred rather than asked, because it is config rather
than architecture: the actual window lengths and request counts. Conservative defaults are chosen
in the plan and tuned in operation.

## Not yet decided

Nothing here commits to a mechanism. The seams, the wiring, and the algorithm are the plan's job
(`docs/plans/2026-08-08-per-user-request-quota.md`, not yet written); D1 gets an ADR.
