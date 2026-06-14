"""Shared auth-test fixtures.

No network and no real Auth0: generate a throwaway RSA keypair, mint our own RS256 JWTs, and
monkeypatch the JWKS client so the public key resolves locally. Shared by the auth regression
tests (test_auth.py) and the mutation-coverage tests (test_auth_mutation.py).
"""
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.auth import Principal, require_principal
from app.config import Settings, get_settings

ISSUER = "https://issuer.example.com/"
AUDIENCE = "https://api.example.test"
JWKS_URL = "https://issuer.example.com/.well-known/jwks.json"


def make_token(private_key, **overrides) -> str:
    """Mint an RS256 token with valid defaults; `overrides` replace any claim."""
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


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def auth_settings(**overrides) -> Settings:
    base = dict(
        auth_required=True,
        oidc_issuer=ISSUER,
        oidc_audience=AUDIENCE,
        oidc_jwks_url=JWKS_URL,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def keypair():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return priv, priv.public_key()


@pytest.fixture
def other_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def client(keypair, monkeypatch):
    """A minimal app exposing the real require_principal dependency, JWKS resolution stubbed."""
    _priv, pub = keypair
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

    app.dependency_overrides[get_settings] = lambda: auth_settings()
    return TestClient(app)
