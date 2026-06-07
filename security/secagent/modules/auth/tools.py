"""Auth-specific tools: forge JWTs and call the protected endpoint.

`mint_token` is the agent's main weapon — it can produce both valid tokens and a range of
adversarial ones (expired, wrong-audience, missing-scope, rogue-key, alg=none, HS256
key-confusion) depending on the claims/alg/key it is asked for.
"""
from __future__ import annotations

import json
import time
from typing import List, Optional

import jwt

from secagent.agent_core.keys import KeyPair
from secagent.agent_core.tools import LoopbackHTTP, Tool


def make_auth_tools(
    *,
    http: LoopbackHTTP,
    signing: KeyPair,
    rogue: KeyPair,
    issuer: str,
    audience: str,
) -> List[Tool]:
    keys = {"signing": signing, "rogue": rogue}

    def mint_token(
        claims: Optional[dict] = None,
        key: str = "signing",
        alg: str = "RS256",
        kid: Optional[str] = None,
    ) -> str:
        if key not in keys:
            return f"ERROR: key must be 'signing' or 'rogue', got {key!r}"
        kp = keys[key]
        now = int(time.time())
        payload = {
            "iss": issuer,
            "aud": audience,
            "sub": "agent-test-user",
            "iat": now,
            "exp": now + 300,
        }
        payload.update(claims or {})  # caller-supplied claims win (omit 'scope' to test 403)

        headers = {"kid": kid or kp.kid}
        alg_u = alg.upper()
        if alg_u == "NONE":
            token = jwt.encode(payload, key="", algorithm="none", headers=headers)
        elif alg_u.startswith("HS"):
            # Key-confusion attempt: sign with the server's PUBLIC key as the HMAC secret.
            token = jwt.encode(payload, key=signing.public_pem, algorithm=alg_u, headers=headers)
        else:
            token = jwt.encode(payload, key=kp.private_pem, algorithm=alg_u, headers=headers)
        return token

    def call_execute(token: Optional[str] = None, prompt: str = "hi") -> str:
        result = http.request("POST", "/api/execute", token=token, json_body={"prompt": prompt})
        return json.dumps(result)

    return [
        Tool(
            name="mint_token",
            description=(
                "Forge a JWT. Returns the token string. `claims` overrides the defaults "
                "(iss/aud/sub/iat/exp are pre-filled; add 'scope':'execute:code' for a valid "
                "token, or omit it to test the scope gate). `key`='signing' is trusted by the "
                "server; 'rogue' is not. `alg` can be RS256 (default), 'none', or an HS* "
                "value to attempt key confusion. `kid` overrides the key id header."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "claims": {"type": "object", "description": "Claims to set/override"},
                    "key": {"type": "string", "enum": ["signing", "rogue"]},
                    "alg": {"type": "string", "description": "RS256 | none | HS256 | ..."},
                    "kid": {"type": "string"},
                },
                "required": [],
            },
            handler=mint_token,
        ),
        Tool(
            name="call_execute",
            description=(
                "Convenience wrapper: POST /api/execute with an optional bearer token. "
                "Returns {status, body}. Use to prove whether a token is accepted/rejected."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "token": {"type": "string", "description": "Bearer token (omit to send none)"},
                    "prompt": {"type": "string"},
                },
                "required": [],
            },
            handler=call_execute,
        ),
    ]
