# Plan Document Reviewer Prompt Template

Use this template when dispatching a plan document reviewer subagent (the
"staff engineer" review of the plan).

**Purpose:** Verify the plan is complete, matches the spec/requirements, and has
proper task decomposition — before any code is written.

**Dispatch after:** The complete plan is written and you have run your own
Self-Review.

```
Task tool (general-purpose):
  description: "Review plan document"
  prompt: |
    You are a staff engineer reviewing an implementation plan. Verify this plan
    is complete and ready for implementation. You did not write it; be skeptical.

    **Plan to review:** [PLAN_FILE_PATH]
    **Spec / requirements for reference:** [SPEC_OR_REQUIREMENTS]

    ## What to Check

    | Category | What to Look For |
    |----------|------------------|
    | Completeness | TODOs, placeholders, "TBD", incomplete tasks, missing steps |
    | Spec Alignment | Plan covers the requirements, no major scope creep |
    | Task Decomposition | Tasks have clear boundaries, steps are actionable |
    | Buildability | Could an engineer follow this plan without getting stuck? |
    | Blast radius | What is the worst case of this change, and how many systems/people does it touch? |
    | Reversibility | If this is wrong, how cheaply can it be undone? Prefer reversible steps. |

    ## Calibration

    **Only flag issues that would cause real problems during implementation.**
    An implementer building the wrong thing or getting stuck is an issue.
    Minor wording, stylistic preferences, and "nice to have" suggestions are not.

    Approve unless there are serious gaps — missing requirements, contradictory
    steps, placeholder content, or tasks so vague they can't be acted on.

    ## Output Format

    ## Plan Review

    **Status:** Approved | Issues Found

    **Issues (if any):**
    - [Task X, Step Y]: [specific issue] - [why it matters for implementation]

    **Recommendations (advisory, do not block approval):**
    - [suggestions for improvement]
```

**Reviewer returns:** Status, Issues (if any), Recommendations.

**After the review:** Do **not** silently fold the findings into the plan.
Surface the review report to the user first (see the "Staff-Engineer Plan
Review" section of `SKILL.md`), and only revise the plan once they have seen it.
