# Retire the auth agent; keep a deterministic CI regression gate — Implementation Plan

**Goal:** Now that the learning is done and what's needed is a CI gate, replace the entire
hand-rolled LLM auth agent with the minimal deterministic artifact: the backend's existing
in-CI auth tests, hardened with two missing attack cases + mutation coverage. Delete all
intermediate scaffolding; distill the learning into one concise doc.

**Architecture:** A CI auth-regression gate needs determinism, speed, and zero cost — not an
LLM. `backend/tests/test_auth.py` (already run by the "Backend checks" CI job) already exercises
the real `require_principal` against a crafted-token battery in-process (no network, no Docker,
no API key). We add the two attack classes it lacks (`alg=none`, look-alike scope) and a
**mutation-coverage** test (the one genuinely novel asset from the `security/` exercise: prove
the battery *catches* a planted regression). Then we delete `security/` wholesale — nothing
outside it imports `secagent` (verified) — and keep the LLM path only as a documented *ad-hoc*
runbook, not code.

**Tech stack:** Python 3.11, pytest, PyJWT, `cryptography`, FastAPI TestClient. Checks:
`cd backend && ./verify.sh` (mirrors CI: install / lint / test). No new deps; no Docker for the
gate.

## Guiding constraints
- **No external breakage:** verified nothing outside `security/` imports `secagent` or references
  `docker-compose.test.yml`. Deletion is self-contained.
- **CI job-name contract:** the new tests run under the existing **Backend checks** job
  (`working-directory: backend`). No CI job added/renamed.
- **Reversibility:** the deleted agent stays in git history (and on merged PR #32); this is a
  retirement, not erasure. ADR 0002 is marked *Superseded*, not deleted (ADRs are historical).
- **Honesty about what's lost:** in-repo autonomous exploratory testing is removed; recovered on
  demand via the ad-hoc Claude runbook in the learning doc.

## Files

**Modify:**
- `backend/tests/test_auth.py` — add `test_alg_none_is_401`, `test_lookalike_scope_is_403`.
- `docs/adr/0002-agentic-auth-security-testing.md` — add a **Superseded** banner + 4-line why.
- `docs/design/auth-bypass-agent.md` — replace body with the concise retrospective/learning doc.
- `README.md` — fix the one stale security line (162) if it points at deleted material.

**Create:**
- `backend/tests/_mutants.py` — the 4 pure mutant functions (moved from
  `security/secagent/modules/auth/mutants/__init__.py`), each mirroring `auth.py` with one flaw.
- `backend/tests/test_auth_mutation.py` — for each mutant: the planted attack is accepted by the
  mutant but rejected by the real `require_principal` (mutation/recall coverage).

**Delete (all scaffolding):**
- The entire `security/` tree: `secagent/` (loop, tools, report, html_report, eval, compare,
  keys, modules/auth/{prompt,checklist,tools,mutants}, run), `mock_oidc/`, `tests/`,
  `docker-compose.test.yml`, `Dockerfile`, `verify.sh`, `pyproject.toml`, `README.md`,
  `comparisons/` (distilled into the learning doc first).

## Out of scope
- Touching `backend/app/auth.py` (the code under test — unchanged).
- Any new CI job or Docker. Frontend. The `.claude/skills/` plan-review vendored skills (stay).

---

### Task 1: Harden the existing battery — add the two missing attack cases
**Files:** Modify `backend/tests/test_auth.py` (uses existing `client`, `keypair`, `_make_token`).

- [ ] **Step 1: Add the tests** (mirror the existing style; `alg=none` and look-alike scope):

```python
def test_alg_none_token_is_401(client):
    # Unsigned token (alg=none) must be rejected — never trusted regardless of claims.
    token = jwt.encode({"sub": "x", "iss": ISSUER, "aud": AUDIENCE,
                        "exp": int(time.time()) + 300, "scope": "execute:code"},
                       key="", algorithm="none")
    assert client.get("/protected", headers=_auth_header(token)).status_code == 401


def test_lookalike_scope_is_403(client, keypair):
    # 'execute:codex' must NOT satisfy 'execute:code' (split-based check, not substring).
    priv, _ = keypair
    token = _make_token(priv, scope="openid execute:codex", permissions=[])
    assert client.get("/protected", headers=_auth_header(token)).status_code == 403
```

- [ ] **Step 2: Run** `cd backend && ./verify.sh test` → both pass (proves real `auth.py` already
  rejects these; if either fails it's a real auth bug to surface, not a test bug).
- [ ] **Step 3: Commit.**

### Task 2: Mutation coverage — prove the battery catches regressions
**Files:** Create `backend/tests/_mutants.py`, `backend/tests/test_auth_mutation.py`.

- [ ] **Step 1: `_mutants.py`** — the 4 pure functions (verbatim logic from the security tree),
  each taking `(token, *, public_pem, issuer, audience) -> int` (HTTP status), one planted flaw:
  `expiry_not_checked` (`verify_exp=False`), `substring_scope` (`in` not `split()`),
  `audience_not_checked` (`verify_aud=False`), `auth_disabled` (returns 200). Include the
  module docstring noting PyJWT blocks HS256/RS256 key-confusion (so no such mutant).

- [ ] **Step 2: `test_auth_mutation.py`** — for each mutant, assert the planted attack is
  *accepted by the mutant* (200) and *rejected by the real gate* (via the existing `client`
  fixture from `test_auth.py` — import it or replicate the fixture). Example:

```python
def test_expiry_mutant_caught(client, keypair):
    priv, _ = keypair
    expired = _make_token(priv, exp=int(time.time()) - 10)
    assert _mutants.expiry_not_checked(expired, public_pem=PUB, issuer=ISSUER, audience=AUDIENCE) == 200
    assert client.get("/protected", headers=_auth_header(expired)).status_code == 401
```

  (Resolve fixture/keypair sharing: either move `client`/`keypair`/`_make_token`/`_auth_header`
  into `backend/tests/conftest.py` so both files use them, or import from `test_auth`. Prefer
  conftest — cleaner. The mutant needs the public PEM; derive from the `keypair` fixture.)

- [ ] **Step 3: Run** `cd backend && ./verify.sh test` → all pass.
- [ ] **Step 4: Commit.**

### Task 3: Distill the learning into one doc
**Files:** Rewrite `docs/design/auth-bypass-agent.md`; banner on `docs/adr/0002`.

- [ ] Concise doc covering: the agent build + loop/termination/coverage learnings; the
  **access-asymmetry** finding (signing-key fixture ≠ white/black-box); the **Strix 3-way
  build-vs-buy verdict** (ad-hoc Claude + a mint helper matches the bespoke agent → don't keep
  it); **why the kept solution is deterministic mutation-covered backend tests**; and the
  **ad-hoc exploratory runbook** (mint a token, point Claude/`curl` at the gate) for when
  derivation is wanted. Pull numbers from the (about-to-be-deleted) comparison record.
- [ ] ADR 0002: prepend `> **Status: Superseded (2026-06-14).** The custom agent served its
  learning purpose; the retained CI artifact is deterministic mutation-covered auth tests in
  `backend/tests/`. See docs/design/auth-bypass-agent.md.`
- [ ] Commit.

### Task 4: Delete the scaffolding
**Files:** `git rm -r security/`.

- [ ] **Step 1:** `git rm -r security/`.
- [ ] **Step 2:** `grep -rn "secagent\|security/" --include=*.md --include=*.yml --include=*.py .`
  (excluding docs/plans + the learning doc) → fix any dangling reference (expect none outside docs).
- [ ] **Step 3: Run** `cd backend && ./verify.sh` (full: install/lint/test) → green.
      Run `cd frontend && ./verify.sh` is unaffected (untouched).
- [ ] **Step 4: Commit** the deletion separately so the PR history shows build → compare → retire.

## Final verification
- [ ] `cd backend && ./verify.sh` green (the gate, now hardened, runs in CI under Backend checks).
- [ ] `git grep -n secagent` returns nothing (outside docs/plans history).
- [ ] PR #34 updated; per CLAUDE.md run `code-review` + `security-review` on the diff before ready.

## Self-review notes
- **Coverage:** Task 1+2 = "keep the final solution" (regression + mutation), Task 4 = "remove
  intermediate", Task 3 = "document learning". All three asks covered.
- **Risk:** the only real risk is a dangling reference after deletion — mitigated by the grep in
  Task 4 Step 2 and the verified no-external-import check. Blast radius confined to `security/` +
  3 docs + `backend/tests/`.
- **Type consistency:** mutant signature `(token, *, public_pem, issuer, audience) -> int` matches
  both the moved functions and the test call sites; `client`/`keypair`/`_make_token` shared via
  conftest so both test files agree.
