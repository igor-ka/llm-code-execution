# Spec: loopable plans — a plan-shape contract and a generic loop command

Epic: not filed · Status: **planned and staff-reviewed 2026-08-31 — criterion 7 and D7 amended
after the review; awaiting authorization to implement**

Stack, commands, project layout and testing strategy are not restated here; they live in
[`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md). The toolkit whose carried files
this changes is [`igor-ka/acb`](https://github.com/igor-ka/acb), specified in
[`2026-08-26-sdlc-template.md`](2026-08-26-sdlc-template.md); its decisions are referenced by name.

## Objective

An unattended loop has to decide, on every wake, whether it is done — and it has to decide from
files, because the conversation that launched it may have been summarised away three ticks ago.
Today it cannot. The **criteria** live in the spec, the **scope** of those criteria lives in the
plan when the plan bothers to say, the **progress** lives in GitHub, and nothing anywhere states
which criteria a given run is allowed to chase. Eight loop runs reconstructed that boundary from
context each time, and six of them ended somewhere the prompt never described.

Done means two things. **The plan becomes a single lookup** — read one document and you know what
this run must achieve, what it must not, and what it will need a human for. And **the loop command
becomes generic**: `/loop-plan docs/plans/<file>.md`, with everything variable read from the plan
rather than retyped into the prompt.

This is a change to a **carried** file, so it lands in `acb` and arrives here by `acb pull`. Every
consumer of the toolkit gets the plan-shape contract; only this repository gets the command.

## Context — what exists today

Grounding for the boundaries below; no design implied. Verified against the tree and the session
transcripts on 2026-08-31.

1. **Eight loop runs exist to learn from** — 33 continuation ticks across four sessions,
   2026-08-16 to 2026-08-30, roughly 15 hours of wall clock. All eight used dynamic (self-paced)
   mode; all eight terminated with an explicit `stop`; every tick reported progress.

2. **Two of the eight ended on a condition the prompt stated.** Six ended on a human dependency —
   an account only the operator can create, an org-level privilege change, a `terraform apply`
   needing their credentials, machine state. No prompt mentioned that exit; the loop invented it
   each time.

3. **Criteria live in the spec, without exception.** All 5 specs carry `## Success criteria`;
   0 of 16 plans do. This matches [`docs/sdlc.md`](../sdlc.md) — the spec phase "produces
   objective, boundaries, success criteria, and open questions."

4. **Scope lives in the plan, inconsistently.** 5 of 16 plans carry a `## Definition of done`
   section, and it is a coverage table, not a copy: *spec criterion → the task that discharges it*,
   plus an explicit **Not claimed** line. `2026-08-16-deploy-to-gcp-phase2.md` claims 7 of the
   spec's 12 criteria and disowns 5. The two most recent plans — `2026-08-29-adopt-acb.md` and
   `2026-08-29-trusting-ai-written-tests.md` — have none. The latter has a `## Verification
   summary` of 13 command/expected pairs, which is a proving procedure, not a criterion map.

5. **Plans are write-once.** Across three completed plans there are 240 `- [ ]` checkboxes and
   **zero** ticked. The strongest case is the newest: `2026-08-29-trusting-ai-written-tests.md` was
   implemented and merged across four pull requests, and its 84 checkboxes are all still unticked.
   Progress lives entirely in GitHub — PRs merged, children closed by `Closes #N`. The plan is
   immutable intent; the tracker is mutable state.

6. **The plan review gate is human-blocking.** `docs/sdlc.md` makes the staff-engineer review
   mandatory and says implementation waits for the human "even when both buckets come back empty."
   A spec routinely spans several plans — `2026-08-09-deploy-to-gcp.md` covers four — so anything
   looping across a plan boundary must either stop at that gate or run through it.

7. **`writing-plans/SKILL.md` is carried and vendored.** It is one of 14 `.claude/skills/` entries
   in `acb`'s 25-file `MANIFEST`, adapted from an MIT upstream pinned in
   [`NOTICE.md`](../../.claude/skills/NOTICE.md). Its `## Plan Document Header` already mandates
   four fields — Goal, Architecture, Tech Stack, PR boundaries.

8. **`.claude/skills/` here contains exactly the carried set** — no local entry has ever been added
   to it. **`.claude/commands/` does not exist.** `process.watched` in `.acb.json` covers
   `^\.claude/skills/` but nothing under `commands`.

9. **`acb` is public and at `9fc5e16`.** `acb status` here reports `behind: 0`, `ahead: 0`,
   `drift: none` — the empty-diff property proven by epic #210 currently holds.

10. **No Monitor was armed across all 33 ticks.** Sixteen ticks slept a full 20–25 minute timer
    with nothing waking them early — 6.0 of the 15 hours — much of it waiting on CI runs that
    finish in three to five minutes.

11. **This repository is `acb`'s only consumer.** Nine other repositories sit alongside it under
    `~/Workspaces/Claude`; none has an `.acb.json`, and none has a `docs/plans/` directory. So
    "apply this everywhere" means *available* everywhere on adoption, not *delivered* anywhere
    today — a carried change costs no consumer anything right now, and the only party who
    receives it immediately is a stranger adopting the public toolkit.

## Boundaries

**In scope**

- **A plan-shape contract in `writing-plans/SKILL.md`**: a mandatory `## Criteria coverage`
  coverage table, and a `**Human dependencies:**` header field required only when non-empty.
- **The matching prose in `docs/sdlc.md` §2**, where the argument for `PR boundaries` living in
  the header already sits (D9).
- **One row in `planning-reviewer-prompt.md`**, beside the existing `PR boundaries` check — the
  gate that catches a plan missing either section (D8).
- **A carried `/loop-plan <plan path>` command** whose three exits are stated in the file: the
  claimed criteria pass with evidence, a named human dependency blocks, or a tick ceiling (D7).
- **`^\.claude/commands/` added to `process.watched`** so the `SDLC docs` gate covers it.
- `NOTICE.md`, recording the `writing-plans` modification against its pinned upstream.
- `docs/sdlc-local.md`, updated in the same PRs — four watched paths are touched.

**Out of scope**

- **Any change to what a loop does at runtime.** `/loop` is harness behaviour; this changes only
  the prompt it carries and the documents that prompt reads.
- **Retrofitting existing plans** (D10). The contract applies to plans written after it lands.
- **A CI plan-shape check** (D8). The reviewer is the gate; a merge-time check would be a
  backstop, and it would cost a required check name.
- **`scripts/dod.sh`** (D11), the executable Definition of done. Deferred, not rejected.
- **Changing the criteria in any existing spec.** A Definition of done maps to the criteria as
  written; if a mapping is impossible, that is a finding to report, not a licence to edit the spec.
- **Cloud schedules.** `/schedule` and durable cron loops are a different tool for a different
  problem.
- **The worked example.** `docs/sdlc-example.md` is not re-run against the new shape.

**Non-goal.** This is not a process redesign. Spec → plan → epic → child issue → PR stays exactly
as it is; the plan-shape contract makes an existing convention mandatory and machine-addressable,
and nothing about the phases, the gates or the tracker changes.

## Success criteria

1. **★ `writing-plans/SKILL.md` requires a `## Criteria coverage` table** (renamed from
   `## Definition of done` during the PR 0 review — the carried bucket already owns that name for
   the standing bar in `references/definition-of-done.md`, which is its opposite) mapping each claimed
   spec criterion to the task or step that discharges it, with an explicit **Not claimed** line.
   This is the criterion the whole change exists for: it is what makes a plan a single lookup.
2. **★ Every file changed here is changed in `acb` and arrives by `acb pull`.** After it lands,
   `acb status` in this repository reports `behind: 0`, `ahead: 0`, `drift: none`. A local edit to
   any carried file would leave this repository permanently `ahead` and break the empty-diff
   property epic #210 established.
3. **The reviewer rejects a plan that lacks the section** — proven by running
   `planning-reviewer-prompt.md` against a plan with the section deleted and observing the finding,
   not by asserting that it would.
4. `**Human dependencies:**` is required only when non-empty; a plan with none omits the line and
   passes review.
5. **`/loop-plan docs/plans/<file>.md` takes no other argument.** Scope, criteria, human
   dependencies and PR boundaries all come from the plan; the merge authorization and the tick
   ceiling come from the command file.
6. **The command is carried**: listed in `acb`'s `MANIFEST`, delivered by `acb pull`, and passing
   `tests/carried-purity.test.sh` — it names no identifier belonging to any one consumer.
7. **★ The carried command grants no merge authority, and none of its preconditions is vacuous**
   (D7, as amended). The first precondition is the operator's word *in this run* — something a
   carried file cannot supply and a stranger's fresh adoption never has, so the clause is inert
   wherever it was not invoked. The remaining preconditions must **fail** on an empty set rather
   than pass over one: "declares at least one required status check, **and** every one has reported
   success", never "every required status check has reported success", which is true for free where
   none exist. Verified by reading the file.
8. **`^\.claude/commands/` is in `process.watched`, and the gate trips on it** — demonstrated
   through `scripts/tests/check-sdlc-sync.test.sh`, which is where that behaviour is already
   proven for the other watched paths.
9. **`docs/sdlc.md` §2 and `writing-plans/SKILL.md` agree** on what a plan must contain, and both
   changes were made upstream.
10. `docs/sdlc-local.md` is updated in every PR that touches a watched path, and `README.md` gains
    the command if a reader following it would otherwise be misled.
11. **`NOTICE.md`'s local-modification list names the `writing-plans` change** — it is a vendored
    file, and an unrecorded divergence makes the next upstream sync unreviewable.

## Decisions

**D1 — Upstream first, always.** The order is: PR in `acb`, then `acb pull` here, then the local
PRs. Not the reverse. Epic #210's close-out is the evidence: fixing five defects upstream and
pulling, four separate times, was "the discipline that made SC1 survivable," and patching locally
"would have made the empty-diff test unreachable forever." Editing a carried file here first would
break criterion 2 on the first commit.

**D2 — The spec and plan live here, not in `acb`.** `acb` has no `docs/specs/` or `docs/plans/`;
it was itself specified and planned from this repository
([`2026-08-26-sdlc-template.md`](2026-08-26-sdlc-template.md), both files). `acb` is the subject of
this work, not its host. Same shape as adoption: the plan's first PR lands in the other repository.

**D3 — `Human dependencies` is required only when non-empty.** The field earns its place in a plan
gated on cloud accounts and org permissions; in a repository that never touches infrastructure it
would read "none" forever, and `docs/sdlc.md` is explicit that ceremony is the thing to cut. A plan
with no external dependency omits the line.

**D4 — The plan is the loop's unit — not the spec, not the child issue.** The plan review gate
(Context 6) is human-blocking, so a spec-level loop must stop at every plan boundary anyway; it is
a plan-level loop with a bigger name and more ambiguity. A child issue is one PR in one worktree,
which throws away the only thing a loop buys — surviving the waits between CI, review agents and
merges. The exception is a child that is itself multi-hour with several CI cycles; drop to that
level deliberately, never by default.

**D5 — GitHub is the ledger, never the stop condition.** The epic's children checklist is where a
loop re-establishes position after a context reset, and `Closes #N` in a merged PR is its per-tick
progress signal. The epic *closing* is a consequence of the criteria passing. "Loop until the epic
can be closed" — one of the eight prompts — makes the success condition an action the loop can
itself perform, which is self-certification. Criteria plus evidence cannot be satisfied by an act.

**D6 — The loop never writes to the plan.** Context 5 shows 240 checkboxes and none ticked, and
that is the correct invariant: a plan edited during implementation is no longer the plan the human
approved at the gate.

**D7 — The command is carried verbatim, merge clause included** *(answered 2026-08-31)*. One
command, byte-identical in every consumer, no `.acb.json` field and no per-repo variant to drift.
The objection — that a carried grant reaches repositories where it was never made, `acb` being
public — is answered by construction rather than by weakening the decision: **criterion 7 requires
the clause to be written as preconditions rather than as a permission.** "Merge when the required
checks are green and both review passes are clean" is unsatisfiable in a repository with neither,
so the sentence carries everywhere and only *acts* where the gates it names exist. Expect the
staff-engineer review to test that phrasing; it is the load-bearing part of this decision.

**Amended 2026-08-31, after that review.** The clause as first drafted failed criterion 7, and the
flaw was in this decision's premise rather than in the drafting. "Merge when the required checks are
green" is a universal over a set, and a repository with no ruleset has an empty one — which makes
the sentence true for free in exactly the repository the criterion is about. The two review bullets
had the same shape from a different direction: the loop runs both reviews and judges its own
findings resolved. **The resolution moves the grant out of the file entirely.** The operator's word,
given in the run, is the first precondition; the carried command grants nothing, and the
authorization travels in the launch prompt — where this operator's own loop transcripts already put
it, in as many words. The remaining bullets were rewritten so an empty set fails rather than
passes.

**D8 — Reviewer-enforced, not CI-enforced** *(answered 2026-08-31)*. One row in
`planning-reviewer-prompt.md`, beside the `PR boundaries` row it most resembles. No
`check-plan-shape.sh`, no `Plan shape` job, and therefore **no new required check name** —
`CLAUDE.md` calls those a contract, and adding one costs a ruleset edit, a `ruleset.json`
regeneration and a new `.acb.json` field naming the plans directory. The gate a human already reads
is where a missing section should surface, which is the same argument `docs/sdlc.md` makes about
`PR boundaries` being the control and `PR shape` being the backstop.

**D9 — Both `writing-plans/SKILL.md` and `docs/sdlc.md` §2 change** *(answered 2026-08-31)*. The
skill is where an author reads the template; `docs/sdlc.md` is where the process is argued, and it
already explains why `PR boundaries` sits in the header — the identical argument. Changing only one
would leave the process document silent about a section it requires, which is how the two drift.

**D10 — No retrofit** *(answered 2026-08-31)*. The contract binds plans written after it lands.
`2026-08-29-adopt-acb.md` is finished work nothing will loop, and
`2026-08-29-trusting-ai-written-tests.md` keeps its `## Verification summary` as-is. The
consequence, stated plainly: **the first plan `/loop-plan` is pointed at will have no Definition of
done table**, so either that plan is written after this lands, or its loop reads the spec's
criteria directly and the operator supplies the scope — exactly the situation this spec exists to
end, tolerated once.

**D11 — `scripts/dod.sh` is deferred** *(recommended and unopposed)*. A script that executes a
plan's proving commands and exits non-zero is the difference between *the model says the criteria
pass* and *the criteria pass*, and `2026-08-29-trusting-ai-written-tests.md` already has the raw
material in its `## Verification summary`. It needs a parseable table format in every plan and only
earns out with repeated looping. Revisit after the command has run two or three times and the
closing verification pass has shown where it is weak.

## Residual risk

**The evidence is eight runs on one repository, and that repository spent August doing a cloud
migration.** The Definition of done table is not speculative — it existed in three plans and was
dropped, so mandating it recovers a proven convention. `Human dependencies` is genuinely new, and
D3 is what keeps a bad generalisation cheap: where it does not apply, it does not appear.

**A carried command reaches repositories that never asked for it.** This is D7's accepted cost.
`acb` is public, so a stranger adopting it inherits `/loop-plan` on their first `pull`. After the
amendment the command carries no grant at all: it merges only where the person who started the run
said so *in that run*, which a fresh adoption never has. The review found this exact risk live in
the first draft and it was the blocking finding D7 predicted. What remains a *phrasing* discipline
rather than a mechanism is the non-vacuity of the other preconditions — nothing enforces that but
the next review.

**Nothing delivers this to the other nine repositories.** Context 11: none has adopted `acb`.
Carrying the work makes it available on adoption; it does not make it present. If "all my
repositories" means today rather than eventually, adoption of each is separate work with its own
spec — epic #210 is the measure of what that costs, and it was not small.

**D10 leaves a hole on day one.** The generic command's first target has no table to read.

## Open questions

None. OQ1–OQ4 were answered on 2026-08-31 and are recorded as D7–D10; OQ5 is recorded as D11.

## Not yet decided

Nothing. The plan can be written.
