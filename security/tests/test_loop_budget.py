"""Context controls: the sliding window, prompt-cache markers, and the ledger (durable memory)."""
from types import SimpleNamespace

from secagent.agent_core.loop import _cached_tools, _system_blocks, run_agent, trim_history
from secagent.agent_core.report import AttemptLedger
from secagent.agent_core.tools import Tool, ToolRegistry


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


# --- prompt-cache markers -------------------------------------------------------------

def test_cached_tools_marks_only_last():
    out = _cached_tools([{"name": "a"}, {"name": "b"}])
    assert "cache_control" not in out[0]
    assert out[-1]["cache_control"] == {"type": "ephemeral"}


def test_system_blocks_cache_base_and_append_ledger():
    assert _system_blocks("BASE", None) == [
        {"type": "text", "text": "BASE", "cache_control": {"type": "ephemeral"}}
    ]
    ledger = AttemptLedger()
    ledger.add("no token", "401")
    blocks = _system_blocks("BASE", ledger)
    assert blocks[0]["cache_control"] == {"type": "ephemeral"}  # base stays cacheable
    assert "no token" in blocks[1]["text"] and "cache_control" not in blocks[1]  # ledger is live


# --- ledger as durable memory ---------------------------------------------------------

def test_attempt_ledger_render():
    ledger = AttemptLedger()
    assert ledger.render() == ""
    ledger.add("expired token", "rejected 401")
    text = ledger.render()
    assert "expired token" in text and "rejected 401" in text


def _resp(blocks, stop):
    return SimpleNamespace(
        content=blocks, stop_reason=stop, usage=SimpleNamespace(input_tokens=1, output_tokens=1)
    )


class _CapturingClient:
    def __init__(self, script):
        script = list(script)
        self.calls = []
        outer = self

        class _Messages:
            def create(self, **kwargs):
                outer.calls.append(kwargs)
                return script.pop(0)

        self.messages = _Messages()


def test_loop_passes_cached_system_tools_and_ledger():
    ledger = AttemptLedger()
    ledger.add("no token", "401")
    registry = ToolRegistry(
        [Tool("noop", "", {"type": "object", "properties": {}}, lambda: "ok")]
    )
    client = _CapturingClient([_resp([SimpleNamespace(type="text", text="done")], "end_turn")])

    run_agent(
        client=client,
        model="m",
        system="BASE",
        initial_user="go",
        registry=registry,
        ledger=ledger,
    )

    kw = client.calls[0]
    assert kw["system"][0] == {"type": "text", "text": "BASE", "cache_control": {"type": "ephemeral"}}
    assert any("no token" in b["text"] for b in kw["system"][1:])
    assert kw["tools"][-1]["cache_control"] == {"type": "ephemeral"}
