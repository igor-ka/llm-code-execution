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

The agent writes `reports/findings.md`, `reports/findings.json`, `reports/transcript.json`
(which hypotheses it fired), and `reports/attempts.json` (the durable ledger). Against the real
`auth.py` it should find nothing; the eval (#23) proves it *can* find planted holes (mutants).

The agent also has **read-only** white-box visibility into the target via `read_backend_logs`:
the backend tees its output to a shared `logs` volume and the agent mounts it read-only (no
Docker socket), so it can observe stack traces / leaked error detail without any control over
the target's host.

Tunable via env (also wired in `docker-compose.test.yml`): `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`
(cumulative billed-token cap), `LLM_MODEL`.

**Context management** (so cost doesn't grow unbounded across turns):
- **Prompt caching** marks the stable system prompt + tool schemas as cacheable (a no-op below
  the model's min cached-prefix size; effective as prompts grow).
- **Attempt ledger** — durable memory of `{hypothesis → outcome}`, re-injected every turn so the
  agent never forgets/repeats what it tried, even after older turns are trimmed.
- **Sliding window** caps retained raw turns as a backstop.

**Not exiting prematurely:**
- **Coverage-gated termination** — the loop won't accept "done" until the agent has logged at
  least the baseline hypotheses via `note_attempt` (nudged up to twice, then it relents).
- **Retry + partial report** — `messages.create` is retried; an unrecoverable API error returns
  a *partial* run (findings/transcript so far) instead of crashing the whole run.

## Compare against a baseline tool — Strix (#24)

Diff our agent against [Strix](https://github.com/usestrix/strix) (an autonomous OSS pentest
agent) over the same target, scored via the ground truth. Strix is **open source and
bring-your-own-LLM** — it drives its loop with whatever model you configure, so any cost lands
on *your* LLM key (or **zero**, with a local model via `LLM_API_BASE`, in which case nothing
leaves your machine). It runs locally; this harness doesn't run it for you.

> Data flow: scanning is local and doesn't require sending data to Strix-the-project, but a
> **hosted** `STRIX_LLM` sends prompts (code/responses/findings) to *that LLM provider*. For
> nothing-leaves-the-box, point `LLM_API_BASE` at a local model and leave `PERPLEXITY_API_KEY` unset.

```bash
# 1. our findings already exist (reports/findings.json from a live run above)
# 2. run Strix against the running stack (uses YOUR LLM key; or a local model for $0):
curl -sSL https://strix.ai/install | bash
export STRIX_LLM=anthropic/claude-sonnet-4-6 LLM_API_KEY=sk-ant-...   # or a local model
strix --target http://localhost:8000          # backend stack must be up
# 3. diff the two against ground truth (`real_auth`, or a mutant name):
python -m secagent.agent_core.compare \
    reports/findings.json strix_runs/<run>/<results>.json real_auth
```

The report shows recall/precision for each tool and, per ground-truth id, who found it (shared /
ours-only / theirs-only / missed-by-both), plus each tool's **unmatched** findings — candidates
to either promote into ground truth or dismiss as false positives.

> Strix's on-disk result schema isn't documented, so `normalize_strix` in `compare.py` is a
> tolerant, **provisional** adapter over common field names — adjust it to the real schema after
> the first Strix run.

## Safety

- Tools are pinned to a single local target and refuse non-loopback hosts (operators may
  allow a known compose host explicitly). The model can never redirect a request elsewhere.
- Step + token **budget caps**; the only writes are the report.
- Loopback/local only — never expose this stack.
