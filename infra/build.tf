# The identity that BUILDS the image, and the only bucket it can touch.
#
# `gcloud builds submit` needs a service account, and new projects no longer get the legacy Cloud
# Build one. The obvious substitute is the Compute Engine default account — which holds project
# **Editor**. Build steps are defined by `cloudbuild.yaml`, a repository file, so running them as
# Editor means anything that lands in this repo executes with authority over the whole project.
# That is a supply-chain path into the project, not a convenience.
#
# This account starts with nothing and gets exactly three grants: write logs, push to the one
# Artifact Registry repository, and read/write the one staging bucket below.
resource "google_service_account" "build" {
  account_id   = "app-build"
  display_name = "Cloud Build identity"
  description  = "Builds the llm-code-execution image. Cannot deploy, cannot read Terraform state."

  depends_on = [google_project_service.phase1]
}

# A dedicated staging bucket, and the reason it exists rather than gcloud's default.
#
# `gcloud builds submit` uploads the source tree to `gs://<project>_cloudbuild` unless told
# otherwise. Granting the build account object access to that bucket is fine; granting it
# PROJECT-level storage access to reach it is not, because the Terraform state bucket lives in the
# same project and state holds the generated Cloud SQL password in cleartext. A build step could
# read it.
#
# So the grant is per-bucket, which means the bucket has to be a resource here — the gcloud default
# is created implicitly on first submit and is not owned by anything, so it would survive
# `terraform destroy` and be missing on a fresh project. The deploy runbook passes
# `--gcs-source-staging-dir` to point at this one.
resource "google_storage_bucket" "build_source" {
  name     = "${var.project_id}-build-source"
  location = var.region
  project  = var.project_id

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Source snapshots are worth nothing an hour after the build. This is also the cost control:
  # without it every submit leaves another copy of the repository behind forever.
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }

  # Uploaded source is disposable and the bucket is recreated by apply, so a destroy that has to
  # stop and ask about leftover objects is pure friction.
  force_destroy = true
}

resource "google_storage_bucket_iam_member" "build_source_writer" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.build.email}"
}

# Push the built image. Writer, not admin: a build never needs to delete a repository or rewrite
# its IAM. Repository-scoped, matching the CI grant in wif.tf.
resource "google_artifact_registry_repository_iam_member" "build_writer" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}

# Build logs. Project-scoped because log sinks are, and `cloudbuild.yaml` sets
# `logging: CLOUD_LOGGING_ONLY` — without this the submit fails before the first step runs.
resource "google_project_iam_member" "build_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.build.email}"
}

# Deliberately NOT granted: roles/run.admin or roles/run.developer, and actAs on the runtime
# account. Building and deploying are separate steps performed by separate identities — this one
# produces an image and cannot put it in front of traffic. `gcloud run deploy` is run by a human
# (the deploy runbook) or by the federated GitHub identity in wif.tf.
#
# The two values the deploy runbook needs from here are exported in outputs.tf.
