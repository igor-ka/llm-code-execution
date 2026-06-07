"""The ReAct loop wiring, driven by a scripted fake LLM (no tokens spent).

The script only exercises plumbing — tool dispatch, message threading, budget caps, and the
report sink. It is not a statement about what the agent *should* conclude.
"""
from types import SimpleNamespace

from secagent.agent_core.loop import Budget, run_agent


def _text(t):
    return SimpleNamespace(type="text", text=t)


def _tool(tid, name, inp):
    return SimpleNamespace(type="tool_use", id=tid, name=name, input=inp)


def _resp(blocks, stop):
    return SimpleNamespace(
        content=blocks, stop_reason=stop, usage=SimpleNamespace(input_tokens=10, output_tokens=5)
    )


class _FakeClient:
    def __init__(self, script):
        script = list(script)

        class _Messages:
            def create(self, **kwargs):
                return script.pop(0)

        self.messages = _Messages()


def test_loop_dispatches_tools_and_records(registry, findings):
    finding = {
        "severity": "high",
        "title": "Demo finding",
        "hypothesis": "h",
        "repro": "r",
        "evidence": "e",
        "recommendation": "fix it",
    }
    script = [
        _resp([_tool("t1", "call_execute", {})], "tool_use"),
        _resp([_tool("t2", "record_finding", finding)], "tool_use"),
        _resp([_text("done")], "end_turn"),
    ]
    result = run_agent(
        client=_FakeClient(script),
        model="fake",
        system="s",
        initial_user="go",
        registry=registry,
    )
    assert result.final_text == "done"
    assert result.steps == 3
    assert result.tokens_used == 45  # (10+5) per turn * 3 turns
    assert not result.stopped_on_budget
    assert len(findings.findings) == 1
    assert "Demo finding" in findings.to_markdown(target="local")
    # The transcript is the audit trail of what the agent actually did.
    assert [s.step for s in result.transcript] == [1, 2, 3]
    assert result.transcript[0].tool_calls[0]["name"] == "call_execute"
    assert result.transcript[1].tool_calls[0]["name"] == "record_finding"
    assert result.transcript[2].tool_calls == [] and result.transcript[2].stop_reason == "end_turn"


def test_step_budget_stops_the_loop(registry):
    script = [_resp([_tool("t1", "call_execute", {})], "tool_use")]
    result = run_agent(
        client=_FakeClient(script),
        model="fake",
        system="s",
        initial_user="go",
        registry=registry,
        budget=Budget(max_steps=1),
    )
    assert result.stopped_on_budget
    assert result.steps == 1
