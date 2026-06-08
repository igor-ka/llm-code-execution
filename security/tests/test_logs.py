"""read_backend_logs — read-only tail of the target's logs (white-box observability)."""
from secagent.agent_core.report import FindingStore
from secagent.agent_core.tools import LogTail, LoopbackHTTP, ToolRegistry, make_generic_tools


def test_tail_returns_last_n_lines(tmp_path):
    log = tmp_path / "backend.log"
    log.write_text("\n".join(f"line{i}" for i in range(10)))
    assert LogTail(str(log)).tail(3) == "line7\nline8\nline9"


def test_tail_handles_missing_file(tmp_path):
    out = LogTail(str(tmp_path / "nope.log")).tail()
    assert "no log file" in out


def test_tail_handles_empty_file(tmp_path):
    (tmp_path / "empty.log").write_text("")
    assert LogTail(str(tmp_path / "empty.log")).tail() == "(log is empty)"


def _registry(logs=None):
    http = LoopbackHTTP("http://127.0.0.1")
    return ToolRegistry(make_generic_tools(http, FindingStore(), logs=logs))


def test_tool_absent_without_logs():
    names = [t["name"] for t in _registry().schemas()]
    assert "read_backend_logs" not in names


def test_tool_present_and_dispatches_with_logs(tmp_path):
    log = tmp_path / "backend.log"
    log.write_text("INFO boot\nERROR Traceback: boom")
    registry = _registry(LogTail(str(log)))
    names = [t["name"] for t in registry.schemas()]
    assert "read_backend_logs" in names
    out = registry.dispatch("read_backend_logs", {"lines": 1})
    assert "boom" in out and "boot" not in out
