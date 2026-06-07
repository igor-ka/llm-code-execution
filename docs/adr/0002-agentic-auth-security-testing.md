# 2. Agentic auth security testing

- **Status:** Proposed
- **Date:** 2026-06-05
- **Tracking:** epic [#19](https://github.com/igor-ka/llm-code-execution/issues/19) (work items [#20](https://github.com/igor-ka/llm-code-execution/issues/20)–[#25](https://github.com/igor-ka/llm-code-execution/issues/25))
- **Related:** auth ADR [0001](0001-authentication-approach.md); design [auth-bypass-agent](../design/auth-bypass-agent.md)

## Context

ADR 0001 added an OIDC bearer gate to `POST /api/execute`. This ADR covers how we test that gate
adversarially with a self-built agent, and the build-vs-buy choice behind the tooling.
Reliability/SRE testing is a separate, later effort and is out of scope here.

The auth surface is small and has deterministic ground truth (a bypass either works or it
doesn't), which suits both a hand-built agent and an honest eval.

## Decision

1. **Build a custom auth-bypass agent** with the **Claude Agent SDK** as the primary
   deliverable. Building the loop once is the lesson; it also avoids sending a private repo to a
   third-party SaaS agent. Architecture in the linked design doc.
2. **Adopt Strix as the OSS benchmark baseline** — the most directly competitive autonomous
   agent (it validates findings with PoCs and explicitly targets auth bypass) — and run it
   against the same target to diff findings against the custom agent. CAI is kept as a secondary
   baseline and as the cleanest reference for the agent loop itself.
3. **Defer commercial tools.** They are excellent but are overkill and not cost-justified for a
   learning project; this ADR records them so the decision is revisitable if this ever needs a
   production-grade posture.
4. **White-box to find, black-box to prove.** The agent may read source for hypotheses, but a
   finding counts only if it reproduces against the running endpoint over loopback.
5. **Controllable IdP.** Use a local mock OIDC/JWKS we hold the signing key for, so token
   attacks are deterministic and offline; an Auth0 dev-tenant pass is an optional later add.
6. **Domain-agnostic core; auth is module one.** Build the reusable agent machinery (loop,
   tool surface, reporting, eval harness) independent of any one vulnerability class, and plug
   **auth** in as the first *capability module* (its checklist + toolset). The decision is "auth
   is milestone one," not "auth forever" — broadening later (BOLA, injection, SSRF,
   sandbox-escape) is adding modules, not rewriting. Separating reusable agent infra from
   domain checklists is itself part of the learning.

## Alternatives considered

### Open source agents (direct competitors — top 3)

Autonomous LLM agents only (legacy non-agent scanners are excluded as out of scope for the
comparison). **Strix** is the chosen benchmark baseline; the others are secondary references.

| Tool | Why chosen / considered | Adoption & reputation |
|------|------------------------|-----------------------|
| **Strix** — chosen ([github](https://github.com/usestrix/strix)) | The most *directly competitive* agent: autonomous, runs the app dynamically, and **validates each finding with a real PoC** — and it explicitly finds **authentication bypass** and IDOR, exactly our target class. Self-hostable, so white-box runs against our own source stay local. The best head-to-head benchmark for the custom agent. | Rated (alongside CAI) **among the most reliable** OSS offensive agents in independent 2026 round-ups; fast-growing since its late-2025 release. |
| **CAI** ([github](https://github.com/aliasrobotics/CAI)) | The cleanest agent *framework* to read and learn the loop from: lightweight, model-agnostic (runs on Claude), self-hostable. Kept as secondary baseline and loop reference. | Built by **Alias Robotics** with a supporting academic paper; reported use by hundreds of orgs for CTFs/bug-bounties; consistently rated among the most reliable OSS security-AI frameworks. |
| **PentestGPT** ([github](https://github.com/GreyDGL/PentestGPT)) | The best-known academic LLM-pentest framework; a task-tree "reasoning module" plans the attack chain — instructive for the custom loop's planning layer. | Widely cited and influential, but independent tests note **setup/reliability friction** (init failures, provider misconfig). A reference, not a dependency. |

Also notable in the autonomous space: **PentAGI**
([github](https://github.com/vxcontrol/pentagi), ~14.7k★, polished multi-agent + sandboxing) and
**Pentest-Swarm-AI** ([github](https://github.com/Armur-Ai/Pentest-Swarm-AI), Go + Claude API
swarm).

### Commercial agents (direct competitors — top 3, with costs)

Agentic platforms only (the traditional DAST scanners considered earlier are dropped). Recorded
for completeness; **not adopted** for this learning project.

| Tool | Why considered | Cost (2026) | Adoption & reputation |
|------|----------------|-------------|-----------------------|
| **XBOW** ([xbow.com](https://xbow.com/)) | The highest-profile autonomous **web-app** pentest agent — the closest commercial analogue to the custom agent. | ~**€5,500/test**; enterprise continuous testing custom-priced. | Reached **#1 on HackerOne**; **$120M Series C (Mar 2026)**, unicorn valuation. The most-watched name in autonomous offense. |
| **Escape** ([escape.tech](https://escape.tech/)) | The agentic **API/auth** specialist (BOLA, business-logic, agentic-crawler agents + a coordinator) — best fit for an auth target specifically; the free single-API tier could double as a second baseline. | Free tier for **one API**; paid quote-based (apps under scan, REST/GraphQL depth, mTLS). | Established API-security vendor; **$18M raise (Mar 2026)**; well-regarded in the API-security niche. |
| **Horizon3 NodeZero** ([horizon3.ai](https://horizon3.ai/nodezero/)) | The most *adopted and proven* autonomous pentest platform (web + network) — the enterprise reference point. | ~**€35k/year**. | **5,200+ organizations**, **170k+ tests**, 102% YoY ARR growth (Mar 2026). De-facto enterprise standard for autonomous pentest. |

Others in the agentic space, for reference: **AWS Security Agent** ($50/task-hr; LLM sign-in
handles OAuth/SAML/Okta/MFA — relevant to testing behind Auth0), **RunSybil** (custom; cloud-native;
$40M Series C Mar 2026), **Pentera** (~€46k/yr), **Terra Security** (€15k+/yr, early-stage).

### Other options

- **Pure parametrized `pytest` matrix (no agent):** the deterministic auth checks (expired /
  wrong-aud / bad-sig → 401) genuinely belong here and are cheaper than an LLM. *Rejected as the
  whole solution* because it cannot do open-ended hypothesis generation — but a small such suite
  is a sensible complement, and the eval mutants (design §6) effectively provide it.
- **Black-box only (no source access):** rejected as the primary mode — for an app we own,
  white-box finds more, faster; we keep one black-box pass to validate findings reproduce
  externally.

## Consequences

- New top-level `security/` tree (agent, mock OIDC, eval) with its own `verify.sh` mirroring CI,
  per CLAUDE.md. If a CI job is added, the job-name contract applies.
- Runs need an `ANTHROPIC_API_KEY` and spend tokens per run; budgets are capped (design §4, §8).
- The eval's "real `auth.py` → zero findings" target doubles as a **regression guard** on the
  auth code from ADR 0001.
- Decision is revisitable: if this app ever heads toward production multi-tenant use, revisit
  **Escape** (free single-API tier first) for a production-grade posture.
- The agent core is built domain-agnostic, so future capability modules (BOLA, injection, SSRF,
  sandbox-escape) plug in without a rewrite; only the auth module ships now.
- Sandbox isolation and SRE testing remain out of scope here.
