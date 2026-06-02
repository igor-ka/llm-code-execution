"""OIDC bearer-token verification for protected endpoints.

The flow this guards is intentionally simple (SPA-direct bearer): the frontend sends the
access token as `Authorization: Bearer <jwt>` and this module verifies it against the OIDC
provider's JWKS, then derives the caller's identity from the token claims.

Staged rollout: when ``auth_required`` is False (the default) the dependency is a no-op that
yields an anonymous principal, so the app keeps working before the frontend sends tokens.
When True, every protected request must carry a valid, in-scope token.
"""
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request
from jwt import PyJWKClient

from app.config import Settings, get_settings

# Scope/permission a token must carry to run code. Matches the Auth0 API permission.
REQUIRED_SCOPE = "execute:code"


@dataclass
class Principal:
    """The verified caller. Fields are None when auth is disabled (anonymous)."""

    user_id: Optional[str]
    tenant_id: Optional[str]


@lru_cache
def _jwk_client(jwks_url: str) -> PyJWKClient:
    """One cached JWKS client per URL. It caches keys in-memory and refetches on unknown kid."""
    return PyJWKClient(jwks_url)


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    return token.strip()


def _has_required_scope(claims: dict) -> bool:
    # Auth0 puts scopes in a space-delimited `scope` string and/or a `permissions` array.
    scope_claim = claims.get("scope", "")
    if isinstance(scope_claim, str) and REQUIRED_SCOPE in scope_claim.split():
        return True
    permissions = claims.get("permissions", [])
    return isinstance(permissions, list) and REQUIRED_SCOPE in permissions


def require_principal(
    request: Request, settings: Settings = Depends(get_settings)
) -> Principal:
    """FastAPI dependency: verify the bearer token and return the caller's Principal.

    401 for a missing/invalid/expired/wrong-audience/wrong-issuer/bad-signature token;
    403 for a valid token that lacks the required scope.
    """
    if not settings.auth_required:
        return Principal(user_id=None, tenant_id=None)

    token = _bearer_token(request)
    try:
        signing_key = _jwk_client(settings.oidc_jwks_url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.oidc_audience,
            issuer=settings.oidc_issuer,
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token") from exc

    if not _has_required_scope(claims):
        raise HTTPException(
            status_code=403, detail=f"Token is missing the required scope '{REQUIRED_SCOPE}'"
        )

    # Identity comes from the verified token, never from the request body.
    return Principal(user_id=claims.get("sub"), tenant_id=claims.get("org_id"))
