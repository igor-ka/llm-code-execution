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

_WRAP_UP = (
    "You are approaching the run's budget limit. Stop testing new hypotheses now — "
    "write your final findings summary and conclude."
)


class LLMClient(Protocol):
    """Minimal surface we need from `anthropic.Anthropic` (and from the test fake)."""

    @property
    def messages(self) -> Any: ...


@dataclass
class Budget:
    max_steps: int = 30
    max_total_tokens: int = 250_000  # cumulative billed tokens (input+output) across turns
    max_response_tokens: int = 8192  # per-call output cap (roomy enough for a closing summary)
    max_history_pairs: int = 8  # sliding window: keep the last N (assistant, tool-result) pairs
    soft_fraction: float = 0.8  # at this fraction of the token budget, tell the agent to wrap up


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
    error: str | None = None  # set if the run ended on an unrecoverable API error (partial)

    @property
    def partial(self) -> bool:
        return self.stopped_on_budget or self.error is not None

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


def _cached_tools(schemas: List[dict]) -> List[dict]:
    """Mark the (stable) tool list as cacheable so its tokens aren't re-billed each turn.

    Caching kicks in only above the model's minimum cached-prefix size; below that it's a
    harmless no-op. The breakpoint goes on the last tool so system + tools form one prefix.
    """
    if not schemas:
        return schemas
    out = [dict(s) for s in schemas]
    out[-1] = {**out[-1], "cache_control": {"type": "ephemeral"}}
    return out


def _system_blocks(system: str, ledger: Any) -> List[dict]:
    """Stable system prompt (cached) + a dynamic ledger block (refreshed each turn, not cached).

    Splitting them keeps the big stable prefix cacheable while the ever-changing ledger rides
    after the cache breakpoint."""
    blocks = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
    if ledger is not None and ledger.render():
        blocks.append({"type": "text", "text": ledger.render()})
    return blocks


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


def _create_with_retry(client: LLMClient, attempts: int = 3, **kwargs):
    """Call messages.create, retrying on error. The Anthropic SDK already backs off on
    429/5xx; this adds a last line of defense so a transient failure doesn't lose the run."""
    last_exc = None
    for i in range(1, attempts + 1):
        try:
            return client.messages.create(**kwargs)
        except Exception as exc:  # noqa: BLE001 — surface as a partial run, never crash
            last_exc = exc
            logger.warning("messages.create failed (%d/%d): %s", i, attempts, exc)
    raise last_exc


def _coverage_nudge(ledger: Any, min_attempts: int) -> str | None:
    """If the agent tries to finish before logging enough baseline attempts, return a nudge
    message to keep it going; else None. Uses attempt COUNT (a robust proxy) rather than
    fragile text-matching of which specific hypotheses were covered."""
    done = len(ledger.attempts) if ledger is not None else 0
    if done >= min_attempts:
        return None
    return (
        f"You're stopping after logging only {done} of at least {min_attempts} baseline "
        f"hypotheses via note_attempt. Do not finish yet: test the remaining seeded "
        f"hypotheses (noting each outcome), then derive and test your own before concluding."
    )


def run_agent(
    *,
    client: LLMClient,
    model: str,
    system: str,
    initial_user: str,
    registry: ToolRegistry,
    budget: Budget | None = None,
    ledger: Any = None,
    min_attempts: int = 0,
    max_nudges: int = 2,
) -> RunResult:
    budget = budget or Budget()
    messages: List[dict] = [{"role": "user", "content": initial_user}]
    tools = _cached_tools(registry.schemas())
    tokens_used = 0
    nudges_used = 0
    wrapping_up = False
    soft_limit = int(budget.soft_fraction * budget.max_total_tokens)
    transcript: List[StepLog] = []

    for step in range(1, budget.max_steps + 1):
        messages = trim_history(messages, budget.max_history_pairs)
        try:
            resp = _create_with_retry(
                client,
                model=model,
                max_tokens=budget.max_response_tokens,
                system=_system_blocks(system, ledger),  # cached base + live ledger
                messages=messages,
                tools=tools,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("aborting after repeated API failures: %s", exc)
            return RunResult(
                "(stopped: API error)", step, tokens_used, False, transcript, error=str(exc)
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
                        {"name": block.name, "input": _clip(block.input), "result": _clip(result)}
                    )
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": result}
                    )
            if not wrapping_up and tokens_used >= soft_limit:
                # Graceful landing: ride a wrap-up instruction in with the tool results (can't
                # send two consecutive user messages) so the agent concludes before the hard cap.
                wrapping_up = True
                tool_results.append({"type": "text", "text": _WRAP_UP})
                logger.info("soft budget reached (%d) — asking the agent to wrap up", soft_limit)
            messages.append({"role": "user", "content": tool_results})

        transcript.append(StepLog(step, step_calls, tokens_used, resp.stop_reason))
        logger.info(
            "step %d: %s | tokens≈%d | %s",
            step,
            ", ".join(c["name"] for c in step_calls) or "(no tools)",
            tokens_used,
            resp.stop_reason,
        )

        if resp.stop_reason == "max_tokens":
            # Response was truncated by the per-call output cap, NOT finished. Drop any partial
            # tool_use (it would dangle without a tool_result) and ask the agent to continue.
            messages[-1]["content"] = [
                b for b in messages[-1]["content"] if b.get("type") == "text"
            ] or [{"type": "text", "text": "(continuing)"}]
            messages.append(
                {
                    "role": "user",
                    "content": "Your previous response was cut off before you finished. "
                    "Continue from where you left off.",
                }
            )
            logger.info("response truncated (max_tokens) — asking the agent to continue")
        elif resp.stop_reason != "tool_use":
            nudge = _coverage_nudge(ledger, min_attempts) if nudges_used < max_nudges else None
            if nudge is not None:
                nudges_used += 1
                logger.info("coverage nudge %d: agent tried to finish early", nudges_used)
                messages.append({"role": "user", "content": nudge})
                continue
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
