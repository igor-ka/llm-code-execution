#!/usr/bin/env bash
# Single source of truth for the frontend checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/ci.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target]
#   all      (default) install + lint + format + test + build + docker
#   install  npm ci
#   lint     eslint
#   format   prettier --check
#   test     vitest
#   build    tsc -b && vite build (+ assert the production CSP shipped)
#   docker   build the frontend image
#
# CI invokes the individual targets as separate named steps (Install / Lint / Format /
# Test / Build / Docker build) so each gets its own pass/fail and timing in the job log,
# while the job stays a single check. If you later want each target as its own line on the
# GitHub *checks screen*, split them into separate jobs that each call `./verify.sh <target>`
# — this script doesn't need to change.
#
# Env toggles apply to the `all` target only: SKIP_INSTALL=1 (reuse node_modules),
# SKIP_DOCKER=1 (host checks only, no image build).
set -euo pipefail

cd "$(dirname "$0")"

# The checkout root, captured AFTER the cd above so it cannot depend on how this script was
# invoked: cwd is now the script's own directory, so the root is simply its parent. The
# basename is unique per worktree, which is what scopes the throwaway image tags below.
CHECKOUT_ROOT="$(cd .. && pwd)"

run() {
  echo
  echo "==> $*"
  "$@"
}

install() { run npm ci; }
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
docker_() {
  # Daemon-wide tag, unique per worktree — see the fuller note in backend/verify.sh.
  # Readable truncated name + a checksum of the FULL path — see the fuller note in
  # backend/verify.sh for why the basename alone is neither unique nor length-bounded.
  # `printf '%s'` and not a bare pipe from basename: basename emits a trailing newline, which
  # `tr -c` would translate into a dash, so every tag would end in one.
  local tag name sum
  name="$(printf '%s' "$(basename "$CHECKOUT_ROOT")" | tr -c '[:alnum:]._-' '-' | cut -c1-24)"
  sum="$(printf '%s' "$CHECKOUT_ROOT" | cksum | cut -d' ' -f1)"
  tag="verify-${name}-${sum}"
  run docker build -t "llm-code-execution-frontend:${tag}" .
}

all() {
  [[ "${SKIP_INSTALL:-}" == "1" ]] || install
  lint
  format
  test_
  build
  [[ "${SKIP_DOCKER:-}" == "1" ]] || docker_
}

target="${1:-all}"
case "$target" in
  all)     all ;;
  install) install ;;
  lint)    lint ;;
  format)  format ;;
  test)    test_ ;;
  build)   build ;;
  docker)  docker_ ;;
  *)       echo "unknown target: $target (expected: all|install|lint|format|test|build|docker)" >&2; exit 2 ;;
esac

echo
echo "✓ frontend: ${target} passed."
