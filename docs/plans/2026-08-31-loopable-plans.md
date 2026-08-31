# Loopable plans Implementation Plan

**Goal:** Make a plan document the single lookup that answers "what must this run achieve, what
must it not, and what will it need a person for" — so an unattended loop can decide it is done
from files rather than from a conversation that may have been summarised away.

**Architecture:** Three moves, in order, and the first two are in a different repository. First
the **contract**: `writing-plans/SKILL.md` gains a mandatory `## Definition of done` coverage
table and a conditional `Human dependencies` header field, `docs/sdlc.md` §2 gains the matching
process prose, and `planning-reviewer-prompt.md` gains the two rows that catch a plan missing
either. Then the **command**: a carried `/loop-plan <plan path>` whose scope, criteria and
blockers all come from the plan it is pointed at, and whose merge clause is written as
preconditions so it acts only where the gates it names exist. Last the **adoption**: `acb pull`
brings all five files here byte-identically, `.acb.json` declares `.claude/commands/` watched, and
the two local documents record what changed.

**Tech Stack:** Markdown, `bash` 3.2, `jq`, `gh`, `shellcheck` (required by `acb`'s `lint`, and
not currently installed on this machine). `acb` at `9fc5e16`. No new dependency, no code.

**Human dependencies:**

- **`brew install shellcheck`** — a one-time change to this machine. `acb`'s `lint()` hard-fails
  when `shellcheck` is absent rather than skipping, so `./verify.sh` in the toolkit cannot pass
  without it, and no component here has ever installed it.
- **Task 0 waits on your approval of this plan**, as every plan does.

Nothing else. There is no credential or account in this plan: `igor-ka/acb` has no ruleset, and
this repository's `Protect main` sets `required_approving_review_count: 0`, so both sides merge on
green checks alone.

**PR boundaries:** Three, and the first two are in a different repository.

- **PR 0 (in `igor-ka/acb`): the plan-shape contract** — the `## Definition of done` requirement
  and the `Human dependencies` field in the plan template, the process prose that argues for them,
  the two reviewer rows that enforce them, and the attribution entry. Closes the child *the
  plan-shape contract*.
- **PR 1 (in `igor-ka/acb`): the carried loop command** — `carried/.claude/commands/loop-plan.md`,
  its `MANIFEST` line, the portability scan and the carried `check-sdlc-sync` fixture both learning
  that `.claude/commands` exists, and `acb init` scaffolding a repository that watches it. Closes
  the child *the carried loop command*.
- **PR 2 (here): pull, declare, document** — `acb pull` brings all five carried files,
  `.acb.json` declares `^\.claude/commands/` watched, and `docs/sdlc-local.md` and `CLAUDE.md`
  record it. Closes the child *adopt the plan-shape contract and the loop command*.

Child issues are **not filed yet**, deliberately: the staff-engineer review of this plan can move
a PR boundary, and issues filed before that review would have to be renumbered or closed unused.
They are filed on approval, in Task 0. PRs 0 and 1 land in `acb`, so they close their children with
the cross-repository form `Closes igor-ka/llm-code-execution#N` — the same form the toolkit and
adoption plans used.

**Spec:** [`docs/specs/2026-08-31-loopable-plans.md`](../specs/2026-08-31-loopable-plans.md) —
decisions D1–D11 and criteria 1–11 are referenced by name throughout. **Read it first.**

---

## What this plan inherits

`acb` is at `9fc5e16` and `acb status` here reports `behind: 0`, `ahead: 0`, `drift: none`. That
is the property epic #210 established and criterion 2 requires this plan to preserve, which is why
**every carried file is edited in `acb` and never here** (D1). A single local edit to
`writing-plans/SKILL.md`, `planning-reviewer-prompt.md`, `docs/sdlc.md` or `NOTICE.md` would make
this repository permanently *ahead*, and the next `acb pull` would revert it.

Two things in `acb` are easy to miss and both are load-bearing:

- **`tests/carried-purity.test.sh` compares `MANIFEST` against the `carried/` tree in both
  directions.** A new carried file without its `MANIFEST` line fails the suite, and so does a
  `MANIFEST` line with no file. This is why Task 8 exists as its own task rather than a step.
- **`tests/skills-portability.test.sh` scans a fixed list of trees**, currently
  `carried/.claude/skills carried/docs`. A new `carried/.claude/commands/` tree is invisible to it
  until Task 9 adds it, so the file with a fresh blast radius would be the one nothing checks —
  the same failure `acb` already fixed once for `templates/` and shellcheck.

`.acb.json` and `CLAUDE.md` are **generated**, not carried: neither appears in `MANIFEST`, both
belong to this repository, and editing them locally is correct.

---

## File structure

**In `igor-ka/acb`** (PRs 0 and 1):

| File | Change | Why |
| --- | --- | --- |
| `carried/.claude/skills/writing-plans/SKILL.md` | modify | The template an author reads; gains the `Human dependencies` field and a `## Definition of done` section |
| `carried/.claude/skills/writing-plans/planning-reviewer-prompt.md` | modify | Two rows in the review table — the gate that catches a plan missing either (D8) |
| `carried/docs/sdlc.md` | modify | Where the process is argued; §2 gains the prose for both (D9) |
| `carried/.claude/skills/NOTICE.md` | modify | `writing-plans` is vendored; an unrecorded divergence makes the next upstream sync unreviewable |
| `carried/.claude/commands/loop-plan.md` | **create** | The command (D7) |
| `MANIFEST` | modify | One line; `carried-purity` fails without it |
| `tests/skills-portability.test.sh` | modify | Teach the scan the new tree exists |
| `templates/CLAUDE.md.tmpl` | modify | So a repository scaffolded by `acb init` knows the command exists |

**Here** (PR 2):

| File | Change | Why |
| --- | --- | --- |
| `.claude/skills/writing-plans/SKILL.md`, `.../planning-reviewer-prompt.md`, `.claude/skills/NOTICE.md`, `docs/sdlc.md`, `.claude/commands/loop-plan.md` | **written by `acb pull`** | Never hand-edited |
| `.acb.json` | modify | `template.commit` (by `pull`) and `^\.claude/commands/` in `process.watched` |
| `docs/sdlc-local.md` | modify | The watched list is enumerated in prose here; `SDLC docs` requires this file in the same PR |
| `CLAUDE.md` | modify | The "Which skill when" table gains the command |

`README.md` is **not** touched: it documents neither skills nor commands, so nobody following it
is misled. That is the judgment `CLAUDE.md`'s documentation-upkeep rule asks for, made explicitly
rather than by omission.

---

## Task 0: Create the epic and its three children

**Files:** none — GitHub only.

- [ ] **Step 1: Create the epic**

```bash
gh issue create --title "Epic: loopable plans — a plan-shape contract and a generic loop command" --body "$(cat <<'BODY'
A plan does not say which of its spec's criteria it is trying to reach, so an unattended run
reconstructs that boundary from context every time. Eight recorded loop runs did exactly that, and
six ended somewhere no prompt described.

Spec: docs/specs/2026-08-31-loopable-plans.md
Plan: docs/plans/2026-08-31-loopable-plans.md

## Children
- [ ] The plan-shape contract (in igor-ka/acb)
- [ ] The carried loop command (in igor-ka/acb)
- [ ] Adopt the plan-shape contract and the loop command
BODY
)"
```

- [ ] **Step 2: Create the three children**

```bash
gh issue create --label enhancement --title "The plan-shape contract: Definition of done and Human dependencies" --body "Adds the mandatory '## Definition of done' table and the conditional 'Human dependencies' header field to the carried plan template, the matching prose in docs/sdlc.md, the two reviewer rows, and the NOTICE entry. Lands in igor-ka/acb. Plan: docs/plans/2026-08-31-loopable-plans.md (PR 0). Parent: <EPIC>"
gh issue create --label enhancement --title "The carried /loop-plan command" --body "Adds carried/.claude/commands/loop-plan.md, its MANIFEST line, the portability scan's new tree, and the scaffolding template entry. Lands in igor-ka/acb. Plan: docs/plans/2026-08-31-loopable-plans.md (PR 1). Parent: <EPIC>"
gh issue create --label enhancement --title "Adopt the plan-shape contract and the loop command" --body "acb pull, '^\\\\.claude/commands/' in process.watched, and the two local documents. Plan: docs/plans/2026-08-31-loopable-plans.md (PR 2). Parent: <EPIC>"
```

The plan's own `PR boundaries` header still names the children by description rather than by
number. That edit is **Task 17 Step 1a**, not a step here: PR 2's branch does not exist yet, and
`scripts/worktree-new.sh` refuses to create a branch that already exists, so making it early would
break Task 14's setup.

---

# PR 0 — the plan-shape contract

Worktree: none. This PR is in `igor-ka/acb`, a separate checkout at `~/Workspaces/Claude/acb`.
`scripts/worktree-new.sh` allocates a stack slot for *this* repository and has nothing to offer a
toolkit with no application in it.

```bash
brew install shellcheck          # acb's lint() hard-fails without it; it does not skip
cd ~/Workspaces/Claude/acb
git checkout main && git pull
git checkout -b feat/plan-shape-contract
```

## Task 1: The `## Definition of done` requirement

**Files:**
- Modify: `carried/.claude/skills/writing-plans/SKILL.md`

- [ ] **Step 1: Add the section after the `PR boundaries` rationale.** Find the paragraph ending
  `…but it is a backstop; this is the control.` and insert immediately after it, before
  `## Task Structure`:

````markdown
## Definition of done

**Every plan MUST end with a `## Definition of done` section.** It is a coverage map, not a copy
of the criteria:

```markdown
## Definition of done

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S1 | Task 4 Step 5 — the end-to-end run, against the real integration rather than a fixture. |
| S3 | Task 7 Steps 1–5. |
| S7 | Structural: the shape of the change makes the failure unreachable. |

**Not claimed:** S2, S4–S6 closed by an earlier plan. S8 is a launch-day measurement.
```

Two rules make it a map rather than a second copy:

- **Never restate a criterion.** Name it by its identifier and point at the task that discharges
  it. A pasted criterion is a second copy that goes stale, and the stale copy is the one people
  read.
- **The `Not claimed` line is mandatory**, and it must account for every criterion in the spec the
  table omits. "The spec has eight, this plan claims three" is a complete sentence only when the
  other five are named.

**Why this belongs in the plan and not in the reader's head.** A spec's criteria define done for
the *whole* problem; a plan is usually one phase of it. Without this table nothing states which
criteria a given implementation run must reach, so the boundary gets reconstructed from context
every time — by the reviewer, by a reader six months later, and by any unattended process working
the plan. Naming the split once turns "is this done?" into a lookup.

**When there is no separate spec** — the process document says a plan absorbs the spec when
requirements are clear — the left column is the plan's own Goal, decomposed into checkable
statements. The section is never omitted.
````

- [ ] **Step 2: Verify the fence nesting survived.** The block above contains a fenced example
  inside a fenced block. Run:

```bash
awk '/^```/ {n++} END {printf "%d fence lines\n", n}' carried/.claude/skills/writing-plans/SKILL.md
```

Expected: an **even** number. An odd count means a fence was lost and the rest of the document
renders as code.

## Task 2: The `Human dependencies` header field

**Files:**
- Modify: `carried/.claude/skills/writing-plans/SKILL.md`

- [ ] **Step 1: Add the field to the mandatory header**, between `**Tech Stack:**` and
  `**PR boundaries:**`:

```markdown
**Human dependencies:** [Credentials, accounts, approvals and by-hand operations this plan needs
from a person — one line each, naming what is needed and which task blocks on it. **Omit this
field entirely when there are none.** A plan carrying it in every repository, reading "none"
forever, is the ceremony this process exists to cut.]
```

- [ ] **Step 2: Add the rationale** immediately after the existing
  `**Why `PR boundaries` is in the header…**` paragraph:

```markdown
**Why `Human dependencies` is conditional and `PR boundaries` is not.** Every plan produces pull
requests; not every plan needs something a person alone can supply. Where the field applies it is
load-bearing — it is the difference between a plan that stops at a known boundary and one that
discovers the boundary mid-run — and where it does not, a line reading "none" is noise in every
plan in every repository that ever uses this template.
```

- [ ] **Step 3: Commit**

```bash
git add carried/.claude/skills/writing-plans/SKILL.md
git commit -m "feat(writing-plans): mandatory Definition of done, conditional Human dependencies"
```

## Task 3: The two reviewer rows

**Files:**
- Modify: `carried/.claude/skills/writing-plans/planning-reviewer-prompt.md`

- [ ] **Step 1: Add both rows to the `## What to Check` table**, immediately after the existing
  `| PR boundaries | … |` row. Keep the four-space indentation the surrounding table uses — the
  table sits inside a fenced prompt block and losing the indent breaks the fence:

```
    | Definition of done | Does the plan end with a `## Definition of done` table mapping each spec criterion it claims to the task that discharges it, plus a `Not claimed` line accounting for every criterion the table omits? A missing section is a finding. So is a table that restates criteria instead of naming tasks, and so is a `Not claimed` line that does not add up. |
    | Human dependencies | If the plan needs a credential, account, approval or by-hand operation from a person, does the header name it and the task it blocks? The field is correctly absent when there are none — but a plan that plainly needs one and does not say so is a finding. |
```

- [ ] **Step 2: Verify the indentation matches its neighbours**

```bash
grep -n '^    | \(PR boundaries\|Definition of done\|Human dependencies\) |' \
  carried/.claude/skills/writing-plans/planning-reviewer-prompt.md
```

Expected: three lines, consecutive line numbers.

- [ ] **Step 3: Commit**

```bash
git add carried/.claude/skills/writing-plans/planning-reviewer-prompt.md
git commit -m "feat(writing-plans): the reviewer checks both new plan sections"
```

## Task 4: The process prose

**Files:**
- Modify: `carried/docs/sdlc.md`

- [ ] **Step 1: Insert after the `**Every plan header names its PR boundaries**` paragraph**,
  before `**The mandatory gate:**`:

```markdown
**Every plan ends with a `## Definition of done`** — a table mapping each spec criterion the plan
claims to the task that discharges it, and a `Not claimed` line accounting for the rest. It is a
map, never a copy: criteria are named by identifier and never restated, for the same reason an
epic links rather than pastes.

A spec's criteria define done for the whole problem; a plan is usually one phase of it. One phase
of a four-phase spec claimed seven of twelve criteria and disowned five — and without that line
nothing states *which* five, so the boundary is reconstructed from context by every reviewer,
every later reader, and any unattended process working the plan. The staff-engineer review checks
that the section exists and that it accounts for every criterion. There is deliberately no
merge-time backstop: a plan is read long before it is merged, and the review is where a missing
boundary still costs nothing to fix.

**A plan that needs something from a person says so in its header.** `Human dependencies` names
the credentials, accounts, approvals and by-hand operations the plan cannot supply itself, and the
task each one blocks. Unlike `PR boundaries` the field is **omitted when there are none** — a line
reading "none" in every plan in every repository is ceremony. Where it does appear it is what
separates a plan that stops at a known boundary from one that discovers the boundary mid-run.
```

- [ ] **Step 2: Confirm no repository identifier entered a carried file**

```bash
grep -rInEi 'igor-ka|llm-code-execution|llm-sandbox' carried/docs/sdlc.md carried/.claude/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add carried/docs/sdlc.md
git commit -m "docs(sdlc): a plan states which criteria it claims, and what it needs a person for"
```

## Task 5: The attribution entry

**Files:**
- Modify: `carried/.claude/skills/NOTICE.md`

- [ ] **Step 1: Extend the existing `writing-plans` bullet** under `### Local modifications`.
  Append to the end of that bullet, keeping its two-space continuation indent:

```markdown
  It later gained a mandatory `## Definition of done` section — a table mapping each spec criterion
  the plan claims to the task that discharges it, plus a `Not claimed` line for the rest — and a
  conditional `Human dependencies` header field, present only when the plan needs a credential,
  account, approval or by-hand operation a person must supply. `planning-reviewer-prompt.md`
  checks both.
```

- [ ] **Step 2: Commit**

```bash
git add carried/.claude/skills/NOTICE.md
git commit -m "docs(notice): record the writing-plans divergence from upstream"
```

## Task 6: Prove the reviewer catches a missing section

This is spec criterion 3, and it is the one criterion here that cannot be met by reading the diff.

**Files:**
- Create (scratch, never committed): a two-task fixture plan

- [ ] **Step 1: Write the fixture** to a scratch path outside both repositories — a minimal plan
  that is complete except for the new section:

```markdown
# Widget Cache Implementation Plan

**Goal:** Cache widget lookups so a repeated request does not hit the datastore twice.

**Architecture:** A read-through cache in front of the existing repository function, keyed by
widget id, invalidated on write.

**Tech Stack:** The project's existing language and test runner. No new dependency.

**PR boundaries:** One. PR 1: the cache and its tests — closes #1.

**Spec:** the fixture spec below.

Spec criteria: C1 a repeated read hits the datastore once. C2 a write invalidates the entry.
C3 a cache miss is indistinguishable from no cache.

---

## Task 1: Write the failing test

- [ ] **Step 1:** Add a test asserting two identical reads produce one datastore call.
- [ ] **Step 2:** Run it. Expected: FAIL, two calls observed.

## Task 2: Implement the cache

- [ ] **Step 1:** Add the read-through cache to the repository function.
- [ ] **Step 2:** Run the test. Expected: PASS.
- [ ] **Step 3:** Commit.
```

- [ ] **Step 2: Dispatch the reviewer** exactly as `planning-reviewer-prompt.md` specifies —
  a fresh general-purpose subagent, the fixture as `[PLAN_FILE_PATH]`, and the three criteria
  above as `[SPEC_OR_REQUIREMENTS]`. Use the **modified** prompt from Task 3, not the copy
  installed in this repository.

- [ ] **Step 3: Read the verdict.** Expected: a finding naming the missing `## Definition of done`
  section, **in either bucket**. Spec criterion 3 asks that the reviewer reject the plan, not that
  it file the rejection under a particular heading — and the prompt's own tie-break is "when in
  doubt, JUDGMENT", so a reviewer treating "which criteria does this plan claim?" as a scope
  question only the author can answer is behaving correctly, not failing.

  Expected *absence*: no finding about `Human dependencies`. The fixture needs no credential, and
  criterion 4 requires the field to be legitimately omittable.

  **If either expectation fails, stop.** A prompt row that does not fire is worse than no row: it
  reports success. Fix the row's wording and re-run before proceeding — do not adjust the fixture
  to make the row fire.

- [ ] **Step 4: Record the result** in the PR body. Nothing is committed from this task.

## Task 7: Verify and open PR 0

- [ ] **Step 1: Run the full toolkit verification**

```bash
cd ~/Workspaces/Claude/acb && ./verify.sh
```

Expected: `lint` clean, and every suite in `selftest` passing — `carried-purity`,
`skills-portability`, `cli`, `config`, `render`, `sync`, and the four carried suites.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/plan-shape-contract
gh pr create --title "feat(process): a plan states the criteria it claims and what it needs a person for" --body "$(cat <<'BODY'
Adds two requirements to the carried plan template and the prose that argues for them.

- `## Definition of done` — mandatory. A table mapping each spec criterion the plan claims to the
  task that discharges it, plus a `Not claimed` line accounting for the rest. A map, never a copy.
- `Human dependencies` — a header field, present only when the plan needs a credential, account,
  approval or by-hand operation from a person.
- `planning-reviewer-prompt.md` gains a row for each.
- `NOTICE.md` records the divergence from the vendored upstream.

Criterion 3 proven live: the modified reviewer prompt was run against a fixture plan with the
Definition of done removed, and returned the finding as mechanical. It returned nothing about
`Human dependencies`, which the fixture legitimately does not need.

Spec: `docs/specs/2026-08-31-loopable-plans.md` in igor-ka/llm-code-execution, criteria 1, 3, 4, 9, 11.

Closes igor-ka/llm-code-execution#<CHILD-1>
BODY
)"
```

- [ ] **Step 3: Run `code-review` and `security-review`** against the pending diff, evaluate each
  finding with the `receiving-code-review` skill, fix what is real, and push.

- [ ] **Step 4: Merge when green.**

---

# PR 1 — the carried loop command

```bash
cd ~/Workspaces/Claude/acb
git checkout main && git pull
git checkout -b feat/loop-plan-command
mkdir -p carried/.claude/commands
```

## Task 8: Write the command

**Files:**
- Create: `carried/.claude/commands/loop-plan.md`

- [ ] **Step 1: Write the file.** Every sentence here is carried byte-identically into every
  consumer, so nothing in it may name a repository, an owner, a component, or a check.

````markdown
# /loop-plan — work a plan to its Definition of done

**Argument:** the path to a plan document — `/loop-plan docs/plans/2026-01-05-widget.md`.
With no path, or a path that does not exist, say so and stop.

Built to run under a loop — `/loop /loop-plan <path>` — so it re-enters on each tick. It works
standalone; the exits below are the same either way.

## First tick

**Read the plan.** Four parts of it govern this run:

- **`## Definition of done`** — the spec criteria this plan claims, and the task discharging each.
  **These, and only these, are the target.** Every criterion on the `Not claimed` line is out of
  scope; working one is scope creep, not diligence. If the plan has no such section, say so and
  ask for the scope rather than inferring it — that inference is the failure this section exists
  to prevent.
- **`Human dependencies`** in the header — what the plan needs from a person, and the task each
  one blocks. Absent means the plan claims to need nothing, which is a claim you may find false.
- **`PR boundaries`** — the pull requests to produce, one child issue each.
- The tasks, in their order.

**Find your position from the tracker, not from the plan.** Read the epic's children checklist and
the open pull requests. A plan's checkboxes are not progress.

**Then state, in one short paragraph:** the criteria in scope, the criteria disowned, the human
dependencies if any, and which pull request you are starting.

## Every tick

Work the next task in the plan's order. Close each child from its pull request body so the link is
automatic, and tick the epic's checklist as children close.

**Never edit the plan.** It is the intent a human approved at the review gate; a plan edited during
implementation is no longer that plan. If it is wrong, stop and say why.

## Merging

**Do not merge unless the person who started this run has said, in this run, that you may.**
Nothing in this file says it, and nothing in it can: a file carried byte-identically into every
repository cannot know whose repository it landed in. Absent that word, take the pull request to
*open, green and reviewed* and stop there, saying so plainly.

Where they have said it, merge only when all of these have been **observed to hold in this run**:

- the repository declares at least one required status check on that branch, **and** every one of
  them has reported success — an empty set of required checks fails this condition rather than
  satisfying it vacuously;
- a code review of the pending diff has been run and its findings resolved;
- a security review of the pending diff has been run and its findings resolved;
- any automated reviewer comments on the pull request have been addressed.

The operator's word is a precondition like the other four, not an override. It makes merging
*possible*, never mandatory, and it excuses none of them.

## Waiting

When the next step waits on something finishing — a status check, a build, a review agent — arm a
monitor for that event instead of sleeping on a timer. A timer that outlasts the event wastes the
whole difference: twenty-five-minute heartbeats spent waiting on checks that finish in three.

## Stopping

Stop on the first of these, and say which:

1. **Done** — every criterion the plan claims passes. Before stopping, report each one on its own
   line with the command that proves it and that command's output. A criterion asserted without
   evidence is not met.
2. **Blocked** — progress needs a credential, account, approval or by-hand operation from a
   person. Stop immediately, name what is needed and which criterion it blocks, and do not work
   around it. Creating the account, or widening your own access, to satisfy a criterion is never
   the answer: needing a person *is* the finding.
3. **Ceiling** — six ticks. Report which criteria pass, which do not, and where the next tick
   would have started.

An epic closing is a consequence of the criteria passing, never the definition of it. "Loop until
the epic can be closed" makes the success condition an act you can perform, which certifies
nothing.
````

- [ ] **Step 2: Read the Merging section back against spec criterion 7.** Two things must hold,
  and the staff review found the first draft failed both:

  **Nothing grants merge authority.** The operator's word *in this run* is the first precondition;
  a repository whose operator has not spoken cannot satisfy it, which is what makes the clause
  inert in a stranger's fresh adoption.

  **No remaining bullet is vacuously true.** "At least one required check exists, and all of them
  passed" fails on an empty set, where "every required check passed" would have *passed* — a
  universal over an empty set is true, and a repository with no ruleset is exactly that set.

  If any line can be read otherwise, rewrite before committing. This is the load-bearing part
  of D7.

- [ ] **Step 3: Commit**

```bash
git add carried/.claude/commands/loop-plan.md
git commit -m "feat(commands): /loop-plan works a plan to its Definition of done"
```

## Task 9: The MANIFEST line

**Files:**
- Modify: `MANIFEST`

- [ ] **Step 1: Prove the suite fails first.** A carried file with no `MANIFEST` line is never
  copied to a consumer and looks as though it were:

```bash
./tests/carried-purity.test.sh
```

Expected: **FAIL**, with a diff showing `.claude/commands/loop-plan.md` present in the tree and
absent from `MANIFEST`.

- [ ] **Step 2: Add the line.** `MANIFEST` is kept in `LC_ALL=C` order and `.claude/commands`
  sorts before `.claude/skills`, so it becomes the first line:

```bash
printf '%s\n' '.claude/commands/loop-plan.md' | cat - MANIFEST > MANIFEST.new && mv MANIFEST.new MANIFEST
head -2 MANIFEST
```

Expected:

```
.claude/commands/loop-plan.md
.claude/skills/NOTICE.md
```

- [ ] **Step 3: Run it again**

```bash
./tests/carried-purity.test.sh
```

Expected: **PASS**, 3 passed 0 failed.

- [ ] **Step 4: Commit**

```bash
git add MANIFEST
git commit -m "feat(manifest): carry the loop-plan command"
```

## Task 10: Teach the portability scan the new tree

**Files:**
- Modify: `tests/skills-portability.test.sh`

- [ ] **Step 1: Prove the tree is currently unscanned.** Add a violating line to the new command
  and confirm the suite passes anyway — the failure mode this task exists to close:

```bash
printf '\nRun `npm test` before merging.\n' >> carried/.claude/commands/loop-plan.md
./tests/skills-portability.test.sh
```

Expected: **PASS** — which is wrong, and is the point.

- [ ] **Step 2: Add the tree**. Change the `TREES` assignment:

```bash
TREES="carried/.claude/commands carried/.claude/skills carried/docs"
```

- [ ] **Step 3: Run it again with the violation still in place**

```bash
./tests/skills-portability.test.sh
```

Expected: **FAIL**, naming `carried/.claude/commands/loop-plan.md` and the `npm test` line.

- [ ] **Step 4: Remove the violation and confirm green**

```bash
git checkout carried/.claude/commands/loop-plan.md
./tests/skills-portability.test.sh
```

Expected: **PASS**.

- [ ] **Step 5: Commit**

```bash
git add tests/skills-portability.test.sh
git commit -m "test: the portability scan covers carried commands"
```

## Task 11: Prove the watched pattern upstream, in the carried fixture

Spec criterion 8 names `scripts/tests/check-sdlc-sync.test.sh` as the mechanism. That suite is
**carried**, and it drives its own fixture `.acb.json` rather than the consumer's — so covering the
new pattern is an upstream edit, and the assertion then runs in every consumer rather than only
here. It is the form the other six watched paths already have.

**Files:**
- Modify: `carried/scripts/tests/check-sdlc-sync.test.sh`

- [ ] **Step 1: Add the assertion first, and watch it fail.** After the existing
  `watched   "scripts/ is watched"` line:

```bash
watched   "commands are watched"                ".claude/commands/loop-plan.md"
```

Then run it:

```bash
./carried/scripts/tests/check-sdlc-sync.test.sh
```

Expected: **FAIL** — the fixture's `watched` list has no `^\\.claude/commands/`, so the path is
ungoverned and the new assertion says so.

- [ ] **Step 2: Add the pattern to the fixture's `watched` list.** Change its first line from

```json
      "^\\.claude/skills/", "^\\.github/workflows/", "^scripts/",
```

to

```json
      "^\\.claude/skills/", "^\\.claude/commands/", "^\\.github/workflows/", "^scripts/",
```

- [ ] **Step 3: Run it again**

```bash
./carried/scripts/tests/check-sdlc-sync.test.sh
```

Expected: **PASS**. This is what proves the alternation `jq` builds from `process.watched` handles
the pattern — not that the pattern was typed correctly, which reading the diff would show, but that
the gate acts on it.

- [ ] **Step 4: Commit**

```bash
git add carried/scripts/tests/check-sdlc-sync.test.sh
git commit -m "test(sdlc-sync): the carried fixture covers .claude/commands"
```

## Task 12: A scaffolded repository knows the command exists, and watches it

`acb init` writes a `watched` list of three patterns, none of them `^\\.claude/commands/`. Without
this task a repository scaffolded after PR 1 receives `loop-plan.md` — an agent instruction with
merge language in it — under an `SDLC docs` gate that does not cover it. That is the same failure
this plan's *What this plan inherits* section names for the portability scan: the file with the
freshest blast radius being the one nothing checks. Task 15 closes it for this repository only;
this task closes it for every future one.

**Files:**
- Modify: `lib/render.sh:87`
- Modify: `templates/CLAUDE.md.tmpl`
- Modify: `carried/docs/sdlc.md`

- [ ] **Step 1: Add the pattern to the scaffolded config.** In `acb_scaffold_config()`, change

```json
    "watched": ["^\\.claude/skills/", "^\\.github/workflows/", "^scripts/"],
```

to

```json
    "watched": ["^\\.claude/skills/", "^\\.claude/commands/", "^\\.github/workflows/", "^scripts/"],
```

- [ ] **Step 2: Verify the scaffolded JSON still parses.** The heredoc is written by hand and a
  stray comma is invisible until someone runs `acb init`:

```bash
./tests/render.test.sh
```

Expected: PASS.

- [ ] **Step 3: Add the path to the template's contract sentence.** In `templates/CLAUDE.md.tmpl`,
  change

```markdown
**The process document is a contract:** if you change `.claude/skills/**`, any component's
`verify.sh`, `.github/workflows/**`, or anything in `scripts/`, update it in the same change.
```

to

```markdown
**The process document is a contract:** if you change `.claude/skills/**`, `.claude/commands/**`,
any component's `verify.sh`, `.github/workflows/**`, or anything in `scripts/`, update it in the
same change.
```

- [ ] **Step 4: Name the command after the skills table**, immediately below
  `The standing bar every change clears is \`.claude/skills/references/definition-of-done.md\`.`:

```markdown
One command ships alongside them: **`/loop-plan <plan path>`** works a plan to the criteria its
`## Definition of done` claims, stops when they pass with evidence or when a `Human dependencies`
entry blocks, and never edits the plan. It is carried, like the skills.
```

- [ ] **Step 5: Add the bullet to the carried process document.** In `carried/docs/sdlc.md`, under
  `## Changing this SDLC`, after the `- \`.claude/skills/**\`` bullet:

```markdown
- `.claude/commands/**`
```

- [ ] **Step 6: Confirm no repository identifier entered the carried file**

```bash
grep -rInEi 'igor-ka|llm-code-execution|llm-sandbox' carried/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add lib/render.sh templates/CLAUDE.md.tmpl carried/docs/sdlc.md
git commit -m "feat(init): a scaffolded repository watches .claude/commands and names the command"
```

## Task 13: Verify and open PR 1

- [ ] **Step 1: Full verification**

```bash
cd ~/Workspaces/Claude/acb && ./verify.sh
```

Expected: `lint` clean; `selftest` all suites passing, including `carried-purity` at 3/3 and
`skills-portability` green over three trees.

No suite covers directory creation on pull — `render.test.sh` never invokes `pull`, and
`sync.test.sh`'s consumer fixture pre-creates its carried directory (`mkdir -p "$c/skills"`), so
the case never arises there. The observation is **Task 14 Step 3**, where
`?? .claude/commands/loop-plan.md` in `git status --porcelain` shows the real pull created the tree.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/loop-plan-command
gh pr create --title "feat(commands): carry /loop-plan" --body "$(cat <<'BODY'
A carried slash command that works a plan to the criteria its `## Definition of done` claims.

Scope, criteria, blockers and PR boundaries all come from the plan it is pointed at, so the
command takes one argument and nothing else. Its merge clause is written as **preconditions** —
required checks green, both review passes run and resolved, reviewer comments addressed — so in a
repository without those gates the condition is unsatisfiable and nothing merges. No sentence in
it grants merge authority on its own.

Also: `MANIFEST` (carried-purity fails without it, proven), and `skills-portability` learns that
`carried/.claude/commands` exists — proven by planting a violation, watching the suite pass, adding
the tree, and watching it fail.

Spec: `docs/specs/2026-08-31-loopable-plans.md` in igor-ka/llm-code-execution, criteria 5, 6, 7.

Closes igor-ka/llm-code-execution#<CHILD-2>
BODY
)"
```

- [ ] **Step 3: Run `code-review` and `security-review`**, evaluate with `receiving-code-review`,
  fix what is real, push.

- [ ] **Step 4: Merge when green.**

---

# PR 2 — pull, declare, document

Worktree: `scripts/worktree-new.sh adopt-loop-plan` from the main checkout.

## Task 14: Pull the carried set

**Files:**
- Modified by `acb pull`: five carried files and `.acb.json`

- [ ] **Step 0: Return the toolkit checkout to `main`.** Task 13 left it on
  `feat/loop-plan-command`, and both `status` and `pull` read `git -C "$ACB_ROOT" rev-parse HEAD`
  and copy from `$ACB_ROOT/carried/…` — whatever branch is checked out. Pulling from the feature
  branch would record a pre-squash sha in `.acb.json` that vanishes from `origin` when the branch
  is deleted, after which `acb status` reports `behind: ?` and criterion 2 cannot be asserted:

```bash
cd ~/Workspaces/Claude/acb && git checkout main && git pull
cd -
```

- [ ] **Step 1: Confirm the starting state**

```bash
~/Workspaces/Claude/acb/bin/acb status
```

Expected: `behind: 2 commit(s) — run 'acb pull'` (the two squash-merged PRs), and `ahead: 0`.
The count is commits in `recorded..HEAD`, not files.

- [ ] **Step 2: Pull**

```bash
~/Workspaces/Claude/acb/bin/acb pull
```

Expected: `✓ pulled 26 carried file(s) at <sha>. Nothing committed — review with 'git diff'.`

- [ ] **Step 3: Read the diff, and confirm its shape**

```bash
git status --porcelain
```

Expected exactly six paths — the four modified carried files, the new
`.claude/commands/loop-plan.md`, and `.acb.json`:

```
 M .acb.json
 M .claude/skills/NOTICE.md
 M .claude/skills/writing-plans/SKILL.md
 M .claude/skills/writing-plans/planning-reviewer-prompt.md
 M docs/sdlc.md
?? .claude/commands/loop-plan.md
```

Anything else means a file changed that this plan did not intend to change. Stop and find out why.

- [ ] **Step 4: Confirm the property criterion 2 requires**

```bash
~/Workspaces/Claude/acb/bin/acb status
```

Expected: `behind: 0`, `ahead: 0`, `drift: none`.

## Task 15: Declare `.claude/commands/` watched

**Files:**
- Modify: `.acb.json`

- [ ] **Step 1: Add the pattern** to `process.watched`, after `"^\\.claude/skills/"`:

```json
      "^\\.claude/commands/",
```

- [ ] **Step 2: Confirm the file is still valid JSON and the list reads back**

```bash
jq -r '.process.watched[]' .acb.json
```

Expected: **eleven** entries, with `^\.claude/commands/` second. The list gained
`^\.mutation-scope\.json$` when the mutation gate landed, so it is ten before this change.

## Task 16: Record it in the local process document

**Files:**
- Modify: `docs/sdlc-local.md`

- [ ] **Step 1: Add the path to the bulleted rule list** under `## Changing this SDLC`,
  immediately after the `.claude/skills/**` bullet:

```markdown
- `.claude/commands/**` — carried, like the skills. `/loop-plan` is the only entry today; it works
  a plan to the criteria its `## Definition of done` claims and stops when they pass with evidence,
  when a `Human dependencies` entry blocks, or at six ticks.
```

- [ ] **Step 2: Update the contract sentence near the top of the file**, which enumerates the
  watched paths in prose. Change:

```markdown
**It is the contract the `SDLC docs` gate enforces.** A pull request that changes
`.claude/skills/**`, any component's `verify.sh`, `infra/tests/**`, `.github/workflows/**` or
anything in `scripts/` must update this file in the same pull request.
```

to:

```markdown
**It is the contract the `SDLC docs` gate enforces.** A pull request that changes
`.claude/skills/**`, `.claude/commands/**`, any component's `verify.sh`, `infra/tests/**`,
`.github/workflows/**` or anything in `scripts/` must update this file in the same pull request.
```

- [ ] **Step 3: Confirm the prose and the declaration agree** — the enumerated list and
  `process.watched` are maintained by hand and nothing checks them against each other:

```bash
diff <(jq -r '.process.watched[]' .acb.json | sed 's|^\^||; s|\\||g; s|/$|/**|; s|\$$||') \
     <(grep -oE '^\- `[^`]+`' docs/sdlc-local.md | sed 's/^- `//; s/`$//') || true
```

Read the output rather than asserting on it: the two lists are written in different notations and
this is a reading aid, not a gate. Every pattern in `.acb.json` must be findable in the prose.

## Task 17: Name the command in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a paragraph after the "Which skill when" table**, immediately below
  `The standing bar every change clears before it counts as done is
  \`.claude/skills/references/definition-of-done.md\`.`:

```markdown
One command ships alongside the skills, carried the same way: **`/loop-plan <plan path>`** works a
plan to the criteria its `## Definition of done` claims. It reads scope from the plan and progress
from the tracker, never edits the plan, and stops when the criteria pass with evidence, when a
`Human dependencies` entry blocks, or at six ticks. Under `/loop` it re-enters on each tick.
```

- [ ] **Step 1a: Write the four assigned issue numbers into this plan's `PR boundaries` header**,
  replacing each child description with `closes #N`. This lands here, not in Task 0: PR 2's branch
  is the first branch in this repository the plan produces, and `scripts/worktree-new.sh` refuses a
  branch that already exists.

- [ ] **Step 2: Commit everything in this PR**

```bash
git add .acb.json .claude/commands/loop-plan.md .claude/skills docs/sdlc.md docs/sdlc-local.md \
       CLAUDE.md docs/plans/2026-08-31-loopable-plans.md
git commit -m "feat: adopt the plan-shape contract and the carried loop command"
```

## Task 18: Verify and open PR 2

- [ ] **Step 1: Run every component's checks.** This PR touches no component code, but the
  required checks run regardless and CI does not skip:

```bash
cd backend && ./verify.sh && cd ../frontend && ./verify.sh && cd ../infra && ./verify.sh
```

Expected: all three green.

- [ ] **Step 2: Prove the `SDLC docs` gate sees the new watched path.** Temporarily drop the
  `docs/sdlc-local.md` change and confirm the check fails, then restore it:

The script reads **committed** state — `changed="$(git diff --name-only "$base" HEAD)"` — so a
stash proves nothing: after Step 2 the tree is clean, the stash saves nothing, and the check still
sees the committed document and exits 0. Drop the change in a temporary commit instead:

```bash
BASE="$(git merge-base HEAD origin/main)"
git checkout "$BASE" -- docs/sdlc-local.md
git commit -q -m "temp: drop the process-document change"
./scripts/check-sdlc-sync.sh; echo "exit=$?"
```

Expected: **non-zero**, naming `.claude/commands/loop-plan.md` as a watched change with no process
document update.

```bash
git reset --hard HEAD~1
./scripts/check-sdlc-sync.sh; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Confirm the carried property one last time**

```bash
~/Workspaces/Claude/acb/bin/acb status
```

Expected: `behind: 0`, `ahead: 0`, `drift: none`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/adopt-loop-plan
gh pr create --title "feat: adopt the plan-shape contract and the carried loop command" --body "$(cat <<'BODY'
`acb pull` brings five carried files at the toolkit's HEAD: the plan template's new
`## Definition of done` requirement and `Human dependencies` field, the two reviewer rows, the
process prose, the attribution entry, and `/loop-plan`.

Locally: `^\\.claude/commands/` joins `process.watched`, and `docs/sdlc-local.md` and `CLAUDE.md`
record what that means. `acb status` reports behind 0 / ahead 0 / drift none — nothing was edited
here that the toolkit owns.

The `SDLC docs` gate was proven to see the new watched path by dropping the process-document change
and watching the check fail.

Spec: `docs/specs/2026-08-31-loopable-plans.md`, criteria 2, 8, 10.

Closes #<CHILD-3>
BODY
)"
```

- [ ] **Step 5: Run `code-review` and `security-review`**, evaluate with `receiving-code-review`,
  fix what is real, push.

- [ ] **Step 6: Merge when green, then close the epic** — every criterion is claimed by this plan,
  so nothing is left open.

- [ ] **Step 7: Free the worktree**

```bash
cd .claude/worktrees/adopt-loop-plan && docker compose down
cd - && git worktree remove .claude/worktrees/adopt-loop-plan && git branch -D feat/adopt-loop-plan
```

---

## Definition of done

| Spec criterion | How this plan satisfies it |
| --- | --- |
| 1 ★ | Task 1 — the `## Definition of done` section in the carried plan template; Task 14 pulls it here |
| 2 ★ | Task 14 Step 4 and Task 18 Step 3 — `acb status` reports `behind: 0`, `ahead: 0`, `drift: none`; every carried edit was made in `acb` (D1) |
| 3 | Task 6 — the modified reviewer prompt run against a fixture plan with the section deleted, and the finding observed rather than assumed |
| 4 | Task 2 Step 1 — the field's own text requires omission when empty; Task 6 Step 3 confirms the reviewer stays silent on a fixture that needs nobody |
| 5 | Task 8 — `/loop-plan <plan path>` takes one argument; scope, criteria, blockers and PR boundaries all come from the plan |
| 6 | Task 9 — the `MANIFEST` line, proven necessary by running `carried-purity` before adding it; Task 13 Step 1 re-runs the suite |
| 7 ★ | Task 8 Step 2 — the Merging section read back bullet by bullet against the preconditions requirement, and D7's phrasing test |
| 8 | Task 11 — the carried `check-sdlc-sync` fixture gains the pattern and an assertion, proven by adding the assertion first and watching it fail; Task 12 Step 1 makes every scaffolded repository watch it; Task 15 declares it here, and Task 18 Step 2 shows the gate failing without the process-document change |
| 9 | Tasks 1 and 4 — the same requirement stated in `writing-plans/SKILL.md` and `docs/sdlc.md` §2, both upstream, both in PR 0 |
| 10 | Task 16 (`docs/sdlc-local.md`, in the same PR as the watched-path change) and Task 17 (`CLAUDE.md`). `README.md` deliberately untouched: it documents neither skills nor commands, so no reader following it is misled |
| 11 | Task 5 — the `NOTICE.md` bullet recording the divergence from the pinned upstream |

**Not claimed:** none. This plan claims all eleven criteria in the spec.

---

## Verification summary

| What | Command | Expected |
| --- | --- | --- |
| Fence nesting survived | `awk '/^```/ {n++} END {print n}' carried/.claude/skills/writing-plans/SKILL.md` | an even number |
| Reviewer rows aligned | `grep -n '^    \| \(PR boundaries\|Definition of done\|Human dependencies\) \|' …` | three consecutive lines |
| No identifier in a carried file | `grep -rInEi 'igor-ka\|llm-code-execution\|llm-sandbox' carried/` | no output |
| Reviewer catches a missing section | Task 6, the fixture plan | a mechanical finding naming `## Definition of done` |
| MANIFEST necessary, then sufficient | `./tests/carried-purity.test.sh` before and after Task 9 | FAIL, then `3 passed, 0 failed` |
| Portability scan covers commands | Task 10, plant a violation | PASS before, FAIL after, PASS once removed |
| Watched pattern proven upstream | `./carried/scripts/tests/check-sdlc-sync.test.sh` before and after Task 11 Step 2 | FAIL, then PASS |
| Scaffolded config still parses | `./tests/render.test.sh` after Task 12 Step 1 | PASS |
| Toolkit green | `cd ~/Workspaces/Claude/acb && ./verify.sh` | lint clean, every suite passing |
| Pull shape | `git status --porcelain` after `acb pull` | exactly six paths |
| Carried property preserved | `acb status` | `behind: 0`, `ahead: 0`, `drift: none` |
| `SDLC docs` sees the new path | `./scripts/check-sdlc-sync.sh` with `docs/sdlc-local.md` stashed | non-zero, then zero once restored |
| Components green | `./verify.sh` in `backend`, `frontend`, `infra` | all three pass |

---

## Plan review log

Staff-engineer review 2026-08-31 — **Issues Found**. Applied without asking (mechanical; each
verified against the real files before transcribing):

- **Header, `Human dependencies`**: the merge clause is written in Task 8, not Task 7 (Task 7 Step 2
  is "push and open the PR"). Retargeted to *Task 8 Steps 1–2*, matching the Definition of done
  row for criterion 7, which already said Task 8.
- **Tech Stack, PR 0 setup, `Human dependencies`**: `shellcheck` is **not installed on this
  machine** (`which shellcheck` → not found), and `acb`'s `lint()` hard-fails rather than skipping,
  so `./verify.sh` in the toolkit aborts under `set -e` before any suite runs. Added
  `brew install shellcheck` as the first setup step, added it to Tech Stack, and — since it is a
  one-time machine change — added it to `Human dependencies`, which had asserted there was no
  by-hand operation.
- **Task 13 Step 2**: `render.test.sh` never invokes `pull` (0 occurrences), so it proved nothing
  about directory creation, and `./verify.sh` already runs it inside `selftest`. Step deleted; the
  observation moved to Task 14 Step 3's `?? .claude/commands/loop-plan.md`. Remaining steps
  renumbered.
- **Task 14, new Step 0**: Task 13 leaves the toolkit checkout on `feat/loop-plan-command`, and
  both `status` and `pull` read `$ACB_ROOT`'s current HEAD and `carried/` tree. Pulling from the
  feature branch would record a pre-squash sha that vanishes when the branch is deleted, after
  which `acb status` reports `behind: ?`. Added a checkout of `main` first.
- **Task 0 Step 3 → Task 17 Step 1a**: the plan-header edit could not be committed "on PR 2's
  branch" from Task 0 — that branch does not exist yet, and `scripts/worktree-new.sh:239` refuses a
  branch that already exists, so creating it early would break Task 14. Moved into PR 2, and
  `docs/plans/2026-08-31-loopable-plans.md` added to Task 17 Step 2's `git add`, which had omitted
  it.
- **Task 18 Step 2**: the demonstration was inert. `check-sdlc-sync.sh` reads committed state
  (`git diff --name-only "$base" HEAD`), so against a clean tree the stash saves nothing, the check
  exits 0, and `git stash pop` then fails with "No stash entries found" — reproduced by the
  reviewer in this checkout. Replaced with a temporary commit that drops `docs/sdlc-local.md`,
  followed by `git reset --hard HEAD~1`.

**Escalated to the user; all four answered 2026-08-31 and applied as decided:**

- **The carried merge clause was vacuously satisfiable.** "Every required status check has reported
  success" is a universal over a set, and in a repository with no ruleset that set is empty and the
  bullet is true for free; the two review bullets are self-satisfiable by the loop. So in exactly
  the repository criterion 7 is about — a stranger's fresh adoption — all four conditions were met
  by the loop's own actions. The reviewer noted the flaw is in D7's premise, not only the drafting.
  **Resolved: option (b).** The operator's word *in this run* becomes the first precondition, so the
  carried file grants nothing and the grant travels in the launch prompt instead — which is what the
  operator's own loop transcripts already say out loud. The first bullet also gained option (a)'s
  non-vacuous form ("declares at least one required check, **and** every one passed"), which was
  part of the same recommendation and is a strict tightening; revert that one line to drop it. Spec
  criterion 7, D7 and the residual-risk section were updated to match.
- **Criterion 8 is proven upstream.** New **Task 11** adds the pattern and an assertion to the
  carried `check-sdlc-sync.test.sh` fixture, assertion first so it is watched failing. Tasks 11–17
  renumbered by one; PR 1's boundary description widened.
- **`acb init` now scaffolds a repository that watches `.claude/commands/`.** Task 12 grew from one
  file to three — `lib/render.sh`'s scaffolded `watched` list, the template's contract sentence, and
  the carried process document's rule list — because a scaffolded repository was otherwise receiving
  an agent instruction with merge language under a gate that did not cover it.
- **Task 6 accepts the finding in either review bucket.** Requiring *mechanical* could not be
  honestly forced: the reviewer prompt's own tie-break is "when in doubt, JUDGMENT", and which
  criteria a plan claims is a scope question only the author can settle. Spec criterion 3 names no
  bucket.
