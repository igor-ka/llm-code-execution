# Version pinning is the whole point of this file — nothing else belongs here.
#
# `required_version` is a range, not an exact pin: Terraform refuses to run a state file written
# by a NEWER minor than the binary in hand, so pinning exactly would break the first machine that
# upgraded. The provider constraint `~> 7.42` admits every later 7.x (the lock currently resolves
# 7.44.0) and excludes 8.x — a MAJOR-version constraint, not a minor one. The lock file is what
# pins the exact build; this only bounds what an unlocked resolve may pick.
terraform {
  # `~> 1.15.0`, NOT `~> 1.15`: the two-component form permits 1.16, which can upgrade the
  # state file to a version a 1.15.x workstation cannot read — and CI initializes with
  # `-backend=false`, so it would never catch the mismatch. Bump this and the CI pin together.
  required_version = "~> 1.15.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.42"
    }
  }
}
