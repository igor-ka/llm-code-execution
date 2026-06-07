"""Precision/recall scoring of findings against ground truth."""
from secagent.agent_core.eval import load_expected, load_non_issues, score


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


# --- three buckets: real findings (credited), non-issues (ignored), false positives ----

NON_ISSUES = [{"id": "aud-array", "match": ["aud array"]}]


def test_non_issue_is_ignored_not_a_false_positive():
    result = score([_finding("Multi-valued aud array accepted")], expected=[], allowed=NON_ISSUES)
    assert result.false_positives == 0
    assert result.precision == 1.0
    assert result.ignored_non_issues == ["aud-array"]


def test_expected_beats_non_issue():
    # A finding matching both a real issue and a non-issue rule counts as a true positive.
    expected = [{"id": "aud-bug", "match": ["audience"]}]
    allowed = [{"id": "aud-noise", "match": ["audience"]}]
    result = score([_finding("audience not validated")], expected, allowed)
    assert result.true_positives == ["aud-bug"]
    assert result.ignored_non_issues == []
    assert result.false_positives == 0


def test_genuine_false_positive_still_counts():
    expected = [{"id": "a", "match": ["expired"]}]
    findings = [_finding("expired token accepted"), _finding("totally unrelated claim")]
    result = score(findings, expected, allowed=NON_ISSUES)
    assert result.false_positives == 1  # the unrelated finding
    assert result.ignored_non_issues == []


def test_real_auth_run_credits_empty_sub_and_ignores_aud_array():
    # The two live-run findings: empty-sub is a REAL finding (credited), aud-array is a non-issue.
    findings = [
        _finding("Multi-valued aud array accepted — audience too permissive"),
        _finding("Empty sub claim accepted"),
    ]
    result = score(findings, load_expected("real_auth"), load_non_issues())
    assert result.true_positives == ["empty-sub"]  # credited, not ignored
    assert result.recall == 1.0  # found the known real finding
    assert result.false_positives == 0
    assert result.ignored_non_issues == ["aud-array-multivalue"]


def test_missing_a_known_real_finding_is_a_regression():
    # If a future run no longer reports empty-sub, that's a false negative (recall < 1).
    result = score([], load_expected("real_auth"), load_non_issues())
    assert result.recall == 0.0
    assert result.false_negatives == ["empty-sub"]
