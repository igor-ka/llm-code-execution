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

Each run writes a descriptively-named, non-clobbering report set under `reports/`, slugged
`auth-<model>-<timestamp>` (so repeated runs — e.g. Haiku vs Sonnet — don't overwrite each
other). The set is: an at-a-glance **`.html`** report (summary banner, findings, baseline
**seed coverage**, the attempt ledger, and the step transcript), plus `.findings.md`,
`.findings.json` (the eval scorer's input), `.transcript.json` (which hypotheses it fired), and
`.attempts.json` (the durable ledger). The runner prints the exact `.html` path on exit. Against
the real `auth.py` it should find nothing; the eval (#23) proves it *can* find planted holes
(mutants).

The agent also has **read-only** white-box visibility into the target via `read_backend_logs`:
the backend tees its output to a shared `logs` volume and the agent mounts it read-only (no
Docker socket), so it can observe stack traces / leaked error detail without any control over
the target's host.

Tunable via env (also wired in `docker-compose.test.yml`): `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`
(cumulative billed-token cap), `LLM_MODEL`, `AGENT_NOVELTY_PATIENCE` (diminishing-returns stop;
0 disables it).

**Context management** (so cost doesn't grow unbounded across turns):
- **Prompt caching** marks the stable system prompt + tool schemas as cacheable (a no-op below
  the model's min cached-prefix size; effective as prompts grow).
- **Attempt ledger** — durable memory of `{hypothesis → outcome}`, re-injected every turn so the
  agent never forgets/repeats what it tried, even after older turns are trimmed.
- **Sliding window** caps retained raw turns as a backstop.

**Not exiting prematurely:**
- **Identity-based coverage gate** — the loop won't accept "done" until every seeded baseline
  hypothesis is *covered by id* (each `note_attempt` tags a `seed_id`); the nudge names the
  specific seeds still missing (nudged up to twice, then it relents). Tracking coverage by
  identity rather than attempt *count* stops duplicate attempts from satisfying the gate while
  real seeds slip through.
- **Retry + partial report** — `messages.create` is retried; an unrecoverable API error returns
  a *partial* run (findings/transcript so far) instead of crashing the whole run.

**Not over-exploring (stopping smart):**
- **Diminishing-returns stop** — once the baseline floor is met, if `AGENT_NOVELTY_PATIENCE`
  consecutive steps surface nothing new (no newly-covered seed, no new finding), the loop lands
  the run gracefully (a clean conclusion, not a budget cap). It's an *external, measurable*
  stopping rule, not the model's self-judgment, and can never fire before the baseline is done.

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
# 1. our findings already exist (reports/<run>.findings.json from a live run above —
#    the runner prints the exact path; <run> = auth-<model>-<timestamp>)
# 2. run Strix against the running stack (uses YOUR LLM key; or a local model for $0):
curl -sSL https://strix.ai/install | bash
export STRIX_LLM=anthropic/claude-haiku-4-5 LLM_API_KEY=sk-ant-...   # or a local model
# Strix probes from its Docker sandbox, so target host.docker.internal, not localhost:
strix -n --target http://host.docker.internal:8000   # backend stack must be up
# 3. diff the two against ground truth (`real_auth`, or a mutant name) — feed Strix's
#    vulnerabilities.json (the findings LIST), NOT run.json (which is narrative-only):
python -m secagent.agent_core.compare \
    reports/<run>.findings.json strix_runs/<run>/vulnerabilities.json real_auth
```

The report shows recall/precision for each tool and, per ground-truth id, who found it (shared /
ours-only / theirs-only / missed-by-both), plus each tool's **unmatched** findings — candidates
to either promote into ground truth or dismiss as false positives.

> **Strix result schema (observed, 1.0.4):** a run that finds vulnerabilities writes
> `strix_runs/<run>/vulnerabilities.json` — a list of objects (`title, severity, description,
> impact, technical_analysis, poc_description, remediation_steps, cvss, cwe, …`). `run.json` is
> narrative-only (no findings list); a clean run has no `vulnerabilities.json`. `normalize_strix`
> maps the list's text fields; it deliberately does **not** mine the narrative (which describes
> attacks as *tested-and-safe* → would manufacture false positives).
>
> **Apples-to-apples caveat (see `comparisons/2026-06-13-strix-vs-ours/`):** our agent is handed
> the mock IdP signing key + `mint_token` — a privileged test fixture, **not** "white-box" — so
> it can reach validation logic *behind* the signature gate (e.g. expiry/audience bugs). A
> black-box tool without that key cannot, and will miss such bugs regardless of skill. To compare
> fairly on key-gated bugs, hand Strix the same credential (a pre-minted validly-signed token).
> Doing so flipped Strix from miss→catch on the expiry mutant, and a narrow credentialed scope
> also cut its cost from ~$3 to ~$0.17 per run.

## Safety

- Tools are pinned to a single local target and refuse non-loopback hosts (operators may
  allow a known compose host explicitly). The model can never redirect a request elsewhere.
- Step + token **budget caps**; the only writes are the report.
- Loopback/local only — never expose this stack.
