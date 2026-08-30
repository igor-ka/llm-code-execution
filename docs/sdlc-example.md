# Worked example: adding per-user rate limiting

The seven phases of [`sdlc.md`](sdlc.md) walked end to end on one real feature, so the
*shape* of each artifact is visible. Everything below happened; the issue numbers are real.

A real roadmap item (README, *Known limitations*): no rate limiting or concurrency cap, so a
burst of requests can exhaust host resources and API budget.

**0. Track** — the gap is already public in the README's *Known limitations*, so it's information
someone could act on. File the epic. The entire body at this point:

```markdown
# Epic: per-user rate limiting and quotas

## Problem
A burst of requests can exhaust host resources (one container per execution) and API
budget. There is no per-user cap and no sandbox concurrency limit.
```

That is a **complete epic**. No solution, no spec, no children — nothing knows what the slices
are yet. It can sit untouched for weeks, and that is fine: it exists so the gap lives somewhere
searchable instead of only in a README bullet.

**1. Spec** — `spec-driven-development` writes `docs/specs/2026-08-08-per-user-rate-limiting.md`.
Objective: cap concurrent sandbox executions and requests per user. Boundaries: keyed on the
verified `sub`, limits centralised in `config.ts`, no new external dependency. Success criteria:
a user exceeding the cap gets `429`; a second user is unaffected. Open question surfaced:
*in-process counter or Postgres-backed?* — answered before planning, because it changes the whole
design. That open question is what earns the spec — without one, this step is skipped and the
plan absorbs it.

**2. Plan** — `writing-plans` writes `docs/plans/2026-08-08-per-user-rate-limiting.md` as ordered
steps. A fresh subagent reviews it and returns both buckets. *Mechanical:* Task 5 calls the limiter
`checkLimit()` where Task 2 defined it as `consume()` — one right answer, so it is applied on the
spot and listed in the plan's `Plan review log`. *Judgment:* the plan never says what happens when
`AUTH_REQUIRED=false` and there is no `sub` to key on — that is scope, so it **goes to the human
and blocks**. The human decides whether to handle it now or scope it out; only then is the plan
revised. The plan's header also names its **PR boundaries** — here, four PRs, one per child — and
the reviewer checks that split against the task graph.

**2b. Children** — *now* the slices are known, so batch-create them under the epic, one per
PR boundary the plan review approved, labelled `enhancement`:

```
#61  R1 — Limit configuration in config.ts
#62  R2 — Per-user limiter keyed on the verified sub
#63  R3 — Enforce on /api/execute (429 + Retry-After)
#64  R4 — Concurrency cap on sandbox launches
```

The reviewer's anonymous-`sub` finding could have collapsed R2 and R3 into one, or added a fifth
child — unknowable before the plan review. Children created earlier would already be wrong.

What did *not* get an issue: the README wording update in step 7. One edit in an existing PR, so
the PR is its own record.

**2c. The epic becomes an index** — the spec, plan, and children now exist, so the epic is
updated to point at them:

```markdown
# Epic: per-user rate limiting and quotas

## Problem
A burst of requests can exhaust host resources (one container per execution) and API
budget. There is no per-user cap and no sandbox concurrency limit.

## Artifacts
- Spec:     docs/specs/2026-08-08-per-user-rate-limiting.md
- Plan:     docs/plans/2026-08-08-per-user-rate-limiting.md
- Decision: docs/adr/0003-rate-limiting-approach.md   ← added at step 7

## Resolved
- In-process counter, not Postgres-backed — see ADR-0003.
- Anonymous mode (AUTH_REQUIRED=false) is out of scope — raised by the plan review,
  scoped out by the human at step 2.

## Children
- [ ] #61 R1 — Limit configuration in config.ts
- [ ] #62 R2 — Per-user limiter keyed on the verified sub
- [ ] #63 R3 — Enforce on /api/execute (429 + Retry-After)
- [ ] #64 R4 — Concurrency cap on sandbox launches
```

The Problem section is byte-identical to step 0 — the epic grew an *index*, not a body. No
design, no task steps, no code: those live under `docs/` and the epic holds paths to them.

`Resolved` is the one section worth hand-writing. Without the anonymous-mode line, the next
reader re-litigates a decision that was already made at step 2.

**3. Build** — `incremental-implementation` slices it, one child issue per branch:

- *Slice 1:* limit config in `config.ts` + unit tests. RED → GREEN → verify → commit.
- *Slice 2:* the limiter itself, keyed on `sub`, with tests for the anonymous case decided above.
- *Slice 3:* wire into `/api/execute`, return `429`.
- *Slice 4:* concurrency cap on sandbox launches.

`security-and-hardening` applies throughout: this touches the auth path, so the threat-model pass
runs first. Rate limiting is the **D** in STRIDE — the abuse case ("one user starves everyone
else") becomes the first test, and a cross-user test proves one user's limit can't affect another,
mirroring the existing isolation battery.

**4. Verify** — `cd backend && ./verify.sh`. No `src/history/**` change here, so the Postgres
suites aren't required — but if the limiter ends up Postgres-backed, `test:integration` becomes
mandatory.

**5. Review** — `code-review` and `security-review` against the diff. Suppose security review
flags that the limiter keys on a header when auth is off. `receiving-code-review` says: verify it
first. It's real → fix it. Had it instead claimed the in-memory counter was a cross-user leak when
the tests already prove otherwise, the right response is a pushback citing the test, not a change.

**6. Merge** — PR body carries `Closes #62` so the child closes itself; all four checks green;
branch deleted. Four PRs land this way, one child each — the `PR shape` job would fail a PR that
tried to close two — and the epic closes when the last child does.

**7. Document** — README's *Known limitations* and *Roadmap* both describe this gap, so both are
updated **in the same PR**. The in-process-vs-Postgres question was close enough to earn
`docs/adr/0003-rate-limiting-approach.md`, and the epic's **Artifacts** list gains that one line
— the last edit the epic ever needs. No `.claude/skills/`, `verify.sh`, or `ci.yml` change, so
this file is untouched and the `SDLC docs` job stays green.
