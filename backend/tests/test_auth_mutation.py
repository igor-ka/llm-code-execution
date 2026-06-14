"""Mutation coverage: prove the auth regression battery would CATCH a regression.

For each planted-hole mutant: the attack is accepted by the mutant (200) but rejected by the
real `require_principal` (via the `client` fixture). If a future edit to auth.py reintroduced one
of these flaws, the matching test in test_auth.py would flip from reject→accept and fail — this
file demonstrates that link is real. Pure-function mutants live in _mutants.py.
"""
import time

from tests import _mutants
from tests.conftest import AUDIENCE, ISSUER, auth_header, make_token


def test_expiry_mutant_caught(client, keypair):
    priv, pub = keypair
    expired = make_token(priv, exp=int(time.time()) - 10)
    assert _mutants.expiry_not_checked(
        expired, public_key=pub, issuer=ISSUER, audience=AUDIENCE
    ) == 200
    assert client.get("/protected", headers=auth_header(expired)).status_code == 401


def test_substring_scope_mutant_caught(client, keypair):
    priv, pub = keypair
    token = make_token(priv, scope="openid execute:codex", permissions=[])
    assert _mutants.substring_scope(token, public_key=pub, issuer=ISSUER, audience=AUDIENCE) == 200
    assert client.get("/protected", headers=auth_header(token)).status_code == 403


def test_audience_mutant_caught(client, keypair):
    priv, pub = keypair
    token = make_token(priv, aud="https://wrong")
    assert _mutants.audience_not_checked(
        token, public_key=pub, issuer=ISSUER, audience=AUDIENCE
    ) == 200
    assert client.get("/protected", headers=auth_header(token)).status_code == 401


def test_auth_disabled_mutant_caught(client, keypair):
    _priv, pub = keypair
    assert _mutants.auth_disabled(None, public_key=pub, issuer=ISSUER, audience=AUDIENCE) == 200
    assert client.get("/protected").status_code == 401  # real gate rejects no-token


def test_mutants_accept_a_normal_valid_token(keypair):
    # Sanity: each planted hole is the ONLY difference — a valid token still works everywhere.
    priv, pub = keypair
    token = make_token(priv)
    for name in ("expiry_not_checked", "substring_scope", "audience_not_checked"):
        assert _mutants.MUTANTS[name](
            token, public_key=pub, issuer=ISSUER, audience=AUDIENCE
        ) == 200
