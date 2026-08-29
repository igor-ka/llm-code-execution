# acb — Implementation Plan

**Goal:** Build `acb`, a private toolkit that installs this repository's development process into
a new repository and carries improvements between repositories in both directions.

**Architecture:** Two buckets and nothing between them. The **carried** set — skills, gate scripts,
gate workflows, the invariant half of `docs/sdlc.md` — is byte-identical in every consumer, so
updating is `cp`, reviewing is `git diff`, and sending a change upstream is `cp` reversed. The
**generated** set — `ci.yml`, `verify.sh` skeletons, `CLAUDE.md`, `dependabot.yml`, the ruleset
document — is rendered once at `acb init` from a single declaration in `.acb.json` and is
thereafter the consumer's own. Variation lives in that declaration, read at *runtime* by the
carried scripts, never as render-time substitution inside a carried file.

**Tech Stack:** bash 3.2 (macOS ships it), `jq`, `gh`, GitHub Actions, `shellcheck`. No Python, no
Node, no template engine.

**PR boundaries:** Five, all in the new `acb` repository. `llm-code-execution` is not touched by
this plan at all.

- **PR 1: repository skeleton and the `.acb.json` contract** — closes the child *acb skeleton and
  config contract*.
- **PR 2: the carried set, de-hardcoded** — closes the child *carry the gate mechanism*.
- **PR 3: generalise the carried skills** — closes the child *generalise the skills*.
- **PR 4: the generated layer, `acb init`, and the ruleset** — closes the child *generate and
  initialise*.
- **PR 5: `acb status`, `pull`, and `propose`** — closes the child *bidirectional sync*.

Child issues are **not filed yet**, deliberately. The staff-engineer review of this plan can move a
PR boundary, and issues filed before that review would have to be renumbered or closed unused. They
are filed on approval, under epic
[#210](https://github.com/igor-ka/llm-code-execution/issues/210), and — since the epic lives here
while the pull requests live in `acb` — each PR closes its child with the cross-repository form
`Closes igor-ka/llm-code-execution#N`.

**Spec:** [`docs/specs/2026-08-26-sdlc-template.md`](../specs/2026-08-26-sdlc-template.md) —
decisions D1–D15 and criteria SC1–SC14 are referenced by name throughout. **Read it first.**

---

## Scope: this plan builds the toolkit, not the adoption

Two things are deliberately **out of this plan**, each for its own reason.

**Adoption of `llm-code-execution` as consumer #1 (D1) is a separate plan.** It is a different
subsystem in a different repository with a different risk profile: it renames two `verify.sh`
targets and an environment variable, swaps two gate scripts for carried copies, splits a 903-line
document that is under an active CI contract, and must leave five required status check names
untouched. Merging it into this plan would put the riskiest change in the repo behind five PRs of
unrelated work, and would deny it its own staff review. It also has a hard prerequisite: there is
nothing to adopt until PR 5 lands.

**The worktree library and skeleton (D12) is a follow-on plan.** `lib/worktree.sh` and the Tier-A
`worktree-new.sh` are genuinely separable — nothing in PRs 1–5 depends on them, and nothing in them
depends on anything past PR 1's config contract. They are deferred because R1 and R2 are the
requirements that justify the project and the worktree facility is a convenience on top.

What this plan does deliver, end to end: `acb init` produces a repository whose gates run and are
enforced by a ruleset, and `acb pull` / `propose` / `status` move changes in both directions.

**What it does not deliver, stated plainly.** R1 and R2 are *built and demonstrated*, not *proven
against the repository the spec names as consumer #1*. At the end of PR 5, SC1 (the empty-diff
test), SC5 (the worktree rule) and SC11 (five required check names survive) are all still unmet, and
SC3's round trip has been shown only between two throwaway consumers. Those are the adoption plan's
acceptance criteria, and adoption is where this stops being a toolkit that works and becomes a
toolkit that is *right* — the empty-diff test is the only check that can tell the difference.

## Design notes the tasks assume

Six points that are load-bearing and easy to get wrong.

**1. There is no template engine, and that is a decision (D2/D3).** GitHub Actions `${{ }}` collides
with every mainstream engine's delimiters, and any file carrying template syntax can never again be
diffed against its consumers. Generation is therefore two mechanisms, both dependency-free:

- **Marker substitution** for static files — `templates/*.tmpl` contain `@@NAME@@` markers replaced
  with `sed`. Used where there is no repetition.
- **Fragment assembly** for repeated structure — `templates/ci.yml.head` plus
  `templates/ci.yml.component` rendered once per component and concatenated. Used where a loop is
  needed, which `sed` cannot express.

`@@` is chosen because it appears in no YAML, JSON, Markdown or shell construct this repository
uses; `${...}` and `{{...}}` both do.

**2. Every carried file must be byte-identical across consumers, and PR 2 has a test for it.** The
temptation is to sneak one substitution into `check-pr-shape.sh`. The moment that happens the file
leaves the carried bucket and SC1 can never pass. Configuration is read at runtime with `jq`, from
`.acb.json`, every time.

**3. `jq` is a hard dependency of the carried gate scripts, and that is new.** `check-sdlc-sync.sh`
is dependency-free today. Both gate scripts run in CI only — there is no local equivalent, which is
why they live in `scripts/` rather than in a `verify.sh` — and `jq` is present on every GitHub
runner and is already used by `dependabot-auto-merge.yml`. `bin/acb` also requires it and checks
for it explicitly, because a missing `jq` otherwise surfaces as an empty config rather than an error.

**4. Exit codes are part of both contracts.** `bin/acb`: `0` success, `1` operational failure, `2`
usage error, `3` refusal-by-design (dirty tree, generated file offered to `propose`). A generated
`verify.sh` skeleton has its own two: `2` from an unimplemented target, so a fresh repository's CI
is **red** until targets are filled in (SC4), and `64` from an *unknown* target. They must differ —
the conformance test distinguishes "this target exists but does nothing yet" from "this target does
not exist", and one shared code would make that check vacuous. A scaffold that returned `0` for an empty target would ship the
decorative-assertion failure at install time, which is the exact failure this process exists to
prevent.

**5. Tests are plain bash in the existing house style.** `pass`/`fail` counters, `ok`/`bad` helpers,
an `asserts` function per suite, `set -uo pipefail` (not `-e`, so a failing assertion does not abort
the run). This matches `scripts/tests/check-sdlc-sync.test.sh` exactly, and the carried tests come
across unchanged, so there is one convention rather than two.

**6. `acb` does not apply the full SDLC to itself (D11).** Its `verify.sh` runs `shellcheck`, the
test suites, and a render smoke test. No spec, no plan, no child issue per change, no PR-shape gate
on its own pull requests. Self-hosting is the strongest correctness signal available and also the
fastest way to spend the whole budget on recursion.

## File structure

The `acb` repository as it stands at the end of PR 5.

```
acb/
├── bin/acb                            # dispatcher: init | pull | propose | status
├── lib/
│   ├── config.sh                       # read and validate .acb.json (jq)
│   ├── render.sh                       # marker substitution + fragment assembly
│   └── sync.sh                         # pull / status / propose mechanics
├── carried/                            # byte-identical into every consumer
│   ├── .claude/skills/**               # 9 skills, 3 references, reviewer prompt
│   ├── .github/workflows/
│   │   ├── pr-shape.yml
│   │   ├── sdlc-docs.yml
│   │   └── dependabot-auto-merge.yml
│   ├── scripts/
│   │   ├── check-pr-shape.sh
│   │   ├── check-sdlc-sync.sh
│   │   ├── check-conformance.sh        # the verify.sh contract test (SC2)
│   │   └── tests/*.test.sh
│   └── docs/sdlc.md                    # invariant half only (D7)
├── templates/                          # rendered once at init, then the consumer's
│   ├── ci.yml.head
│   ├── ci.yml.component
│   ├── verify.sh.tmpl
│   ├── CLAUDE.md.tmpl
│   ├── dependabot.yml.head
│   ├── dependabot.yml.ecosystem
│   ├── ruleset.json.tmpl
│   ├── apply-ruleset.sh.tmpl
│   └── sdlc-example.md.tmpl
├── schema/acb.schema.json
├── tests/                              # acb's own suites
│   ├── config.test.sh
│   ├── cli.test.sh
│   ├── render.test.sh
│   ├── carried-purity.test.sh
│   ├── skills-portability.test.sh
│   └── sync.test.sh
├── MANIFEST                            # every carried path, one per line
├── verify.sh                           # selftest | lint | render
└── .github/workflows/ci.yml
```

`MANIFEST` is the boundary made explicit. `acb pull` writes exactly the paths it lists and nothing
else; `acb propose` accepts exactly those paths and refuses everything else (SC7). One file answers
"is this carried?", so the answer cannot drift between the two commands.

## The `.acb.json` contract

Referenced by every task below. This is the complete v1 shape.

```json
{
  "template": {
    "repo": "igor-ka/acb",
    "commit": "0000000000000000000000000000000000000000"
  },
  "process": {
    "doc": "docs/sdlc.md",
    "watched": [
      "^\\.claude/skills/",
      "^\\.github/workflows/",
      "^scripts/"
    ],
    "prShapeHatch": "[multi-child]",
    "sdlcSyncHatch": "[skip-sdlc-sync]",
    "dependabotEcosystems": ["npm_and_yarn"]
  },
  "components": [
    {
      "id": "backend",
      "checkName": "Backend checks",
      "runner": "ubuntu-latest",
      "targets": ["audit", "install", "lint", "format", "test", "build", "package"]
    }
  ]
}
```

`components` **may be empty** (D13) — a prompt library or a spec repository declares `[]` and still
receives the whole process layer. `id` and `checkName` are separate fields because they already
disagree in `llm-code-execution`, where the `infra` directory's required check is named
`Terraform checks`; deriving one from the other would silently rename a required status check and
block merges (SC10).

---

# PR 1 — Repository skeleton and the `.acb.json` contract

Closes the child *acb skeleton and config contract*. Delivers a repository that verifies itself and
a config reader every later task depends on.

### Task 1: Create the repository and its own verification script

**Files:**
- Create: `verify.sh`
- Create: `.github/workflows/ci.yml`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Create the private repository and clone it**

```bash
gh repo create acb --private --description "my agentic coding toolkit" --clone
cd acb
```

Expected: `✓ Created repository igor-ka/acb on GitHub` followed by a clone into `./acb`.
Private per D10 — private→public is free later, the reverse is not, and the vendored skills carry
MIT attribution in `NOTICE.md` that must be correct before anything is published.

- [ ] **Step 2: Write `verify.sh`**

This is `acb`'s own script, not the skeleton it ships. Three targets only (D11).

```bash
#!/usr/bin/env bash
# The single entry point CI and a developer both run. Same script, same targets, so the two
# cannot drift — the property the toolkit exists to propagate.
set -euo pipefail
cd "$(dirname "$0")"

run() { echo "==> $*"; "$@"; }

lint() {
  # -x follows `source` so lib/*.sh is analysed in the context that sources it.
  run shellcheck -x bin/acb lib/*.sh tests/*.test.sh
}

selftest() {
  local t status=0
  for t in tests/*.test.sh; do
    echo "==> $t"
    "$t" || status=1
  done
  return $status
}

render() {
  # Smoke test: a render into a throwaway directory must succeed and leave no @@MARKER@@ behind.
  run ./tests/render.test.sh
}

all() { lint; selftest; }

case "${1:-all}" in
  lint|selftest|render|all) "${1:-all}" ;;
  *) echo "usage: ./verify.sh [lint|selftest|render|all]" >&2; exit 2 ;;
esac
```

- [ ] **Step 3: Make it executable and run it**

```bash
brew install shellcheck
chmod +x verify.sh && ./verify.sh
```

Expected: FAIL — `shellcheck: bin/acb: No such file or directory`. That is correct; nothing exists
yet. This step exists so the first green run in Task 3 means something.

- [ ] **Step 4: Write the CI workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    name: Checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Install shellcheck
        run: sudo apt-get update && sudo apt-get install -y shellcheck
      - name: Lint
        run: ./verify.sh lint
      - name: Self-test
        run: ./verify.sh selftest
```

- [ ] **Step 5: Write `.gitignore` and `README.md`, then commit**

```bash
printf '%s\n' '.DS_Store' '*.tmp' 'tmp/' > .gitignore
cat > README.md <<'EOF'
# acb — my agentic coding toolkit

Installs a development process into a repository, and carries improvements between repositories.

    acb init <dir>     scaffold a repository from this toolkit
    acb status         what this repo is behind or ahead on
    acb pull           bring carried files up to the toolkit's HEAD
    acb propose <path> open a PR upstream with a carried file you changed

Design and rationale: `docs/specs/2026-08-26-sdlc-template.md` in igor-ka/llm-code-execution.
EOF
git add -A && git commit -m "chore: repository skeleton, verify.sh and CI"
```

### Task 2: The config schema and reader

**Files:**
- Create: `schema/acb.schema.json`
- Create: `lib/config.sh`
- Create: `tests/config.test.sh`

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# Unit tests for lib/config.sh. The config is the contract every later command reads, so a
# malformed one must fail loudly here rather than produce an empty component list three
# commands later — which would render an empty CI workflow and look like success.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/config.sh
source lib/config.sh

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

write_cfg() { printf '%s' "$1" > "$TMP/.acb.json"; }

# asserts_validate <name> <expected-exit> <json>
asserts_validate() {
  local name="$1" want="$2" json="$3" got out
  write_cfg "$json"
  out="$(ACB_CONFIG="$TMP/.acb.json" acb_config_validate 2>&1)"; got=$?
  if [[ "$got" -eq "$want" ]]; then ok "$name"
  else bad "$name" "expected exit ${want}, got ${got}: ${out}"; fi
}

VALID='{"template":{"repo":"igor-ka/acb","commit":"abc"},
        "process":{"doc":"docs/sdlc.md","watched":["^scripts/"],
                   "prShapeHatch":"[multi-child]","sdlcSyncHatch":"[skip-sdlc-sync]",
                   "dependabotEcosystems":["npm_and_yarn"]},
        "components":[{"id":"backend","checkName":"Backend checks",
                       "runner":"ubuntu-latest","targets":["lint","test"]}]}'

asserts_validate "accepts a complete config"        0 "$VALID"
asserts_validate "accepts zero components (D13)"    0 "$(jq -c '.components=[]' <<<"$VALID")"
asserts_validate "rejects invalid JSON"             1 '{ not json'
asserts_validate "rejects a missing process block"  1 "$(jq -c 'del(.process)' <<<"$VALID")"
asserts_validate "rejects a duplicate component id" 1 "$(jq -c '.components += .components' <<<"$VALID")"
asserts_validate "rejects an empty checkName"       1 "$(jq -c '.components[0].checkName=""' <<<"$VALID")"
asserts_validate "rejects a component with no targets" 1 "$(jq -c '.components[0].targets=[]' <<<"$VALID")"

# Accessors
write_cfg "$VALID"
export ACB_CONFIG="$TMP/.acb.json"
[[ "$(acb_components)" == "backend" ]] && ok "acb_components lists ids" || bad "acb_components lists ids" "got '$(acb_components)'"
[[ "$(acb_targets backend | tr '\n' ' ')" == "lint test " ]] && ok "acb_targets lists targets" || bad "acb_targets lists targets" "got '$(acb_targets backend)'"
[[ "$(acb_check_name backend)" == "Backend checks" ]] && ok "acb_check_name reads checkName" || bad "acb_check_name reads checkName" "got '$(acb_check_name backend)'"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chmod +x tests/config.test.sh && ./tests/config.test.sh
```

Expected: FAIL with `lib/config.sh: No such file or directory`.

- [ ] **Step 3: Write `lib/config.sh`**

```bash
#!/usr/bin/env bash
# Reader and validator for .acb.json. Sourced by bin/acb and by the carried gate scripts.
#
# Every accessor reads the file rather than caching into globals: the gate scripts are one-shot
# CI invocations where a cache buys nothing, and a stale cache in a long-running command is a
# class of bug this does not need to have.

# The canonical target vocabulary (D5). Reserved names; extras are allowed, so this list is not
# used to reject unknown targets — only to document what the names mean and to let `acb init`
# order the generated CI steps sensibly.
ACB_CANONICAL_TARGETS="install audit lint format typecheck test test:integration build package migrate publish eval selftest"

acb_config_path() { printf '%s' "${ACB_CONFIG:-.acb.json}"; }

acb_config_validate() {
  local f; f="$(acb_config_path)"
  if [[ ! -f "$f" ]]; then
    echo "✗ no $f here — run 'acb init' first, or cd to a repository that has one." >&2
    return 1
  fi
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "✗ $f is not valid JSON." >&2
    return 1
  fi
  local problem
  # One jq expression, so every problem is reported in one pass rather than one per run.
  problem="$(jq -r '
    [ (if .template.repo   | type != "string" then "template.repo must be a string" else empty end),
      (if .process.doc     | type != "string" then "process.doc must be a string"   else empty end),
      (if .process.watched | type != "array"  then "process.watched must be an array" else empty end),
      (if (.components | type) != "array" then "components must be an array (use [] for none)" else empty end),
      (([.components[]?.id] | length) as $n
        | ([.components[]?.id] | unique | length) as $u
        | if $n != $u then "component ids must be unique" else empty end),
      (.components[]? | select((.checkName // "") == "") | "component \(.id // "?") has no checkName"),
      (.components[]? | select((.targets // []) | length == 0) | "component \(.id // "?") declares no targets")
    ] | join("\n")' "$f")"
  if [[ -n "$problem" ]]; then
    printf '✗ %s is invalid:\n' "$f" >&2
    printf '%s\n' "$problem" | sed 's/^/    /' >&2
    return 1
  fi
  return 0
}

acb_components()  { jq -r '.components[]?.id' "$(acb_config_path)"; }
acb_targets()     { jq -r --arg id "$1" '.components[] | select(.id == $id) | .targets[]' "$(acb_config_path)"; }
acb_check_name()  { jq -r --arg id "$1" '.components[] | select(.id == $id) | .checkName' "$(acb_config_path)"; }
acb_runner()      { jq -r --arg id "$1" '.components[] | select(.id == $id) | .runner // "ubuntu-latest"' "$(acb_config_path)"; }
acb_process()     { jq -r --arg k "$1" '.process[$k] // ""' "$(acb_config_path)"; }
acb_process_arr() { jq -r --arg k "$1" '.process[$k][]?' "$(acb_config_path)"; }
acb_template()    { jq -r --arg k "$1" '.template[$k] // ""' "$(acb_config_path)"; }
```

- [ ] **Step 4: Write the JSON Schema and run the tests**

`schema/acb.schema.json` documents the same shape for an editor; `lib/config.sh` is the enforcement
because a schema validator is another dependency and the gate scripts cannot take one.

```bash
mkdir -p schema
jq -n '{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  title: "acb configuration",
  type: "object",
  required: ["template", "process", "components"],
  properties: {
    template: { type: "object", required: ["repo","commit"],
      properties: { repo: {type:"string"}, commit: {type:"string"} } },
    process: { type: "object", required: ["doc","watched"],
      properties: { doc: {type:"string"}, watched: {type:"array", items:{type:"string"}},
                    prShapeHatch: {type:"string"}, sdlcSyncHatch: {type:"string"},
                    dependabotEcosystems: {type:"array", items:{type:"string"}} } },
    components: { type: "array", items: { type: "object",
      required: ["id","checkName","targets"],
      properties: { id: {type:"string"}, checkName: {type:"string"},
                    runner: {type:"string"}, targets: {type:"array", items:{type:"string"}} } } }
  }
}' > schema/acb.schema.json
./tests/config.test.sh
```

Expected: `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/config.sh tests/config.test.sh schema/acb.schema.json
git commit -m "feat(config): .acb.json schema, reader and validator"
```

### Task 3: The `acb` dispatcher

**Files:**
- Create: `bin/acb`
- Create: `tests/cli.test.sh`

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# Exit codes are part of the contract (design note 4): 0 success, 1 operational failure,
# 2 usage error, 3 refusal by design. A caller — often an agent following CLAUDE.md rather than
# a human reading stderr — distinguishes "you typed it wrong" from "I declined" on the code alone.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

# asserts <name> <expected-exit> <needle> <args...>
asserts() {
  local name="$1" want="$2" needle="$3"; shift 3
  local out got
  out="$(./bin/acb "$@" 2>&1)"; got=$?
  if [[ "$got" -eq "$want" && "$out" == *"$needle"* ]]; then ok "$name"
  else bad "$name" "expected exit ${want} containing '${needle}', got ${got}: ${out}"; fi
}

asserts "no arguments prints usage"     2 "usage: acb"
asserts "unknown subcommand exits 2"    2 "unknown command 'frobnicate'" frobnicate
asserts "--help exits 0"                0 "usage: acb" --help
asserts "status outside a acb repo"    1 "run 'acb init' first" status

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chmod +x tests/cli.test.sh && ./tests/cli.test.sh
```

Expected: FAIL — `./bin/acb: No such file or directory` on every case.

- [ ] **Step 3: Write `bin/acb`**

```bash
#!/usr/bin/env bash
set -uo pipefail

ACB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ACB_ROOT

usage() {
  cat <<'EOF'
usage: acb <command> [args]

  init <dir> [--repo owner/name]  scaffold a repository from this toolkit
  status                          what this repository is behind or ahead on
  pull                            bring carried files up to the toolkit's HEAD
  propose <path>...               open a PR upstream with carried files you changed

exit codes: 0 ok · 1 failure · 2 usage · 3 refused by design
EOF
}

# jq is required by every command and by the carried gate scripts. Checked here rather than at
# first use: an absent jq otherwise surfaces as an empty config, which reads as "no components"
# and renders an empty CI workflow — a silent wrong answer instead of an error.
if ! command -v jq >/dev/null 2>&1; then
  echo "✗ acb requires jq (brew install jq)." >&2
  exit 1
fi

# shellcheck source=lib/config.sh
source "$ACB_ROOT/lib/config.sh"

cmd="${1:-}"; [[ $# -gt 0 ]] && shift
case "$cmd" in
  ""|-h|--help|help) usage; if [[ -z "$cmd" ]]; then exit 2; fi; exit 0 ;;
  init)    source "$ACB_ROOT/lib/render.sh"; acb_cmd_init "$@" ;;
  status)  source "$ACB_ROOT/lib/sync.sh";   acb_cmd_status "$@" ;;
  pull)    source "$ACB_ROOT/lib/sync.sh";   acb_cmd_pull "$@" ;;
  propose) source "$ACB_ROOT/lib/sync.sh";   acb_cmd_propose "$@" ;;
  *) echo "✗ unknown command '$cmd'." >&2; usage >&2; exit 2 ;;
esac
```

- [ ] **Step 4: Stub the two libraries so the dispatcher loads, then run the tests**

`lib/render.sh` and `lib/sync.sh` are written in PRs 4 and 5. Stubs here keep Task 3 self-contained
and keep `shellcheck -x` able to follow the `source` lines.

```bash
mkdir -p lib
printf '%s\n' '#!/usr/bin/env bash' 'acb_cmd_init() { echo "✗ not implemented until PR 4." >&2; return 1; }' > lib/render.sh
printf '%s\n' '#!/usr/bin/env bash' \
  'acb_cmd_status()  { acb_config_validate || return 1; }' \
  'acb_cmd_pull()    { echo "✗ not implemented until PR 5." >&2; return 1; }' \
  'acb_cmd_propose() { echo "✗ not implemented until PR 5." >&2; return 1; }' > lib/sync.sh
chmod +x bin/acb && ./tests/cli.test.sh && ./verify.sh
```

Expected: `4 passed, 0 failed`, then `verify.sh` green — the first meaningful green run, since
Task 1 Step 3 deliberately failed.

- [ ] **Step 5: Commit and open PR 1**

```bash
git add bin/acb lib/render.sh lib/sync.sh tests/cli.test.sh
git commit -m "feat(cli): acb dispatcher with usage and exit-code contract"
git push -u origin HEAD
gh pr create --title "feat: repository skeleton and the .acb.json contract" \
  --body "Closes igor-ka/llm-code-execution#<child>"
```

---

# PR 2 — The carried set, de-hardcoded

Closes the child *carry the gate mechanism*. Moves the gate scripts, gate workflows and their tests
into `carried/`, removes every repository-specific value from them, and adds the test that keeps
them byte-identical forever.

### Task 4: The carried tree and its MANIFEST

**Files:**
- Create: `carried/**` (copied from `llm-code-execution`)
- Create: `MANIFEST`

- [ ] **Step 1: Copy the carried files in, unmodified**

Copied verbatim first, de-hardcoded in Tasks 5–7. Two commits, so the review can see which lines are
a move and which are a change.

```bash
SRC=~/Workspaces/Claude/llm-code-execution
mkdir -p carried/.claude carried/.github/workflows carried/scripts/tests carried/docs templates
cp -R "$SRC/.claude/skills" carried/.claude/skills
cp "$SRC/.github/workflows/pr-shape.yml" "$SRC/.github/workflows/sdlc-docs.yml" \
   "$SRC/.github/workflows/dependabot-auto-merge.yml" carried/.github/workflows/
cp "$SRC/scripts/check-pr-shape.sh" "$SRC/scripts/check-sdlc-sync.sh" carried/scripts/
cp "$SRC/scripts/tests/check-pr-shape.test.sh" "$SRC/scripts/tests/check-sdlc-sync.test.sh" \
   "$SRC/scripts/tests/dependabot-auto-merge-disarm.test.sh" carried/scripts/tests/
```

- [ ] **Step 2: Split `docs/sdlc.md` and carry the invariant half (D7)**

Lines 405–523 of the source are the per-user rate-limiting worked example — wholly that
application. The remainder is process and mechanism.

```bash
sed -n '1,404p;524,$p' "$SRC/docs/sdlc.md" > carried/docs/sdlc.md
sed -n '405,523p'      "$SRC/docs/sdlc.md" > templates/sdlc-example.md.tmpl
```

The split orphans one cross-reference: line 114 of the source is
`[worked example](#worked-example-adding-per-user-rate-limiting)`, and that heading has just left
the file. Repoint it at the generated document:

```bash
sed -i '' 's|(#worked-example-adding-per-user-rate-limiting)|(sdlc-example.md)|' carried/docs/sdlc.md
grep -c 'rate limiting'  carried/docs/sdlc.md
grep -c 'rate-limiting'  carried/docs/sdlc.md
```

Expected: `0` from **both** — the hyphenated form is the one the anchor used, so checking only the
spaced form would miss exactly the reference this step exists to fix. If either is non-zero the
split boundary is wrong — re-read the headings with
`grep -n '^#\{1,3\} ' carried/docs/sdlc.md` and adjust before continuing.

- [ ] **Step 3: Replace the extracted example with a generic one**

The 119 lines just extracted are this application's Express/Postgres/Auth0 rate-limiting story. As a
*template* they would be copied verbatim into every new repository, and because the result is a
generated file, `pull` never corrects it and `propose` refuses it — so the wrong example would be
permanent in every consumer.

Keep the extracted text in the toolkit as reference, and write `templates/sdlc-example.md.tmpl`
fresh: roughly thirty lines walking one imaginary feature through the same seven phases, with the
epic body, one child issue, and the PR that closes it. It exists to show the **shape** of the
artefacts — what an epic contains versus what a plan contains — which is exactly the part that
transfers and the part a reader cannot infer from the process document alone.

```bash
mv templates/sdlc-example.md.tmpl reference/sdlc-example-rate-limiting.md
```

- [ ] **Step 4: Evict the lodgers from `sdlc-docs.yml`**

The carried copy runs four self-tests, and two of them — `deploy-cloud-run.test.sh` (line 62) and
`verify-deployment.test.sh` (line 64) — belong to the deployment layer the spec puts explicitly out
of scope. Neither is carried, so **every consumer's `SDLC docs` check would fail on a missing file,
forever**, blocking R1 outright.

They are lodgers: they run here because this workflow was a convenient host, not because they
belong to this gate. Delete both steps from the carried copy. Finding them a new home in
`llm-code-execution` is adoption's problem, and is noted in the adoption plan's inputs.

```bash
sed -i '' '/deploy-cloud-run.test.sh/,-1d;/verify-deployment.test.sh/,-1d' carried/.github/workflows/sdlc-docs.yml
grep -c 'deploy-cloud-run\|verify-deployment' carried/.github/workflows/sdlc-docs.yml
```

Expected: `0`. Read the file afterwards — `sed` with a relative range is doing real work here, and
a mis-deleted `- name:` line leaves a syntactically valid workflow that runs the wrong step.

- [ ] **Step 5: Write the MANIFEST**

```bash
( cd carried && find . -type f | sed 's|^\./||' | sort ) > MANIFEST
wc -l MANIFEST
```

Expected: **23** lines — 14 under `.claude/skills/` (9 `SKILL.md`, 3 references,
`planning-reviewer-prompt.md`, `NOTICE.md`), 3 workflows, 2 gate scripts, 3 gate tests, and
`docs/sdlc.md`.
`MANIFEST` is generated here and hand-maintained thereafter; Task 8 fails if the two ever disagree,
so it cannot silently drift.

- [ ] **Step 6: Commit the move on its own**

```bash
git add carried MANIFEST templates/sdlc-example.md.tmpl
git commit -m "chore(carried): move the gate mechanism and skills in, unmodified"
```

- [ ] **Step 7: Extend `verify.sh` to cover the carried tree**

`carried/` did not exist in PR 1, and an unmatched glob stays literal in bash — so both lines had
to wait until now. The carried suites running in `acb`'s own CI is SC9, not a nicety: they are the
only thing standing between a de-hardcoding mistake and every consumer inheriting it.

```bash
# lint()
run shellcheck -x bin/acb lib/*.sh tests/*.test.sh carried/scripts/*.sh carried/scripts/tests/*.test.sh
# selftest()
for t in tests/*.test.sh carried/scripts/tests/*.test.sh; do
```

```bash
./verify.sh && git add verify.sh && git commit -m "chore(ci): lint and run the carried suites"
```

### Task 5: De-hardcode `check-sdlc-sync.sh`

**Files:**
- Modify: `carried/scripts/check-sdlc-sync.sh:23-24`
- Modify: `carried/scripts/tests/check-sdlc-sync.test.sh`

- [ ] **Step 1: Neutralise the actor fixtures, then extend the test**

Lines 71, 77 and 81 use `"igor-ka"` as the non-Dependabot `PR_ACTOR`. Replace all three with
`"a-human"` — the fixture only needs an actor that is not `dependabot[bot]`.

Then add, after the existing `asserts` definition:

```bash
# The two knobs now come from .acb.json, so a consumer with a different doc path or a different
# watched set gets different behaviour from the identical script. That indirection is the whole
# point of the carried bucket, and it is worth a test that the script reads the file rather than
# falling back to a compiled-in default nobody notices.
CFGDIR="$(mktemp -d)"; trap 'rm -rf "$CFGDIR"' EXIT
cat > "$CFGDIR/.acb.json" <<'JSON'
{"template":{"repo":"x/y","commit":"z"},
 "process":{"doc":"docs/process.md","watched":["^lib/"],"sdlcSyncHatch":"[no-sync]"},
 "components":[]}
JSON

out="$(ACB_CONFIG="$CFGDIR/.acb.json" PR_TITLE="tidy [no-sync]" "$SCRIPT" 2>&1)"; got=$?
if [[ "$got" -eq 0 && "$out" == *"[no-sync]"* ]]; then ok "hatch is read from config"
else bad "hatch is read from config" "expected exit 0 naming [no-sync], got ${got}: ${out}"; fi

out="$(ACB_CONFIG="$CFGDIR/nonexistent.json" PR_TITLE="x" "$SCRIPT" 2>&1)"; got=$?
if [[ "$got" -eq 1 && "$out" == *"no "* ]]; then ok "a missing config is a hard failure"
else bad "a missing config is a hard failure" "expected exit 1, got ${got}: ${out}"; fi
```

The second case matters more than it looks: a gate that silently falls back to a default when its
config is absent is a gate that passes for the wrong reason.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd carried && ./scripts/tests/check-sdlc-sync.test.sh; cd ..
```

Expected: FAIL — the hatch case reports the compiled-in `[skip-sdlc-sync]` still in force.

- [ ] **Step 3: Replace the two constants with configuration reads**

In `carried/scripts/check-sdlc-sync.sh`, replace lines 23–24 with:

```bash
# The three values that vary between repositories. Read from .acb.json at run time rather than
# substituted at render time: this file must stay byte-identical across every consumer, which is
# what makes `acb pull` a copy and `git diff` the review (spec D2).
ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
if [[ ! -f "$ACB_CONFIG" ]]; then
  echo "✗ no $ACB_CONFIG — this check needs one. Run 'acb init' or add it." >&2
  exit 1
fi
DOC="$(jq -r '.process.doc' "$ACB_CONFIG")"
# Alternation, not a list: the script greps once and an alternation is the cheapest way to say
# "any of these" to grep -E.
WATCHED_RE="$(jq -r '[.process.watched[]] | join("|")' "$ACB_CONFIG")"
HATCH="$(jq -r '.process.sdlcSyncHatch // "[skip-sdlc-sync]"' "$ACB_CONFIG")"
```

Then change the hatch test on line 26 from the literal to the variable:

```bash
if [[ "${PR_TITLE:-}" == *"$HATCH"* ]]; then
  echo "==> $HATCH found in the PR title — skipping the ${DOC} check."
  exit 0
fi
```

- [ ] **Step 4: Repair the two things this breaks in the existing suite**

The rewrite invalidates parts of the suite that shipped with the script, and both failures are
silent-passing rather than loud, which is why they are called out here.

**(a) The `WATCHED_RE` extraction.** Line 101 reads the pattern back out of the script with
`sed -n "s/^WATCHED_RE='\(.*\)'$/\1/p"`. That assignment is now a `jq` call, so the extraction
yields an empty string — and an empty pattern matches *everything*, which inverts all three
`unwatched` cases into false passes. Replace the extraction with a read of the fixture config, so
the table tests what the script will actually use:

```bash
WATCHED_RE="$(jq -r '[.process.watched[]] | join("|")' "$CFGDIR/.acb.json")"
```

**(b) The six pre-existing cases run with no `ACB_CONFIG`.** Step 3's hard failure fires before the
hatch and actor branches, so every one of them now exits 1. Export `ACB_CONFIG="$CFGDIR/.acb.json"`
once, above the first `asserts` call, and move the `CFGDIR` fixture from Step 1 up with it.

The `watched`/`unwatched` table itself stays, but its meaning shifts: it no longer pins *this
repository's* path list, it asserts that the alternation `jq` builds from `.process.watched`
behaves. That is the right test to carry, because the path list is now the consumer's.

- [ ] **Step 5: Run the tests**

```bash
cd carried && ./scripts/tests/check-sdlc-sync.test.sh; cd ..
```

Expected: all cases pass, including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add carried/scripts/check-sdlc-sync.sh carried/scripts/tests/check-sdlc-sync.test.sh
git commit -m "refactor(carried): read the sdlc-sync knobs from .acb.json"
```

### Task 6: De-hardcode `check-pr-shape.sh`

**Files:**
- Modify: `carried/scripts/check-pr-shape.sh:18,20`
- Modify: `carried/scripts/tests/check-pr-shape.test.sh` (5 fixture occurrences)

- [ ] **Step 1: Replace the repository default and the hatch**

Line 18 currently supplies `igor-ka/llm-code-execution` as a default. A default is worse than an
error here: it silently qualifies bare `#N` references against the wrong repository, and every
assertion still passes.

```bash
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set — GitHub Actions sets it; set it by hand to run this locally}"
ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
HATCH="$(jq -r '.process.prShapeHatch // "[multi-child]"' "$ACB_CONFIG" 2>/dev/null || echo '[multi-child]')"
```

The `|| echo` fallback is deliberate here and absent in Task 5, and the difference is the point:
this hatch only widens what is allowed, so a missing config degrades to the stricter default. The
watched-path list in Task 5 *decides what is checked at all*, so a missing config there must fail.

- [ ] **Step 2: Parameterise the five test fixtures**

In `carried/scripts/tests/check-pr-shape.test.sh` there are **six** occurrences, not five: line 130
carries a mixed-case one, `Igor-Ka/LLM-Code-Execution#64`, which exists precisely to prove the
script's matching is case-insensitive. Replace the five literal `igor-ka/llm-code-execution` with
`$REPO`, replace line 130's with `Example/Repo#64`, and add near the top:

```bash
# Any owner/name will do — the fixture only needs the script and the assertions to agree.
REPO="example/repo"
export GITHUB_REPOSITORY="$REPO"
```

- [ ] **Step 3: Run the tests**

```bash
cd carried && ./scripts/tests/check-pr-shape.test.sh; cd ..
```

Expected: all pass, with no occurrence of `llm-code-execution` remaining in either file.

- [ ] **Step 4: Commit**

```bash
git add carried/scripts/check-pr-shape.sh carried/scripts/tests/check-pr-shape.test.sh
git commit -m "refactor(carried): require GITHUB_REPOSITORY, read the hatch from config"
```

### Task 7: De-hardcode the auto-merge allow-list

**Files:**
- Modify: `carried/.github/workflows/dependabot-auto-merge.yml:66-68`

This is the subtlest change in the plan. Read the design note before editing.

**Two constraints, and the allow-list has to satisfy both.**

*Reject before third-party code runs.* The list sits in a job-level `if:` today so that it
evaluates before any step does — on `pull_request` the workflow is read from the merge ref, so a
`dependabot/github_actions/…` PR bumping this file's own `fetch-metadata` pin would otherwise
execute the **replacement** action and only then reach a rule rejecting it. The `if:` is the
mechanism; *before third-party code* is the requirement.

*There is no working tree.* `dependabot-auto-merge.yml:16-20` documents why there is no
`actions/checkout` step anywhere in the file: the `apply` job holds the only writable
`GITHUB_TOKEN` in the repository, and checking out the head ref would put PR-branch code inside
it. **This is why the list cannot come from `.acb.json` at all** — a `jq` against a runner with no
working tree fails on every run, sets the verdict to skip, and leaves auto-merge silently dead in
every consumer. Fail-closed, invisible, and undetectable by a suite that parses YAML.

So the list travels as a **repository variable**, `vars.ACB_DEPENDABOT_ECOSYSTEMS`, handed to the
step through `env:` — which needs no checkout and no file. `acb init` sets it with `gh variable
set`; `acb status` reconciles it against `.acb.json` so the two cannot drift apart unnoticed. The
generic `dependabot/` prefix, the actor and the fork guard stay in the `if:`, because none of them
needs anything the runner does not already have.

- [ ] **Step 1: Replace the job-level condition**

```yaml
    if: >-
      github.event.pull_request.user.login == 'dependabot[bot]' &&
      github.event.repository.fork == false &&
      startsWith(github.head_ref, 'dependabot/')
```

`github.event.repository.fork == false` replaces the hardcoded repository comparison and expresses
what that line was actually for: do not run in someone's fork.

- [ ] **Step 2: Add the allow-list step before `Fetch Dependabot metadata`**

```yaml
      - name: Check the ecosystem is allowed to auto-merge
        id: ecosystem
        env:
          HEAD_REF: ${{ github.head_ref }}
          # A repository variable, not a file: this job has no checkout by design, and must not
          # acquire one. Set by `acb init`, reconciled by `acb status`.
          ALLOWED: ${{ vars.ACB_DEPENDABOT_ECOSYSTEMS }}
        run: |
          set -euo pipefail
          # Runs BEFORE dependabot/fetch-metadata, which is the requirement the job-level `if:`
          # used to carry. Dependabot always names branches `dependabot/<ecosystem>/…`.
          eco="$(cut -d/ -f2 <<<"$HEAD_REF")"
          # An unset variable means no ecosystem is allowed. That is the correct default for a
          # repository that has not decided, and it is why the empty case is not special-cased.
          case " ${ALLOWED:-} " in
            *" $eco "*) echo "verdict=allowed" >> "$GITHUB_OUTPUT" ;;
            *) echo "==> '$eco' is not in ACB_DEPENDABOT_ECOSYSTEMS — not auto-merging."
               echo "verdict=skip" >> "$GITHUB_OUTPUT" ;;
          esac
```

- [ ] **Step 3: Gate every subsequent step in the job**

Add to `Fetch Dependabot metadata` and each step after it:

```yaml
        if: steps.ecosystem.outputs.verdict == 'allowed'
```

- [ ] **Step 4: Point Rule 2 at the same variable**

Line 127 carries a second hardcoded test — `any(.[]; .packageEcosystem != "npm_and_yarn")` —
described in-file as "the ecosystem allow-list again, as defence in depth". Left alone, a consumer
declaring `gradle` clears the new step and is rejected here with a message about npm. Defence in
depth is worth keeping; a second *source of truth* is not. Pass `ALLOWED` into the gate step's
`env:` and rewrite the rule as:

```jq
              elif any(.[]; (env.ALLOWED // "") | split(" ") | index($item.packageEcosystem) | not)
```

- [ ] **Step 5: Neutralise the disarm fixtures, then run the suite**

Six occurrences in `carried/scripts/tests/dependabot-auto-merge-disarm.test.sh`: `"login":"igor-ka"`
at lines 74, 83, 84 becomes `"login":"a-human"`, and `APP_SLUG=llm-code-execution-automerge` /
`app/llm-code-execution-automerge` at lines 119, 121, 124 become `example-automerge` /
`app/example-automerge`.

`carried/scripts/tests/dependabot-auto-merge-disarm.test.sh` asserts the workflow cannot auto-merge
what it should not. It parses the YAML, so it must be updated to look for the step rather than the
`if:` — extend it with a case asserting that the `ecosystem` step appears **before** the
`fetch-metadata` step in the step list, which is the property the whole task turns on.

```bash
cd carried && ./scripts/tests/dependabot-auto-merge-disarm.test.sh; cd ..
```

Expected: all pass, including the new ordering assertion.

- [ ] **Step 5: Commit**

```bash
git add carried/.github/workflows/dependabot-auto-merge.yml \
        carried/scripts/tests/dependabot-auto-merge-disarm.test.sh
git commit -m "refactor(carried): ecosystem allow-list from config, checked before third-party code"
```

### Task 8: The carried-purity test

**Files:**
- Create: `tests/carried-purity.test.sh`

This is the test that makes SC1 reachable. Without it, byte-identity is a discipline; with it, it is
a check.

- [ ] **Step 1: Write the test**

```bash
#!/usr/bin/env bash
# Carried files must be byte-identical in every consumer. Three ways that breaks, one case each.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s\n%s\n' "$1" "$(sed 's/^/      /' <<<"$2")"; }

# 1. No repository, owner, or project identifier may appear in a carried file.
# -i, because the fixtures deliberately include a mixed-case spelling to prove the matching is
# case-insensitive — and a case-sensitive purity check would sail straight past it.
hits="$(grep -rInEi 'igor-ka|llm-code-execution|llm-sandbox' carried/ || true)"
[[ -z "$hits" ]] && ok "no repository identifiers in carried/" \
                 || bad "no repository identifiers in carried/" "$hits"

# 2. No render-time marker may appear. A carried file with a marker in it is a template that
#    escaped into the wrong bucket, and `acb pull` would overwrite a consumer's substituted
#    value with the marker itself.
hits="$(grep -rIn '@@[A-Z_]\+@@' carried/ || true)"
[[ -z "$hits" ]] && ok "no @@MARKER@@ substitutions in carried/" \
                 || bad "no @@MARKER@@ substitutions in carried/" "$hits"

# 3. MANIFEST and the tree must agree in both directions. A file in carried/ but not in MANIFEST
#    is never copied to a consumer and looks like it was; a MANIFEST line with no file makes
#    `acb pull` fail halfway, having already written some of the set.
actual="$( ( cd carried && find . -type f | sed 's|^\./||' ) | sort )"
listed="$(sort MANIFEST)"
diffout="$(diff <(printf '%s\n' "$listed") <(printf '%s\n' "$actual") || true)"
[[ -z "$diffout" ]] && ok "MANIFEST matches carried/" || bad "MANIFEST matches carried/" "$diffout"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it and expect one real failure**

```bash
chmod +x tests/carried-purity.test.sh && ./tests/carried-purity.test.sh
```

Expected: all three cases pass. The skills carry **no** repository identifier — the coupling
Task 9 and Task 10 remove is to *npm and Postgres*, not to this repository — and Tasks 5–7 already
cleared the fixtures in the three carried test files. There is no temporary exclusion and no
expected-red state: a suite that is supposed to be red is a suite nobody reads.

- [ ] **Step 3: Run the full verification and commit**

```bash
./verify.sh
git add tests/carried-purity.test.sh
git commit -m "test(carried): byte-identity, marker and MANIFEST checks"
git push -u origin HEAD
gh pr create --title "feat: carry the gate mechanism, de-hardcoded" \
  --body "Closes igor-ka/llm-code-execution#<child>"
```

---

# PR 3 — Generalise the carried skills

Closes the child *generalise the skills*. The spec's Context 1 counts 75 references that tie the
skills to this stack and this application. This PR removes them and adds the lint that keeps them
out.

### Task 9: Rewrite the 53 stack-specific command references

**Files:**
- Modify: `carried/.claude/skills/**` (9 files)

- [ ] **Step 1: List exactly what has to change**

```bash
grep -rnoE 'npm (run |ci|test|audit)[a-z:_-]*|vitest|eslint|prettier|tsc |package\.json|package-lock' \
  carried/.claude/skills/ | sort -t: -k1,1 -k2,2n
```

Expected: 53 lines. Keep this output — Step 3 checks the count against it.

- [ ] **Step 2: Apply the substitution table**

Every one of these is the same edit: name the contract, not the tool. This is what lets one
`test-driven-development` skill serve a Swift project and a Terraform one.

| Found | Becomes |
| --- | --- |
| `npm test` | `./verify.sh test` |
| `npm run test:integration` | `./verify.sh test:integration` |
| `npm audit` | `./verify.sh audit` |
| `npm run lint` | `./verify.sh lint` |
| `npm run build` | `./verify.sh build` |
| `npm ci` | `./verify.sh install` |
| `npm run dev` | the component's documented dev command (see Step 4) |
| `vitest` | "the test runner" |
| `eslint` / `prettier` / `tsc` | "the linter" / "the formatter" / "the type checker" |
| `package.json` / `package-lock` | "the manifest" / "the lockfile" |

- [ ] **Step 3: Verify the count reached zero**

```bash
grep -rcoE 'npm (run |ci|test|audit)|vitest|eslint|prettier|tsc |package\.json|package-lock' \
  carried/.claude/skills/ | grep -v ':0$' || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Handle `npm run dev`, which has no canonical target**

Five occurrences, and `dev` is deliberately **not** in the vocabulary (D5): a long-running dev
server is not a verification step, and adding it would put a target in `verify.sh` that CI must
never call. Replace each with "the component's dev command, documented in `CLAUDE.md`" — the
generated `CLAUDE.md` is where a consumer records it.

- [ ] **Step 5: Commit**

```bash
git add carried/.claude/skills
git commit -m "refactor(skills): reference verify.sh targets, not npm and vitest"
```

### Task 10: Neutralise the 16 incidental app nouns

**Files:**
- Modify: `carried/.claude/skills/test-driven-development/SKILL.md:49,54,58,59`
- Modify: `carried/.claude/skills/references/definition-of-done.md:38,90`
- Modify: 4 further skill files for the incidental nouns below

- [ ] **Step 1: Apply the judgment rule, not a blanket substitution**

The spec's Residual risk names the hazard: `security-checklist.md` is persuasive partly *because* it
names Postgres and a verified `sub` rather than "your datastore" and "the user identifier".
Replacing concreteness with placeholders is how a good prompt becomes a vague one, and prompts are
behaviour here.

**Neutralise** where the noun is incidental — a path in an example, a technology named only to have
something to name:

| Found | Becomes |
| --- | --- |
| `backend/src/auth.ts` | `the module that verifies tokens` |
| `backend/src/history/` | `the per-user data layer` |
| `backend/src/sandbox/` | `the untrusted-execution layer` |
| `frontend/src/` | `the client` |
| `HistoryStore` / `SandboxBackend` | `the storage seam` / `the execution seam` |
| `Auth0` | `the identity provider` |
| `Cloud Run` | `the hosting platform` |
| `sandbox-image` | `the untrusted-execution image` |

**Keep and attribute** where the concreteness teaches. The six `Postgres` references are **not** in
`security-checklist.md` — four are in `test-driven-development/SKILL.md` and two in
`references/definition-of-done.md`, where they are a worked example of one datastore's failure
modes, and generalising them deletes the lesson. Add this note to **each of those two files**:

```markdown
> The examples below are drawn from a Postgres-backed service. The mechanism generalises; the
> specific field names do not. Read them as a worked case, not as a checklist to match literally.
```

- [ ] **Step 2: Check the count**

```bash
grep -rnoE 'backend/src|frontend/src|HistoryStore|SandboxBackend|Auth0|Cloud Run|Valkey|sandbox-image' \
  carried/.claude/skills/ | wc -l
```

Expected: `0`. That is 16 of the spec's 22; the other six are the `Postgres` mentions kept under
attribution by Step 1, which is why they are absent from this pattern and why Task 12's lint asserts
the attribution rather than the absence.

- [ ] **Step 3: Commit**

```bash
git add carried/.claude/skills
git commit -m "refactor(skills): neutralise incidental app nouns, attribute the worked examples"
```

### Task 11: Generalise the carried process document

**Files:**
- Modify: `carried/docs/sdlc.md`

Spec D12 requires the stack-specific tails to be generalised out of `docs/sdlc.md` during the split,
and Task 4 only split it. Left alone, every consumer receives a process document naming `npm`,
Docker, Cloud Run and `backend/` — and Task 12's lint is scoped to `carried/.claude/skills`, so it
would never see them.

- [ ] **Step 1: Count what is there**

```bash
grep -cE 'npm|Docker|Cloud Run|backend/|infra/|worktree-new\.sh|SKIP_DOCKER|Postgres|Auth0' \
  carried/docs/sdlc.md
```

Expected: roughly 44 across those patterns — `npm` ×8, `Docker` ×6, `Cloud Run` ×6, `backend/` ×7,
`infra/` ×5, `worktree-new.sh` ×3, and singles for the rest.

- [ ] **Step 2: Apply the same rule as Tasks 9 and 10**

Commands become `verify.sh` targets; component paths become roles. Three cases need more than a
substitution:

- **The "How this meets CI/CD" section** describes this repository's five jobs by name. Rewrite it
  to describe the *shape* — one job per component named by its `checkName`, plus the two process
  checks — and point at `.acb.json` as the source.
- **`SKIP_DOCKER` becomes `SKIP_PACKAGE`**, and every `verify.sh docker` becomes `verify.sh
  package`. This is where D5's renames actually land: the process document is what tells a reader
  the vocabulary exists.
- **The worktree section** keeps the rule and the rationale — both portable, and D12 says so — but
  drops the port table and the slot arithmetic, which are Tier C and belong to the consumer.

- [ ] **Step 3: Verify and commit**

```bash
grep -cE 'npm|Docker|Cloud Run|backend/|infra/|SKIP_DOCKER|Auth0' carried/docs/sdlc.md
git add carried/docs/sdlc.md
git commit -m "refactor(sdlc): generalise the carried process document"
```

Expected: `0`.

### Task 12: The portability lint

**Files:**
- Create: `tests/skills-portability.test.sh`
- Modify: `tests/carried-purity.test.sh` (remove the temporary exclusion)

- [ ] **Step 1: Write the lint**

```bash
#!/usr/bin/env bash
# A carried skill that names a package manager is broken for every project that does not use it.
# This is the check behind that sentence.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s\n%s\n' "$1" "$(sed 's/^/      /' <<<"$2")"; }

# Both trees: the process document is carried too, and a `docs/`-shaped hole in this lint is how
# Task 11's work silently regresses.
SKILLS="carried/.claude/skills carried/docs"

hits="$(grep -rInE 'npm |yarn |pnpm |vitest|jest|eslint|prettier|tsc |pytest|gradle|cargo ' "$SKILLS" || true)"
[[ -z "$hits" ]] && ok "no package manager or tool names" || bad "no package manager or tool names" "$hits"

hits="$(grep -rInE 'backend/src|frontend/src|HistoryStore|SandboxBackend|Auth0|Cloud Run|Valkey' "$SKILLS" || true)"
[[ -z "$hits" ]] && ok "no application nouns" || bad "no application nouns" "$hits"

# Postgres survives under attribution (Task 10). Assert the attribution is present rather than
# asserting the word is absent — the lesson is the point, the unlabelled example is the problem.
if grep -rqI 'Postgres' "$SKILLS"; then
  if grep -rqI 'drawn from a Postgres-backed service' "$SKILLS"; then
    ok "Postgres examples carry their attribution"
  else
    bad "Postgres examples carry their attribution" "Postgres appears with no 'drawn from' note"
  fi
else
  ok "Postgres examples carry their attribution (none present)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run everything and commit**

```bash
chmod +x tests/skills-portability.test.sh && ./verify.sh
git add tests/skills-portability.test.sh
git commit -m "test(skills): lint carried skills for stack and app coupling"
git push -u origin HEAD
gh pr create --title "refactor: generalise the carried skills" \
  --body "Closes igor-ka/llm-code-execution#<child>"
```

---

# PR 4 — The generated layer, `acb init`, and the ruleset

Closes the child *generate and initialise*. After this PR, R1 is satisfied end to end: one command
produces a repository whose gates run and are enforced.

### Task 13: Templates and the renderer

**Files:**
- Create: `templates/ci.yml.head`, `templates/ci.yml.component`
- Create: `lib/render.sh` (replacing the PR 1 stub)
- Create: `tests/render.test.sh`

- [ ] **Step 1: Write the two CI templates**

`templates/ci.yml.head`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

# Job `name:` values are a contract: the branch ruleset requires these exact check names, so
# renaming one blocks merges until the ruleset is updated to match. They are generated from
# .acb.json's `checkName`, never from the directory name — the two already disagree in at least
# one real repository.
jobs:
```

`templates/ci.yml.component`:

```yaml
  @@ID@@:
    name: @@CHECK_NAME@@
    runs-on: @@RUNNER@@
    defaults:
      run:
        working-directory: @@ID@@
    steps:
      - uses: actions/checkout@v7
```

- [ ] **Step 2: Write the failing render test**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
export ACB_ROOT="$PWD"
# shellcheck source=lib/config.sh
source lib/config.sh
source lib/render.sh

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/.acb.json" <<'JSON'
{"template":{"repo":"igor-ka/acb","commit":"abc"},
 "process":{"doc":"docs/sdlc.md","watched":["^scripts/"],
            "prShapeHatch":"[multi-child]","sdlcSyncHatch":"[skip-sdlc-sync]",
            "dependabotEcosystems":["npm_and_yarn"]},
 "components":[{"id":"api","checkName":"API checks","runner":"ubuntu-latest",
                "targets":["lint","test"]},
               {"id":"app","checkName":"App checks","runner":"macos-14",
                "targets":["build"]}]}
JSON
export ACB_CONFIG="$TMP/.acb.json"

ci="$(acb_render_ci)"
grep -q 'name: API checks'  <<<"$ci" && ok "renders the first checkName"  || bad "renders the first checkName" "missing"
grep -q 'name: App checks'  <<<"$ci" && ok "renders the second checkName" || bad "renders the second checkName" "missing"
grep -q 'runs-on: macos-14' <<<"$ci" && ok "honours a per-component runner" || bad "honours a per-component runner" "missing"
grep -q 'run: ./verify.sh test' <<<"$ci" && ok "renders a step per target" || bad "renders a step per target" "missing"
grep -q '@@' <<<"$ci" && bad "leaves no unreplaced marker" "found @@" || ok "leaves no unreplaced marker"

# Zero components is a supported repository shape (D13). The right output is NO output: a `jobs:`
# key with nothing under it is a file GitHub rejects, and asserting it renders would lock that in.
jq -c '.components=[]' "$TMP/.acb.json" > "$TMP/empty.json"
empty="$(ACB_CONFIG="$TMP/empty.json" acb_render_ci)"; rc=$?
[[ $rc -eq 1 && -z "$empty" ]] && ok "zero components writes no workflow" \
                              || bad "zero components writes no workflow" "exit $rc, output '$empty'"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 3: Run it to verify it fails**

```bash
chmod +x tests/render.test.sh && ./tests/render.test.sh
```

Expected: FAIL — `acb_render_ci: command not found`, because `lib/render.sh` is still PR 1's stub.

- [ ] **Step 4: Write `lib/render.sh`**

```bash
#!/usr/bin/env bash
# Generation, without a template engine (design note 1). Two mechanisms and no third:
# marker substitution with sed for static files, fragment assembly for repeated structure.
# GitHub Actions' own ${{ }} passes through untouched, which is exactly why the markers are @@.

# Returns 1 and writes nothing when there are no components. A workflow whose `jobs:` key is
# empty is not valid YAML-for-Actions and GitHub rejects the file outright, so for a repository
# with nothing to build the right artefact is no ci.yml at all — the process gates live in the
# carried workflows and do not need this one.
acb_render_ci() {
  local id t
  [[ -n "$(acb_components)" ]] || return 1
  cat "$ACB_ROOT/templates/ci.yml.head"
  for id in $(acb_components); do
    sed -e "s|@@ID@@|$id|g" \
        -e "s|@@CHECK_NAME@@|$(acb_check_name "$id")|g" \
        -e "s|@@RUNNER@@|$(acb_runner "$id")|g" \
        "$ACB_ROOT/templates/ci.yml.component"
    # Steps are assembled rather than templated: sed cannot loop, and a per-target step list is
    # the one place this file genuinely needs one.
    for t in $(acb_targets "$id"); do
      printf '      - name: %s\n        run: ./verify.sh %s\n' "$t" "$t"
    done
  done
}

acb_render_verify() {
  local id="$1" t targets
  targets="$(acb_targets "$id" | tr '\n' ' ')"
  cat <<EOF
#!/usr/bin/env bash
# The single entry point CI and a developer both run — same script, same targets, so the two
# cannot drift. Generated by 'acb init'; this file is yours to fill in and is never regenerated.
set -euo pipefail
cd "\$(dirname "\$0")"

TARGETS="${targets% }"

run() { echo "==> \$*"; "\$@"; }

not_implemented() {
  echo "✗ ./verify.sh \$1 is not implemented yet." >&2
  echo "  Fill in target_\$1 below. Until then this component's CI is red, which is correct:" >&2
  echo "  a check that passes without checking anything is worse than no check." >&2
  exit 2
}
EOF
  # One function per declared target. The target_ prefix is not decoration: 'test' is a shell
  # builtin, and a bare `test()` would shadow it for the whole script.
  # Multi-line bodies, not one-liners. The conformance check plants a `false` on the line after
  # the opening brace; against `target_lint() { not_implemented lint; }` that lands after the
  # closing brace, at top level, where `set -e` kills the script before dispatch and the check
  # passes no matter what the target does.
  for t in $targets; do
    printf 'target_%s() {\n  not_implemented %s\n}\n' "$t" "$t"
  done
  cat <<'EOF'

all() { local t; for t in $TARGETS; do "target_$t"; done; }

case "${1:-all}" in
  all) all ;;
  *)
    if [[ " $TARGETS " == *" ${1} "* ]]; then
      "target_${1}"
    else
      echo "unknown target '${1}'. Known: $TARGETS all" >&2
      exit 64
    fi
    ;;
esac
EOF
}
```

- [ ] **Step 5: Run the tests and commit**

```bash
./tests/render.test.sh && ./verify.sh lint
git add templates lib/render.sh tests/render.test.sh
git commit -m "feat(render): CI and verify.sh generation without a template engine"
```

### Task 14: The conformance test

**Files:**
- Create: `carried/scripts/check-conformance.sh`
- Create: `carried/scripts/tests/check-conformance.test.sh`
- Modify: `MANIFEST` (two new lines)

This is SC2, and the fourth assertion is the one that earns the task.

- [ ] **Step 1: Write the conformance script**

```bash
#!/usr/bin/env bash
# Proves the verify.sh contract holds for every declared component. It tests the script's
# PLUMBING, never its checks — which is what makes it stack-agnostic: dispatch, exit codes and
# error propagation are the same in a Swift repo and a Terraform one.
set -uo pipefail
cd "$(dirname "$0")/.."

ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

# One trap for the whole run: a `trap` inside the loop is replaced on every iteration, so all but
# the last patched copy would survive a failure.
trap 'rm -f ./*/.acb-conformance.sh' EXIT

for id in $(jq -r '.components[]?.id' "$ACB_CONFIG"); do
  v="$id/verify.sh"

  # 1. It exists and is executable.
  [[ -x "$v" ]] && ok "$id: verify.sh is executable" || { bad "$id: verify.sh is executable" "missing or not +x"; continue; }

  # 2. Every declared target dispatches. Exit 64 means "unknown target"; anything else — including
  #    2 for not-implemented and 1 for a genuine failure — means the target was found.
  for t in $(jq -r --arg i "$id" '.components[]|select(.id==$i)|.targets[]' "$ACB_CONFIG"); do
    ( cd "$id" && ./verify.sh "$t" >/dev/null 2>&1 ); rc=$?
    [[ $rc -ne 64 ]] && ok "$id: target '$t' dispatches" || bad "$id: target '$t' dispatches" "exit 64"
  done

  # 3. An undeclared target is rejected, and rejected distinguishably.
  ( cd "$id" && ./verify.sh __no_such_target__ >/dev/null 2>&1 ); rc=$?
  [[ $rc -eq 64 ]] && ok "$id: unknown target exits 64" || bad "$id: unknown target exits 64" "got $rc"

  # 4. A failure inside a target propagates. This is the assertion that catches `|| true` and the
  #    POSIX rule exempting a negated command from errexit — the decorative-assertion failure
  #    mode, which is how a green check comes to mean nothing. A copy is patched rather than the
  #    original, so this is read-only on the consumer's file.
  first="$(jq -r --arg i "$id" '.components[]|select(.id==$i)|.targets[0]' "$ACB_CONFIG")"
  # The patched copy lives INSIDE the component directory, not in /tmp. The script's own
  # `cd "$(dirname "$0")"` is what makes its relative paths work, so a copy in /tmp would run the
  # target against the wrong directory and prove nothing. The original is never written to.
  tmp="$id/.acb-conformance.sh"
  awk -v fn="target_${first}() {" '
    index($0, fn) == 1 { print; print "  false"; next } { print }' "$v" > "$tmp"
  chmod +x "$tmp"
  ( cd "$id" && "./$(basename "$tmp")" "$first" >/dev/null 2>&1 ); rc=$?
  rm -f "$tmp"
  [[ $rc -ne 0 ]] && ok "$id: a failure inside '$first' propagates" \
                 || bad "$id: a failure inside '$first' propagates" "exit 0 with a planted 'false'"
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run it in the consumer's CI**

Written, carried and never invoked is worth nothing — SC2 and SC10 both read as requiring the check
where the repository is checked out. Add it as a step to the carried `sdlc-docs.yml`, immediately
after its existing self-tests:

```yaml
      - name: Verify.sh contract
        run: ./scripts/check-conformance.sh
```

That workflow is chosen over `ci.yml` for two reasons: `SDLC docs` is already a required check, so
this adds no job name, no ruleset entry and nothing for `acb_check_drift` to reconcile; and the
conformance check is a property of the *process*, not of any one component, so a per-component job
would be the wrong shape.

- [ ] **Step 3: Write its test against a fixture, run both, update MANIFEST, commit**

The fixture is a two-component temp repo: one component whose `verify.sh` is the generated
skeleton, one whose first target contains `grep -q nothing file || true` — the decorative
assertion the fourth check exists to catch. Assert the first passes conformance and the second
fails it, naming the target.

```bash
chmod +x carried/scripts/check-conformance.sh
./carried/scripts/tests/check-conformance.test.sh
( cd carried && find . -type f | sed 's|^\./||' | sort ) > MANIFEST
./verify.sh
git add carried/scripts/check-conformance.sh carried/scripts/tests/check-conformance.test.sh MANIFEST
git commit -m "feat(conformance): prove the verify.sh contract, including failure propagation"
```

### Task 15: `acb init`

**Files:**
- Modify: `lib/render.sh` (add `acb_cmd_init`)
- Create: `templates/CLAUDE.md.tmpl`, `templates/dependabot.yml.head`, `templates/dependabot.yml.ecosystem`, `templates/ruleset.json.tmpl`

- [ ] **Step 1: Write the remaining templates**

`ruleset.json.tmpl` carries the required-check list as `@@REQUIRED_CHECKS@@`, a JSON array assembled
from every component's `checkName` plus the two process checks `SDLC docs` and `PR shape`. The rest
of its posture is a decision, not a detail, so it is written out rather than left to the
implementer — spec Residual risk flags this payload shape as the fragile part:

```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_reviewers": [],
        "allowed_merge_methods": ["squash", "rebase"]
      } },
    { "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": true
      } },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": @@REQUIRED_CHECKS@@
      } }
  ]
}
```

This is the live `Protect main` ruleset from `llm-code-execution`, read back with
`gh api repos/OWNER/REPO/rulesets/ID`, not written from memory. Reproducing a proven configuration
is the whole point of a baseline, and three of its six rules would have been missed by hand.

Four choices worth naming.

**`copilot_code_review` is a ruleset rule, and that is what makes it automatable.** Copilot review
is not a repository setting reached through a menu — it is expressed in the ruleset alongside the
status checks, so `acb init` enables it through the same `gh api` call and a new repository gets it
on the first pull request. This matters more than it looks: `CLAUDE.md` leans on Copilot as the
*enforced* half of its review gate, the two skill passes being procedure rather than enforcement. A
repository scaffolded without this rule would lose that gate silently, with nothing red to show for
it. `review_on_push: true` re-reviews each push rather than only the opening commit.

**No bypass actors** — an exception nobody can use is the only kind that cannot be used by accident.

**Zero required approvals, but thread resolution required.** These are single-maintainer
repositories, so an approval gate is self-approval theatre; unresolved review threads genuinely
block, which is what turns a Copilot comment into something that must be answered.
`require_extra_approval_for_unattributed_changes` covers commits pushed by an identity the merger
cannot vouch for.

**`strict_required_status_checks_policy: true`, and it is a real trade.** A branch must be current
with `main` before it merges, so every merge invalidates every other open pull request and costs
them a re-run. On a repository with one or two concurrent branches that is cheap and it closes the
semantic-conflict gap — two PRs that each pass alone and break together. On a busier repository,
flip it to `false`.
`CLAUDE.md.tmpl` carries `@@COMPONENT_TABLE@@` and a "dev command" line per component — the place
Task 9 Step 4 sends the reader.

- [ ] **Step 2: Write the four remaining render functions**

`acb_cmd_init` calls these; none may be left to the implementer to invent.

```bash
# The declaration a fresh repository starts from. Deliberately one component, deliberately named
# after the directory — an empty `components` array is valid (D13) but a first-time user staring
# at `[]` has nothing to copy.
acb_scaffold_config() {
  cat > .acb.json <<'JSON'
{
  "template": { "repo": "igor-ka/acb", "commit": "" },
  "process": {
    "doc": "docs/sdlc.md",
    "watched": ["^\\.claude/skills/", "^\\.github/workflows/", "^scripts/"],
    "prShapeHatch": "[multi-child]",
    "sdlcSyncHatch": "[skip-sdlc-sync]",
    "dependabotEcosystems": []
  },
  "components": [
    { "id": "app", "checkName": "App checks", "runner": "ubuntu-latest",
      "targets": ["install", "lint", "format", "test", "build"] }
  ]
}
JSON
}

acb_render_dependabot() {
  local eco
  cat "$ACB_ROOT/templates/dependabot.yml.head"
  # No ecosystems declared means no updates configured, which is the right default for a repo
  # that has not thought about it — not a silent every-ecosystem opt-in.
  for eco in $(acb_process_arr dependabotEcosystems); do
    sed -e "s|@@ECOSYSTEM@@|$eco|g" "$ACB_ROOT/templates/dependabot.yml.ecosystem"
  done
}

acb_render_ruleset() {
  local checks id
  # The two process checks are always required; component checks come from checkName, never from
  # the directory name (SC10). This list and ci.yml's job names are generated from one source,
  # which is the only reason they can be trusted to agree.
  checks="$( { echo "SDLC docs"; echo "PR shape"
               for id in $(acb_components); do acb_check_name "$id"; done
             } | jq -R . | jq -sc 'map({context: .})' )"
  sed -e "s|@@REQUIRED_CHECKS@@|$checks|g" "$ACB_ROOT/templates/ruleset.json.tmpl"
}

acb_render_claude_md() {
  local rows id
  rows="$(for id in $(acb_components); do
            printf '| `%s` | `cd %s && ./verify.sh` | _document the dev command here_ |\n' "$id" "$id"
          done)"
  # awk, not sed: the replacement is multi-line and sed's `s` command cannot carry newlines
  # portably between GNU and BSD.
  awk -v rows="$rows" '{ gsub(/@@COMPONENT_TABLE@@/, rows); print }' \
      "$ACB_ROOT/templates/CLAUDE.md.tmpl"
}
```

- [ ] **Step 3: Write `acb_cmd_init`**

```bash
acb_cmd_init() {
  local dir="${1:-}" repo="" id
  [[ -n "$dir" ]] || { echo "usage: acb init <dir> [--repo owner/name]" >&2; return 2; }
  [[ "${2:-}" == "--repo" ]] && repo="${3:-}"

  mkdir -p "$dir"; cd "$dir" || return 1
  [[ -d .git ]] || git init -q -b main

  # The declaration comes first: everything below is generated from it, so an invalid one must
  # stop the run before any file is written.
  [[ -f .acb.json ]] || acb_scaffold_config
  ACB_CONFIG=".acb.json" acb_config_validate || return 1

  # Carried files: copied, never rendered. MANIFEST is the single answer to "is this carried?".
  local p
  while read -r p; do
    # Auto-merge is opt-in. It needs a per-repository GitHub App — AUTOMERGE_APP_CLIENT_ID,
    # AUTOMERGE_APP_PRIVATE_KEY, AUTOMERGE_APP_SLUG — which a fresh repository does not have, so
    # carrying it unconditionally ships a workflow that fails at "Mint a GitHub App installation
    # token" on every dependency bump. Declaring an ecosystem is the opt-in.
    if [[ "$p" == *dependabot-auto-merge.yml ]] && [[ -z "$(acb_process_arr dependabotEcosystems)" ]]; then
      continue
    fi
    mkdir -p "$(dirname "$p")"
    cp "$ACB_ROOT/carried/$p" "$p"
  done < "$ACB_ROOT/MANIFEST"

  # The allow-list travels as a repository variable, not a file (Task 7).
  local ecos; ecos="$(acb_process_arr dependabotEcosystems | tr '\n' ' ')"
  if [[ -n "${ecos// }" ]] && [[ -n "$repo" ]]; then
    gh variable set ACB_DEPENDABOT_ECOSYSTEMS --repo "$repo" --body "${ecos% }"
    echo "==> auto-merge needs a GitHub App. See 'Auto-merge setup' in the generated CLAUDE.md."
  fi

  mkdir -p .github/workflows docs
  acb_render_ci > .github/workflows/ci.yml || rm -f .github/workflows/ci.yml
  acb_render_dependabot > .github/dependabot.yml
  acb_render_ruleset > .github/ruleset.json
  acb_render_claude_md > CLAUDE.md
  cp "$ACB_ROOT/templates/sdlc-example.md.tmpl" docs/sdlc-example.md
  for id in $(acb_components); do
    mkdir -p "$id"
    acb_render_verify "$id" > "$id/verify.sh"
    chmod +x "$id/verify.sh"
  done

  # Record the template commit LAST, so a run that died halfway leaves a repo that `acb status`
  # reports as uninitialised rather than as up to date.
  local commit; commit="$(git -C "$ACB_ROOT" rev-parse HEAD)"
  local tmp; tmp="$(mktemp)"
  jq --arg c "$commit" '.template.commit = $c' .acb.json > "$tmp" && mv "$tmp" .acb.json

  if [[ -n "$repo" ]]; then
    gh repo view "$repo" >/dev/null 2>&1 || gh repo create "$repo" --private --source=. --remote=origin
    echo "==> next: git add -A && git commit && git push, then ./scripts/apply-ruleset.sh"
  fi
  echo "✓ initialised $dir at template commit ${commit:0:8}"
  echo "  CI is red until you fill in each component's verify.sh. That is correct."
}
```

- [ ] **Step 4: Initialise a throwaway repository end to end**

```bash
./bin/acb init /tmp/acb-smoke && ( cd /tmp/acb-smoke && ./scripts/check-conformance.sh )
```

Expected: `✓ initialised`, then conformance green — every target dispatches, unknown targets exit
64, and the planted failure propagates. The component's own CI would be red, which is SC4.

- [ ] **Step 5: Commit**

```bash
git add lib/render.sh templates
git commit -m "feat(init): scaffold a repository from the declaration"
```

### Task 16: `apply-ruleset.sh`

**Files:**
- Create: `templates/apply-ruleset.sh.tmpl` (generated into each consumer as `scripts/apply-ruleset.sh`)
- Modify: `lib/render.sh` (`acb_cmd_init` copies it)

Task 15 deliberately leaves `apply-ruleset.sh` out of `acb_cmd_init`, because `bin/acb` has no
`set -e`: a `cp` of a template that does not exist yet fails silently and `init` still prints
`✓ initialised`. The template is written here, and only here is it wired in.

- [ ] **Step 1: Write it**

```bash
#!/usr/bin/env bash
# Branch protection is API state, not a file. Shipping the checks without the enforcement would
# contradict this process's own maxim — an instruction is a request, a check is a guarantee — at
# the moment of installation.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY=owner/name}"

gh api --method POST "repos/$GITHUB_REPOSITORY/rulesets" \
  --input .github/ruleset.json
echo "✓ ruleset applied. Verify: gh api repos/$GITHUB_REPOSITORY/rulesets"
```

- [ ] **Step 2: Wire it into `acb_cmd_init`**

Add after the `sdlc-example.md` copy:

```bash
  mkdir -p scripts
  cp "$ACB_ROOT/templates/apply-ruleset.sh.tmpl" scripts/apply-ruleset.sh
  chmod +x scripts/apply-ruleset.sh
```

- [ ] **Step 3: Initialise a repository that actually exists, then apply the ruleset (SC5)**

Task 15's smoke run used no `--repo`, so there is no remote to protect. A ruleset needs one.

```bash
rm -rf /tmp/acb-smoke
./bin/acb init /tmp/acb-smoke --repo igor-ka/acb-smoke
cd /tmp/acb-smoke && git add -A && git commit -qm "chore: initial scaffold" && git push -u origin main
GITHUB_REPOSITORY=igor-ka/acb-smoke ./scripts/apply-ruleset.sh
```

Then open a pull request whose body names two issues and confirm the **merge button is disabled** —
not merely that the check is red. The ruleset is the thing under test, not the workflow.

- [ ] **Step 4: Delete the throwaway repo and commit**

`gh repo delete` needs the `delete_repo` scope, which `gh auth login` does not grant by default.

```bash
gh auth refresh -s delete_repo
gh repo delete igor-ka/acb-smoke --yes
cd - && git add templates/apply-ruleset.sh.tmpl lib/render.sh
git commit -m "feat(ruleset): apply required checks from the generated document"
git push -u origin HEAD
gh pr create --title "feat: generated layer, acb init, and the ruleset" \
  --body "Closes igor-ka/llm-code-execution#<child>"
```

---

# PR 5 — `acb status`, `pull`, and `propose`

Closes the child *bidirectional sync*. This is R2, and SC3 is the acceptance test.

### Task 17: `acb status`

**Files:**
- Modify: `lib/sync.sh` (replacing the PR 1 stub)
- Create: `tests/sync.test.sh`

- [ ] **Step 1: Write the failing test**

**The suite must never touch the real toolkit checkout.** `ACB_ROOT` is what `pull` and `propose`
read *and write* — `propose` branches, commits and pushes — so every case sets `ACB_ROOT` to a
throwaway `git init` fixture holding a `carried/` tree and a `MANIFEST`, and puts a stub `gh` first
on `PATH` that records its arguments instead of calling GitHub. `scripts/tests/dependabot-auto-merge-disarm.test.sh`
is the existing example of that pattern.

Cases: reports *behind* when the toolkit has commits the repo lacks; reports *ahead* when a carried
file differs from the toolkit's copy; reports both independently; and fails when a job name in
`ci.yml` is absent from the ruleset's required checks (SC14 — the drift a hand-edited workflow
introduces).

- [ ] **Step 2: Write `acb_cmd_status`**

```bash
acb_cmd_status() {
  acb_config_validate || return 1
  local recorded head p behind=0 ahead=()
  recorded="$(acb_template commit)"
  head="$(git -C "$ACB_ROOT" rev-parse HEAD)"

  if [[ "$recorded" != "$head" ]]; then
    behind="$(git -C "$ACB_ROOT" rev-list --count "$recorded..$head" 2>/dev/null || echo '?')"
    echo "behind: $behind commit(s) — run 'acb pull'"
  else
    echo "behind: 0"
  fi

  # Ahead is per-file, not per-commit: the question a consumer asks is "what have I changed that
  # the toolkit does not have", and the answer is the argument list `acb propose` takes.
  while read -r p; do
    [[ -f "$p" ]] || continue
    cmp -s "$p" "$ACB_ROOT/carried/$p" || ahead+=("$p")
  done < "$ACB_ROOT/MANIFEST"
  if ((${#ahead[@]})); then
    echo "ahead: ${#ahead[@]} carried file(s) differ — 'acb propose <path>' to send upstream"
    printf '  %s\n' "${ahead[@]}"
  else
    echo "ahead: 0"
  fi

  acb_check_drift
}

# The ruleset and the workflow are generated from one declaration but owned by the consumer
# afterwards, so a hand-edit to either can leave a job nothing requires or a required check that
# no job produces. Both failures are silent at merge time, which is the wrong time.
acb_check_drift() {
  local jobs required missing
  # The two process checks come from the CARRIED workflows, not from ci.yml, so reading ci.yml
  # alone would report them missing on every single run and make status permanently red.
  # ci.yml is absent in a zero-component repository, and that is correct rather than an error.
  jobs="$( { [[ -f .github/workflows/ci.yml ]] &&
               grep -oE '^ {4}name: .*' .github/workflows/ci.yml | sed 's/.*name: //'
             echo "SDLC docs"; echo "PR shape"; } | LC_ALL=C sort -u )"
  required="$(jq -r '.rules[]?|select(.type=="required_status_checks")
                     |.parameters.required_status_checks[].context' .github/ruleset.json \
              | LC_ALL=C sort -u)"
  # LC_ALL=C on both: comm compares byte-wise, and these names contain spaces.
  missing="$(comm -3 <(printf '%s\n' "$jobs") <(printf '%s\n' "$required"))"
  if [[ -n "$missing" ]]; then
    echo "✗ drift between ci.yml job names and the ruleset's required checks:" >&2
    printf '%s\n' "$missing" | sed 's/^/    /' >&2
    return 1
  fi
  echo "drift: none"
}
```

- [ ] **Step 3: Run the tests and commit**

```bash
./tests/sync.test.sh && ./verify.sh
git add lib/sync.sh tests/sync.test.sh
git commit -m "feat(sync): status reports behind, ahead and ruleset drift"
```

### Task 18: `acb pull`

**Files:**
- Modify: `lib/sync.sh`

- [ ] **Step 1: Extend the test**

Cases: refuses a dirty working tree with exit 3; writes every MANIFEST path; never commits; updates
`.template.commit`; and — the important one — a second `pull` with no upstream change produces an
empty `git diff`. That last case is SC1 in miniature.

- [ ] **Step 2: Write it**

```bash
acb_cmd_pull() {
  acb_config_validate || return 1
  # Overwrite is correct for byte-identical files, which makes `git diff` the review and
  # `git checkout .` the undo — but only if the tree was clean first. Refusing here is what
  # turns "read the diff" from an instruction into a guarantee.
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "✗ working tree is not clean. Commit or stash first — pull overwrites carried files and" >&2
    echo "  a dirty tree makes the resulting diff unreadable, which is the only review there is." >&2
    return 3
  fi
  local p n=0
  while read -r p; do
    mkdir -p "$(dirname "$p")"
    cp "$ACB_ROOT/carried/$p" "$p"; n=$((n + 1))
  done < "$ACB_ROOT/MANIFEST"
  local commit tmp; commit="$(git -C "$ACB_ROOT" rev-parse HEAD)"; tmp="$(mktemp)"
  jq --arg c "$commit" '.template.commit = $c' .acb.json > "$tmp" && mv "$tmp" .acb.json
  echo "✓ pulled $n carried file(s) at ${commit:0:8}. Nothing committed — review with 'git diff'."
}
```

- [ ] **Step 3: Run the tests and commit**

```bash
./tests/sync.test.sh
git add lib/sync.sh tests/sync.test.sh
git commit -m "feat(sync): pull refuses a dirty tree and never commits"
```

### Task 19: `acb propose`

**Files:**
- Modify: `lib/sync.sh`

- [ ] **Step 1: Extend the test**

Cases: refuses a path absent from MANIFEST with exit 3 and a message naming the bucket; refuses a
path identical to the toolkit's copy (nothing to propose); and on a valid path, branches in the
toolkit clone, copies the file, and calls `gh pr create`.

- [ ] **Step 2: Write it**

```bash
acb_cmd_propose() {
  acb_config_validate || return 1
  [[ $# -gt 0 ]] || { echo "usage: acb propose <path>..." >&2; return 2; }
  local p
  for p in "$@"; do
    # Generated files are the consumer's, by construction. Sending one upstream is the failure
    # mode that makes a template unmaintainable, so it is prevented rather than discouraged.
    if ! grep -qxF "$p" "$ACB_ROOT/MANIFEST"; then
      echo "✗ '$p' is not a carried file — it is generated, and generated files belong to this" >&2
      echo "  repository alone. 'acb status' lists what can be proposed." >&2
      return 3
    fi
    cmp -s "$p" "$ACB_ROOT/carried/$p" && { echo "✗ '$p' is identical upstream — nothing to propose." >&2; return 3; }
  done

  # Restore the toolkit's branch afterwards. Leaving it on propose/… would make the very next
  # `acb status` or `pull` — in any consumer — compare against that branch instead of main.
  local orig branch
  orig="$(git -C "$ACB_ROOT" rev-parse --abbrev-ref HEAD)"
  branch="propose/$(date +%Y%m%d-%H%M%S)"
  git -C "$ACB_ROOT" checkout -q -b "$branch"
  for p in "$@"; do cp "$p" "$ACB_ROOT/carried/$p"; done
  git -C "$ACB_ROOT" add -A
  git -C "$ACB_ROOT" commit -qm "propose: $* from $(basename "$PWD")"
  git -C "$ACB_ROOT" push -q -u origin "$branch"
  ( cd "$ACB_ROOT" && gh pr create --title "propose: $* from $(basename "$OLDPWD")" \
      --body "Carried file(s) changed downstream and offered upstream by 'acb propose'." )
  git -C "$ACB_ROOT" checkout -q "$orig"
}
```

- [ ] **Step 3: Prove the round trip (SC3)**

The acceptance test for R2, and the reason this PR exists. Two throwaway consumers:

```bash
ACB="$PWD/bin/acb"          # absolute: the consumers are elsewhere and acb is not on PATH
"$ACB" init /tmp/acb-a && "$ACB" init /tmp/acb-c
cd /tmp/acb-a && printf '\n<!-- round trip -->\n' >> .claude/skills/writing-plans/SKILL.md
"$ACB" propose .claude/skills/writing-plans/SKILL.md   # opens the PR
# merge it in the acb repo, then:
cd /tmp/acb-c && "$ACB" status   # expect: behind: 1
"$ACB" pull && git diff --stat    # expect: the same one-line change
```

Expected: consumer C receives, through the toolkit, a change made in consumer A. Nothing short of
this demonstrates R2.

- [ ] **Step 4: Clean up, run everything, commit and open PR 5**

```bash
rm -rf /tmp/acb-a /tmp/acb-c && cd - && ./verify.sh
git add lib/sync.sh tests/sync.test.sh
git commit -m "feat(sync): propose carried files upstream, refuse generated ones"
git push -u origin HEAD
gh pr create --title "feat: bidirectional sync — status, pull, propose" \
  --body "Closes igor-ka/llm-code-execution#<child>"
```

---

## Plan review log

Staff-engineer review 2026-08-27 — **Issues Found**. Applied without asking (16 findings):

- Task 1, Step 2: `lint()` no longer globs `carried/scripts/*.sh` — that directory does not exist in
  PR 1 and an unmatched glob stays literal, so `shellcheck` errored and Task 3's "expected green"
  was unreachable. PR 2 Task 4 gains a Step 5 that adds the carried globs to **both** `lint()` and
  `selftest()`; the carried suites had otherwise run in no CI at all (SC9).
- Task 1, Step 3: added `brew install shellcheck`.
- Task 2, Step 4: `mkdir -p schema` moved ahead of the `jq -n` redirect that writes into it.
- Task 3, Step 3: `usage; [[ … ]] && exit 2 || exit 0` → an `if` block. The original trips
  shellcheck SC2015, which fails `verify.sh lint`.
- Task 4, Step 1: `templates` added to the `mkdir`, which Step 2 writes into; removed from Step 4.
- Task 4, Step 2: the split orphaned `sdlc.md:114`'s
  `[worked example](#worked-example-adding-per-user-rate-limiting)` anchor — repointed at
  `sdlc-example.md`, and the verification now greps the **hyphenated** form too, which is the one
  the anchor used and the only form that catches it.
- Task 5, Step 1: also replaces the three `"igor-ka"` `PR_ACTOR` fixtures (lines 71, 77, 81).
- Task 6, Step 2: there are **six** occurrences, not five — line 130 carries a mixed-case
  `Igor-Ka/LLM-Code-Execution#64`, which exists to prove the matching is case-insensitive.
- Task 7, Step 4: also replaces the six identifiers in the disarm suite (lines 74, 83, 84, 119,
  121, 124).
- Task 8, Steps 2–3: **the premise was false.** The carried skills contain zero repository
  identifiers; the real remainders were the test fixtures above. The `--exclude-dir=skills`
  workaround and its expected-red state are deleted, as is Task 12 Step 2 which removed it.
- Task 8, Step 1: the purity grep is now case-insensitive (`grep -rInEi`).
- Task 10: **wrong file.** The six `Postgres` references are in `test-driven-development/SKILL.md`
  and `references/definition-of-done.md`, not `security-checklist.md`, which has none. The
  attribution note goes in those two.
- Task 10, Step 1: added the three missing substitutions — `Auth0`, `Cloud Run`, `sandbox-image`
  had no prescribed replacement. Task retitled to 16 nouns, the other six being the attributed
  `Postgres` mentions.
- Tasks 16–18, Step 1: `tests/sync.test.sh` must point `ACB_ROOT` at a throwaway fixture and stub
  `gh` on `PATH` — as written it would have branched, committed and **pushed** in the real toolkit
  checkout.
- Task 17, Step 2: `acb_check_drift` always failed, so `status` always exited 1. `SDLC docs` and
  `PR shape` come from the carried workflows, not `ci.yml`, so `comm` reported both missing every
  run. Both sorts now `LC_ALL=C`, because `comm` compares byte-wise and the names contain spaces.
- Tasks 14–15: `acb_cmd_init` copied `templates/apply-ruleset.sh.tmpl` a task before it existed,
  and `bin/acb` has no `set -e`, so the `cp` failed silently and `init` still printed `✓`. The copy
  moved into Task 16 alongside the template, and Task 16's smoke run now creates the repository with
  `--repo` before applying a ruleset to it. Added `gh auth refresh -s delete_repo`.
- Task 19, Steps 2–3: `../../bin/acb` resolved to `/bin/acb` and two later calls assumed `acb` on
  `PATH` — now one absolute `$ACB`. `acb_cmd_propose` also left the toolkit on the `propose/…`
  branch, so the next `status`/`pull` in any consumer would compare against it; it now restores the
  original branch.
- File structure: `scripts/apply-ruleset.sh` → `templates/apply-ruleset.sh.tmpl`; added
  `tests/cli.test.sh`.

Escalated to the user 2026-08-27 — **all 12 judgment findings returned with "go with your
recommendation"**, and applied as follows. Each is a decision the user owns; they are recorded here
so any of them can be reversed without re-deriving the reasoning.

- **The auto-merge allow-list cannot read `.acb.json` at all.** The workflow has no
  `actions/checkout` *by design* — the `apply` job holds the only writable token — so a `jq` against
  it fails on every run and leaves auto-merge silently dead in every consumer. The list now travels
  as the repository variable `ACB_DEPENDABOT_ECOSYSTEMS`, handed to the first step through `env:`:
  no checkout, no file, and still ahead of `fetch-metadata`. `acb init` sets it, `acb status`
  reconciles it against `.acb.json`. Rule 2's second hardcoded `npm_and_yarn` test reads the same
  variable, so defence in depth survives without a second source of truth.
- **The carried `sdlc-docs.yml` ran two deployment tests that are not carried**, which would have
  failed every consumer's `SDLC docs` check forever and blocked R1. Both steps are deleted from the
  carried copy; rehosting them in `llm-code-execution` is an input to the adoption plan.
- **`carried/docs/sdlc.md` was never generalised** — a whole missing task, now Task 11, and the
  portability lint widened to `carried/docs`. D5's `docker`→`package` and `SKIP_DOCKER`→
  `SKIP_PACKAGE` renames land here, which is where a reader learns the vocabulary exists.
- **The fourth conformance assertion was vacuous.** One-liner `target_*` bodies put the planted
  `false` after the closing brace. `acb_render_verify` now emits multi-line bodies, and the patched
  copy is written inside the component directory — a copy in `/tmp` resolves `cd "$(dirname "$0")"`
  to the wrong place and proves nothing. The original is still never written to.
- **Nothing ran `check-conformance.sh` in a consumer's CI.** Added as a step to the carried
  `sdlc-docs.yml` rather than to `ci.yml`: that check is already required, so it adds no job name,
  no ruleset entry and nothing for `acb_check_drift` to reconcile.
- **Auto-merge is now opt-in.** It needs a per-repository GitHub App a fresh consumer does not have.
  `init` writes the workflow only when `dependabotEcosystems` is non-empty, and points at an
  "Auto-merge setup" section in the generated `CLAUDE.md`.
- **The ruleset posture is written out** rather than left to the implementer: `enforcement: active`,
  no bypass actors, zero required approvals with `required_review_thread_resolution: true`, and
  `strict_required_status_checks_policy: false`. The reasoning for each is in Task 15.
- **Zero components now writes no `ci.yml` at all.** A `jobs:` key with nothing under it is a file
  GitHub rejects, and the render test's old assertion would have locked that in. `acb_check_drift`
  tolerates the absence.
- **Task 5 breaks two things in the carried suite**, both silent-passing: the `WATCHED_RE`
  extraction yields empty (and an empty pattern matches everything, inverting three cases), and the
  six pre-existing cases run with no `ACB_CONFIG`. Both repairs are now Step 4.
- **`sdlc-example.md.tmpl` shipped this application's 119-line rate-limiting story** into every new
  repository, permanently — it is generated, so `pull` never corrects it. Replaced with a short
  generic example; the original is kept in the toolkit as reference.
- **The scope claim overstated what lands.** "R1 and R2, complete" is now explicit that SC1, SC5 and
  SC11 remain unmet at the end of PR 5, and that the round trip is demonstrated only between
  throwaway consumers.

Correction 2026-08-28, after the review — **the ruleset template was missing half the live
ruleset.** The block written above was composed from memory rather than read back from the
repository it claims to reproduce. `gh api repos/igor-ka/llm-code-execution/rulesets/17055903`
returns six rules; the template had four. Missing outright: **`copilot_code_review`** (with
`review_on_push` and `review_draft_pull_requests`) and **`required_linear_history`**. Wrong on
three parameters: `strict_required_status_checks_policy` is `true` here, not `false`;
`allowed_merge_methods` is `["squash", "rebase"]`, which `required_linear_history` depends on; and
`require_extra_approval_for_unattributed_changes` is on.

The Copilot omission was the costly one. `CLAUDE.md` treats Copilot review as the *enforced* half of
the review gate — the two skill passes are procedure, not enforcement — so every repository
scaffolded from the old template would have lost that gate with nothing red to show for it.

Also applied from the advisory bucket, being consequences of the above rather than separate
choices: `gh auth refresh -s delete_repo` before `gh repo delete`, and the `verify.sh` lint extended
to the carried test suites.
