# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A learning project: a React + Vite frontend and a FastAPI backend that asks Claude whether
a prompt needs code, generates it if so, and runs it in a hardened, ephemeral Docker sandbox
behind a swappable `SandboxBackend` interface. See `README.md` for architecture and layout.

## Checks before pushing

Each side has one script that mirrors CI exactly — run it from that directory:

- Backend: `cd backend && ./verify.sh`
- Frontend: `cd frontend && ./verify.sh`

Both accept `SKIP_INSTALL=1` and `SKIP_DOCKER=1`. CI runs these same scripts, so never add
a check to CI without adding it to the matching `verify.sh` (and vice versa).

## Review process

Every PR and every plan goes through a thorough review. These reviews are not optional and
are never skipped because a change "looks small." Use the skills below — don't hand-roll the
review.

**Every PR — code review *and* security review.** Before a PR is ready for me, run both
against the pending diff:

- `code-review` skill — correctness, reuse, simplification, efficiency.
- `security-review` skill — security review of the pending changes.

Then **incorporate the findings back into the PR** before handing it over. Don't apply
feedback blindly: evaluate each item with the `receiving-code-review` skill (verify against
the codebase, push back with technical reasoning when a finding is wrong), then fix what's
real and push the result.

**Every plan — staff-engineer review.** Before writing code from a plan, run the staff-engineer
plan review via the `writing-plans` skill (vendored in `.claude/skills/`), which dispatches a
fresh subagent reviewer using `planning-reviewer-prompt.md`. **Surface the review to me first
and wait** — present the reviewer's report with your own opinionated take and do **not** fold
the findings into the plan until I've seen them. I decide what goes into the plan.

The plan-review skills are adapted from a community project; see `.claude/skills/NOTICE.md` for
provenance and what was deliberately left out. `code-review` and `security-review` are built-in
skills, not vendored.

## Don't assume — surface it

If anything about a request is ambiguous, don't guess. State your assumptions and check with me
before proceeding. High-stakes ambiguity (architecture, security posture, scope, anything hard
to reverse) is always worth a question first.

## Documentation upkeep

When a change alters anything documented in `README.md` — commands, project layout,
verification/setup steps, security posture, or the roadmap — update `README.md` in the
**same change**. Keep this judgment tight: edit the README only when a reader following it
would otherwise be misled. Do **not** touch it for internal-only refactors that change
nothing a README reader relies on.

## CI job names are a contract

The "Protect main" ruleset requires status checks by job name (`Backend checks`,
`Frontend checks`). Renaming or removing a CI job breaks merges until the ruleset's required
checks are updated to match. Change what runs *inside* a job freely; keep its name stable, or
update the ruleset in the same PR.
