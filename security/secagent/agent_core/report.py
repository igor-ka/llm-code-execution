"""Structured findings + the findings/ledger data model.

Two renderings of the run live here: markdown (quick human read) and JSON (the eval scorer's
input). The at-a-glance HTML report lives in `html_report.py` so its CSS/presentation don't
crowd these data types.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import List

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
