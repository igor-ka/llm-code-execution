#!/usr/bin/env bash
# Emit Stryker `mutate` patterns — one `path:start-end` per line, relative to the component root —
# for the lines this branch changes inside the mutation-eligible file set.
#
# THE ELIGIBLE SET IS DECLARED, NOT HARD-CODED, and that is a constraint this repository inherits
# from acb: a gate script byte-identical across consumers can be carried by `cp` and diffed against
# every one of them, while a script carrying a repo-specific list can never be. Variation belongs in
# a declaration read at RUNTIME. Today that is .mutation-scope.json; folding it into .acb.json needs
# an upstream schema change, and this script would not change.
#
# Read with node rather than jq: jq is on every GitHub runner but not on every laptop, and unlike
# acb's existing gate scripts this one has a local equivalent developers run in the inner loop.
# Node is already a hard dependency here — scripts/mutation-decide.mjs is node.
#
# Output is EMPTY when the change touches nothing eligible. That is a legitimate pass, and the
# caller must SAY SO rather than printing a bare success: an empty scope and a silent pass look
# identical in a log.
set -euo pipefail

BASE_REF="${MUTATION_BASE_REF:-origin/main}"
CONFIG="${MUTATION_SCOPE_CONFIG:-$(git rev-parse --show-toplevel)/.mutation-scope.json}"

# A missing declaration is a FAILURE, never an empty scope: an absent config and a change that
# touches nothing eligible must not look the same to the caller.
if [[ ! -f "$CONFIG" ]]; then
  echo "mutation-scope: no scope declaration at ${CONFIG}" >&2
  exit 1
fi

config_key() {
  node -e '
    const fs = require("node:fs");
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { console.error("mutation-scope: invalid JSON in " + process.argv[1] + ": " + e.message); process.exit(1); }
    const key = process.argv[2];
    const v = cfg[key];
    if (key === "root") {
      if (typeof v !== "string" || v === "") { console.error("mutation-scope: root must be a non-empty string"); process.exit(1); }
      console.log(v);
    } else {
      // NOT `return` in the branch above: `node -e` evaluates at module top level, where a return
      // is a SyntaxError and the script would die on its very first call.
      if (!Array.isArray(v)) { console.error("mutation-scope: " + key + " must be an array"); process.exit(1); }
      for (const x of v) console.log(x);
    }
  ' "$CONFIG" "$1"
}

ROOT="$(config_key root)"          # the COMPONENT dir, e.g. "backend" — Stryker's cwd
INCLUDE=(); EXCLUDE=()
while IFS= read -r line; do [[ -n "$line" ]] && INCLUDE+=("$line"); done <<< "$(config_key include)"
while IFS= read -r line; do [[ -n "$line" ]] && EXCLUDE+=("$line"); done <<< "$(config_key exclude)"
[[ ${#INCLUDE[@]} -gt 0 ]] || { echo "mutation-scope: include is empty — nothing would ever be gated" >&2; exit 1; }

# An `include` entry ending in `/` is a directory prefix: everything under it is eligible, so a file
# ADDED there later is in scope by default. That is the fail-safe direction — forgetting to update
# the declaration over-tests rather than under-tests.
#
# EXCLUDE matches an exact path only, while INCLUDE also honours a trailing '/' as a prefix. That
# asymmetry is deliberate — every exclusion so far is a single named file, and a prefix exclude is
# the kind of blunt instrument that quietly removes a directory from the gate. If one is ever
# needed, add the case here rather than assuming `exclude: ["src/history/"]` does anything: today
# it silently matches nothing.
# `${a[@]+"${a[@]}"}` on EXCLUDE, not a bare `"${EXCLUDE[@]}"`. macOS ships bash 3.2.57, where
# expanding an EMPTY array under `set -u` aborts with "unbound variable" — and an empty or absent
# `exclude` is a legitimate declaration, and the natural starting value for any repository adopting
# this script. INCLUDE needs no guard: it is checked non-empty above.
eligible() {
  local path="$1" pat
  for pat in ${EXCLUDE[@]+"${EXCLUDE[@]}"}; do [[ "$path" == "$ROOT/$pat" ]] && return 1; done
  for pat in "${INCLUDE[@]}"; do
    case "$pat" in
      */) [[ "$path" == "$ROOT/$pat"* ]] && return 0 ;;
      *)  [[ "$path" == "$ROOT/$pat"  ]] && return 0 ;;
    esac
  done
  return 1
}

# A merge base that cannot be resolved is a HARD FAILURE. `actions/checkout` shallow-clones by
# default, and without fetch-depth: 0 this is exactly how the gate ends up checking nothing while
# reporting success.
if ! merge_base="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)"; then
  echo "mutation-scope: cannot resolve a merge base between '${BASE_REF}' and HEAD." >&2
  echo "  In CI this usually means actions/checkout needs fetch-depth: 0." >&2
  exit 1
fi

# UNTRACKED FILES ARE A HARD FAILURE, not an empty scope. `git diff` only sees tracked files, so a
# brand-new source file that has not been `git add`ed contributes nothing — and the REFACTOR step,
# where this target is meant to run, is exactly when a new file is most likely still untracked. A
# green gate on a file with no tests at all is the worst outcome this design can produce, so it
# refuses to run instead. Same fail-loud posture as a missing merge base and a missing declaration.
untracked="$(git ls-files --others --exclude-standard -- ":(top)${ROOT}")"
if [[ -n "$untracked" ]]; then
  echo "mutation-scope: untracked file(s) under ${ROOT} — git diff cannot see them:" >&2
  printf '  %s\n' $untracked >&2
  echo "  git add them (or remove them) so the gate can measure the change it is gating." >&2
  exit 1
fi

# --unified=0 so each hunk header covers only changed lines, never context.
#
# ':(top)' makes the pathspec REPOSITORY-relative, and it is load-bearing. A bare 'backend' resolves
# against the CALLER's cwd, and backend/verify.sh cds to backend/ before invoking this — so it would
# match `backend/backend`, emit nothing, and the gate would report "no mutable lines" on every real
# run while its unit tests (which run from the repo root) stayed green.
#
# --diff-filter=AMR keeps additions, modifications and RENAMES. The R is load-bearing too: with -M
# on, a rename-plus-edit is reported as R, so filtering to AM alone drops every changed line in a
# moved file. That fails OPEN.
#
# -M enables rename detection, and settles the move-only case in passing: a PURE rename produces no
# hunks at all, so a move-only PR generates no mutants rather than re-mutating every moved line.
git diff --unified=0 --diff-filter=AMR -M "$merge_base" -- ":(top)${ROOT}" \
| awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^@@ / {
      plus = $3                      # the "+c,d" field
      sub(/^\+/, "", plus)
      n = split(plus, r, ",")
      start = r[1] + 0
      len   = (n < 2 ? 1 : r[2] + 0)
      if (len == 0) next             # pure deletion: no new lines exist to mutate
      printf "%s\t%d\t%d\n", file, start, start + len - 1
    }
  ' \
| while IFS=$'\t' read -r path start end; do
    eligible "$path" || continue
    # Stryker runs with cwd = the component root, so emit paths relative to it.
    printf '%s:%s-%s\n' "${path#"$ROOT"/}" "$start" "$end"
  done
