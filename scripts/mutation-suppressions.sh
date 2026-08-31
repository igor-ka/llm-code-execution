#!/usr/bin/env bash
# Every Stryker suppression must state WHY no test can kill the mutant. Stryker itself accepts a
# bare `// Stryker disable next-line all`; this repository does not, for the same reason the npm
# audit gate demands a dated exception written where review can see it.
#
# NOTE the `if grep …; then exit 1; fi` form rather than `! grep -q …`. POSIX exempts a command
# negated with `!` from `set -e`, so the negated form does not abort — that exact mistake shipped
# here once, and is recorded in the escaped-defect log.
set -euo pipefail

# With no argument, derive the directories to scan from the same declaration the scope script reads,
# so widening `.mutation-scope.json` cannot leave suppressions in the new area unpoliced. An
# explicit argument overrides it, which is what the unit tests use.
#
# The scanned paths come from `include`, NOT from `root`: root is the component directory, and
# scanning it would sweep node_modules — which ships third-party `// Stryker disable all` comments
# and would fail the gate on someone else's code.
dirs=()
if [[ $# -gt 0 ]]; then
  dirs=("$@")
else
  config="${MUTATION_SCOPE_CONFIG:-$(git rev-parse --show-toplevel)/.mutation-scope.json}"
  [[ -f "$config" ]] || { echo "mutation-suppressions: no scope declaration at $config" >&2; exit 1; }
  root_dir="$(git rev-parse --show-toplevel)"
  while IFS= read -r d; do [[ -n "$d" ]] && dirs+=("$root_dir/$d"); done < <(node -e '
    const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof cfg.root !== "string" || cfg.root === "") { console.error("root must be a non-empty string"); process.exit(1); }
    if (!Array.isArray(cfg.include)) { console.error("include must be an array"); process.exit(1); }
    // The first path segment of each include entry, deduped: "src/auth.ts" and "src/limits/" both
    // yield "src", so the scan covers the eligible area without reaching node_modules.
    const tops = new Set(cfg.include.map((i) => i.split("/")[0]).filter(Boolean));
    for (const t of tops) console.log(cfg.root + "/" + t);
  ' "$config")
  [[ ${#dirs[@]} -gt 0 ]] || { echo "mutation-suppressions: the declaration names no directories to scan" >&2; exit 1; }
fi


# Fail closed on a missing directory. Without this the grep finds nothing, `|| true` swallows the
# error, and the gate reports "every suppression states a reason" about a directory that is absent.
for d in "${dirs[@]}"; do
  [[ -d "$d" ]] || { echo "mutation-suppressions: no such directory: $d" >&2; exit 1; }
done

# A suppression with a reason looks like `// Stryker disable next-line all: <non-blank text>`.
# Anything matching "Stryker disable" that does NOT match that shape is unexplained.
offenders="$(grep -rn 'Stryker disable' "${dirs[@]}" 2>/dev/null \
  | grep -vE 'Stryker disable [^:]*:[[:space:]]*[^[:space:]]' || true)"

if [[ -n "$offenders" ]]; then
  echo "mutation-suppressions: suppression(s) with no reason:" >&2
  printf '%s\n' "$offenders" >&2
  echo "  Write why no test can kill it: // Stryker disable next-line <mutator>: <reason>" >&2
  exit 1
fi

echo "mutation-suppressions: every suppression states a reason."
