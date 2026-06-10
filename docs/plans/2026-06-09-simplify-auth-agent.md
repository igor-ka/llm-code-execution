# Simplify the Auth-Bypass Agent Implementation Plan

**Goal:** Consolidate the session's learnings into the settled design and simplify the agent's
implementation across all its files — without changing behavior or weakening the security posture.

**Architecture:** The agent stays a hand-rolled ReAct loop on the Anthropic Messages tool-use
API (the learning goal — *not* `claude_agent_sdk`). The session proved the design is sound:
this is open-ended red-teaming, so a budget-driven graceful landing is the correct termination
model (both Haiku and Sonnet were shown to never self-terminate). The simplification therefore
*consolidates* rather than redesigns. The one structural change: collapse the scattered
stopping machinery — the graceful-landing wrap-up (token/step/novelty) **and** the coverage
gate (premature-exit guard) — into a single `_StopController`, since both are "when does the run
stop?". Everything else is focus/clarity: derive ledger coverage instead of duplicating it,
move the HTML+CSS blob into its own module, and shrink `run.py` to thin wiring.

**Tech Stack:** Python 3.11 (runs in Docker; local python is 3.9), `anthropic` SDK, `httpx`,
`PyJWT`, `pytest` + `ruff`. Checks: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
(host path; needs `PYTHONPATH=../backend`, which `verify.sh` sets) — mirrors CI.

---

## Guiding constraints (non-negotiable, carried from the session)

- **No behavior change.** All 67 existing tests must stay green at every task boundary. This is
  a refactor + docs pass, not a feature change. If a test must change, it's only because a
  symbol moved or a signature was intentionally grouped — never because behavior shifted.
- **Security posture is untouched.** Loopback-only `LoopbackHTTP`, read-only `LogTail`, the
  threat-model rules in the prompt, "a finding is real only if reproduced via `call_endpoint`",
  and the intended permissions-array acceptance all remain exactly as-is.
- **DRY / YAGNI.** Do not add abstraction the current two call sites (tests + `run.py`) don't
  need. The `_StopController` is justified because it removes a class, a function, and 3
  parameters; nothing else gets a new layer.
- **Keep the loop legible.** The whole point is a *visible* loop. Simplification must make
  `run_agent` easier to read top-to-bottom, never hide control flow behind cleverness.

## Files in scope

- Modify: `security/secagent/agent_core/loop.py` (351 lines — the big one)
- Modify: `security/secagent/agent_core/report.py` (354 lines — split HTML out)
- Create: `security/secagent/agent_core/html_report.py` (receives the HTML renderer)
- Modify: `security/secagent/run.py` (114 lines — shrink to wiring)
- Modify: `security/tests/test_loop_robustness.py`, `security/tests/test_report_html.py`
  (follow moved symbols / grouped params)
- Modify: `docs/adr/0002-agentic-auth-security-testing.md`, `docs/design/auth-bypass-agent.md`
  (reconcile wording with the hand-rolled reality + this session's mechanisms — issue #25)

## Out of scope (explicitly not doing — YAGNI)

- Replacing the hand-rolled loop with `claude_agent_sdk` (kept hand-rolled on purpose).
- Touching `tools.py`'s `LoopbackHTTP`/`LogTail`/guardrails, `keys.py`, `eval.py`,
  `compare.py`, `mock_oidc/`, or the auth `mint_token`/`call_execute` tools — they are already
  focused and were not implicated in any session learning.
- Any change to CI job names or `verify.sh` contents.

---

### Task 1: Derive ledger coverage instead of storing it

Smallest, lowest-risk change first. `AttemptLedger` currently keeps a separate `_covered` set
that must be kept in sync with `attempts`. Each attempt already records its `seed_id`, so
coverage is *derivable* — the set is redundant mutable state.

**Files:**
- Modify: `security/secagent/agent_core/report.py:35-46` (the `AttemptLedger` dataclass)
- Test: `security/tests/test_loop_robustness.py` (existing coverage tests already exercise this)

- [ ] **Step 1: Run the suite to confirm a green baseline**

Run: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
Expected: PASS (67 passed).

- [ ] **Step 2: Replace the stored set with a derived property**

In `report.py`, the `AttemptLedger` becomes:

```python
@dataclass
class AttemptLedger:
    """External memory of hypotheses already tested + their outcome.

    Re-injected into context every turn so the agent doesn't forget (or repeat) what it tried,
    even when raw history is trimmed by the sliding window.
    """

    attempts: List[dict] = field(default_factory=list)

    def add(self, hypothesis: str, outcome: str, seed_id: str | None = None) -> str:
        self.attempts.append({"hypothesis": hypothesis, "outcome": outcome, "seed_id": seed_id})
        return f"noted attempt ({len(self.attempts)} total)"

    @property
    def covered_seeds(self) -> set:
        """Seed ids tested at least once — derived from attempts, not tracked separately."""
        return {a["seed_id"] for a in self.attempts if a.get("seed_id")}

    def uncovered(self, required: set) -> set:
        return set(required) - self.covered_seeds

    def render(self) -> str:
        if not self.attempts:
            return ""
        lines = ["Hypotheses already tested (do NOT repeat these):"]
        lines += [f"- {a['hypothesis']} → {a['outcome']}" for a in self.attempts]
        return "\n".join(lines)
```

(Removes the `_covered: set` field and the two lines in `add` that maintained it.)

- [ ] **Step 3: Run the suite to verify still green**

Run: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
Expected: PASS (67 passed) — `covered_seeds`/`uncovered` behave identically.

- [ ] **Step 4: Commit**

```bash
git add security/secagent/agent_core/report.py
git commit -m "refactor(security): derive ledger coverage from attempts (drop _covered set)"
```

---

### Task 2: Collapse the stopping machinery into one `_StopController`

The session's core learning is that an agent has a **two-sided** stopping problem: a *floor*
(don't quit before the baseline is covered — the coverage gate) and a *ceiling* (don't wander
forever — the graceful landing's token/step/novelty rules). Today those live in two helpers
(`_GracefulLanding` + `_coverage_nudge`) and five `run_agent` parameters
(`ledger, required_seeds, findings, novelty_patience, max_nudges`). Unify them: one controller
owns both sides, and a small `StoppingPolicy` dataclass groups the three config knobs.

**Files:**
- Modify: `security/secagent/agent_core/loop.py` (replace `_GracefulLanding`, `_coverage_nudge`,
  and the `run_agent` signature/body that wires them)
- Test: `security/tests/test_loop_robustness.py` (update construction to the grouped params)

- [ ] **Step 1: Add the `StoppingPolicy` dataclass**

In `loop.py`, near `Budget`:

```python
@dataclass
class StoppingPolicy:
    """When may the run end? The two-sided stop: a coverage FLOOR (don't quit before the
    baseline seeds are covered) and a novelty CEILING (wind down once returns dry up). The
    token/step soft-limits live on Budget; these are the content-aware knobs."""

    required_seeds: set[str] = field(default_factory=set)  # the coverage floor
    novelty_patience: int = 0  # consecutive no-progress steps before a productive early stop; 0 off
    max_nudges: int = 2  # how many times the floor may nudge a premature finish
```

- [ ] **Step 2: Replace both helpers with `_StopController`**

Delete `_GracefulLanding` and `_coverage_nudge`. Add:

```python
class _StopController:
    """Owns both sides of "when does the run stop?":

    - FLOOR (premature-exit guard): on an attempted finish, if required seeds are still
      uncovered, `nudge()` returns a message naming the missing seeds (up to max_nudges times).
    - CEILING (graceful landing): after a tool step, `wrap_up()` returns a wind-down message
      when any external stopping rule fires first — token soft-limit, step soft-limit, or
      diminishing returns (baseline covered + novelty_patience steps with nothing new).

    Once a wrap-up fires, `landing` latches True and the floor stands down (wrap-up wins over
    the gate, so the two never fight and thrash the run to the hard cap)."""

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

    def _floor_met(self) -> bool:
        return self._ledger is None or not self._ledger.uncovered(self._policy.required_seeds)

    def _diminishing(self) -> bool:
        """Advance the novelty counter for this tool step; report whether returns have dried up.
        Gated on the floor, so it can never short-circuit baseline coverage."""
        if self._policy.novelty_patience <= 0:
            return False
        covered, found = self._covered_count(), self._finding_count()
        progressed = covered > self._covered_seen or found > self._findings_seen
        self._covered_seen, self._findings_seen = covered, found
        self._stalled_steps = 0 if progressed else self._stalled_steps + 1
        return self._floor_met() and self._stalled_steps >= self._policy.novelty_patience

    def wrap_up(self, step: int, tokens_used: int) -> str | None:
        """Call once per tool step. Returns the wind-down instruction to ride in with the tool
        results, or None to keep going."""
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
```

- [ ] **Step 3: Slim `run_agent`'s signature and body to delegate to the controller**

`run_agent` keeps `ledger` and `findings` (they are also used for `_system_blocks` and reports),
but the three stopping knobs collapse into one `policy` argument:

```python
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
                client, model=model, max_tokens=budget.max_response_tokens,
                system=_system_blocks(system, ledger), messages=messages, tools=tools,
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
                tool_results.append({"type": "text", "text": wrap_up})  # ride it in (one user msg)
            messages.append({"role": "user", "content": tool_results})

        transcript.append(StepLog(step, step_calls, tokens_used, resp.stop_reason))
        logger.info(
            "step %d: %s | tokens≈%d | %s",
            step, ", ".join(c["name"] for c in step_calls) or "(no tools)",
            tokens_used, resp.stop_reason,
        )

        if resp.stop_reason == "max_tokens":
            _queue_continuation(messages)
        elif resp.stop_reason != "tool_use":
            nudge = stop.nudge()
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
```

Net deletions: the `_GracefulLanding` class, the `_coverage_nudge` function, and the
`nudges_used`/`wrapping_up` locals. Net additions: `StoppingPolicy` + `_StopController`. The
loop body's stop logic drops from two inline concerns to two one-line delegations.

- [ ] **Step 3b: Update `run.py`'s call site in the SAME task (so the signature and its only
  production caller move together — no false-green commit)**

`run.py` is not exercised by any test and ruff won't catch a stale cross-module kwarg, so the
call-site MUST change here, not in Task 4. Add `StoppingPolicy` to the import and swap the three
kwargs:

```python
from secagent.agent_core.loop import Budget, StoppingPolicy, run_agent
...
    result = run_agent(
        client=Anthropic(), model=model, system=SYSTEM_PROMPT,
        initial_user=initial_goal(SEED_HYPOTHESES, audience=audience, issuer=issuer),
        registry=registry, budget=budget, ledger=ledger, findings=findings,
        policy=StoppingPolicy(required_seeds=SEED_IDS, novelty_patience=novelty_patience),
    )
```

- [ ] **Step 4: Update `test_loop_robustness.py` to the grouped params**

Every `run_agent(... required_seeds=X, novelty_patience=Y, max_nudges=Z ...)` and the bare
`min_attempts`-era calls become `policy=StoppingPolicy(required_seeds=X, novelty_patience=Y,
max_nudges=Z)`. Concretely, the call sites change like:

```python
# before
run_agent(..., ledger=AttemptLedger(), required_seeds={"a", "b"}, max_nudges=2)
# after
run_agent(..., ledger=AttemptLedger(),
          policy=StoppingPolicy(required_seeds={"a", "b"}, max_nudges=2))
```

and for the novelty test:

```python
run_agent(..., ledger=ledger, findings=None,
          policy=StoppingPolicy(required_seeds={"a"}, novelty_patience=2))
```

Add `StoppingPolicy` to the import at the top of the test file. The assertions
(`result.steps`, `result.stopped_on_budget`, the injected-text scans) are unchanged — behavior
is identical.

- [ ] **Step 5: Run the suite**

Run: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
Expected: PASS (67 passed). If a stopping test fails, the controller's branch order differs
from the old inline logic — diff `wrap_up`/`nudge` against the pre-refactor behavior, do not
change the test's expectations.

- [ ] **Step 6: Commit**

```bash
git add security/secagent/agent_core/loop.py security/tests/test_loop_robustness.py
git commit -m "refactor(security): unify stop logic into _StopController + StoppingPolicy"
```

---

### Task 3: Move the HTML report into its own module

`report.py` is 354 lines, ~150 of which are the HTML renderer + its CSS string — a different
concern (presentation) from the findings/ledger data types. Split it so each file has one
responsibility and the CSS blob stops drowning the data model.

**Files:**
- Create: `security/secagent/agent_core/html_report.py`
- Modify: `security/secagent/agent_core/report.py` (remove the HTML section + now-unused imports)
- Modify: `security/secagent/run.py` (import `render_html_report` from the new module)
- Modify: `security/tests/test_report_html.py` (import from the new module)

- [ ] **Step 1: Create `html_report.py` with the renderer**

Move, verbatim, from `report.py` into a new `security/secagent/agent_core/html_report.py`:
`_SEV_COLOR`, `_OK_GREEN`, `_HTML_CSS`, `_esc`, and `render_html_report`. Add its own header
and imports:

```python
"""Self-contained HTML rendering of one agent run — the at-a-glance human deliverable.

Kept separate from report.py (the findings/ledger data model) so the CSS blob and presentation
logic don't crowd the data types. Inputs are plain data, so this stays decoupled from the
loop/Seed types."""
from __future__ import annotations

from datetime import datetime, timezone
from html import escape
from typing import Any, Sequence, Tuple

from .report import SEVERITIES, AttemptLedger, FindingStore
```

(The body of `render_html_report` and its helpers/constants are unchanged.)

- [ ] **Step 2: Remove the HTML section from `report.py`**

Delete the `# --- HTML report ---` block and below from `report.py`. Then prune now-unused
imports in `report.py`: drop `escape` (from `html`) and narrow `typing` back to what the
remaining code uses (`List`; remove `Any, Sequence, Tuple` if nothing else needs them — verify
with ruff, which will flag unused imports).

- [ ] **Step 3: Point importers at the new module**

In `run.py`: `from secagent.agent_core.html_report import render_html_report` (remove it from the
`report` import). In `test_report_html.py`: import `render_html_report` from
`secagent.agent_core.html_report` (keep `AttemptLedger, FindingStore` from `report`).

- [ ] **Step 4: Run the suite**

Run: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
Expected: PASS (67 passed). ruff confirms no unused/circular imports (note: `html_report`
imports from `report`, never the reverse — no cycle).

- [ ] **Step 5: Commit**

```bash
git add security/secagent/agent_core/html_report.py security/secagent/agent_core/report.py \
        security/secagent/run.py security/tests/test_report_html.py
git commit -m "refactor(security): split HTML report into its own module"
```

---

### Task 4: Shrink `run.py` to wiring by extracting the report-set writer

`run.py` now both wires the agent and hand-builds the 5-file artifact set + the slug. The
artifact-set writing is reusable, testable logic that doesn't belong in the entrypoint.

**Files:**
- Modify: `security/secagent/agent_core/html_report.py` (add `write_report_set` — it already
  owns the HTML and can own the bundle) OR `report.py`; place it in `html_report.py` since it
  produces the HTML headline.
- Modify: `security/secagent/run.py` (call the helper)
- Test: `security/tests/test_report_html.py` (add one test for the writer)

- [ ] **Step 1: Write the failing test for the writer**

In `test_report_html.py`:

```python
def test_write_report_set_emits_descriptive_bundle(tmp_path):
    from secagent.agent_core.html_report import write_report_set
    ledger = AttemptLedger()
    ledger.add("no token", "401", seed_id="no_token")
    paths = write_report_set(
        report_dir=tmp_path, model="claude-haiku-4-5", target="http://backend:8000",
        findings=FindingStore(), ledger=ledger, seeds=SEEDS,
        steps=3, tokens_used=10, tool_calls=1, stopped_on_budget=False, partial=False,
        error=None, transcript=[],
    )
    html_path = paths["html"]
    assert html_path.suffix == ".html"
    assert html_path.name.startswith("auth-claude-haiku-4-5-")  # descriptive, model-stamped
    # the full bundle is written and named off one slug
    names = sorted(p.name for p in paths.values())
    assert any(n.endswith(".findings.json") for n in names)
    assert html_path.read_text().startswith("<!doctype html>")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd security && PYTHONPATH=../backend pytest tests/test_report_html.py::test_write_report_set_emits_descriptive_bundle -v`
Expected: FAIL with `ImportError: cannot import name 'write_report_set'`.

- [ ] **Step 3: Implement `write_report_set` in `html_report.py`**

```python
import json
import pathlib


def write_report_set(
    *, report_dir, model: str, target: str, findings, ledger, seeds,
    steps: int, tokens_used: int, tool_calls: int, stopped_on_budget: bool,
    partial: bool, error: str | None, transcript, generated: datetime | None = None,
) -> dict:
    """Write the per-run, descriptively-named report bundle and return {kind: path}.

    Filenames share one slug `auth-<model>-<UTC timestamp>` so repeated runs (e.g. Haiku vs
    Sonnet) never clobber each other on the persisted host mount."""
    report_dir = pathlib.Path(report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    generated = generated or datetime.now(timezone.utc)
    slug = f"auth-{model}-{generated.strftime('%Y%m%d-%H%M%SZ')}"
    html = render_html_report(
        target=target, model=model, findings=findings, ledger=ledger, seeds=seeds,
        steps=steps, tokens_used=tokens_used, tool_calls=tool_calls,
        stopped_on_budget=stopped_on_budget, partial=partial, error=error,
        transcript=transcript, generated=generated,
    )
    bundle = {
        "html": (f"{slug}.html", html),
        "findings_md": (f"{slug}.findings.md", findings.to_markdown(target=target, partial=partial)),
        "findings_json": (f"{slug}.findings.json", findings.to_json()),
        "transcript_json": (f"{slug}.transcript.json", json.dumps(transcript, indent=2)),
        "attempts_json": (f"{slug}.attempts.json", json.dumps(ledger.attempts, indent=2)),
    }
    paths = {}
    for kind, (name, content) in bundle.items():
        path = report_dir / name
        path.write_text(content)
        paths[kind] = path
    return paths
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd security && PYTHONPATH=../backend pytest tests/test_report_html.py -v`
Expected: PASS.

- [ ] **Step 5: Replace the inline writing in `run.py` with the helper**

The report block in `run.py` collapses to:

```python
    paths = write_report_set(
        report_dir=os.environ.get("REPORT_DIR", "reports"), model=model, target=target,
        findings=findings, ledger=ledger, seeds=[(s.id, s.text) for s in SEED_HYPOTHESES],
        steps=result.steps, tokens_used=result.tokens_used, tool_calls=tool_calls,
        stopped_on_budget=result.stopped_on_budget, partial=result.partial,
        error=result.error, transcript=result.transcript_dicts(),
    )
    print(findings.to_markdown(target=target, partial=result.partial))
    if result.error:
        print(f"\n[!] run ended on error: {result.error}")
    uncovered = ledger.uncovered(SEED_IDS)
    print(
        f"\n[steps={result.steps} tokens≈{result.tokens_used} "
        f"budget_stop={result.stopped_on_budget} attempts={len(ledger.attempts)} "
        f"tool_calls={tool_calls} "
        f"seeds_covered={len(SEED_IDS) - len(uncovered)}/{len(SEED_IDS)}"
        + (f" uncovered={sorted(uncovered)}" if uncovered else "")
        + "]"
    )
    print(f"\n[report] {paths['html']}")
```

Remove the now-unused `json`/`pathlib`/`datetime` imports from `run.py` if nothing else uses
them (ruff will confirm; `tool_calls` is still computed from `result.transcript`). The
`run_agent(...)` call site already moved to `policy=...`/`findings=...` in Task 2 — do not touch
it again here.

- [ ] **Step 6: Add a run.py smoke test (guards against silent signature drift)**

`run.py` has no test coverage, which is exactly how the Task 2/Task 4 false-green could have
slipped by. Add a smoke test that drives `main()` end-to-end with a fake LLM client (immediate
`end_turn`) so any future stale kwarg to `run_agent`/`write_report_set` fails loudly. Create
`security/tests/test_run_smoke.py`:

```python
"""Smoke test: run.main() wires the agent + report writer without a live API or network."""
import types

import secagent.run as run
from secagent.agent_core import keys


def _fake_anthropic_factory():
    end = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text="done")],
        stop_reason="end_turn",
        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
    )
    msgs = types.SimpleNamespace(create=lambda **kw: end)
    return types.SimpleNamespace(messages=msgs)


def test_main_wires_and_writes_a_report(tmp_path, monkeypatch):
    key_dir = tmp_path / "keys"
    key_dir.mkdir()
    keys.save_keypair(keys.generate_keypair("signing"), str(key_dir), "signing")  # JWKS signer
    monkeypatch.setattr(run, "Anthropic", _fake_anthropic_factory)
    monkeypatch.setenv("OIDC_ISSUER", "http://mock/")
    monkeypatch.setenv("OIDC_AUDIENCE", "https://api.local")
    monkeypatch.setenv("KEY_DIR", str(key_dir))
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("TARGET_BASE_URL", "http://127.0.0.1:8000")

    run.main()  # must not raise — exercises run_agent(...) + write_report_set(...) kwargs

    htmls = list((tmp_path / "reports").glob("auth-*.html"))
    assert len(htmls) == 1 and htmls[0].read_text().startswith("<!doctype html>")
```

Note: confirm the exact `keys` API first — `grep -n "def " security/secagent/agent_core/keys.py`.
If saving a keypair has a different name/shape than `save_keypair(kp, dir, name)`, adapt this
step to the real signature (the test's intent — generate + persist a signing key the agent can
load — is what matters).

- [ ] **Step 7: Run the suite**

Run: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
Expected: PASS (69 passed — the writer test + the run smoke test).

- [ ] **Step 8: Commit**

```bash
git add security/secagent/agent_core/html_report.py security/secagent/run.py \
        security/tests/test_report_html.py security/tests/test_run_smoke.py
git commit -m "refactor(security): extract write_report_set; run.py is thin wiring + smoke test"
```

---

### Task 5: Reconcile the docs with the hand-rolled reality + session mechanisms (#25)

The session's learnings include doc drift: ADR 0002 still says "Claude Agent SDK" though the
loop is hand-rolled on the Anthropic SDK, and neither the ADR nor the design doc mentions the
termination model, the identity coverage gate, the novelty stop, or the HTML report. This is
the "incorporate all the learnings" half of the request. (README was already updated this
session — do not re-touch it.)

**Files:**
- Modify: `docs/adr/0002-agentic-auth-security-testing.md`
- Modify: `docs/design/auth-bypass-agent.md`

- [ ] **Step 1: Read both docs to find the exact stale passages**

Run: `grep -n -i "agent sdk\|claude_agent_sdk\|min_attempts\|count\|terminat\|coverage" docs/adr/0002-agentic-auth-security-testing.md docs/design/auth-bypass-agent.md`
(Read the surrounding paragraphs before editing — fix only what misleads a reader.)

- [ ] **Step 2: Correct the ADR wording**

Change any "Claude Agent SDK" phrasing to state the decision accurately: the loop is built **by
hand on the Anthropic Messages tool-use API** (deliberately, as the learning goal), with
`claude_agent_sdk` noted as the future swap-in, localized to `loop.py`. Keep the ADR's
decision/consequences structure; this is a wording correction, not a new decision.

- [ ] **Step 3: Update the design doc's termination + coverage sections**

Add/lift, in the design doc's own voice (cite the memory `agent-termination-and-coverage` is
*not* needed in the doc — restate the conclusions): (a) the task is open-ended, so the
termination model is a **budget-driven graceful landing**, not autonomous self-termination
(empirically, neither model self-terminates); (b) coverage is gated by **seed identity**, not
attempt count; (c) a **diminishing-returns/novelty stop** lands the run once the floor is met
and returns dry up; (d) each run emits a descriptively-named **HTML report bundle**. Correct
any "zero findings" / HS256 phrasing that the earlier draft over-claimed.

- [ ] **Step 4: Verify the docs build/links and nothing else references the old wording**

Run: `grep -rn -i "claude agent sdk" docs/ README.md security/`
Expected: no stale matches (or only the intentional "future swap-in" mention).

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0002-agentic-auth-security-testing.md docs/design/auth-bypass-agent.md
git commit -m "docs(security): reconcile ADR/design with hand-rolled loop + stop/coverage model (#25)"
```

---

## Final verification (before the PR is ready)

- [ ] Full suite green via the CI-mirroring path: `cd security && SKIP_DOCKER=1 SKIP_INSTALL=1 ./verify.sh`
- [ ] Optional Docker parity (matches CI exactly): `cd security && ./verify.sh`
- [ ] Per CLAUDE.md "Review process", before handing the PR over: run the `code-review` and
  `security-review` skills against the pending diff, evaluate findings with
  `receiving-code-review`, fix what's real, and re-run `verify.sh`.
- [ ] Confirm line counts dropped where intended: `loop.py` (one class + one function removed),
  `report.py` (HTML section removed), `run.py` (report block collapsed).

## Self-Review notes (run before dispatching the reviewer)

- **Requirement coverage:** "incorporate all session learnings" → Tasks 1–2 (identity coverage,
  novelty stop, two-sided stop framing) + Task 5 (docs). "simplify all agent files" → Tasks 1–4
  (loop, report, html, run). Ledger/eval/compare/tools/keys deliberately untouched (justified
  under Out of scope).
- **Placeholder scan:** every code step shows real code; no TBD/"handle edge cases".
- **Type consistency:** `StoppingPolicy` fields (`required_seeds`, `novelty_patience`,
  `max_nudges`) are referenced consistently in `_StopController` and the Task 4 `run.py` call;
  `write_report_set` returns a dict keyed `html/findings_md/findings_json/...` used as
  `paths['html']`; `covered_seeds`/`uncovered` signatures unchanged from today.
- **Reversibility:** each task is an independent commit that keeps the suite green; any task can
  be reverted alone. Blast radius is confined to `security/` + two docs; no CI/ruleset/public
  API surface changes.
