#!/usr/bin/env bash
# One-command checks for the auth-security harness, mirrored by CI (per CLAUDE.md).
# Runs ruff + pytest. Because these need Python 3.11+ (and the backend's app.auth), the
# default path runs them inside the image. Honors SKIP_DOCKER=1 (run on host instead) and
# SKIP_INSTALL=1 (host path only; skip pip install).
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"
IMAGE="llm-auth-agent:test"

if [[ "${SKIP_DOCKER:-0}" == "1" ]]; then
  echo "==> Host checks (SKIP_DOCKER=1)"
  if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
    pip install -e ".[dev]"
  fi
  PYTHONPATH="$REPO_ROOT/backend" ruff check .
  PYTHONPATH="$REPO_ROOT/backend" pytest -q
else
  echo "==> Building $IMAGE"
  docker build -f Dockerfile -t "$IMAGE" "$REPO_ROOT"
  echo "==> ruff"
  docker run --rm "$IMAGE" ruff check .
  echo "==> pytest"
  docker run --rm "$IMAGE" pytest -q
fi

echo "OK"
