"""Anti-premature-exit: coverage-gated termination + retry/partial-report on API errors."""
from types import SimpleNamespace

from secagent.agent_core.loop import Budget, run_agent
from secagent.agent_core.report import AttemptLedger
from secagent.agent_core.tools import Tool, ToolRegistry


def _end(text="done"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )


def _truncated(text="partial", tool_use=False):
    content = [SimpleNamespace(type="text", text=text)]
    if tool_use:  # a partial tool_use block, as happens when output is cut mid-call
        content.append(SimpleNamespace(type="tool_use", id="x", name="noop", input={}))
    return SimpleNamespace(
        content=content, stop_reason="max_tokens",
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )


class _AlwaysEnd:
    """A model that always tries to finish immediately."""

    class _Messages:
        def create(self, **kwargs):
            return _end()

    messages = _Messages()


class _Capturing:
    """Returns a scripted sequence and records each create() kwargs."""

    def __init__(self, responses):
        self.calls = []
        self._responses = list(responses)
        outer = self

        class _Messages:
            def create(self, **kwargs):
                outer.calls.append(kwargs)
                return outer._responses.pop(0)

        self.messages = _Messages()


def _run(client, **kw):
    return run_agent(
        client=client, model="m", system="s", initial_user="go",
        registry=ToolRegistry([]), **kw
    )


def test_coverage_gate_nudges_then_accepts():
    # Ledger stays empty (the fake never calls note_attempt); min 2 attempts, up to 2 nudges.
    result = _run(_AlwaysEnd(), ledger=AttemptLedger(), min_attempts=2, max_nudges=2)
    assert result.steps == 3  # nudged at steps 1 and 2, accepted the finish at step 3


def test_coverage_gate_accepts_when_enough_attempts():
    ledger = AttemptLedger()
    ledger.add("h1", "401")
    ledger.add("h2", "403")
    result = _run(_AlwaysEnd(), ledger=ledger, min_attempts=2)
    assert result.steps == 1  # baseline covered → finishes immediately, no nudge


def test_no_gate_without_min_attempts():
    # Backward-compatible: min_attempts defaults to 0, so the model finishes when it says so.
    result = _run(_AlwaysEnd())
    assert result.steps == 1


def test_api_error_returns_partial_not_crash():
    class _Boom:
        class _Messages:
            def create(self, **kwargs):
                raise RuntimeError("529 overloaded")

        messages = _Messages()

    result = _run(_Boom())
    assert result.error is not None
    assert result.partial is True
    assert result.steps == 1  # didn't raise; returned a partial run


def test_create_retries_then_succeeds():
    class _Flaky:
        calls = 0

        class _Messages:
            def create(self, **kwargs):
                _Flaky.calls += 1
                if _Flaky.calls < 3:
                    raise RuntimeError("transient blip")
                return _end()

        messages = _Messages()

    result = _run(_Flaky())
    assert result.error is None
    assert result.steps == 1
    assert _Flaky.calls == 3  # failed twice, recovered on the third attempt within one step


def test_max_tokens_is_continued_not_treated_as_done():
    client = _Capturing([_truncated("half a thought"), _end("the full conclusion")])
    result = _run(client)
    assert result.steps == 2  # truncation didn't end the run
    assert result.final_text == "the full conclusion"


def test_max_tokens_strips_partial_tool_use_before_continuing():
    client = _Capturing([_truncated("cut", tool_use=True), _end("done")])
    result = _run(client)
    assert result.steps == 2
    # The 2nd call's history must not carry a dangling tool_use (no matching tool_result).
    second_msgs = client.calls[1]["messages"]
    assert not any(
        isinstance(m["content"], list)
        and any(isinstance(b, dict) and b.get("type") == "tool_use" for b in m["content"])
        for m in second_msgs
    )


def _tool_use(usage=10):
    return SimpleNamespace(
        content=[SimpleNamespace(type="tool_use", id="t", name="noop", input={})],
        stop_reason="tool_use",
        usage=SimpleNamespace(input_tokens=usage, output_tokens=0),
    )


def test_soft_budget_injects_wrapup_before_hard_cap():
    reg = ToolRegistry([Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")])
    # Step 1 burns 60 tokens; soft limit = 0.5 * 100 = 50, so a wrap-up rides the tool results.
    client = _Capturing([_tool_use(usage=60), _end("summary")])
    result = run_agent(
        client=client, model="m", system="s", initial_user="go", registry=reg,
        budget=Budget(max_total_tokens=100, soft_fraction=0.5),
    )
    second_msgs = client.calls[1]["messages"]
    assert any(
        isinstance(m["content"], list)
        and any(
            isinstance(b, dict) and b.get("type") == "text" and "final" in b["text"].lower()
            for b in m["content"]
        )
        for m in second_msgs
    )
    assert result.final_text == "summary"  # concluded cleanly, not on the hard cap
