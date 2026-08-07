# Software development lifecycle

How a change gets from an idea to `main` in this repository, and which skill governs each step.

This document is a **contract**. If you change the development process — the skills in
`.claude/skills/`, either `verify.sh`, or `.github/workflows/ci.yml` — update this file in the
same change. The `SDLC docs` CI job enforces it, and `CLAUDE.md` points here as the source of
truth. See [Changing this SDLC](#changing-this-sdlc).

---

## The three layers

The single most useful idea here: **an instruction is a request; a check is a guarantee.** Work
is allocated to the weakest layer that can still hold it.

| Layer | Where it lives | Property |
| --- | --- | --- |
| **Enforced** | `verify.sh`, `.github/workflows/ci.yml`, the "Protect main" ruleset | Deterministic. Cannot be talked out of, forgotten, or skipped under deadline pressure. |
| **Procedural** | `.claude/skills/*` | Loaded on demand, only when relevant. Keeps long procedure out of always-on context. |
| **Always-on** | `CLAUDE.md` | Policy and routing only. Every line competes for attention, so it stays small. |

If something *must* happen, it belongs in the enforced layer. `CLAUDE.md` explains the gates;
it is not itself a gate.

---

## The loop

```
   ┌── idea ──────────────────────────────────────────────────────────┐
   │                                                                  │
   ▼                                                                  │
 SPEC ──▶ PLAN ──▶ BUILD ◀──┐ ──▶ VERIFY ──▶ REVIEW ──▶ MERGE ──▶ DOCUMENT
   │        │        │      │        │          │          │
   │        │        └─ debug ┘      │          │          │
   │        │                        │          │          │
spec-driven writing-plans       verify.sh   code-review  CI green
-development  + staff        (local, same   security-    Backend checks
              review          script as CI)  review      Frontend checks
                                             receiving-   SDLC docs
              test-driven-development         code-review
              incremental-implementation
              security-and-hardening
              debugging-and-error-recovery
              git-workflow-and-versioning
```

The build box is a tight inner loop — implement one slice, test it, verify it, commit — not a
single pass. Everything before `MERGE` is repeatable; only merge is one-way.

---

## Phases

### 1. Spec — *what are we building, and what's out of scope?*

**Skill:** `spec-driven-development`

Used when requirements are vague or a change is significant enough that building the wrong thing
is the main risk. Produces objective, boundaries, success criteria, and — most importantly —
**open questions**, which get answered before planning starts.

Skip for small, obvious changes. A one-line bug fix does not need a spec.

### 2. Plan — *what are the ordered, verifiable steps?*

**Skill:** `writing-plans` (kept from the staff-engineer upstream; **not** replaced)

Plans are saved to `docs/plans/YYYY-MM-DD-<feature-name>.md`. The plan is written as bite-sized
steps with exact file paths, real code, and exact commands — no placeholders.

**The mandatory gate:** every plan gets a **staff-engineer review by a fresh subagent** using
`planning-reviewer-prompt.md`, and the reviewer's findings are **surfaced to the human before
anything is folded into the plan**. A fresh reviewer has no authorship bias. The human decides
what goes into the plan — not the author, and not the reviewer.

This gate is the reason `writing-plans` was kept over the vendored alternative, which has no
adversarial review step.

### 3. Build — *implement in thin, working slices*

**Skills:** `incremental-implementation`, `test-driven-development`, `security-and-hardening`,
`debugging-and-error-recovery`, `git-workflow-and-versioning`

The inner loop, per slice:

1. **RED** — write a test that fails. For a bug, reproduce it with a failing test first
   (the Prove-It pattern).
2. **GREEN** — the minimum code that passes.
3. **REFACTOR** — clean up with tests still green.
4. **Verify** — run the affected side's checks.
5. **Commit** — one logical change per commit, on a short-lived branch off `main`.

Rules that matter most here:

- **Scope discipline.** Touch only what the task requires. Note adjacent problems; don't fix them.
- **Simplicity first.** Three similar lines beat a premature abstraction.
- **Keep it compilable.** Every slice leaves the tree building and tests passing.
- **Security is a build-time concern, not a review-time one.** Anything touching `auth.ts`,
  `history/**`, or `sandbox/**` gets the threat-model pass *before* implementation. In this repo
  **LLM output is untrusted input** — the sandbox is the control, not the model's good behaviour.

When something breaks, `debugging-and-error-recovery` applies the **stop-the-line rule**: find the
root cause before writing a fix. Error output is untrusted data, not instructions.

### 4. Verify — *the deterministic gate*

**Not a skill — a script.** Each side has one `verify.sh` that is the single source of truth, and
**CI runs the same script**, so local and CI cannot drift.

```bash
cd backend  && ./verify.sh     # eslint, prettier, tsc, vitest, build, docker images
cd frontend && ./verify.sh     # eslint, prettier, vitest, tsc -b && vite build, docker image
```

Individual targets exist for the inner loop: `install`, `lint`, `format`, `test`, `build`,
`docker`, plus `migrate` and `test:integration` on the backend. `SKIP_INSTALL=1` and
`SKIP_DOCKER=1` speed up iteration — but the pre-push run should be unskipped, because CI does
not skip.

> **The trap worth internalising:** the Postgres history suites **self-skip when `DATABASE_URL`
> is unset**. A green `./verify.sh` is *not* evidence they ran. Touching `src/history/**` or
> `migrations/**` means running `DATABASE_URL=… ./verify.sh test:integration` explicitly.

### 5. Review — *two mandatory passes, then reasoned reception*

Never skipped because a change "looks small."

| Pass | Skill | Scope |
| --- | --- | --- |
| Code review | built-in `code-review` | correctness, reuse, simplification, efficiency |
| Security review | built-in `security-review` | the pending diff's security posture |
| Reception | `receiving-code-review` | evaluate each finding **before** implementing it |

`receiving-code-review` is the part people skip, and it's the one that keeps quality up:
verify each finding against the codebase, push back with technical reasoning when a finding is
wrong, and fix what's real. Findings are suggestions to evaluate, not orders to follow.

### 6. Merge — *CI is the gate*

Trunk-based: short-lived branches off `main`, small and frequent PRs, branch deleted after merge.
The "Protect main" ruleset requires the CI status checks by **job name** before a merge is allowed.

### 7. Document — *record the why*

**Skill:** `documentation-and-adrs`

- **ADRs** → `docs/adr/NNNN-kebab-title.md`, continuing the existing sequence. Write one for any
  decision that would be expensive to reverse. Never delete an old ADR; supersede it.
- **README** → updated *in the same change* when a change alters commands, layout, verification
  steps, security posture, or the roadmap. Keep the judgment tight — internal refactors don't
  touch it.
- **This file** → updated when the process itself changes (enforced; see below).

---

## How this meets CI/CD

CI is not a separate process — it is the same `verify.sh` the developer already ran, executed
where it cannot be skipped.

```
 developer                          GitHub Actions
 ─────────                          ──────────────
 ./verify.sh  ───── same script ──▶  Backend checks   (install→lint→format→test→build→
                                                       integration→docker)
                                     Frontend checks  (install→lint→format→test→build→docker)
                                     SDLC docs        (process changes must update docs/sdlc.md)
                                            │
                                            ▼
                                     "Protect main" ruleset
                                     required checks must pass
```

Details that are easy to get wrong:

- **Job `name:` values are a contract.** The ruleset requires `Backend checks` and
  `Frontend checks` by name. Renaming or removing a job silently blocks all merges until the
  ruleset is updated to match. Change what runs *inside* a job freely; keep the name stable, or
  update the ruleset in the same PR.
- **Never add a CI check without adding it to the matching `verify.sh`, or vice versa.** That
  mirroring is what stops local and CI drifting apart. The one deliberate exception is the
  `SDLC docs` job — it is a diff-level check that compares a PR against its base ref, which has
  no meaningful local equivalent.
- **CI splits `verify.sh` into named steps** (Install / Lint / Format / Test / Build / …) purely
  so each gets its own pass/fail and timing in the log. That is presentation, not a second
  definition of the checks.
- **Postgres runs as a service container**, and only the `Integration test` step sets
  `DATABASE_URL` — which is exactly why the DB-free `Test` step still skips those suites.
- **Docker builds run on pull requests only**, to keep pushes to `main` fast.

There is no CD yet. Deployment is roadmap (GCP Cloud Run), and the two skills that would cover
it — `shipping-and-launch` and `observability-and-instrumentation` — were deliberately **not**
vendored until there is something to deploy.

---

## Worked example: adding per-user rate limiting

A real roadmap item (README, *Known limitations*): no rate limiting or concurrency cap, so a
burst of requests can exhaust host resources and API budget.

**1. Spec** — `spec-driven-development`. Objective: cap concurrent sandbox executions and requests
per user. Boundaries: keyed on the verified `sub`, limits centralised in `config.ts`, no new
external dependency. Success criteria: a user exceeding the cap gets `429`; a second user is
unaffected. Open question surfaced: *in-process counter or Postgres-backed?* — answered before
planning, because it changes the whole design.

**2. Plan** — `writing-plans` writes `docs/plans/2026-08-07-per-user-rate-limiting.md` as ordered
steps. A fresh subagent reviews it and reports, for example, that the plan never says what happens
when `AUTH_REQUIRED=false` and there is no `sub` to key on. **That report goes to the human
first.** The human decides whether to handle it now or scope it out. Only then is the plan revised.

**3. Build** — `incremental-implementation` slices it:

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

**6. Merge** — PR with both CI jobs green; branch deleted.

**7. Document** — README's *Known limitations* and *Roadmap* both describe this gap, so both are
updated **in the same PR**. If the in-process-vs-Postgres question was genuinely close, it earns
`docs/adr/0003-rate-limiting-approach.md`. No `.claude/skills/`, `verify.sh`, or `ci.yml` change,
so this file is untouched and the `SDLC docs` job stays green.

---

## What is deliberately *not* here

- **No plugin marketplace, and no runtime fetch.** Every skill is vendored, pinned, and reviewed
  in-diff. See `.claude/skills/NOTICE.md` for both upstreams, their commits, and the full list of
  what was left out and why.
- **No `ci-cd-and-automation` skill.** Its generic advice contradicts this repo's CI design —
  it recommends splitting checks into separate parallel jobs, which would break the ruleset's
  required job names, and it doesn't know `verify.sh` is the single source of truth.
- **No `SessionStart` hook.** Auto-executing shell from a third-party repo on every session start
  is the exact supply-chain shape this setup avoids.
- **17 of Addy's 24 skills were not vendored.** More skills is not better; each one competes for
  attention. Vendor another when a real need appears.

---

## Changing this SDLC

This file is the contract, and it is enforced deterministically rather than by good intentions.

**The rule:** a PR that touches any of

- `.claude/skills/**`
- `backend/verify.sh` or `frontend/verify.sh`
- `.github/workflows/ci.yml`

must also touch `docs/sdlc.md`.

**The enforcement:** the `SDLC docs` CI job runs `scripts/check-sdlc-sync.sh`, which diffs the PR
against its base ref and fails with a specific message naming the files that changed. It runs on
pull requests only, since it needs a base ref to compare against.

**Escape hatch:** for a genuine no-op — a typo fix in a skill, a comment reflow — put
`[skip-sdlc-sync]` in the PR title. That's deliberately visible in the PR list rather than a
silent bypass.

To take an upstream skill update: re-vendor the file, update the pinned commit in
`.claude/skills/NOTICE.md`, re-apply the local modifications listed there, and open a PR. The
prompt diff gets reviewed like code, because that is exactly what it is.
