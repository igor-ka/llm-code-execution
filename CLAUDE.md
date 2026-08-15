# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A learning project: a React + Vite frontend and an Express + TypeScript backend that asks
Claude whether a prompt needs code, generates it if so, and runs it in a hardened, ephemeral
Docker sandbox behind a swappable `SandboxBackend` interface. Per-user chat history sits
behind a second seam, `HistoryStore` (in-memory + Postgres). See `README.md` for architecture
and layout.

## Development lifecycle

`docs/sdlc.md` is the full process — phases, gates, how it meets CI, and a worked example.
**It is a contract:** if you change `.claude/skills/**`, any of the three `verify.sh` scripts,
`infra/tests/**`, `.github/workflows/**`, or anything in `scripts/`, update `docs/sdlc.md` in
the same PR.
The `SDLC docs` CI job enforces this; `[skip-sdlc-sync]` in the PR title is the escape hatch
for a genuine no-op.

Which skill when — all vendored in `.claude/skills/`, loaded on demand:

| When | Skill |
| --- | --- |
| Requirements are vague or scope is unclear | `spec-driven-development` |
| Turning requirements into ordered tasks | `writing-plans` (plan review is mandatory — see below) |
| Writing any logic, or fixing any bug | `test-driven-development` |
| Any change touching more than one file | `incremental-implementation` |
| Touching `backend/src/{auth.ts,history/**,sandbox/**}` or `backend/sandbox-image/**` | `security-and-hardening` (threat-model first) |
| Touching `infra/**` | `security-and-hardening` (threat-model first) — IAM, federation and secrets live here |
| Tests fail, builds break, behaviour surprises | `debugging-and-error-recovery` |
| Committing, branching, versioning | `git-workflow-and-versioning` |
| A decision worth preserving; README/ADR upkeep | `documentation-and-adrs` (ADRs → `docs/adr/`) |
| Receiving review findings | `receiving-code-review` |

The standing bar every change clears before it counts as done is
`.claude/skills/references/definition-of-done.md`.

## Work each child issue in its own worktree

**Start every child issue of a plan in a git worktree, created with `scripts/worktree-new.sh
<slug> [branch]` from the main checkout.** Not for answering a question, a one-line doc fix, or
anything that will not become its own PR — those stay in the main checkout.

**Always that script — never a bare `git worktree add`, and never the built-in worktree tool.**
Both create a directory with no stack slot, no `node_modules`, and none of the gitignored files a
worktree cannot inherit, so its ports collide with the main checkout's and nothing in it runs. The
script allocates a slot, links `.env.shared` and `.claude/settings.local.json`, generates `.env`
and `frontend/.env.local`, and installs both sides.

Why this is a rule and not a preference: several sessions share this checkout, and one switching
branches mid-task moves HEAD under another. A worktree per slice makes that impossible, and each
one gets its own stack — see *Parallel worktrees* in `README.md` for the slot table. The pool is
four (main plus three), bounded by the origins registered in Auth0.

When the PR merges, free the slot: `docker compose down` in the worktree, then `git worktree
remove <path>` and `git branch -D <branch>` from the main checkout.

## Checks before pushing

Each side has one script that mirrors CI exactly — run it from that directory:

- Backend: `cd backend && ./verify.sh`
- Frontend: `cd frontend && ./verify.sh`
- Infra: `cd infra && ./verify.sh`

The backend and frontend scripts accept `SKIP_INSTALL=1` and `SKIP_DOCKER=1`; the infra script
takes neither — it has no install step and builds no image. CI runs these same scripts, so never
add a check to CI without adding it to the matching `verify.sh` (and vice versa).

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
fresh subagent reviewer using `planning-reviewer-prompt.md`. The reviewer sorts its own findings
into two buckets. **Mechanical** ones — wrong paths, name mismatches, placeholders, a missing test
or verification step — you apply, then list explicitly so I can reverse them. **Judgment** ones —
scope, cost, risk, architecture, the security invariants, anything either of you is unsure about —
you do **not** touch: surface them with your own opinionated take and **wait**. When in doubt,
escalate. I decide what goes into the plan, and implementation doesn't start until I've responded.

**One child per PR.** A PR closes at most one issue; the `PR shape` job enforces it and
`[multi-child]` in the title is the visible exception. The decision belongs earlier — every plan
header names its PR boundaries and the staff review checks them. See
[`docs/sdlc.md`](docs/sdlc.md).

Every skill in `.claude/skills/` is **vendored** — copied in, adapted to this repo, pinned to an
upstream commit, and reviewed in-diff. No plugin marketplace is wired into this repository and
nothing is fetched at runtime. See `.claude/skills/NOTICE.md` for both upstreams, their pinned
commits, the local modifications, and what was deliberately left out. Treat a change to a skill
as a code change — prompts are behaviour. `code-review` and `security-review` are built-in
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
`Frontend checks`, `SDLC docs`, `PR shape`, `Terraform checks`). Renaming or removing a CI job
breaks merges until the ruleset's required checks are updated to match. Change what runs *inside* a job freely; keep
its name stable, or update the ruleset in the same PR.

`SDLC docs` and `PR shape` (PRs only, each in its own workflow) are the two deliberate exceptions
to the `verify.sh` mirroring rule above: one diffs a PR against its base, the other reads the PR
body, and neither has a single-working-tree equivalent.
