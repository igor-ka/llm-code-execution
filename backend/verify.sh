#!/usr/bin/env bash
# Single source of truth for the backend checks. Run this locally before pushing;
# CI runs the SAME script (see .github/workflows/ci.yml), so local and CI can't drift.
#
# Usage: ./verify.sh [target]
#   all      (default) install + lint + test + docker
#   install  pip install dev deps + editable package + pinned ruff
#   lint     ruff check
#   test     pytest
#   docker   build the backend and sandbox images
#
# CI invokes the individual targets as separate named steps (Install / Lint / Test /
# Docker build) so each gets its own pass/fail and timing in the job log, while the job
# stays a single check. If you later want each target as its own line on the GitHub
# *checks screen*, split them into separate jobs that each call `./verify.sh <target>`
# — this script doesn't need to change.
#
# Uses whatever `python` is active (a venv locally, the runner's Python in CI);
# override with PYTHON=/path/to/python.
#
# Env toggles apply to the `all` target only: SKIP_INSTALL=1 (reuse the current
# environment), SKIP_DOCKER=1 (host checks only, no image builds).
set -euo pipefail

cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
RUFF_VERSION="0.15.15"

run() {
  echo
  echo "==> $*"
  "$@"
}

install() {
  run "$PY" -m pip install -r requirements-dev.txt
  run "$PY" -m pip install -e . --no-deps
  run "$PY" -m pip install "ruff==${RUFF_VERSION}"
}
lint()    { run "$PY" -m ruff check .; }
test_()   { run "$PY" -m pytest; }
docker_() {
  run docker build -t llm-code-execution-backend:verify .
  run docker build -t llm-sandbox:verify ./sandbox-image
}

all() {
  [[ "${SKIP_INSTALL:-}" == "1" ]] || install
  lint
  test_
  [[ "${SKIP_DOCKER:-}" == "1" ]] || docker_
}

target="${1:-all}"
case "$target" in
  all)     all ;;
  install) install ;;
  lint)    lint ;;
  test)    test_ ;;
  docker)  docker_ ;;
  *)       echo "unknown target: $target (expected: all|install|lint|test|docker)" >&2; exit 2 ;;
esac

echo
echo "✓ backend: ${target} passed."
