"""Shared fixtures.

The key idea: stand up the **real** backend `require_principal` dependency in an in-process
FastAPI app, pointed at a signing key we control (the JWKS lookup is monkeypatched to return
our public key). The agent's real tools then drive it over an in-memory ASGI transport — so
tests exercise the actual auth code with zero network and zero token spend.
"""
from __future__ import annotations

import json

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import app.auth as auth_mod
from app.auth import Principal, require_principal
from app.config import Settings, get_settings
from secagent.agent_core.keys import generate_keypair
from secagent.agent_core.report import FindingStore
from secagent.agent_core.tools import LoopbackHTTP, ToolRegistry, make_generic_tools
from secagent.modules.auth.tools import make_auth_tools

ISSUER = "http://mock-oidc.test/"
AUDIENCE = "https://api.local"


@pytest.fixture
def signing():
    return generate_keypair("mock-signing-key")


@pytest.fixture
def rogue():
    return generate_keypair("rogue-key")


@pytest.fixture
def app(signing, monkeypatch):
    """In-process app whose /api/execute is guarded by the real require_principal."""

    class _FakeJWK:
        def __init__(self, pem):
            self.key = pem

    class _FakeJWKClient:
        def __init__(self, pem):
            self._pem = pem

        def get_signing_key_from_jwt(self, token):  # signature matches PyJWKClient
            return _FakeJWK(self._pem)

    # The server only ever trusts the signing key's public half (whatever kid is presented).
    monkeypatch.setattr(auth_mod, "_jwk_client", lambda url: _FakeJWKClient(signing.public_pem))

    settings = Settings(
        auth_required=True,
        oidc_issuer=ISSUER,
        oidc_audience=AUDIENCE,
        oidc_jwks_url="http://mock-oidc.test/.well-known/jwks.json",
    )

    fastapi_app = FastAPI()

    @fastapi_app.post("/api/execute")
    def execute(principal: Principal = Depends(require_principal)):
        return {"ok": True, "user_id": principal.user_id}

    fastapi_app.dependency_overrides[get_settings] = lambda: settings
    return fastapi_app


@pytest.fixture
def loop_http(app):
    # TestClient is a sync, ASGI-aware httpx.Client — what LoopbackHTTP expects.
    client = TestClient(app, base_url="http://127.0.0.1")
    return LoopbackHTTP("http://127.0.0.1", client=client)


@pytest.fixture
def findings():
    return FindingStore()


@pytest.fixture
def registry(loop_http, findings, signing, rogue):
    tools = make_generic_tools(loop_http, findings) + make_auth_tools(
        http=loop_http, signing=signing, rogue=rogue, issuer=ISSUER, audience=AUDIENCE
    )
    return ToolRegistry(tools)


@pytest.fixture
def mint(registry):
    """mint(claims=..., key=..., alg=..., kid=...) -> token string (via the real tool)."""

    def _mint(**kwargs):
        return registry.dispatch("mint_token", kwargs)

    return _mint


@pytest.fixture
def call_execute(registry):
    """call_execute(token=...) -> (status, body) via the real tool."""

    def _call(**kwargs):
        result = json.loads(registry.dispatch("call_execute", kwargs))
        return result["status"], result["body"]

    return _call
