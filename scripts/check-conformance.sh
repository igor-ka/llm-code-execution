#!/usr/bin/env bash
# Proves the verify.sh contract holds for every declared component. It tests the script's
# PLUMBING, never its checks — which is what makes it stack-agnostic: dispatch, exit codes and
# error propagation are identical in a Swift repository and a Terraform one, while the checks
# themselves have nothing in common.
#
# THE TRICK THAT MAKES IT CHEAP. It writes one patched copy of each verify.sh with `false` injected
# as the first statement of EVERY function, then runs targets against that copy. Every run exits
# immediately, so a repository whose targets install dependencies and build images pays nothing —
# and one probe now answers both questions at once:
#
#   exit 64          the dispatcher does not know this target        (a CI step that cannot run)
#   exit 0           it knows it, but the failure did not propagate  (a check that cannot fail)
#   anything else    it knows it, and a failure reaches the status   (correct)
#
# Probing by *running the real target* was the first design and it is wrong for any repository
# whose targets do something. Comparing `--targets` against the declaration instead was the
# second, and it was worse: it verified the script→declaration direction and silently dropped
# declaration→dispatch, so a target listed in TARGETS but missing from the dispatcher passed.
# Both directions are checked here, and neither costs a build.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ACB_CONFIG="${ACB_CONFIG:-.acb.json}"
if [[ ! -f "$ACB_CONFIG" ]]; then
  echo "✗ no $ACB_CONFIG — this check needs one." >&2
  exit 1
fi

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

# One trap for the whole run. A trap set inside the loop is replaced on every iteration, so all
# but the last patched copy would survive a failure.
trap 'rm -f ./*/.acb-conformance.sh' EXIT

for id in $(jq -r '.components[]?.id' "$ACB_CONFIG"); do
  v="$id/verify.sh"

  # 1. It exists and is executable.
  if [[ -x "$v" ]]; then ok "$id: verify.sh is executable"
  else bad "$id: verify.sh is executable" "missing or not +x"; continue; fi

  # 2. Build the patched copy: `false` inside the opening brace of every function.
  #
  #    INSIDE the brace, not printed on the line after it. `install() { run npm ci; }` is a
  #    complete definition on one line, and a `false` printed after it lands at file scope, where
  #    it runs at definition time and aborts the script before dispatch — a non-zero exit for
  #    entirely the wrong reason, which is a pass this check must not award.
  #
  #    EVERY function, not one chosen by name. Naming conventions differ (`target_lint`, `lint_`,
  #    `lint`, `do_the_lint`) and a check that has to guess the name is a check that silently
  #    patches nothing when it guesses wrong — an assertion that then passes on an unrelated
  #    non-zero exit. That is the exact defect this file exists to catch, and it has exhibited it.
  #
  #    Written INSIDE the component directory, not in /tmp: the script's own `cd "$(dirname "$0")"`
  #    is what makes its relative paths work. The original is never written to.
  tmp="$id/.acb-conformance.sh"
  awk '
    /^[A-Za-z_][A-Za-z0-9_:]*[[:space:]]*\([[:space:]]*\)[[:space:]]*\{/ { sub(/\{/, "{ false;") }
    { print }
  ' "$v" > "$tmp"
  chmod +x "$tmp"
  # The patch must have changed something. This is the guard that holds however the conventions
  # evolve: a patch that inserts nothing produces assertions that pass vacuously.
  if cmp -s "$v" "$tmp"; then
    bad "$id: the failure probe patches something" "no function definitions found in $v"
    continue
  fi
  ok "$id: the failure probe patches something"

  # 3. An undeclared target is rejected, and rejected distinguishably. Exit 64 means "unknown
  #    target"; 2 is "declared but not implemented yet", and one shared code makes this vacuous.
  #
  #    FIRST of the runs, deliberately. A dispatcher that falls through to `all` on an unrecognised
  #    argument would otherwise run the whole build when probed with `--targets` below. Against the
  #    patched copy it fails instantly instead, and this assertion is what reports it.
  ( cd "$id" && "./$(basename "$tmp")" __no_such_target__ >/dev/null 2>&1 ); rc=$?
  if [[ $rc -eq 64 ]]; then
    ok "$id: unknown target exits 64"
  else
    bad "$id: unknown target exits 64" \
        "got $rc — either the dispatcher does not use 64, or something outside a function failed first"
    continue
  fi

  # 4. The script's own target list matches the declaration. Read from the ORIGINAL: a consumer may
  #    implement `--targets` as a function, which the patched copy would have disabled. Safe to run
  #    unpatched now that assertion 3 has established unknown arguments exit rather than fall
  #    through. This is the script→declaration direction — a target the script knows and nothing
  #    declares is a check nobody calls.
  declared="$(jq -r --arg i "$id" '.components[]|select(.id==$i)|.targets[]' \
              "$ACB_CONFIG" | LC_ALL=C sort)"
  actual="$( ( cd "$id" && ./verify.sh --targets ) 2>/dev/null | LC_ALL=C sort )"
  if [[ -z "$actual" ]]; then
    bad "$id: --targets agrees with the declaration" \
        "./verify.sh --targets printed nothing — the script does not implement it"
  elif [[ "$declared" == "$actual" ]]; then
    ok "$id: --targets agrees with the declaration"
  else
    bad "$id: --targets agrees with the declaration" \
        "declared [$(echo "$declared" | tr '\n' ' ')] vs --targets [$(echo "$actual" | tr '\n' ' ')]"
  fi

  # 5. Every declared target dispatches, and a failure inside it reaches the exit status. The
  #    declaration→dispatch direction, and the one that costs nothing because the body is `false`.
  #
  #    Be precise about what the propagation half proves, because the tempting overclaim is wrong.
  #    It catches the two structural ways a target becomes unable to fail: a body running without
  #    `errexit`, where an early failure is ignored and a later success sets the status; and a
  #    dispatcher that swallows the target's status (`"target_$1" || true`). It does NOT prove an
  #    individual check can fail — `grep -q x file || true` inside the body still exits 0, and this
  #    will not see it. Detecting that needs mutation of the checks themselves, which is a
  #    different tool. Reviewers catch those; this catches the plumbing that would silence all of
  #    them at once.
  for t in $(jq -r --arg i "$id" '.components[]|select(.id==$i)|.targets[]' "$ACB_CONFIG"); do
    ( cd "$id" && "./$(basename "$tmp")" "$t" >/dev/null 2>&1 ); rc=$?
    if [[ $rc -eq 64 ]]; then
      bad "$id: '$t' dispatches and can fail" "exit 64 — declared, but the dispatcher does not know it"
    elif [[ $rc -eq 0 ]]; then
      bad "$id: '$t' dispatches and can fail" "exit 0 with a planted 'false' — the failure was swallowed"
    else
      ok "$id: '$t' dispatches and can fail"
    fi
  done
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
