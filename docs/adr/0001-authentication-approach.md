# 1. Authentication approach

- **Status:** Accepted
- **Date:** 2026-06-01
- **Tracking:** epic [#9](https://github.com/igor-ka/llm-code-execution/issues/9) (work items [#5](https://github.com/igor-ka/llm-code-execution/issues/5)–[#8](https://github.com/igor-ka/llm-code-execution/issues/8))

## Context

`POST /api/execute` is currently unauthenticated: anyone who can reach the backend can run
code and spend the project's Anthropic credits. `ExecuteRequest` carries `tenant_id`/`user_id`,
but they are client-supplied and unverified (spoofable). We want authentication that is **free**,
fits a **learning project that mirrors an enterprise B2B pattern**, and protects the endpoint
(and the budget behind it).

## Decision

- **Provider: Auth0** (hosted OIDC). The maintainer uses Auth0 at work, so skills transfer both
  ways; it is the same OIDC pattern as any alternative; the free tier comfortably covers a
  learning project.
- **Token architecture: SPA-direct bearer.** The access token is held in browser memory (never
  `localStorage`) and sent as `Authorization: Bearer` to `/api/execute`. XSS is mitigated via
  in-memory storage + a strict CSP. A **BFF (`HttpOnly` cookie) is deferred** as an optional
  phase-2 upgrade.
- **TLS before deploy, not for local dev.** Auth0 permits `http://localhost` callbacks and
  browsers treat localhost as a secure context, so the flow is built and tested over
  `http://localhost`; TLS gates exposure/deploy.
- **Claims, not body.** `user_id`/`tenant_id` are derived from verified token claims
  (`sub`, org claim) and **removed from `ExecuteRequest`**.
- **Staged rollout.** Backend enforcement ships behind a config switch so `main` stays usable
  until the frontend sends tokens; the switch is flipped once login is wired.

## Alternatives considered

- **Roll your own (password store + JWT):** rejected — real security liability (password
  storage, reset, verification), not the enterprise pattern, no social login.
- **Self-host Keycloak / Zitadel:** rejected for now — genuinely *fastest to a working local
  demo* (all local files + Docker, no signup), and free forever, but adds an ongoing-ops burden
  (a stateful container to run, persist, secure, upgrade) and the IdP-internals knowledge does
  not transfer to the maintainer's Auth0-based work stack.
- **Clerk / Supabase (hosted):** viable and free, but Auth0 wins on matching the work stack.

## Consequences

- Backend validates the access token's signature against Auth0's JWKS and checks `iss`, `aud`,
  `exp`, and scope; populates `user_id`/`tenant_id` from claims.
- Frontend integrates the Auth0 React SDK; access token in memory; bearer attached in `api.ts`.
- New config in `config.py`: `oidc_issuer`, `oidc_audience`, `oidc_jwks_url` (per-tenant
  override seam already present).
- Unblocks per-user rate limiting / quota keyed on the verified `sub`.
- Future option: revisit the BFF (`HttpOnly` cookie) and sender-constrained tokens (DPoP/mTLS)
  if a stronger posture is wanted.
