# Definition of Done

A standing, project-wide bar that every change clears before it counts as done. Acceptance
criteria vary per task and answer *"did we build the right thing?"*; the Definition of Done is
the same every time and answers *"is this finished to our standard?"*.

Adapted from `agent-skills` by Addy Osmani (MIT), upstream commit `d2478bf` — rewritten to name
this repository's actual gates rather than generic ones. See `../NOTICE.md`.

## Definition of Done vs. acceptance criteria

|          | Acceptance criteria         | Definition of Done              |
| -------- | --------------------------- | ------------------------------- |
| Scope    | Specific to one task        | Applies to every increment      |
| Changes  | Different for each item     | Fixed and reused                |
| Answers  | "Did we build *this thing*?" | "Is it *ready*?"               |
| Owner    | Defined when planning       | Defined once for the project    |

A task is done only when **its** acceptance criteria are met **and** this standing bar is
satisfied. Skipping either leaves work that looks finished but is not.

## The standing checklist

### Correctness

- [ ] All acceptance criteria for the task are met.
- [ ] New behaviour is covered by a test that **fails without the change and passes with it**.
- [ ] Existing tests still pass; no regressions.
- [ ] Edge cases and error paths are handled, not just the happy path.

### The verification gate (non-negotiable)

This repo's single source of truth is `verify.sh` — CI runs the **same script**, so local and CI
cannot drift. Run the side(s) you touched:

- [ ] `cd <component> && ./verify.sh`, for each component you touched — lint, format, typecheck,
      tests, build, package. The same script, and the same targets, that CI runs.
- [ ] Touched code covered by a suite that needs a live service? Run it explicitly:
      `./verify.sh test:integration` with the service's environment variable set. Such suites
      self-skip when it is unset, so a green `./verify.sh` alone does **not** prove they ran.

`SKIP_INSTALL=1` and `SKIP_PACKAGE=1` speed up the inner loop, but a final pre-push run should be
unskipped — CI does not skip.

### Security invariants

- [ ] Changes touching the sensitive paths `CLAUDE.md` names keep the isolation invariants
      intact: identity comes from the **verified token** (`sub`), never the request body; every
      store method filters on the owner; a record you don't own returns **404**, never 403.
- [ ] The cross-user battery and planted-hole mutants still pass
      (`backend/tests/history/isolation.test.ts`, `historyMutants.ts`). These are designed to fail
      if an owner filter is ever dropped — never weaken them to make a change pass.
- [ ] SQL stays fully parameterized; LIKE wildcards stay escaped.
- [ ] No secrets committed; no internal exception detail newly exposed in responses.

### Quality

- [ ] Code reveals intent through naming and structure.
- [ ] No duplicated business logic, dead code, debug output, or commented-out blocks.
- [ ] Changes are scoped to the task — no unrelated refactors snuck in.

### Documentation

- [ ] `README.md` updated **in the same change** if the change alters anything a README reader
      relies on — commands, layout, verification/setup steps, security posture, or the roadmap.
      Keep this tight: internal-only refactors don't touch it.
- [ ] Decisions worth preserving recorded as an ADR in `docs/adr/` (see `documentation-and-adrs`).
- [ ] The process document updated if the change alters the development process itself — the
      skills in `.claude/skills/`, any component's `verify.sh`, anything in `scripts/`, or a
      workflow in `.github/workflows/`. Which document that is comes from `process.doc` in
      `.acb.json`, and the exact watched list from `process.watched` beside it; `docs/sdlc.md` is
      carried and must not be edited locally when `process.doc` names a companion. Enforced by the
      `SDLC docs` CI job.
- [ ] Documentation describes the current state in timeless language, not the change history.

### Review (mandatory — never skipped because a change "looks small")

- [ ] `code-review` skill run against the pending diff.
- [ ] `security-review` skill run against the pending diff.
- [ ] Findings evaluated with `receiving-code-review` — verified against the codebase, pushed back
      on with technical reasoning where wrong — and the real ones fixed before handover.
- [ ] CI green on the PR (`Backend checks`, `Frontend checks`).

## How to apply

- **Per increment:** Correctness + the verification gate.
- **Per PR:** everything above, including both reviews.
- **Per feature:** confirm Documentation and the security invariants once the whole slice lands.

## Red flags

- "It's done, I just haven't run `verify.sh` yet" — unverified work is not done.
- A green `./verify.sh` treated as proof the service-backed suites ran (they self-skip).
- Weakening the isolation battery or mutants so a change passes.
- Skipping the review skills because the diff is small.
- A different bar applied under deadline pressure.
