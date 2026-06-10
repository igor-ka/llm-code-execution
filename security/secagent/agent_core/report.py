"""Structured findings + report rendering.

Three renderings of the same run: markdown (quick human read), JSON (the eval scorer's input),
and a self-contained HTML report (the at-a-glance human deliverable — see `render_html_report`).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from html import escape
from typing import Any, List, Sequence, Tuple

SEVERITIES = ("info", "low", "medium", "high", "critical")


@dataclass
class Finding:
    severity: str
    title: str
    hypothesis: str
    repro: str
    evidence: str
    recommendation: str

    def __post_init__(self) -> None:
        if self.severity not in SEVERITIES:
            raise ValueError(f"severity must be one of {SEVERITIES}, got {self.severity!r}")


@dataclass
class AttemptLedger:
    """External memory of hypotheses already tested + their outcome.

    Re-injected into context every turn so the agent doesn't forget (or repeat) what it tried,
    even when raw history is trimmed by the sliding window. This is the durable state the
    sliding window alone would lose.
    """

    attempts: List[dict] = field(default_factory=list)

    def add(self, hypothesis: str, outcome: str, seed_id: str | None = None) -> str:
        self.attempts.append({"hypothesis": hypothesis, "outcome": outcome, "seed_id": seed_id})
        return f"noted attempt ({len(self.attempts)} total)"

    @property
    def covered_seeds(self) -> set:
        """Seed ids tested at least once — derived from attempts, not tracked separately."""
        return {a["seed_id"] for a in self.attempts if a.get("seed_id")}

    def uncovered(self, required: set) -> set:
        """Required seed ids not yet covered — what the coverage gate steers toward."""
        return set(required) - self.covered_seeds

    def render(self) -> str:
        if not self.attempts:
            return ""
        lines = ["Hypotheses already tested (do NOT repeat these):"]
        lines += [f"- {a['hypothesis']} → {a['outcome']}" for a in self.attempts]
        return "\n".join(lines)


@dataclass
class FindingStore:
    """Append-only sink the `record_finding` tool writes to."""

    findings: List[Finding] = field(default_factory=list)

    def add(self, **kwargs) -> Finding:
        finding = Finding(**kwargs)
        self.findings.append(finding)
        return finding

    def to_json(self) -> str:
        return json.dumps([asdict(f) for f in self.findings], indent=2)

    def to_markdown(self, *, target: str, partial: bool = False) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines = [
            "# Auth-bypass agent — findings",
            "",
            f"- **Target:** {target}",
            f"- **Generated:** {ts}",
            f"- **Findings:** {len(self.findings)}"
            + ("  _(partial — budget exhausted)_" if partial else ""),
            "",
        ]
        if not self.findings:
            lines.append("_No findings — the auth gate held against every hypothesis tried._")
            return "\n".join(lines)
        order = {s: i for i, s in enumerate(reversed(SEVERITIES))}
        for f in sorted(self.findings, key=lambda f: order[f.severity]):
            lines += [
                f"## [{f.severity.upper()}] {f.title}",
                "",
                f"- **Hypothesis:** {f.hypothesis}",
                f"- **Reproduction:** {f.repro}",
                f"- **Evidence:** {f.evidence}",
                f"- **Recommendation:** {f.recommendation}",
                "",
            ]
        return "\n".join(lines)


# --- HTML report --------------------------------------------------------------------------

_SEV_COLOR = {
    "critical": "#b00020",
    "high": "#d9534f",
    "medium": "#e8901a",
    "low": "#3a87ad",
    "info": "#6c757d",
}
_OK_GREEN = "#2e7d32"

_HTML_CSS = """
:root { --line: #e3e6ea; --muted: #6b7280; --bg: #f6f7f9; --card: #fff; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: #1f2430;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
a { color: #3a87ad; }
.meta { color: var(--muted); font-size: 13px; }
.meta code { background: #eef0f3; padding: 1px 6px; border-radius: 4px; }
.badges { margin: 14px 0 0; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px;
  font-weight: 600; color: #fff; margin-right: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.finding { background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--line);
  border-radius: 8px; padding: 14px 18px; margin: 12px 0; }
.finding h3 { margin: 0 0 8px; font-size: 16px; }
.finding .sev { display: inline-block; font-size: 11px; font-weight: 700; color: #fff;
  padding: 2px 8px; border-radius: 4px; vertical-align: middle; margin-right: 8px; }
.finding dl { margin: 8px 0 0; display: grid; grid-template-columns: 130px 1fr; gap: 4px 14px; }
.finding dt { color: var(--muted); font-size: 13px; }
.finding dd { margin: 0; }
.ok { background: #e7f4e8; border: 1px solid #bfe0c2; color: #1e5e23; padding: 14px 18px; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-size: 14px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: #f0f2f5; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
tr:last-child td { border-bottom: none; }
td code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 4px; font-weight: 600; }
.tag.yes { background: #e7f4e8; color: #1e5e23; }
.tag.no  { background: #fdeaea; color: #9b1c1c; }
.dim { color: var(--muted); }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; text-align: center; }
"""


def _esc(value: Any) -> str:
    return escape(str(value))


def render_html_report(
    *,
    target: str,
    model: str,
    findings: FindingStore,
    ledger: AttemptLedger,
    seeds: Sequence[Tuple[str, str]],
    steps: int,
    tokens_used: int,
    tool_calls: int,
    stopped_on_budget: bool,
    partial: bool,
    error: str | None = None,
    transcript: Sequence[dict] = (),
    generated: datetime | None = None,
) -> str:
    """A self-contained, dependency-free HTML report of one run: a summary banner, the findings,
    baseline seed coverage (by identity), the attempt ledger, and the step-by-step transcript.
    All inputs are plain data so this stays decoupled from the loop/Seed types."""
    ts = (generated or datetime.now(timezone.utc)).strftime("%Y-%m-%d %H:%M UTC")

    # Findings, worst-first.
    order = {s: i for i, s in enumerate(reversed(SEVERITIES))}
    sorted_findings = sorted(findings.findings, key=lambda f: order[f.severity])
    worst_color = _SEV_COLOR[sorted_findings[0].severity] if sorted_findings else _OK_GREEN

    # Baseline coverage by seed identity.
    outcomes_by_seed: dict = {}
    for a in ledger.attempts:
        sid = a.get("seed_id")
        if sid:
            outcomes_by_seed.setdefault(sid, []).append(a.get("outcome", ""))
    covered = sum(1 for sid, _ in seeds if sid in outcomes_by_seed)
    total_seeds = len(seeds)

    # Status badges.
    badges = []
    if error:
        badges.append(
            f'<span class="badge" style="background:{_SEV_COLOR["high"]}">ended on error</span>'
        )
    if partial:
        badges.append(
            f'<span class="badge" style="background:{_SEV_COLOR["medium"]}">partial run</span>'
        )
    if not partial and not error:
        badges.append(
            f'<span class="badge" style="background:{_OK_GREEN}">completed cleanly</span>'
        )

    if stopped_on_budget:
        outcome_txt, outcome_color = "Stopped on budget", _SEV_COLOR["medium"]
    elif error:
        outcome_txt, outcome_color = "Error (partial)", _SEV_COLOR["high"]
    else:
        outcome_txt, outcome_color = "Completed", _OK_GREEN

    cov_color = _OK_GREEN if covered == total_seeds and total_seeds else _SEV_COLOR["medium"]

    # Summary cards.
    cards = [
        ("Findings", str(len(sorted_findings)),
         "auth gate held" if not sorted_findings else "see below", worst_color),
        ("Baseline coverage", f"{covered}/{total_seeds}", "seeds tested by id", cov_color),
        ("Steps", str(steps), "ReAct turns", "#1f2430"),
        ("Tokens", f"≈{tokens_used:,}", "billed in+out", "#1f2430"),
        ("Tool calls", str(tool_calls), "endpoint/forge/log", "#1f2430"),
        ("Outcome", outcome_txt, "how the run ended", outcome_color),
    ]
    card_html = "\n".join(
        f'<div class="card"><div class="label">{_esc(lbl)}</div>'
        f'<div class="value" style="color:{color}">{_esc(val)}</div>'
        f'<div class="sub">{_esc(sub)}</div></div>'
        for lbl, val, sub, color in cards
    )

    # Findings cards (or a clean "gate held" banner).
    if sorted_findings:
        fitems = []
        for f in sorted_findings:
            c = _SEV_COLOR[f.severity]
            fitems.append(
                f'<div class="finding" style="border-left-color:{c}">'
                f'<h3><span class="sev" style="background:{c}">{_esc(f.severity.upper())}</span>'
                f"{_esc(f.title)}</h3>"
                f"<dl>"
                f"<dt>Hypothesis</dt><dd>{_esc(f.hypothesis)}</dd>"
                f"<dt>Reproduction</dt><dd>{_esc(f.repro)}</dd>"
                f'<dt>Evidence</dt><dd class="mono">{_esc(f.evidence)}</dd>'
                f"<dt>Recommendation</dt><dd>{_esc(f.recommendation)}</dd>"
                f"</dl></div>"
            )
        findings_html = "\n".join(fitems)
    else:
        findings_html = (
            '<div class="ok">✓ No findings — the auth gate held against every '
            "hypothesis tried.</div>"
        )

    # Seed coverage table (by identity).
    cov_rows = []
    for sid, text in seeds:
        hit = sid in outcomes_by_seed
        tag = (
            '<span class="tag yes">covered</span>' if hit
            else '<span class="tag no">missed</span>'
        )
        outcome = "; ".join(o for o in outcomes_by_seed.get(sid, []) if o)
        outcome_cell = _esc(outcome) if hit else '<span class="dim">not tested</span>'
        cov_rows.append(
            f"<tr><td><code>{_esc(sid)}</code></td><td>{_esc(text)}</td>"
            f"<td>{tag}</td><td>{outcome_cell}</td></tr>"
        )
    coverage_html = (
        "<table><thead><tr><th>Seed</th><th>Hypothesis</th><th>Status</th>"
        "<th>Observed outcome</th></tr></thead><tbody>"
        + "\n".join(cov_rows)
        + "</tbody></table>"
    )

    # Attempt ledger.
    if ledger.attempts:
        att_rows = []
        for i, a in enumerate(ledger.attempts, 1):
            seed_cell = (
                f"<code>{_esc(a['seed_id'])}</code>" if a.get("seed_id")
                else '<span class="dim">derived</span>'
            )
            att_rows.append(
                f"<tr><td>{i}</td><td>{_esc(a.get('hypothesis', ''))}</td>"
                f"<td>{seed_cell}</td><td>{_esc(a.get('outcome', ''))}</td></tr>"
            )
        ledger_html = (
            "<table><thead><tr><th>#</th><th>Hypothesis</th><th>Seed</th><th>Outcome</th>"
            "</tr></thead><tbody>" + "\n".join(att_rows) + "</tbody></table>"
        )
    else:
        ledger_html = '<p class="dim">No attempts were logged.</p>'

    # Step-by-step transcript.
    if transcript:
        tr_rows = []
        for s in transcript:
            tools = ", ".join(c.get("name", "") for c in s.get("tool_calls", [])) or "—"
            toks = f"{s.get('cumulative_tokens', 0):,}"
            tr_rows.append(
                f"<tr><td>{_esc(s.get('step', ''))}</td><td>{_esc(tools)}</td>"
                f'<td class="mono">≈{_esc(toks)}</td>'
                f"<td><code>{_esc(s.get('stop_reason', ''))}</code></td></tr>"
            )
        transcript_html = (
            "<table><thead><tr><th>Step</th><th>Tools fired</th><th>Cumulative tokens</th>"
            "<th>Stop reason</th></tr></thead><tbody>" + "\n".join(tr_rows) + "</tbody></table>"
        )
    else:
        transcript_html = '<p class="dim">No transcript captured.</p>'

    error_html = (
        '<div class="ok" style="background:#fdeaea;border-color:#f3b4b4;color:#9b1c1c">'
        f"⚠ Run ended on error: {_esc(error)}</div>" if error else ""
    )

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auth-bypass agent report — {_esc(target)}</title>
<style>{_HTML_CSS}</style></head>
<body><div class="wrap">
<h1>Auth-bypass agent — run report</h1>
<div class="meta">Target <code>{_esc(target)}</code> · Model <code>{_esc(model)}</code> · \
Generated {_esc(ts)}</div>
<div class="badges">{"".join(badges)}</div>
{error_html}
<div class="cards">{card_html}</div>

<h2>Findings</h2>
{findings_html}

<h2>Baseline seed coverage <span class="dim">({covered}/{total_seeds} covered by identity)</span></h2>
{coverage_html}

<h2>Attempt ledger <span class="dim">({len(ledger.attempts)} attempts)</span></h2>
{ledger_html}

<h2>Run transcript</h2>
{transcript_html}

<footer>Generated by the hand-rolled auth red-team agent · loopback-only test harness</footer>
</div></body></html>
"""
