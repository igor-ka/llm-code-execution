#!/usr/bin/env bash
# Single source of truth for the backend checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/ci.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target]
#   all              (default) audit + install + lint + format + test + build + integration + package
#   --targets        print the target names this script knows, one per line
#   audit            npm audit (fails on high+ advisories)
#   install          npm ci
#   lint             eslint
#   format           prettier --check
#   test             tsc typecheck + vitest (DB-free; Postgres suites self-skip)
#   build            tsc emit
#   migrate          apply history migrations (requires DATABASE_URL)
#   test:integration contract suites against a real Postgres and Redis (require DATABASE_URL
#                    and REDIS_URL respectively; each self-skips when its variable is unset)
#   package          build the backend, sandbox and production images, and assert against them
#   mutation         diff-scoped mutation gate (blocks on survivors AND uncovered changed lines)
#   mutation:selftest  proves the gate can fail — Stryker against a deliberately weak fixture
#
# CI invokes the individual targets as separate named steps (Audit / Install / Lint / Format /
# Test / Build / Integration test / Package) so each gets its own pass/fail and timing
# in the job log, while the job stays a single check.
#
# Env toggles apply to the `all` target only: SKIP_INSTALL=1 (reuse node_modules),
# SKIP_PACKAGE=1 (host checks only, no image builds). The integration step is gated on
# DATABASE_URL / REDIS_URL exactly like SKIP_PACKAGE: both absent -> skipped with a message.
set -euo pipefail

cd "$(dirname "$0")"

# The checkout root, captured AFTER the cd above so it cannot depend on how this script was
# invoked: cwd is now the script's own directory, so the root is simply its parent. The
# basename is unique per worktree, which is what scopes the throwaway image tags below.
CHECKOUT_ROOT="$(cd .. && pwd)"

# The single list, and the same order .acb.json declares. NOT the order `all` runs them — `all`
# audits first, deliberately, because `npm ci` executes lifecycle scripts. `install` leads this
# list instead because the conformance check plants a `false` in the FIRST declared target, and a
# target that exits before doing anything is what keeps that probe free. Do not "fix" the order to
# match `all()`: that would put `audit` first and make every conformance run a real `npm audit`.
TARGETS="install audit lint format test build migrate test:integration package mutation mutation:selftest"

run() {
  echo
  echo "==> $*"
  "$@"
}

install() { run npm ci; }
# Dependency advisories, from the lockfile — no node_modules needed, so SKIP_INSTALL=1 does not
# weaken it. `jose` verifies auth tokens and `pg` talks to the history store, so an advisory in
# either sits directly on the security path the README leads with.
#
# SCOPE is every dependency, dev included — NOT `--omit=dev`. Neither image ships devDependencies
# (both Dockerfiles use `npm ci --omit=dev`), so a vulnerable eslint never reaches production. But
# it does run here and in CI, on a checkout with a writable token, which is the supply-chain half
# of the threat model rather than the runtime half.
#
# THRESHOLD: high and above fail. Moderate and below are reported by `npm audit` and handled by
# Dependabot PRs; blocking a merge on every moderate transitive advisory buys noise, not safety.
#
# TWO FLAGS ARE LOAD-BEARING, both closing environment-driven bypasses that fail OPEN:
#
#   --no-offline   with `npm_config_offline=true` in the environment or `offline=true` in a
#                  developer's ~/.npmrc, `npm audit` prints "found 0 vulnerabilities" and exits 0.
#   --include=dev  `npm audit` honours the `omit` config, and BOTH `npm_config_omit=dev` and
#                  `NODE_ENV=production` set it — silently dropping every dev-dependency advisory,
#                  which is exactly the scope the paragraph above claims. NODE_ENV=production is a
#                  plausible thing to find already exported in a shell or on a runner; it does not
#                  have to be deliberate to disable this.
#
# Both were found by review rather than by the gate noticing, which is the point: `npm audit` is
# configurable from the environment in several ways that all fail open, so these flags state the
# intent explicitly instead of inheriting whatever the environment happens to say.
#
# A HARD FAIL, deliberately — not `|| true`. A check that cannot fail is the decorative-assertion
# pattern this repo has already shipped once and had to fix (see "Details that are easy to get
# wrong" under "How this meets CI/CD" in docs/sdlc.md): it reads as coverage and provides none. If
# an unfixable high advisory ever lands with no upstream patch, the honest response is an
# explicit, dated exception written here — where it is visible in review — not a green check.
audit()  { run npm audit --audit-level=high --no-offline --include=dev; }
lint()    { run npm run lint; }
format()  { run npm run format:check; }
test_()   { run npm run test; }
build()   { run npm run build; }
migrate() { run node --import tsx src/history/cli-migrate.ts; }
integration() {
  if [[ -z "${DATABASE_URL:-}" && -z "${REDIS_URL:-}" ]]; then
    echo
    echo "==> skipping integration tests (neither DATABASE_URL nor REDIS_URL set)"
    return 0
  fi
  # Each suite self-skips on its own variable, so one service is enough to make this
  # worth running — but a partial run is NOT full coverage. Say which half is missing.
  [[ -n "${DATABASE_URL:-}" ]] || echo "==> note: DATABASE_URL unset — Postgres suites will self-skip"
  [[ -n "${REDIS_URL:-}" ]]    || echo "==> note: REDIS_URL unset — Redis quota suite will self-skip"
  run npm run test:integration
}
# The diff-scoped mutation gate. Its rationale is ADR 0006 ("Trusting AI-written tests").
#
# THE LOCAL RUN IS THE FIRST SIGNAL AND CI IS THE BACKSTOP. Run this at the REFACTOR step on the
# lines you just touched — survivors are the assertions you have not written yet, and they are a
# two-minute fix while the code is still in your head. If the workflow is working, CI never finds
# a survivor.
mutation() {
  # The datastore precondition FIRST, before any work: it is the cheapest check here and the one
  # most likely to fail, and paying a Stryker run before reaching it wastes minutes.
  #
  # CI must not be able to take the partial branch. The suites covering pgStore.ts, migrate.ts and
  # redisQuota.ts SELF-SKIP without these variables — so a DB-free run does not skip those files,
  # it reports every mutant in them as SURVIVED. That is not incomplete output, it is wrong output,
  # and it would fail the build for the wrong reason.
  if [[ "${MUTATION_REQUIRE_FULL:-}" == "1" ]]; then
    [[ -n "${DATABASE_URL:-}" ]] || { echo "MUTATION_REQUIRE_FULL=1 but DATABASE_URL is unset" >&2; exit 1; }
    [[ -n "${REDIS_URL:-}" ]]    || { echo "MUTATION_REQUIRE_FULL=1 but REDIS_URL is unset" >&2; exit 1; }
  else
    [[ -n "${DATABASE_URL:-}" ]] || echo "==> note: DATABASE_URL unset — mutants in pgStore.ts and migrate.ts would all read as survivors"
    [[ -n "${REDIS_URL:-}" ]]    || echo "==> note: REDIS_URL unset — mutants in redisQuota.ts would all read as survivors"
  fi

  # The unit tests for the three mutation scripts are NOT run here. They live in the `Deploy
  # scripts` workflow with the other repo-root script tests: this is a backend-component target, and
  # reaching repo-root tooling through it meant a change to scripts/mutation-scope.sh landing on
  # `main` was never re-tested — this target is outside `all` and gated on pull_request in ci.yml.
  #
  # The suppression SCAN stays, because it inspects this component's own source. No argument: the
  # script reads the same declaration mutation-scope.sh does, so the eligible set lives in exactly
  # one place.
  run ../scripts/mutation-suppressions.sh

  local scope
  scope="$(../scripts/mutation-scope.sh)"
  if [[ -z "$scope" ]]; then
    echo
    echo "==> no mutable lines in this change — the eligible file set was not touched"
    echo "    (this is a pass, not a skip: there is nothing to mutate)"
    return 0
  fi

  echo
  echo "==> mutating $(printf '%s\n' "$scope" | wc -l | tr -d ' ') changed range(s):"
  printf '      %s\n' $scope

  # ALWAYS SINGLE-WORKER WHEN A DATASTORE IS IN PLAY, with no allowlist.
  #
  # Stryker forks N worker processes, each running its own vitest. CI provides ONE Postgres and ONE
  # Redis, and the Postgres suites share a single schema — which is why vitest.config.ts sets
  # fileParallelism:false. That serializes files WITHIN one vitest process; it does nothing about
  # two Stryker workers running two vitest processes at once. A collision produces a spurious
  # failure, and a spurious failure KILLS a mutant — so the gate passes for the wrong reason and
  # nobody can tell that from a real kill.
  #
  # AN EARLIER VERSION ALLOWLISTED auth.ts, schemas.ts AND sandbox/ as "provably datastore-free".
  # That was a category error, caught in review: the allowlist named SOURCE files, but the hazard is
  # which TESTS execute. With coverageAnalysis:perTest Stryker runs whatever covers each mutant —
  # and `schemas.ts` is imported by server.ts, which tests/history/isolation.test.ts drives through
  # /api/execute while its `postgres` block holds a real pool on the shared schema. Proving a file
  # datastore-free means proving a negative about the whole coverage graph, and getting it wrong
  # fails OPEN. Serializing costs seconds — measured at 8s for a real two-line change against live
  # Postgres and Redis — so the trade is not close.
  local stryker_args=()
  if [[ -n "${DATABASE_URL:-}" || -n "${REDIS_URL:-}" ]]; then
    echo "    a datastore is configured — running single-worker to protect the shared schema"
    stryker_args+=(--concurrency 1)
  fi

  # A STALE REPORT MUST NOT BE READABLE. reports/ is gitignored and persists between runs, so if
  # Stryker exits 0 without writing (a broken json reporter, a --mutate list it declines), the
  # decide script would read the PREVIOUS run's file and report plausible file:line data from a
  # different scope. mutation-decide.mjs already fails closed on absence; this makes absence the
  # only possible failure mode.
  rm -rf reports/mutation

  # Stryker's exit code is captured rather than left to `set -e` so the decision script always runs
  # and always explains WHY. It is not swallowed: a non-zero Stryker exit with no offending mutant
  # is treated as a crash below.
  #
  # `${a[@]+"${a[@]}"}` and NOT a bare `"${stryker_args[@]}"`. macOS ships bash 3.2.57, where
  # expanding an EMPTY array under `set -u` aborts with "unbound variable" — and empty is the common
  # case, so the plain form would kill the gate on every developer laptop while passing on CI's
  # bash 5. Exactly the local/CI split this single-verify.sh design exists to prevent.
  local stryker_status=0
  npx stryker run ${stryker_args[@]+"${stryker_args[@]}"} \
    --mutate "$(printf '%s\n' "$scope" | paste -sd, -)" || stryker_status=$?

  if ! node ../scripts/mutation-decide.mjs reports/mutation/mutation.json; then
    exit 1
  fi
  if [[ "$stryker_status" -ne 0 ]]; then
    echo "stryker exited ${stryker_status} but the report names no unkilled mutant — treating as a crash" >&2
    exit 1
  fi
}

# The end-to-end proof that the gate can fail: Stryker really runs, really writes a report, and a
# test that cannot detect a bug really is rejected. Two full Stryker runs against a tiny fixture.
#
# SEPARATE FROM `mutation` deliberately. It is the difference between a proven gate and a decorative
# one, so it must run before every push and in CI — but the inner-loop REFACTOR run is supposed to
# cost seconds, and paying two fixture runs there is how a target stops being used.
mutation_selftest() { run ../scripts/tests/mutation-gate.test.sh; }

# Image tags are daemon-wide, and this target BUILDS a tag and then RUNS it. Two worktrees
# verifying at the same moment would otherwise share `…:verify`, so one tree's assertions can
# execute the other tree's image and report a pass or fail that belongs to a different branch.
# The checkout's directory name is unique per worktree (see "Parallel worktrees" in README.md)
# and deterministic in CI. Sanitised because a directory name is not necessarily a legal tag.
#
# Derived from CHECKOUT_ROOT above, NOT from `git rev-parse --show-toplevel`: the name is then
# correct in an exported tree or source archive too, where there is no git. And NOT from a
# `|| pwd` fallback, which would be worse than useless — this script cds to its own directory
# first, so the fallback would resolve to `backend` on every machine and silently restore the
# very collision this exists to prevent.
# A basename alone is neither unique nor bounded: `worktree-new.sh llm-code-execution` would give
# a worktree the same basename as the main checkout, restoring the collision, and Docker caps a
# tag at 128 characters — which `${tag}-argcheck` below would breach for a long directory name.
# So: a readable, truncated name for humans plus a checksum of the FULL path for uniqueness.
# `cksum` rather than shasum/sha1sum because it is POSIX and present on both macOS and CI.
verify_tag() {
  local name sum
  name="$(printf '%s' "$(basename "$CHECKOUT_ROOT")" | tr -c '[:alnum:]._-' '-' | cut -c1-24)"
  sum="$(printf '%s' "$CHECKOUT_ROOT" | cksum | cut -d' ' -f1)"
  printf 'verify-%s-%s\n' "$name" "$sum"
}

# `--pull` on every build, deliberately. Without it `docker build` reuses whatever base image is
# already cached locally, so an identical script produces different artifacts on two machines:
# CI starts from a cold cache and gets the current `node:22-slim`, while a developer's laptop can
# be months behind and still report green. That is local/CI drift arriving through the INPUTS
# rather than the commands, which is the one gap the single-verify.sh design does not otherwise
# close.
#
# What it does NOT do is make the two provably identical. `node:22-slim` is a mutable tag resolved
# independently at each build, so two builds can still differ if upstream republishes between
# them. Only digest pins close that, and they turn every upstream rebuild into a PR. The trade
# taken here is deliberate: a residual window of upstream-republish timing, instead of a laptop
# months behind CI.
#
# Cost is 0.15s (0.52s -> 0.66s, sandbox image) WHEN THE CACHED DIGEST IS CURRENT — a manifest
# check, not a download. When the tag has actually moved, --pull fetches the changed layers, which
# is the entire point. It does mean the `package` target needs the network, which building an image
# always did whenever the cache was cold.
package_() {
  local tag
  tag="$(verify_tag)"
  run docker build --pull -t "llm-code-execution-backend:${tag}" .
  run docker build --pull -t "llm-sandbox:${tag}" ./sandbox-image
  # The production artifact (repo-root Dockerfile, repo-root context): the SPA and the API in one
  # image. Built here because it is the backend process that serves the SPA.
  #
  # The VITE_AUTH0_* placeholders satisfy the Dockerfile's build-time assertion. They prove the
  # WIRING, never the values: a real deploy passes its real tenant, and an image built by this
  # script must never be deployed.
  run docker build --pull -f ../Dockerfile \
    --build-arg VITE_AUTH0_DOMAIN=verify.invalid \
    --build-arg VITE_AUTH0_CLIENT_ID=verify \
    --build-arg VITE_AUTH0_AUDIENCE=https://verify.invalid/api \
    -t "llm-code-execution:${tag}" ..
  # NOTE the `if …; then exit 1; fi` form. `! grep -q …` under `set -e` does NOT abort: POSIX
  # exempts a command whose return value is inverted with `!` from errexit, so the negated
  # assertions silently passed on a bad image. frontend/verify.sh uses the same explicit form for
  # the same reason.
  run docker run --rm "llm-code-execution:${tag}" sh -c '
    set -e
    # The CSP must have shipped, and must be the PRODUCTION policy.
    grep -qE "script-src '"'"'self'"'"'\s*(;|$)" /app/public/csp.txt
    if grep -q "unsafe-eval" /app/public/csp.txt; then
      echo "csp.txt permits unsafe-eval — that is the DEV policy" >&2; exit 1
    fi

    # No PLAINTEXT origin in the policy. connect-src is generated from the same resolveApiBase()
    # the bundle uses, so a VITE_API_BASE left at the localhost fallback shows up here.
    #
    # Scope of what this proves: THIS build passes no VITE_API_BASE, so it exercises the ARG
    # default (""). It therefore guards the default and the policy builder, not a real deploy
    # that passes a plaintext base — that one is caught by the same assertion run against the
    # image you actually ship.
    #
    # Do NOT grep the bundle for localhost instead: resolveApiBase() carries that string as its
    # fallback LITERAL, so it is present in every build by construction whether or not it is in
    # use. The policy reflects the RESOLVED value; the bundle does not.
    if grep -q "http://" /app/public/csp.txt; then
      echo "csp.txt names a plaintext http:// origin" >&2; exit 1
    fi

    # The Auth0 origin must have REACHED the policy. Without this, a regression in the
    # ARG -> ENV -> buildCsp wiring leaves every other assertion green while the deployed app
    # blocks its own login: the policy is still valid, still strict, and missing frame-src /
    # connect-src for the tenant. The Dockerfile guard only proves the value was non-EMPTY.
    if ! grep -q "verify.invalid" /app/public/csp.txt; then
      echo "csp.txt does not name the Auth0 origin that was passed as a build arg" >&2; exit 1
    fi

    # A Cloud Run sandbox executes user code against a read-only view of THIS image, so the
    # interpreter must ship here rather than in backend/sandbox-image/. Without it the first
    # execution on Cloud Run dies with command-not-found.
    # NOTE: no apostrophes in this block. It lives inside a single-quoted sh -c string, and one
    # stray quote closes it early and turns the rest into shell syntax errors.
    # Import numpy rather than checking the interpreter binary: llm.ts promises the generator
    # that numpy is available, so a missing module is a broken promise, not a missing nicety.
    # ABSOLUTE path, matching what cloudRunSandbox.ts spawns. A bare `python3` here would pass on
    # PATH and prove nothing about the sandbox, which runs with PATH empty and resolves nothing —
    # exactly the gap that let #185 reach production green.
    /usr/bin/python3 -c "import numpy" >/dev/null 2>&1 || { echo "/usr/bin/python3 with numpy missing from the production image" >&2; exit 1; }

    # Never root.
    [ "$(id -u)" != "0" ]
    echo "production image assertions passed"
  '
  # Negative test: the Dockerfile MUST reject an empty VITE_AUTH0_* value. CI always supplies all
  # three, so without this the guard could be deleted and every check would stay green — the
  # classic gate that does not gate. Runs after the positive build, so the npm ci layer is warm
  # and this costs seconds. Omitting the audience exercises the ARG default ("").
  echo
  echo "==> docker build (negative: VITE_AUTH0_AUDIENCE omitted, MUST fail)"
  # NO --pull here, and the failure is checked for its REASON rather than just its exit code.
  #
  # Both for the same reason. This assertion reads a non-zero exit as "the guard rejected it", so
  # every additional way the build can fail is a way for it to pass while proving nothing — a
  # registry 429, a DNS blip, an offline laptop. `--pull` would add exactly that, and buy nothing:
  # the positive build above pulled the same base from the same daemon seconds ago, so there is no
  # drift left for it to close. A gate that does not gate is what this test exists to prevent; it
  # should not become one itself.
  local negative_out
  if negative_out="$(docker build -f ../Dockerfile \
      --build-arg VITE_AUTH0_DOMAIN=verify.invalid \
      --build-arg VITE_AUTH0_CLIENT_ID=verify \
      -t "llm-code-execution:${tag}-argcheck" .. 2>&1)"; then
    echo "Dockerfile built with VITE_AUTH0_AUDIENCE empty — the build-arg guard is not enforcing" >&2
    exit 1
  fi
  if ! grep -q "VITE_AUTH0_AUDIENCE is required" <<<"$negative_out"; then
    echo "the build failed, but NOT on the build-arg guard — this assertion proved nothing:" >&2
    printf '%s\n' "$negative_out" | tail -20 >&2
    exit 1
  fi
  echo "    rejected as expected, by the guard"
}

# `mutation` and `mutation:selftest` are deliberately absent from `all`, for DIFFERENT reasons.
# `mutation` needs a resolvable merge base against origin/main, which a detached checkout or a fresh
# clone may not have, and `all` must stay runnable anywhere. `mutation:selftest` needs no merge base
# at all — its fixture carries its own `mutate` key — and is out purely on COST: two full Stryker
# runs. Run them explicitly: ./verify.sh mutation && ./verify.sh mutation:selftest
all() {
  # FIRST, before install: `npm ci` runs dependency lifecycle scripts, so auditing afterwards
  # lets a package with a known install-time vulnerability execute before the gate can reject it.
  # The audit reads the committed lockfile and needs no node_modules, so it can go first — and a
  # security gate that fails closed is worth more than a tidy ordering.
  #
  # The cost is that a registry outage aborts the pass before the offline checks run. Reach for a
  # single target then (`./verify.sh test`), which is what the per-target dispatch is for.
  audit
  [[ "${SKIP_INSTALL:-}" == "1" ]] || install
  lint
  format
  test_
  build
  integration
  [[ "${SKIP_PACKAGE:-}" == "1" ]] || package_
}

target="${1:-all}"
case "$target" in
  all)              all ;;
  --targets)        printf '%s\n' "$TARGETS" | tr ' ' '\n'; exit 0 ;;
  install)          install ;;
  audit)            audit ;;
  lint)             lint ;;
  format)           format ;;
  test)             test_ ;;
  build)            build ;;
  migrate)          migrate ;;
  test:integration) integration ;;
  package)          package_ ;;
  mutation)         mutation ;;
  mutation:selftest) mutation_selftest ;;
  *)                # 64, not 2 — see infra/verify.sh for the full reason.
                    echo "unknown target: $target (expected: all|$TARGETS)" >&2; exit 64 ;;
esac

echo
echo "✓ backend: ${target} passed."
