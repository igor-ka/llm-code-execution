# Spec: per-user request quota

Epic: [#62](https://github.com/igor-ka/llm-code-execution/issues/62) · Status: **partially
decided — OQ4/OQ6/OQ7 still block planning**

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
- **SPA retry/backoff logic.** Contingent on OQ4.

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
| S8 | Both `verify.sh` scripts green, with the cross-user and Redis-failure behaviours covered by tests rather than asserted. |

S5 and S7 are easy to *claim* and hard to *prove* — they need tests that exercise real key churn
and a real restart, not a unit test of the counter arithmetic.

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

**D4 — Over-quota is 429.**
RFC 6585 §4: *the user has sent too many requests in a given amount of time*. Carries
`Retry-After`. With the sandbox cap out of scope there is no second refusal mode, so 503 does not
arise in this work — if the concurrency cap is built later, *that* refusal is a 503 (RFC 9110
§15.6.4, *temporary overload*), because it is caused by other users' load rather than the caller's
own behaviour.

## Residual risk

Narrowing to the quota leaves two gaps, recorded rather than solved:

1. **Host exhaustion is only indirectly bounded.** The ceiling on concurrent containers is now
   *number of active users × their quota*, which has no fixed upper bound. A modest number of
   users acting simultaneously — entirely within their limits — can still saturate the host. Only
   the concurrency cap closes this.
2. **The quota is now a single layer.** The sandbox cap would have been an independent second
   control needing no Redis. Without it, whatever OQ7 decides for a Redis outage applies to *all*
   protection, not to some of it. Fail-open now means fully unprotected.

Both belong to epic #62 and neither is fixed by this spec. They are the argument for building the
concurrency cap next rather than never.

## Open questions

**These still block planning.**

**OQ4 — Is any frontend work in scope?**
The SPA already displays the server's `detail` for any non-2xx, so 429 is *surfaced* today.
Anything beyond that — a countdown from `Retry-After`, a disabled submit button, automatic retry —
is new UI work.
*Recommendation:* out of scope. If it's in, it is its own child issue.

**OQ6 — What are the actual numbers?**
Defaults for the burst window and the sustained window.
*Recommendation:* conservative defaults, treated as tunable — config, not architecture.

**OQ7 — What happens when Redis is unreachable?**
Unavoidable once the limiter depends on a network service, and sharpened by the narrowed scope:
with no sandbox cap behind it, this decides whether protection is *degraded* or *absent*.
(a) **Fail-open** (serve unlimited — availability preserved, protection silently gone, and an
attacker who can degrade Redis gets unlimited access) or **fail-closed** (refuse — protection
preserved, but one Redis outage takes the whole service down, which is self-defeating for a
control that exists to protect availability)?
(b) Is there an in-process fallback during an outage — partial protection, or added complexity on
a rare path?
(c) What does local dev do with no `REDIS_URL` set? History's precedent is *feature off when
unconfigured* (`historyEnabled: authRequired && databaseUrl !== ""`), but that reasoning does not
transfer: history is a feature, and this is a **security control**. Silently disabling it because
an env var is missing is exactly what S6 exists to prevent.
*No recommendation on (a) — it is a genuine availability-vs-protection trade-off and the human's
call.*

## Not yet decided

Nothing here commits to a mechanism. The seams, the wiring, and the algorithm are the plan's job
(`docs/plans/2026-08-08-per-user-request-quota.md`, not yet written); D1 gets an ADR.
