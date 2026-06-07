"""Precision/recall scoring of findings against ground truth."""
from secagent.agent_core.eval import load_expected, score


def _finding(title):
    return {"title": title, "hypothesis": "", "evidence": "", "recommendation": ""}


EXPECTED = [
    {"id": "a", "match": ["hs256", "key confusion"]},
    {"id": "b", "match": ["audience"]},
]


def test_partial_detection():
    findings = [_finding("HS256 key confusion bypass"), _finding("unrelated noise")]
    result = score(findings, EXPECTED)
    assert result.recall == 0.5
    assert result.precision == 0.5  # 1 of 2 findings matched something
    assert result.true_positives == ["a"]
    assert result.false_negatives == ["b"]
    assert result.false_positives == 1


def test_perfect_detection():
    findings = [_finding("HS256 confusion"), _finding("wrong audience accepted")]
    result = score(findings, EXPECTED)
    assert result.recall == 1.0
    assert result.false_positives == 0


def test_no_findings_means_zero_recall_but_clean_precision():
    result = score([], EXPECTED)
    assert result.recall == 0.0
    assert result.precision == 1.0  # vacuously precise — nothing wrong was claimed
    assert result.false_negatives == ["a", "b"]


def test_ground_truth_file_loads():
    expected = load_expected("substring_scope")
    assert expected and expected[0]["id"] == "scope-substring"
