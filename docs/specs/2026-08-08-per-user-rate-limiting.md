# Spec: per-user rate limiting and quotas

Epic: [#62](https://github.com/igor-ka/llm-code-execution/issues/62) · Status: **all questions
answered — ready to plan**

Stack, commands, project layout, code style, and testing strategy are not restated here; they
live in [`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md).

## Objective

Bound the resources a single caller can consume, so that one user — or one runaway client — can
neither exhaust the host nor run up the Anthropic bill. Two resources are consumed at different
points in the request, and each needs its own control:

| Control | Defends | Where it runs | State |
| --- | --- | --- | --- |
| **Per-user request quota**, keyed on the verified `sub` | Anthropic API budget | Before `llm.generate` | Redis (D1) |
| **Sandbox concurrency cap**, global | Host CPU / memory / containers | Around the sandbox launch | In-process (D8) |

Done means a burst degrades only the user who sent it.

> **Scope note.** This spec was narrowed to the quota alone on 2026-08-08 and widened again the
> same day once the implications of a single-layer design were clear. The two controls are kept
> together deliberately: each covers the other's blind spot, and the pairing is what makes D5's
> fail-open posture safe.

## Context — what the code does today

Grounding for the criteria below; no design implied.

1. [`server.ts:87`](../../backend/src/server.ts#L87) — `requirePrincipal` verifies the token, and
   nothing after it bounds how much work the caller can ask for.
2. [`server.ts:131`](../../backend/src/server.ts#L131) — `llm.generate` is called on **every**
   accepted request, before any execute/no-execute decision exists. The no-code path
   (`should_execute: false`) never touches Docker but is **fully billed**. A control that only
   guarded sandbox launches would therefore miss the budget entirely — the quota has to sit ahead
   of the LLM call. *This asymmetry is the whole reason two controls are needed rather than one.*
3. [`dockerBackend.ts:65`](../../backend/src/sandbox/dockerBackend.ts#L65) — `createContainer` runs
   unconditionally. The per-container limits (256 MB, 0.5 CPU, 64 PIDs, 10 s) bound *one*
   execution; nothing bounds how many run at once. 200 concurrent prompts ⇒ 200 containers ⇒
   ~50 GB of memory commitments on a laptop-sized host.
4. `SANDBOX_TIMEOUT_SECONDS` is a floor on how long a saturating request holds capacity, not a
   ceiling on arrival rate.
5. Identity already exists and is trustworthy: `res.locals.principal.userId` is the verified `sub`
   from [`auth.ts`](../../backend/src/auth.ts), never client-supplied.
6. The SPA already renders the server's `{detail}` for any non-2xx
   ([`api.ts:62`](../../frontend/src/api.ts#L62)), so a refusal surfaces as an error message today
   with no frontend change.
7. Every backend test builds its app through `createApp({ settings, llm, sandbox, history,
   requirePrincipal })` with fakes ([`main.test.ts`](../../backend/tests/main.test.ts)). A limiter
   injected through that same seam keeps external services out of the unit suites (S10).

**Security framing.** This is the **D** in STRIDE, not a performance feature. The abuse case —
*one authenticated user starves everyone else and bills the owner for it* — is the first test, and
a cross-user test proves one user's limit cannot affect another, mirroring the existing isolation
battery. Per [`CLAUDE.md`](../../CLAUDE.md), the `security-and-hardening` threat-model pass runs
before implementation because this touches `sandbox/**` and the authenticated request path.

## Boundaries

**In scope**

- `POST /api/execute` — the only endpoint that spends API budget or host capacity.
- A per-user request quota keyed on the **verified `sub`**, never a header or body field.
- A **global** cap on concurrent sandbox executions.
- Limits centralised in [`config.ts`](../../backend/src/config.ts), which already documents itself
  as the seam where per-tenant overrides will plug in.
- Refusals returned through the existing `HttpError` → `{detail}` path, so error shapes stay
  uniform.
- **Redis as a new infrastructure dependency** (D1): a service in `docker-compose.yml`, a service
  container in CI, and matching coverage in `backend/verify.sh` — the mirroring rule in
  [`CLAUDE.md`](../../CLAUDE.md) means the CI step and the local script move together.
- **SPA handling of the refusals** (D7): its own child issue, not folded into a backend slice.

**Out of scope**

- **Token-spend accounting.** The quota counts requests, not Anthropic tokens (D3).
- **History routes** (`/api/sessions*`, `/api/runs/*`). They hit Postgres, not Claude or Docker,
  so they are outside the stated problem. Named so the omission is deliberate, not forgotten.
- **Per-tenant differentiated limits.** `tenantId` is carried but unused; the repo is single-tenant
  (#9).
- **IP-based limiting, WAF, network-layer DDoS.** Out of the application's reach.
- **Changing the per-container limits.** Those already exist and are verified.
- **Automatic client-side retry.** The SPA surfaces the refusal; it does not silently re-send.

**Non-goal.** This is not a fair-share scheduler or a throughput optimiser. It is a safety limit:
the correct behaviour at the limit is to *refuse work*, not to schedule it cleverly. D8 follows
directly from this.

## Success criteria

| # | Criterion |
| --- | --- |
| S1 | A user exceeding the quota gets **429**; requests under it succeed. |
| S2 | While user A is throttled, user B is unaffected — proven by a cross-user test. |
| S3 | A **quota** refusal (429) costs **zero** Anthropic spend: the decision happens before `llm.generate`. A **saturation** refusal (503) happens after generation and costs one call — see D9. |
| S4 | Quota is consumed by **every** accepted request, including the `should_execute: false` no-code path. |
| S5 | Under a burst of M ≫ N simultaneous requests, concurrent sandbox executions never exceed the configured N. Excess is refused with **503** — never launched, never queued (D8). |
| S6 | Limiter state stays bounded as identities accumulate: every key carries a TTL, so Redis is not turned into a memory-exhaustion vector by a token-minting attacker. |
| S7 | The quota holds across a backend restart. In-process counters would reset, making redeploy a bypass; D1 exists partly to close that. |
| S8 | The backend **refuses to start** without `REDIS_URL` (D6), with an error naming the missing variable. |
| S9 | With Redis unreachable at request time, `/api/execute` still **serves** the request (D5) and emits an error-level signal. Silence is a failure of this criterion, not an implementation detail. |
| S10 | The existing backend suites still run **without a live Redis**. A hard dependency at the composition root must not become a hard dependency of every unit test. |
| S11 | Both `verify.sh` scripts green, with the cross-user, concurrency, boot-refusal, and Redis-outage behaviours covered by tests rather than asserted. |

S5, S6 and S9 are easy to *claim* and hard to *prove* — they need tests that exercise real
concurrency, real key churn, and a severed Redis connection, not unit tests of counter arithmetic.
S10 is the constraint most likely to be discovered late: `createApp` is the seam every backend test
builds on, so D6's fail-fast belongs at the composition root, not inside it.

## Decisions

Answered 2026-08-08. Recorded here so the plan does not re-litigate them.

**D1 — Quota state lives in Redis.**
Rejected: in-process counters, Postgres. The deciding argument is the deployment target — Cloud
Run autoscales horizontally by default, so a per-process counter would be wrong on day one, giving
N instances N× the intended limit. In-process state also resets on restart, making redeploy a
quota bypass (S7). Postgres would avoid a new dependency but puts a transactional store on the hot
path of every request. **This is expensive to reverse and gets an ADR** — including the rejected
options and the costs accepted below.

*Accepted costs:* a third piece of infrastructure (Compose service, CI service container,
`verify.sh` coverage); a network round trip before every `/api/execute`; a new failure mode when
Redis is unreachable (D5); and integration tests that need a live Redis, mirroring the
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
Over-quota → **429** (RFC 6585 §4, *the user has sent too many requests*). Sandbox saturation →
**503** (RFC 9110 §15.6.4, *temporary overload*). Both carry `Retry-After`. The distinction is not
cosmetic: the quota is checked first, so any request reaching the sandbox cap is **inside** its own
allowance and is being refused because of *other* users' load — 429 would misattribute that to the
caller. Noted for the deployment work: Cloud Run's load balancer counts container 503s as backend
errors, which 429s are not.

**D5 — Fail-open when Redis is unreachable, and say so loudly.**
`/api/execute` proceeds; an error-level signal fires (S9). Rejected: fail-closed (Redis becomes a
hard availability dependency, so a Redis blip becomes a service outage — a control meant to protect
availability removing it) and an emergency in-process quota (a second limiter to build and reason
about for a rare path).
*This is only safe because of the concurrency cap.* With the cap in place, a Redis outage degrades
protection rather than removing it: the host stays bounded, and the exposure narrows to Anthropic
spend for the duration of the outage. **That residual exposure is real and accepted** — a long
outage during abuse means an unbounded bill. It is the reason S9 demands an alarm rather than a log
line, and the reason the two controls are specified together.

**D6 — No `REDIS_URL`, no boot.**
The backend refuses to start rather than running with the budget control silently absent. Rejected:
the `historyEnabled` pattern (*off when unconfigured*), because a missing env var would silently
disable a security control — what S9 and S8 exist to prevent. Accepted cost: Redis is required to
run the backend, so the README's setup steps, `.env.example`, and `docker-compose.yml` all change,
and contributors lose part of the clone-and-run story. S10 keeps this out of the unit tests.

**D7 — SPA handling is in scope, as its own child issue.**
Not folded into a backend slice. **Constraint the plan must not miss:** `Retry-After` is not a
CORS-safelisted response header, and the SPA is cross-origin
([`server.ts:43`](../../backend/src/server.ts#L43) sets `cors({ origin: frontendOrigin })` with no
`exposedHeaders`). As things stand the browser **cannot read the header at all** — so either CORS
exposes it or the retry hint travels in the JSON body. Choosing between those is the plan's job;
knowing the header is invisible today is not optional.

**D8 — The concurrency cap refuses immediately; no queue. In-process state.**
At the cap, a request is refused with 503 rather than waiting for a slot. Rejected: a bounded
FIFO wait. *This reverses an earlier recommendation in this document*, on three grounds that only
became clear once the rest was written: a queue is itself unbounded-growth surface needing its own
bound and its own tests (the S6 problem again, in a second place); it adds a tuning knob to a
control whose whole point is simplicity; and the spec's own non-goal says the right behaviour at a
safety limit is to refuse, not to schedule. The per-user quota already smooths arrival rate, so the
queue would be absorbing contention the quota should have prevented.

*Why in-process here, when D1 chose Redis?* Because the resource differs. A per-user budget is
global — the same user hitting two instances must share one allowance. Host capacity is **local**:
each instance protects the host it runs on, so a per-instance cap is the correct semantics under
horizontal scaling, not a compromise. The asymmetry is deliberate. (Caveat for today's
`docker-compose.yml`: several backend instances sharing one Docker daemon would over-subscribe it.
There is one instance today; this needs revisiting with `CloudRunBackend`.)

**D9 — The concurrency cap is enforced only at the sandbox launch, never before the LLM call.**
Raised by the plan review. The cap could also be checked *before* `llm.generate` as a cheap
saturation peek, so that a refusal under load cost nothing. Rejected, because the prompt's nature
is unknowable until the model has answered: a peek would refuse **no-code prompts too** — *"tell
me a joke"* never touches Docker, yet would receive a 503 whenever the sandbox pool happened to be
full. Refusing work the service could comfortably have done is the worse outcome.

*Accepted cost:* every saturation refusal wastes exactly one Claude call, since the request is
refused only after generation. Bounded by how often the pool is actually full, and by the quota
already limiting arrival rate. This narrows S3 — the zero-spend guarantee now covers quota
refusals only.

## Residual risk

Recorded rather than solved:

1. **Anthropic spend is unbounded during a Redis outage** (D5). Bounded by outage duration and by
   how fast the alarm is answered — an operational control, not a technical one.
2. **The concurrency cap is per-instance** (D8). Correct for host protection under Cloud Run, but
   wrong if multiple backend instances ever share one Docker daemon. Revisit with
   `CloudRunBackend`.
3. **Cost is controlled by request count, not tokens** (D3). A user sending few, very expensive
   prompts stays within quota while spending more than a user sending many cheap ones.
4. **Saturation refusals waste one Claude call each** (D9). The alternative wasted no spend but
   refused work the service could have completed.

## Open questions

**None — all resolved (D1–D9).** One item deferred as config rather than architecture: the actual
window lengths, request counts, and concurrency limit. Conservative defaults are chosen in the plan
and tuned in operation; at 256 MB and 0.5 CPU per container, a 4-core/8 GB dev box tolerates
roughly 4–8 concurrent sandboxes.

## Not yet decided

Nothing here commits to a mechanism. The seams, the wiring, and the algorithms are the plan's job
([`docs/plans/2026-08-08-per-user-rate-limiting.md`](../plans/2026-08-08-per-user-rate-limiting.md));
D1, D5 and D8 go in the ADR — they are the three that would be expensive to reverse.
