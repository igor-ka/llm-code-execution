"""Deliberately-broken variants of the auth check — the eval's ground truth.

Each mutant mirrors the real `app.auth` logic but plants exactly one hole. The eval runs the
agent against each and checks it reports the planted weakness (true positive); the agent must
report nothing against the real `auth.py` (the regression guard, covered in test_auth_endpoint).

Mutants are pure functions returning an HTTP status (200 accepted / 401 unauthenticated /
403 forbidden) so they can be checked offline without a server or token spend.
"""
from __future__ import annotations

from typing import Callable, Dict, Optional

import jwt

REQUIRED_SCOPE = "execute:code"

# A mutant verifies a presented bearer token against the trusted public key.
Mutant = Callable[..., int]


def _has_scope(claims: dict) -> bool:
    """Correct, split-based scope check (shared by mutants whose flaw is elsewhere)."""
    scope = claims.get("scope", "")
    if isinstance(scope, str) and REQUIRED_SCOPE in scope.split():
        return True
    perms = claims.get("permissions", [])
    return isinstance(perms, list) and REQUIRED_SCOPE in perms


# Note: an "HS256 allowed" mutant would NOT be a valid ground truth here — modern PyJWT refuses
# to use an asymmetric/public key as an HMAC secret (InvalidKeyError) on both encode and decode,
# so the classic RS256/HS256 key-confusion attack is mitigated regardless of the algorithms list.
# We use exploitable-under-PyJWT flaws instead.


def expiry_not_checked(token: Optional[str], *, public_pem: str, issuer: str, audience: str) -> int:
    """FLAW: token expiry is not verified, so an expired token is still accepted."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token,
            public_pem,
            algorithms=["RS256"],
            audience=audience,
            issuer=issuer,
            options={"require": ["iss", "aud"], "verify_exp": False},  # <-- planted hole
        )
    except jwt.PyJWTError:
        return 401
    return 200 if _has_scope(claims) else 403


def substring_scope(token: Optional[str], *, public_pem: str, issuer: str, audience: str) -> int:
    """FLAW: scope checked by substring, so 'execute:codex' satisfies 'execute:code'."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token, public_pem, algorithms=["RS256"], audience=audience, issuer=issuer,
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return 401
    scope = claims.get("scope", "")
    return 200 if REQUIRED_SCOPE in scope else 403  # <-- substring, not split


def audience_not_checked(
    token: Optional[str], *, public_pem: str, issuer: str, audience: str
) -> int:
    """FLAW: audience is not verified, so a token minted for any audience is accepted."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token, public_pem, algorithms=["RS256"], issuer=issuer,
            options={"require": ["exp", "iss"], "verify_aud": False},  # <-- planted hole
        )
    except jwt.PyJWTError:
        return 401
    return 200 if _has_scope(claims) else 403


def auth_disabled(token: Optional[str], *, public_pem: str, issuer: str, audience: str) -> int:
    """FLAW: the gate is effectively off (e.g. AUTH_REQUIRED defaulting False)."""
    return 200  # <-- accepts everything, even with no token


MUTANTS: Dict[str, Mutant] = {
    "expiry_not_checked": expiry_not_checked,
    "substring_scope": substring_scope,
    "audience_not_checked": audience_not_checked,
    "auth_disabled": auth_disabled,
}
