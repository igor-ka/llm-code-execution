# Partial configuration: the bucket name is supplied at init time rather than hardcoded, because
# it derives from the project ID and this root is meant to be reproducible into a fresh project
# (spec S7). See docs/runbooks/gcp-bootstrap.md for the exact init command.
#
# `terraform init -backend=false` — what infra/verify.sh and CI run — skips this block entirely,
# which is what lets the checks run with no credentials and no bucket.
terraform {
  backend "gcs" {
    prefix = "phase1"
  }
}
