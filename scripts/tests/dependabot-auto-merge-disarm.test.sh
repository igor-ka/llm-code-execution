#!/usr/bin/env bash
# Tests the disarm logic in .github/workflows/dependabot-auto-merge.yml.
#
# WHY THIS FILE IS SHAPED ODDLY. The script under test lives inline in a workflow, not in
# `scripts/`, and it has to stay there: the job that runs it holds the only writable GITHUB_TOKEN
# in this repository's CI, and running a repository script would mean checking the PR branch out
# into that job. So this test EXTRACTS the script from the YAML rather than importing it. The copy
# under test is therefore always the one that ships — there is no second copy to drift.
#
# WHERE IT RUNS. The `SDLC docs` job, which is a host rather than the owner: the auto-merge
# workflow gates itself to `dependabot/npm_and_yarn/*` branches, so a PR that edits it never
# executes it, and this test would otherwise have nowhere to run. `SDLC docs` already has a
# checkout and a read-only token and runs on every pull request. Locally:
#
#     ./scripts/tests/dependabot-auto-merge-disarm.test.sh
#
# WHY A STUB `gh` THAT RUNS REAL JQ. The stub does not return a hand-written answer; it runs the
# actual `--jq` expression the script passes, over payloads captured from real `gh` output. That
# distinction is the entire lesson of the `app/github-actions` bug: a hand-written stub can only
# encode what the author already believes, and the author believed the login was
# `github-actions[bot]`. A captured payload encodes what GitHub actually sends.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
WORKFLOW=".github/workflows/dependabot-auto-merge.yml"
[[ -f "$WORKFLOW" ]] || { echo "FAIL: $WORKFLOW not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Extract the `run:` block of the step whose name starts "Disarm", dedented. No YAML library:
# this runs on a bare macOS/Linux shell, and BWK awk (macOS /usr/bin/awk) is the floor — no
# interval expressions, no gensub.
awk '
  /^ *- name: Disarm/     { found = 1; next }
  found && /^ *run: \|/   { inrun = 1; indent = -1; next }
  inrun {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    match($0, /^ */)
    if (indent < 0) indent = RLENGTH
    if (RLENGTH < indent) exit
    print substr($0, indent + 1)
  }
' "$WORKFLOW" > "$TMP/disarm.sh"

[[ -s "$TMP/disarm.sh" ]] || { echo "FAIL: extracted an empty script — did the step name change?"; exit 1; }
grep -q 'disable-auto' "$TMP/disarm.sh" || { echo "FAIL: extracted script has no --disable-auto call"; exit 1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# FIXTURE holds a real `gh pr view --json autoMergeRequest` payload. VIEW_RC / DISABLE_RC force
# the failure paths.
case "$2" in
  view)
    [[ "${VIEW_RC:-0}" -ne 0 ]] && exit "${VIEW_RC}"
    expr=""
    while [[ $# -gt 0 ]]; do
      [[ "$1" == "--jq" ]] && expr="$2"
      shift
    done
    printf '%s' "${FIXTURE}" | jq -r "${expr}"
    exit $?
    ;;
  merge) exit "${DISABLE_RC:-0}" ;;
esac
exit 9
STUB
chmod +x "$TMP/bin/gh"

# Captured 2026-08-10 from PR #117, after the workflow armed it. Note `app/github-actions` —
# NOT `github-actions[bot]`, which is what the first implementation compared against.
BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"app/github-actions"}}}'
HUMAN='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":false,"login":"a-human"}}}'
OTHER_BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"app/dependabot"}}}'
NONE='{"autoMergeRequest":null}'
# `enabledBy` is a nullable Actor in GraphQL: a deleted account or an uninstalled app.
NULL_ACTOR='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":null}}'
# A gh upgrade that renames or drops the field.
NO_IS_BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"app/github-actions"}}}'
# Arming moved to a GitHub App, so the login this workflow must recognise as its own moved with it.
# The legacy pair stays matchable for PRs armed before that change; these two are the new shape.
APP_BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"app/example-automerge"}}}'
APP_BOT_BARE='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"example-automerge"}}}'

fails=0
check() { # name fixture view_rc disable_rc verdict want_exit want_substring
  local name="$1" fixture="$2" vrc="$3" drc="$4" verdict="$5" want_exit="$6" want="$7"
  local out got
  # `local out=$(...)` would swallow the exit status — keep the capture on its own line.
  out="$(PATH="$TMP/bin:$PATH" PR_URL="https://example.invalid/pr/1" GH_TOKEN=x \
         VERDICT="$verdict" FIXTURE="$fixture" VIEW_RC="$vrc" DISABLE_RC="$drc" \
         bash -e "$TMP/disarm.sh" 2>&1)"
  got=$?
  if [[ "$got" -ne "$want_exit" ]]; then
    printf 'FAIL %-28s exit %s, wanted %s\n%s\n' "$name" "$got" "$want_exit" "$out"
    fails=$((fails + 1))
    return
  fi
  if [[ "$out" != *"$want"* ]]; then
    printf 'FAIL %-28s output missing %q\n%s\n' "$name" "$want" "$out"
    fails=$((fails + 1))
    return
  fi
  printf 'ok   %-28s exit=%s\n' "$name" "$got"
}

V="not-eligible: at least one dependency is not patch or minor"

#     name                       fixture       vrc drc verdict  exit  expected substring
check "not armed"                "$NONE"        0   0  "$V"      0    "nothing to disarm"
check "armed by this workflow"   "$BOT"         0   0  "$V"      0    "auto-merge disarmed"
check "disarm reports the why"   "$BOT"         0   0  "$V"      0    "$V"
check "gate failed: still disarms" "$BOT"       0   0  ""        0    "eligibility is unknown"
check "armed by a human"         "$HUMAN"       0   0  "$V"      0    "leaving it alone"
check "armed by another bot"     "$OTHER_BOT"   0   0  "$V"      0    "leaving it alone"
# The regression this PR would otherwise have shipped: arming moved to the App, the disarm check
# did not, so the workflow could no longer recognise its own arming and left ineligible PRs armed.
APP_SLUG=example-automerge \
  check "armed by the App"         "$APP_BOT"     0   0  "$V"      0    "auto-merge disarmed"
APP_SLUG=example-automerge \
  check "armed by the App (bare)"  "$APP_BOT_BARE" 0  0  "$V"      0    "auto-merge disarmed"
# Legacy arming must stay matchable: PRs armed before the App existed are still open.
APP_SLUG=example-automerge \
  check "legacy arming still matches" "$BOT"      0   0  "$V"      0    "auto-merge disarmed"
# Without a slug the App's login is unrecognisable, and the documented behaviour is to leave an
# unrecognised bot alone rather than revoke what may be a maintainer's decision.
check "App arming, no slug known" "$APP_BOT"      0   0  "$V"      0    "leaving it alone"
# The indeterminate cases must DISARM and then complain. Exiting without disarming would not be
# failing closed: this workflow is not a required check, so a red job blocks nothing and the PR
# would stay armed and merge. Assert the disarm happened, not just the non-zero exit.
check "enabledBy null disarms"   "$NULL_ACTOR"  0   0  "$V"      1    "auto-merge disarmed"
check "enabledBy null complains" "$NULL_ACTOR"  0   0  "$V"      1    "could not be identified"
check "is_bot absent disarms"    "$NO_IS_BOT"   0   0  "$V"      1    "auto-merge disarmed"
check "indeterminate + gh fails" "$NULL_ACTOR"  0   1  "$V"      1    "FAILED to disarm"
check "disarm call fails"        "$BOT"         0   1  "$V"      1    "FAILED to disarm"
check "gh pr view fails"         "$NONE"        4   0  "$V"      1    "refusing to assume"

# --- Step ordering in the gate job ---
#
# The ecosystem allow-list MUST evaluate before dependabot/fetch-metadata runs. On `pull_request`
# the workflow is read from the merge ref, so a `dependabot/github_actions/…` PR that bumps the
# fetch-metadata pin would otherwise execute the REPLACEMENT action and only afterwards reach a
# rule rejecting it — rejecting on metadata the action itself produced is too late by
# construction. That ordering used to be guaranteed by a job-level `if:`; it is now a step, and
# nothing but this assertion holds it in place.
# Relative to the cwd this suite already established (line 24 cds to the repository root), not
# to $0 — which is the invocation path and no longer resolves after that cd.
WF=".github/workflows/dependabot-auto-merge.yml"
eco_line="$(grep -n 'name: Check the ecosystem is allowed' "$WF" | cut -d: -f1)"
fm_line="$(grep -n 'uses: dependabot/fetch-metadata' "$WF" | cut -d: -f1)"
if [[ -n "$eco_line" && -n "$fm_line" && "$eco_line" -lt "$fm_line" ]]; then
  printf 'ok   %-28s\n' "allow-list precedes fetch-metadata"
else
  printf 'FAIL %-28s ecosystem@%s fetch-metadata@%s\n' \
    "allow-list precedes fetch-metadata" "${eco_line:-absent}" "${fm_line:-absent}"
  fails=$((fails + 1))
fi

# Every step after the allow-list must be gated on its verdict, or a skip verdict would let the
# rest of the job run anyway.
gated="$(grep -c "steps.ecosystem.outputs.verdict == 'allowed'" "$WF")"
if [[ "$gated" -ge 2 ]]; then
  printf 'ok   %-28s\n' "later steps gated on the verdict"
else
  printf 'FAIL %-28s only %s step(s) gated\n' "later steps gated on the verdict" "$gated"
  fails=$((fails + 1))
fi

# --- The gate's verdict expression -------------------------------------------------------------
#
# Extracted and RUN, not read. The allow-list moved into this jq when it moved into a repository
# variable, and a `.` that means the wrong thing inside a pipe is invisible to review and to the
# ordering assertions above — the step fails closed, so the only symptom is that nothing ever
# auto-merges again. The same awk shape as the disarm extraction; only the step name differs.
awk '
  /^ *- name: Decide whether this PR may auto-merge/ { found = 1; next }
  found && /^ *run: \|/   { inrun = 1; indent = -1; next }
  inrun {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    match($0, /^ */)
    if (indent < 0) indent = RLENGTH
    if (RLENGTH < indent) exit
    print substr($0, indent + 1)
  }
' "$WORKFLOW" > "$TMP/gate.sh"
[[ -s "$TMP/gate.sh" ]] || { echo "FAIL: extracted an empty gate script — did the step name change?"; exit 1; }

# verdict <allowed> <commits> <deps-json> -> echoes the verdict, or "STEP-FAILED"
verdict() {
  local out
  : > "$TMP/gh_output"
  # `bash -e`, as GitHub invokes a run: block (`shell: /usr/bin/bash -e {0}`) and as the disarm
  # harness above does. The extracted script sets its own `-euo pipefail` today; running it under
  # a plain shell would mean that if someone ever removed that line — reasoning that GitHub
  # supplies -e already — the step would still fail closed on GitHub while this suite quietly
  # stopped checking that it does.
  if out="$( ALLOWED="$1" PR_COMMITS="$2" DEPS_JSON="$3" GITHUB_OUTPUT="$TMP/gh_output" \
             bash -e "$TMP/gate.sh" 2>&1 )"; then
    sed -n 's/^verdict=//p' "$TMP/gh_output"
  else
    echo "STEP-FAILED: $out"
  fi
}

PATCH='[{"dependencyName":"a","packageEcosystem":"npm_and_yarn","updateType":"version-update:semver-patch"}]'
MAJOR='[{"dependencyName":"a","packageEcosystem":"npm_and_yarn","updateType":"version-update:semver-major"}]'
ACTIONS='[{"dependencyName":"a","packageEcosystem":"github_actions","updateType":"version-update:semver-patch"}]'
MIXED='[{"dependencyName":"a","packageEcosystem":"npm_and_yarn","updateType":"version-update:semver-patch"},
        {"dependencyName":"b","packageEcosystem":"github_actions","updateType":"version-update:semver-patch"}]'

# Substring matching for the not-eligible reasons, EXACT for "eligible" — because "eligible" is a
# substring of every "not-eligible: …" verdict, so a substring assertion on the positive path
# passes when the gate has inverted. Those two cases are the only ones covering the decision that
# arms an unattended merge, which is the worst place to hold a vacuous assertion.
vcheck() { # name expected allowed commits deps
  local got; got="$(verdict "$3" "$4" "$5")"
  local hit=1
  if [[ "$2" == "eligible" ]]; then [[ "$got" == "eligible" ]] && hit=0
  else [[ "$got" == *"$2"* ]] && hit=0; fi
  if [[ $hit -eq 0 ]]; then printf 'ok   %-40s\n' "$1"
  else printf 'FAIL %-40s expected %q, got %q\n' "$1" "$2" "$got"; fails=$((fails + 1)); fi
}

vcheck "an allowed patch bump is eligible"      "eligible"                    "npm_and_yarn" 1 "$PATCH"
vcheck "a major bump is not"                    "not patch or minor"          "npm_and_yarn" 1 "$MAJOR"
vcheck "an ecosystem outside the list is not"   "outside the allow-list"      "npm_and_yarn" 1 "$ACTIONS"
vcheck "one disallowed entry rejects the lot"   "outside the allow-list"      "npm_and_yarn" 1 "$MIXED"
# An unset variable allows nothing — the right default for a repository that has not decided.
vcheck "an empty allow-list allows nothing"     "outside the allow-list"      ""             1 "$PATCH"
# Two ecosystems allowed, and the second one used.
vcheck "a second allowed ecosystem works"       "eligible"                    "npm_and_yarn github_actions" 1 "$ACTIONS"
# The one-commit rule, which does not reach jq at all.
vcheck "more than one commit is not eligible"   "only the first is verified"  "npm_and_yarn" 3 "$PATCH"
vcheck "non-array metadata is handled"          "no dependency metadata"      "npm_and_yarn" 1 '{}'

# --- The write-scoped job must not run for a rejected ecosystem ---------------------------------
#
# `gate` runs for every `dependabot/*` branch. When the allow-list rejects the ecosystem its later
# steps skip, but a job whose steps skip still reports `success` — so `needs.gate.result !=
# 'skipped'` is TRUE and `apply` would run. `apply` holds contents:write and the App private key,
# and its first step executes a third-party action read from the merge ref: precisely the pull
# request that bumps that action's pin. Nothing else in this file would notice.
apply_if="$(awk '/^  apply:/ { inapply = 1 } inapply && /^    if:/ { print; exit }' "$WORKFLOW")"
if [[ "$apply_if" == *"needs.gate.outputs.ecosystem != 'skip'"* ]]; then
  printf 'ok   %-40s\n' "apply is gated on the ecosystem verdict"
else
  printf 'FAIL %-40s got %q\n' "apply is gated on the ecosystem verdict" "$apply_if"
  fails=$((fails + 1))
fi

# The clause above is only meaningful if the verdict is actually published as a job output.
# shellcheck disable=SC2016  # ${{ }} is GitHub Actions syntax being matched, not a shell expansion
if grep -q 'ecosystem: ${{ steps.ecosystem.outputs.verdict }}' "$WORKFLOW"; then
  printf 'ok   %-40s\n' "the ecosystem verdict is a job output"
else
  printf 'FAIL %-40s\n' "the ecosystem verdict is a job output"
  fails=$((fails + 1))
fi

# And only if the disarm path still runs when the gate HARD-FAILS, where the ecosystem output is
# 'allowed' and the verdict is empty. `!= 'skip'` keeps that path; `== 'allowed'` would too, but a
# future edit to `== 'eligible'` would silently make disarming fail open.
if [[ "$apply_if" == *"!cancelled()"* ]]; then
  printf 'ok   %-40s\n' "a failed gate still reaches disarm"
else
  printf 'FAIL %-40s got %q\n' "a failed gate still reaches disarm" "$apply_if"
  fails=$((fails + 1))
fi

if [[ "$fails" -gt 0 ]]; then
  echo
  echo "$fails case(s) failed."
  exit 1
fi
echo
echo "All disarm cases pass."
