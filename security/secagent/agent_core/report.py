"""Structured findings + report rendering (markdown for humans, JSON for the eval scorer)."""
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
