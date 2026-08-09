#!/usr/bin/env bash
# Single source of truth for the backend checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/ci.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target]
#   all              (default) install + lint + format + test + build + integration + docker
#   install          npm ci
#   lint             eslint
#   format           prettier --check
#   test             tsc typecheck + vitest (DB-free; Postgres suites self-skip)
#   build            tsc emit
#   migrate          apply history migrations (requires DATABASE_URL)
#   test:integration contract suites against a real Postgres and Redis (require DATABASE_URL
#                    and REDIS_URL respectively; each self-skips when its variable is unset)
#   docker           build the backend and sandbox images
#
# CI invokes the individual targets as separate named steps (Install / Lint / Format /
# Test / Build / Integration test / Docker build) so each gets its own pass/fail and timing
# in the job log, while the job stays a single check.
#
# Env toggles apply to the `all` target only: SKIP_INSTALL=1 (reuse node_modules),
# SKIP_DOCKER=1 (host checks only, no image builds). The integration step is gated on
# DATABASE_URL / REDIS_URL exactly like SKIP_DOCKER: both absent -> skipped with a message.
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
docker_() {
  run docker build -t llm-code-execution-backend:verify .
  run docker build -t llm-sandbox:verify ./sandbox-image
}

all() {
  [[ "${SKIP_INSTALL:-}" == "1" ]] || install
  lint
  format
  test_
  build
  integration
  [[ "${SKIP_DOCKER:-}" == "1" ]] || docker_
}

target="${1:-all}"
case "$target" in
  all)              all ;;
  install)          install ;;
  lint)             lint ;;
  format)           format ;;
  test)             test_ ;;
  build)            build ;;
  migrate)          migrate ;;
  test:integration) integration ;;
  docker)           docker_ ;;
  *)                echo "unknown target: $target (expected: all|install|lint|format|test|build|migrate|test:integration|docker)" >&2; exit 2 ;;
esac

echo
echo "✓ backend: ${target} passed."
