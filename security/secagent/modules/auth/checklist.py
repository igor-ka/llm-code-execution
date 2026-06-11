"""Seed hypotheses — the phase-1 floor (design doc §5). The agent derives more in phase 2.

All are runtime-testable against the live endpoint via the agent's tools. The expected result
for a correct gate is in parentheses; a *finding* is when reality differs.

Each seed carries a stable `id` so coverage is tracked by IDENTITY, not by a raw attempt
count. The agent tags each `note_attempt` with the seed it addressed, and the coverage gate
nudges toward the *specific* seeds still missing. A count gate is satisfied by duplicate
attempts while real seeds quietly slip through; an identity gate is not.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Seed:
    id: str
    text: str


SEED_HYPOTHESES = [
    Seed("no_token", "No token / missing Authorization header is rejected (401)."),
    Seed(
        "malformed_header",
        "A malformed Authorization header (not 'Bearer <jwt>') is rejected (401).",
    ),
    Seed("expired", "An expired token (exp in the past), otherwise valid, is rejected (401)."),
    Seed("wrong_audience", "A token with the wrong audience is rejected (401)."),
    Seed("wrong_issuer", "A token with the wrong issuer is rejected (401)."),
    Seed(
        "tampered_payload",
        "A token with a tampered payload (broken signature) is rejected (401).",
    ),
    Seed("alg_none", "An alg=none (unsigned) token is rejected (401)."),
    Seed(
        "hs256_confusion",
        "An HS256 key-confusion token (HMAC-signed with the server's public key) is rejected.",
    ),
    Seed(
        "rogue_key",
        "A token signed by a rogue key not in the server's JWKS (or a forged kid) is "
        "rejected (401).",
    ),
    Seed(
        "missing_scope",
        "A valid, correctly-signed token lacking the 'execute:code' scope is rejected (403).",
    ),
    Seed(
        "lookalike_scope",
        "A look-alike scope such as 'execute:codex' or 'xexecute:code' does NOT satisfy "
        "'execute:code'.",
    ),
    Seed(
        "permissions_array",
        "A token carrying the scope via a 'permissions' array is accepted (intended behavior).",
    ),
    Seed(
        "body_spoof",
        "Identity cannot be spoofed via the request body: user_id/tenant_id sent in the body "
        "are ignored (identity comes only from verified token claims).",
    ),
    Seed(
        "endpoint_enum",
        "Other endpoints (e.g. /api/health and any unguarded route) expose nothing they "
        "shouldn't to an unauthenticated caller.",
    ),
]

SEED_IDS = {s.id for s in SEED_HYPOTHESES}
