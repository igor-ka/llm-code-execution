#!/usr/bin/env bash
# Every Stryker suppression must state WHY no test can kill the mutant. Stryker itself accepts a
# bare `// Stryker disable next-line all`; this repository does not, for the same reason the npm
# audit gate demands a dated exception written where review can see it.
#
# NOTE the `if grep …; then exit 1; fi` form rather than `! grep -q …`. POSIX exempts a command
# negated with `!` from `set -e`, so the negated form does not abort — that exact mistake shipped
# here once and is an entry in docs/escaped-defects.md.
set -euo pipefail

dir="${1:-src}"

# Fail closed on a missing directory. Without this the grep finds nothing, `|| true` swallows the
# error, and the gate reports "every suppression states a reason" about a directory that is absent.
[[ -d "$dir" ]] || { echo "mutation-suppressions: no such directory: $dir" >&2; exit 1; }

# A suppression with a reason looks like `// Stryker disable next-line all: <non-blank text>`.
# Anything matching "Stryker disable" that does NOT match that shape is unexplained.
offenders="$(grep -rn 'Stryker disable' "$dir" 2>/dev/null \
  | grep -vE 'Stryker disable [^:]*:[[:space:]]*[^[:space:]]' || true)"

if [[ -n "$offenders" ]]; then
  echo "mutation-suppressions: suppression(s) with no reason:" >&2
  printf '%s\n' "$offenders" >&2
  echo "  Write why no test can kill it: // Stryker disable next-line <mutator>: <reason>" >&2
  exit 1
fi

echo "mutation-suppressions: every suppression states a reason."
