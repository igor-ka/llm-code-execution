#!/usr/bin/env bash
# END-TO-END NEGATIVE TEST: prove the gate actually fails on a test that cannot detect a bug.
#
# The three unit suites prove the pieces; this proves the WIRING — Stryker really generates mutants,
# really runs vitest against them, really writes the report, and the report really fails the gate.
# Without it the whole target could be a no-op and every check would stay green, which is the
# decorative-assertion pattern the escaped-defect log records this repository shipping more than
# once.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$root/backend/tests/fixtures/mutation-selftest"
strong="$root/backend/.mutation-selftest-strong"
decide="$root/scripts/mutation-decide.mjs"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

# One trap for the whole run: an early failure must not leave the next run starting dirty.
cleanup() { rm -rf "$strong" "$fixture/reports" "$fixture/.stryker-tmp"; }
trap cleanup EXIT

# Clear any stale report FIRST: if this run dies without writing, the assertions below would
# otherwise be made against a previous run's file.
rm -rf "$fixture/reports" "$fixture/.stryker-tmp"
echo "==> Stryker against the deliberately-weak fixture"
( cd "$fixture" && npx --prefix "$root/backend" stryker run ) >/dev/null 2>&1

report="$fixture/reports/mutation/mutation.json"
if [[ ! -f "$report" ]]; then
  bad "the weak fixture produces a report" "no report at $report — the gate's wiring is broken"
else
  ok "the weak fixture produces a report"
  # The whole point: a weak test must leave survivors, and the gate must reject them BY NAME.
  # An exit-code-only check would pass on a gate that failed while telling the engineer nothing.
  out="$(node "$decide" "$report" 2>&1)"
  if [[ $? -eq 0 ]]; then
    bad "a weak test is rejected" "the gate exited 0 — THE GATE IS NOT GATING"
  elif ! printf '%s' "$out" | grep -q 'src/toggle.ts:.*\(Survived\|NoCoverage\)'; then
    bad "the rejection names the survivor" "$(printf '%s' "$out" | head -3)"
  else
    ok "a weak test leaves survivors and the gate names and rejects them"
  fi
fi

# The converse, so the gate is not simply always-red: strengthen the test and it must pass.
#
# UNDER backend/, not in mktemp: Node resolves modules by walking up from the file, so a copy in
# /tmp never reaches backend/node_modules and Stryker's sandbox dies on "Cannot find module
# 'vitest/config'" — no report, and the test would fail for entirely the wrong reason.
echo "==> Stryker against a strengthened copy"
rm -rf "$strong" && mkdir -p "$strong"
cp -R "$fixture/." "$strong/"
rm -rf "$strong/reports" "$strong/.stryker-tmp"
cat > "$strong/toggle.test.ts" <<'TS'
import { it, expect } from "vitest";
import { overLimit } from "./src/toggle.js";
it("is false at the boundary and true above it", () => {
  expect(overLimit(2, 2)).toBe(false);
  expect(overLimit(3, 2)).toBe(true);
});
TS
( cd "$strong" && npx --prefix "$root/backend" stryker run ) >/dev/null 2>&1

if [[ ! -f "$strong/reports/mutation/mutation.json" ]]; then
  bad "the strengthened fixture produces a report" "no report written"
elif ! node "$decide" "$strong/reports/mutation/mutation.json" >/dev/null 2>&1; then
  bad "a boundary-asserting test kills them" "the gate still rejects it — it is always-red"
elif ! node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const all = Object.values(r.files).flatMap((f) => f.mutants);
    process.exit(all.some((m) => m.status === "Killed") ? 0 : 1);
  ' "$strong/reports/mutation/mutation.json"; then
  # An exit-0 from `decide` is not enough: RuntimeError and CompileError are ACCEPTABLE, so a
  # Stryker sandbox that failed to run any test at all would also exit 0 and print "the gate
  # passes" — the decorative assertion this file exists to prevent, in the file itself.
  bad "at least one mutant was actually Killed" "the gate exited 0 with no kill — Stryker ran nothing"
else
  ok "a boundary-asserting test kills them and the gate passes"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
