---
name: writing-plans
description: Use when you have requirements for a multi-step task, before touching code. Writes a comprehensive implementation plan, then runs a staff-engineer review of that plan; mechanical findings are applied and reported, judgment findings are surfaced to the user and block until they decide.
---

<!--
Adapted from claude-code-staff-engineer by Fareed Khan (MIT). See ../NOTICE.md.
Cross-skill references to the upstream subagent-driven-development / executing-plans
/ brainstorming skills were removed; those were intentionally not installed here.
-->

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for
our codebase and questionable taste. Document everything they need to know: which
files to touch for each task, the code, testing, docs they might need to check, and
how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD.
Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or
problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
(User preferences for plan location override this default.)

## Scope Check

If the requirements cover multiple independent subsystems, suggest breaking this into
separate plans — one per subsystem. Each plan should produce working, testable
software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each
one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should
  have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more
  reliable when files are focused. Prefer smaller, focused files over large ones.
- Files that change together should live together. Split by responsibility, not by
  technical layer.
- In existing codebases, follow established patterns. If a file you're modifying has
  grown unwieldy, including a split in the plan is reasonable; don't unilaterally
  restructure unrelated code.

This structure informs the task decomposition. Each task should produce self-contained
changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Human dependencies:** [Credentials, accounts, approvals and by-hand operations this plan needs
from a person — one line each, naming what is needed and which task blocks on it. **Omit this
field entirely when there are none.** A plan carrying it in every repository, reading "none"
forever, is the ceremony this process exists to cut.]

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

**Why `Human dependencies` is conditional and `PR boundaries` is not.** Every plan produces pull
requests; not every plan needs something a person alone can supply. Where the field applies it is
load-bearing — it is the difference between a plan that stops at a known boundary and one that
discovers the boundary mid-run — and where it does not, a line reading "none" is noise in every
plan in every repository that ever uses this template.

## Criteria coverage

**Every plan MUST carry a `## Criteria coverage` section, placed after the last task.** Only
`## Plan review log` may follow it. It is a coverage map, not a copy of the criteria:

```markdown
## Criteria coverage

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S1 | Task 4 Step 5 — the end-to-end run, against the real integration rather than a fixture. |
| S3 | Task 7 Steps 1-5. |
| S7 | Structural: the launcher flag is set in the same resource, so a default apply cannot strip it. |

**Not claimed:** S2, S4-S6 closed by an earlier plan. S8 is a launch-day measurement.
```

Two rules make it a map rather than a second copy:

- **Never restate a criterion.** Name it by its identifier and point at the task that discharges
  it. A pasted criterion is a second copy that goes stale, and the stale copy is the one people
  read. Where a spec's criteria are not numbered, number them **in the spec** first: an identifier
  that exists only in the plan cannot be checked against anything, which is the one thing this
  table is for.
- **The `Not claimed` line is mandatory**, and it must account for every criterion in the spec the
  table omits. "The spec has eight, this plan claims three" is a complete sentence only when the
  other five are named. When it omits nothing, write `**Not claimed:** none — this plan claims all
  of them.` Unlike `Human dependencies` this line is never dropped: its absence and "nothing left
  over" are not distinguishable to a reader.

**Why this belongs in the plan and not in the reader's head.** A spec's criteria define done for
the *whole* problem; a plan is usually one phase of it. Without this table nothing states which
criteria a given implementation run must reach, so the boundary gets reconstructed from context
every time — by the reviewer, by a reader six months later, and by any unattended process working
the plan. Naming the split once turns "is this done?" into a lookup.

**When there is no separate spec** — the process document says a plan absorbs the spec when
requirements are clear — the left column is the plan's own Goal, decomposed into checkable
statements. The section is never omitted.

**This is not the Definition of Done.** `../references/definition-of-done.md` is the standing bar
every increment clears, the same every time, answering *"is this finished to our standard?"*. This
section is the opposite column of that file's own table: acceptance criteria, specific to this
plan, answering *"did we build the right thing?"*. A task is done when both hold, so do not read
one as the other.

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test** — *oracle: <where the expected value comes from>*

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

Name the **oracle** on the step: written first, a document (a success criterion, a named invariant,
a threat), or a second implementation. Not "matches the implementation" — a test whose expected
value was read off the code passes whatever the code does, including the bug. If no oracle exists
yet, that is a gap in the spec, not something to invent while writing the step.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan
failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may read tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the requirements with fresh eyes and check
the plan against them. This is a checklist you run yourself — not a subagent dispatch.

**1. Requirement coverage:** Build the `## Criteria coverage` table. A criterion with no task
is a **gap** — add the task. Move one to `Not claimed` only when it is deliberately outside this
plan's phase, never to make the table balance.

**2. Placeholder scan:** Search your plan for the red flags from "No Placeholders". Fix them.

**3. Type consistency:** Do the types, method signatures, and property names used in
later tasks match what you defined in earlier tasks? A function called `clearLayers()`
in Task 3 but `clearFullLayers()` in Task 7 is a bug.

Fix any issues inline before the staff-engineer review.

## Staff-Engineer Plan Review (required)

Every plan gets a thorough review by a staff engineer before any code is written.
After your Self-Review, dispatch a **fresh** general-purpose subagent using
`planning-reviewer-prompt.md` in this directory. A fresh reviewer has no authorship
bias — its job is to find the gaps you can't see.

The reviewer classifies each finding at source and returns two buckets. They are
handled differently, and the difference is the point: human attention is the scarce
resource, so it is spent only on findings that carry a decision.

**Mechanical findings — apply, then report.** One right answer, and the reviewer wrote
the exact correction. Apply each to the plan, and list every one in what you surface so
the user can audit and reverse them.

Applying means transcribing the correction the reviewer gave. Two things send a finding
back the other way: the reviewer stated no correction, or applying it would settle
something the plan has not already settled. Either way, treat it as a judgment finding.
**Never re-classify in the other direction.** A finding the reviewer called judgment
stays a judgment finding, however obvious the fix looks to you — you are the author, and
that is exactly the bias the split exists to contain.

**Judgment findings — escalate and wait.** Scope, cost, risk posture, architecture, the
security invariants (auth, isolation, sandbox), anything where you and the reviewer
disagree, anything the reviewer flagged as uncertain. **Do not touch the plan for
these.** Recommendations are advisory in the same way: surface them, never auto-apply.

**Tie-break rule: when in doubt, escalate.** A false escalation costs the user a few
seconds of reading. A false auto-apply silently changes the plan they thought they
approved.

### What to surface

Present, in this order, then **stop and wait**:

1. **Status** — the reviewer's verdict.
2. **Applied without asking** — every mechanical finding, one line each, naming the edit
   you made. Write "none" if there were none; never omit the section.
3. **Needs your decision** — every judgment finding, with the decision being asked for
   and your own opinionated take on it.
4. **Advisory** — the reviewer's recommendations, unapplied.

Record the same applied list at the end of the plan document under a `## Plan review log`
heading, dated, so the audit trail outlives the conversation. The plan is committed and
reviewed in a PR; terminal scrollback is not.

```markdown
## Plan review log

Staff-engineer review 2026-08-10 — applied without asking:
- Task 4: `clearFullLayers()` → `clearLayers()`, matching Task 3.
- Task 6: added the missing `./verify.sh test` step before the commit step.

Escalated to the user: the single-tenancy assumption in Task 2. Decision: scoped out —
recorded in the epic's Resolved list.
```

### Why the gate stays

The reviewer is another instance of the same model, so its blind spots correlate with
yours. Two agreeing agents are much weaker evidence than two agreeing engineers — the
user is the only uncorrelated signal in this loop. This split narrows *what reaches*
them; it does not remove the gate. **Implementation does not start until they respond**,
even when both buckets come back empty.

## After Approval

Once the user has seen the review and the plan is settled, implement it task by task,
committing as you go. Run the project's checks before pushing (see `CLAUDE.md`).

<!-- round-trip marker: an improvement discovered while using the process -->
