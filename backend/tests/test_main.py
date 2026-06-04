"""Tests for the public, unauthenticated endpoints."""
from fastapi.testclient import TestClient

from app import main
from app.config import Settings


def test_health_is_ok():
    assert TestClient(main.app).get("/api/health").json() == {"status": "ok"}


def test_config_reports_auth_required_true(monkeypatch):
    monkeypatch.setattr(main, "get_settings", lambda: Settings(auth_required=True))
    resp = TestClient(main.app).get("/api/config")
    assert resp.status_code == 200
    assert resp.json() == {"auth_required": True}


def test_config_reports_auth_required_false(monkeypatch):
    monkeypatch.setattr(main, "get_settings", lambda: Settings(auth_required=False))
    resp = TestClient(main.app).get("/api/config")
    assert resp.status_code == 200
    assert resp.json() == {"auth_required": False}


def test_config_is_public_even_when_auth_required(monkeypatch):
    """The SPA must read config before login, so this endpoint carries no token gate."""
    monkeypatch.setattr(main, "get_settings", lambda: Settings(auth_required=True))
    # No Authorization header — still 200.
    assert TestClient(main.app).get("/api/config").status_code == 200
