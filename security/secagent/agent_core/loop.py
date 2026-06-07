"""The explicit ReAct loop, written by hand on the Anthropic Messages tool-use API.

This is deliberately *not* delegated to a framework's built-in loop: making the loop
visible — turn accounting, tool dispatch, and the step/token budget caps — is the point of
the project. Swapping in `claude_agent_sdk` later would be localized to this module.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Protocol

from .tools import ToolRegistry


class LLMClient(Protocol):
    """Minimal surface we need from `anthropic.Anthropic` (and from the test fake)."""

    @property
    def messages(self) -> Any: ...


@dataclass
class Budget:
    max_steps: int = 24
    max_tokens: int = 120_000


@dataclass
class RunResult:
    final_text: str
    steps: int
    tokens_used: int
    stopped_on_budget: bool


def _blocks_to_dicts(content: Any) -> List[dict]:
    """Normalize an assistant message's content blocks to dicts for re-submission."""
    out: List[dict] = []
    for block in content:
        if block.type == "text":
            out.append({"type": "text", "text": block.text})
        elif block.type == "tool_use":
            out.append(
                {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
            )
    return out


def run_agent(
    *,
    client: LLMClient,
    model: str,
    system: str,
    initial_user: str,
    registry: ToolRegistry,
    budget: Budget | None = None,
) -> RunResult:
    budget = budget or Budget()
    messages: List[dict] = [{"role": "user", "content": initial_user}]
    tools = registry.schemas()
    tokens_used = 0
    final_text = ""

    for step in range(1, budget.max_steps + 1):
        resp = client.messages.create(
            model=model,
            max_tokens=4096,
            system=system,
            messages=messages,
            tools=tools,
        )
        usage = getattr(resp, "usage", None)
        if usage is not None:
            tokens_used += getattr(usage, "input_tokens", 0) + getattr(usage, "output_tokens", 0)

        messages.append({"role": "assistant", "content": _blocks_to_dicts(resp.content)})

        if resp.stop_reason == "tool_use":
            tool_results = []
            for block in resp.content:
                if block.type == "tool_use":
                    result = registry.dispatch(block.name, dict(block.input))
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result,
                        }
                    )
            messages.append({"role": "user", "content": tool_results})
        else:
            final_text = "".join(b.text for b in resp.content if b.type == "text")
            return RunResult(final_text, step, tokens_used, stopped_on_budget=False)

        if tokens_used >= budget.max_tokens:
            return RunResult(
                final_text="(stopped: token budget exhausted)",
                steps=step,
                tokens_used=tokens_used,
                stopped_on_budget=True,
            )

    return RunResult(
        final_text="(stopped: step budget exhausted)",
        steps=budget.max_steps,
        tokens_used=tokens_used,
        stopped_on_budget=True,
    )
