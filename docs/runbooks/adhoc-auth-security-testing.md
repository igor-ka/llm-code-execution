# Runbook: ad-hoc auth security testing with Claude Code

How to do **on-demand, LLM-driven discovery testing** of the OIDC bearer gate on
`POST /api/execute` — without any bespoke agent. This is the kept replacement for the retired
custom red-team agent (see [the retrospective](../design/auth-bypass-agent.md) for why).

**Two modes, by what you're testing:**

| Mode | What it finds | Can you mint accepted tokens? |
|---|---|---|
| **A. In-process (validation logic)** | bugs *behind* the signature gate — expiry/audience/issuer/scope handling, claim parsing, `kid`/JWKS edge cases | **Yes** — you control a throwaway key the harness trusts |
| **B. Live black-box (real-attacker view)** | what an outsider reaches — no/garbage/replayed tokens, error leakage, other endpoints | **No** — the real backend trusts only Auth0's JWKS; you have no IdP key |

> **The access-asymmetry lesson** (the central finding of the agent exercise): reaching
> validation logic requires *minting validly-signed tokens*, which requires the IdP signing key —
> a **privileged test fixture**, not a real-attacker capability. So validation-logic discovery is
> inherently a **test-harness** activity (Mode A). Mode B is the genuine outsider view.

---

## Mode A — in-process discovery (recommended; executable today)

The surviving harness is `backend/tests/conftest.py`. It stands up the **real**
`require_principal` in an in-process FastAPI app and monkeypatches the JWKS client to trust a
throwaway RSA key you control — so you can mint *any* token (`make_token(priv, **claims)`) and
fire it at the actual auth code with zero network and zero cost. `make_token` / `auth_header` /
the `client` and `keypair` fixtures are your mint + target.

**Steps**

1. From the repo root, launch Claude Code in the backend: `cd backend && claude`.
2. Give it this task (paste verbatim or adapt):

   > You are red-teaming the OIDC bearer gate on `POST /api/execute` (verified by
   > `app.auth.require_principal`). Use the existing test harness in `tests/conftest.py`:
   > `make_token(private_key, **claims)` mints a validly-signed RS256 token the in-process
   > `client` fixture trusts; `keypair` gives `(priv, pub)`; `auth_header(token)` builds the
   > header. Work the OWASP API Security checklist (missing/malformed/expired token, wrong
   > `aud`/`iss`, tampered signature, `alg=none`, missing & look-alike scope, `permissions[]`,
   > rogue-key, body identity spoofing), confirm the existing battery in `tests/test_auth.py`
   > already covers each, then **derive and try NEW hypotheses it doesn't cover** — e.g. unusual
   > `kid` headers, JWKS rotation behavior, `nbf`/`iat` in the future, multi-valued `aud`,
   > nested/duplicate claims, scope as a non-string. Write throwaway pytest cases against the
   > `client` fixture to prove each. Report only what reproduces; for anything real, propose
   > either a new assertion in `tests/test_auth.py` or a new planted mutant in `tests/_mutants.py`.

3. Let it iterate. Each probe is a few lines:

   ```python
   # illustrative — Claude writes these against the conftest fixtures
   def test_probe(client, keypair):
       priv, _ = keypair
       from tests.conftest import make_token, auth_header
       token = make_token(priv, nbf=int(time.time()) + 3600)   # e.g. future not-before
       assert client.get("/protected", headers=auth_header(token)).status_code == 401
   ```

4. **Promote findings.** A real reject-case that holds → add to `backend/tests/test_auth.py`.
   A new bug *class* worth guarding against regression → add a planted variant to
   `backend/tests/_mutants.py` + a paired assertion in `test_auth_mutation.py` (so the gate keeps
   catching it). Run `cd backend && ./verify.sh test` to confirm.

**Cost:** ~the tokens Claude Code spends reasoning; no API key for the target, no Docker. This is
the cheapest tester — at equal (credentialed) footing it matched both the bespoke agent and Strix.

---

## Mode B — live black-box (real-attacker view)

For what a true outsider reaches, point Claude at a *running* instance — you cannot mint accepted
tokens (no IdP key), so this tests the unauthenticated/attacker surface.

1. Run the app with auth on (`AUTH_REQUIRED=true`) against your real/staging Auth0 tenant
   (`docker compose up` per the root README; the throwaway mock IdP used during the agent
   exercise was removed).
2. `cd backend && claude`, then:

   > Black-box test `POST /api/execute` on <URL>. You have **no** valid token. Probe: missing
   > header, malformed/`Basic` header, a structurally-valid but un-trusted JWT, an expired *real*
   > token if you have one, oversized/garbage bodies, and other routes. Use `curl`. Report any
   > non-401/403 on the gated path, internal error-detail leakage, or unintended exposure.

3. For credential-gated classes (expiry/audience/etc.), you'd need a *real* Auth0 token — obtain
   one via the SPA login, then have Claude manipulate what it can (it cannot re-sign). Anything
   requiring a re-signed token is **Mode A** territory (validation logic, test harness).

---

## Why this replaced the custom agent (one line)
At equal credentialed footing, ad-hoc Claude + this harness matched the bespoke agent's
recall/precision on the planted mutants — so the loop was retired and the deterministic,
mutation-covered gate in `backend/tests/` was kept. Full evidence:
[auth-bypass-agent retrospective](../design/auth-bypass-agent.md).
