#!/usr/bin/env bash
# Unit tests for the pure helpers in scripts/worktree-new.sh. The script sources cleanly with
# WORKTREE_NEW_LIB=1 (defining functions, running nothing), so the slot arithmetic and the
# generated env can be tested without touching git, Docker or the network.
#
# Run locally before pushing. Deliberately NOT in CI: CI never creates a worktree, so a CI run
# of this file would assert nothing about anything CI does — see "Changing this SDLC" in
# docs/sdlc.md.
set -uo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=../worktree-new.sh
WORKTREE_NEW_LIB=1 source ./worktree-new.sh
# The sourced script runs `set -euo pipefail`, which lands in THIS shell. Errexit has to go
# back off or the deliberate failure cases below would abort the suite instead of being asserted.
set +e

pass=0
fail=0

# eq <name> <expected> <actual>
eq() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  ✗ %s\n      expected: %s\n      got:      %s\n' "$name" "$want" "$got"
  fi
}

# fails <name> <command...> — asserts a non-zero exit.
fails() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail=$((fail + 1))
    printf '  ✗ %s — expected non-zero exit\n' "$name"
  else
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  fi
}

echo "worktree-new.sh"

# --- port_for: base + slot * 10 ---
eq "slot 0 is today's backend port" 8000 "$(port_for 8000 0)"
eq "slot 1 backend" 8010 "$(port_for 8000 1)"
eq "slot 3 frontend" 5203 "$(port_for 5173 3)"
eq "slot 2 postgres" 5452 "$(port_for 5432 2)"
eq "slot 1 redis" 6389 "$(port_for 6379 1)"

# --- free_slot: lowest unused slot in 1..SLOT_MAX ---
eq "first worktree gets slot 1" 1 "$(free_slot 0)"
eq "second gets slot 2" 2 "$(free_slot 0 1)"
eq "gaps are reused before growing" 1 "$(free_slot 0 2 3)"
eq "out-of-order input still works" 2 "$(free_slot 3 0 1)"
eq "no claims at all still starts at 1" 1 "$(free_slot)"
fails "an exhausted pool is an error" free_slot 0 1 2 3

# --- project_name: Compose accepts lowercase alnum, dash, underscore ---
eq "uppercase folds" "llmce-slot1-fix-auth" "$(project_name 1 'Fix/Auth')"
eq "dots and spaces go" "llmce-slot2-a-b-c" "$(project_name 2 'a. b c')"

# --- stack_env: the generated .env ---
block="$(stack_env 1 llmce-slot1-thing)"
grep_line() { printf '%s\n' "$block" | grep -m1 "^$1=" || true; }

eq "slot" "STACK_SLOT=1" "$(grep_line STACK_SLOT)"
eq "project" "COMPOSE_PROJECT_NAME=llmce-slot1-thing" "$(grep_line COMPOSE_PROJECT_NAME)"
eq "backend port" "BACKEND_PORT=8010" "$(grep_line BACKEND_PORT)"
eq "frontend port" "FRONTEND_PORT=5183" "$(grep_line FRONTEND_PORT)"
eq "postgres port" "PG_PORT=5442" "$(grep_line PG_PORT)"
eq "redis port" "REDIS_PORT=6389" "$(grep_line REDIS_PORT)"
eq "cors origin" "FRONTEND_ORIGIN=http://localhost:5183" "$(grep_line FRONTEND_ORIGIN)"
eq "host listener" "PORT=8010" "$(grep_line PORT)"
eq "sandbox tag" "SANDBOX_IMAGE=llm-sandbox:slot1" "$(grep_line SANDBOX_IMAGE)"
eq "database" "DATABASE_URL=postgres://app:app@localhost:5442/app" "$(grep_line DATABASE_URL)"
eq "redis url" "REDIS_URL=redis://localhost:6389" "$(grep_line REDIS_URL)"

# The backend's own stackSlotWarnings() check must find nothing to complain about in a file this
# script generated. Every variable that check reads has to be present and consistent, or the very
# first `npm run dev` in a fresh worktree greets you with warnings about the tooling's own output.
for required in STACK_SLOT COMPOSE_PROJECT_NAME BACKEND_PORT FRONTEND_PORT PG_PORT REDIS_PORT \
  FRONTEND_ORIGIN PORT SANDBOX_IMAGE DATABASE_URL REDIS_URL; do
  line="$(grep_line "$required")"
  if [[ -n "$line" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  ✗ generated .env is missing %s\n' "$required"
  fi
done
printf '  ✓ every variable stackSlotWarnings() reads is generated\n'

# --- frontend_env: the generated frontend/.env.local ---
fe="$(frontend_env 2 $'VITE_AUTH0_DOMAIN=example.auth0.com\nVITE_AUTH0_CLIENT_ID=abc\n')"
fe_line() { printf '%s\n' "$fe" | grep -m1 "^$1=" || true; }

eq "auth0 values carried over" "VITE_AUTH0_DOMAIN=example.auth0.com" "$(fe_line VITE_AUTH0_DOMAIN)"
eq "dev port" "VITE_DEV_PORT=5193" "$(fe_line VITE_DEV_PORT)"
eq "api base" "VITE_API_BASE=http://localhost:8020" "$(fe_line VITE_API_BASE)"

# Appending to a value with no trailing newline would splice VITE_DEV_PORT onto the end of the
# last Auth0 value: the audience breaks login and the port is never set at all.
fe_nonl="$(frontend_env 1 'VITE_AUTH0_AUDIENCE=https://api.x.local')"
eq "no-trailing-newline input stays intact" \
  "VITE_AUTH0_AUDIENCE=https://api.x.local" \
  "$(printf '%s\n' "$fe_nonl" | grep -m1 '^VITE_AUTH0_AUDIENCE=')"
eq "and the port still lands" "VITE_DEV_PORT=5183" \
  "$(printf '%s\n' "$fe_nonl" | grep -m1 '^VITE_DEV_PORT=')"

# --- slot_of: reading a claim back out of a generated .env ---
eq "reads its own output" 1 "$(printf '%s\n' "$block" | slot_of)"
eq "a file with no slot claims nothing" "" "$(printf 'PORT=8000\n' | slot_of)"
eq "commented-out slots do not count" "" "$(printf '#STACK_SLOT=2\n' | slot_of)"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
