"""Tests for the OIDC bearer-token dependency.

No network and no real Auth0: we generate a throwaway RSA keypair, mint our own RS256
JWTs, and monkeypatch the JWKS client so the public key is resolved locally.
"""
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from types import SimpleNamespace

from app import auth
from app.auth import Principal, require_principal
from app.config import Settings, get_settings

ISSUER = "https://issuer.example.com/"
AUDIENCE = "https://api.example.test"
JWKS_URL = "https://issuer.example.com/.well-known/jwks.json"


@pytest.fixture
def keypair():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return priv, priv.public_key()


@pytest.fixture
def other_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _make_token(private_key, **overrides) -> str:
    claims = {
        "sub": "auth0|abc123",
        "org_id": "org_xyz",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 300,
        "scope": "openid profile execute:code",
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm="RS256")


def _auth_settings(**overrides) -> Settings:
    base = dict(
        auth_required=True,
        oidc_issuer=ISSUER,
        oidc_audience=AUDIENCE,
        oidc_jwks_url=JWKS_URL,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def client(keypair, monkeypatch):
    """A minimal app exposing the dependency, with settings + JWKS resolution stubbed."""
    _priv, pub = keypair
    # Resolve any token to our local public key — no network.
    monkeypatch.setattr(
        auth,
        "_jwk_client",
        lambda url: SimpleNamespace(
            get_signing_key_from_jwt=lambda token: SimpleNamespace(key=pub)
        ),
    )

    app = FastAPI()

    @app.get("/protected")
    def protected(principal: Principal = Depends(require_principal)):
        return {"user_id": principal.user_id, "tenant_id": principal.tenant_id}

    app.dependency_overrides[get_settings] = lambda: _auth_settings()
    return TestClient(app)


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_valid_token_passes_and_yields_claims(client, keypair):
    priv, _ = keypair
    resp = client.get("/protected", headers=_auth_header(_make_token(priv)))
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "auth0|abc123", "tenant_id": "org_xyz"}


def test_scope_via_permissions_array_passes(client, keypair):
    priv, _ = keypair
    token = _make_token(priv, scope="openid profile", permissions=["execute:code"])
    resp = client.get("/protected", headers=_auth_header(token))
    assert resp.status_code == 200


def test_missing_scope_is_403(client, keypair):
    priv, _ = keypair
    token = _make_token(priv, scope="openid profile", permissions=[])
    resp = client.get("/protected", headers=_auth_header(token))
    assert resp.status_code == 403


def test_bad_signature_is_401(client, other_key):
    # Signed by a different key than the one the JWKS client resolves.
    resp = client.get("/protected", headers=_auth_header(_make_token(other_key)))
    assert resp.status_code == 401


def test_wrong_audience_is_401(client, keypair):
    priv, _ = keypair
    resp = client.get("/protected", headers=_auth_header(_make_token(priv, aud="someone-else")))
    assert resp.status_code == 401


def test_wrong_issuer_is_401(client, keypair):
    priv, _ = keypair
    token = _make_token(priv, iss="https://evil.example.com/")
    resp = client.get("/protected", headers=_auth_header(token))
    assert resp.status_code == 401


def test_expired_is_401(client, keypair):
    priv, _ = keypair
    token = _make_token(priv, exp=int(time.time()) - 10)
    resp = client.get("/protected", headers=_auth_header(token))
    assert resp.status_code == 401


def test_missing_header_is_401(client):
    assert client.get("/protected").status_code == 401


def test_garbage_header_is_401(client):
    assert client.get("/protected", headers={"Authorization": "Basic xyz"}).status_code == 401


def test_disabled_auth_allows_anonymous(monkeypatch):
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

    app.dependency_overrides[get_settings] = lambda: _auth_settings()
    try:
        resp = TestClient(app).post("/api/execute", json={"prompt": "hello"})
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.pop(get_settings, None)
