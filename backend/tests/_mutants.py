"""Deliberately-broken variants of the auth check — mutation-testing fixtures.

Each mutant mirrors `app.auth.require_principal`'s verification but plants exactly one hole, and
returns an HTTP status (200 accepted / 401 unauthenticated / 403 forbidden) as a pure function —
no server, no network. `test_auth_mutation.py` asserts each planted hole is ACCEPTED by its
mutant yet REJECTED by the real gate, proving the regression battery has the sensitivity to catch
that class of bug.

Note: an "HS256 allowed" mutant is not a valid ground truth — modern PyJWT refuses an asymmetric
public key as an HMAC secret (InvalidKeyError) on both encode and decode, so the RS256/HS256
key-confusion attack is mitigated regardless of the algorithms list. We use PyJWT-exploitable
flaws instead.
"""
from __future__ import annotations

from typing import Optional

import jwt

REQUIRED_SCOPE = "execute:code"


def _has_scope(claims: dict) -> bool:
    """Correct, split-based scope check (shared by mutants whose flaw is elsewhere)."""
    scope = claims.get("scope", "")
    if isinstance(scope, str) and REQUIRED_SCOPE in scope.split():
        return True
    perms = claims.get("permissions", [])
    return isinstance(perms, list) and REQUIRED_SCOPE in perms


def expiry_not_checked(token: Optional[str], *, public_key, issuer: str, audience: str) -> int:
    """FLAW: token expiry is not verified, so an expired token is still accepted."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token, public_key, algorithms=["RS256"], audience=audience, issuer=issuer,
            options={"require": ["iss", "aud"], "verify_exp": False},  # <-- planted hole
        )
    except jwt.PyJWTError:
        return 401
    return 200 if _has_scope(claims) else 403


def substring_scope(token: Optional[str], *, public_key, issuer: str, audience: str) -> int:
    """FLAW: scope checked by substring, so 'execute:codex' satisfies 'execute:code'."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token, public_key, algorithms=["RS256"], audience=audience, issuer=issuer,
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return 401
    scope = claims.get("scope", "")
    return 200 if REQUIRED_SCOPE in scope else 403  # <-- substring, not split


def audience_not_checked(token: Optional[str], *, public_key, issuer: str, audience: str) -> int:
    """FLAW: audience is not verified, so a token minted for any audience is accepted."""
    if not token:
        return 401
    try:
        claims = jwt.decode(
            token, public_key, algorithms=["RS256"], issuer=issuer,
            options={"require": ["exp", "iss"], "verify_aud": False},  # <-- planted hole
        )
    except jwt.PyJWTError:
        return 401
    return 200 if _has_scope(claims) else 403


def auth_disabled(token: Optional[str], *, public_key, issuer: str, audience: str) -> int:
    """FLAW: the gate is effectively off (e.g. AUTH_REQUIRED defaulting False)."""
    return 200  # <-- accepts everything, even with no token


MUTANTS = {
    "expiry_not_checked": expiry_not_checked,
    "substring_scope": substring_scope,
    "audience_not_checked": audience_not_checked,
    "auth_disabled": auth_disabled,
}
