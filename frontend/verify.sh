#!/usr/bin/env bash
# Single source of truth for the frontend checks. Run this locally before pushing;
# CI runs the exact same script (see .github/workflows/ci.yml), so local and CI can't
# drift. This is what would have caught the Docker build breaking before the PR.
#
#   ./verify.sh                 full run: install, lint, format, test, build, docker build
#   SKIP_INSTALL=1 ./verify.sh  reuse existing node_modules (faster inner loop)
#   SKIP_DOCKER=1  ./verify.sh  skip the docker image build (host checks only)
set -euo pipefail

cd "$(dirname "$0")"

run() {
  echo
  echo "==> $*"
  "$@"
}

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  run npm ci
fi

run npm run lint
run npm run format:check
run npm run test
run npm run build

if [[ "${SKIP_DOCKER:-}" != "1" ]]; then
  run docker build -t llm-code-execution-frontend:verify .
fi

echo
echo "✓ All frontend checks passed."
