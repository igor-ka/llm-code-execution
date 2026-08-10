# Dependabot version updates — Implementation Plan

**Goal:** Add scheduled Dependabot version updates for backend npm, frontend npm and
`github-actions`, and stop `github-actions` bumps from failing the `SDLC docs` job.

**Architecture:** One config file plus one narrow exemption. `.github/dependabot.yml` declares
three ecosystems, with the vite/vitest toolchain grouped so peer-linked packages always move
together. The exemption lives **inside `scripts/check-sdlc-sync.sh`** as an early `exit 0` on
`PR_ACTOR == "dependabot[bot]"`, not as a job-level `if:` — `SDLC docs` is a required status
check, and a check that reports *skipped* instead of *success* can leave a PR unmergeable
forever. The two early-exit branches gain a unit suite, run both locally and as the job's first
step, matching the `PR shape` pattern.

**Tech Stack:** Dependabot config v2, GitHub Actions, Bash.

**Issue:** [#56](https://github.com/igor-ka/llm-code-execution/issues/56) — read its
*Findings from the first real run* section first; findings 1 and 3 are the two decisions this
plan implements.

> **Post-implementation correction — this plan's central rationale is wrong.** Copilot review
> challenged it and was right: GitHub reports a job skipped by a job-level `if:` as *Success*,
> and it **satisfies** a required status check — *"A job that is skipped will report its status
> as 'Success'. It will not prevent a pull request from merging, even if it is a required
> check."* The case that hangs a merge forever is a workflow-level `paths:`/`branches:` filter,
> where the check never reports at all.
>
> The decision (exit 0 inside the script) stands, on narrower ground: a job-level `if:` would
> skip the `Self-test` step too, so the suite guarding the exemption would not run on the PRs it
> exists for — and a skipped job says nothing in the checks list, where an exercised bypass
> should be visible. Wherever this document says a skipped required check "blocks the merge
> permanently", read the corrected reasoning in `docs/sdlc.md` and `scripts/check-sdlc-sync.sh`.
> Issue #56's finding 1 was corrected the same way.

**PR boundaries:** One PR, closing #56. The config and the exemption are not separable: the
first `github-actions` bump fails `SDLC docs` the moment the config exists, so shipping the
config alone would knowingly break the queue it creates. `docs/sdlc.md` is touched by both
halves regardless.

---

## Design notes the tasks assume

**1. Why the exemption is an `exit 0`, not a job-level `if:`.** #56 originally recommended "add
an actor check to the job's `if:`". That predates `SDLC docs` becoming a **required** status
check (2026-08-09). A skipped job does not report success, and a required check that never
reports success blocks the merge — turning a nuisance failure into a permanent one. The script
must still run and still print a success line. Same reasoning kept the `PR shape` self-test a
step rather than a conditional job.

**2. Why actor-based is safe here.** `github.event.pull_request.user.login` is set by GitHub and
is not attacker-controllable — unlike the title and body, which is why those already travel via
`env:`. `PR_ACTOR` travels the same way for consistency, never interpolated into `run:`. The
widening is narrow in practice: Dependabot only ever touches manifests, lockfiles, and `uses:`
lines. It cannot reach `.claude/skills/**` or `scripts/`.

**3. Grouping is the whole reason majors are survivable — and each ecosystem needs *two* groups.**
Finding 3 in #56: #77 raised `vite` `^5 → ^8` *with* `@vitejs/plugin-react` `^4 → ^6` and went
green; #78 raised the same `vite` without the plugin and died at `Install` with
`ERESOLVE — Conflicting peer dependency: vite@7.3.6`. Default grouping is not peer-aware, so the
`groups:` blocks name the toolchain explicitly.

**The trap:** `groups.<name>.applies-to` defaults to `version-updates` — GitHub's options
reference says verbatim *"When undefined, defaults to version updates."* A single group would
therefore have **no effect on security updates**, and #77 and #78 were both security PRs. The
config that motivated grouping would not be covered by it. So each npm ecosystem declares the
same patterns twice, once per update type.

This is sharper for the backend than it looks. Version updates cover **direct** dependencies;
security updates also cover **transitive** ones. The backend's only direct toolchain dependency
is `vitest` — its `vite` is transitive, so `vite` there can *only* ever be bumped by a security
update, which is precisely the path a version-updates-only group misses.

The frontend group carries `@vitejs/*`; the backend has no plugin-react. **They are deliberately
not identical.** Neither manifest declares `esbuild`, so it is not in either list — a pattern
matching nothing is legal but misleading.

**4. `.github/dependabot.yml` is not itself a watched path.** `WATCHED_RE` matches
`^\.github/workflows/`, and the config sits one level up at `.github/dependabot.yml`. Adding it
does not trip the `SDLC docs` job on its own — but this PR also edits
`scripts/check-sdlc-sync.sh`, which does, so `docs/sdlc.md` is required either way.

**5. Only the early exits get tested, and the negative cases must not read the repo's diff.**
`check-sdlc-sync.sh` has no suite today. The base-resolution logic needs git fixtures (merge
refs, moving bases) and is out of scope. The two early exits need nothing but environment
variables, so they are cheap to cover and they are exactly the logic this PR adds.

Positive cases assert **stdout content plus exit code** — every early exit returns 0 and so does
"no watched files changed", so an exit code alone cannot tell a working exemption from a silent
fall-through.

Negative cases assert the exemption line is **absent**, and ignore the exit code entirely. This
matters: anything that asserts what the script prints *after* the early exits is reading the
working tree's diff against its base, which differs between a local checkout and CI's merge ref
— and on this very branch that diff contains watched files, so such a case would be red by
construction. The unit under test is "did the early exit fire?", nothing further.

**6. `open-pull-requests-limit: 5` per ecosystem is #56's number and is kept.** Worth knowing
that `strict_required_status_checks_policy: true` means each merge invalidates every other open
PR's up-to-date status, so concurrent bumps serialise behind Dependabot's rebases. Fifteen
possible open PRs across three ecosystems is a slow queue, not a broken one. If it proves
annoying, lowering the limits is a one-line follow-up — not a reason to guess now.

---

## File structure

| File | Responsibility |
| --- | --- |
| `.github/dependabot.yml` | **Create.** Three ecosystems, weekly, toolchain grouped for both update types |
| `docs/plans/2026-08-10-dependabot-config.md` | **Create.** This plan — committed in Task 1, since nothing enforces it |
| `scripts/tests/check-sdlc-sync.test.sh` | **Create.** Unit suite for the two early-exit branches |
| `scripts/check-sdlc-sync.sh` | **Modify.** `PR_ACTOR` exemption + usage comment |
| `.github/workflows/sdlc-docs.yml` | **Modify.** Pass `PR_ACTOR`; run the self-test first |
| `docs/sdlc.md` | **Modify.** Document the exemption and the new local command |

No application code changes. `README.md` is deliberately untouched: it describes *what* the
`SDLC docs` job enforces, and a bot exemption does not change what a reader following it would
do.

---

## Task 1: The Dependabot config

**Files:**
- Create: `.github/dependabot.yml`
- Create: `docs/plans/2026-08-10-dependabot-config.md` (this file — commit it, Step 5)

- [ ] **Step 1: Write the config**

```yaml
# Scheduled version updates. Security updates are enabled separately in repository settings and
# ignore `schedule` and `open-pull-requests-limit` here — but they DO honour a `groups` block
# that sets `applies-to: security-updates`, which is why each npm ecosystem has two.
#
# Both package.json files live one level down, so `directory:` must name them explicitly; a
# single "/" entry silently matches nothing and Dependabot reports no error.
#
# Each npm ecosystem declares the SAME patterns twice. `applies-to` defaults to
# `version-updates`, so a single group would silently not cover security updates — and both
# PRs that motivated grouping (#77, #78) were security updates. See issue #56, finding 3.
version: 2
updates:
  - package-ecosystem: npm
    directory: /backend
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      # Peer-linked packages must move together. Ungrouped, a vite major lands while its
      # peers stay pinned and the PR dies at `npm ci`.
      #
      # Only `vitest` is a direct dependency here today, so this group is one package for
      # version updates. It is kept for symmetry and for when vite lands directly.
      vite-toolchain:
        patterns:
          - vite
          - vitest
          - "@vitest/*"
      # The one that actually bites for the backend: `vite` is transitive here, and security
      # updates are the only path that reaches transitive dependencies.
      vite-toolchain-security:
        applies-to: security-updates
        patterns:
          - vite
          - vitest
          - "@vitest/*"
  - package-ecosystem: npm
    directory: /frontend
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      # The frontend groups additionally carry @vitejs/* — @vitejs/plugin-react declares a
      # peer range on vite, and leaving it behind is exactly what broke PR #78.
      vite-toolchain:
        patterns:
          - vite
          - vitest
          - "@vitest/*"
          - "@vitejs/*"
      vite-toolchain-security:
        applies-to: security-updates
        patterns:
          - vite
          - vitest
          - "@vitest/*"
          - "@vitejs/*"
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 2: Parse-check it**

Ruby ships with macOS and has YAML in its standard library; the system `python3` here has no
PyYAML.

```bash
ruby -ryaml -e 'd=YAML.load_file(".github/dependabot.yml"); d["updates"].each{|u| puts "#{u["package-ecosystem"]} #{u["directory"]} groups=#{(u["groups"]||{}).map{|n,g| "#{n}:#{g["applies-to"]||"version-updates"}"}.join(",")}"}'
```

Expected — note both `applies-to` values appear for each npm ecosystem; a missing
`security-updates` line is the silent failure design note 3 describes:

```
npm /backend groups=vite-toolchain:version-updates,vite-toolchain-security:security-updates
npm /frontend groups=vite-toolchain:version-updates,vite-toolchain-security:security-updates
github-actions / groups=
```

- [ ] **Step 3: Confirm the directories actually contain manifests**

The silent-failure mode this guards against.

```bash
ls backend/package.json frontend/package.json
ls .github/workflows/*.yml
```

Expected: both manifests exist, and three workflow files are listed.

- [ ] **Step 4: Confirm which toolchain packages are actually direct dependencies**

Design note 3 claims the backend group is one package for version updates. Verify rather than
assume — if this ever stops being true, the group's shape should change with it.

```bash
for d in backend frontend; do
  echo "== $d"
  python3 -c "
import json;d=json.load(open('$d/package.json'))
for k in ('dependencies','devDependencies'):
    for n,v in sorted((d.get(k) or {}).items()):
        if any(t in n for t in ('vite','esbuild','vitest')): print(f'  {n} {v}')
"
done
```

Expected: backend lists `vitest` only; frontend lists `@vitejs/plugin-react`,
`@vitest/coverage-v8`, `vite`, `vitest`. **Neither lists `esbuild`** — which is why it is absent
from both pattern lists.

- [ ] **Step 5: Commit the config and this plan**

The plan document belongs in the same PR as the work it describes — every plan in `docs/plans/`
is tracked. Nothing enforces it: `docs/plans/` is not in `WATCHED_RE`, so `SDLC docs` stays
green and a PR can ship without its own plan.

```bash
git add .github/dependabot.yml docs/plans/2026-08-10-dependabot-config.md
git commit -m "feat(deps): scheduled Dependabot updates for npm and github-actions"
```

---

## Task 2: Unit suite for the early exits

TDD: the exemption is logic, so the test comes first and must fail for the right reason.

**Files:**
- Create: `scripts/tests/check-sdlc-sync.test.sh`

- [ ] **Step 1: Write the failing test suite**

```bash
#!/usr/bin/env bash
# Unit tests for the *early-exit* branches of scripts/check-sdlc-sync.sh — the
# [skip-sdlc-sync] title hatch and the dependabot[bot] actor exemption. Both return before any
# git state is consulted, so environment variables are the entire input.
#
# The base-resolution logic below those branches is deliberately not covered: it needs merge
# refs and a moving base to exercise, which is a fixture harness this issue does not need.
#
# Positive cases assert stdout *and* exit code: every early exit returns 0 and so does "no
# SDLC-governed files changed", so an exit code alone cannot distinguish a working exemption
# from a silent fall-through.
#
# Negative cases assert the exemption line is ABSENT and ignore the exit code. Asserting on
# what the script prints past the early exits would be reading this worktree's diff against
# its base — which differs between a local checkout and CI's merge ref, and on a branch that
# touches watched files is red by construction.
set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT="./check-sdlc-sync.sh"
EXEMPT_LINE="author is dependabot[bot]"

pass=0
fail=0

run() { PR_TITLE="$1" PR_ACTOR="$2" "$SCRIPT" 2>&1; }

ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; printf '%s\n' "$3" | sed 's/^/      /'; }

# asserts <name> <expected-exit> <expected-stdout-substring> <PR_TITLE> <PR_ACTOR>
#
# `local name=... got out` declares on its own line, and the capture is a separate statement.
# Do NOT tidy this into `local out="$(...)"`: in that form `$?` is `local`'s status, which is
# always 0, and every positive case below would pass vacuously.
asserts() {
  local name="$1" want="$2" needle="$3" title="$4" actor="$5" got out
  out="$(run "$title" "$actor")"
  got=$?
  if [[ "$got" -eq "$want" && "$out" == *"$needle"* ]]; then
    ok "$name"
  else
    bad "$name" "expected exit ${want} and stdout containing '${needle}', got exit ${got}" "$out"
  fi
}

# refutes <name> <PR_TITLE> <PR_ACTOR> — the exemption must NOT have fired. Exit code ignored
# on purpose; see the header.
refutes() {
  local name="$1" title="$2" actor="$3" out
  out="$(run "$title" "$actor")"
  if [[ "$out" != *"$EXEMPT_LINE"* ]]; then
    ok "$name"
  else
    bad "$name" "the dependabot exemption fired and should not have" "$out"
  fi
}

echo "check-sdlc-sync.sh (early exits)"

asserts "the [skip-sdlc-sync] title hatch exits 0" \
  0 "skip-sdlc-sync" "chore: reflow a comment [skip-sdlc-sync]" "igor-ka"

asserts "a dependabot PR is exempt" \
  0 "$EXEMPT_LINE" "chore(deps): bump actions/checkout from 4 to 5" "dependabot[bot]"

asserts "the hatch still works for a bot-shaped title from a human" \
  0 "skip-sdlc-sync" "chore(deps): bump something [skip-sdlc-sync]" "igor-ka"

# The exemption must be exact. A human whose title mentions the bot is not Dependabot, and
# neither is a lookalike account name.
refutes "a human author is not exempt" "chore(deps): mimic dependabot[bot]" "igor-ka"

refutes "a lookalike actor is not exempt" "chore(deps): bump something" "dependabot"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "✗ ${fail} failed, ${pass} passed"
  exit 1
fi
echo "✓ ${pass} passed"
```

- [ ] **Step 2: Make it executable and run it to verify it fails**

```bash
chmod +x scripts/tests/check-sdlc-sync.test.sh
./scripts/tests/check-sdlc-sync.test.sh
```

Expected: the two hatch cases pass (that behaviour exists), both `refutes` cases pass trivially
(nothing prints the exemption line yet), and `a dependabot PR is exempt` **fails** with
`expected exit 0 and stdout containing 'author is dependabot[bot]'` — then `✗ 1 failed, 4 passed`.

This is the correct RED: exactly one case fails, and it is the new behaviour.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/tests/check-sdlc-sync.test.sh
git commit -m "test(ci): cover the check-sdlc-sync early exits"
```

---

## Task 3: The Dependabot exemption

**Files:**
- Modify: `scripts/check-sdlc-sync.sh:12-13, 25-28`

- [ ] **Step 1: Extend the usage comment**

Replace:

```bash
# Usage:  scripts/check-sdlc-sync.sh
#   BASE_SHA   fallback base commit (default: merge-base with origin/main)
#   PR_TITLE   pull request title; containing [skip-sdlc-sync] skips the check
```

with:

```bash
# Usage:  scripts/check-sdlc-sync.sh
#   BASE_SHA   fallback base commit (default: merge-base with origin/main)
#   PR_TITLE   pull request title; containing [skip-sdlc-sync] skips the check
#   PR_ACTOR   pull request author login; dependabot[bot] is exempt (see below)
```

- [ ] **Step 2: Add the exemption next to the existing hatch**

After the `[skip-sdlc-sync]` block, insert:

```bash
# Dependabot's `github-actions` ecosystem bumps `uses:` pins inside .github/workflows/*.yml,
# which is a watched path — so without this every action update would fail a required check
# that a bot can never satisfy. A pin bump is not a process change.
#
# This is an early `exit 0` rather than a job-level `if:` in sdlc-docs.yml on purpose. `SDLC
# docs` is a *required* status check; a skipped job does not report success, and a required
# check that never reports success blocks the merge permanently. The job must run and pass.
#
# The actor is exact-matched. PR_ACTOR comes from github.event.pull_request.user.login, which
# GitHub sets and a contributor cannot forge, and it arrives via `env:` like the title.
if [[ "${PR_ACTOR:-}" == "dependabot[bot]" ]]; then
  echo "==> author is dependabot[bot] — dependency bumps are exempt from the SDLC doc check."
  exit 0
fi
```

- [ ] **Step 3: Run the tests to verify they pass**

```bash
./scripts/tests/check-sdlc-sync.test.sh
```

Expected: 5 ticks, then `✓ 5 passed`, exit 0.

- [ ] **Step 4: Prove the exemption on a realistic input**

```bash
PR_ACTOR="dependabot[bot]" PR_TITLE="chore(deps): bump actions/checkout from 4 to 5" \
  ./scripts/check-sdlc-sync.sh
```

Expected:

```
==> author is dependabot[bot] — dependency bumps are exempt from the SDLC doc check.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-sdlc-sync.sh
git commit -m "feat(ci): exempt dependabot[bot] from the SDLC doc check"
```

---

## Task 4: Wire the workflow

**Files:**
- Modify: `.github/workflows/sdlc-docs.yml`

- [ ] **Step 1: Add the self-test step and pass `PR_ACTOR`**

Replace the `steps:` block's final step with:

```yaml
      - name: Self-test
        run: ./scripts/tests/check-sdlc-sync.test.sh
      - name: Check docs/sdlc.md is in sync
        env:
          # Fallback only — the script prefers the merge ref's first parent, which is exact.
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          # GitHub sets this; a contributor cannot forge it. Via env, never inline in `run:`.
          PR_ACTOR: ${{ github.event.pull_request.user.login }}
        run: ./scripts/check-sdlc-sync.sh
```

- [ ] **Step 2: Confirm the checkout options are unchanged**

No change needed here, but not for the reason it first appears. The self-test does not depend on
fetch depth at all — its cases either return before any git state is read, or assert only that
the exemption line is absent. `fetch-depth: 0` remains necessary for the *check* step, whose base
resolution uses the merge ref's first parent (not `origin/main`, which is what a local run falls
back to). Confirm both options survive the edit:

```bash
grep -A3 'actions/checkout@v4' .github/workflows/sdlc-docs.yml
```

Expected: `fetch-depth: 0` and `persist-credentials: false` both present.

- [ ] **Step 3: Parse-check the workflow**

```bash
ruby -ryaml -e 'YAML.load_file(".github/workflows/sdlc-docs.yml"); puts "yaml ok"'
```

Expected: `yaml ok`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/sdlc-docs.yml
git commit -m "feat(ci): SDLC docs job passes PR_ACTOR and runs its own self-test"
```

---

## Task 5: Update the contract — `docs/sdlc.md`

**Files:**
- Modify: `docs/sdlc.md` — the `Changing this SDLC` section

- [ ] **Step 1: Extend the escape-hatch paragraph**

In `## Changing this SDLC`, after the `**Escape hatch:**` paragraph, insert:

```markdown
**Dependabot is exempt.** The `github-actions` ecosystem bumps `uses:` pins inside
`.github/workflows/*.yml` — a watched path — so without an exemption every action update would
fail a required check that a bot can never satisfy. `scripts/check-sdlc-sync.sh` exits 0 when
`PR_ACTOR` is exactly `dependabot[bot]`. A pin bump is not a process change.

That exemption is an early `exit 0` **inside the script**, not a job-level `if:`. `SDLC docs` is
a required status check, and a skipped job does not report success — a required check that never
reports success blocks the merge permanently, which is worse than the failure being avoided.
The same reasoning keeps `PR shape`'s self-test a step rather than a conditional job.

Both early exits are covered by `scripts/tests/check-sdlc-sync.test.sh`, which the job runs as
its first step and which is also the local pre-push command. The base-resolution logic below
them is not covered — it needs git fixtures, and no change has yet warranted building them.
```

- [ ] **Step 2: Add Dependabot to the CI section's detail list**

In `## How this meets CI/CD`, under "Details that are easy to get wrong", append a bullet:

```markdown
- **Dependabot PRs are exempt from `SDLC docs`, and need no exemption from `PR shape`.** The
  first is because `github-actions` bumps touch watched workflow files; the second is because
  bot PRs close no issue and the rule is *at most* one. If someone proposes an actor exemption
  for `PR shape`, that is a sign the rule drifted — see
  [One child per PR](#one-child-per-pr).
```

- [ ] **Step 3: Update the now-stale self-test bullet**

The existing bullet under "Details that are easy to get wrong" names `PR shape` as the job whose
unit tests have a local equivalent. After this change both jobs do. Replace the final sentence
of that bullet:

```markdown
  Both jobs' *unit tests* do have a local equivalent, and it is the same file CI runs:
  `./scripts/tests/check-pr-shape.test.sh` and `./scripts/tests/check-sdlc-sync.test.sh`.
```

- [ ] **Step 4: Verify all three edits are present**

```bash
grep -n 'Dependabot is exempt' docs/sdlc.md
grep -n 'need no exemption from `PR shape`' docs/sdlc.md
grep -n "check-sdlc-sync.test.sh" docs/sdlc.md
```

Expected: one hit for the first two; two hits for the third (the exemption paragraph and the
self-test bullet).

- [ ] **Step 5: Commit**

```bash
git add docs/sdlc.md
git commit -m "docs(sdlc): record the Dependabot exemption and its shape"
```

---

## Task 6: Open the PR

- [ ] **Step 1: Run both verify scripts**

Nothing here touches application code, but the gate is the gate.

```bash
cd backend  && SKIP_DOCKER=1 ./verify.sh && cd ..
cd frontend && SKIP_DOCKER=1 ./verify.sh && cd ..
```

Expected: green both sides.

- [ ] **Step 2: Write the PR body**

It must exist before Step 3 can check it. End it with `Closes #56`, and put **every quoted
closing reference inside a fenced block** — markdown tables are not fenced, so a table cell
reading like a closing reference is counted and this PR would fail its own `PR shape` gate.

```bash
cat > /tmp/pr-body.md <<'EOF'
Implements the plan in `docs/plans/2026-08-10-dependabot-config.md`.

Closes #56
EOF
```

Then expand it: what lands, why each npm ecosystem has two groups, and the #77/#78 evidence.

- [ ] **Step 3: Dogfood both diff-level checks against this branch**

```bash
BASE_SHA=$(git merge-base HEAD origin/main) PR_TITLE="feat(deps): dependabot" \
  PR_ACTOR="igor-ka" ./scripts/check-sdlc-sync.sh
```

Expected: `✓ SDLC-governed files changed and docs/sdlc.md was updated in the same change:`
listing `.github/workflows/sdlc-docs.yml`, `scripts/check-sdlc-sync.sh` and
`scripts/tests/check-sdlc-sync.test.sh`. Note that `.github/dependabot.yml` is **not** listed —
it is not a watched path (design note 4).

```bash
GITHUB_REPOSITORY=igor-ka/llm-code-execution PR_TITLE="feat(deps): dependabot" \
  PR_BODY="$(cat /tmp/pr-body.md)" ./scripts/check-pr-shape.sh
```

Expected: `✓ this PR closes exactly one issue: igor-ka/llm-code-execution#56`

Also confirm the exemption does **not** fire for a human author, which is the whole point of the
two `refutes` cases:

```bash
BASE_SHA=$(git merge-base HEAD origin/main) PR_TITLE="feat(deps): dependabot" \
  PR_ACTOR="dependabot" ./scripts/check-sdlc-sync.sh; echo "exit=$?"
```

Expected: the normal watched-files success message, **not** the exemption line.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/dependabot-config
gh pr create --title "feat(deps): scheduled Dependabot updates, with a bot exemption for SDLC docs" \
             --body-file /tmp/pr-body.md
```

- [ ] **Step 5: Confirm all four required checks pass**

```bash
gh pr checks --watch
```

Expected: `Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape` all pass. `SDLC docs`
passing here is the human path, not the exemption — Step 7 tests the exemption for real.

- [ ] **Step 6: Run `code-review` and `security-review`, then receive the findings**

Both mandatory. Point the security review at the `PR_ACTOR` trust argument specifically, and
hand it the analysis rather than making it rediscover the boundary:

- **The claim:** `github.event.pull_request.user.login` is GitHub-set and unforgeable, and an
  exact string match closes the lookalike gap. `dependabot[bot]` is unregisterable — `[` and `]`
  are illegal in GitHub usernames — so no outsider can author a PR that satisfies it.
- **The known bypass, and why it is accepted:** anyone with **write access** can push commits to
  a Dependabot PR's branch while `pull_request.user.login` stays `dependabot[bot]`, so a
  process-file change could ride through `SDLC docs` at exit 0. That is a maintainer bypassing
  their own discipline gate, not a privilege escalation — and `docs/sdlc.md` already states both
  jobs are discipline backstops, not security controls. Name it so the reviewer confirms or
  refutes the reasoning rather than reporting it as new.

- [ ] **Step 7: Merge, then verify the exemption on a real bot PR**

```bash
gh pr merge --squash --delete-branch
```

Then wait for Dependabot's first scheduled run — or force one from
**Insights → Dependency graph → Dependabot → Check for updates** — and confirm:

1. **No config error** is reported on that page.
2. A `github-actions` bump PR opens and **`SDLC docs` reports success**, not skipped, not
   failed. This is the acceptance criterion the whole exemption exists for; until a real bot PR
   touching a workflow goes green, this issue is not done.

---

## Rollback

Nothing here touches runtime behaviour, data, or the sandbox.

| If | Undo |
| --- | --- |
| The PR queue is too noisy | Lower `open-pull-requests-limit`, or drop an ecosystem |
| The exemption is too broad | Narrow it to PRs whose watched changes are only `uses:` lines (#56 option 2) |
| Dependabot config is rejected | The page names the offending key; fix forward, the file is inert until valid |
| The whole approach is wrong | `git revert` the squash commit — the config stops applying immediately |

---

## Definition of done

Against `.claude/skills/references/definition-of-done.md` and #56's acceptance criteria:

- [ ] `.github/dependabot.yml` covers backend npm, frontend npm and github-actions
- [ ] `groups:` pins the toolchain in both npm ecosystems, frontend including `@vitejs/*`
- [ ] **Each npm ecosystem has a second group with `applies-to: security-updates`** — without it
      grouping does not cover the update type that produced #77 and #78
- [ ] This plan is committed in the same PR (`docs/plans/` is not enforced by any check)
- [ ] `./scripts/tests/check-sdlc-sync.test.sh` passes locally — 5 cases
- [ ] No Dependabot exemption added to `PR shape`
- [ ] Both `verify.sh` scripts green
- [ ] All four required checks green on the PR
- [ ] `code-review` and `security-review` run, findings evaluated, real ones fixed
- [ ] `docs/sdlc.md` describes the exemption, its shape, and the test command
- [ ] **A real `github-actions` Dependabot PR reports `SDLC docs` as success**
- [ ] Dependabot reports no config error
- [ ] #56 closed
