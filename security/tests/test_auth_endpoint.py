"""End-to-end behavior of the REAL auth gate, driven through the agent's tools.

These double as the ground truth for the eval (#23): against the real `auth.py`, every attack
is correctly rejected — so the agent should report zero findings.
"""
import time


def test_no_token_is_401(call_execute):
    status, _ = call_execute()
    assert status == 401


def test_valid_token_is_accepted(call_execute, mint):
    status, body = call_execute(token=mint(claims={"scope": "execute:code"}))
    assert status == 200
    assert body["ok"] is True


def test_expired_token_is_401(call_execute, mint):
    token = mint(claims={"scope": "execute:code", "exp": int(time.time()) - 10})
    status, _ = call_execute(token=token)
    assert status == 401


def test_wrong_audience_is_401(call_execute, mint):
    token = mint(claims={"scope": "execute:code", "aud": "https://wrong"})
    assert call_execute(token=token)[0] == 401


def test_rogue_signed_token_is_401(call_execute, mint):
    token = mint(key="rogue", claims={"scope": "execute:code"})
    assert call_execute(token=token)[0] == 401


def test_alg_none_is_401(call_execute, mint):
    token = mint(alg="none", claims={"scope": "execute:code"})
    assert call_execute(token=token)[0] == 401


def test_missing_scope_is_403(call_execute, mint):
    status, _ = call_execute(token=mint(claims={}))
    assert status == 403


def test_lookalike_scope_is_403(call_execute, mint):
    status, _ = call_execute(token=mint(claims={"scope": "execute:codex"}))
    assert status == 403


def test_scope_via_permissions_array_is_accepted(call_execute, mint):
    status, _ = call_execute(token=mint(claims={"permissions": ["execute:code"]}))
    assert status == 200
