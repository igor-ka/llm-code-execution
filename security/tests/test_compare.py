"""Comparing our findings against a baseline tool's, via ground truth."""
from secagent.agent_core.compare import compare, normalize_strix


def _finding(title):
    return {"title": title, "hypothesis": "", "evidence": "", "recommendation": ""}


EXPECTED = [
    {"id": "a", "match": ["alpha-bug"]},
    {"id": "b", "match": ["beta-bug"]},
    {"id": "c", "match": ["gamma-bug"]},
]


def test_compare_shared_unique_and_missed():
    ours = [_finding("alpha-bug found"), _finding("beta-bug found")]  # a, b
    theirs = normalize_strix([{"name": "beta-bug found"}, {"title": "gamma-bug found"}])  # b, c
    result = compare(ours, theirs, EXPECTED, non_issues=[])
    assert result.shared == ["b"]
    assert result.ours_only == ["a"]
    assert result.theirs_only == ["c"]
    assert result.missed_by_both == []  # a, b, c all found by someone
    assert result.ours.recall == 2 / 3 and result.theirs.recall == 2 / 3


def test_unmatched_findings_flagged_for_investigation():
    # A finding matching neither ground truth nor a non-issue is "unmatched" (candidate new / FP).
    ours = [_finding("alpha-bug found")]
    theirs = normalize_strix([{"name": "alpha-bug found"}, {"name": "some novel SSRF"}])
    result = compare(ours, theirs, EXPECTED, non_issues=[])
    assert result.ours_unmatched == 0
    assert result.theirs_unmatched == 1  # the novel SSRF


def test_non_issue_not_counted_as_unmatched():
    non_issues = [{"id": "noise", "match": ["aud array"]}]
    theirs = normalize_strix([{"name": "Multi-valued aud array accepted"}])
    result = compare([], theirs, EXPECTED, non_issues)
    assert result.theirs_unmatched == 0  # aud-array is a known non-issue, not a surprise


def test_normalize_strix_aliases_and_wrappers():
    raw = {"findings": [{"name": "X", "description": "d", "remediation": "fix"}]}
    out = normalize_strix(raw)
    assert out == [{"title": "X", "hypothesis": "d", "evidence": "", "recommendation": "fix"}]
    # tolerant of a bare list and of junk entries
    assert normalize_strix([{"title": "Y"}, "junk", 3]) == [
        {"title": "Y", "hypothesis": "", "evidence": "", "recommendation": ""}
    ]
    assert normalize_strix("not a list") == []


def test_normalize_strix_real_schema():
    # Real Strix 1.0.4 vulnerabilities.json shape (one finding object, fields per observed schema).
    # The mapped text must carry the keywords ground truth matches on (here: expiry).
    raw = [
        {
            "id": "vuln-0001",
            "title": "JWT Expiration Not Validated in POST /api/execute",
            "severity": "critical",
            "description": "The endpoint accepts an expired JWT without validating exp.",
            "impact": "A leaked token works indefinitely.",
            "technical_analysis": "Signature is verified but the exp claim is not checked.",
            "poc_description": "Replay an expired but validly-signed token; 200 is returned.",
            "poc_script_code": "requests.post(url, headers={'Authorization': 'Bearer <jwt>'})",
            "remediation_steps": "Validate the exp claim against current time.",
            "cwe": "CWE-613",
        }
    ]
    out = normalize_strix(raw)
    assert len(out) == 1
    f = out[0]
    assert f["title"].startswith("JWT Expiration")
    assert "exp" in f["hypothesis"]  # description carried over
    assert "expired" in f["evidence"]  # poc_description carried over (not blank)
    assert "exp claim" in f["recommendation"]  # remediation_steps carried over
    blob = " ".join(f.values()).lower()
    assert "expir" in blob  # matches ground-truth expiry-bypass keywords


def test_markdown_renders_rows():
    result = compare([_finding("alpha-bug")], normalize_strix([]), EXPECTED, non_issues=[])
    md = result.to_markdown(theirs_name="Strix")
    assert "Baseline comparison" in md and "Strix" in md and "Only our agent:" in md
