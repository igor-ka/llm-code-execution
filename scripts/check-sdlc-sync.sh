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

# The three values that vary between repositories. Read from .acb.json at run time rather than
# substituted at render time: this file must stay byte-identical across every consumer, which is
# what makes `acb pull` a copy and `git diff` the review.
#
# A missing config is a HARD failure, not a fallback. process.watched decides what is checked at
# all, so a default would make this gate pass for the wrong reason — the one failure mode a gate
# must not have.
ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
if [[ ! -f "$ACB_CONFIG" ]]; then
  echo "✗ no $ACB_CONFIG — this check needs one. Run 'acb init', or add it by hand." >&2
  exit 1
fi
DOC="$(jq -r '.process.doc' "$ACB_CONFIG")"
# An alternation, not a list: the script greps once, and an alternation is the cheapest way to
# say "any of these" to grep -E.
WATCHED_RE="$(jq -r '[.process.watched[]] | join("|")' "$ACB_CONFIG")"
HATCH="$(jq -r '.process.sdlcSyncHatch // "[skip-sdlc-sync]"' "$ACB_CONFIG")"

if [[ "${PR_TITLE:-}" == *"$HATCH"* ]]; then
  echo "==> $HATCH found in the PR title — skipping the ${DOC} check."
  exit 0
fi

# Dependabot's `github-actions` ecosystem bumps `uses:` pins inside .github/workflows/*.yml,
# which is a watched path — so without this every action update would fail a required check
# that a bot can never satisfy. A pin bump is not a process change.
#
# This is an early `exit 0` rather than a job-level `if:` in sdlc-docs.yml on purpose — but NOT
# because a skipped job would block the merge. It would not: GitHub reports a job skipped by an
# `if:` as Success, and it satisfies a required check. (The case that does hang forever is a
# workflow-level path or branch filter, where the check never reports at all.)
#
# The real reasons are that a job-level `if:` would also skip the Self-test step — so the suite
# guarding this very exemption would not run on the PRs the exemption exists for — and that a
# skipped job says nothing in the checks list, while this prints why it passed.
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
  echo "  For a genuine no-op (typo in a skill, comment reflow), put ${HATCH} in"
  echo "  the PR title. That stays visible in the PR list rather than silently bypassing."
  echo
} >&2
exit 1
