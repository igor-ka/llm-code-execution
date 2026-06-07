"""Live entrypoint: wire the core + auth module and run the agent against a local target.

Spends Anthropic credits. Reads config from env (see security/README.md). Writes a
markdown + JSON findings report.
"""
from __future__ import annotations

import json
import logging
import os
import pathlib

from anthropic import Anthropic

from secagent.agent_core.keys import generate_keypair, load_keypair
from secagent.agent_core.loop import Budget, run_agent
from secagent.agent_core.report import AttemptLedger, FindingStore
from secagent.agent_core.tools import LoopbackHTTP, ToolRegistry, make_generic_tools
from secagent.modules.auth.checklist import SEED_HYPOTHESES
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

    signing = load_keypair(key_dir, "signing")  # must match the mock OIDC's JWKS
    rogue = generate_keypair("rogue-key")  # ephemeral; NOT in the JWKS

    http = LoopbackHTTP(target, extra_allowed_hosts=allowed)
    findings = FindingStore()
    ledger = AttemptLedger()  # durable memory of what's been tried (survives context trimming)
    registry = ToolRegistry(
        make_generic_tools(http, findings, ledger)
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
    )

    report_dir = pathlib.Path(os.environ.get("REPORT_DIR", "reports"))
    report_dir.mkdir(parents=True, exist_ok=True)
    md = findings.to_markdown(target=target, partial=result.stopped_on_budget)
    (report_dir / "findings.md").write_text(md)
    (report_dir / "findings.json").write_text(findings.to_json())
    # The transcript is the audit trail: which hypotheses the agent actually fired.
    (report_dir / "transcript.json").write_text(json.dumps(result.transcript_dicts(), indent=2))
    (report_dir / "attempts.json").write_text(json.dumps(ledger.attempts, indent=2))
    print(md)
    print(
        f"\n[steps={result.steps} tokens≈{result.tokens_used} "
        f"budget_stop={result.stopped_on_budget} tool_calls="
        f"{sum(len(s.tool_calls) for s in result.transcript)}]"
    )


if __name__ == "__main__":
    main()
