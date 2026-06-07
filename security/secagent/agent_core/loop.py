"""The explicit ReAct loop, written by hand on the Anthropic Messages tool-use API.

This is deliberately *not* delegated to a framework's built-in loop: making the loop
visible — turn accounting, tool dispatch, the step/token budget caps, and a sliding-window
over history (the thing that otherwise makes cost grow unbounded) — is the point of the
project. Swapping in `claude_agent_sdk` later would be localized to this module.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, List, Protocol

from .tools import ToolRegistry

logger = logging.getLogger("secagent.loop")


class LLMClient(Protocol):
    """Minimal surface we need from `anthropic.Anthropic` (and from the test fake)."""

    @property
    def messages(self) -> Any: ...


@dataclass
class Budget:
    max_steps: int = 30
    max_total_tokens: int = 250_000  # cumulative billed tokens (input+output) across turns
    max_response_tokens: int = 4096  # per-call output cap
    max_history_pairs: int = 8  # sliding window: keep the last N (assistant, tool-result) pairs


@dataclass
class StepLog:
    step: int
    tool_calls: List[dict]  # [{name, input, result}], summarized
    cumulative_tokens: int
    stop_reason: str


@dataclass
class RunResult:
    final_text: str
    steps: int
    tokens_used: int
    stopped_on_budget: bool
    transcript: List[StepLog] = field(default_factory=list)

    def transcript_dicts(self) -> List[dict]:
        return [asdict(s) for s in self.transcript]


def _clip(text: str, limit: int = 200) -> str:
    text = str(text)
    return text if len(text) <= limit else text[:limit] + " …"


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


def trim_history(messages: List[dict], max_pairs: int) -> List[dict]:
    """Sliding window: always keep the initial user message, then the last `max_pairs`
    (assistant, tool-result) pairs. Pairs are kept intact so tool_use/tool_result stay
    matched (the API requires it)."""
    if max_pairs <= 0 or len(messages) <= 1:
        return messages
    head, rest = messages[:1], messages[1:]
    if len(rest) > 2 * max_pairs:
        rest = rest[-2 * max_pairs:]
    return head + rest


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
    transcript: List[StepLog] = []

    for step in range(1, budget.max_steps + 1):
        messages = trim_history(messages, budget.max_history_pairs)
        resp = client.messages.create(
            model=model,
            max_tokens=budget.max_response_tokens,
            system=system,
            messages=messages,
            tools=tools,
        )
        usage = getattr(resp, "usage", None)
        if usage is not None:
            tokens_used += getattr(usage, "input_tokens", 0) + getattr(usage, "output_tokens", 0)

        messages.append({"role": "assistant", "content": _blocks_to_dicts(resp.content)})

        step_calls: List[dict] = []
        if resp.stop_reason == "tool_use":
            tool_results = []
            for block in resp.content:
                if block.type == "tool_use":
                    result = registry.dispatch(block.name, dict(block.input))
                    step_calls.append(
                        {
                            "name": block.name,
                            "input": _clip(block.input),
                            "result": _clip(result),
                        }
                    )
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": result}
                    )
            messages.append({"role": "user", "content": tool_results})

        transcript.append(StepLog(step, step_calls, tokens_used, resp.stop_reason))
        logger.info(
            "step %d: %s | tokens≈%d | %s",
            step,
            ", ".join(c["name"] for c in step_calls) or "(no tools)",
            tokens_used,
            resp.stop_reason,
        )

        if resp.stop_reason != "tool_use":
            final_text = "".join(b.text for b in resp.content if b.type == "text")
            return RunResult(final_text, step, tokens_used, False, transcript)

        if tokens_used >= budget.max_total_tokens:
            logger.warning("stopping: token budget %d reached", budget.max_total_tokens)
            return RunResult(
                "(stopped: token budget exhausted)", step, tokens_used, True, transcript
            )

    logger.warning("stopping: step budget %d reached", budget.max_steps)
    return RunResult(
        "(stopped: step budget exhausted)", budget.max_steps, tokens_used, True, transcript
    )
