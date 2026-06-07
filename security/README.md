# security/ — agentic auth-security testing

A custom red-team agent that tries to break/bypass the OIDC bearer gate on `POST /api/execute`.
Built by hand (explicit ReAct loop on the Anthropic tool-use API) as a learning vehicle. See
[`docs/design/auth-bypass-agent.md`](../docs/design/auth-bypass-agent.md) and ADR
[`0002`](../docs/adr/0002-agentic-auth-security-testing.md). Tracked by epic
[#19](https://github.com/igor-ka/llm-code-execution/issues/19).

## Layout

```
agent_core/   domain-agnostic: keys, tools (+loopback guard), report, the ReAct loop
modules/auth/ capability module #1: prompt, seed checklist, mint_token + call_execute
mock_oidc/    a JWKS server for a signing key we control (so we can forge tokens)
tests/        real auth.py exercised in-process via the agent's own tools (no token spend)
secagent/run.py  live entrypoint (spends Anthropic credits)
```

The agent core knows nothing about auth; auth is a pluggable module (design seam for future
classes like BOLA/injection — none ship yet).

## Verify (mirrors CI)

```bash
cd security && ./verify.sh          # builds the image, runs ruff + pytest
SKIP_DOCKER=1 ./verify.sh           # run on host instead (needs Python 3.11+)
```

The default builds an image from the repo root so tests can import the real backend
`app.auth` (the code under test) via `PYTHONPATH`.

## Run it live (spends Anthropic credits)

```bash
# bring up the mock IdP + backend (auth ON, pointed at the mock):
ANTHROPIC_API_KEY=sk-... docker compose -f security/docker-compose.test.yml up --build backend
# in another shell, run the agent against it:
ANTHROPIC_API_KEY=sk-... docker compose -f security/docker-compose.test.yml --profile agent run --build agent
```

The agent writes `reports/findings.md` and `reports/findings.json`. Against the real `auth.py`
it should find nothing; the eval (#23) will prove it *can* find planted holes (mutants).

## Safety

- Tools are pinned to a single local target and refuse non-loopback hosts (operators may
  allow a known compose host explicitly). The model can never redirect a request elsewhere.
- Step + token **budget caps**; the only writes are the report.
- Loopback/local only — never expose this stack.
