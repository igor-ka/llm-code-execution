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

cd "$(dirname "$0")/.." || exit 1
SCRIPT="./check-sdlc-sync.sh"
EXEMPT_LINE="author is dependabot[bot]"

pass=0
fail=0

# The script now reads its knobs from .acb.json, so the suite supplies one. It pins the same
# watched set the table below asserts against — the table's job shifts from "this repository's
# path list is right" to "the alternation jq builds from process.watched behaves", which is the
# right test to carry once the list belongs to the consumer.
CFGDIR="$(mktemp -d)"
trap 'rm -rf "$CFGDIR"' EXIT
cat > "$CFGDIR/.acb.json" <<'JSON'
{ "template": { "repo": "example/repo", "commit": "0" },
  "process": {
    "doc": "docs/sdlc.md",
    "sdlcSyncHatch": "[skip-sdlc-sync]",
    "watched": [
      "^\\.claude/skills/", "^\\.github/workflows/", "^scripts/",
      "^backend/verify\\.sh$", "^frontend/verify\\.sh$", "^infra/verify\\.sh$",
      "^infra/tests/"
    ]
  },
  "components": [] }
JSON
export ACB_CONFIG="$CFGDIR/.acb.json"

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

# refutes <name> <PR_TITLE> <PR_ACTOR> — the exemption must NOT have fired.
#
# The script's *verdict* is ignored: 0 and 1 are both fine here, because whether the doc is in
# sync depends on the branch's own diff and this assertion must not.
#
# But it must have RUN. Absence of the exemption line is trivially true when nothing executed —
# a renamed script exits 127 with only bash's own error captured, and the case would report ✓
# while testing nothing. So the exit code is checked for plausibility (0 or 1, the script's two
# real verdicts) and the output for non-emptiness. Same vacuity the header warns about for
# `asserts`, reached from the other side.
refutes() {
  local name="$1" title="$2" actor="$3" got out
  out="$(run "$title" "$actor")"
  got=$?
  if [[ "$got" -le 1 && -n "$out" && "$out" != *"$EXEMPT_LINE"* ]]; then
    ok "$name"
  else
    bad "$name" "expected the script to run (exit 0 or 1, non-empty) without the exemption line, got exit ${got}" "$out"
  fi
}

echo "check-sdlc-sync.sh (early exits)"

asserts "the [skip-sdlc-sync] title hatch exits 0" \
  0 "skip-sdlc-sync" "chore: reflow a comment [skip-sdlc-sync]" "a-human"

asserts "a dependabot PR is exempt" \
  0 "$EXEMPT_LINE" "chore(deps): bump actions/checkout from 4 to 5" "dependabot[bot]"

asserts "the hatch still works for a bot-shaped title from a human" \
  0 "skip-sdlc-sync" "chore(deps): bump something [skip-sdlc-sync]" "a-human"

# The exemption must be exact. A human whose title mentions the bot is not Dependabot, and
# neither is a lookalike account name.
refutes "a human author is not exempt" "chore(deps): mimic dependabot[bot]" "a-human"

refutes "a lookalike actor is not exempt" "chore(deps): bump something" "dependabot"

# This case pins the QUOTING of the comparison, not the comparison. In [[ x == y ]] the
# right-hand side is a glob unless quoted, so an unquoted `== dependabot[bot]` would read
# `[bot]` as a character class matching one of b/o/t — making `dependabott` (a registerable
# GitHub username) exempt from a required check. Correct today; this is what keeps it correct.
refutes "a glob-collision actor is not exempt" "chore(deps): bump something" "dependabott"

# --- WATCHED_RE ---
#
# The path list is the other half of this script's contract, and until now nothing checked it: a
# typo in the alternation (a missing backslash, a stray anchor) silently un-watches a path and
# the failure mode is invisible — PRs go green that should have been red.
#
# Built the same way the script builds it — from the fixture config, through the same jq
# expression — rather than scraped out of the source. Scraping was correct while the pattern was
# a literal assignment; it is now a jq call, and a scrape would yield empty. An empty pattern
# matches everything, which would invert every `unwatched` case below into a silent pass.
WATCHED_RE="$(jq -r '[.process.watched[]] | join("|")' "$ACB_CONFIG")"
if [[ -z "$WATCHED_RE" ]]; then
  bad "WATCHED_RE extraction" "could not parse WATCHED_RE out of $SCRIPT" ""
fi

# Herestrings, not pipes, for the same reason check-sdlc-sync.sh:78-81 already documents: `grep -q`
# exits on first match, the writer takes SIGPIPE and returns 141, and this file's `pipefail`
# (line 17) makes 141 the pipeline's status. In `unwatched()` that inverts to a pass — a gate that
# cannot fail. The repo has paid for this lesson once already.

# watched <name> <path> — the path must be governed by the SDLC contract.
watched() {
  if grep -Eq "$WATCHED_RE" <<<"$2"; then
    ok "$1"
  else
    bad "$1" "expected '$2' to be watched" ""
  fi
}

# unwatched <name> <path> — the path must NOT drag docs/sdlc.md into every change.
unwatched() {
  if grep -Eq "$WATCHED_RE" <<<"$2"; then
    bad "$1" "expected '$2' NOT to be watched" ""
  else
    ok "$1"
  fi
}

watched   "backend/verify.sh is watched"        "backend/verify.sh"
watched   "frontend/verify.sh is watched"       "frontend/verify.sh"
watched   "infra/verify.sh is watched"          "infra/verify.sh"
watched   "infra/tests/ is watched"             "infra/tests/gates.test.sh"
watched   "workflows are watched"               ".github/workflows/terraform.yml"
watched   "scripts/ is watched"                 "scripts/check-sdlc-sync.sh"

# The Terraform CONFIG is not a process change. Watching all of infra/ would force a docs/sdlc.md
# edit on every resource added for the rest of the project's life, and a contract that fires on
# everything is one people learn to bypass.
unwatched "infra/*.tf is not watched"           "infra/wif.tf"
unwatched "infra/bootstrap.sh is not watched"   "infra/bootstrap.sh"
unwatched "backend source is not watched"       "backend/src/log.ts"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "✗ ${fail} failed, ${pass} passed"
  exit 1
fi
echo "✓ ${pass} passed"
