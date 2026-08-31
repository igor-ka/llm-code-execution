#!/usr/bin/env bash
# Unit tests for scripts/mutation-scope.sh — hunk parsing, eligibility, the cwd-independence of the
# pathspec, and the two hard failures. Builds a throwaway git repository per case so nothing depends
# on this checkout's history.
#
# House style matches scripts/tests/check-conformance.test.sh: `set -uo pipefail` (not -e) and
# counters, so one failing assertion does not hide the rest.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/mutation-scope.sh"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

make_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  mkdir -p "$dir/backend/src/limits" "$dir/backend/src/history"
  cat > "$dir/.mutation-scope.json" <<'JSON'
{ "root": "backend", "include": ["src/limits/", "src/history/"], "exclude": ["src/history/types.ts"] }
JSON
  printf 'const a = 1;\nconst b = 2;\nconst c = 3;\n' > "$dir/backend/src/limits/quota.ts"
  printf 'export type X = 1;\n' > "$dir/backend/src/history/types.ts"
  printf 'ignore me\n' > "$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
  git -C "$dir" branch -q base-ref
  echo "$dir"
}
run_in() { ( cd "$1" && MUTATION_BASE_REF=base-ref "$SCRIPT" ); }
expect() { # <name> <expected> <actual>
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi
}

# 1. A changed line inside an eligible file becomes one component-relative range.
repo="$(make_repo)"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
expect "one changed line becomes one range" "src/limits/quota.ts:2-2" "$(run_in "$repo")"

# 2. A file outside the eligible set produces nothing.
repo="$(make_repo)"
printf 'changed\n' > "$repo/README.md"
git -C "$repo" commit -qam change
expect "an ineligible file yields an empty scope" "" "$(run_in "$repo")"

# 3. Excluded files are skipped even under an eligible directory.
repo="$(make_repo)"
printf 'export type X = 2;\n' > "$repo/backend/src/history/types.ts"
git -C "$repo" commit -qam change
expect "an excluded file is skipped" "" "$(run_in "$repo")"

# 4. A NEW file under an eligible directory is included — new code defaults IN.
repo="$(make_repo)"
printf 'export const f = () => 1;\n' > "$repo/backend/src/limits/newThing.ts"
git -C "$repo" add -A && git -C "$repo" commit -qam add
expect "a new file under an eligible dir is in scope" "src/limits/newThing.ts:1-1" "$(run_in "$repo")"

# 5. A pure deletion emits nothing — there are no new lines to mutate.
repo="$(make_repo)"
printf 'const a = 1;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam delete
expect "a pure deletion yields an empty scope" "" "$(run_in "$repo")"

# 6. An unresolvable base ref is a HARD FAILURE, never an empty scope. This is the likeliest way
#    the gate silently checks nothing (a shallow CI clone).
repo="$(make_repo)"
if ( cd "$repo" && MUTATION_BASE_REF=refs/heads/does-not-exist "$SCRIPT" ) >/dev/null 2>&1; then
  bad "an unresolvable base ref exits non-zero" "it exited 0"
else ok "an unresolvable base ref exits non-zero"; fi

# 7. The pathspec is REPOSITORY-relative, so the same scope comes back from the component dir —
#    which is where verify.sh calls this from. Without ':(top)' the gate silently scopes nothing.
repo="$(make_repo)"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
expect "the pathspec is repository-relative, not cwd-relative" "src/limits/quota.ts:2-2" \
  "$( cd "$repo/backend" && MUTATION_BASE_REF=base-ref "$SCRIPT" )"

# 8. A rename PLUS an edit must still be scoped. With -M git reports it as R, which a
#    --diff-filter of AM alone would drop entirely — every changed line escaping the gate.
repo="$(make_repo)"
git -C "$repo" mv backend/src/limits/quota.ts backend/src/limits/quotas.ts
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quotas.ts"
git -C "$repo" commit -qam rename-and-edit
expect "a rename plus an edit is still scoped" "src/limits/quotas.ts:2-2" "$(run_in "$repo")"

# 9. A MISSING declaration is a hard failure, never an empty scope.
repo="$(make_repo)"
rm "$repo/.mutation-scope.json"
printf 'const a = 1;\nconst b = 99;\nconst c = 3;\n' > "$repo/backend/src/limits/quota.ts"
git -C "$repo" commit -qam change
if run_in "$repo" >/dev/null 2>&1; then
  bad "a missing scope declaration exits non-zero" "it exited 0"
else ok "a missing scope declaration exits non-zero"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
