# Spec: extracting the SDLC as a reusable template

Epic: [#210](https://github.com/igor-ka/llm-code-execution/issues/210) · Status: **all questions
answered — ready to plan**

Stack, commands, project layout, code style and testing strategy are not restated here; they
live in [`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md). This spec covers the
*mechanism* by which the process in [`docs/sdlc.md`](../sdlc.md) travels to another repository —
not the content of that process, which is carried as it stands.

The tool is called **`acb`** — *agentic coding baseline*. The process document it carries keeps
its own name (D9).

## Objective

Make this repository's development process — the skills, the gates, and the enforcement behind
them — installable into a new repository and updatable in both directions afterwards.

Two requirements, and the second is the hard one:

| | Requirement | Done means |
| --- | --- | --- |
| **R1** | Initialise a new repo with the SDLC | One command produces a repo whose gates run, whose ruleset enforces them, and whose agent has the skills |
| **R2** | Carry changes made in one repo across to the others | A skill improved while working on project B reaches project C without a manual diff hunt |

R1 is a scaffolding problem and every generator solves it. R2 is a *synchronisation* problem, and
it is what most templates get wrong: a GitHub template repository has no link back to its
children, so the improvements you make while actually using the process — which is where they all
come from — die in the repo that produced them.

Done means the process is a thing that gets *better across projects* rather than a snapshot that
decays in each one.

## Context — what exists today

Grounding for the boundaries below; no design implied. Counts are from the tracked tree on
2026-08-26.

1. **The procedural layer is close to portable, and less close than it first looks.** The nine
   skills, three references and the planning-reviewer prompt total **3,249 lines**. A precise
   count finds **75 references that must be generalised**: **53 stack-specific commands**
   (`npm test` ×11, `npm audit` ×8, `vitest` ×7, plus `eslint`, `prettier`, `tsc`,
   `package.json`) and **22 app-specific nouns** (`Postgres` ×6, `HistoryStore` ×3, `Auth0` ×3,
   `backend/src/auth.ts`). A further 20 references are to `verify.sh` and the `docs/` layout —
   the template's own conventions, correct as they stand. Only `receiving-code-review` is clean.

   The 53 are mechanical and the fix is identical every time: a skill that says `npm test`
   becomes a skill that says `./verify.sh test`. This is why D5's vocabulary matters beyond
   tidiness — it is what lets one `test-driven-development` skill serve a Swift project and a
   Terraform one.

2. **The gate mechanism is nearly portable, and the exceptions are enumerable.** Across
   `check-sdlc-sync.sh`, `check-pr-shape.sh`, `dependabot-auto-merge.yml`, `pr-shape.yml`,
   `sdlc-docs.yml` and their tests — roughly **1,200 lines** — there are exactly **seven**
   occurrences of `igor-ka/llm-code-execution`:
   - five are test fixtures in `scripts/tests/check-pr-shape.test.sh`;
   - one is already an environment default
     ([`check-pr-shape.sh:18`](../../scripts/check-pr-shape.sh#L18));
   - one is a real behavioural guard
     ([`dependabot-auto-merge.yml:67`](../../.github/workflows/dependabot-auto-merge.yml#L67)),
     whose app-agnostic equivalent is `github.event.repository.fork == false`.

3. **`check-sdlc-sync.sh` has exactly two knobs** —
   [`WATCHED_RE:23`](../../scripts/check-sdlc-sync.sh#L23) and
   [`DOC:24`](../../scripts/check-sdlc-sync.sh#L24). `check-pr-shape.sh` has one,
   [`HATCH:20`](../../scripts/check-pr-shape.sh#L20). Everything else in those scripts is the
   base-ref resolution and the failure messaging, both of which are invariant.

4. **The implementation layer is not portable and should not pretend to be.**
   `deploy-cloud-run.sh` (572), `verify-deployment.sh` (298), `worktree-new.sh` (391), the three
   `verify.sh` bodies (553) and `infra/**` are structurally coupled to Cloud Run, Docker,
   Postgres, Valkey and Auth0 — roughly **3,000 lines** whose *shape* transfers and whose *body*
   does not.

5. **`docs/sdlc.md` is two documents in one file.** Of its 903 lines, 405–523 are the per-user
   rate-limiting worked example — wholly this application. The remainder is process and
   mechanism.

6. **The enforcement is not in the repository at all.** The "Protect main" ruleset requires five
   status checks by job name (`Backend checks`, `Frontend checks`, `SDLC docs`, `PR shape`,
   `Terraform checks`) and enables review-thread resolution. None of that is a tracked file. A
   repository scaffolded with every workflow and no ruleset has all of the checks and none of the
   guarantees.

7. **The verify.sh target vocabulary is already inconsistent within this repo.** Backend and
   frontend expose `install|audit|lint|format|test|build|docker`; `infra/verify.sh` exposes
   `selftest|fmt|init|validate|gates`. Two names for formatting, and `docker` names a *tool*
   rather than a step. Today that is cosmetic; in a stack-agnostic contract it is the contract.

8. **`Terraform checks` is the required check name for the `infra` component.** The check name
   and the directory name already disagree, so anything that generates one from the other will
   silently rename a required check and block merges.

9. **The auto-merge allow-list is npm-only.** `dependabot-auto-merge.yml` gates on
   `startsWith(github.head_ref, 'dependabot/npm_and_yarn/')`, hoisted to a job-level `if:` so it
   evaluates before any third-party action runs. That prefix *is* the security control, and it is
   hardcoded to one ecosystem — wrong for Swift Package Manager, Gradle, pip or Go modules. It
   sits in the Carried bucket today, so it would travel wrong to every non-npm project.

## The design in one idea

**Two buckets, and deliberately nothing between them.**

- **Carried** — byte-identical in every consumer repo. Updating is `cp`; reviewing is
  `git diff`; sending a change upstream is `cp` in the other direction. No merge engine, no
  conflict markers, no templating syntax.
- **Generated** — rendered once at `acb init` from the component declaration, then owned by the
  consumer and never touched again.

The property that makes this work is byte-identity, and every piece of template syntax destroys
it for the file it touches: a `.jinja` file can never again be diffed against its consumers.
Variation therefore moves into a config file that the carried scripts read **at runtime**, not
into substitutions applied at render time.

When a file starts wanting to be in both buckets, that is the signal to push the varying part
into config — not to invent a third bucket.

**Stack-agnosticism is achieved by refusing to guess.** The template ships no working
`verify.sh` for any language. It ships a skeleton that implements the *dispatch contract* and
nothing else, plus a carried conformance test that proves the contract holds (D6).

## Boundaries

**In scope**

- A new standalone repository `acb` (private — D10) holding the carried set, the skeletons, and
  the `acb` command.
- `acb init`, `acb pull`, `acb propose`, `acb status` — bash, `gh` and `jq`, no other runtime
  dependency.
- **`.acb.json`** in each consumer: the template commit, the component/target declaration, and
  the gate knobs from Context 3.
- **De-hardcoding the seven identifiers in Context 2** and the two-plus-one knobs in Context 3,
  in this repository, as the first consumer.
- **A generated layer**: the CI workflow, a fail-closed `verify.sh` skeleton per component,
  `CLAUDE.md`, `dependabot.yml`, and the ruleset document — all rendered from one declaration.
- **A canonical target vocabulary**, enforced by the conformance test, including the
  `docker`→`package` and `fmt`→`format` renames in this repository (D5).
- **Generalising the 75 stack- and app-specific references inside the carried skills** (Context 1)
  so that one copy of each skill serves any project shape.
- **Repositories with no components at all** — a prompt library, a spec repo, an agent-definition
  repo. They declare an empty component list and still receive the entire process layer (D13).
- **Applying the ruleset**, via `gh api`, from a tracked document generated alongside the
  workflow that satisfies it.
- **The worktree rule, its rationale, and a working Tier-A skeleton** — `lib/worktree.sh` carried,
  `scripts/worktree-new.sh` generated, and the rule's stack-specific tails generalised out of
  `docs/sdlc.md` during the split (D12).
- **Splitting `docs/sdlc.md`** into a carried process document and a generated, consumer-owned
  worked example.
- **Adopting `acb` back onto this repository**, which is what makes R2 real (D1).

**Out of scope**

- **Language profiles.** No Node profile, no Python profile, no working `verify.sh` bodies of any
  kind. Dropped deliberately: a profile written before a second project exists is a guess, and
  the skeleton-plus-conformance-test approach (D6) delivers the stack-agnostic property for less.
- **The deployment layer.** `deploy-cloud-run.sh`, `verify-deployment.sh`, `infra/**` and the
  three GCP runbooks stay here. Named so the omission is deliberate: it is the single most
  valuable body of reusable code in the repo, and carrying it would commit every future project
  to Cloud Run before its hosting is chosen.
- **This repository's `worktree-new.sh` as it stands.** Its 391 lines include the per-slot port
  arithmetic, the Compose project naming, and the Auth0-shaped origin handling — Tier C in the
  prior analysis, and specific to this stack. What *is* carried is the rule, its rationale, and
  the slot-allocation library beneath it (D12).
- **Scheduled update pull requests** in consumer repos. The mechanism that keeps consumers from
  silently drifting, deferred until `acb` has been used on a real second project.
- **Improving any carried content.** Skills and gates travel as they stand. A better
  `test-driven-development` skill is separate work with its own issue.
- **Any merge or conflict-resolution engine.** Explicitly rejected in D3.
- **Migrating an existing unrelated repository onto `acb`.** `acb pull` assumes a repo that was
  initialised by `acb init`, or adopted deliberately as this one is.

**Non-goal.** This is not a product. There is no versioning contract, no release cadence, no
support for consumers pinned to old template commits. `acb pull` moves a repo to template `HEAD`
or it does nothing.

## Success criteria

Every criterion is a command whose result is observable. Three are the whole point and are
marked.

1. **★ The empty-diff test.** `acb pull` run against this repository, after adoption, produces a
   `git diff` touching only the recorded template commit in `.acb.json`. Any other hunk means a
   file is in the wrong bucket, and the diff names it.
2. **★ The conformance test proves the contract, not the checks.** Given a `.acb.json`, the
   carried conformance test asserts: every declared component has an executable `verify.sh`;
   every declared target dispatches; an undeclared target exits non-zero with usage; a no-arg run
   invokes every declared target; and **a deliberately failing command planted inside a target
   causes the script to exit non-zero**. That last assertion is what catches `|| true` and the
   POSIX rule exempting a negated command from `errexit` — the decorative-assertion failure mode,
   turned into a shipped check.
3. **★ The round trip.** A skill edited in consumer A reaches consumer C: `acb propose` from A
   opens a pull request on `acb`; after merge, `acb status` in C reports it as *behind* and
   `acb pull` applies it. This is R2, end to end, and nothing short of it demonstrates R2.
4. **The skeleton fails closed.** A freshly initialised repository's CI is **red**, because every
   generated target is `not_implemented` and exits 2. A scaffold that produced green, empty
   checks would ship the decorative-assertion failure at install time.
5. **The worktree rule is followable on day one.** In a freshly initialised repository, with no
   configuration beyond `.acb.json`, `scripts/worktree-new.sh <slug>` creates a worktree on a new
   branch and runs the declared `install` target for every declared component. A skeleton that
   had to be implemented before the first child issue could start would make the rule
   unfollowable at exactly the moment it is first needed.
6. **The gates actually gate.** In a freshly initialised repo with the ruleset applied, a pull
   request naming two issues is *blocked from merging*, not merely red — verified at the merge
   button, since the ruleset is the thing under test, not the workflow.
7. `acb status` partitions its output into **behind** (template has commits this repo lacks) and
   **ahead** (this repo has carried-file edits the template lacks), and the *ahead* set is exactly
   the argument list `acb propose` accepts.
8. `acb propose` **refuses** a generated file, naming the bucket and why. Sending app-specific
   content upstream is the failure mode that makes template maintenance unbearable, so it is
   prevented rather than discouraged.
9. `acb pull` **refuses** to run against a dirty working tree, and never commits. `git diff` is
   the review and `git checkout .` is the undo.
10. Every carried script passes `shellcheck` and retains its existing self-tests, which run in the
   `acb` repo's own CI as well as in each consumer.
11. **This repository's five required check names survive adoption unchanged** — `Backend
    checks`, `Frontend checks`, `SDLC docs`, `PR shape`, `Terraform checks`. Generation reads the
    check name from the declaration, never derives it from the directory (Context 8).
12. `docs/sdlc.md` is updated in the same pull request as every change to `.claude/skills/**`,
    `.github/workflows/**` or `scripts/**` — the existing `SDLC docs` contract applies to this
    work like any other, and this work touches all three.
13. **A repository with no components works.** `acb init` against a declaration with an empty
    component list produces a repo whose `PR shape` and `SDLC docs` checks run and are enforced by
    the ruleset, and whose CI contains no component jobs. Nothing in the process layer requires a
    component to exist.
14. **Declaration and reality agree.** `acb status` fails when a job name in the generated
    workflow is absent from the ruleset's required checks, or when a required check names a job
    that no longer exists — the drift a hand-edited `ci.yml` introduces (D14).

## Decisions

**D1 — This repository becomes consumer #1, not merely the donor.**
The alternative is extracting by copy and never syncing back. Rejected: this is the repository
with the most activity, so it is where SDLC improvements will actually be discovered, and a
one-way extraction gives them no path upstream — R2 failing in exactly the case that matters
most. The cost is honest: one non-trivial pull request here with no user-visible benefit. The
compensation is Success criterion 1, a sharper test of the bucket boundary than any review.

**D2 — Variation lives in runtime config, not in render-time substitution.**
Follows from byte-identity. A concrete consequence: `dependabot-auto-merge.yml` is carried whole
— 382 lines of supply-chain logic with one line to change — rather than becoming a template file.
It also avoids a specific collision: GitHub Actions `${{ }}` and Jinja `{{ }}` share a delimiter,
so templating workflow files means overriding the template engine's syntax before anything ships.

**D3 — No merge engine.**
`copier` is the obvious tool and is rejected. Its `update` performs a three-way merge, which is
machinery the Carried bucket does not need (overwrite is correct) and the Generated bucket does
not want (those files are the consumer's and should never be re-rendered). It would also
introduce Python into a repository whose tooling is Node, Terraform and bash. If the two-bucket
discipline ever fails, that failure is the argument for reconsidering — not the anticipation of
it.

**D4 — `.acb.json` is the single source of truth for CI, verify.sh and the ruleset.**
One declaration of components and their targets generates the workflow's jobs and steps, each
component's `verify.sh` skeleton, and the ruleset's required-check list. Each component declares
an `id` (the directory) **and** a `checkName` (the required status check), because Context 8
shows those already disagree and deriving one from the other would silently rename a required
check. JSON read with `jq` rather than sourced bash: `jq` is already a dependency of the carried
set and is present on every runner, and a component/target declaration is structured data that a
flat key-value file represents badly. The gate scripts are CI-only, so this adds no local
dependency.

**D5 — A canonical target vocabulary: reserved, optional, and extensible.**
`install`, `audit`, `lint`, `format`, `typecheck`, `test`, `test:integration`, `build`,
`package`, `migrate`, `publish`, `eval`, `selftest`, and `all` as the no-arg default.

Three rules, and each is load-bearing for a different project shape:

- **Every target is optional.** Several ecosystems have no `npm audit` equivalent at all; a
  workflow-definition repo has nothing to `build`. A component declares what it has, and the
  conformance test checks only what was declared.
- **Reserved names may not be repurposed.** A component may not call its formatter `lint`.
- **Extra targets are allowed.** `infra/verify.sh`'s `gates` has no canonical equivalent and must
  survive.

Three of these exist for project shapes this repository does not have. **`eval`** is for
non-deterministic quality checks — agent and model work — and is deliberately separate from
`test` because it costs money per run and is rarely binary. **`publish`** is for libraries.
**`migrate`** already exists in `backend/verify.sh` and was simply never named as canonical.

Two renames land in this repository during adoption:
- **`docker` → `package`.** A tool name has no place in a stack-agnostic contract; a Python
  service building a wheel has a packaging step and no Docker. `SKIP_DOCKER=1` becomes
  `SKIP_PACKAGE=1`, which `CLAUDE.md` documents and must be updated with it.
- **`fmt` → `format`.** `infra/verify.sh` disagrees with the other two today.

`infra`'s remaining targets map onto the vocabulary rather than staying bespoke: `init` →
`install`, `validate` → `lint`. `selftest` and `gates` are unchanged.

**D6 — Skeletons and a conformance test, not language profiles.**
The template ships no working `verify.sh` for any stack. It ships a skeleton implementing the
dispatch contract, whose target bodies call `not_implemented` and exit 2, plus the carried
conformance test in Success criterion 2. This is what makes stack-agnosticism real: the
conformance test exercises the script's *plumbing*, which is invariant, and never its checks,
which are not. It is also strictly cheaper than the two profiles it replaces, and it cannot rot
the way a profile for a stack you are not currently using inevitably does.

**D7 — `docs/sdlc.md` splits.**
The invariant process is carried; the worked example (lines 405–523) is generated once and owned
by the consumer. Keeping them in one file guarantees a permanent conflict in the file that the
`SDLC docs` gate requires every process change to touch.

**D8 — The ruleset is a tracked document plus an apply command, not a click-path.**
Branch protection is API state, not files. Shipping the checks without the enforcement would
contradict the process's own maxim — *an instruction is a request; a check is a guarantee* — at
the moment of installation.

**D9 — The tool is `acb`; the document keeps its own name.**
**`acb`** — *agentic coding baseline* — installs and synchronises a way of working with coding
agents. "Baseline" is the load-bearing word: it is the minimum every project starts from and is
free to exceed, which is exactly the relationship a consumer has with the carried set. Three
letters, no collision in the developer toolchain, and short enough to type without an alias. `docs/sdlc.md` *is* the process it carries, and `check-sdlc-sync.sh` is a gate about that
document. Three different jobs, and it is correct that they have three names. "SDLC" is kept for
the document and the `SDLC docs` check because it is accurate, universally understood, and a
required status check whose rename would block merges until the ruleset matched.

**D10 — The `acb` repository is private, and `acb init` will create a consumer repository.**
Private because private→public is free later and the reverse is not, and because the vendored
skills carry MIT attribution in `.claude/skills/NOTICE.md` that must be correct before anything
is published. `acb init` calls `gh repo create` when the target does not exist and initialises in
place when it does, so R1 is honestly one command without being magic.

**D11 — The `acb` repository does not apply the full SDLC to itself in v1.**
It gets `shellcheck`, the carried self-tests, and a render smoke test — not spec/plan/child-issue
ceremony for its own changes. Self-hosting is the strongest correctness signal available and also
the fastest way to spend the entire budget on recursion. Revisit once it is in use.

**D12 — The worktree rule is carried; the worktree script is a skeleton that already works.**
Three things were bundled under "worktrees" and only the third is stack-specific:

- **The rule** — a child issue starts in its own worktree, never a bare `git worktree add` — is
  process, and already sits in the carried half of `docs/sdlc.md` (:190–199). It arrives free with
  D7's split, but its current text names `scripts/worktree-new.sh` and justifies itself by "its own
  application stack", so the stack-specific tails are generalised out during that split.
- **The rationale** — several agent sessions share one checkout, and one switching branches
  mid-task moves `HEAD` under another — is about agentic development, not about this stack. It is
  the strongest argument the rule has and it is entirely portable. It is also the one collision of
  the four that is *live*: the prior analysis found three covered by existing machinery and this one
  mitigated only by a manual protocol.
- **The script** splits cleanly. `slot_of`, `free_slot`, `used_slots`, the atomic `mkdir` mutex,
  the exit trap that releases it, and the dead-tree validation are generic — "hand me a unique
  integer, safely, under concurrency" has nothing to do with Node or Terraform. `stack_env` and
  `frontend_env`, which render `BACKEND_PORT`, `PG_PORT`, `SANDBOX_IMAGE` and `DATABASE_URL`, are
  wholly this application.

So `lib/worktree.sh` is **Carried**, with its own tests, and `scripts/worktree-new.sh` is
**Generated**, sourcing it. That is not a third bucket — a carried library consumed by a generated
script is the two-bucket model working as intended.

The generated script is not a `not_implemented` stub. It ships working at **Tier A**: create the
worktree, branch from a freshly fetched `main`, and run the canonical `install` target for each
declared component. That is possible only because D5 made `install` canonical — the worktree
script can prepare a runnable tree without knowing what language it is preparing. Tier B (linking
gitignored files a worktree cannot inherit) is a path list in `.acb.json`, so it costs
configuration rather than code. Tier C — per-slot ports, per-slot images, externally pre-registered
origins — is a named, empty hook, because the prior analysis found a bare worktree already covers
lint, format, typecheck, build and 23 of 27 backend suites, and adopting Tier C by default is the
single easiest way to make this template feel heavier than it is.

**D13 — Universality comes from thinning the component layer, not from archetypes.**
`.acb.json` has two sections. **`process`** is universal: the watched-path regex, the doc path,
the PR-shape hatch, the review requirements, the Dependabot ecosystem allow-list. **`components`**
is a list that may be **empty**. A repository with no components — a prompt library, a spec repo,
a set of agent definitions — still receives the whole process layer: issue → spec → plan → child
→ pull request → two reviews → merge → document, with one-child-per-PR and doc-sync enforced and
the ruleset applied. For that kind of repository the process layer *is* the value, and today's
design would refuse to serve it.

An "agent archetype" or a "mobile archetype" is rejected for the same reason D6 rejected language
profiles: it is a guess about a project that does not exist yet, and it rots in exactly the way a
guess does. Breadth comes from the component layer being thin and optional, not from enumerating
project kinds.

**D14 — The generator stays minimal, because `ci.yml` belongs to the consumer.**
Generation emits `ubuntu-latest` jobs plus a per-component `runner` field, and stops. macOS
runners for iOS signing, label-gated evals that cost money per run, device farms, matrix
expansion — all of these are hand-edits to a file that nothing ever re-renders (D3), so a limited
generator never blocks anybody. The real hazard is the opposite one: a hand-edited workflow
drifting from the ruleset generated beside it, so that a job someone added is not actually
required and a required check no longer exists. `acb status` therefore checks that the
workflow's job names and the ruleset's required checks still agree.

**D15 — The Dependabot ecosystem allow-list moves into `.acb.json`.**
Context 9: the `dependabot/npm_and_yarn/` branch-prefix test is the security control that decides
which ecosystems may auto-merge, and it is currently hardcoded. It stays a job-level `if:` — the
hoisting is deliberate and must survive, since a metadata-based rule would run third-party code
before rejecting it — but the prefix list is read from configuration. A project declaring no
ecosystems gets no auto-merge, which is the correct default for a repo that has not thought
about it.

## Residual risk

- **The contract is validated against one stack until a second project exists.** Dropping
  profiles removes the guessing, not this. The conformance test proves the plumbing is sound; it
  cannot prove the canonical vocabulary in D5 fits a language nobody has tried. The first
  non-Node consumer is where that is learned, and the cost of being wrong is adding a target name
  — small, and much smaller than a wrong profile.
- **Generalising the skills can hollow them out.** The 53 stack-specific references are
  mechanical, but the 22 app-specific nouns are not: `security-checklist.md` is persuasive partly
  *because* it names Postgres and a verified `sub` rather than "your datastore" and "the user
  identifier". Replacing concreteness with placeholders is how good prompts become vague ones, and
  prompts are behaviour here. The rule to apply is to neutralise a noun only where the example is
  incidental, and where the concreteness is doing the teaching, keep it and mark it as an example
  drawn from another project.
- **Every SDLC improvement now costs two pull requests** — one in the consumer where it was
  discovered, one in `acb`. This is the standing tax of R2 and there is no version of this design
  without it. `acb propose` exists to make the second one cheap.
- **Consumers drift silently.** Nothing in v1 tells a repository it is behind; `acb status` has
  to be run. The scheduled update pull request is the fix and is out of scope. Until it lands, a
  repository initialised and forgotten keeps an old process with no signal.
- **The ruleset API shape is not versioned.** `apply-ruleset.sh` depends on a `gh api` payload
  format GitHub can change, and the failure would appear at `acb init` time in a new repo rather
  than in any existing one's CI.
- **Byte-identity is a discipline, not a mechanism.** Nothing prevents someone adding a
  substitution to a carried file. Success criterion 1 catches it on the next `acb pull` of *this*
  repo, which is a real check but not an immediate one.
- **This repository will duplicate `lib/worktree.sh` until a follow-up child refactors onto it.**
  Its existing `worktree-new.sh` is consumer-owned and therefore never touched by `acb pull`, so
  nothing breaks — but two copies of the slot mutex exist and can drift. Refactoring it is
  deliberately *not* part of the adoption pull request, which is already the riskiest change here;
  it is a separate child, sequenced immediately after. Until it lands, the carried library is
  exercised only by its own tests, and this repo's own standard applies — a claim nobody has
  exercised is an assumption.
- **The adoption pull request is the largest single risk to this repository.** It renames two
  verify targets and an environment variable, rewrites two gate scripts, splits a 903-line
  document under an active CI contract, and must leave five required check names untouched. It is
  also, by D1, not optional.

## Open questions

None outstanding. Every question raised during specification has been answered and folded into
the Decisions above.

## Not yet decided

Whether the deployment layer eventually becomes a carried optional module or stays app-specific
forever. It is out of scope for v1 (Boundaries) and the answer depends on whether a second
project picks Cloud Run. Recorded here so the omission stays a decision rather than an oversight.
