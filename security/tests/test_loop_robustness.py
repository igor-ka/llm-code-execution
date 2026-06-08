"""Anti-premature-exit: coverage-gated termination + retry/partial-report on API errors."""
from types import SimpleNamespace

from secagent.agent_core.loop import run_agent
from secagent.agent_core.report import AttemptLedger
from secagent.agent_core.tools import ToolRegistry


def _end(text="done"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )


class _AlwaysEnd:
    """A model that always tries to finish immediately."""

    class _Messages:
        def create(self, **kwargs):
            return _end()

    messages = _Messages()


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
