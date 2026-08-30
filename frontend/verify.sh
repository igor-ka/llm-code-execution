#!/usr/bin/env bash
# Single source of truth for the frontend checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/ci.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target]
#   all      (default) audit + install + lint + format + test + build + package
#   --targets print the target names this script knows, one per line
#   audit    npm audit (fails on high+ advisories)
#   install  npm ci
#   lint     eslint
#   format   prettier --check
#   test     vitest
#   build    tsc -b && vite build (+ assert the production CSP shipped)
#   package  build the frontend image
#
# CI invokes the individual targets as separate named steps (Audit / Install / Lint / Format /
# Test / Build / Package) so each gets its own pass/fail and timing in the job log,
# while the job stays a single check. If you later want each target as its own line on the
# GitHub *checks screen*, split them into separate jobs that each call `./verify.sh <target>`
# — this script doesn't need to change.
#
# Env toggles apply to the `all` target only: SKIP_INSTALL=1 (reuse node_modules),
# SKIP_PACKAGE=1 (host checks only, no image build).
set -euo pipefail

cd "$(dirname "$0")"

# The checkout root, captured AFTER the cd above so it cannot depend on how this script was
# invoked: cwd is now the script's own directory, so the root is simply its parent. The
# basename is unique per worktree, which is what scopes the throwaway image tags below.
CHECKOUT_ROOT="$(cd .. && pwd)"

# The single list, and the same order .acb.json declares. NOT the order `all` runs them, which
# audits first — `install` leads because the conformance check plants a `false` in the FIRST
# declared target, and it must be one that exits before doing any work. See backend/verify.sh.
TARGETS="install audit lint format test build package"

run() {
  echo
  echo "==> $*"
  "$@"
}

install() { run npm ci; }
# Dependency advisories, from the lockfile — no node_modules needed, so SKIP_INSTALL=1 does not
# weaken it. The SPA ships `@auth0/auth0-react`, which drives the
# login flow, so an advisory there sits on the auth path; its build toolchain is the rest.
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
build() {
  run npm run build
  # Regression gate: the production CSP must ship with the bundle. It used to exist only as a
  # Vite dev/preview response header, so a static deploy of dist/ silently served no CSP at all —
  # a unit test on the policy builder cannot catch "the server forgot the header".
  run test -f dist/csp.txt
  # Exact directive, not a substring: the DEV policy is `script-src 'self' 'unsafe-inline'
  # 'unsafe-eval'`, which contains "script-src 'self'" and would sail through a looser check —
  # shipping the app with eval enabled while the gate stayed green.
  run grep -qE "script-src 'self'\s*(;|$)" dist/csp.txt
  # NOT `grep -qv`: that inverts per LINE, so it passes on any file with one clean line.
  # Only unsafe-eval is searched for: `style-src 'self' 'unsafe-inline'` is legitimate in the
  # production policy (React inline style objects), and the exact script-src check above already
  # guarantees no inline script is permitted.
  if grep -q "unsafe-eval" dist/csp.txt; then
    echo "dist/csp.txt permits unsafe-eval — that is the DEV policy, not the production one" >&2
    exit 1
  fi
}
# `--pull` on every build: without it Docker reuses whatever base image is cached locally, so an
# identical script yields different artifacts on two machines. See the fuller note in
# backend/verify.sh.

package_() {
  # Daemon-wide tag, unique per worktree — see the fuller note in backend/verify.sh.
  # Readable truncated name + a checksum of the FULL path — see the fuller note in
  # backend/verify.sh for why the basename alone is neither unique nor length-bounded.
  # `printf '%s'` and not a bare pipe from basename: basename emits a trailing newline, which
  # `tr -c` would translate into a dash, so every tag would end in one.
  local tag name sum
  name="$(printf '%s' "$(basename "$CHECKOUT_ROOT")" | tr -c '[:alnum:]._-' '-' | cut -c1-24)"
  sum="$(printf '%s' "$CHECKOUT_ROOT" | cksum | cut -d' ' -f1)"
  tag="verify-${name}-${sum}"
  run docker build --pull -t "llm-code-execution-frontend:${tag}" .
}

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
  [[ "${SKIP_PACKAGE:-}" == "1" ]] || package_
}

target="${1:-all}"
case "$target" in
  all)       all ;;
  --targets) printf '%s\n' "$TARGETS" | tr ' ' '\n'; exit 0 ;;
  install)   install ;;
  audit)     audit ;;
  lint)      lint ;;
  format)    format ;;
  test)      test_ ;;
  build)     build ;;
  package)   package_ ;;
  *)         # 64, not 2 — see infra/verify.sh for the full reason.
             echo "unknown target: $target (expected: all|$TARGETS)" >&2; exit 64 ;;
esac

echo
echo "✓ frontend: ${target} passed."
