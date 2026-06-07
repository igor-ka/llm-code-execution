# Design: custom auth-bypass agent

- **Status:** Draft
- **Date:** 2026-06-05
- **Related:** ADR [0002](../adr/0002-agentic-auth-security-testing.md), auth ADR [0001](../adr/0001-authentication-approach.md)
- **Tracking:** epic (see ADR 0002)

## Purpose

A small, self-built red-team agent that tries to **break or bypass the auth gate on
`POST /api/execute`**. The point is *learning agentic engineering* — building the reasoning
loop, tool surface, guardrails, and eval once, by hand, so we understand exactly what a
framework would do for us (see ADR 0002 for the build-vs-buy reasoning).

Mental model: **the agent is the tester's brain.** It reads the source + docs to form
hypotheses, then *proves or disproves* each one against the running app using deterministic
tools. The LLM never asserts a finding from source alone — every finding must reproduce over
the network against the live endpoint.

**Non-goals:** the sandbox/code-execution isolation (a separate concern, already hardened),
reliability/SRE testing (a later, deploy-gated effort), and deep multi-tenant isolation
(noted as future — the app is single-tenant today).

## Scope of access (white-box to find, black-box to prove)

Two deliberately separate scopes, mirroring how internal SDL testing works:

- **Read scope (white-box):** the repo (esp. `backend/app/auth.py`) + README, for *generating*
  hypotheses. Generous.
- **Exploit scope (black-box-ish):** only the running endpoint over loopback. A finding counts
  only if it reproduces against the live app.

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  auth-bypass agent (Claude Agent SDK)          │
                    │  - red-team system prompt + methodology        │
                    │  - ReAct loop w/ step & token budget caps      │
                    │  - reads auth.py for hypotheses (read scope)   │
                    └───────────────┬──────────────────────────────┘
                                    │ tool calls
        ┌───────────────┬──────────┼───────────────┬──────────────────┐
        ▼               ▼          ▼               ▼                  ▼
   mint_token     call_execute  call_endpoint  read_backend_logs  record_finding
   (forge JWTs)   (the target)  (other routes) (white-box observe) (structured out)
        │               │          │               │
        │   ┌───────────▼──────────▼───────────────▼───────────┐
        │   │  Target under test — docker-compose.test.yml      │
        │   │   backend (AUTH_REQUIRED=true) ──▶ /api/execute    │
        │   └───────────▲───────────────────────────────────────┘
        │               │ OIDC_JWKS_URL / OIDC_ISSUER / OIDC_AUDIENCE
        └───────────────┴──── mock OIDC server (we hold the signing key)
                              /.well-known/jwks.json  + rogue-key support
```

### 1. Target under test (TUT)
The app via a dedicated `docker-compose.test.yml`: backend with `AUTH_REQUIRED=true`, pointed at
a **local mock OIDC** instead of Auth0. Loopback only; never exposed.

### 2. Mock OIDC server (the key move)
A tiny service that serves `/.well-known/jwks.json` with an RSA public key **whose private key
we control**. Pointing the backend's `OIDC_JWKS_URL`/`OIDC_ISSUER`/`OIDC_AUDIENCE` at it lets the
agent **mint arbitrary valid and deliberately-broken tokens** — so signature, `kid`, `alg`, and
claim attacks become deterministic and offline, with no Auth0 dependency. This is a white-box
test of the *verification logic* in `auth.py`. (A later, optional pass against a real Auth0 dev
tenant validates the integration end-to-end.)

It also exposes a **rogue second key** so the agent can attempt JWKS/`kid` confusion (sign with a
key the backend should not trust and see if it's accepted).

### 3. Agent tool surface (narrow, guarded)
| Tool | Purpose | Guardrail |
|------|---------|-----------|
| `mint_token(claims, alg, kid, key)` | Forge a JWT (valid or adversarial) via mock or rogue key | — |
| `call_execute(token, body)` | Hit `POST /api/execute` | base URL hardcoded to loopback |
| `call_endpoint(method, path, token, body)` | Probe other routes (`/api/health`, enumeration) | loopback only; non-destructive |
| `read_backend_logs(n)` | Tail the backend container to observe behavior | read-only |
| `record_finding(severity, title, hypothesis, repro, evidence, recommendation)` | Emit a structured finding | append-only to report |

All network tools **refuse any non-loopback host**. The agent has no repo write access except
the report output path.

### 4. The agent (Claude Agent SDK)
- **System prompt:** red-team auth tester persona; explicit scope/guardrails (loopback TUT
  only); required output schema.
- **Two-phase methodology — baseline, then derive.** This is the core of the design:
  1. **Baseline (the floor).** Cover the seeded checklist (§5), anchored on **OWASP API
     Security Top 10** (esp. API2 broken authentication, API1 BOLA), so nothing obvious slips.
     This is coverage insurance, *not* the goal — a scanner or a `pytest` matrix could do it.
  2. **Derive (the point).** Read `auth.py` and the live responses and **generate novel,
     app-specific hypotheses the checklist doesn't enumerate** — e.g. the dual `scope`-string
     vs `permissions[]` code paths, the `org_id → tenant_id` derivation and whether tenant
     isolation is actually enforced downstream, the `lru_cache`d JWKS client's behavior on
     `kid` rotation, internal error-detail leakage, response-timing differences. Only an agent
     does phase 2 — it is the entire reason to build one instead of a scanner.
- **Reflection loop:** ReAct *with a feedback step* — *hypothesize → craft token/request →
  call → observe → **reflect: what did that response reveal, and what new hypothesis does it
  suggest?** → record → next*. Observations feed forward into fresh hypotheses rather than the
  agent merely walking a fixed list.
- **Budget:** hard caps on steps and tokens with graceful termination + a partial report on
  overrun. (Building this cap by hand is one of the lessons — it's the "20%" a framework hides.)

### 5. Attack checklist (seed — the floor, not the ceiling)
This is the **baseline coverage** for phase 1 (§4), *not* the full test plan — the agent derives
further app-specific hypotheses in phase 2. Seeding it keeps runs comparable across changes:

| # | Hypothesis | Expected against real `auth.py` |
|---|------------|--------------------------------|
| 1 | No token / malformed `Authorization` header | 401 |
| 2 | Expired token (`exp` in past) | 401 |
| 3 | Wrong `aud` / wrong `iss` | 401 |
| 4 | Tampered payload / bad signature | 401 |
| 5 | `alg=none` | rejected (algorithms pinned to RS256) |
| 6 | HS256 key-confusion (sign with the public key as HMAC secret) | rejected |
| 7 | Unknown / forged `kid`, rogue JWKS key | rejected |
| 8 | Valid token missing `execute:code` scope | 403 |
| 9 | Scope look-alike (`execute:codex`, `xexecute:code`) | rejected (split, not substring) |
| 10 | Scope delivered via `permissions[]` array | **accepted** (intended) |
| 11 | `user_id`/`tenant_id` injected in request **body** | ignored (identity from claims) |
| 12 | Posture: `AUTH_REQUIRED=false` | endpoint open (config finding) |
| 13 | Endpoint enumeration (`/api/health`, anything unguarded) | only intended routes |
| 14 | `nbf`/`iat` not in `require` list | minor / informational |

### 6. Eval harness (ground truth)
To know the agent *works*, run it against deliberately-broken **mutant** auth modules with known
holes and check it finds them. Examples:

- **Mutant A:** `algorithms=["RS256","HS256"]` → key-confusion (hyp. 6) becomes exploitable.
- **Mutant B:** scope check uses substring `in` → look-alike (hyp. 9) passes.
- **Mutant C:** identity falls back to request body → spoofable (hyp. 11).
- **Mutant D:** `auth_required` defaults `False` → open endpoint (hyp. 12).

`eval/ground_truth.yaml` maps each mutant to the findings that *should* surface. A scorer
computes **precision/recall**: the agent should score N/N on mutants and **report zero on the
real `auth.py`** (which doubles as a regression guard on the real auth code).

### 7. Reporting
Markdown findings report (severity, title, repro, evidence, fix) **+** machine-readable JSON for
the scorer. Severity via a simple CVSS-ish rubric.

### 8. Baseline comparison (direct competitor)
Run the chosen baseline (**Strix** — see ADR 0002) against the same TUT and diff its findings
against the custom agent's. Strix is the closest head-to-head competitor: an autonomous agent
that validates findings with PoCs and targets auth bypass. The learning artifact: *what did a
purpose-built agent catch that my hand-built loop missed, and why?*

## Proposed layout

The layout separates the **domain-agnostic core** (reused by every future capability module)
from the **auth module** (this milestone) — see "Extensibility" below.

```
security/
  agent_core/            # domain-agnostic — reused by every future module
    loop.py              # SDK ReAct loop: planning, reflection, budget caps
    tools.py             # generic tools: call_endpoint, read_backend_logs, record_finding; loopback guard
    report.py            # markdown + JSON output
    eval.py              # precision/recall scorer (mutant-vs-ground-truth runner)
  modules/
    auth/                # capability module #1 (this milestone)
      prompt.py          # red-team auth-tester system prompt
      checklist.py       # seed hypotheses (the phase-1 floor)
      tools.py           # auth-specific tools: mint_token, call_execute
      mutants/           # deliberately-broken auth variants
      ground_truth.yaml  # expected findings per mutant
  mock_oidc/
    server.py            # JWKS endpoint + signing-key control + rogue key
    Dockerfile
  docker-compose.test.yml  # backend (mock OIDC) wired for testing
  verify.sh              # lint + unit tests + eval (mirrors CI, per CLAUDE.md)
  README.md
```

## Extensibility — auth is module one

The scope is narrow (auth) but the **agent is not**. The reusable machinery — the ReAct loop,
reflection, budget caps, the generic tools, reporting, and the eval scorer — lives in
`agent_core/` and knows nothing about auth. A **capability module** contributes three things:
its system prompt, its seed checklist, and any domain-specific tools (plus eval mutants +
ground truth). `auth` is the first such module.

Consequences of this split:

- Broadening later (BOLA, injection, SSRF, sandbox-escape) is **adding a `modules/<name>/`,
  not rewriting** — the core and the harness are untouched.
- The decision recorded here is "**auth is milestone one**," not "auth forever."
- Keeping reusable agent infra cleanly separate from domain checklists is itself one of the
  engineering lessons this project is for.

This is a deliberate design seam, **not** a commitment to build further modules now — only the
auth module ships in this epic.

## Safety & cost

- **Loopback only**, against the throwaway test stack; tools reject non-loopback targets.
- Step/token **budget caps**; no repo writes beyond the report.
- Needs an **Anthropic API key** (same `ANTHROPIC_API_KEY`); each run spends tokens — keep
  budgets small. The mock OIDC removes any Auth0 dependency for the core runs.
- A new `security/verify.sh` follows the repo's one-script-mirrors-CI rule (see CLAUDE.md). If a
  CI job is added for it, keep the job-name contract in mind.
