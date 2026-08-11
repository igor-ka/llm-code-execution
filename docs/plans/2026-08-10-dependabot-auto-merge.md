# Dependabot Auto-Merge Implementation Plan

**Goal:** Green patch and minor Dependabot pull requests merge themselves, so human attention is
spent only on majors and on PRs something objected to.

**Architecture:** One new workflow, `.github/workflows/dependabot-auto-merge.yml`, listens on
`pull_request`, runs only for `dependabot[bot]`, reads the per-dependency metadata with
`dependabot/fetch-metadata` (pinned to a full commit SHA), and calls `gh pr merge --auto --squash`
only when **every** dependency in the PR is a `semver-patch` or `semver-minor` bump and the
ecosystem is not `github_actions`. It does **not** check out the repository, so no code from the
PR branch executes in a job that holds a writable token. Native auto-merge then merges the PR when
— and only when — every required check passes and every review thread is resolved. Nothing about
the "Protect main" ruleset changes.

**Tech Stack:** GitHub Actions, `dependabot/fetch-metadata@v3.1.0`, `gh` CLI (preinstalled on
`ubuntu-latest`), GitHub native auto-merge.

**PR boundaries:** PR 1: the auto-merge workflow + its `docs/sdlc.md` entry — closes #94. One
child, one PR. Two steps sit outside the PR by necessity and are called out as their own tasks:
enabling `allow_auto_merge` on the repository (Task 1, a settings change, no diff) and the live
acceptance run against real Dependabot PRs (Task 7, only possible once the workflow is on `main`).

---

## Context this plan assumes

Read these before starting; each one is a decision already made, not an option.

- **#94 is decided and needs no spec.** `required_review_thread_resolution` and
  `copilot_code_review` both stay. A Copilot comment parking auto-merge is the intended
  behaviour. The feature is therefore *"auto-merge when nothing objects"*, not *"unattended
  merges"*. A stalled PR is a correct outcome.
- **#56 has landed** (`.github/dependabot.yml`, PR #96, extended by #115). Scheduled weekly
  version updates across `npm` × 2 directories and `github-actions` are live, which is what makes
  a patch/minor gate worth building — see *Ordering* in #94.
- **`strict_required_status_checks_policy: true` stays** (decided 2026-08-10). Auto-merge does
  **not** update an out-of-date branch — that is precisely what a merge queue exists for. For
  Dependabot PRs the update arrives from Dependabot itself, which rebases its own PRs by default
  and stops doing so after 30 days. So the loop is: `main` moves → PR goes `BEHIND` → Dependabot
  rebases → checks re-run → auto-merge fires. Latency is Dependabot's cadence, not instant.
- **The repository today:** `allow_auto_merge: false`, `allow_merge_commit: false`,
  `allow_squash_merge: true`, `allow_rebase_merge: true`, `delete_branch_on_merge: true`,
  `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`.
- **The "Protect main" ruleset** (id `17055903`) requires `Backend checks`, `Frontend checks`,
  `SDLC docs`, `PR shape`; `required_approving_review_count: 0`;
  `allowed_merge_methods: [squash, rebase]`; `required_linear_history: true`.

### How this change is tested, and why not with a test file

`test-driven-development` applies to logic, and the eligibility rule *is* logic — a jq program
over every dependency in the PR (Task 2, Step 2). It is tested two ways:

1. **Five fixtures, run at implementation time** (Task 2, Step 4), including the exact shape that
   defeats the naive one-line version of this gate. These are structural cases — all-entries,
   missing key, empty array, wrong ecosystem, malformed input — so they can fail for real reasons.
2. **Two live Dependabot PRs after merge** (Task 7), one positive and one negative. This is the
   only thing that validates the *constants* — that `version-update:semver-minor` is still spelled
   that way, that `updateType` is still camelCase. A checked-in unit test cannot: it would assert
   the same literals the implementation asserts and pass either way, which is the vacuous-test
   failure `scripts/tests/check-sdlc-sync.test.sh` was fixed for.

**Why the rule is not extracted into `scripts/automerge-eligible.sh` with a test file**, matching
`check-pr-shape.sh` and `check-sdlc-sync.sh`: running a repository script requires
`actions/checkout`, and this is the one job in the repository holding a writable `GITHUB_TOKEN`.
Keeping PR-branch code out of it is worth more than a committed test file that could only cover
the cases the fixtures already cover. The middle design — a separate read-only job that checks out
and emits a verdict, feeding a checkout-free arming job via `needs:` — is a reasonable alternative,
costs about 40 more lines and a second runner, and is written down here because it was weighed and
rejected, not overlooked.

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `.github/workflows/dependabot-auto-merge.yml` | Create | Arms native auto-merge on eligible Dependabot PRs. Holds the only writable token in this repository's CI. |
| `docs/sdlc.md` | Modify | Records that a workflow exists which is *not* a check, and the accepted consequence of keeping thread resolution on. Mandatory: `.github/workflows/**` is a watched path. |

No `verify.sh` change. The mirroring rule in `docs/sdlc.md` binds **checks** — things that gate a
merge. This workflow gates nothing; it presses a button that the four existing gates still stand
in front of. Task 3 states that in the document so the next reader does not have to re-derive it.

**One line of #94 is deliberately not implemented.** Its "Also known" section says "the
enforced-layer list should name the new job". The three-layer table at `docs/sdlc.md:20` describes
the *Enforced* layer — things that cannot be talked out of — and this workflow is not one: it
enforces nothing, and adding it there would contradict the bullet Task 3 adds three sections
later. Decided 2026-08-10: record the divergence, leave the table alone. Separately, that row is
already stale — it names `ci.yml` but neither `sdlc-docs.yml` nor `pr-shape.yml`. That is a
different fix and belongs in its own issue, not here.

---

## Task 1: Enable `allow_auto_merge` on the repository

**Files:** none — this is a repository setting.

Do this **first**. Until it is on, `gh pr merge --auto` fails with
`Auto-merge is not enabled for this repository`. Turning it on before the workflow exists is inert:
auto-merge never arms itself, so nothing changes until something calls `--auto`.

- [ ] **Step 1: Read the current value**

```bash
gh api repos/igor-ka/llm-code-execution --jq '.allow_auto_merge'
```

Expected: `false`

- [ ] **Step 2: Enable it**

```bash
gh api -X PATCH repos/igor-ka/llm-code-execution -F allow_auto_merge=true --jq '.allow_auto_merge'
```

Expected: `true`

- [ ] **Step 3: Confirm nothing else moved**

```bash
gh api repos/igor-ka/llm-code-execution \
  --jq '{allow_auto_merge, allow_squash_merge, allow_rebase_merge, allow_merge_commit}'
```

Expected: `{"allow_auto_merge":true,"allow_squash_merge":true,"allow_rebase_merge":true,"allow_merge_commit":false}`

**Rollback:**

```bash
gh api -X PATCH repos/igor-ka/llm-code-execution -F allow_auto_merge=false
```

---

## Task 2: Add the auto-merge workflow

**Files:**
- Create: `.github/workflows/dependabot-auto-merge.yml`

- [ ] **Step 1: Cut the branch first**

This working tree is shared with other sessions and is currently on an unrelated branch with
uncommitted work. Branch **before** writing anything, or the commits in this task land on someone
else's branch. Check first, and do not disturb work in progress.

```bash
git status --short
git fetch origin
git switch -c feat/dependabot-auto-merge origin/main
```

Expected: a clean switch. If `git status --short` shows tracked modifications belonging to another
session, stop and resolve that before going further.

- [x] **Step 2: Create the workflow file**

> **Post-implementation note.** The YAML below is the version this plan was approved with. The
> `code-review` pass on PR #126 found four real defects in it, so the merged file differs — three
> gate rules instead of two, a disarm step, `reopened` dropped, and `contents: write` dropped. See
> [Code review log](#code-review-log) at the end of this document; `.github/workflows/dependabot-auto-merge.yml`
> is authoritative.

```yaml
name: Dependabot auto-merge

# Arms GitHub's native auto-merge on Dependabot PRs that only move a patch or minor version.
# See "Auto-merging dependency bumps" in docs/sdlc.md, and issue #94.
#
# This is NOT a check and must never be added to the "Protect main" ruleset's required status
# checks. The four gates (Backend checks, Frontend checks, SDLC docs, PR shape) still decide
# whether the PR is mergeable; this job only presses the button in advance. It is therefore also
# not subject to the "every CI check has a verify.sh equivalent" rule — it gates nothing.
#
# Why `pull_request` and NOT `pull_request_target`: pull_request_target runs in the base repo's
# context with a writable token, which is the standard way to turn a dependency bot into a
# code-execution path. It is not needed here — Dependabot's branches live in this repository, so
# a plain `pull_request` run can be granted write via the `permissions:` block below.
#
# Why there is no `actions/checkout` step: this job holds the only writable GITHUB_TOKEN in the
# repository's CI. Checking out the head ref would put code from the PR branch inside that job.
# Every input this job needs arrives as event metadata or as an action output, so it never needs
# a working tree. If a future change here needs the repository, check out
# `${{ github.event.pull_request.base.sha }}`, never the head.

on:
  pull_request:
    branches: [main]

# `synchronize` is in the default type set, which matters: Dependabot rebases its open PRs when
# main moves, and that rebase is what re-runs this workflow for a PR opened before it existed.

concurrency:
  group: dependabot-auto-merge-${{ github.ref }}
  cancel-in-progress: true

jobs:
  auto-merge:
    name: Dependabot auto-merge
    runs-on: ubuntu-latest
    # `github.repository` keeps this inert in forks. `user.login` is set by GitHub from the
    # authenticated actor and cannot be forged by a PR author.
    if: >-
      github.event.pull_request.user.login == 'dependabot[bot]' &&
      github.repository == 'igor-ka/llm-code-execution'
    # Declared at job level, not workflow level, so the scope is visibly attached to the only job
    # that needs it. The repository default is `read`; a workflow may request more, and a PR from
    # a fork is capped at read regardless of what is written here.
    permissions:
      contents: write
      pull-requests: write
    steps:
      # Pinned to the full commit SHA for v3.1.0, not @v3 — a moving tag is a supply-chain
      # rewrite waiting to happen, and this step runs in the job holding write access.
      # `alert-lookup` and `compat-lookup` stay off: both require a PAT, and neither is used.
      - name: Fetch Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      # Two rules, both fail-closed, both evaluated per dependency rather than off the summary
      # outputs. Why not `steps.metadata.outputs.update-type`, which would be one line:
      #
      #   On SECURITY updates Dependabot omits `update-type:` from the commit trailer entirely —
      #   verified on PR #78, whose trailer carries only dependency-name/-version/-type. The
      #   action then derives the type by parsing "Updates `x` from A to B" out of the PR body
      #   and yields "" for any entry it cannot parse (#78's esbuild line reads "Removes
      #   `esbuild`", with an empty dependency-version). `update-type` is the MAX across entries
      #   and the max skips blanks — so a security PR whose only major is an unparseable entry
      #   reports minor, and a gate reading that output would arm auto-merge on a major.
      #
      # Rule 1: every entry must declare patch or minor. A blank, a missing key, malformed JSON
      #         or an empty array is not eligible.
      # Rule 2: `github_actions` is excluded. This workflow pins `fetch-metadata` by SHA with
      #         the version in a trailing comment, and Dependabot bumps SHA pins by that comment
      #         — so v3.1.x arrives as a *patch* and this workflow would merge a new third-party
      #         action SHA into main unread. Nothing else catches it: `SDLC docs` exits 0 for
      #         dependabot[bot], `PR shape` passes, and no verify.sh reads workflow files.
      #
      # Key names are camelCase because this output is the action's internal struct serialised
      # by @actions/core — `updateType`, `packageEcosystem` — not the kebab-case summary outputs.
      #
      # `set -euo pipefail` plus jq's non-zero exit on malformed input means a parse failure
      # fails the step rather than falling through to "eligible". A red job here is the intended
      # outcome: it is not a required check, so it blocks nothing, and it is visible.
      - name: Decide whether this PR may auto-merge
        id: gate
        env:
          DEPS_JSON: ${{ steps.metadata.outputs.updated-dependencies-json }}
        run: |
          set -euo pipefail
          verdict="$(printf '%s' "$DEPS_JSON" | jq -r '
            if type != "array" or length == 0 then "not-eligible: no dependency metadata"
            elif any(.[]; .packageEcosystem == "github_actions")
              then "not-eligible: github_actions pins are merged by a human"
            elif all(.[]; .updateType == "version-update:semver-patch"
                       or .updateType == "version-update:semver-minor")
              then "eligible"
            else "not-eligible: at least one dependency is not patch or minor"
            end')"
          echo "verdict=${verdict}" >> "$GITHUB_OUTPUT"
          echo "${verdict}"
          printf '%s' "$DEPS_JSON" \
            | jq -r '.[] | "  \(.dependencyName): \(.prevVersion) -> \(.newVersion) [\(.updateType // "unknown")]"'

      # `--squash`, not `--merge`: the ruleset allows only squash and rebase, and
      # required_linear_history is on. GitHub's own documented example uses `--merge` and would
      # fail here.
      #
      # No `gh pr review --approve`: required_approving_review_count is 0, and the repository
      # sets can_approve_pull_request_reviews: false, so Actions could not approve anyway.
      #
      # `gh pr merge --auto` errors on a PR that is *already* mergeable — GitHub only offers
      # auto-merge while something is still outstanding. That cannot happen here (four required
      # checks and a Copilot review are always pending when this runs), but if this step ever
      # goes red with "not in the correct state", read it as "the PR was already mergeable", not
      # as a gate failure.
      - name: Arm auto-merge
        if: steps.gate.outputs.verdict == 'eligible'
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh pr merge --auto --squash "$PR_URL"

      # Prints why a PR was left alone, so "why did this not merge?" is answered in the run log
      # rather than by re-deriving the rule. Majors are the common case here.
      - name: Explain why auto-merge was not armed
        if: steps.gate.outputs.verdict != 'eligible'
        env:
          VERDICT: ${{ steps.gate.outputs.verdict }}
          DEPS: ${{ steps.metadata.outputs.dependency-names }}
        run: |
          echo "Auto-merge not armed — ${VERDICT}."
          echo "Dependencies: ${DEPS}"
          echo "Merge this one by hand after reading the diff."
```

- [ ] **Step 3: Verify the file is valid YAML and the pin resolves**

There is no `yaml` module for `python3` here, no `yq` and no `actionlint`; `js-yaml` is not in
either `node_modules`. `npx --yes js-yaml` fetches it for the one call.

```bash
cd /Users/igorkamenetsky/Workspaces/Claude/llm-code-execution
npx --yes js-yaml .github/workflows/dependabot-auto-merge.yml \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d['jobs']['auto-merge'].keys()))"
gh api repos/dependabot/fetch-metadata/git/ref/tags/v3.1.0 --jq '.object.sha'
```

Expected: the key list prints and includes `permissions`, `if`, `steps`; the SHA prints
`25dd0e34f4fe68f24cc83900b1fe3fe149efef98`, matching the pin in the file.

- [x] **Step 4: Exercise the gate against six fixtures**

This is the test this change gets (see *Why there is no unit test in this plan* above — the
verdict logic is now structural, not a string comparison, so it *can* fail for a real reason).
Copy the jq program out of the workflow file rather than retyping it, so the two cannot drift.

```bash
FIX="${TMPDIR:-/tmp}/automerge-fixtures"; mkdir -p "$FIX"; cd "$FIX"

cat > gate.jq <<'JQ'
if type != "array" or length == 0 then "not-eligible: no dependency metadata"
elif any(.[]; .packageEcosystem == "github_actions")
  then "not-eligible: github_actions pins are merged by a human"
elif all(.[]; .updateType == "version-update:semver-patch"
           or .updateType == "version-update:semver-minor")
  then "eligible"
else "not-eligible: at least one dependency is not patch or minor"
end
JQ

# A: a single minor dev bump — the #117 shape.
cat > a-minor.json <<'J'
[{"dependencyName":"globals","dependencyType":"direct:development","updateType":"version-update:semver-minor","packageEcosystem":"npm","prevVersion":"17.7.0","newVersion":"17.9.0"}]
J
# B: a grouped version update carrying a major — the #119 shape.
cat > b-grouped-major.json <<'J'
[{"dependencyName":"@auth0/auth0-react","dependencyType":"direct:production","updateType":"version-update:semver-minor","packageEcosystem":"npm"},
 {"dependencyName":"react","dependencyType":"direct:production","updateType":"version-update:semver-major","packageEcosystem":"npm"}]
J
# C: a grouped SECURITY update with no update-type in the trailer — the #78 shape. This is the
#    one a gate reading `outputs.update-type` would wave through.
cat > c-security-blank.json <<'J'
[{"dependencyName":"esbuild","dependencyType":"indirect","updateType":"","packageEcosystem":"npm"},
 {"dependencyName":"vitest","dependencyType":"direct:development","updateType":"version-update:semver-patch","packageEcosystem":"npm"}]
J
# D: a patch bump of a pinned action — the case Rule 2 exists for.
cat > d-actions-patch.json <<'J'
[{"dependencyName":"dependabot/fetch-metadata","dependencyType":"direct:production","updateType":"version-update:semver-patch","packageEcosystem":"github_actions"}]
J
# E: the key absent entirely rather than blank.
cat > e-missing-key.json <<'J'
[{"dependencyName":"uuid","dependencyType":"indirect","packageEcosystem":"npm"}]
J
# F: no metadata at all.
echo '[]' > f-empty.json

for f in a-minor b-grouped-major c-security-blank d-actions-patch e-missing-key f-empty; do
  printf '%-18s %s\n' "$f" "$(jq -r -f gate.jq "$f.json")"
done
```

Observed 2026-08-10, re-run after the code-review fixes with `packageEcosystem` set to the real
value Dependabot produces (`npm_and_yarn` — every npm branch is `dependabot/npm_and_yarn/…`) and a
seventh fixture for the `docker` ecosystem proposed in #110:

```
a-minor            eligible
b-grouped-major    not-eligible: at least one dependency is not patch or minor
c-security-blank   not-eligible: at least one dependency is not patch or minor
d-actions-patch    not-eligible: only npm dependency bumps auto-merge
e-missing-key      not-eligible: at least one dependency is not patch or minor
f-empty            not-eligible: no dependency metadata
g-docker-patch     not-eligible: only npm dependency bumps auto-merge
```

> Fixture `f-empty` is defensive rather than reachable: `fetch-metadata` calls `setFailed` on an
> empty dependency array, so its own step fails and the gate never runs. The branch stays because
> the same condition also covers non-array input, which *is* reachable.

Then confirm malformed input fails rather than passing:

```bash
printf 'not json' | jq -r -f gate.jq; echo "exit=$?"
```

Observed: `jq: parse error: Invalid numeric literal at line 1, column 4`, `exit=5`. In the
workflow, `set -euo pipefail` turns that into a failed step, so the arm step never runs.

Prove the fixture copy has not drifted from the program in the workflow:

```bash
python3 - .github/workflows/dependabot-auto-merge.yml "$FIX/gate.jq" <<'PY'
import sys
wf = open(sys.argv[1]).read()
jq = open(sys.argv[2]).read().rstrip("\n")
print("jq program embedded verbatim in workflow:", jq in wf)
PY
```

Expected: `True`.

Return to the repository before continuing:

```bash
cd /Users/igorkamenetsky/Workspaces/Claude/llm-code-execution
```

- [ ] **Step 5: Confirm no required check name was introduced or changed**

```bash
gh api repos/igor-ka/llm-code-execution/rulesets/17055903 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

Expected: exactly `Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape`. The new job's
name `Dependabot auto-merge` must **not** appear, now or later.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/dependabot-auto-merge.yml
git commit -m "feat(ci): arm auto-merge for patch and minor Dependabot bumps"
```

---

## Task 3: Record it in `docs/sdlc.md`

**Files:**
- Modify: `docs/sdlc.md` — the "How this meets CI/CD" bullet list, and a new section after
  "Dependabot is exempt" in the SDLC-change section.

`.github/workflows/**` is in `WATCHED_RE`, so the `SDLC docs` job fails this PR without this task.
That is the mechanism working as designed: a new workflow is a process change.

- [ ] **Step 1: Add a bullet to "Details that are easy to get wrong"**

In `docs/sdlc.md`, in the `## How this meets CI/CD` section, insert this bullet immediately after
the existing bullet that begins **"Dependabot PRs are exempt from `SDLC docs`"**:

```markdown
- **One workflow is not a check: `Dependabot auto-merge`.** It runs on every pull request but
  does nothing unless the author is `dependabot[bot]`, and all it does then is press "enable
  auto-merge" on patch and minor bumps. The four required checks still decide whether the PR is
  mergeable. It is therefore **not** in the ruleset's required checks and **not** subject to the
  `verify.sh` mirroring rule above — that rule binds gates, and this gates nothing. It also holds
  the only writable `GITHUB_TOKEN` in this repository's CI, which is why it checks nothing out;
  see [Auto-merging dependency bumps](#auto-merging-dependency-bumps).
```

- [ ] **Step 2: Add the section**

Insert this at the **end** of the `## Changing this SDLC` section — after the paragraph beginning
"To take an upstream skill update:" and before the `---` that precedes `## One child per PR`.

> Not after "*A pin bump is not a process change.*", which is the intuitive spot: an `###`
> heading there would swallow the four paragraphs that follow it (the `exit 0`-vs-`if:`
> explanation, "The actual reasons are narrower…", "Both early exits are covered by…", and the
> upstream-skill-update paragraph), none of which belong under this heading.

```markdown
### Auto-merging dependency bumps

`.github/workflows/dependabot-auto-merge.yml` arms GitHub's native auto-merge on Dependabot PRs
where **every** dependency is a patch or minor bump. Majors are always merged by a human, because
a major is where a peer range breaks — #78 raised `vite` without `@vitejs/plugin-react` and died
at `npm ci`.

Two details in that rule are not decoration:

- **Every dependency, not the PR's highest reported update type.** On security updates Dependabot
  omits `update-type:` from the commit trailer, so the action falls back to parsing versions out
  of the PR body and yields nothing for an entry it cannot parse — #78's `esbuild` line reads
  "Removes `esbuild`". The summary output is the *max* across entries and skips those blanks, so a
  security PR whose only major is an unparseable entry reports minor. The gate reads the
  per-dependency JSON instead and fails closed on a blank, a missing key or malformed input.
- **`github_actions` never auto-merges.** This workflow pins its own action by SHA with the
  version in a trailing comment, and Dependabot bumps SHA pins by that comment — so a new
  third-party action SHA would arrive as a *patch* and merge unread. Nothing else would catch it:
  `SDLC docs` exits 0 for `dependabot[bot]`, `PR shape` passes, and no `verify.sh` reads workflow
  files.

**What it is not.** It does not weaken any gate. Native auto-merge waits for all four required
checks *and* for every review thread to be resolved. Copilot reviews every PR including
Dependabot's, so a single inline comment parks the merge until someone answers it. That is the
intended behaviour and was chosen deliberately over dropping
`required_review_thread_resolution` (issue #94): the feature is "auto-merge when nothing
objects", not "unattended merges". A parked PR is a correct outcome, not a bug to design around.

**Why it does not update stale branches.** `strict_required_status_checks_policy` is on, so a
merge to `main` leaves every other open PR out of date, and auto-merge will not update a branch
itself — that is what a merge queue is for. For Dependabot PRs the update arrives from Dependabot,
which rebases its own PRs by default and gives up after 30 days. The queue therefore drains on
Dependabot's cadence rather than instantly. If that becomes the bottleneck, the fix is a merge
queue, not dropping `strict` — but note that the built-in `GITHUB_TOKEN` cannot add a pull request
to a merge queue, so adopting one means re-authenticating this workflow with a PAT or a GitHub App
token.

**Security posture — different from every other job here.** `SDLC docs` and `PR shape` run
scripts from the PR branch under a read-only token. This one inverts both: it holds
`contents: write` and `pull-requests: write`, and so it checks nothing out and runs no repository
code. Its only third-party action is pinned to a full commit SHA. It uses `pull_request`, never
`pull_request_target`. Keep all four of those properties together — each one is load-bearing only
because the others hold.
```

- [ ] **Step 3: Verify the anchor resolves**

```bash
grep -n "Auto-merging dependency bumps" docs/sdlc.md
```

Expected: two lines — the heading, and the cross-reference from the CI bullet.

- [ ] **Step 4: Commit**

```bash
git add docs/sdlc.md
git commit -m "docs(sdlc): record the Dependabot auto-merge workflow and its posture"
```

---

## Task 4: Push and open the PR

**Files:** none.

The branch was cut in Task 2, Step 1, and both commits are already on it. Confirm before pushing:

```bash
git branch --show-current   # expect: feat/dependabot-auto-merge
git log --oneline origin/main..HEAD
```

Expected: exactly two commits — the workflow and the `docs/sdlc.md` update.

- [ ] **Step 1: Push**

```bash
git push -u origin feat/dependabot-auto-merge
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "feat(ci): auto-merge green patch and minor Dependabot bumps" --body "$(cat <<'EOF'
Arms GitHub native auto-merge on Dependabot PRs whose highest semver change is patch or minor.
Majors stay manual.

Nothing about the "Protect main" ruleset changes. The four required checks and
`required_review_thread_resolution` still decide whether the PR merges — this only presses the
button in advance. A Copilot comment parks the merge, which is the behaviour chosen in #94.

- `dependabot/fetch-metadata` pinned to a full commit SHA (v3.1.0), not a moving tag.
- `pull_request`, never `pull_request_target`.
- No checkout: this is the only job in the repository holding a writable token, so no code from
  the PR branch runs inside it.
- `--squash`, because the ruleset allows only squash and rebase.

`allow_auto_merge` was enabled on the repository separately; it is a settings change with no diff.

Closes #94
EOF
)"
```

- [ ] **Step 3: Confirm the new job is skipped on this PR and the four gates ran**

```bash
gh pr view --json number,mergeStateStatus,statusCheckRollup \
  --jq '{n: .number, state: .mergeStateStatus, checks: [.statusCheckRollup[] | {name: (.name // .context), c: (.conclusion // .state)}]}'
```

Expected: `Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape` all `SUCCESS`.
`Dependabot auto-merge` is either absent or `SKIPPED` — the `if:` excludes a human author. A
skipped job reports Success and is not a required check either way.

---

## Task 5: Code review and security review

**Files:** whatever the findings require.

Both are mandatory per `CLAUDE.md`; neither is skipped because the diff is small. This diff is
*exactly* the shape security review exists for — a writable token in CI.

- [ ] **Step 1: Push first.** The review agents check out branches in this shared working tree.
      Push before dispatching, and re-check `git rev-parse HEAD` afterwards.

- [ ] **Step 2: Run the `code-review` skill against the pending diff.**

- [ ] **Step 3: Run the `security-review` skill against the pending diff.** Specifically confirm
      it reasons about: the writable token, the absence of checkout, the SHA pin, `pull_request`
      vs `pull_request_target`, and whether `user.login` is forgeable.

- [ ] **Step 4: Evaluate every finding with `receiving-code-review`.** Verify each against the
      codebase before acting. Push back with reasoning where a finding is wrong; fix what is real.

- [ ] **Step 5: Check Copilot's review and answer every thread.**
      `required_review_thread_resolution` is on — an unresolved thread blocks the merge.

```bash
gh pr view --json reviewDecision,reviews --jq '{decision: .reviewDecision, reviewers: [.reviews[].author.login]}'
```

- [ ] **Step 6: Commit and push any fixes.**

---

## Task 6: Merge

**Files:** none.

- [ ] **Step 1: Confirm mergeable**

```bash
gh pr view --json mergeStateStatus --jq '.mergeStateStatus'
```

Expected: `CLEAN`. `BEHIND` means `main` moved — update the branch and re-check. `BLOCKED` means a
check is red or a thread is unresolved.

- [ ] **Step 2: Merge**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 3: Note that #94 auto-closes here**

The `Closes #94` line closes the issue on merge, before Task 7 has proved anything. That is
GitHub's behaviour, not a signal that the work is done. Leave it closed only if Task 7 passes;
reopen it if the live test fails.

---

## Task 7: Live acceptance — one positive, one negative

**Files:** none. This is the real test of this change, and it can only run once the workflow is on
`main`.

Two open PRs are the fixtures. Re-check they are still open and still have these shapes before
using them; if either has been merged or closed, substitute the current equivalent from
`gh pr list --author app/dependabot`.

- **Positive:** #117 — `globals` 17.7.0 → 17.9.0 in `/backend`. A **minor** dev-dependency bump.
- **Negative:** #120 — `jsdom` 25.0.1 → 30.0.1 in `/frontend`. A **major**.

For `pull_request` events the workflow file is read from the merge commit, so a workflow that is
on `main` applies to an already-open PR on its **next event** — the branch does not have to
contain it. What is needed is therefore just an event: `@dependabot rebase` produces one
immediately instead of waiting for the weekly run.

If Dependabot replies "already up to date", the rebase is a no-op — no push, no `synchronize`, no
run. Use `@dependabot recreate` as the fallback. Unlikely to be needed here, since merging this
PR moves `main` and leaves every open Dependabot PR `BEHIND`.

**The pass condition, decided in advance.** `copilot_code_review` runs on every PR and
`required_review_thread_resolution` is on, so #117 may sit armed-but-parked on an unresolved
Copilot thread. **That counts as passing** #94's "merges with no human interaction" criterion —
parking is the behaviour #94 chose deliberately, and a criterion that forbids it would be
untestable. The follow-through is required, though: resolve the thread, then confirm the PR merges
with **no further interaction**. Only these count as failures: auto-merge is not armed on #117, or
it *is* armed on #120.

- [ ] **Step 1: Confirm both fixtures still match**

```bash
gh pr view 117 --json number,title,state,mergeStateStatus
gh pr view 120 --json number,title,state,mergeStateStatus
```

- [ ] **Step 2: Force a rebase of the positive fixture**

```bash
gh pr comment 117 --body "@dependabot rebase"
```

- [ ] **Step 3: Wait for the rebase, then watch the run**

```bash
gh run list --workflow "Dependabot auto-merge" --limit 5
```

Expected: a run appears for #117's branch, `Fetch Dependabot metadata` succeeds, the
`Decide whether this PR may auto-merge` step prints `eligible`, and `Arm auto-merge` runs (not
skipped).

- [ ] **Step 4: Confirm auto-merge is armed on #117**

```bash
gh pr view 117 --json autoMergeRequest --jq '.autoMergeRequest'
```

Expected: a non-null object with `"mergeMethod": "SQUASH"`.

- [ ] **Step 5: Confirm it merges with no human interaction**

```bash
gh pr view 117 --json state,mergedAt,mergedBy --jq '{state, mergedAt, mergedBy: .mergedBy.login}'
```

Expected: `state: MERGED`. If it stays open with every check green and `autoMergeRequest` still
set, the cause is an unresolved Copilot thread — the accepted outcome above. Resolve the thread,
then re-run this command and confirm it merged with no further interaction. Record which path it
took.

- [ ] **Step 6: Negative control — force a rebase of the major**

```bash
gh pr comment 120 --body "@dependabot rebase"
```

- [ ] **Step 7: Confirm auto-merge is NOT armed on #120**

```bash
gh run list --workflow "Dependabot auto-merge" --limit 5
gh pr view 120 --json state,autoMergeRequest --jq '{state, auto: .autoMergeRequest}'
```

Expected: the run exists, the `Explain why auto-merge was not armed` step ran and printed
`not-eligible: at least one dependency is not patch or minor`, `auto` is `null`, and `state` is
`OPEN`. **If #120 auto-merges, that is the failure this control exists to catch** — revert
immediately (`allow_auto_merge=false` is the fastest kill switch; `git revert` the merge commit
removes the workflow).

- [ ] **Step 7b: Confirm the eligible → ineligible transition disarms**

Added after the Copilot review. Arming is sticky, so the transition is the case that matters and
neither fixture covers it. Do it on a PR that is already armed (#117 if Step 4 armed it and it has
not merged; otherwise the next eligible bump):

```bash
gh pr view <PR> --json autoMergeRequest --jq '.autoMergeRequest.mergeMethod'   # expect: SQUASH
gh pr comment <PR> --body "@dependabot recreate"
```

`recreate` rewrites the branch. If the rewritten PR is still patch/minor the verdict stays
`eligible` and nothing changes — that is not the test. To reach the transition, use a grouped PR
that Dependabot refreshes across a major, or verify the branch directly:

```bash
gh run list --workflow "Dependabot auto-merge" --limit 3
gh pr view <PR> --json autoMergeRequest --jq '.autoMergeRequest'
```

Expected when the verdict flips to `not-eligible`: the `Disarm auto-merge if it is no longer
eligible` step runs, prints `auto-merge disarmed`, and `autoMergeRequest` becomes `null`. If no
natural transition occurs within the acceptance window, record that it was not exercised rather
than claiming it was — the step's own failure path (`FAILED to disarm auto-merge on an ineligible
PR`) is loud, so an unexercised path is a known gap, not a silent one.

- [ ] **Step 8: Note whether the post-merge `CI` run on `main` fired**

```bash
gh run list --workflow CI --branch main --limit 3
```

`ci.yml` also triggers on `push: branches: [main]`. Events triggered by `GITHUB_TOKEN` do not
start new workflow runs, so an auto-merge armed by this workflow may produce no push-side CI run.
That is expected to be harmless — `strict` means the PR's checks already ran against this exact
base — but confirm which way it went and, if the run is missing, add one line saying so to the
`Auto-merging dependency bumps` section of `docs/sdlc.md` in a follow-up. Do not guess in advance.

- [ ] **Step 9: Close the loop on #94**

Comment on #94 with the outcome of Steps 4–8, ticking the acceptance criteria against real
evidence (PR numbers, run URLs). If it auto-closed at Task 6 and Task 7 failed, reopen it.

---

## Acceptance criteria (from #94)

- [ ] `required_review_thread_resolution` question answered and recorded — **already done** in the
      issue body, 2026-08-10. No ADR needed: the decision was to keep an existing rule, not
      reverse one.
- [ ] `allow_auto_merge` enabled on the repository — Task 1.
- [ ] A workflow arms auto-merge for `dependabot[bot]` PRs on patch and minor updates only —
      Task 2.
- [ ] Uses `--squash`; `fetch-metadata` pinned to a full SHA; no `pull_request_target` — Task 2.
- [ ] A real patch or minor Dependabot PR merges with no human interaction — Task 7, Steps 2–5.
- [ ] A real **major** Dependabot PR is confirmed *not* to auto-merge — Task 7, Steps 6–7.
- [ ] `docs/sdlc.md` updated in the same PR — Task 3.

## Rollback

Three levers, cheapest first:

1. `gh api -X PATCH repos/igor-ka/llm-code-execution -F allow_auto_merge=false` — instant, kills
   every armed auto-merge repository-wide, no PR needed.
2. `gh pr merge --disable-auto <PR>` — disarms one PR.
3. `git revert` the merge commit — removes the workflow.

Nothing here is one-way. No gate is weakened, so the worst case is a patch or minor bump merging
that someone would rather have read first.

Note that `allow_auto_merge` is repository-wide: enabling it also lets any human with write access
arm auto-merge on their own PRs. That is a wider blast radius than "Dependabot bumps", and lever 1
above is what reverses it.

---

## Plan review log

Staff-engineer review 2026-08-10 — **applied without asking** (mechanical):

- **Task 2, new Step 1:** branch creation moved here from Task 4. As written, both `git commit`
  steps ran before the branch existed, so the commits would have landed on whichever branch this
  shared tree was on and `feat/dependabot-auto-merge` — cut fresh from `origin/main` — would have
  pushed nothing. Task 2's remaining steps renumbered 2–5; Task 4 now starts at "Push" and
  verifies the two commits are on the branch.
- **Task 2, Step 3:** replaced `python3 -c "import yaml…"` with
  `npx --yes js-yaml … | python3 -c "import json…"`. Verified: `python3` here has no `yaml`
  module, and there is no `yq` or `actionlint` on PATH. Deleted the note about `on:` parsing as
  boolean `True` — js-yaml 4 uses the YAML 1.2 core schema, so it does not apply.
- **Task 3, Step 2:** insertion point moved to the **end** of `## Changing this SDLC`. The
  original point would have put an `###` heading mid-section, pushing four unrelated paragraphs
  underneath it.
- **Task 3, Step 2 body:** appended the merge-queue caveat — the built-in `GITHUB_TOKEN` cannot
  add a PR to a merge queue, so adopting one means re-authenticating this workflow with a PAT or
  App token. Without it, `docs/sdlc.md` would point a future reader at a change that silently
  breaks this workflow.
- **Rollback section:** added the note that `allow_auto_merge` is repository-wide.

The reviewer independently confirmed, against the live repository and the action's source at the
pinned SHA: the SHA is v3.1.0; a `permissions:` block does raise a Dependabot-triggered run's
token above the repository default; `update-type` is the max over `major → minor → patch`;
`--squash` matches the ruleset; a workflow on `main` does apply to an already-open PR on its next
event; and `GITHUB_TOKEN`-triggered events do not start new workflow runs.

**Escalated to the user — decided 2026-08-10, all four resolved before implementation started:**

- **Grouped security updates can under-report `update-type`.** Confirmed directly against PR #78:
  its commit trailer carries no `update-type:` key on any entry, and `esbuild` has an empty
  `dependency-version:`. **Decision: fail closed per dependency.** The gate reads
  `updated-dependencies-json` and requires every entry to declare patch or minor. The reviewer's
  cheaper suggestion — `dependency-type != 'indirect'` — was rejected because it does not cover
  the observed shape: `dependency-type` is also a max, and #78 would report `direct:development`
  and pass it.
- **This workflow would auto-merge bumps to its own pinned action SHA.** **Decision: exclude the
  `github_actions` ecosystem** in the same jq gate.
- **Pass condition when Copilot parks the acceptance PR.** **Decision: parked counts as passing**,
  with the follow-through spelled out in Task 7 — resolve the thread, confirm it then merges with
  no further interaction. Only "not armed on #117" or "armed on #120" are failures.
- **#94's "enforced-layer list should name the new job".** **Decision: not implemented**, recorded
  under *File structure* above with the reasoning, plus a note that the row is separately stale.

Advisory items from the review, also applied: `@dependabot recreate` as the Task 7 fallback, and
the corrected reason for why an open PR picks up a workflow that is on `main` (the merge commit,
not the branch contents). The "already mergeable" note was written into the workflow and then
superseded — see below.

---

## Code review log

`code-review` and `security-review` on PR #126, 2026-08-10. The security review found nothing:
no checkout, no `${{ }}` interpolated into any `run:` body, the `if:` uses GitHub-expression `==`
(exact, no glob), fork PRs are capped at a read token regardless of `permissions:`, the action is
SHA-pinned, and the `verdict` value is one of a fixed set of literals so it cannot forge a second
`$GITHUB_OUTPUT` line.

`code-review` found four real defects. All four are fixed in the merged workflow:

1. **No disarm path.** Arming is sticky — GitHub disables auto-merge only when someone *without*
   write permission pushes to the head branch, and Dependabot has write. A grouped PR armed while
   patch-only and later updated in place to carry a major would have stayed armed and merged that
   major unattended, which is the exact outcome this workflow exists to prevent. Added a
   `gh pr merge --disable-auto` step, gated on `github.event.pull_request.auto_merge != null`.
2. **The gate bound `commits[0]`, auto-merge binds HEAD.** `fetch-metadata` reads and
   signature-checks only the first commit. Added a single-commit rule; verified that all eleven
   open Dependabot PRs carry exactly one commit, so it costs nothing.
3. **The diagnostic jq crashed on the input the verdict handles.** `jq '.[]'` on non-array input
   exits 5, and under `set -euo pipefail` that failed the step and skipped the `Explain` step —
   the fail-closed path produced a raw jq trace instead of its own reason. Guarded with
   `if type == "array"`, and `// "?"` added to `prevVersion`/`newVersion`, which are exactly the
   fields that are absent in the security-update case the log exists to explain.
4. **`reopened` made the "already mergeable" case reachable.** Check results survive a
   close/reopen, so reopening a green PR would run the arm step against an immediately-mergeable
   PR, where `gh pr merge --auto` errors. Dropped `reopened` from the trigger rather than
   documenting the case as impossible.

Two further findings were accepted as improvements rather than defects:

5. **Rule 2 was a deny-list.** Blocking `github_actions` admitted every ecosystem added later —
   and #110 proposes `docker`, where a base-image digest bump has the same "nobody reads it"
   property. Inverted to an allow-list of `npm_and_yarn`.
6. **`contents: write` was broader than the operation needs.** `gh pr merge --auto` enables
   auto-merge; GitHub performs the merge later. Dropped to `pull-requests: write` alone. This is
   the one change not verified locally — Task 7 is where it is proved. If the arm step fails with
   a 403 or "Resource not accessible by integration", add `contents: write` back.

**Pushed back on, not applied:**

- *"`docs/sdlc.md`'s claim that `PR shape` passes on Dependabot PRs is false"* — the reviewer
  constructed a body whose embedded release notes carried `resolve #1234` and showed the script
  counting three issues. The constructed risk is real, but the claim is not false: the script was
  run against four real bot bodies including `@anthropic-ai/sdk` 0.68.0 → 0.116.0 (48 minor
  versions of changelog) and `jsdom` 25 → 30, and all four print "closes no issue" — consistent
  with the existing verification against #73, #74, #75, #77 and #78 and with `PR shape` reporting
  SUCCESS on every open bot PR today. The reviewer also called the claim load-bearing for the
  ecosystem argument; it is not. An *accidental* `PR shape` failure is not somebody reading the
  diff, so the argument for excluding `github_actions` holds either way.
- *"Hard-coding the repository slug means a rename silently skips the job"* — true, but the
  proposed `github.repository_owner` has the same failure mode on a transfer, and the slug is
  already hard-coded in `scripts/check-pr-shape.sh`. Churn without a fix.

### Copilot review, same PR

Copilot found the one thing both other reviews missed, and it invalidated a claim this plan made
about its own design:

7. **The ecosystem rule ran too late by construction.** For `pull_request` the workflow file is
   read from the merge ref — a fact this plan already used to explain why open PRs pick up a
   workflow on `main`, without noticing the consequence. A Dependabot PR bumping this workflow's
   own `fetch-metadata` pin would therefore execute the *replacement* action under the job's
   writable token, and only afterwards reach a jq rule that rejects `github_actions`. Any rule
   built on metadata the third-party action produces cannot protect the step that produces it.
   Fixed by hoisting the allow-list into the job-level `if:` as
   `startsWith(github.head_ref, 'dependabot/npm_and_yarn/')`, which is event data evaluated before
   the first step. The jq rule stays as defence in depth. Dropping `contents: write` had already
   bounded the blast radius of this to "can enable auto-merge", not "can push to `main`".
8. **The disarm step trusted a snapshot.** It was gated on
   `github.event.pull_request.auto_merge != null`, a field captured when the event fired; being
   wrong about it in the "already armed" direction is the exact failure the step exists to
   prevent. It now attempts the disarm unconditionally and, if that errors, re-reads the live
   state and fails loudly unless auto-merge really is off.

Copilot's remaining two comments were already addressed by the `code-review` fixes in the
preceding commit — the deny-list-not-fail-closed point (a missing or null `packageEcosystem` now
fails the `!= "npm_and_yarn"` test) and the missing disarm path.

Also applied: a paragraph in `README.md`'s CI section noting that a fourth pull-request workflow
exists and gates nothing. The reviewer flagged this as a judgment call under the documentation
rule in `CLAUDE.md`; a workflow that merges to `main` is close enough to "security posture" to
name.

---

## Live acceptance results — 2026-08-10, after PR #126 merged as `66bca9b`

Three fixtures, rebased with `@dependabot rebase` to produce a `synchronize` event.

**The gate is correct.** Both npm runs produced the right verdict and the right diagnostic:

| PR | Bump | Verdict | Diagnostic |
| --- | --- | --- | --- |
| #117 | `globals` 17.7.0 → 17.9.0 | `eligible` | `globals: 17.7.0 -> 17.9.0 [version-update:semver-minor]` |
| #120 | `jsdom` 25.0.1 → 30.0.1 | `not-eligible: at least one dependency is not patch or minor` | `jsdom: 25.0.1 -> 30.0.1 [version-update:semver-major]` |

**The `github_actions` exclusion works, and it works in the right place.** #98
(`actions/setup-node` 4 → 7) produced **no run at all** — the job-level `if:` rejected it on
`head_ref` before any step, so `fetch-metadata` never executed. That is the property the Copilot
finding was about, and only a live run could demonstrate it: a jq-level rule would have shown the
same verdict while still having run the action.

**Two defects, both fixed in the follow-up PR.**

1. **`pull-requests: write` alone is not sufficient.** Run 31432435114 failed with
   `GraphQL: Resource not accessible by integration (enablePullRequestAutoMerge)`, and run
   31432454576 failed identically on `disablePullRequestAutoMerge`. Both auto-merge mutations are
   gated on the `contents` scope. This was the one change shipped on reasoning rather than
   evidence, flagged as such at the time, and the reasoning was wrong — GitHub's documented
   example carries `contents: write` for a reason. Restored, with the run IDs recorded in the
   workflow so nobody re-derives it.
2. **The disarm fallback's not-armed check never matched.** `gh pr view --json autoMergeRequest
   --jq '.autoMergeRequest'` prints an **empty string** when the field is null, not the text
   `null`. Verified directly: the raw form returns a zero-length string, while
   `--jq 'if .autoMergeRequest == null then "no" else "yes" end'` returns `no`. So an ineligible
   PR that was never armed took the loud failure path. Switched to the predicate form, which also
   makes an empty value mean "`gh` itself failed" — which correctly falls through to the loud
   path.

Neither defect could reach `main`: the failures are in a job that gates nothing, and in both cases
the outcome was "auto-merge not armed".

**Still unproven, honestly:** no PR has auto-merged yet, so #94's "merges with no human
interaction" criterion is not yet met — it is blocked on defect 1, not on the design. Task 7 Steps
4–5, 7b and 8 are re-run after the follow-up lands.

### Review of the follow-up (PR #127)

`security-review` found nothing. `code-review` found two more real defects and one design
consequence of restoring `contents: write` that the follow-up itself had introduced:

10. **The disarm step failed open.** A step `if:` without a status function is implicitly ANDed
    with `success()`, so a failure in `Fetch Dependabot metadata` or in the gate skipped the
    disarm entirely — leaving an armed PR armed. Confirmed in run 31432454576, where the `Explain`
    step never appeared after the disarm step failed. Both non-eligible steps now carry
    `!cancelled()`, and an unknown verdict takes the disarm path rather than the skip.
11. **`set -uo pipefail` never cleared errexit.** GitHub invokes steps as `bash -e {0}`, so
    errexit is already on and `set -u -o pipefail` does not turn it off. The `gh`-failure branches
    added in this very PR were unreachable — the script died at the assignment. The comment
    claiming otherwise was wrong in exactly the way the PR was correcting elsewhere. Fixed with an
    explicit `set +e`, and covered by the stub test below.
12. **Restoring `contents: write` made `--disable-auto` work for the first time — including
    against humans.** `allow_auto_merge` is repository-wide, so a maintainer can read a major and
    arm auto-merge by hand. The next Dependabot rebase would have silently revoked that decision.
    The step now reads `autoMergeRequest.enabledBy.login` first and only disarms what
    `github-actions[bot]` armed.

**One architectural change, reversible if you disagree.** `code-review` pointed out that with
`contents: write` restored, the single job hands a main-writable token to
`dependabot/fetch-metadata` — making the SHA pin the only control rather than defence in depth.
The workflow is now two jobs: `gate` (third-party action, `pull-requests: read`, publishes a
verdict) and `apply` (`contents: write`, runs only `gh`). This is *not* the two-job design
rejected during planning — that one required a checkout to run a repository script, and this one
still checks nothing out. The rejection reasoning does not carry over.

**The shell logic now has a test.** `test-driven-development` applies to a bug fix, and finding 11
is exactly the kind a test catches. The disarm script cannot move to `scripts/` — that would need
a checkout in the privileged job — so instead it is **extracted verbatim from the workflow YAML**
and run under `bash -e` (the runner's actual shell) against a stub `gh`:

| Case | Expected |
| --- | --- |
| not armed | exit 0, "nothing to disarm" |
| armed by a human | exit 0, "leaving it alone" |
| armed by the bot, disarm succeeds | exit 0, "auto-merge disarmed" |
| armed by the bot, disarm fails | **exit 1**, loud |
| `gh pr view` fails | **exit 1**, "refusing to assume it is disarmed" |
| armed by `github-actionsb` | exit 0, treated as a human — the unquoted-`[bot]`-is-a-glob regression |

All six pass. The fifth is the one that was dead code before finding 11.

### Second live run — the fix worked, and exposed one more

After #127 merged as `ea41038`, the three fixtures were rebased again.

**`contents: write` was the answer.** #117 armed successfully:
`{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"app/github-actions"}}`. The claim
that had been reasoned rather than proven is now proven.

**Both remaining controls held.** #120 (major) was not armed and the run exited 0 — the disarm
step's "not armed, nothing to disarm" path, which had been failing incorrectly. #98
(`github_actions`) produced a run in which **both** jobs report `skipped`, so the write-scoped
`apply` job never starts for that ecosystem.

**And a thirteenth defect, of exactly the kind this plan claimed a unit test could not catch.**

13. **The disarm step keyed on the wrong login string.** It compared
    `autoMergeRequest.enabledBy.login` against `github-actions[bot]`. `gh` renders a Bot actor as
    **`app/github-actions`** — the underlying GraphQL `Bot.login` is bare `github-actions`, and
    neither is the string the code tested. So every bot-armed PR took the "a human armed this,
    leave it alone" branch, silently reinstating the sticky-arming bug the step exists to
    prevent. Verified against the live payload: the old expression yields `app/github-actions`
    and the old comparison sends it down the human branch.

    This is the failure mode named in *How this change is tested* — a wrong constant, where the
    stub test asserted the same wrong constant the implementation did and passed. The fix keys on
    `enabledBy.is_bot`, a boolean, which is rendering-independent.

    **The test was strengthened so it could have caught it.** The stub `gh` no longer returns a
    hand-written answer; it now runs the **real jq expression from the workflow** over **real
    captured payloads**, including the exact object `gh` returned for #117. A hand-written stub
    can only encode what the author believes; a captured payload encodes what GitHub actually
    sends. That distinction is the whole lesson of this defect.

    > **Correction, same day.** When that paragraph was first written the harness lived in a
    > scratch directory and was never committed — so "the test was strengthened" described
    > something no reader could run, which the review of #128 caught and was right to call out.
    > It is now `scripts/tests/dependabot-auto-merge-disarm.test.sh`, ten cases, run by the
    > `SDLC docs` job, and it was mutation-checked: reverting the `is_bot | type` guard makes two
    > cases fail, and restoring it makes them pass.

### #94's acceptance criteria — final status

| Criterion | Status |
| --- | --- |
| `required_review_thread_resolution` question answered and recorded | ✅ in the issue body, 2026-08-10 |
| `allow_auto_merge` enabled on the repository | ✅ Task 1 |
| Workflow arms auto-merge for `dependabot[bot]` patch/minor only | ✅ #126, corrected by #127 and #128 |
| `--squash`; `fetch-metadata` pinned to a full SHA; no `pull_request_target` | ✅ |
| **A real patch or minor Dependabot PR merges with no human interaction** | ✅ **PR #117 merged as `8211ee8` at 21:36:05 by `app/github-actions`** |
| A real **major** Dependabot PR is confirmed *not* to auto-merge | ✅ #120, `not-eligible: at least one dependency is not patch or minor` |
| `docs/sdlc.md` updated in the same PR | ✅ |

**Task 7 Step 8, answered.** The auto-merge produced **no `push`-side `CI` run on `main`** —
`8211ee8` has none, while every human-merged commit around it does. This confirms the documented
rule that `GITHUB_TOKEN`-triggered events do not start new workflow runs. Recorded in
`docs/sdlc.md` rather than left as folklore.

**Task 7 Step 7b (the eligible → ineligible disarm transition) has still not been exercised
live.** No open PR has made that transition. The path is covered by
`scripts/tests/dependabot-auto-merge-disarm.test.sh` and its failure mode is loud, but it has not
run in production — stated here as a known gap rather than claimed as verified.

### Review of #128 — four more, and one that mattered

`security-review` found nothing: the actor check is not spoofable without write access, and the
parameter expansions are unquoted-glob-free. `code-review` found four real problems.

14. **`is_bot // false` could not distinguish `false` from absent.** `enabledBy` is a nullable
    Actor in GraphQL (deleted account, uninstalled app), so `is_bot` can be missing entirely — and
    a bare `// false` reads that as "a human armed it" and leaves an ineligible PR armed. This is
    reachable today, not only after a `gh` upgrade. Now `is_bot | type` must be `"boolean"`, and
    anything else fails the step closed.
15. **`is_bot` alone matches *any* app.** A maintainer running `@dependabot merge` on a major
    after reading it would have been silently overridden on the next rebase — the same
    revoke-a-considered-decision defect the step's own comment warns about, relocated. The check
    now requires `is_bot` **and** a login of `github-actions` / `app/github-actions`.
16. **The gate-failure branch disarmed while claiming a judgement it had not made.** An empty
    verdict means `gate` failed, not that the PR was found ineligible. Disarming is still correct
    — an unknown verdict must not stay armed — but the log said "the PR no longer qualifies". It
    now reports which of the two it was.
17. **A workflow comment claimed #98 "produced no run at all".** False: a job-level `if:`
    suppresses the *jobs*, not the run. Run 31434426736 exists with both jobs `skipped`. The
    comment now says that, because someone auditing the allow-list would otherwise look for
    evidence that does not exist. (The same wrong claim was made to the user in conversation and
    corrected there.)

18. **"Fail closed" did not fail closed** — Copilot, on the fix for finding 14. The indeterminate
    branch exited 1 without disarming, which reads as safe and is not: this workflow is
    deliberately **not a required check**, so a red job blocks nothing and the armed PR merges
    anyway. Refusing to act is fail-*open* with a red light nobody has to obey. The only lever the
    workflow actually has is `--disable-auto`, so the indeterminate case now disarms first and
    fails the job second. Revoking a possible human decision is visible and one click to undo; an
    unattended merge of an ineligible PR is neither. Four test cases assert the disarm happened,
    not merely that the exit code was non-zero — the assertion the first version would have
    passed while being wrong.

Copilot, reviewing the same PR, independently raised the missing-test point and went one further:
*run it from CI*. Initially the test was committed as a documented pre-push command, on the
grounds that the auto-merge workflow cannot host it. That reasoning was right about the owner and
wrong about the conclusion — a test nobody runs automatically is a procedure, not a guarantee, and
this repository's whole premise is the difference between the two. It now runs as a step in the
**`SDLC docs`** job, which already has a checkout and a read-only token, runs on every pull
request, and exists to check that a process change is self-consistent. The test reads files only
and needs no token.

Also applied: `**is_bot**` inside a code span rendered literally in `docs/sdlc.md`; the
`GITHUB_TOKEN` claim was narrowed to `push`/`pull_request` since `workflow_dispatch` and
`repository_dispatch` are documented exceptions; the two-field unpack became `read -r kind who`;
and the third near-verbatim copy of the bug post-mortem was cut from the workflow comment, which
now states the decision and points at `docs/sdlc.md`.
