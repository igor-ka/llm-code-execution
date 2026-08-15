#!/usr/bin/env bash
# Create the GCS bucket that holds Terraform's state. This is the ONE resource Terraform does not
# manage, and the reason is structural rather than stylistic (plan P1-D2): a bucket managed by the
# state it stores makes every `terraform destroy` a special case, and spec S7's "zero billable
# resources" would then rest on remembering a manual `terraform state rm` under time pressure.
#
# The teardown runbook (docs/runbooks/gcp-teardown.md) deletes this bucket as its final step.
#
# Idempotent: safe to re-run. Usage: ./bootstrap.sh <project-id> [region]
set -euo pipefail

project="${1:?usage: ./bootstrap.sh <project-id> [region]}"
region="${2:-us-central1}"
bucket="${project}-tfstate"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install it: brew install google-cloud-sdk" >&2
  exit 1
fi

# No --project on describe: bucket names are global, and the flag is not accepted here.
if gcloud storage buckets describe "gs://${bucket}" >/dev/null 2>&1; then
  echo "==> gs://${bucket} already exists"
else
  echo "==> creating gs://${bucket}"
  gcloud storage buckets create "gs://${bucket}" \
    --project "$project" \
    --location "$region"
fi

# Applied on EVERY run, not only at creation. "Idempotent" has to mean the bucket converges on the
# promised posture, not merely that the script exits 0: a bucket that already exists — made by
# hand, by an older version of this script, or by a teammate — would otherwise keep ACLs and
# public access exactly as they were while this prints success and Terraform writes state naming
# every resource in the project into it.
#
# --uniform-bucket-level-access: ACLs are legacy and make "who can read this" unanswerable.
# --public-access-prevention: state names every resource in the project. Never public.
echo "==> enforcing uniform bucket-level access and public access prevention"
gcloud storage buckets update "gs://${bucket}" \
  --uniform-bucket-level-access \
  --public-access-prevention

# Versioning is the undo button for a corrupted or truncated state file, which is the one failure
# in Terraform with no other recovery path.
echo "==> enabling object versioning"
gcloud storage buckets update "gs://${bucket}" --versioning

# Without a lifecycle rule, every apply keeps a noncurrent version forever. 10 is far more history
# than this project will ever need and keeps the bucket's cost at effectively zero.
echo "==> capping noncurrent versions at 10"
lifecycle="$(mktemp)"
trap 'rm -f "$lifecycle"' EXIT
cat >"$lifecycle" <<'JSON'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"numNewerVersions": 10}
    }
  ]
}
JSON
gcloud storage buckets update "gs://${bucket}" --lifecycle-file="$lifecycle"

echo
echo "==> done. Backend config:"
echo "    bucket = \"${bucket}\""
