#!/usr/bin/env bash
# Unit tests for scripts/mutation-decide.mjs. This is where "block AND count" is proven: Survived
# fails, NoCoverage fails, Timeout passes (Stryker counts it as detected), and an UNKNOWN status
# fails rather than being ignored.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-decide.mjs"
tmp="$(mktemp -d)"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

report() { printf '%s' "$1" > "$tmp/r.json"; }
mutant() { printf '{"files":{"src/auth.ts":{"mutants":[{"id":"1","mutatorName":"M","status":"%s","location":{"start":{"line":10}}}]}}}' "$1"; }
passes() { node "$SCRIPT" "$tmp/r.json" >/dev/null 2>&1; }

report "$(mutant Killed)"
if passes; then ok "all killed → exit 0"; else bad "all killed → exit 0" "it exited non-zero"; fi

report "$(mutant Survived)"
if passes; then bad "Survived → exit non-zero" "it exited 0"; else ok "Survived → exit non-zero"; fi

report "$(mutant NoCoverage)"
if passes; then bad "NoCoverage → exit non-zero (the 'count' half)" "it exited 0"
else ok "NoCoverage → exit non-zero (the 'count' half of block-and-count)"; fi

report "$(mutant Timeout)"
if passes; then ok "Timeout → exit 0 (Stryker counts it as detected)"
else bad "Timeout → exit 0" "it exited non-zero"; fi

report "$(mutant SomethingNew)"
if passes; then bad "unknown status → exit non-zero" "it exited 0"; else ok "unknown status → exit non-zero"; fi

report "$(mutant Pending)"
if passes; then bad "Pending → exit non-zero" "it exited 0 — a mutant never run is not evidence"
else ok "Pending → exit non-zero (never run is not the same as killed)"; fi

if node "$SCRIPT" "$tmp/absent.json" >/dev/null 2>&1; then
  bad "missing report → exit non-zero" "it exited 0"
else ok "missing report → exit non-zero"; fi

# A non-empty scope that yields NO mutants is routine, not a fault: a changed line can be a comment,
# an import, a blank line or a type-only declaration. An earlier version exited 1 here, which would
# have blocked any PR whose only edit to an eligible file was a doc comment — with no escape, since
# there is no mutant to suppress. The wiring assurance lives in mutation-gate.test.sh instead.
report '{"files":{}}'
if passes; then ok "zero mutants → exit 0 (comments and imports are not mutable)"
else bad "zero mutants → exit 0" "it exited non-zero — a comment-only change would block"; fi

# The message must NAME the offender — an exit code alone is not actionable.
report "$(mutant Survived)"
out="$(node "$SCRIPT" "$tmp/r.json" 2>&1)"
if printf '%s' "$out" | grep -q 'src/auth.ts:10'; then ok "the failure names file and line"
else bad "the failure names file and line" "got: $out"; fi

rm -rf "$tmp"
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
