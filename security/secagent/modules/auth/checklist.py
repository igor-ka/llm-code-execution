"""Seed hypotheses — the phase-1 floor (design doc §5). The agent derives more in phase 2.

This walking-skeleton ships a representative subset; the full 14-item list lands with #22.
"""

SEED_HYPOTHESES = [
    "No token / missing Authorization header should be rejected (401).",
    "An expired token (exp in the past), otherwise valid, should be rejected (401).",
    "A token signed by the rogue key (not in the server's JWKS) should be rejected (401).",
    "A token with a wrong audience should be rejected (401).",
    "A valid, correctly-signed token that lacks the 'execute:code' scope should be "
    "rejected (403).",
    "A look-alike scope such as 'execute:codex' must NOT satisfy the 'execute:code' "
    "requirement.",
]
