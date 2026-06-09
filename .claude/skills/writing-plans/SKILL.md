---
name: writing-plans
description: Use when you have requirements for a multi-step task, before touching code. Writes a comprehensive implementation plan, then runs a staff-engineer review of that plan and surfaces the findings to the user before incorporating them.
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

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

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

**1. Requirement coverage:** Skim each requirement. Can you point to a task that
implements it? List any gaps.

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

**Then surface the review to the user before changing the plan.** Do not silently
fold the findings in. Present the reviewer's report (Status, Issues, Recommendations)
to the user, give your own opinionated take on each item, and wait for their input.
Only revise the plan once they have seen the review. This is deliberate: the user
decides what goes into the plan.

## After Approval

Once the user has seen the review and the plan is settled, implement it task by task,
committing as you go. Run the project's checks before pushing (see `CLAUDE.md`).
