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
