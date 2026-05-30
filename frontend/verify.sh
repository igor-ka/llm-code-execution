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
#   build    tsc -b && vite build
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

run() {
  echo
  echo "==> $*"
  "$@"
}

install() { run npm ci; }
lint()    { run npm run lint; }
format()  { run npm run format:check; }
test_()   { run npm run test; }
build()   { run npm run build; }
docker_() { run docker build -t llm-code-execution-frontend:verify .; }

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
