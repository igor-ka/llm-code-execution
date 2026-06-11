"""Smoke test: run.main() wires the agent + report writer without a live API or network.

run.py is otherwise untested, so a stale kwarg to run_agent(...)/write_report_set(...) could
silently false-green (ruff won't catch a wrong cross-module keyword). This drives main() with a
fake LLM client so any such drift fails loudly.
"""
import types

import secagent.run as run
from secagent.agent_core import keys


def _fake_anthropic_factory():
    end = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text="done")],
        stop_reason="end_turn",
        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
    )
    messages = types.SimpleNamespace(create=lambda **kw: end)
    return types.SimpleNamespace(messages=messages)


def test_main_wires_and_writes_a_report(tmp_path, monkeypatch):
    key_dir = tmp_path / "keys"
    key_dir.mkdir()
    keys.save_keypair(str(key_dir), "signing", keys.generate_keypair("signing"))  # JWKS signer
    monkeypatch.setattr(run, "Anthropic", _fake_anthropic_factory)
    monkeypatch.setenv("OIDC_ISSUER", "http://mock/")
    monkeypatch.setenv("OIDC_AUDIENCE", "https://api.local")
    monkeypatch.setenv("KEY_DIR", str(key_dir))
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("TARGET_BASE_URL", "http://127.0.0.1:8000")

    run.main()  # must not raise — exercises run_agent(...) + write_report_set(...) kwargs

    htmls = list((tmp_path / "reports").glob("auth-*.html"))
    assert len(htmls) == 1 and htmls[0].read_text().startswith("<!doctype html>")
