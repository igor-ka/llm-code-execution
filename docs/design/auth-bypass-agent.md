# Auth-bypass agent — retrospective & retirement

- **Status:** Retired (2026-06-14). Superseded by deterministic, mutation-covered auth tests in
  `backend/tests/` (`test_auth.py` + `test_auth_mutation.py`), which run in CI under *Backend
  checks*. This doc preserves the learning; the agent code under `security/` has been deleted.
- **Epic:** #19. Prior decision record: ADR 0002 (now marked Superseded).

## What it was
A learning project: a custom OIDC/JWT auth red-team agent for our own app's `POST /api/execute`
gate. The whole point was to *build the loop by hand* on the Anthropic Messages tool-use API
(not a framework) and see what an agentic security tester does. It worked: across many runs it
found **0 false findings** against the real `auth.py` and caught planted mutants.

## What was built (and the engineering learnings)
- **Hand-rolled ReAct loop** with tool dispatch, a sliding-window history, prompt caching, and
  tools: `mint_token` (forge valid/adversarial JWTs with the mock IdP key), `call_endpoint`,
  `read_backend_logs`, `note_attempt`, `record_finding`.
- **Termination is an *external* problem for open-ended tasks.** "Find any bypass" has no
  internal "done"; empirically neither Haiku nor Sonnet ever self-terminated. The right model is
  a **budget-driven graceful landing** (a soft-budget wrap-up before the hard cap), with three
  stopping rules — token soft-limit, step soft-limit, and a **diminishing-returns/novelty stop**.
- **Coverage must be by identity, not count.** A count gate is satisfied by duplicate attempts
  while real seeds slip; an **identity coverage gate** (each attempt tags a `seed_id`) is honest.
- **The hand-rolled context machinery is redundant** vs. the Agent SDK / Claude Code, which give
  caching, compaction, and subagents for free. Kept only for the learning.

## The decisive finding — access asymmetry (not white-box vs black-box)
Against an *expiry-not-checked* mutant, our agent caught the bug and black-box **Strix missed
it** — but the cause was **a granted credential, not source visibility**. Our agent holds the
mock IdP **signing key** (a privileged *test fixture*, not "white-box"), so it mints a
validly-signed expired token and reaches the validation logic *behind* the signature gate. Strix
had no key, so its expired tokens died at the signature check and it concluded "expiry enforced."
The axes that actually matter: **credential/key access** (decisive here), **task scope**
(specialist vs generalist), and **source visibility** (irrelevant for this bug).

## Build-vs-buy verdict (the Strix + ad-hoc Claude comparison)
Scored via the eval ground truth, on the expiry mutant, **at equal (credentialed) footing**:

| Tester | recall | precision | cost |
|---|:--:|:--:|---|
| Our agent (Haiku) | 1.00 | 1.00 | ~$0.30 |
| Strix, leveled (given a pre-minted expired token, narrow scope) | 1.00 | 1.00 | ~$0.17 |
| **Ad-hoc Claude** (a `mint` helper + `curl`, no bespoke agent) | **1.00** | **1.00** | ~5 calls |

Uncredentialed, Strix scored 0 (the access asymmetry); leveling the credential flipped it to
1.00 and cut a run from ~$3.05 to $0.17. Broad Strix runs cost ~$2.79–3.05 (≈10× our agent).
**Conclusion: given the one privileged ingredient (a mint helper), an off-the-shelf agent — even
just Claude ad hoc — matches the bespoke agent.** The custom loop bought no unique capability;
its only non-capability justifications (CI automation, fixed report format, cost ceilings) are
better served by headless Claude Code / the Agent SDK. So the agent was retired.

## What we kept (the final solution)
- **`backend/tests/test_auth.py`** — the deterministic regression battery over the real
  `require_principal`: every attack class (no/garbage/expired/wrong-aud/wrong-iss/bad-sig/
  alg=none/missing-scope/look-alike-scope) rejected with the right status; valid + permissions-
  array accepted. In CI, no LLM, no Docker, no API key.
- **`backend/tests/_mutants.py` + `test_auth_mutation.py`** — mutation coverage: each planted
  hole is accepted by its mutant yet rejected by the real gate, proving the battery would catch a
  regression. (This is the one genuinely novel asset the agent exercise produced.)

## Ad-hoc exploratory runbook (when you want LLM-driven derivation)
Regression is deterministic (above); *exploration* is on-demand, no bespoke code — ask Claude
Code to derive and try new attacks using the surviving `backend/tests/conftest.py` harness
(in-process), or against a live instance for the outsider view. Full step-by-step (with the
access-asymmetry caveat baked in): **[Runbook: ad-hoc auth security testing with Claude
Code](../runbooks/adhoc-auth-security-testing.md)**.
