"""Compare our agent's findings against a baseline tool's (e.g. Strix), via the ground truth.

This is the payoff for #24: a head-to-head over the same target. Both finding sets are matched
to ground-truth ids, so we can say who caught each planted hole / real issue, where they agree,
and what each surfaced that ISN'T in ground truth (candidate new findings — promote to ground
truth — or false positives).

Strix's on-disk result schema isn't documented (results land in `strix_runs/<run>/`), so
`normalize_strix` is a tolerant, *provisional* adapter over common field names. Adjust it once a
real Strix run is observed; only the text fields matter for matching.
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List

from .eval import Score, _match_items, _finding_text, load_expected, load_non_issues, score


@dataclass
class Comparison:
    ours: Score
    theirs: Score
    shared: List[str]  # ground-truth ids both tools found
    ours_only: List[str]  # ground-truth ids only our agent found
    theirs_only: List[str]  # ground-truth ids only the baseline found
    missed_by_both: List[str]  # ground-truth ids neither found
    ours_unmatched: int  # our findings matching neither expected nor a non-issue (investigate)
    theirs_unmatched: int  # baseline findings, same

    def as_dict(self) -> dict:
        d = asdict(self)
        d["ours"] = self.ours.as_dict()
        d["theirs"] = self.theirs.as_dict()
        return d

    def to_markdown(self, *, ours_name: str = "our agent", theirs_name: str = "Strix") -> str:
        lines = [
            "# Baseline comparison",
            "",
            f"|                | {ours_name} | {theirs_name} |",
            "|----------------|:----:|:----:|",
            f"| recall         | {self.ours.recall:.2f} | {self.theirs.recall:.2f} |",
            f"| precision      | {self.ours.precision:.2f} | {self.theirs.precision:.2f} |",
            f"| unmatched (investigate) | {self.ours_unmatched} | {self.theirs_unmatched} |",
            "",
            f"- **Found by both:** {', '.join(self.shared) or '—'}",
            f"- **Only {ours_name}:** {', '.join(self.ours_only) or '—'}",
            f"- **Only {theirs_name}:** {', '.join(self.theirs_only) or '—'}",
            f"- **Missed by both:** {', '.join(self.missed_by_both) or '—'}",
        ]
        return "\n".join(lines)


def _found_ground_truth_ids(findings: List[dict], expected: List[dict]) -> set:
    texts = [_finding_text(f) for f in findings]
    _, ids = _match_items(texts, expected, skip=set())
    return set(ids)


def compare(
    ours: List[dict], theirs: List[dict], expected: List[dict], non_issues: List[dict]
) -> Comparison:
    ours_score = score(ours, expected, non_issues)
    theirs_score = score(theirs, expected, non_issues)
    ours_ids = _found_ground_truth_ids(ours, expected)
    theirs_ids = _found_ground_truth_ids(theirs, expected)
    all_ids = {item["id"] for item in expected}
    return Comparison(
        ours=ours_score,
        theirs=theirs_score,
        shared=sorted(ours_ids & theirs_ids),
        ours_only=sorted(ours_ids - theirs_ids),
        theirs_only=sorted(theirs_ids - ours_ids),
        missed_by_both=sorted(all_ids - ours_ids - theirs_ids),
        ours_unmatched=ours_score.false_positives,
        theirs_unmatched=theirs_score.false_positives,
    )


def _first(d: dict, *keys: str, default: str = "") -> str:
    for k in keys:
        if d.get(k):
            return str(d[k])
    return default


def normalize_strix(raw) -> List[dict]:
    """Best-effort map of Strix output to our finding-dict shape (text fields only).

    PROVISIONAL: accepts a list, or a dict wrapping the list under findings/results/
    vulnerabilities, and aliases common field names. Revisit once Strix's real schema is seen.
    """
    if isinstance(raw, dict):
        for key in ("findings", "results", "vulnerabilities", "issues"):
            if isinstance(raw.get(key), list):
                raw = raw[key]
                break
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "title": _first(item, "title", "name", "summary", "vulnerability", "type"),
                "hypothesis": _first(item, "description", "details", "explanation"),
                "evidence": _first(item, "evidence", "proof", "poc", "reproduction", "details"),
                "recommendation": _first(item, "recommendation", "remediation", "fix", "mitigation"),
            }
        )
    return out


def _load(path: str, kind: str) -> List[dict]:
    raw = json.loads(Path(path).read_text())
    return raw if kind == "ours" else normalize_strix(raw)


def _main(argv: List[str]) -> int:
    if len(argv) != 3:
        print(
            "usage: python -m secagent.agent_core.compare "
            "<ours-findings.json> <strix-results.json> <mutant-name|real_auth>"
        )
        return 2
    ours_path, strix_path, target = argv
    expected, non_issues = load_expected(target), load_non_issues()
    result = compare(_load(ours_path, "ours"), _load(strix_path, "strix"), expected, non_issues)
    print(result.to_markdown())
    print("\n" + json.dumps(result.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
