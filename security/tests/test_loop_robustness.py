"""Anti-premature-exit: coverage-gated termination + retry/partial-report on API errors."""
from types import SimpleNamespace

from secagent.agent_core.loop import Budget, StoppingPolicy, run_agent
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


def _injected_user_text(client) -> list:
    """All text blocks the loop rode in on USER messages (wrap-ups), across every create call.
    Restricted to user messages so the model's own assistant text blocks aren't counted."""
    return [
        b["text"]
        for call in client.calls
        for m in call["messages"]
        if m["role"] == "user" and isinstance(m["content"], list)
        for b in m["content"]
        if isinstance(b, dict) and b.get("type") == "text"
    ]


def _run(client, **kw):
    return run_agent(
        client=client, model="m", system="s", initial_user="go",
        registry=ToolRegistry([]), **kw
    )


def test_coverage_gate_nudges_then_accepts():
    # Ledger stays empty (the fake never tags a seed); two seeds required, up to 2 nudges.
    result = _run(_AlwaysEnd(), ledger=AttemptLedger(),
                  policy=StoppingPolicy(required_seeds={"a", "b"}, max_nudges=2))
    assert result.steps == 3  # nudged at steps 1 and 2, accepted the finish at step 3


def test_coverage_gate_accepts_when_seeds_covered():
    ledger = AttemptLedger()
    ledger.add("h1", "401", seed_id="a")
    ledger.add("h2", "403", seed_id="b")
    result = _run(_AlwaysEnd(), ledger=ledger, policy=StoppingPolicy(required_seeds={"a", "b"}))
    assert result.steps == 1  # every required seed covered → finishes immediately, no nudge


def test_coverage_gate_names_the_uncovered_seeds():
    # Identity gate, not a count gate: covering "alg_none" twice does not satisfy the
    # requirement for "expired" — and the nudge names the specific seed still missing.
    ledger = AttemptLedger()
    ledger.add("first", "401", seed_id="alg_none")
    ledger.add("dup", "401", seed_id="alg_none")  # a dup inflates COUNT but covers nothing new
    client = _Capturing([_end(), _end()])  # tries to finish; nudged once, then accepted
    result = run_agent(
        client=client, model="m", system="s", initial_user="go", registry=ToolRegistry([]),
        ledger=ledger, policy=StoppingPolicy(required_seeds={"alg_none", "expired"}, max_nudges=1),
    )
    assert result.steps == 2
    nudge_text = next(
        m["content"] for m in client.calls[-1]["messages"]
        if m["role"] == "user" and isinstance(m["content"], str) and "uncovered" in m["content"]
    )
    assert "expired" in nudge_text and "alg_none" not in nudge_text  # names the missing one only


def test_no_gate_without_required_seeds():
    # Default StoppingPolicy has empty required_seeds (no floor), so the model finishes at will.
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


def test_soft_budget_step_bound_injects_wrapup():
    # A cheap-but-chatty run: tokens stay far below the token soft-limit, so only the STEP
    # threshold can trigger the wrap-up. soft_step = int(0.5 * 2) = 1, so step 1 rides a wrap-up.
    reg = ToolRegistry([Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")])
    client = _Capturing([_tool_use(usage=1), _end("summary")])
    result = run_agent(
        client=client, model="m", system="s", initial_user="go", registry=reg,
        budget=Budget(max_steps=2, soft_fraction=0.5, max_total_tokens=10_000_000),
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
    assert result.final_text == "summary"  # step-bound run still concluded cleanly
    assert result.stopped_on_budget is False


def test_wrapup_overrides_coverage_gate():
    # The conflict: soft budget triggers wrap-up, the agent concludes (end_turn), but the
    # ledger is short of the required seeds. The coverage gate must NOT nudge it back — wrap-up
    # wins, so the run lands cleanly instead of thrashing to the hard cap.
    reg = ToolRegistry([Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")])
    client = _Capturing([_tool_use(usage=1), _end("summary")])  # step 1 tool, step 2 concludes
    result = run_agent(
        client=client, model="m", system="s", initial_user="go", registry=reg,
        budget=Budget(max_steps=2, soft_fraction=0.5, max_total_tokens=10_000_000),
        ledger=AttemptLedger(),  # none covered
        policy=StoppingPolicy(required_seeds={"a", "b", "c"}, max_nudges=2),
    )
    assert result.final_text == "summary"  # accepted the conclusion despite short coverage
    assert result.steps == 2
    assert result.stopped_on_budget is False  # landed cleanly, not nudged into the step cap


def test_novelty_stop_wraps_up_once_floor_met_and_progress_stalls():
    # Diminishing returns: the baseline floor is already met (seed "a" covered), and the model
    # keeps making tool calls that surface nothing new. After novelty_patience unproductive
    # steps the loop rides in a wrap-up, and the run lands cleanly — NOT on the budget cap.
    reg = ToolRegistry([Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")])
    ledger = AttemptLedger()
    ledger.add("baseline", "401", seed_id="a")  # floor for required_seeds={"a"} already met
    client = _Capturing([_tool_use(usage=1), _tool_use(usage=1), _end("summary")])
    result = run_agent(
        client=client, model="m", system="s", initial_user="go", registry=reg,
        budget=Budget(max_steps=10, max_total_tokens=10_000_000),  # budget nowhere near binding
        ledger=ledger, policy=StoppingPolicy(required_seeds={"a"}, novelty_patience=2),
    )
    assert result.final_text == "summary"
    assert result.stopped_on_budget is False  # productive early stop, not a budget landing
    # a wrap-up instruction must have ridden in on some user message (patience exhausted).
    assert any("new" in t.lower() for t in _injected_user_text(client))


def test_novelty_stop_never_fires_before_the_floor_is_met():
    # Guard: diminishing returns must NEVER short-circuit the baseline. With an uncovered seed,
    # no amount of unproductive steps should trigger the novelty wrap-up.
    reg = ToolRegistry([Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")])
    client = _Capturing([_tool_use(usage=1), _tool_use(usage=1), _tool_use(usage=1), _end("x")])
    run_agent(
        client=client, model="m", system="s", initial_user="go", registry=reg,
        budget=Budget(max_steps=10, max_total_tokens=10_000_000),
        ledger=AttemptLedger(),  # "a" never covered
        # max_nudges=0: don't nudge on the final end_turn — keep the scripted run finite
        policy=StoppingPolicy(required_seeds={"a"}, novelty_patience=1, max_nudges=0),
    )
    assert _injected_user_text(client) == []  # floor never met → no wrap-up ever injected
