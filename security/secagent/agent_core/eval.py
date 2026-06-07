"""Score a run's findings against ground truth (precision / recall).

Domain-agnostic: it takes a list of finding dicts, a list of expected-finding dicts (must-find
issues — planted holes on a mutant, or genuine current issues on real auth), and an optional
list of non-issue dicts (spec-compliant / won't-fix behavior that is not a bug). A finding
matches an item if its combined text contains ANY of the item's `match` keywords (case-insensitive).

Classification per finding: matches an expected item -> true positive; else matches a
non-issue item -> ignored (neither credited nor penalised); else -> false positive.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List

import yaml

DEFAULT_GROUND_TRUTH = (
    Path(__file__).resolve().parents[1] / "modules" / "auth" / "ground_truth.yaml"
)


@dataclass
class Score:
    precision: float
    recall: float
    true_positives: List[str]  # expected ids that were found
    false_negatives: List[str]  # expected ids that were missed
    false_positives: int  # findings matching neither expected nor a non-issue
    ignored_non_issues: List[str]  # non-issue ids the agent surfaced (neither good nor bad)

    def as_dict(self) -> dict:
        return {
            "precision": round(self.precision, 3),
            "recall": round(self.recall, 3),
            "true_positives": self.true_positives,
            "false_negatives": self.false_negatives,
            "false_positives": self.false_positives,
            "ignored_non_issues": self.ignored_non_issues,
        }


def _finding_text(finding: dict) -> str:
    fields = ("title", "hypothesis", "evidence", "recommendation")
    return " ".join(str(finding.get(f, "")) for f in fields).lower()


def _match_items(texts: List[str], items: List[dict], skip: set) -> tuple[set, List[str]]:
    """Return (finding indices that matched, ids of items that were hit), skipping indices
    already claimed by a higher-priority category."""
    matched: set = set()
    hit_ids: List[str] = []
    for item in items:
        keywords = [k.lower() for k in item.get("match", [])]
        hit = False
        for i, text in enumerate(texts):
            if i in skip:
                continue
            if any(k in text for k in keywords):
                matched.add(i)
                hit = True
        if hit:
            hit_ids.append(item["id"])
    return matched, hit_ids


def score(findings: List[dict], expected: List[dict], allowed: List[dict] | None = None) -> Score:
    texts = [_finding_text(f) for f in findings]

    # Expected wins over noise: a finding that matches a planted hole is a true positive even
    # if it also happens to match a noise keyword.
    tp_findings, found_ids = _match_items(texts, expected, skip=set())
    non_issue_findings, non_issue_ids = _match_items(texts, allowed or [], skip=tp_findings)

    missed_ids = [item["id"] for item in expected if item["id"] not in found_ids]
    false_positives = len(findings) - len(tp_findings) - len(non_issue_findings)

    recall = len(found_ids) / len(expected) if expected else 1.0
    denom = len(tp_findings) + false_positives
    precision = len(tp_findings) / denom if denom else 1.0
    return Score(precision, recall, found_ids, missed_ids, false_positives, non_issue_ids)


def load_expected(target: str, path: Path = DEFAULT_GROUND_TRUTH) -> List[dict]:
    """Must-find issues for a target: a mutant's planted hole, or real_auth's genuine findings."""
    data = yaml.safe_load(path.read_text())
    if target == "real_auth":
        return data.get("real_auth", [])
    return data.get("mutants", {}).get(target, [])


def load_non_issues(path: Path = DEFAULT_GROUND_TRUTH) -> List[dict]:
    data = yaml.safe_load(path.read_text())
    return data.get("non_issues", [])


def _main(argv: List[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m secagent.agent_core.eval <findings.json> <mutant-name|real_auth>")
        return 2
    findings_path, target = argv
    findings = json.loads(Path(findings_path).read_text())
    result = score(findings, load_expected(target), load_non_issues())
    print(json.dumps(result.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
