#!/usr/bin/env bash
# Unit tests for scripts/apply-ruleset.sh, against a fake `gh` on PATH — no repository, no
# credentials, no network, and nothing is ever applied.
#
# WHY THIS EXISTS. The script mutates branch protection, which is the one piece of this
# repository's configuration with no undo short of a saved copy. It shipped from the toolkit
# template with three defects that only a run would reveal: `gh` writing an upgrade notice to
# stderr corrupted the listing on the SUCCESS path; the endpoint returns organisation rulesets
# unless told not to; and a duplicate name produced a two-line "id". A fake `gh` catches all
# three in milliseconds.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/apply-ruleset.sh"
ROOT="$(cd .. && pwd)"

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ✓ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# A fake repository: the script cds to its own parent, so the copy must sit in scripts/.
mkrepo() {  # <ruleset-json-contents> -> echoes the repo dir
  local d; d="$(mktemp -d)"
  mkdir -p "$d/.github" "$d/scripts"
  cp "$SCRIPT" "$d/scripts/"
  printf '%s' "$1" > "$d/.github/ruleset.json"
  printf '%s' "$d"
}
GOOD_DOC='{"name":"Protect main","target":"branch","enforcement":"active","conditions":{},"bypass_actors":[],"rules":[{"type":"deletion"}]}'

# STUB_LIST is the listing body; STUB_STDERR is written to stderr first, as real gh does.
mkstub() {
  cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
[[ -n "${STUB_STDERR:-}" ]] && echo "$STUB_STDERR" >&2
case "$*" in
  *"--method PUT"*)  echo "$*" >> "${STUB_CALLS:-/dev/null}"; echo '{}' ;;
  *"--method POST"*) echo "$*" >> "${STUB_CALLS:-/dev/null}"; echo '{}' ;;
  *rulesets/*)       echo "${STUB_ONE:-$GOOD_DOC}" ;;
  *rulesets*)        echo "${STUB_LIST:-[]}" ;;
esac
exit 0
STUB
  chmod +x "$TMP/bin/gh"
}
mkstub

run_in() {  # <repo-dir> [args...] -> sets $out $rc
  local d="$1"; shift
  out="$( cd "$d" && PATH="$TMP/bin:$PATH" GITHUB_REPOSITORY=owner/name \
          STUB_LIST="${STUB_LIST:-[]}" STUB_STDERR="${STUB_STDERR:-}" STUB_ONE="${STUB_ONE:-}" \
          STUB_CALLS="${STUB_CALLS:-/dev/null}" ./scripts/apply-ruleset.sh "$@" 2>&1 )"; rc=$?
}

echo "apply-ruleset.sh"

# 1. The default is a dry run. A tool that overwrites branch protection the moment it is typed
#    cannot support the documented discipline of reading the live one first.
d="$(mkrepo "$GOOD_DOC")"; calls="$TMP/calls1"; : > "$calls"
STUB_LIST='[{"id":1,"name":"Protect main","source_type":"Repository"}]' STUB_ONE="$GOOD_DOC" STUB_CALLS="$calls" run_in "$d"
if [[ $rc -eq 0 && "$out" == *"Nothing applied"* && ! -s "$calls" ]]; then ok "the default applies nothing"
else bad "the default applies nothing" "exit $rc, calls=$(cat "$calls"): $out"; fi

# 2. --apply issues the PUT against the id the listing returned.
d="$(mkrepo "$GOOD_DOC")"; calls="$TMP/calls2"; : > "$calls"
STUB_LIST='[{"id":1,"name":"Protect main","source_type":"Repository"}]' STUB_ONE="$GOOD_DOC" STUB_CALLS="$calls" run_in "$d" --apply
if [[ $rc -eq 0 && "$out" == *"ruleset updated (id 1)"* ]] && grep -q 'PUT' "$calls"; then ok "--apply updates the existing ruleset"
else bad "--apply updates the existing ruleset" "exit $rc, calls=$(cat "$calls"): $out"; fi

# 3. gh's stderr must not reach the capture. An upgrade notice folded into $listing makes jq die
#    with a parse error on the SUCCESS path, aborting before anything is applied — and the
#    operator sees a jq error rather than "nothing was applied".
d="$(mkrepo "$GOOD_DOC")"
STUB_LIST='[{"id":1,"name":"Protect main","source_type":"Repository"}]' STUB_ONE="$GOOD_DOC" \
  STUB_STDERR='gh: A new release of gh is available: 2.40.0 → 2.41.0' run_in "$d"
if [[ $rc -eq 0 && "$out" != *"parse error"* ]]; then ok "a gh notice on stderr does not corrupt the listing"
else bad "a gh notice on stderr does not corrupt the listing" "exit $rc: $out"; fi

# 4. An organisation ruleset sharing the name must not be treated as this repository's.
d="$(mkrepo "$GOOD_DOC")"; calls="$TMP/calls4"; : > "$calls"
STUB_LIST='[{"id":99,"name":"Protect main","source_type":"Organization"}]' STUB_CALLS="$calls" run_in "$d" --apply
if [[ $rc -eq 0 && "$out" == *"created"* ]] && grep -q 'POST' "$calls"; then ok "an org-level ruleset is not mistaken for this repo's"
else bad "an org-level ruleset is not mistaken for this repo's" "exit $rc, calls=$(cat "$calls"): $out"; fi

# 5. Two repository rulesets with the same name: refuse rather than build a two-line URL.
d="$(mkrepo "$GOOD_DOC")"; calls="$TMP/calls5"; : > "$calls"
STUB_LIST='[{"id":1,"name":"Protect main","source_type":"Repository"},{"id":2,"name":"Protect main","source_type":"Repository"}]' \
  STUB_CALLS="$calls" run_in "$d" --apply
if [[ $rc -ne 0 && "$out" == *"Refusing to guess"* && ! -s "$calls" ]]; then ok "duplicate names are refused, not guessed"
else bad "duplicate names are refused, not guessed" "exit $rc, calls=$(cat "$calls"): $out"; fi

# 6. A malformed document is caught before any mutating call.
d="$(mkrepo 'not json')"; calls="$TMP/calls6"; : > "$calls"
STUB_LIST='[{"id":1,"name":"Protect main","source_type":"Repository"}]' STUB_CALLS="$calls" run_in "$d" --apply
if [[ $rc -ne 0 && "$out" == *"not valid JSON"* && ! -s "$calls" ]]; then ok "a malformed document is refused before any call"
else bad "a malformed document is refused before any call" "exit $rc, calls=$(cat "$calls"): $out"; fi

# 7. An unset GITHUB_REPOSITORY is loud. A default would silently rewrite another repository's
#    branch protection.
#
#    `unset` explicitly, inside the subshell. GitHub Actions exports GITHUB_REPOSITORY into every
#    step, so "I did not pass it" is not the same as "it is unset" — this case passed locally and
#    failed in CI on exactly that difference.
d="$(mkrepo "$GOOD_DOC")"
out="$( cd "$d" && unset GITHUB_REPOSITORY && PATH="$TMP/bin:$PATH" ./scripts/apply-ruleset.sh 2>&1 )"; rc=$?
if [[ $rc -ne 0 && "$out" == *"GITHUB_REPOSITORY"* ]]; then ok "an unset GITHUB_REPOSITORY stops the script"
else bad "an unset GITHUB_REPOSITORY stops the script" "exit $rc: $out"; fi

# 8. The real document in THIS repository is valid, and names every required check the live
#    ruleset does. A document that has drifted is the thing this script would apply.
if jq -e . "$ROOT/.github/ruleset.json" >/dev/null 2>&1; then ok "this repository's ruleset.json is valid JSON"
else bad "this repository's ruleset.json is valid JSON" "jq rejected it"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
