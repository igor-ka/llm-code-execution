# Vendored skills — attribution

> Both upstreams are MIT-licensed. Their copyright remains with their authors, and the full
> licence texts live in the upstream repositories linked below. Redistributing this directory —
> which every consumer of the toolkit does — carries that attribution with it, which is why this
> file is part of the carried set rather than a note in the toolkit only.

Everything in this directory is **vendored**: copied in, adapted to this repo, and reviewed as
part of the diff. Nothing here is fetched at runtime, and no plugin marketplace is wired into
this repository. Upstream commits are pinned below so the next sync is a reviewable diff rather
than a silent behaviour change.

Skills are prompts, and prompts are behaviour. Treat a change to any file here as a code change:
it goes through a PR and the review gates in `CLAUDE.md` like anything else.

## Upstream 1 — claude-code-staff-engineer (Fareed Khan)

`writing-plans/` and `receiving-code-review/` are adapted from **claude-code-staff-engineer** by
Fareed Khan (https://github.com/FareedKhan-dev/claude-code-staff-engineer), MIT.

Only the plan-review and review-reception pieces were vendored; the upstream SessionStart hook,
the global "1% rule" handbook, and the TDD/forensic/worktree/orchestration skills were
intentionally **not** installed. Cross-skill references to those uninstalled parts were removed
so each skill stands alone.

## Upstream 2 — agent-skills (Addy Osmani)

`spec-driven-development/`, `test-driven-development/`, `incremental-implementation/`,
`debugging-and-error-recovery/`, `security-and-hardening/`, `git-workflow-and-versioning/`,
`documentation-and-adrs/`, and the shared `references/` are adapted from **agent-skills** by
Addy Osmani (https://github.com/addyosmani/agent-skills), MIT.

- **Upstream version:** `0.6.6`
- **Upstream commit:** `d2478bf0c73a6357df39a3ed6aff16acaa218843`
- **Vendored:** 2026-08-07

### What was deliberately left out (7 of 24 skills vendored)

| Not vendored | Why |
| --- | --- |
| `ci-cd-and-automation` | Its generic advice **contradicts this repo's CI design** — it recommends splitting lint/typecheck/test into separate parallel jobs, but our job `name:` values are a contract with the "Protect main" ruleset, and `verify.sh` is deliberately the single source of truth for both local and CI. Following it would break merges. |
| `code-review-and-quality` | `CLAUDE.md` mandates the **built-in** `code-review` skill. A second, competing review checklist splits the standard. |
| `planning-and-task-breakdown` | Weaker than our `writing-plans`: no adversarial staff-engineer review, and it writes to `tasks/plan.md` instead of this repo's `docs/plans/YYYY-MM-DD-*.md`. |
| `using-agent-skills` | A router skill only helps once something loads it — upstream relied on a SessionStart hook we did not take. The routing table in `CLAUDE.md` is always in context and costs less. |
| `shipping-and-launch`, `observability-and-instrumentation` | Premature for a repository with no deployment yet. Revisit once one exists. |
| `browser-testing-with-devtools` | Requires a `chrome-devtools` MCP server that is not configured here. |
| `code-simplification` | The built-in `simplify` skill already covers this. |
| `performance-optimization`, `frontend-ui-engineering`, `api-and-interface-design`, `deprecation-and-migration`, `context-engineering`, `source-driven-development`, `doubt-driven-development`, `idea-refine`, `interview-me` | Not part of this repo's core loop today. Vendor later if a real need appears. |

Of the shared `references/`, only `definition-of-done.md`, `security-checklist.md`, and
`testing-patterns.md` are cited by the vendored skills; the rest were left out.

### Local modifications

- Attribution headers added to each vendored `SKILL.md`.
- `references/…` paths repointed to the shared `../references/` sibling directory.
- Cross-references to skills that were **not** vendored were repointed or removed.
- `documentation-and-adrs` now points at this repo's real ADR location (`docs/adr/`, `NNNN-` prefix)
  instead of the upstream default `docs/decisions/`.
- `test-driven-development` gained a *This repository's commands* section (`verify.sh` targets, the
  self-skip trap for service-backed suites, and the shared contract-suite pattern).
- `security-and-hardening` gained a *Trust boundaries in this repository* section covering the
  sandbox, the auth gate, history isolation, and treating **LLM output as untrusted input**.
- `writing-plans` gained a mandatory `PR boundaries` field in the plan header (see
  [One child per PR](../../docs/sdlc.md#one-child-per-pr)), and its plan review was split into two
  buckets: the reviewer classifies each finding as **mechanical** or **judgment** at source, the
  author applies the mechanical ones and lists them for audit, and the judgment ones block on the
  human. Upstream returned one flat list and escalated all of it.
  It later gained a mandatory `## Criteria coverage` section — a table mapping each spec criterion
  the plan claims to the task that discharges it, plus a `Not claimed` line for the rest — and a
  conditional `Human dependencies` header field, present only when the plan needs a credential,
  account, approval or by-hand operation a person must supply. `planning-reviewer-prompt.md`
  checks both.
- `git-workflow-and-versioning`'s *Working with Worktrees* section was rewritten. Upstream's
  recipe — `git worktree add ../project-feature-a` — produces a tree with no stack slot, no
  `node_modules` and none of this repo's gitignored files, so its ports collide with the main
  checkout's and nothing in it runs. It now routes through `scripts/worktree-new.sh` and states
  when a worktree is warranted (one per child issue) and what bounds the pool at four.
- `references/definition-of-done.md` was rewritten around this repo's actual gates — `verify.sh`,
  the INV-1…8 isolation battery, the mandatory `code-review` + `security-review` pass, and the
  README/`docs/sdlc.md` upkeep rules.

The PR-level code review and security review referenced in `CLAUDE.md` use the built-in
`code-review` and `security-review` skills, not vendored code.

---

MIT License

Copyright (c) 2026 Fareed Khan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
