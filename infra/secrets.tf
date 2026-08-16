# CONTAINERS ONLY. No google_secret_manager_secret_version appears in this repository, and
# infra/verify.sh fails if one ever does (spec S6): a version resource puts the plaintext in
# Terraform state, in every plan output, and in any CI log that prints a plan. Payloads are added
# with `gcloud secrets versions add` — see docs/runbooks/gcp-bootstrap.md.
#
# The consequence is deliberate and belongs in the runbook, not in a surprise: `terraform destroy`
# removes the containers and every version with them, so a rebuild re-runs the population step.
locals {
  # Named for what the backend reads them as, so the mapping to backend/src/config.ts is obvious
  # at a glance and Phase 2's --set-secrets flags write themselves.
  secrets = {
    "anthropic-api-key" = "ANTHROPIC_API_KEY — Claude API key used for generation and judgment"
    "database-url"      = "DATABASE_URL — Cloud SQL connection string for chat history"
    "redis-url"         = "REDIS_URL — Upstash connection string; the backend refuses to boot without it"
    "oidc-audience"     = "OIDC_AUDIENCE — Auth0 API identifier"
    "oidc-issuer"       = "OIDC_ISSUER — Auth0 tenant issuer URL, with its trailing slash"
    # Not derived from the issuer anywhere in the backend: config.ts reads OIDC_JWKS_URL with an
    # empty default and auth.ts hands it straight to jwksFor(). Omit this container and a Phase 2
    # deploy wired from this list verifies exactly zero tokens.
    "oidc-jwks-url" = "OIDC_JWKS_URL — Auth0 JWKS endpoint"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = local.secrets

  secret_id = each.key
  labels    = { component = "backend" }

  replication {
    # Automatic replication rather than pinning to var.region: Secret Manager charges per
    # replica-location for user-managed replication and nothing extra for automatic, and there is
    # no data-residency requirement here (P1-D1 already accepted US storage).
    auto {}
  }

  # Explicitly false. The default has changed across provider majors, and a secret that refuses to
  # delete would block the day-91 teardown — the same failure the prevent_destroy gate exists to
  # catch, arriving through a different door.
  deletion_protection = false

  depends_on = [google_project_service.phase1]
}

# One binding per secret, not one project-level role. There are six here; if a seventh is added
# later for some unrelated component, the runtime account does not silently gain access to it.
resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
