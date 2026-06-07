"""The sliding-window over history — the knob that keeps cost from growing unbounded."""
from secagent.agent_core.loop import trim_history


def _conversation(pairs: int) -> list[dict]:
    msgs = [{"role": "user", "content": "init"}]
    for i in range(pairs):
        msgs.append({"role": "assistant", "content": f"a{i}"})
        msgs.append({"role": "user", "content": f"r{i}"})
    return msgs


def test_keeps_initial_and_last_pairs():
    trimmed = trim_history(_conversation(5), max_pairs=2)
    assert trimmed[0]["content"] == "init"  # initial user message always kept
    assert len(trimmed) == 1 + 2 * 2  # init + 2 pairs
    assert trimmed[1]["role"] == "assistant"  # window starts on an assistant (pairing intact)
    assert trimmed[-1]["content"] == "r4"  # most recent pair retained


def test_noop_when_within_window():
    msgs = _conversation(2)
    assert trim_history(msgs, max_pairs=8) == msgs


def test_disabled_when_max_pairs_zero():
    msgs = _conversation(5)
    assert trim_history(msgs, max_pairs=0) == msgs
