# Spec: per-user rate limiting and quotas

Epic: [#62](https://github.com/igor-ka/llm-code-execution/issues/62) · Status: **partially
decided — OQ4/OQ5/OQ6/OQ7 still block planning**

Stack, commands, project layout, code style, and testing strategy are not restated here; they
live in [`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md).

## Objective

Bound the resources a single caller can consume, so that one user — or one runaway client — can
neither exhaust the host nor run up the Anthropic bill. Two resources need bounding, and they are
consumed at different points in the request:

- **API budget.** Every accepted `/api/execute` makes a billed Claude call.
- **Host capacity.** Every `should_execute` request launches a container.

Done means a burst degrades only the user who sent it.

## Context — what the code does today

Grounding for the criteria below; no design implied.

1. [`server.ts:87`](../../backend/src/server.ts#L87) — `requirePrincipal` verifies the token, and
   nothing after it bounds how much work the caller can ask for.
2. [`server.ts:131`](../../backend/src/server.ts#L131) — `llm.generate` is called on **every**
   accepted request, before any execute/no-execute decision exists. The no-code path
   (`should_execute: false`) never touches Docker but is **fully billed**. A cap that only guards
   sandbox launches therefore does not protect the API budget.
3. [`dockerBackend.ts:65`](../../backend/src/sandbox/dockerBackend.ts#L65) — `createContainer` runs
   unconditionally. The per-container limits (256 MB, 0.5 CPU, 64 PIDs, 10 s) bound *one*
   execution; nothing bounds how many run at once. 200 concurrent prompts ⇒ 200 containers ⇒
   ~50 GB of memory commitments on a laptop-sized host.
4. `SANDBOX_TIMEOUT_SECONDS` is a floor on how long a saturating request holds capacity, not a
   ceiling on arrival rate.
5. Identity already exists and is trustworthy: `res.locals.principal.userId` is the verified `sub`
   from [`auth.ts`](../../backend/src/auth.ts), never client-supplied.
6. The SPA already renders the server's `{detail}` for any non-2xx
   ([`api.ts:62`](../../frontend/src/api.ts#L62)), so a throttled response surfaces as an error
   message today with no frontend change.

**Security framing.** This is the **D** in STRIDE, not a performance feature. The abuse case —
*one authenticated user starves everyone else and bills the owner for it* — is the first test, and
a cross-user test proves one user's limit cannot affect another, mirroring the existing isolation
battery. Per [`CLAUDE.md`](../../CLAUDE.md), the `security-and-hardening` threat-model pass runs
before implementation because this touches `sandbox/**` and the authenticated request path.

## Boundaries

**In scope**

- `POST /api/execute` — the only endpoint that spends API budget or host capacity.
- A per-user quota keyed on the **verified `sub`**, never a header or body field.
- A **global** cap on concurrent sandbox executions.
- Limits centralised in [`config.ts`](../../backend/src/config.ts), which already documents itself
  as the seam where per-tenant overrides will plug in.
- Refusals returned through the existing `HttpError` → `{detail}` path, so error shapes stay
  uniform.
- **Redis as a new infrastructure dependency** (D1): a service in `docker-compose.yml`, a service
  container in CI, and matching coverage in `backend/verify.sh` — the mirroring rule in
  [`CLAUDE.md`](../../CLAUDE.md) means the CI step and the local script move together.

**Out of scope**

- **Token-spend accounting.** The quota counts requests, not Anthropic tokens (see OQ3).
- **History routes** (`/api/sessions*`, `/api/runs/*`). They hit Postgres, not Claude or Docker,
  so they are outside the stated problem. Named here so the omission is deliberate, not forgotten.
- **Per-tenant differentiated limits.** `tenantId` is carried but unused; the repo is single-tenant
  (#9).
- **IP-based limiting, WAF, network-layer DDoS.** Out of the application's reach.
- **Changing the per-container limits.** Those already exist and are verified.
- **SPA retry/backoff logic.** Contingent on OQ4.

**Non-goal.** This is not a fair-share scheduler or a throughput optimiser. It is a safety limit:
the correct behaviour when saturated is to *refuse work*, not to schedule it cleverly.

## Success criteria

| # | Criterion |
| --- | --- |
| S1 | A user exceeding the per-user cap gets **429**; requests under the cap succeed. |
| S2 | While user A is throttled, user B is unaffected — proven by a cross-user test. |
| S3 | A throttled request costs **zero** Anthropic spend: the decision happens before `llm.generate`. |
| S4 | Quota is consumed by **every** accepted request, including the `should_execute: false` no-code path. |
| S5 | Under a burst of M ≫ N simultaneous requests, concurrent sandbox executions never exceed the configured N. Excess is refused or queued (OQ5) — never launched. |
| S6 | Limiter state stays bounded as distinct identities accumulate: every key carries a TTL, so Redis is not turned into a memory-exhaustion vector by a token-minting attacker. |
| S7 | Limits are configurable with safe defaults. Behaviour when Redis is unreachable is explicit and tested — never accidental (OQ7). |
| S8 | The quota holds across a backend restart. In-process counters would reset, making redeploy a quota bypass; D1 exists partly to close that. |
| S9 | Both `verify.sh` scripts green, with the concurrency and cross-user behaviours covered by tests rather than asserted. |

S5 and S6 are the two that are easy to *claim* and hard to *prove* — they need tests that exercise
real concurrency and real key churn, not a unit test of the counter arithmetic.

## Decisions

Answered 2026-08-08. Recorded here so the plan does not re-litigate them.

**D1 — Limiter state lives in Redis.** *(was OQ1)*
Rejected: in-process counters, Postgres. The deciding argument is the deployment target — Cloud
Run autoscales horizontally by default, so a per-process counter would be wrong on day one, giving
N instances N× the intended limit. In-process state also resets on restart, making redeploy a
quota bypass (S8). Postgres would avoid a new dependency but puts a transactional store on the hot
path of every request. **This is expensive to reverse and gets an ADR** — including the rejected
options and the cost accepted below.

*Accepted costs:* a third piece of infrastructure (Compose service, CI service container,
`verify.sh` coverage); a network round trip before every `/api/execute`; a new failure mode when
Redis is unreachable (OQ7); and integration tests that need a live Redis, mirroring the
`DATABASE_URL`-gated history suites — with the same trap, that a green `verify.sh` is not evidence
they ran.

**D2 — Anonymous traffic shares one bucket.** *(was OQ2)*
With `AUTH_REQUIRED=false` there is no `sub`, so all anonymous callers share a single bucket —
effectively a global rate limit. Rejected: IP keying (would require trusting `X-Forwarded-For`, a
spoofable header and therefore a limiter bypass) and no-limit-when-anonymous (leaves API budget
unprotected). Consistent with history's posture: anonymous is degraded, never privileged.

**D3 — The quota counts requests, in two windows.** *(was OQ3)*
A short burst allowance plus a longer sustained window. Countable and refusable *before* any spend,
which is what makes S3 achievable. Token spend is the truer budget but is only known after the call
returns — a lagging control that cannot stop the first expensive request. Consciously accepted: a
few expensive prompts can cost more than many cheap ones.

**D4 — Two refusals, two status codes.**
Per-user quota exhausted → **429** (RFC 6585 §4: *the user has sent too many requests*). Global
sandbox saturation → **503** (RFC 9110 §15.6.4: *temporary overload*). The distinction is not
cosmetic: the quota is checked first, so any request that reaches the sandbox cap is **inside** its
own allowance and is being refused because of *other* users' load — 429 would misattribute that to
the caller. Both carry `Retry-After`. Noted for the deployment work: Cloud Run's load balancer
counts container 503s as backend errors, which 429s are not.

## Open questions

**These still block planning.**

**OQ4 — Is any frontend work in scope?**
The SPA already displays the server's `detail` for any non-2xx, so 429 and 503 are *surfaced*
today. Anything beyond that — a countdown from `Retry-After`, a disabled submit button, automatic
retry — is new UI work.
*Recommendation:* out of scope. If it's in, it is its own child issue.

**OQ5 — At the sandbox cap: refuse immediately, or wait briefly first?**
The status code is settled (D4: 503). What remains is whether a request waits in a bounded queue
before being refused. Immediate refusal is simpler and adds no knob; a short wait smooths ordinary
overlap so brief contention isn't user-visible, at the cost of queueing latency and a second
tunable.
*Recommendation:* bounded short wait — but this is a genuine trade-off, not an obvious call.

**OQ6 — What are the actual numbers?**
Defaults for the burst window, the sustained window, and max concurrent sandboxes. At 256 MB and
0.5 CPU each, a 4-core/8 GB dev box tolerates roughly 4–8 concurrent containers.
*Recommendation:* conservative defaults, treated as tunable — config, not architecture.

**OQ7 — What happens when Redis is unreachable?** *(new, created by D1)*
Unavoidable once the limiter depends on a network service. Three sub-questions:
(a) **Fail-open** (serve the request unlimited — availability preserved, protection silently gone)
or **fail-closed** (refuse — protection preserved, one Redis outage takes the whole service down)?
(b) Is there an in-process fallback during an outage — partial protection, or added complexity for
a rare path?
(c) What does local dev do with no `REDIS_URL` set? History's precedent is *feature off when
unconfigured* (`historyEnabled: authRequired && databaseUrl !== ""`), but that reasoning does not
transfer cleanly: history is a feature, and this is a **security control**. Silently disabling it
because an env var is missing is exactly the failure mode S7 exists to prevent.
*No recommendation yet — (a) is a real availability-vs-protection trade-off and is the human's
call.*

## Not yet decided

Nothing here commits to a mechanism. The seams, the wiring, and the algorithm are the plan's job
(`docs/plans/2026-08-08-per-user-rate-limiting.md`, not yet written); D1 and D4 get an ADR.
