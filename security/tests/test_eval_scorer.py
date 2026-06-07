"""Precision/recall scoring of findings against ground truth."""
from secagent.agent_core.eval import load_acceptable, load_expected, score


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


# --- acceptable noise (judgment-call findings against the real auth.py) ----------------

ALLOWED = [
    {"id": "aud-array", "match": ["aud array"]},
    {"id": "empty-sub", "match": ["empty sub"]},
]


def test_acceptable_noise_is_not_a_false_positive():
    findings = [_finding("Multi-valued aud array accepted"), _finding("Empty sub accepted")]
    result = score(findings, expected=[], allowed=ALLOWED)
    assert result.false_positives == 0
    assert result.precision == 1.0
    assert sorted(result.ignored_noise) == ["aud-array", "empty-sub"]


def test_expected_beats_noise():
    # A finding matching both a planted hole and a noise rule counts as a true positive.
    expected = [{"id": "aud-bug", "match": ["audience"]}]
    allowed = [{"id": "aud-noise", "match": ["audience"]}]
    result = score([_finding("audience not validated")], expected, allowed)
    assert result.true_positives == ["aud-bug"]
    assert result.ignored_noise == []
    assert result.false_positives == 0


def test_genuine_false_positive_still_counts():
    expected = [{"id": "a", "match": ["expired"]}]
    findings = [_finding("expired token accepted"), _finding("totally unrelated claim")]
    result = score(findings, expected, allowed=ALLOWED)
    assert result.false_positives == 1  # the unrelated finding
    assert result.ignored_noise == []


def test_real_auth_run_scores_clean_against_acceptable_noise():
    # The two findings from the live run, scored as a real-auth run (no planted holes).
    findings = [
        _finding("Multi-valued aud array accepted — audience too permissive"),
        _finding("Empty sub claim accepted"),
    ]
    result = score(findings, load_expected("real_auth"), load_acceptable())
    assert result.false_positives == 0
    assert sorted(result.ignored_noise) == ["aud-array-multivalue", "empty-sub"]
