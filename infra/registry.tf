resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "app"
  description   = "Container images for ${var.github_repository}"
  format        = "DOCKER"

  # Cleanup policies are not cosmetic on a fixed budget. Every pushed image is billed storage for
  # as long as it exists, and a CD pipeline (Phase 3) pushes one per merge. Untagged layers left
  # behind by a re-tag are pure waste.
  #
  # dry_run = false means these DELETE. That is intended: nothing here is a release artifact worth
  # keeping — Phase 2 deploys by hand from a tag, and a lost image is one `docker push` away.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state = "UNTAGGED"
      # A grace period, not zero: an untagged image is briefly the normal state during a push,
      # and deleting one mid-push is a race the registry should not be asked to win.
      older_than = "604800s" # protobuf Duration — a "7d" suffix is rejected
    }
  }

  # Without this, nothing above ever deletes a tagged image. A KEEP policy only PROTECTS artifacts
  # from DELETE policies — it deletes nothing on its own — so keep-recent-releases paired only with
  # delete-untagged would let every tagged image accumulate forever, which is the opposite of this
  # block's stated purpose. This is the policy that does the work; keep-recent-releases is what
  # stops it from eating the newest five.
  cleanup_policies {
    id     = "delete-old-tagged"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "2592000s" # protobuf Duration — a "30d" suffix is rejected
    }
  }

  depends_on = [google_project_service.phase1]
}
