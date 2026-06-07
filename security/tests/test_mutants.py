"""Each mutant is genuinely exploitable — and the REAL auth.py blocks the same attack.

This is the eval's ground truth: the attack that the real gate rejects (proven via the live
in-process app in `call_execute`) is *accepted* by the mutant. So if the agent reports the
weakness against a mutant it's a true positive, and reporting nothing against real auth is correct.
"""
from secagent.modules.auth.mutants import MUTANTS
from tests.conftest import AUDIENCE, ISSUER


def _run_mutant(name, token, signing):
    return MUTANTS[name](token, public_pem=signing.public_pem, issuer=ISSUER, audience=AUDIENCE)


def test_expiry_not_checked(mint, call_execute, signing):
    import time

    token = mint(claims={"scope": "execute:code", "exp": int(time.time()) - 10})
    assert _run_mutant("expiry_not_checked", token, signing) == 200  # mutant accepts expired
    assert call_execute(token=token)[0] == 401  # real auth rejects


def test_substring_scope(mint, call_execute, signing):
    token = mint(claims={"scope": "execute:codex"})
    assert _run_mutant("substring_scope", token, signing) == 200
    assert call_execute(token=token)[0] == 403


def test_audience_not_checked(mint, call_execute, signing):
    token = mint(claims={"scope": "execute:code", "aud": "https://wrong"})
    assert _run_mutant("audience_not_checked", token, signing) == 200
    assert call_execute(token=token)[0] == 401


def test_auth_disabled(call_execute, signing):
    assert _run_mutant("auth_disabled", None, signing) == 200  # accepts with no token
    assert call_execute()[0] == 401  # real auth rejects


def test_mutants_accept_a_normal_valid_token(mint, signing):
    # Sanity: the planted hole is the *only* difference — valid tokens still work.
    token = mint(claims={"scope": "execute:code"})
    for name in ("expiry_not_checked", "substring_scope", "audience_not_checked"):
        assert _run_mutant(name, token, signing) == 200
