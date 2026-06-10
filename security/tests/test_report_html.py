"""The self-contained HTML run report (render_html_report)."""
from secagent.agent_core.html_report import render_html_report
from secagent.agent_core.report import AttemptLedger, FindingStore

SEEDS = [
    ("no_token", "No token is rejected (401)."),
    ("alg_none", "An alg=none token is rejected."),
    ("expired", "An expired token is rejected (401)."),
]


def _render(findings, ledger, **kw):
    defaults = dict(
        target="http://backend:8000", model="claude-haiku-4-5", findings=findings,
        ledger=ledger, seeds=SEEDS, steps=5, tokens_used=1234, tool_calls=3,
        stopped_on_budget=False, partial=False,
    )
    defaults.update(kw)
    return render_html_report(**defaults)


def test_clean_run_reports_gate_held_and_full_coverage():
    ledger = AttemptLedger()
    for sid, _ in SEEDS:
        ledger.add(sid, "rejected 401", seed_id=sid)
    html = _render(FindingStore(), ledger)
    assert html.startswith("<!doctype html>")
    assert "the auth gate held" in html  # no findings → clean banner
    assert "3/3" in html  # every seed covered
    assert "completed cleanly" in html


def test_finding_is_rendered_and_html_is_escaped():
    findings = FindingStore()
    findings.add(
        severity="high", title="alg=none accepted", hypothesis="unsigned token",
        repro="POST with alg=none", evidence="200 OK <script>alert(1)</script>",
        recommendation="reject unsigned tokens",
    )
    html = _render(findings, AttemptLedger())
    assert "alg=none accepted" in html and "HIGH" in html
    # evidence is attacker-influenced text → must be escaped, never live markup.
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_uncovered_seeds_and_derived_attempts_are_surfaced():
    ledger = AttemptLedger()
    ledger.add("no token", "401", seed_id="no_token")  # one seed covered
    ledger.add("my own idea", "401")  # derived (no seed_id)
    html = _render(findings=FindingStore(), ledger=ledger)
    assert "1/3" in html  # only one of three seeds covered
    assert "missed" in html  # the uncovered seeds are flagged
    assert "derived" in html  # the untagged attempt is labelled derived


def test_partial_and_error_runs_are_flagged():
    html = _render(
        FindingStore(), AttemptLedger(), partial=True, stopped_on_budget=True,
        error="529 overloaded",
    )
    assert "partial run" in html and "ended on error" in html
    assert "Stopped on budget" in html
    assert "529 overloaded" in html
