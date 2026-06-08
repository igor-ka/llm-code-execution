"""Seed hypotheses — the phase-1 floor (design doc §5). The agent derives more in phase 2.

All are runtime-testable against the live endpoint via the agent's tools. The expected result
for a correct gate is in parentheses; a *finding* is when reality differs.
"""

SEED_HYPOTHESES = [
    "No token / missing Authorization header is rejected (401).",
    "A malformed Authorization header (not 'Bearer <jwt>') is rejected (401).",
    "An expired token (exp in the past), otherwise valid, is rejected (401).",
    "A token with the wrong audience is rejected (401).",
    "A token with the wrong issuer is rejected (401).",
    "A token with a tampered payload (broken signature) is rejected (401).",
    "An alg=none (unsigned) token is rejected (401).",
    "An HS256 key-confusion token (HMAC-signed with the server's public key) is rejected.",
    "A token signed by a rogue key not in the server's JWKS (or a forged kid) is rejected (401).",
    "A valid, correctly-signed token lacking the 'execute:code' scope is rejected (403).",
    "A look-alike scope such as 'execute:codex' or 'xexecute:code' does NOT satisfy "
    "'execute:code'.",
    "A token carrying the scope via a 'permissions' array is accepted (intended behavior).",
    "Identity cannot be spoofed via the request body: user_id/tenant_id sent in the body are "
    "ignored (identity comes only from verified token claims).",
    "Other endpoints (e.g. /api/health and any unguarded route) expose nothing they shouldn't "
    "to an unauthenticated caller.",
]
