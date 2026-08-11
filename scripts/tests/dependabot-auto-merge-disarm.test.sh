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
HUMAN='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":false,"login":"igor-ka"}}}'
OTHER_BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"is_bot":true,"login":"app/dependabot"}}}'
NONE='{"autoMergeRequest":null}'
# `enabledBy` is a nullable Actor in GraphQL: a deleted account or an uninstalled app.
NULL_ACTOR='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":null}}'
# A gh upgrade that renames or drops the field.
NO_IS_BOT='{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"app/github-actions"}}}'

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
# The indeterminate cases must DISARM and then complain. Exiting without disarming would not be
# failing closed: this workflow is not a required check, so a red job blocks nothing and the PR
# would stay armed and merge. Assert the disarm happened, not just the non-zero exit.
check "enabledBy null disarms"   "$NULL_ACTOR"  0   0  "$V"      1    "auto-merge disarmed"
check "enabledBy null complains" "$NULL_ACTOR"  0   0  "$V"      1    "could not be identified"
check "is_bot absent disarms"    "$NO_IS_BOT"   0   0  "$V"      1    "auto-merge disarmed"
check "indeterminate + gh fails" "$NULL_ACTOR"  0   1  "$V"      1    "FAILED to disarm"
check "disarm call fails"        "$BOT"         0   1  "$V"      1    "FAILED to disarm"
check "gh pr view fails"         "$NONE"        4   0  "$V"      1    "refusing to assume"

if [[ "$fails" -gt 0 ]]; then
  echo
  echo "$fails case(s) failed."
  exit 1
fi
echo
echo "All disarm cases pass."
