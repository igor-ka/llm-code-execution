#!/usr/bin/env bash
# Unit tests for infra/bootstrap.sh, driven by a fake `gcloud` on PATH.
#
# The script was exercised once against a real project, and that proved it worked THAT day. It did
# not protect the next edit — and the first review of it found exactly the regression a live run
# cannot catch: the bucket hardening was applied only on the create branch, so an existing bucket
# kept whatever posture it already had while the script printed success.
#
# So the fake records every gcloud invocation and the assertions read that log. No network, no
# project, no credentials.
set -euo pipefail

cd "$(dirname "$0")"
# Overridable so the suite can be pointed at a modified copy to prove it goes RED — the repo
# standard is that a check nobody has seen fail is not a check.
BOOTSTRAP="${BOOTSTRAP:-$PWD/../bootstrap.sh}"

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "ok   — $1"
}
bad() {
  fail=$((fail + 1))
  echo "FAIL — $1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | sed 's/^/      /'
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Builds a fake gcloud. $1 decides whether `buckets describe` succeeds, i.e. whether the bucket
# already exists. Every call is appended to $work/calls.log.
make_fake_gcloud() {
  local describe_exit="$1"
  mkdir -p "$work/bin"
  local bucket_project="${2:-530312723651}"
  local bucket_location="${3:-US-CENTRAL1}"
  cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"buckets describe"*"projectNumber"*) echo "$bucket_project"; exit 0 ;;
  *"buckets describe"*"location"*)      echo "$bucket_location"; exit 0 ;;
  *"buckets describe"*)                 exit $describe_exit ;;
  *"projects describe"*)                echo "530312723651"; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$work/bin/gcloud"
  : >"$work/calls.log"
}

run_bootstrap() {
  PATH="$work/bin:$PATH" "$BOOTSTRAP" test-project us-central1 >"$work/out.txt" 2>&1
}

logged() { grep -qF -- "$1" "$work/calls.log"; }

# --- the bucket does not exist yet -------------------------------------------------------------
make_fake_gcloud 1
if run_bootstrap; then ok "create path exits 0"; else bad "create path exits 0" "$(cat "$work/out.txt")"; fi
if logged "buckets create gs://test-project-tfstate"; then
  ok "create path creates the bucket"
else
  bad "create path creates the bucket" "$(cat "$work/calls.log")"
fi

# --- the bucket already exists -----------------------------------------------------------------
make_fake_gcloud 0
if run_bootstrap; then ok "existing path exits 0"; else bad "existing path exits 0" "$(cat "$work/out.txt")"; fi
if logged "buckets create"; then
  bad "existing path does not re-create" "$(cat "$work/calls.log")"
else
  ok "existing path does not re-create"
fi

# The regression this file exists for. These four must hold on the ALREADY-EXISTS path, because
# that is the path every run after the first one takes.
if logged "--uniform-bucket-level-access"; then
  ok "existing bucket still gets uniform bucket-level access"
else
  bad "existing bucket still gets uniform bucket-level access" "$(cat "$work/calls.log")"
fi
if logged "--public-access-prevention"; then
  ok "existing bucket still gets public access prevention"
else
  bad "existing bucket still gets public access prevention" "$(cat "$work/calls.log")"
fi
if logged "--versioning"; then
  ok "existing bucket still gets versioning"
else
  bad "existing bucket still gets versioning" "$(cat "$work/calls.log")"
fi
if logged "--lifecycle-file"; then
  ok "existing bucket still gets the lifecycle cap"
else
  bad "existing bucket still gets the lifecycle cap" "$(cat "$work/calls.log")"
fi

# --- the existing bucket belongs to a DIFFERENT project ------------------------------------------
# Bucket names are global, so a describe that succeeds proves visibility, not ownership. Pointing
# state at someone else's bucket survives the day-91 `gcloud projects delete` — a silent leak of
# exactly the kind S7 exists to prevent.
make_fake_gcloud 0 "999999999999" "US-CENTRAL1"
if run_bootstrap; then
  bad "a bucket owned by another project is refused" "$(cat "$work/out.txt")"
else
  ok "a bucket owned by another project is refused"
fi
if logged "--public-access-prevention"; then
  bad "no hardening is applied to a foreign bucket" "$(cat "$work/calls.log")"
else
  ok "no hardening is applied to a foreign bucket"
fi

# --- the existing bucket is in a DIFFERENT region -------------------------------------------------
make_fake_gcloud 0 "530312723651" "EUROPE-WEST1"
if run_bootstrap; then
  bad "a bucket in the wrong region is refused" "$(cat "$work/out.txt")"
else
  ok "a bucket in the wrong region is refused"
fi

# --- region comparison is case-insensitive --------------------------------------------------------
# The API answers US-CENTRAL1; the argument is us-central1. macOS ships bash 3.2, where ${var^^}
# is a syntax error rather than a no-op, so this case also pins the portable implementation.
make_fake_gcloud 0 "530312723651" "us-central1"
if run_bootstrap; then
  ok "region comparison ignores case"
else
  bad "region comparison ignores case" "$(cat "$work/out.txt")"
fi

# --- a gcloud failure must not be swallowed ------------------------------------------------------
# `set -e` is the only thing standing between a failed update and a script that reports success,
# so prove it rather than trust it.
mkdir -p "$work/bin"
cat >"$work/bin/gcloud" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/calls.log"
case "\$*" in
  *"buckets describe"*) exit 0 ;;
  *"buckets update"*)   exit 1 ;;
esac
exit 0
EOF
chmod +x "$work/bin/gcloud"
: >"$work/calls.log"
if run_bootstrap; then
  bad "a failing gcloud update fails the script" "$(cat "$work/out.txt")"
else
  ok "a failing gcloud update fails the script"
fi

# --- a missing project argument is refused --------------------------------------------------------
make_fake_gcloud 1
if PATH="$work/bin:$PATH" "$BOOTSTRAP" >"$work/out.txt" 2>&1; then
  bad "no project argument is refused" "$(cat "$work/out.txt")"
else
  ok "no project argument is refused"
fi

echo
echo "passed: $pass  failed: $fail"
[[ "$fail" -eq 0 ]]
