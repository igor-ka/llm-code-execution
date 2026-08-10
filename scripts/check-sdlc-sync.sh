#!/usr/bin/env bash
# docs/sdlc.md documents this repository's development process, and that document is a
# contract: a change to the process must update the document in the same PR. This script
# is the enforcement behind that contract (see "Changing this SDLC" in docs/sdlc.md).
#
# It is a *diff-level* check — it compares a PR against its base — which is why it lives
# here rather than in backend/verify.sh or frontend/verify.sh. Those two scripts mirror CI
# exactly for checks that run against a single working tree; this one has no meaningful
# local equivalent because there is no base ref to compare against.
#
# Usage:  scripts/check-sdlc-sync.sh
#   BASE_SHA   fallback base commit (default: merge-base with origin/main)
#   PR_TITLE   pull request title; containing [skip-sdlc-sync] skips the check
#   PR_ACTOR   pull request author login; dependabot[bot] is exempt (see below)
set -euo pipefail

cd "$(dirname "$0")/.."

# Files whose change means the development process itself changed. This deliberately includes
# all of scripts/: docs/sdlc.md documents the exact semantics of the checks that live there
# (watched paths, failure messages, escape hatches), so changing one without updating the doc
# would let the documentation silently desync from the enforcement it describes.
WATCHED_RE='^(\.claude/skills/|\.github/workflows/|scripts/|backend/verify\.sh$|frontend/verify\.sh$)'
DOC='docs/sdlc.md'

if [[ "${PR_TITLE:-}" == *"[skip-sdlc-sync]"* ]]; then
  echo "==> [skip-sdlc-sync] found in the PR title — skipping the SDLC doc check."
  exit 0
fi

# Dependabot's `github-actions` ecosystem bumps `uses:` pins inside .github/workflows/*.yml,
# which is a watched path — so without this every action update would fail a required check
# that a bot can never satisfy. A pin bump is not a process change.
#
# This is an early `exit 0` rather than a job-level `if:` in sdlc-docs.yml on purpose. `SDLC
# docs` is a *required* status check; a skipped job does not report success, and a required
# check that never reports success blocks the merge permanently. The job must run and pass.
#
# The actor is exact-matched. PR_ACTOR comes from github.event.pull_request.user.login, which
# GitHub sets and a contributor cannot forge, and it arrives via `env:` like the title.
if [[ "${PR_ACTOR:-}" == "dependabot[bot]" ]]; then
  echo "==> author is dependabot[bot] — dependency bumps are exempt from the SDLC doc check."
  exit 0
fi

# Resolving the base is the subtle part. On `pull_request`, actions/checkout leaves the PR
# *merge* ref at HEAD: a merge commit whose first parent is the base tip and whose second is
# the PR head. Diffing that first parent is exact. Diffing the event payload's base.sha is
# NOT — it is the base tip as of the last push, so once main advances (or the job is re-run)
# the range swallows everything merged in between, which both fails PRs for files their
# author never touched and passes PRs whose docs/sdlc.md was updated by someone else.
if git rev-parse --verify --quiet HEAD^2 >/dev/null 2>&1; then
  base="$(git rev-parse HEAD^1)"
else
  base="${BASE_SHA:-}"
  if [[ -z "$base" ]]; then
    if ! base="$(git merge-base HEAD origin/main 2>/dev/null)"; then
      echo "==> cannot resolve a base ref (no merge ref, no BASE_SHA, no origin/main) — skipping." >&2
      exit 0
    fi
  fi
  # Normalise to the fork point so the comparison ignores commits already on the base.
  base="$(git merge-base "$base" HEAD)"
fi

changed="$(git diff --name-only "$base" HEAD)"
watched="$(printf '%s\n' "$changed" | grep -E "$WATCHED_RE" || true)"

if [[ -z "$watched" ]]; then
  echo "✓ no SDLC-governed files changed; ${DOC} not required."
  exit 0
fi

# Herestring rather than a pipe: `grep -q` exits on first match, and under `pipefail` the
# SIGPIPE'd writer (exit 141) would become the pipeline's status on a large diff — reporting
# the doc as missing when it was in fact updated.
if grep -qxF "$DOC" <<<"$changed"; then
  echo "✓ SDLC-governed files changed and ${DOC} was updated in the same change:"
  printf '%s\n' "$watched" | sed 's/^/    /'
  exit 0
fi

{
  echo
  echo "✗ ${DOC} is out of sync with this change."
  echo
  echo "  These files change the development process:"
  printf '%s\n' "$watched" | sed 's/^/      /'
  echo
  echo "  ${DOC} documents that process and is a contract — see its \"Changing this SDLC\""
  echo "  section. Update it in this PR so the documented process matches the real one."
  echo
  echo "  For a genuine no-op (typo in a skill, comment reflow), put [skip-sdlc-sync] in"
  echo "  the PR title. That stays visible in the PR list rather than silently bypassing."
  echo
} >&2
exit 1
