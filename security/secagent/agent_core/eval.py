"""Score a run's findings against ground truth (precision / recall).

Domain-agnostic: it takes a list of finding dicts and a list of expected-finding dicts (each
with `match` keywords) and computes how well the agent did. A finding matches an expected item
if its combined text contains ANY of the expected item's keywords (case-insensitive).
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
    false_positives: int  # findings that matched no expected item

    def as_dict(self) -> dict:
        return {
            "precision": round(self.precision, 3),
            "recall": round(self.recall, 3),
            "true_positives": self.true_positives,
            "false_negatives": self.false_negatives,
            "false_positives": self.false_positives,
        }


def _finding_text(finding: dict) -> str:
    fields = ("title", "hypothesis", "evidence", "recommendation")
    return " ".join(str(finding.get(f, "")) for f in fields).lower()


def score(findings: List[dict], expected: List[dict]) -> Score:
    texts = [_finding_text(f) for f in findings]
    matched_findings: set[int] = set()
    found_ids: List[str] = []

    for item in expected:
        keywords = [k.lower() for k in item.get("match", [])]
        hit = False
        for i, text in enumerate(texts):
            if any(k in text for k in keywords):
                matched_findings.add(i)
                hit = True
        if hit:
            found_ids.append(item["id"])

    missed_ids = [item["id"] for item in expected if item["id"] not in found_ids]
    false_positives = len(findings) - len(matched_findings)

    recall = len(found_ids) / len(expected) if expected else 1.0
    precision = len(matched_findings) / len(findings) if findings else 1.0
    return Score(precision, recall, found_ids, missed_ids, false_positives)


def load_expected(mutant: str, path: Path = DEFAULT_GROUND_TRUTH) -> List[dict]:
    data = yaml.safe_load(path.read_text())
    return data.get("mutants", {}).get(mutant, [])


def _main(argv: List[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m secagent.agent_core.eval <findings.json> <mutant-name>")
        return 2
    findings_path, mutant = argv
    findings = json.loads(Path(findings_path).read_text())
    result = score(findings, load_expected(mutant))
    print(json.dumps(result.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
