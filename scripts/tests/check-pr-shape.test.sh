#!/usr/bin/env bash
# Unit tests for scripts/check-pr-shape.sh. The script's whole contract is (PR_BODY, PR_TITLE)
# in, exit code out, so a table of cases is the entire suite. Run it locally before pushing;
# the "PR shape" job runs this same file as its first step, so the two cannot drift.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="./check-pr-shape.sh"
export GITHUB_REPOSITORY="example/repo"

pass=0
fail=0

# case_ <name> <expected-exit> <title> <body>
#
# `local name=... got out` declares on its own line, and the capture is a separate statement.
# Do NOT tidy this into `local out="$(...)"`: in that form `$?` is `local`'s status, which is
# always 0, and every test below would pass vacuously.
case_() {
  local name="$1" want="$2" title="$3" body="$4" got out
  out="$(PR_TITLE="$title" PR_BODY="$body" "$SCRIPT" 2>&1)"
  got=$?
  if [[ "$got" -eq "$want" ]]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  ✗ %s — expected exit %s, got %s\n' "$name" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

echo "check-pr-shape.sh"

case_ "no closing reference passes" 0 "docs: tidy the README" \
  "A body with no closing keyword at all."

case_ "empty body passes" 0 "chore(deps): bump postcss" ""

case_ "one bare reference passes" 0 "feat: thing" \
  "Part of epic #37. Closes #43."

case_ "two references fail" 1 "feat: thing" \
  "Closes #64
Closes #65"

case_ "all nine keywords are recognised" 1 "feat: thing" \
  "Resolves #64 and fixed #65"

case_ "the same issue twice counts once" 0 "feat: thing" \
  "Closes #64. Superseded text, still closes #64."

case_ "bare and URL forms of one issue count once" 0 "feat: thing" \
  "Closes #64 — see also Closes https://github.com/example/repo/issues/64"

case_ "http and www URL forms normalise too" 0 "feat: thing" \
  "Closes #64 — see also Closes http://www.github.com/example/repo/issues/64"

case_ "cross-repo reference is distinct from a bare one" 1 "feat: thing" \
  "Closes #64 and closes other/repo#64"

case_ "closers inside a fenced block are ignored" 0 "feat: thing" \
  'Closes #64

```markdown
Closes #65
Closes #66
```'

case_ "tilde fences are ignored too" 0 "feat: thing" \
  'Closes #64

~~~
Closes #65
~~~'

case_ "a nested fence does not leak its contents" 0 "feat: thing" \
  'Closes #64

````markdown
Quoting a plan excerpt:

```bash
Closes #65
```

Closes #66
````'

case_ "a closer in an HTML comment is ignored" 0 "feat: thing" \
  "Closes #64 <!-- Closes #65 -->"

# Regression: comment stripping is stateful across lines, so running it before fence stripping
# let a literal "<!--" inside an HTML snippet swallow the rest of the body and pass anything.
case_ "an HTML comment marker inside a fence does not disable the check" 1 "feat: thing" \
  'Closes #64

```html
<!-- a comment example
```

Closes #65'

# shellcheck disable=SC2016  # literal backticks are the fixture; expansion would defeat it
case_ "a closer in an inline code span is ignored" 0 "feat: thing" \
  'Closes #64 and the doc says `Closes #65`'

# shellcheck disable=SC2016  # as above — the backticks are data, not syntax
case_ "a closer in a double-backtick span is ignored" 0 "feat: thing" \
  'Closes #64 and the doc says ``Closes #65`` verbatim'

# CommonMark: an opening fence may carry an info string, a closing fence may not. Treating
# "```bash" as a close inside an equal-length block exposed everything after it.
case_ "an equal-length fence with an info string is content" 0 "feat: thing" \
  'Closes #64

```
quoting a document:
```bash
Closes #65
```
still inside the quote
```'

# find_closers is case-insensitive; normalise was not, so a mixed-case URL matched and was then
# silently dropped, and a mixed-case owner/repo survived sort -u as a second issue.
case_ "a mixed-case GitHub URL is not silently dropped" 1 "feat: thing" \
  "Closes https://GitHub.com/example/repo/issues/64
Closes #65"

case_ "mixed-case owner/repo dedupes with the canonical form" 0 "feat: thing" \
  "Closes example/repo#64 and closes Example/Repo#64"

case_ "a multi-line HTML comment is ignored" 0 "feat: thing" \
  "Closes #64

<!--
Closes #65
Closes #66
-->"

case_ "the hatch allows many" 0 "feat(limits): everything [multi-child]" \
  "Closes #64
Closes #65
Closes #66"

case_ "a bare issue mention is not a closer" 0 "feat: thing" \
  "Part of epic #37, follows #38, blocked on #39."

case_ "colon form is recognised" 1 "feat: thing" \
  "Fixes: #64
Resolves: #65"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "✗ ${fail} failed, ${pass} passed"
  exit 1
fi
echo "✓ ${pass} passed"
