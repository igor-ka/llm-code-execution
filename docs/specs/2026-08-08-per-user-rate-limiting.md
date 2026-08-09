# Spec: per-user rate limiting and quotas

Epic: [#62](https://github.com/igor-ka/llm-code-execution/issues/62) · Status: **open questions
unanswered — not ready to plan**

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
| S6 | Limiter state stays bounded as distinct identities accumulate; it is not itself a memory-exhaustion vector. |
| S7 | Limits are configurable with safe defaults. An existing deployment that sets no new env var still boots and is protected. |
| S8 | Both `verify.sh` scripts green, with the concurrency and cross-user behaviours covered by tests rather than asserted. |

S5 and S6 are the two that are easy to *claim* and hard to *prove* — they need tests that exercise
real concurrency and real key churn, not a unit test of the counter arithmetic.

## Open questions

**These block planning.** Each changes the shape of the solution, so none can be deferred into the
plan. Recommendations are mine; the decision is the human's.

**OQ1 — In-process counters, or a shared store?**
In-process means the cap is per-process: N instances ⇒ N× the intended limit. Shared state
(Postgres, already a dependency; or Redis, a new one) is correct under horizontal scaling but adds
a round trip to every request and a failure mode — what happens when the store is down, fail-open
or fail-closed? There is one instance today and no deployment yet.
*Recommendation:* in-process for v1, with the multi-instance gap recorded in the ADR and revisited
by the Cloud Run work. **This is the decision that would be expensive to reverse — it likely earns
an ADR either way.**

**OQ2 — What happens when `AUTH_REQUIRED=false` and there is no `sub`?**
Options: (a) one shared bucket for all anonymous traffic — effectively a global rate limit, no new
trust assumptions; (b) key on IP, which requires deciding whether to trust `X-Forwarded-For`;
(c) no per-user limit in anonymous mode, relying on the sandbox cap alone.
*Recommendation:* (a). Anonymous is local-dev-only, and it avoids trusting a spoofable header —
consistent with history's posture that anonymous is degraded, never privileged.

**OQ3 — Does the quota count requests, or token spend?**
Requests are cheap to count and refuse *before* spending. Tokens are the real budget but are only
known *after* the call returns, which makes them a lagging control.
*Recommendation:* requests for v1 — two windows, a short burst allowance plus a longer sustained
one. Note this consciously accepts that a few expensive prompts cost more than many cheap ones.

**OQ4 — Is any frontend work in scope?**
The SPA already displays the server's `detail`, so 429 is *surfaced* today. Anything beyond that —
a countdown, a disabled submit button, automatic retry — is new UI work.
*Recommendation:* out of scope. If it's in, it is its own child issue.

**OQ5 — When the sandbox cap is reached: refuse immediately, or wait briefly?**
Immediate refusal is simpler and honest. A short bounded wait smooths bursts at the cost of
queueing latency and a second tuning knob. Either way the HTTP semantics differ from OQ's 429:
"the server is full" is **503**, not "you sent too many".
*Recommendation:* bounded short wait, then 503 — but this is a genuine trade-off, not an obvious
call.

**OQ6 — What are the actual numbers?**
Defaults for the burst window, the sustained window, and max concurrent sandboxes. At 256 MB and
0.5 CPU each, a 4-core/8 GB dev box tolerates roughly 4–8 concurrent containers.
*Recommendation:* pick conservative defaults now and treat them as tunable; they are config, not
architecture.

## Not yet decided

Nothing in this document commits to an implementation. The mechanism, the seams, and the wiring
are the plan's job (`docs/plans/2026-08-08-per-user-rate-limiting.md`, not yet written), and any
decision expensive to reverse — OQ1 above — gets an ADR.
