#!/usr/bin/env bash
# Unit tests for the *early-exit* branches of scripts/check-sdlc-sync.sh — the
# [skip-sdlc-sync] title hatch and the dependabot[bot] actor exemption. Both return before any
# git state is consulted, so environment variables are the entire input.
#
# The base-resolution logic below those branches is deliberately not covered: it needs merge
# refs and a moving base to exercise, which is a fixture harness this issue does not need.
#
# Positive cases assert stdout *and* exit code: every early exit returns 0 and so does "no
# SDLC-governed files changed", so an exit code alone cannot distinguish a working exemption
# from a silent fall-through.
#
# Negative cases assert the exemption line is ABSENT and ignore the exit code. Asserting on
# what the script prints past the early exits would be reading this worktree's diff against
# its base — which differs between a local checkout and CI's merge ref, and on a branch that
# touches watched files is red by construction.
set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT="./check-sdlc-sync.sh"
EXEMPT_LINE="author is dependabot[bot]"

pass=0
fail=0

run() { PR_TITLE="$1" PR_ACTOR="$2" "$SCRIPT" 2>&1; }

ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; printf '%s\n' "$3" | sed 's/^/      /'; }

# asserts <name> <expected-exit> <expected-stdout-substring> <PR_TITLE> <PR_ACTOR>
#
# `local name=... got out` declares on its own line, and the capture is a separate statement.
# Do NOT tidy this into `local out="$(...)"`: in that form `$?` is `local`'s status, which is
# always 0, and every positive case below would pass vacuously.
asserts() {
  local name="$1" want="$2" needle="$3" title="$4" actor="$5" got out
  out="$(run "$title" "$actor")"
  got=$?
  if [[ "$got" -eq "$want" && "$out" == *"$needle"* ]]; then
    ok "$name"
  else
    bad "$name" "expected exit ${want} and stdout containing '${needle}', got exit ${got}" "$out"
  fi
}

# refutes <name> <PR_TITLE> <PR_ACTOR> — the exemption must NOT have fired. Exit code ignored
# on purpose; see the header.
refutes() {
  local name="$1" title="$2" actor="$3" out
  out="$(run "$title" "$actor")"
  if [[ "$out" != *"$EXEMPT_LINE"* ]]; then
    ok "$name"
  else
    bad "$name" "the dependabot exemption fired and should not have" "$out"
  fi
}

echo "check-sdlc-sync.sh (early exits)"

asserts "the [skip-sdlc-sync] title hatch exits 0" \
  0 "skip-sdlc-sync" "chore: reflow a comment [skip-sdlc-sync]" "igor-ka"

asserts "a dependabot PR is exempt" \
  0 "$EXEMPT_LINE" "chore(deps): bump actions/checkout from 4 to 5" "dependabot[bot]"

asserts "the hatch still works for a bot-shaped title from a human" \
  0 "skip-sdlc-sync" "chore(deps): bump something [skip-sdlc-sync]" "igor-ka"

# The exemption must be exact. A human whose title mentions the bot is not Dependabot, and
# neither is a lookalike account name.
refutes "a human author is not exempt" "chore(deps): mimic dependabot[bot]" "igor-ka"

refutes "a lookalike actor is not exempt" "chore(deps): bump something" "dependabot"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "✗ ${fail} failed, ${pass} passed"
  exit 1
fi
echo "✓ ${pass} passed"
