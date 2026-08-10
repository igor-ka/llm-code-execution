# One child per PR — Implementation Plan

**Goal:** Make "a PR closes one child issue" a guarantee instead of a request, by deciding the
PR boundaries during planning — where splitting is still free — and backstopping that decision
with a `PR shape` CI check.

**Architecture:** Two layers, matching the two failure points. The *procedural* layer adds a
required `PR boundaries:` line to the plan header and one row to the staff-engineer reviewer's
checklist, so a human sees "seven PRs" at step 2 before any code exists. The *enforced* layer
adds `scripts/check-pr-shape.sh` — a metadata-level check, modelled exactly on
`scripts/check-sdlc-sync.sh` — that counts the issues a PR body would close and fails above one,
with `[multi-child]` in the title as the visible escape hatch. Neither layer changes application
code; the blast radius is the development process itself.

**Tech Stack:** Bash (POSIX awk, BWK/GNU-portable), GitHub Actions, GitHub repository rulesets.

**Issue:** [#72](https://github.com/igor-ka/llm-code-execution/issues/72) — read its **Resolved**
section first; it records why there is no size gate, no stacked PRs, and no `[no-issue]` marker.

> **Post-implementation note — the code listings below are superseded. Do not copy them.**
> This document is the pre-implementation record, deliberately left as it was reviewed. Review
> found four defects in the script it specifies, all fixed in the shipped files
> (`scripts/check-pr-shape.sh`, `scripts/tests/check-pr-shape.test.sh`), which are the only
> source of truth:
>
> - quotation stripping runs fences → code spans → HTML comments; the order here let a `<!--`
>   inside a fenced snippet swallow the rest of the body and pass any number of references;
> - inline code spans are stripped;
> - a closing fence must have nothing but whitespace after the delimiter, so an equal-length
>   ` ```bash ` line inside a block is content rather than the close;
> - `normalise` lowercases, so a mixed-case GitHub URL is not silently dropped and
>   `Owner/Repo#64` does not survive dedupe as a second issue.
>
> The suite is 23 cases, not 17. The PR description records what was applied and what was
> pushed back on. **Task 7 was also reordered**: the ruleset edit happens *before* merge, not
> after — see that task.

**PR boundaries:** One PR, closing #72. Every task below touches `docs/sdlc.md`, so splitting
would mean writing the same contract update twice. A single PR closing exactly one issue is also
the rule demonstrating itself on its own first use.

---

## Design notes the tasks assume

Six points that are load-bearing and easy to get wrong.

**1. Why the rule is *at most* one, not exactly one.** Exactly-one would close the last bypass
(omit `Closes` entirely and land the batch without spending a hatch) but costs a second
`[no-issue]` marker on the ~30% of PRs here that legitimately close nothing, plus an actor
exemption for `dependabot[bot]` — five of whose PRs are open right now with no closing reference,
and whose titles are rewritten on every rebase so a title marker would not survive. The bypass
has no evidence behind it: #71 declared all seven `Closes` lines openly. The batching was
announced, not concealed. **A backstop should be dumb.**

**2. `synchronize` is required for correctness, not convenience.** Required status checks are
evaluated against the PR's head SHA. Without `synchronize`, a PR that passes on its first commit
and is then pushed to would have no `PR shape` result on the new SHA, and the ruleset would block
the merge forever waiting for a check that never runs. This is a *different* reason from
`sdlc-docs.yml`'s, which needs `edited` so a title hatch re-runs the check. This workflow needs
both types, for both reasons.

**3. The PR body is untrusted input.** It is attacker-controllable on a public repo by anyone who
can open a PR. It is passed through `env:`, never interpolated into `run:` as `${{ }}` — the same
discipline `sdlc-docs.yml` already applies to the title, which matters more here because a body
is long, multi-line, and nobody reads it before CI does. The job takes `contents: read` and
`persist-credentials: false`, so a body that did escape has nothing to reach.

**4. Normalisation is what makes dedupe real.** GitHub accepts three reference forms — `#64`,
`owner/repo#64`, and the full issue URL. All are folded to `owner/repo#64` before counting, so
one issue referenced twice in two forms counts once, while `#64` and `other/repo#64` correctly
stay distinct. The folding is done in `awk` rather than `sed`: it needs branch-on-substitution to
stop the bare-`#N` rule from rewriting an already-qualified match, and that is spelled differently
in BSD and GNU `sed`. Developers here run macOS; CI runs Ubuntu.

**5. Quotations are stripped, and the stripping must survive nesting.** PR bodies in this repo
routinely paste issue text, plan excerpts, and review quotes; a `Closes #12` inside a fence or an
HTML comment is a quotation, not a commitment. A naïve fence stripper that toggles on any fence
line **over-counts** when a ` ``` ` block sits inside a ````` ```` ````` block — it flips state
four times and exposes the inner content, failing a legitimate PR. That is not hypothetical: this
repo's plans use ````` ````markdown ````` blocks, so quoting one would trip it. The stripper
therefore remembers the opening fence's character and length and only closes on a matching run of
equal-or-greater length. With that, under-counting is the only residual direction — a missed
warning rather than a blocked PR, and a blocked PR is what teaches people to reach for the hatch.

*Portability trap:* the fence scanner is written with `substr`/`index`, not an interval like
`{3,}`. BWK awk — what `/usr/bin/awk` is on macOS — does not support interval expressions.

**6. This is a discipline backstop, not a security control.** On `pull_request`, both the
workflow and the script come from the PR's head, so a fork PR can edit the gate to pass itself.
That is the same posture as `check-sdlc-sync.sh`, the token is read-only, and no secrets are
exposed — but it must be stated in `docs/sdlc.md` so nobody later mistakes the job for a control
and builds on that assumption.

---

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/check-pr-shape.sh` | **Create.** Count closable issues in `PR_BODY`; exit 1 above one unless `PR_TITLE` carries `[multi-child]` |
| `scripts/tests/check-pr-shape.test.sh` | **Create.** Table-driven unit tests; the same file CI runs as the job's first step |
| `.github/workflows/pr-shape.yml` | **Create.** The `PR shape` job — self-test, then check |
| `scripts/check-sdlc-sync.sh` | **Modify.** Broaden `WATCHED_RE` from the one named script to all of `scripts/` |
| `.claude/skills/writing-plans/SKILL.md` | **Modify.** `PR boundaries:` becomes a required plan-header field |
| `.claude/skills/writing-plans/planning-reviewer-prompt.md` | **Modify.** One checklist row so the staff review verifies the boundaries |
| `docs/sdlc.md` | **Modify.** The contract: plan phase, merge phase, CI section, watched paths, new "One child per PR" subsection |
| `CLAUDE.md` | **Modify.** Job-name contract list, and one clause explaining the gate |
| `README.md` | **Modify.** "one additional check" is now two |

No application code changes. No `verify.sh` changes — see Task 3.

---

## Task 1: The check script and its tests

TDD applies: the script is real logic (three reference forms, nine keywords, comment and fence
stripping, dedupe, a hatch), so the tests come first and must fail for the right reason.

**Files:**
- Create: `scripts/tests/check-pr-shape.test.sh`
- Create: `scripts/check-pr-shape.sh`

- [ ] **Step 1: Write the failing test suite**

Create `scripts/tests/check-pr-shape.test.sh`:

``````bash
#!/usr/bin/env bash
# Unit tests for scripts/check-pr-shape.sh. The script's whole contract is (PR_BODY, PR_TITLE)
# in, exit code out, so a table of cases is the entire suite. Run it locally before pushing;
# the "PR shape" job runs this same file as its first step, so the two cannot drift.
set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT="./check-pr-shape.sh"
export GITHUB_REPOSITORY="igor-ka/llm-code-execution"

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
  "Closes #64 — see also Closes https://github.com/igor-ka/llm-code-execution/issues/64"

case_ "http and www URL forms normalise too" 0 "feat: thing" \
  "Closes #64 — see also Closes http://www.github.com/igor-ka/llm-code-execution/issues/64"

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
``````

> **Writing this file:** three cases contain literal backtick fences inside single-quoted bash
> strings, one of them four backticks deep. Write it with the `Write` tool, not a heredoc in a
> shell command.

- [ ] **Step 2: Make it executable and run it to verify it fails**

```bash
chmod +x scripts/tests/check-pr-shape.test.sh
./scripts/tests/check-pr-shape.test.sh
```

Expected: all 17 cases fail with `expected exit 0, got 127` and
`./check-pr-shape.sh: No such file or directory`, then `✗ 17 failed, 0 passed`. **127, not 1** —
the script does not exist yet. If you see exit 1 anywhere, something else is wrong.

- [ ] **Step 3: Write the script**

Create `scripts/check-pr-shape.sh`:

```bash
#!/usr/bin/env bash
# docs/sdlc.md says a pull request is "one change, closing a child" (:66). That rule lived only
# in the instruction layer until this script; see "One child per PR" in docs/sdlc.md.
#
# It counts the issues a PR body would close and fails when there is more than one. Like
# scripts/check-sdlc-sync.sh it is a *metadata-level* check with no single-working-tree
# equivalent — there is no PR body in a working tree — which is why it lives here rather than
# in backend/verify.sh or frontend/verify.sh.
#
# This is a discipline backstop, not a security control: on `pull_request` the workflow and this
# script both come from the PR's head, so a fork PR can edit the gate. Same posture as
# check-sdlc-sync.sh; the token is read-only and no secrets are in reach.
#
# Usage:  scripts/check-pr-shape.sh
#   PR_BODY            pull request body (empty is a valid PR that closes nothing)
#   PR_TITLE           pull request title; containing [multi-child] skips the check
#   GITHUB_REPOSITORY  owner/repo, used to qualify bare "#N" references
set -euo pipefail

: "${PR_BODY:=}"
: "${PR_TITLE:=}"
: "${GITHUB_REPOSITORY:=igor-ka/llm-code-execution}"

HATCH='[multi-child]'

if [[ "$PR_TITLE" == *"$HATCH"* ]]; then
  echo "==> ${HATCH} found in the PR title — this PR deliberately closes more than one issue."
  exit 0
fi

# HTML comments are stripped first, across line boundaries. PR templates conventionally ship a
# commented-out "Closes #" placeholder, and GitHub does not link references inside them.
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

# Fenced blocks are stripped next. A "Closes #12" inside a fence is a quotation, not a
# commitment.
#
# The opening fence's character and length are remembered, so a ```-block nested inside a
# ````-block does not toggle the state back off and leak its contents. Without that, quoting a
# plan excerpt — this repo's plans use ````markdown blocks — would *over*-count and fail a
# legitimate PR. Under-counting is the safe direction; over-counting is the failure mode that
# teaches people to reach for the hatch.
#
# Written with substr/index rather than an interval like `{3,}`: BWK awk, which is
# /usr/bin/awk on macOS, does not support interval expressions.
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
        if (!infence) { infence = 1; fch = ch; flen = n }
        else if (ch == fch && n >= flen) { infence = 0 }
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
normalise() {
  awk -v repo="$GITHUB_REPOSITORY" '
    {
      if (match($0, /https?:\/\/(www\.)?github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/[0-9]+$/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/^https?:\/\/(www\.)?github\.com\//, "", s)
        sub(/\/issues\//, "#", s)
        print s
      } else if (match($0, /[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/)) {
        print substr($0, RSTART, RLENGTH)
      } else if (match($0, /#[0-9]+$/)) {
        print repo substr($0, RSTART, RLENGTH)
      }
    }'
}

closed="$(printf '%s\n' "$PR_BODY" | strip_comments | strip_fences | find_closers | normalise | sort -u)"
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
chmod +x scripts/check-pr-shape.sh
./scripts/tests/check-pr-shape.test.sh
```

Expected: 17 ticks, then `✓ 17 passed`, exit 0.

- [ ] **Step 5: Verify against real history — the check must catch #71 and clear Dependabot**

The unit tests prove the logic; this proves the calibration. #71 is the drift event the check
exists for, #51 is a correctly-shaped child PR, #63 is a docs PR that closes nothing, and #73 is
a Dependabot PR with no closing reference and no exemption.

```bash
export GITHUB_REPOSITORY=igor-ka/llm-code-execution
for n in 71 51 63 73; do
  printf -- '--- PR #%s\n' "$n"
  PR_BODY="$(gh pr view "$n" --json body --jq .body)" \
  PR_TITLE="$(gh pr view "$n" --json title --jq .title)" \
    ./scripts/check-pr-shape.sh || true
done
```

Expected:

| PR | Expected |
| --- | --- |
| #71 | `✗ this PR would close 7 issues:` listing `…#64` through `…#70` |
| #51 | `✓ this PR closes exactly one issue: igor-ka/llm-code-execution#43` |
| #63 | `✓ this PR closes no issue — nothing to check.` |
| #73 | `✓ this PR closes no issue — nothing to check.` |

If #73 fails, the Dependabot decision in #72's **Resolved** section is wrong and the plan needs
revisiting before going further.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-pr-shape.sh scripts/tests/check-pr-shape.test.sh
git commit -m "feat(ci): check-pr-shape.sh — a PR closes at most one issue"
```

---

## Task 2: The `PR shape` workflow

**Files:**
- Create: `.github/workflows/pr-shape.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/pr-shape.yml`:

```yaml
name: PR shape

# docs/sdlc.md says a PR is "one change, closing a child". This job is the guarantee behind
# that sentence — see "One child per PR" in docs/sdlc.md.
#
# Why a separate workflow from ci.yml, and why these event types:
#   `edited`      — the [multi-child] hatch is read from the PR title, and the count is read
#                   from the body. Neither fires `synchronize`. Without `edited`, fixing either
#                   would never re-run the check.
#   `synchronize` — required status checks are evaluated against the PR's head SHA. Without it,
#                   a PR that passed on its first commit and was then pushed to would have no
#                   result on the new SHA, and the ruleset would block the merge forever.
# Putting either type on ci.yml would re-run the full backend and frontend suites, Docker
# builds included, on every PR-title edit.
#
# Like `SDLC docs`, this is an exception to the "never add a CI check without adding it to the
# matching verify.sh" rule: there is no PR body in a working tree. Its unit tests *do* have a
# local equivalent, which is why they run here as a step and are documented as a pre-push
# command in docs/sdlc.md — the same file, run both places, so the two cannot drift.
#
# The job `name:` is a contract like the others (see ci.yml). It is a new name, so no existing
# required check is affected; it only blocks merges once "PR shape" is added to the
# "Protect main" ruleset's required status checks.

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, edited]

concurrency:
  group: pr-shape-${{ github.ref }}
  cancel-in-progress: true

# Read-only: this job reads PR metadata handed to it as environment variables and never needs
# the repository's write scope. It runs a script from the PR branch, so it must not hold a
# writable token.
permissions:
  contents: read

jobs:
  pr-shape:
    name: PR shape
    runs-on: ubuntu-latest
    steps:
      # No fetch-depth: 0 — unlike the SDLC docs check there is no base to diff against.
      # persist-credentials: false keeps the token out of .git/config, since the steps after
      # this execute scripts from the PR branch.
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Self-test
        run: ./scripts/tests/check-pr-shape.test.sh
      - name: Check the PR closes at most one issue
        env:
          # Via env, never inline `${{ }}` in `run:`. The body is attacker-controllable by
          # anyone who can open a PR against this public repo.
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_BODY: ${{ github.event.pull_request.body }}
        run: ./scripts/check-pr-shape.sh
```

- [ ] **Step 2: Parse-check the workflow locally**

Ruby ships with macOS and has YAML in its standard library; the system `python3` here is 3.9.6
with no PyYAML, so the Python one-liner you might reach for fails with `ModuleNotFoundError`.

```bash
ruby -ryaml -e 'YAML.load_file(".github/workflows/pr-shape.yml"); puts "yaml ok"'
```

Expected: `yaml ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-shape.yml
git commit -m "feat(ci): PR shape job runs the one-child check on every PR"
```

---

## Task 3: Bring the new script under the SDLC-docs contract

`scripts/check-sdlc-sync.sh` watches itself by name, on the reasoning that `docs/sdlc.md`
documents its exact semantics. `check-pr-shape.sh` is in exactly the same position. Broaden the
pattern to the whole directory rather than naming each script: there are two files in `scripts/`
today, and the next one will have the same property.

*Trade-off accepted:* an unrelated helper dropped in `scripts/` later would also demand a doc
touch. `[skip-sdlc-sync]` covers that case, visibly.

**Files:**
- Modify: `scripts/check-sdlc-sync.sh:24`

**Note on TDD:** `check-sdlc-sync.sh` has no test suite today, and building one is out of scope
for this issue — the change here is one alternation in one regex, verified directly in Step 2.
Flagged rather than skipped silently.

- [ ] **Step 1: Broaden the watched pattern**

Replace:

```bash
WATCHED_RE='^(\.claude/skills/|\.github/workflows/|scripts/check-sdlc-sync\.sh$|backend/verify\.sh$|frontend/verify\.sh$)'
```

with:

```bash
WATCHED_RE='^(\.claude/skills/|\.github/workflows/|scripts/|backend/verify\.sh$|frontend/verify\.sh$)'
```

And update the comment directly above it, replacing "This deliberately includes *this script*"
with:

```bash
# Files whose change means the development process itself changed. This deliberately includes
# all of scripts/: docs/sdlc.md documents the exact semantics of the checks that live there
# (watched paths, failure messages, escape hatches), so changing one without updating the doc
# would let the documentation silently desync from the enforcement it describes.
```

- [ ] **Step 2: Verify the new path is watched and the old ones still are**

```bash
for f in scripts/check-pr-shape.sh scripts/check-sdlc-sync.sh backend/verify.sh README.md; do
  printf '%-32s ' "$f"
  printf '%s\n' "$f" \
    | grep -qE '^(\.claude/skills/|\.github/workflows/|scripts/|backend/verify\.sh$|frontend/verify\.sh$)' \
    && echo watched || echo "not watched"
done
```

Expected:

```
scripts/check-pr-shape.sh        watched
scripts/check-sdlc-sync.sh       watched
backend/verify.sh                watched
README.md                        not watched
```

- [ ] **Step 3: Commit**

```bash
git add scripts/check-sdlc-sync.sh
git commit -m "chore(ci): SDLC-docs contract covers all of scripts/"
```

---

## Task 4: The plan layer — `PR boundaries` in the header

This is the layer that makes the gate in Tasks 1–2 cheap to satisfy, and the reason it should
almost never fire. No tests: these are prompts, and prompts are behaviour — they are reviewed in
the diff, which is what `.claude/skills/NOTICE.md` requires.

**Files:**
- Modify: `.claude/skills/writing-plans/SKILL.md:63-77`
- Modify: `.claude/skills/writing-plans/planning-reviewer-prompt.md:22-31`

- [ ] **Step 1: Add the field to the plan header template**

In `SKILL.md`, replace the `## Plan Document Header` block:

````markdown
## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**PR boundaries:** [The pull requests this plan produces — one line each, naming the child
issue each one closes. "PR 1: quota seam + in-memory store — closes #64". One child per PR.
Where two children genuinely cannot be separated, say so here and say why.]

---
```

**Why `PR boundaries` is in the header and not left to the implementer.** The decomposition
decision is cheapest at planning time and most expensive once a branch is finished — at that
point the only remaining moves are splitting completed work or reaching for an escape hatch.
Naming the PRs here puts the decision in front of a human at the plan review, before any code
exists. The `PR shape` CI check enforces the same rule at merge time, but it is a backstop; this
is the control.
````

- [ ] **Step 2: Add the reviewer checklist row**

In `planning-reviewer-prompt.md`, add a row to the **What to Check** table, immediately after
`Task Decomposition`:

```
    | PR boundaries | Does the header name the PRs this plan produces, one child issue each? Does that split match the task graph and its dependency order? Where two children are merged into one PR, is the reason stated and does it hold? |
```

- [ ] **Step 3: Verify both edits landed where intended**

```bash
grep -n 'PR boundaries' .claude/skills/writing-plans/SKILL.md \
                        .claude/skills/writing-plans/planning-reviewer-prompt.md
```

Expected: one hit in the `SKILL.md` header block, one in its explanatory paragraph, and one in
the reviewer table.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/writing-plans/
git commit -m "feat(skills): plans declare their PR boundaries; the staff review checks them"
```

---

## Task 5: Update the contract — `docs/sdlc.md`

Eight edits. This is the task the `SDLC docs` job exists to force, and Tasks 1–4 all trip it.

**Files:**
- Modify: `docs/sdlc.md` (lines 5-8, 66, 146-158, 222-226, 243-283, 318, 388-389, 414-446)

- [ ] **Step 1: Header — the watched set**

Replace lines 5-8:

```markdown
This document is a **contract**. If you change the development process — the skills in
`.claude/skills/`, either `verify.sh`, anything in `scripts/`, or a workflow in
`.github/workflows/` — update this file in the same change. The `SDLC docs` CI job enforces
it, and `CLAUDE.md` points here as the source of truth.
See [Changing this SDLC](#changing-this-sdlc).
```

- [ ] **Step 2: Track table — mark the PR row as enforced**

Replace line 66:

```markdown
| **PR** | one change, closing a child *(enforced — [One child per PR](#one-child-per-pr))* | GitHub |
```

- [ ] **Step 3: Plan phase — the boundaries requirement**

In `### 2. Plan`, after the paragraph beginning "Plans are saved to", insert:

```markdown
**Every plan header names its PR boundaries** — the pull requests the plan will produce, one
child issue each. This is where decomposition is decided, because it is the last point at which
splitting is free: once a branch is finished, the choices are re-slicing completed work or
reaching for an escape hatch. The staff-engineer review checks the boundaries against the task
graph, so a human sees "seven PRs" before a line is written. The `PR shape` job enforces the same
rule at merge time, but it is a backstop, not the decision point.
```

- [ ] **Step 4: Worked example 2b — children come from the approved boundaries**

At line 318, replace:

```markdown
**2b. Children** — *now* the slices are known, so batch-create them under the epic, one per
independently deliverable unit, labelled `enhancement`:
```

with:

```markdown
**2b. Children** — *now* the slices are known, so batch-create them under the epic, one per
PR boundary the plan review approved, labelled `enhancement`:
```

The children and the PR boundaries are then the same list, rather than two lists that drift.

- [ ] **Step 5: Merge phase — name the check**

In `### 6. Merge`, after the existing two lines, append:

```markdown
A PR closes **one** child. The `PR shape` job counts the closing references in the PR body and
fails above one; `[multi-child]` in the title is the visible exception. A PR that closes no issue
— a docs fix, a dependency bump — passes untouched.
```

- [ ] **Step 6: CI section — the diagram and the exception bullet**

In `## How this meets CI/CD`, add to the diagram after the `SDLC docs` line:

```
                                     PR shape         (a PR closes at most one child issue)
```

and replace the second bullet under "Details that are easy to get wrong":

```markdown
- **Never add a CI check without adding it to the matching `verify.sh`, or vice versa.** That
  mirroring is what stops local and CI drifting apart. Two jobs are deliberate exceptions,
  both metadata-level: `SDLC docs` diffs a PR against its base, and `PR shape` reads the PR
  body — neither has a meaningful single-working-tree equivalent. Both live in their own
  workflows so they can listen for `pull_request: edited` without re-running the full suites on
  every PR-title change. `PR shape`'s *unit tests* do have a local equivalent, and it is the
  same file CI runs: `./scripts/tests/check-pr-shape.test.sh`.
```

- [ ] **Step 7: Worked example — steps 2 and 6**

In step **2. Plan**, after the sentence ending "the plan never says what happens when
`AUTH_REQUIRED=false` and there is no `sub` to key on.", insert:

```markdown
The plan's header also names its **PR boundaries** — here, four PRs, one per child — and the
reviewer checks that split against the task graph.
```

In step **6. Merge** (:388), replace the closing sentence:

```markdown
**6. Merge** — PR body carries `Closes #62` so the child closes itself; both CI jobs green;
branch deleted. Four PRs land this way, one child each — the `PR shape` job would fail a PR
that tried to close two — and the epic closes when the last child does.
```

- [ ] **Step 8: Changing this SDLC — watched paths and the new subsection**

In `## Changing this SDLC`, replace the bullet list of watched paths:

```markdown
- `.claude/skills/**`
- `backend/verify.sh` or `frontend/verify.sh`
- `.github/workflows/**`
- `scripts/**`
```

and replace the sentence beginning "That last entry is deliberate":

```markdown
That last entry is deliberate: this document describes the exact semantics of the checks in
`scripts/` — their watched paths, failure messages and escape hatches — so a change to one that
skipped the doc would leave the two silently disagreeing.
```

Then add a new subsection at the end of the file:

```markdown
## One child per PR

`docs/sdlc.md` has always said a PR is "one change, closing a child". It drifted on its first
real test — #71 closed all seven children of epic #62 in one 1,362-line change — so the rule
moved out of the instruction layer.

**The rule:** a PR body may contain closing references (`Closes`, `Fixes`, `Resolves`, and their
tenses) to **at most one** issue. Zero is fine — a docs fix or a dependency bump closes nothing.

**The enforcement:** the `PR shape` job — in its own workflow, `.github/workflows/pr-shape.yml` —
runs `scripts/check-pr-shape.sh`, which strips HTML comments and fenced blocks from the body,
folds all three GitHub reference forms (`#N`, `owner/repo#N`, the issue URL) to one canonical
form, deduplicates, and fails above one. Quoting another PR's body is therefore safe as long as
the quotation sits in a fence. Its unit tests are `scripts/tests/check-pr-shape.test.sh`; the job
runs that file as its first step, and it is also the local pre-push command.

**Escape hatch:** put `[multi-child]` in the PR title. Visible in the PR list, exactly like
`[skip-sdlc-sync]`.

**Why *at most* one and not exactly one.** Exactly-one would also catch a PR that batches
children while writing no `Closes` line at all — but it would need a second marker on every PR
that legitimately closes nothing (~30% here) and an actor exemption for `dependabot[bot]`, whose
titles are rewritten on every rebase. The concealment it guards against has no precedent here:
#71 declared all seven closing references openly. A backstop should be dumb.

**It is a discipline backstop, not a security control.** On `pull_request` the workflow and the
script both come from the PR's head, so a fork PR can edit the gate to pass itself — the same
posture as `SDLC docs`. Both jobs hold a read-only token and reach no secrets. Do not build
anything on the assumption that either is tamper-proof.

**Where the real decision is made:** the `PR boundaries` field in the plan header (see
[Plan](#2-plan--what-are-the-ordered-verifiable-steps)). This check is what happens when that
decision is not honoured.
```

- [ ] **Step 9: Verify the anchors resolve**

```bash
grep -n '^## One child per PR' docs/sdlc.md
grep -n '#one-child-per-pr' docs/sdlc.md
```

Expected: the heading exists once, and the link from the Track table (Step 2) points at it.

- [ ] **Step 10: Commit**

```bash
git add docs/sdlc.md
git commit -m "docs(sdlc): one child per PR — the rule, the gate, and where it is decided"
```

---

## Task 6: `CLAUDE.md` and `README.md`

**Files:**
- Modify: `CLAUDE.md:92-101`, and the "Review process" section
- Modify: `README.md:249-253`

- [ ] **Step 1: `CLAUDE.md` — the job-name contract**

Replace the `## CI job names are a contract` section body:

```markdown
The "Protect main" ruleset requires status checks by job name (`Backend checks`,
`Frontend checks`, `SDLC docs`, `PR shape`). Renaming or removing a CI job breaks merges until
the ruleset's required checks are updated to match. Change what runs *inside* a job freely; keep
its name stable, or update the ruleset in the same PR.

`SDLC docs` and `PR shape` (PRs only, each in its own workflow) are the two deliberate exceptions
to the `verify.sh` mirroring rule above: one diffs a PR against its base, the other reads the PR
body, and neither has a single-working-tree equivalent.
```

- [ ] **Step 2: `CLAUDE.md` — one clause on the gate**

At the end of the "Review process" section, append:

```markdown
**One child per PR.** A PR closes at most one issue; the `PR shape` job enforces it and
`[multi-child]` in the title is the visible exception. The decision belongs earlier — every plan
header names its PR boundaries and the staff review checks them. See
[`docs/sdlc.md`](docs/sdlc.md).
```

- [ ] **Step 3: `README.md` — one additional check becomes two**

Replace lines 249-253 in full — this is the complete replacement, final sentence included:

```markdown
CI runs two additional checks that have no local equivalent, because both read pull-request
metadata rather than a working tree. The **`SDLC docs`** job compares a pull request against
its base ref and fails if the change touches the development process (`.claude/skills/**`,
either `verify.sh`, `scripts/**`, or `.github/workflows/**`) without updating
[`docs/sdlc.md`](docs/sdlc.md). The **`PR shape`** job fails a pull request whose body would
close more than one issue — `[multi-child]` in the title is the visible exception. That document
describes how a change gets from an idea to `main` — phases, gates, and how they meet CI.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: route CLAUDE.md and the README to the new PR-shape gate"
```

---

## Task 7: Open the PR and wire the ruleset

The ruleset edit is the step that turns a reporting job into a gate. `SDLC docs` sat in the
reporting state from #53 until 2026-08-09 because this step was left implicit — it is a task
here for that reason.

- [ ] **Step 1: Run both verify scripts**

Nothing in this change touches application code, but the gate is the gate.

```bash
cd backend  && SKIP_DOCKER=1 ./verify.sh && cd ..
cd frontend && SKIP_DOCKER=1 ./verify.sh && cd ..
```

Expected: green both sides.

- [ ] **Step 2: Push and open the PR**

The body must close exactly one issue — this PR is the check's own first subject.

> **Write the body carefully.** It should cover what lands, the at-most-one decision, and the
> #71/#51/#63/#73 calibration from Task 1 Step 5 — but **every quoted closing reference must sit
> inside a plain triple-backtick fence**. Markdown tables are not fenced, so a table cell reading
> `Closes #64` is counted like any other closer and this PR would fail its own gate. The obvious
> reaction would be to reach for `[multi-child]`, which is a poor first precedent for the hatch.

```bash
git push -u origin feat/one-child-per-pr
gh pr create --title "feat(sdlc): one child per PR — plan boundaries and a PR shape gate" \
             --body-file .github/pr-body.md
```

Write `.github/pr-body.md` first, ending with `Closes #72`, and delete it after the PR is open —
it is a scratch file, not part of the change.

- [ ] **Step 3: Confirm the new job ran and passed on its own PR**

```bash
gh pr checks --watch
```

Expected: `Backend checks`, `Frontend checks`, `SDLC docs`, and `PR shape` all pass. `PR shape`
reporting `✓ this PR closes exactly one issue` is the end-to-end proof.

- [ ] **Step 4: Run `code-review` and `security-review`, then receive the findings**

Both are mandatory (`CLAUDE.md`). Evaluate each finding with `receiving-code-review` before
applying it. Point the security review specifically at the workflow's handling of
`github.event.pull_request.body`.

- [ ] **Step 5: Add `PR shape` to the ruleset's required status checks — *before* merging**

Reordered after review. The original plan did this after merge, which would let the PR that
closes #72 land without the enforcement it promises — the exact shape of the `SDLC docs` lapse.
The context already exists: the job has reported on this PR's head SHA, so making it required
is satisfied immediately rather than blocking.

> **Side effect to expect.** The five open Dependabot PRs (#73–#78) predate this workflow and
> have no `PR shape` result on their head SHAs, so they will show the check as missing until
> each is nudged (a push, or close/reopen). They pass the check on content — verified against
> #73 — so this is a re-run, not a fix.

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  | jq '{name, target, enforcement, conditions, rules, bypass_actors}
        | (.rules[] | select(.type=="required_status_checks")
             .parameters.required_status_checks) += [{"context":"PR shape"}]' \
  > /tmp/protect-main.json

gh api -X PUT repos/igor-ka/llm-code-execution/rulesets/17055903 --input /tmp/protect-main.json
```

- [ ] **Step 6: Verify the gate is live**

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  --jq '.rules[] | select(.type=="required_status_checks").parameters.required_status_checks[].context'
```

Expected, in order:

```
Backend checks
Frontend checks
SDLC docs
PR shape
```

- [ ] **Step 7: Merge**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 8: Close the loop on the issue**

`Closes #72` in the PR body closes it on merge. Confirm, and add a comment recording the ruleset
edit — it happened outside the repository, so the PR diff is not evidence of it.

```bash
gh issue view 72 --json state --jq .state    # expect: CLOSED
```

---

## Rollback

Every step is cheap to undo; nothing here touches runtime behaviour, data, or the sandbox.

| If | Undo |
| --- | --- |
| The check misfires on a legitimate PR | `[multi-child]` in the title — no deploy, no revert |
| It misfires repeatedly | Remove `PR shape` from the ruleset (below). The job keeps reporting; merges stop being blocked |
| The whole approach is wrong | `git revert` the squash commit, then remove the ruleset context |

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  | jq '{name, target, enforcement, conditions, rules, bypass_actors}
        | (.rules[] | select(.type=="required_status_checks")
             .parameters.required_status_checks) |= map(select(.context != "PR shape"))' \
  > /tmp/protect-main-rollback.json

gh api -X PUT repos/igor-ka/llm-code-execution/rulesets/17055903 --input /tmp/protect-main-rollback.json
```

---

## Definition of done

Against `.claude/skills/references/definition-of-done.md`:

- [ ] `./scripts/tests/check-pr-shape.test.sh` passes locally — 23 cases
- [ ] The check fails #71's body and clears #51's, #63's and #73's (Task 1, Step 5)
- [ ] Both `verify.sh` scripts green
- [ ] `SDLC docs` green — it is watching every file this change touches
- [ ] `PR shape` green on this PR, reporting exactly one closed issue
- [ ] `code-review` and `security-review` run, findings evaluated, real ones fixed
- [ ] `PR shape` present in the ruleset's required status checks (Task 7, Step 7)
- [ ] `docs/sdlc.md`, `CLAUDE.md` and `README.md` describe the process that now exists
- [ ] #72 closed
