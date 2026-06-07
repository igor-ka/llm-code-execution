"""The forging tool produces the tokens the agent needs."""
import time

import jwt

from tests.conftest import AUDIENCE, ISSUER


def test_valid_token_decodes_with_expected_claims(mint, signing):
    token = mint(claims={"scope": "execute:code"})
    decoded = jwt.decode(
        token, signing.public_pem, algorithms=["RS256"], audience=AUDIENCE, issuer=ISSUER
    )
    assert decoded["scope"] == "execute:code"
    assert decoded["sub"] and decoded["exp"] > time.time()


def test_caller_claims_override_defaults(mint, signing):
    token = mint(claims={"scope": "execute:code", "aud": "https://other"})
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "RS256"
    body = jwt.decode(token, options={"verify_signature": False})
    assert body["aud"] == "https://other"


def test_alg_none_is_unsigned(mint):
    token = mint(claims={"scope": "execute:code"}, alg="none")
    assert jwt.get_unverified_header(token)["alg"] == "none"


def test_rogue_key_differs_from_signing(mint, signing):
    rogue_token = mint(key="rogue", claims={"scope": "execute:code"})
    # Verifying a rogue-signed token against the trusted key must fail.
    try:
        jwt.decode(rogue_token, signing.public_pem, algorithms=["RS256"], audience=AUDIENCE,
                   issuer=ISSUER)
        raised = False
    except jwt.InvalidSignatureError:
        raised = True
    assert raised
