"""Live entrypoint: wire the core + auth module and run the agent against a local target.

Spends Anthropic credits. Reads config from env (see security/README.md). Writes a per-run,
descriptively-named report set: an at-a-glance HTML report plus markdown + JSON artifacts.
"""
from __future__ import annotations

import logging
import os

from anthropic import Anthropic

from secagent.agent_core.html_report import write_report_set
from secagent.agent_core.keys import generate_keypair, load_keypair
from secagent.agent_core.loop import Budget, StoppingPolicy, run_agent
from secagent.agent_core.report import AttemptLedger, FindingStore
from secagent.agent_core.tools import LogTail, LoopbackHTTP, ToolRegistry, make_generic_tools
from secagent.modules.auth.checklist import SEED_HYPOTHESES, SEED_IDS
from secagent.modules.auth.prompt import SYSTEM_PROMPT, initial_goal
from secagent.modules.auth.tools import make_auth_tools


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )

    target = os.environ.get("TARGET_BASE_URL", "http://127.0.0.1:8000")
    issuer = os.environ["OIDC_ISSUER"]
    audience = os.environ["OIDC_AUDIENCE"]
    key_dir = os.environ.get("KEY_DIR", "/keys")
    model = os.environ.get("LLM_MODEL", "claude-sonnet-4-6")
    allowed = {h for h in os.environ.get("ALLOWED_TARGET_HOSTS", "").split(",") if h}
    budget = Budget(
        max_steps=int(os.environ.get("AGENT_MAX_STEPS", Budget.max_steps)),
        max_total_tokens=int(os.environ.get("AGENT_MAX_TOKENS", Budget.max_total_tokens)),
    )
    # Diminishing-returns stop: land the run once the baseline is covered and this many
    # consecutive steps surface nothing new. 0 disables it (budget-only landing).
    novelty_patience = int(os.environ.get("AGENT_NOVELTY_PATIENCE", 4))

    signing = load_keypair(key_dir, "signing")  # must match the mock OIDC's JWKS
    rogue = generate_keypair("rogue-key")  # ephemeral; NOT in the JWKS

    http = LoopbackHTTP(target, extra_allowed_hosts=allowed)
    findings = FindingStore()
    ledger = AttemptLedger()  # durable memory of what's been tried (survives context trimming)
    logs = LogTail(os.environ.get("BACKEND_LOG_FILE", "/logs/backend.log"))  # read-only tail
    registry = ToolRegistry(
        make_generic_tools(http, findings, ledger, logs=logs, seed_ids=SEED_IDS)
        + make_auth_tools(
            http=http, signing=signing, rogue=rogue, issuer=issuer, audience=audience
        )
    )

    result = run_agent(
        client=Anthropic(),  # ANTHROPIC_API_KEY from env
        model=model,
        system=SYSTEM_PROMPT,
        initial_user=initial_goal(SEED_HYPOTHESES, audience=audience, issuer=issuer),
        registry=registry,
        budget=budget,
        ledger=ledger,
        findings=findings,  # feeds the diminishing-returns stop (a new finding is "progress")
        policy=StoppingPolicy(
            required_seeds=SEED_IDS,  # don't accept "done" before every baseline seed is covered
            novelty_patience=novelty_patience,
        ),
    )

    tool_calls = sum(len(s.tool_calls) for s in result.transcript)
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


if __name__ == "__main__":
    main()
