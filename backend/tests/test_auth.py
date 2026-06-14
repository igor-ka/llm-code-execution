"""Regression battery for the OIDC bearer-token dependency (the real `require_principal`).

Shared fixtures/helpers live in conftest.py. Every attack here must be rejected with the right
status — this is the CI gate on auth.py. Mutation coverage (proof these would catch a regression)
lives in test_auth_mutation.py.
"""
import time

import jwt
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import Principal, require_principal
from app.config import Settings, get_settings
from tests.conftest import AUDIENCE, ISSUER, auth_header, auth_settings, make_token


def test_valid_token_passes_and_yields_claims(client, keypair):
    priv, _ = keypair
    resp = client.get("/protected", headers=auth_header(make_token(priv)))
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "auth0|abc123", "tenant_id": "org_xyz"}


def test_scope_via_permissions_array_passes(client, keypair):
    priv, _ = keypair
    token = make_token(priv, scope="openid profile", permissions=["execute:code"])
    assert client.get("/protected", headers=auth_header(token)).status_code == 200


def test_missing_scope_is_403(client, keypair):
    priv, _ = keypair
    token = make_token(priv, scope="openid profile", permissions=[])
    assert client.get("/protected", headers=auth_header(token)).status_code == 403


def test_lookalike_scope_is_403(client, keypair):
    # 'execute:codex' must NOT satisfy 'execute:code' — split-based check, never substring.
    priv, _ = keypair
    token = make_token(priv, scope="openid execute:codex", permissions=[])
    assert client.get("/protected", headers=auth_header(token)).status_code == 403


def test_bad_signature_is_401(client, other_key):
    # Signed by a different key than the one the JWKS client resolves.
    assert client.get("/protected", headers=auth_header(make_token(other_key))).status_code == 401


def test_alg_none_token_is_401(client):
    # Unsigned token (alg=none) must be rejected regardless of claims.
    token = jwt.encode(
        {"sub": "x", "iss": ISSUER, "aud": AUDIENCE,
         "exp": int(time.time()) + 300, "scope": "execute:code"},
        key="", algorithm="none",
    )
    assert client.get("/protected", headers=auth_header(token)).status_code == 401


def test_wrong_audience_is_401(client, keypair):
    priv, _ = keypair
    assert client.get(
        "/protected", headers=auth_header(make_token(priv, aud="someone-else"))
    ).status_code == 401


def test_wrong_issuer_is_401(client, keypair):
    priv, _ = keypair
    token = make_token(priv, iss="https://evil.example.com/")
    assert client.get("/protected", headers=auth_header(token)).status_code == 401


def test_expired_is_401(client, keypair):
    priv, _ = keypair
    token = make_token(priv, exp=int(time.time()) - 10)
    assert client.get("/protected", headers=auth_header(token)).status_code == 401


def test_missing_header_is_401(client):
    assert client.get("/protected").status_code == 401


def test_garbage_header_is_401(client):
    assert client.get("/protected", headers={"Authorization": "Basic xyz"}).status_code == 401


def test_disabled_auth_allows_anonymous():
    """With auth_required=False, no token is needed and the principal is anonymous."""
    app = FastAPI()

    @app.get("/protected")
    def protected(principal: Principal = Depends(require_principal)):
        return {"user_id": principal.user_id, "tenant_id": principal.tenant_id}

    app.dependency_overrides[get_settings] = lambda: Settings(auth_required=False)
    resp = TestClient(app).get("/protected")
    assert resp.status_code == 200
    assert resp.json() == {"user_id": None, "tenant_id": None}


def test_execute_endpoint_requires_token_when_enabled():
    """Wiring check: the real /api/execute is gated (401 before any LLM work)."""
    from app.main import app

    app.dependency_overrides[get_settings] = lambda: auth_settings()
    try:
        resp = TestClient(app).post("/api/execute", json={"prompt": "hello"})
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.pop(get_settings, None)
