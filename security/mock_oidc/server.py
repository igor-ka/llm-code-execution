"""FastAPI mock OIDC provider.

Publishes the public half of a signing keypair we control as a JWKS, so the backend (pointed
here via OIDC_JWKS_URL) trusts tokens the agent mints with the private half. The private key is
persisted to KEY_DIR so the agent container can load the same key.
"""
from __future__ import annotations

import os

from fastapi import FastAPI

from secagent.agent_core.keys import jwks, load_or_create

ISSUER = os.environ.get("OIDC_ISSUER", "http://mock-oidc:9000/")
KEY_DIR = os.environ.get("KEY_DIR", "/keys")
SIGNING_KID = os.environ.get("SIGNING_KID", "mock-signing-key")

app = FastAPI(title="mock-oidc")
_signing = load_or_create(KEY_DIR, "signing", SIGNING_KID)


@app.get("/.well-known/jwks.json")
def jwks_endpoint() -> dict:
    return jwks(_signing)


@app.get("/.well-known/openid-configuration")
def openid_configuration() -> dict:
    base = ISSUER.rstrip("/")
    return {"issuer": ISSUER, "jwks_uri": f"{base}/.well-known/jwks.json"}
