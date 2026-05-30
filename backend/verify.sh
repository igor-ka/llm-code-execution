#!/usr/bin/env bash
# Single source of truth for the backend checks. Run this locally before pushing;
# CI runs the exact same script (see .github/workflows/ci.yml), so local and CI can't
# drift. Mirrors what used to be the backend-test, backend-lint, and docker-build jobs.
#
#   ./verify.sh                 full run: install, ruff, pytest, docker builds
#   SKIP_INSTALL=1 ./verify.sh  reuse the current environment (faster inner loop)
#   SKIP_DOCKER=1  ./verify.sh  skip the docker image builds (host checks only)
#
# Uses whatever `python` is active (a venv locally, the runner's Python in CI);
# override with PYTHON=/path/to/python.
set -euo pipefail

cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
RUFF_VERSION="0.15.15"

run() {
  echo
  echo "==> $*"
  "$@"
}

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  run "$PY" -m pip install -r requirements-dev.txt
  run "$PY" -m pip install -e . --no-deps
  run "$PY" -m pip install "ruff==${RUFF_VERSION}"
fi

run "$PY" -m ruff check .
run "$PY" -m pytest

if [[ "${SKIP_DOCKER:-}" != "1" ]]; then
  run docker build -t llm-code-execution-backend:verify .
  run docker build -t llm-sandbox:verify ./sandbox-image
fi

echo
echo "✓ All backend checks passed."
