"""Unit tests for LLMService parsing/branching with a mocked Anthropic client.

These don't hit the network — they assert that we correctly turn the forced
tool_use response into a GenerationResult for both the execute and no-execute paths.
"""
from types import SimpleNamespace

import pytest

from app.llm import LLMService


def _tool_use_response(payload: dict):
    """Build a fake Anthropic Message with a single emit_decision tool_use block."""
    block = SimpleNamespace(type="tool_use", name="emit_decision", input=payload)
    return SimpleNamespace(content=[block])


def _service_with_response(payload: dict) -> LLMService:
    svc = LLMService.__new__(LLMService)  # bypass __init__ (no real client/key)
    svc._model = "test-model"
    svc._client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kwargs: _tool_use_response(payload))
    )
    return svc


def test_generate_should_execute_path():
    svc = _service_with_response(
        {"should_execute": True, "language": "python", "code": "print('hi')"}
    )
    result = svc.generate("print hello")
    assert result.should_execute is True
    assert result.language == "python"
    assert result.code == "print('hi')"
    assert result.message is None


def test_generate_no_code_path():
    svc = _service_with_response(
        {"should_execute": False, "message": "That's not a coding task."}
    )
    result = svc.generate("tell me a joke")
    assert result.should_execute is False
    assert result.code is None
    assert result.message == "That's not a coding task."


def test_generate_raises_without_tool_block():
    svc = LLMService.__new__(LLMService)
    svc._model = "test-model"
    svc._client = SimpleNamespace(
        messages=SimpleNamespace(
            create=lambda **kwargs: SimpleNamespace(
                content=[SimpleNamespace(type="text", name=None, input=None)]
            )
        )
    )
    with pytest.raises(ValueError):
        svc.generate("anything")
