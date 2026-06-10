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

_WRAP_UP_NOVELTY = (
    "You have worked the full baseline and your recent attempts are no longer surfacing "
    "anything new. Stop here — write your final findings summary and conclude."
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
class StoppingPolicy:
    """When may the run end? The two-sided stop the session settled on: a coverage FLOOR (don't
    quit before the baseline seeds are covered) and a novelty CEILING (wind down once returns
    dry up). The token/step soft-limits live on Budget; these are the content-aware knobs."""

    required_seeds: set[str] = field(default_factory=set)  # the coverage floor (by seed identity)
    novelty_patience: int = 0  # consecutive no-progress steps before an early stop; 0 disables it
    max_nudges: int = 2  # how many times the floor may nudge a premature finish


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


def _usage_tokens(resp: Any) -> int:
    """Billed tokens (input+output) for one response, tolerant of a missing usage object."""
    usage = getattr(resp, "usage", None)
    if usage is None:
        return 0
    return getattr(usage, "input_tokens", 0) + getattr(usage, "output_tokens", 0)


def _dispatch_tools(registry: ToolRegistry, content: Any) -> tuple[List[dict], List[dict]]:
    """Run every tool_use block in an assistant turn. Returns (step_calls, tool_results):
    the first is summarized for the transcript, the second is the API-shaped reply."""
    step_calls, tool_results = [], []
    for block in content:
        if block.type == "tool_use":
            result = registry.dispatch(block.name, dict(block.input))
            step_calls.append(
                {"name": block.name, "input": _clip(block.input), "result": _clip(result)}
            )
            tool_results.append(
                {"type": "tool_result", "tool_use_id": block.id, "content": result}
            )
    return step_calls, tool_results


def _queue_continuation(messages: List[dict]) -> None:
    """Handle a response truncated by the per-call output cap (max_tokens) — NOT a finish.
    Drop any partial tool_use (it would dangle without a tool_result) and ask to continue."""
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


class _StopController:
    """Owns both sides of "when does the run stop?" — the two-sided stop the session settled on:

    - FLOOR (premature-exit guard): on an attempted finish, `nudge()` returns a message naming
      the still-uncovered required seeds (up to `policy.max_nudges` times), else None to accept.
      Coverage is by seed IDENTITY, not attempt count (a count gate is satisfied by duplicate
      attempts while real seeds slip through).
    - CEILING (graceful landing): after a tool step, `wrap_up()` returns a wind-down message
      when any external stopping rule fires first — token soft-limit, step soft-limit (catches
      cheap-but-chatty step-bound runs that would otherwise die on a partial at the step cap),
      or diminishing returns (baseline covered + `policy.novelty_patience` steps with nothing
      new). All three are *measurable* rules, not the model's self-judgment.

    Once a wrap-up fires, `landing` latches True and the floor stands down — wrap-up wins over
    the gate, so the two never fight and thrash the run to the hard cap."""

    def __init__(self, budget: Budget, policy: StoppingPolicy, *, ledger: Any, findings: Any):
        self._budget = budget
        self._policy = policy
        self._ledger = ledger
        self._findings = findings
        self._soft_tokens = int(budget.soft_fraction * budget.max_total_tokens)
        self._soft_step = int(budget.soft_fraction * budget.max_steps)
        self._covered_seen = self._covered_count()
        self._findings_seen = self._finding_count()
        self._stalled_steps = 0
        self._nudges_used = 0
        self.landing = False

    def _covered_count(self) -> int:
        return len(self._ledger.covered_seeds) if self._ledger is not None else 0

    def _finding_count(self) -> int:
        return len(self._findings.findings) if self._findings is not None else 0

    def _floor_met(self, covered: set | None = None) -> bool:
        if self._ledger is None:
            return True
        covered = self._ledger.covered_seeds if covered is None else covered
        return self._policy.required_seeds <= covered

    def _diminishing(self) -> bool:
        """Advance the novelty counter for this tool step; report whether returns have dried up.
        Gated on the floor, so it can never short-circuit baseline coverage."""
        if self._policy.novelty_patience <= 0:
            return False
        covered_set = self._ledger.covered_seeds if self._ledger is not None else set()
        covered, found = len(covered_set), self._finding_count()
        progressed = covered > self._covered_seen or found > self._findings_seen
        self._covered_seen, self._findings_seen = covered, found
        self._stalled_steps = 0 if progressed else self._stalled_steps + 1
        return self._floor_met(covered_set) and self._stalled_steps >= self._policy.novelty_patience

    def wrap_up(self, step: int, tokens_used: int) -> str | None:
        """Call once per tool step. Returns the wind-down instruction to ride in with the tool
        results (a clean graceful landing before the hard cap), or None to keep going."""
        diminishing = self._diminishing()  # always advance the counter, even once landing
        if self.landing or not (
            tokens_used >= self._soft_tokens or step >= self._soft_step or diminishing
        ):
            return None
        self.landing = True
        trigger = "novelty" if diminishing else "step" if step >= self._soft_step else "token"
        logger.info(
            "wrap-up triggered (%s: step %d/%d, tokens %d/%d) — asking the agent to conclude",
            trigger, step, self._budget.max_steps, tokens_used, self._budget.max_total_tokens,
        )
        return _WRAP_UP_NOVELTY if diminishing else _WRAP_UP

    def nudge(self) -> str | None:
        """Call when the agent tries to finish. Returns a coverage nudge naming the missing
        seeds, or None to accept the finish. Stands down once we're landing."""
        if self.landing or self._nudges_used >= self._policy.max_nudges:
            return None
        if self._ledger is None or not self._policy.required_seeds:
            return None
        missing = self._ledger.uncovered(self._policy.required_seeds)
        if not missing:
            return None
        self._nudges_used += 1
        logger.info("coverage nudge %d: agent tried to finish early", self._nudges_used)
        return (
            f"You're trying to finish, but {len(missing)} baseline hypotheses are still "
            f"uncovered: {', '.join(sorted(missing))}. Do not conclude yet — test each "
            f"remaining seed and tag its note_attempt with the matching seed_id, then derive "
            f"and test your own before concluding."
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
    findings: Any = None,
    policy: StoppingPolicy | None = None,
) -> RunResult:
    budget = budget or Budget()
    policy = policy or StoppingPolicy()
    messages: List[dict] = [{"role": "user", "content": initial_user}]
    tools = _cached_tools(registry.schemas())
    stop = _StopController(budget, policy, ledger=ledger, findings=findings)
    tokens_used = 0
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

        tokens_used += _usage_tokens(resp)
        messages.append({"role": "assistant", "content": _blocks_to_dicts(resp.content)})

        step_calls: List[dict] = []
        if resp.stop_reason == "tool_use":
            step_calls, tool_results = _dispatch_tools(registry, resp.content)
            wrap_up = stop.wrap_up(step, tokens_used)
            if wrap_up:
                # Ride the wrap-up in with the tool results — can't send two user messages.
                tool_results.append({"type": "text", "text": wrap_up})
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
            _queue_continuation(messages)
        elif resp.stop_reason != "tool_use":
            nudge = stop.nudge()  # floor guards premature exit; stands down once landing
            if nudge is not None:
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
