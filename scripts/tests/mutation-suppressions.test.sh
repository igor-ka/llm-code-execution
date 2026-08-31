#!/usr/bin/env bash
# A Stryker suppression must carry a reason. Stryker accepts a bare `// Stryker disable next-line
# all`; this repository does not, for the same reason the npm audit gate demands a dated exception
# in the script rather than a silent skip.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-suppressions.sh"
tmp="$(mktemp -d)"; mkdir -p "$tmp/src"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }
write()  { printf '%s\n' "$1" > "$tmp/src/f.ts"; }
passes() { "$SCRIPT" "$tmp/src" >/dev/null 2>&1; }

write 'const a = 1;'
if passes; then ok "no suppressions → exit 0"; else bad "no suppressions → exit 0" "exited non-zero"; fi

write '// Stryker disable next-line all: the retry delay cannot change observable behaviour'
if passes; then ok "suppression with a reason → exit 0"; else bad "suppression with a reason → exit 0" "exited non-zero"; fi

write '// Stryker disable next-line all'
if passes; then bad "bare suppression → exit non-zero" "exited 0"; else ok "suppression with no reason → exit non-zero"; fi

write '// Stryker disable next-line all:   '
if passes; then bad "whitespace-only reason → exit non-zero" "exited 0"; else ok "whitespace-only reason → exit non-zero"; fi

# Fail closed: a missing directory must not read as "every suppression states a reason".
if "$SCRIPT" "$tmp/does-not-exist" >/dev/null 2>&1; then
  bad "a missing directory → exit non-zero" "exited 0 — the gate would pass vacuously"
else ok "a missing directory → exit non-zero"; fi

rm -rf "$tmp"
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
