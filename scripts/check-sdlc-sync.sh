#!/usr/bin/env bash
# docs/sdlc.md documents this repository's development process, and that document is a
# contract: a change to the process must update the document in the same PR. This script
# is the enforcement behind that contract (see "Changing this SDLC" in docs/sdlc.md).
#
# It is a *diff-level* check — it compares a PR against its base ref — which is why it
# lives here rather than in backend/verify.sh or frontend/verify.sh. Those two scripts
# mirror CI exactly for the checks that can run against a single working tree; this one
# has no meaningful local equivalent because there is no base ref to compare against.
#
# Usage:  scripts/check-sdlc-sync.sh
#   BASE_SHA   base commit to diff against (default: merge-base with origin/main)
#   PR_TITLE   pull request title; containing [skip-sdlc-sync] skips the check
set -euo pipefail

cd "$(dirname "$0")/.."

# Files whose change means the development process itself changed.
WATCHED_RE='^(\.claude/skills/|backend/verify\.sh$|frontend/verify\.sh$|\.github/workflows/ci\.yml$)'
DOC='docs/sdlc.md'

if [[ "${PR_TITLE:-}" == *"[skip-sdlc-sync]"* ]]; then
  echo "==> [skip-sdlc-sync] found in the PR title — skipping the SDLC doc check."
  exit 0
fi

base="${BASE_SHA:-}"
if [[ -z "$base" ]]; then
  if ! base="$(git merge-base HEAD origin/main 2>/dev/null)"; then
    echo "==> cannot resolve a base ref (no BASE_SHA, no origin/main) — skipping." >&2
    exit 0
  fi
fi

changed="$(git diff --name-only "$base"...HEAD)"
watched="$(printf '%s\n' "$changed" | grep -E "$WATCHED_RE" || true)"

if [[ -z "$watched" ]]; then
  echo "✓ no SDLC-governed files changed; ${DOC} not required."
  exit 0
fi

if printf '%s\n' "$changed" | grep -qxF "$DOC"; then
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
