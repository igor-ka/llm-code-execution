#!/usr/bin/env bash
# docs/sdlc.md says a pull request is "one change, closing a child" (:66). That rule lived only
# in the instruction layer until this script; see "One child per PR" in docs/sdlc.md.
#
# It counts the issues a PR body would close and fails when there is more than one. Like
# scripts/check-sdlc-sync.sh it is a *metadata-level* check with no single-working-tree
# equivalent — there is no PR body in a working tree — which is why it lives here rather than
# in backend/verify.sh or frontend/verify.sh.
#
# Usage:  scripts/check-pr-shape.sh
#   PR_BODY            pull request body (empty is a valid PR that closes nothing)
#   PR_TITLE           pull request title; containing [multi-child] skips the check
#   GITHUB_REPOSITORY  owner/repo, used to qualify bare "#N" references
set -euo pipefail

: "${PR_BODY:=}"
: "${PR_TITLE:=}"
# No default. A wrong default silently qualifies bare "#N" against another repository and every
# assertion still passes; an unset variable is loud. GitHub Actions always sets it.
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set — Actions sets it; set it by hand to run locally}"

# Read from config, with a fallback — unlike check-sdlc-sync.sh. This hatch only WIDENS what is
# allowed, so a missing config degrading to the strict default is safe. There, the config decides
# what is checked at all, so it must fail.
ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
HATCH="$(jq -r '.process.prShapeHatch // "[multi-child]"' "$ACB_CONFIG" 2>/dev/null || echo '[multi-child]')"

if [[ "$PR_TITLE" == *"$HATCH"* ]]; then
  echo "==> ${HATCH} found in the PR title — this PR deliberately closes more than one issue."
  exit 0
fi

# Quotations are stripped in three passes, and the ORDER IS LOAD-BEARING:
#   fences → code spans → HTML comments
# Comment stripping must run last because it is stateful across lines. Run first, a literal
# "<!--" inside a fenced HTML snippet opens comment state and swallows the rest of the body —
# every closing reference after it disappears and the gate silently passes anything.
strip_comments() {
  awk '
    {
      line = $0; out = ""
      while (1) {
        if (!incomment) {
          i = index(line, "<!--")
          if (i == 0) { out = out line; break }
          out = out substr(line, 1, i - 1)
          line = substr(line, i + 4)
          incomment = 1
        } else {
          j = index(line, "-->")
          if (j == 0) { break }
          line = substr(line, j + 3)
          incomment = 0
        }
      }
      print out
    }'
}

# Inline code spans, run once fences are gone. A body discussing this very check will write
# `Closes #65` inline, and GitHub does not link that — counting it would fail a legitimate PR,
# and the failure message's advice ("put the quotation in a fence") does not apply to a span.
# Double-backtick spans go first so their contents are not exposed by the single-backtick pass.
strip_code_spans() {
  # shellcheck disable=SC2016  # the backticks are the pattern being matched, not substitution
  sed -e 's/``[^`]*``//g' -e 's/`[^`]*`//g'
}

# Fenced blocks are stripped first. PR bodies in this repo routinely paste issue text, plan
# excerpts and review quotes; a "Closes #12" inside a fence is a quotation, not a commitment.
#
# Known limitation: 4-space-indented code blocks are not recognised, so a closing reference
# inside one is still counted. Deliberate — whether an indented line is a code block or a list
# continuation depends on what precedes it, and a cheap version would drop closers written as
# nested list items instead. GitHub's editor produces fences, not indented blocks.
#
# The opening fence's character and length are remembered, so a ```-block nested inside a
# ````-block does not toggle the state back off and leak its contents. Without that, quoting a
# plan excerpt — this repo's plans use ````markdown blocks — would *over*-count and fail a
# legitimate PR. Under-counting is the safe direction; over-counting is the failure mode that
# teaches people to reach for the hatch.
#
# Written with substr/index rather than an interval like `{3,}`: BWK awk on macOS does not
# support interval expressions, and developers here run macOS while CI runs Ubuntu.
strip_fences() {
  awk '
    {
      s = $0
      sub(/^[[:space:]]+/, "", s)
      ch = substr(s, 1, 1)
      n = 0
      if (ch == "`" || ch == "~") {
        while (substr(s, n + 1, 1) == ch) n++
      }
      if (n >= 3) {
        # CommonMark: an opening fence may carry an info string ("```bash"); a *closing* fence
        # may not. Without the rest-is-blank test, a "```bash" line inside an equal-length
        # block reads as the close, and everything after it leaks back into the count.
        rest = substr(s, n + 1)
        if (!infence) { infence = 1; fch = ch; flen = n }
        else if (ch == fch && n >= flen && rest ~ /^[[:space:]]*$/) { infence = 0 }
        next
      }
      if (!infence) print
    }'
}

# All nine GitHub closing keywords, in the reference forms GitHub accepts. Matching only
# "Closes"/"Fixes" would let "Resolves #64" walk straight past the gate.
find_closers() {
  grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[[:space:]]*:?[[:space:]]*(https?://(www\.)?github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/issues/[0-9]+|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+|#[0-9]+)' || true
}

# Normalise every form to "owner/repo#N" so the same issue referenced twice — once bare, once by
# URL — counts once. awk rather than sed: the branch-on-substitution needed to stop the
# bare-"#N" rule from rewriting an already-qualified match is spelled differently in BSD and GNU
# sed.
#
# Everything is lowercased first, because find_closers matches case-insensitively and GitHub
# treats owner and repository names that way too. Without it "https://GitHub.com/…" matches no
# branch here and is silently dropped, and "Owner/Repo#64" survives `sort -u` as a second issue
# alongside "owner/repo#64".
normalise() {
  awk -v repo="$GITHUB_REPOSITORY" '
    BEGIN { repo = tolower(repo) }
    {
      r = tolower($0)
      if (match(r, /https?:\/\/(www\.)?github\.com\/[a-z0-9._-]+\/[a-z0-9._-]+\/issues\/[0-9]+$/)) {
        s = substr(r, RSTART, RLENGTH)
        sub(/^https?:\/\/(www\.)?github\.com\//, "", s)
        sub(/\/issues\//, "#", s)
        print s
      } else if (match(r, /[a-z0-9._-]+\/[a-z0-9._-]+#[0-9]+$/)) {
        print substr(r, RSTART, RLENGTH)
      } else if (match(r, /#[0-9]+$/)) {
        print repo substr(r, RSTART, RLENGTH)
      }
    }'
}

closed="$(printf '%s\n' "$PR_BODY" | strip_fences | strip_code_spans | strip_comments | find_closers | normalise | sort -u)"
count="$(printf '%s' "$closed" | grep -c . || true)"

if [[ "$count" -le 1 ]]; then
  if [[ "$count" -eq 0 ]]; then
    echo "✓ this PR closes no issue — nothing to check."
  else
    echo "✓ this PR closes exactly one issue: ${closed}"
  fi
  exit 0
fi

{
  echo
  echo "✗ this PR would close ${count} issues:"
  echo
  printf '%s\n' "$closed" | sed 's/^/      /'
  echo
  echo "  docs/sdlc.md: a PR is \"one change, closing a child\". Batching children into one"
  echo "  PR is what this check exists to catch — reviewer attention is the constraint, and"
  echo "  it does not scale with diff size."
  echo
  echo "  Split the branch so each PR closes one child. The boundaries should already be in"
  echo "  the plan's \"PR boundaries\" header — start there."
  echo
  echo "  If you are quoting another PR's body, put the quotation in a fenced block — quoted"
  echo "  closing references inside a fence or an HTML comment are not counted."
  echo
  echo "  For a genuine exception, put [multi-child] in the PR title. That stays visible in"
  echo "  the PR list rather than silently bypassing."
  echo
} >&2
exit 1
