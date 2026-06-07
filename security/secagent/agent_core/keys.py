"""RSA key material shared by the mock OIDC server and the agent's token-forging tools.

The mock OIDC publishes the *public* half as a JWKS; the agent holds the *private* half to
mint tokens. A separate "rogue" key (whose public half is NOT in the JWKS) lets the agent
attempt key/`kid` confusion attacks.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


@dataclass
class KeyPair:
    """An RSA keypair plus the `kid` it is published/labelled under."""

    kid: str
    private_pem: str
    public_pem: str

    def jwk(self) -> dict:
        """The public half as a JWK entry (what a JWKS endpoint would serve)."""
        algo = jwt.algorithms.RSAAlgorithm(jwt.algorithms.RSAAlgorithm.SHA256)
        key = algo.prepare_key(self.public_pem)
        jwk = algo.to_jwk(key, as_dict=True)
        jwk.update({"kid": self.kid, "use": "sig", "alg": "RS256"})
        return jwk


def generate_keypair(kid: str) -> KeyPair:
    """Generate a fresh RSA-2048 keypair labelled with `kid`."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        private.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return KeyPair(kid=kid, private_pem=private_pem, public_pem=public_pem)


def jwks(*keypairs: KeyPair) -> dict:
    """Assemble a JWKS document from the public halves of the given keypairs."""
    return {"keys": [kp.jwk() for kp in keypairs]}


def save_keypair(directory: str, name: str, kp: KeyPair) -> None:
    """Persist a keypair so the mock OIDC and the agent can share the signing key."""
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, f"{name}_private.pem"), "w") as f:
        f.write(kp.private_pem)
    with open(os.path.join(directory, f"{name}_public.pem"), "w") as f:
        f.write(kp.public_pem)
    with open(os.path.join(directory, f"{name}_kid.txt"), "w") as f:
        f.write(kp.kid)


def load_keypair(directory: str, name: str) -> KeyPair:
    with open(os.path.join(directory, f"{name}_private.pem")) as f:
        private_pem = f.read()
    with open(os.path.join(directory, f"{name}_public.pem")) as f:
        public_pem = f.read()
    with open(os.path.join(directory, f"{name}_kid.txt")) as f:
        kid = f.read().strip()
    return KeyPair(kid=kid, private_pem=private_pem, public_pem=public_pem)


def load_or_create(directory: str, name: str, kid: str) -> KeyPair:
    """Load the named keypair from `directory`, generating + persisting it if absent."""
    try:
        return load_keypair(directory, name)
    except FileNotFoundError:
        kp = generate_keypair(kid)
        save_keypair(directory, name, kp)
        return kp
