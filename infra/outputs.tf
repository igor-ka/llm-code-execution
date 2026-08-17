output "registry_url" {
  description = "Docker registry host/path to tag images for. Phase 2 and 3 push here."
  # The provider exports this already — hand-assembling "${var.region}-docker.pkg.dev/…" would be
  # a second copy of Google's URL format, and the copy is the one that goes stale.
  value = google_artifact_registry_repository.app.registry_uri
}

output "runtime_service_account" {
  description = "Email of the identity Cloud Run runs as. Phase 2 passes this to --service-account."
  value       = google_service_account.runtime.email
}

output "sql_connection_name" {
  description = "project:region:instance — what --add-cloudsql-instances takes."
  value       = google_sql_database_instance.main.connection_name
}

output "db_password" {
  description = "Generated application database password. Read once to populate the secret."
  value       = random_password.db.result
  sensitive   = true
}

output "build_service_account" {
  description = "Email of the identity Cloud Build runs as. Pass to `gcloud builds submit --service-account`."
  value       = google_service_account.build.email
}

output "build_source_bucket" {
  description = "gs:// URL for `gcloud builds submit --gcs-source-staging-dir`. The only bucket the build identity can read."
  value       = google_storage_bucket.build_source.url
}

output "workload_identity_provider" {
  description = "Full resource name for google-github-actions/auth's workload_identity_provider input."
  value       = google_iam_workload_identity_pool_provider.github.name
}
