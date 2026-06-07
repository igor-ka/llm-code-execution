"""Live entrypoint: wire the core + auth module and run the agent against a local target.

Spends Anthropic credits. Reads config from env (see security/README.md). Writes a
markdown + JSON findings report.
"""
from __future__ import annotations

import os
import pathlib

from anthropic import Anthropic

from secagent.agent_core.keys import generate_keypair, load_keypair
from secagent.agent_core.loop import Budget, run_agent
from secagent.agent_core.report import FindingStore
from secagent.agent_core.tools import LoopbackHTTP, ToolRegistry, make_generic_tools
from secagent.modules.auth.checklist import SEED_HYPOTHESES
from secagent.modules.auth.prompt import SYSTEM_PROMPT, initial_goal
from secagent.modules.auth.tools import make_auth_tools


def main() -> None:
    target = os.environ.get("TARGET_BASE_URL", "http://127.0.0.1:8000")
    issuer = os.environ["OIDC_ISSUER"]
    audience = os.environ["OIDC_AUDIENCE"]
    key_dir = os.environ.get("KEY_DIR", "/keys")
    model = os.environ.get("LLM_MODEL", "claude-sonnet-4-6")
    allowed = {h for h in os.environ.get("ALLOWED_TARGET_HOSTS", "").split(",") if h}

    signing = load_keypair(key_dir, "signing")  # must match the mock OIDC's JWKS
    rogue = generate_keypair("rogue-key")  # ephemeral; NOT in the JWKS

    http = LoopbackHTTP(target, extra_allowed_hosts=allowed)
    findings = FindingStore()
    registry = ToolRegistry(
        make_generic_tools(http, findings)
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
        budget=Budget(),
    )

    report_dir = pathlib.Path(os.environ.get("REPORT_DIR", "reports"))
    report_dir.mkdir(parents=True, exist_ok=True)
    md = findings.to_markdown(target=target, partial=result.stopped_on_budget)
    (report_dir / "findings.md").write_text(md)
    (report_dir / "findings.json").write_text(findings.to_json())
    print(md)
    print(
        f"\n[steps={result.steps} tokens≈{result.tokens_used} "
        f"budget_stop={result.stopped_on_budget}]"
    )


if __name__ == "__main__":
    main()
