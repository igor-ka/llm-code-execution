# Workload Identity Federation: GitHub Actions exchanges its short-lived OIDC token for a GCP
# access token. Spec S9 forbids a long-lived service-account key anywhere, and the surest way to
# honour that is for no key to exist — there is no deployer service account here at all (P1-D4).
# Roles are granted directly to the federated principalSet below.
#
# `data.google_project.this` lives in providers.tf — the project number is needed here and in
# budget.tf, and neither file should own it for the other.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Federated identities for CI in ${var.github_repository}"

  depends_on = [google_project_service.phase1]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  # THE load-bearing line. Without an attribute condition, any GitHub Actions workflow in the
  # world can present a token this pool accepts — GitHub's issuer is shared by every repository
  # on the platform. Google's own guidance is explicit that a condition restricting the issuing
  # organisation is mandatory, not advisory.
  #
  # Numeric IDs, not names: a GitHub login or repository name can be renamed and the old name
  # re-registered by someone else, at which point a name-based condition trusts a stranger. The
  # numeric IDs are permanent.
  #
  # ref/ref_type pin it further to pushes on the default branch, so a token minted by a workflow
  # on a topic branch cannot deploy. The repository being public makes this worth having twice
  # over — though note GitHub already withholds `id-token: write` from fork pull requests, so
  # this is defence in depth rather than the only line.
  attribute_condition = <<-EOT
    assertion.repository_owner_id == "${var.github_owner_id}" &&
    assertion.repository_id == "${var.github_repository_id}" &&
    assertion.ref == "refs/heads/main" &&
    assertion.ref_type == "branch"
  EOT

  # Map only what a condition or a principalSet actually reads. Every extra mapped claim is one
  # more thing an IAM binding elsewhere could accidentally come to depend on.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  # Everything from this repository's main branch, and nothing else. Scoped by attribute.repository
  # rather than principalSet://…/* — the pool-wide form would grant these roles to any identity the
  # pool ever accepts, including a provider added later for something unrelated.
  github_principal = "principalSet://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}

# Push images. Writer, not admin: CI never needs to delete a repository or change its IAM.
resource "google_artifact_registry_repository_iam_member" "ci_writer" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = local.github_principal
}

# Deploy revisions. roles/run.admin is project-scoped, and Phase 1 left a note saying Phase 2
# should narrow it to the service once one existed. Phase 2 looked, and it cannot:
#
# Creating a service is a PROJECT-level permission — there is no resource to scope it to until the
# service exists. And the service does not survive a session: the environment is destroyed between
# working sessions (ADR-0005, the teardown runbook), so a service-scoped binding would be deleted
# along with the service it was attached to, leaving CI unable to recreate it. Narrowing this would
# work exactly once and then break on the first rebuild.
#
# So it stays project-scoped, which is broader than P1-D5 would like, and stated rather than
# hidden. What bounds the blast radius instead is `ci_act_as_runtime` below: run.admin lets this
# identity deploy services, but only running as an account it has actAs on.
resource "google_project_iam_member" "ci_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = local.github_principal
}

# Deploying a service that RUNS AS the runtime account requires actAs on that account. Granted on
# the one account, not project-wide: without this scoping, CI could run code as any service
# account in the project, which is the standard way a deploy pipeline becomes a privilege
# escalation path.
resource "google_service_account_iam_member" "ci_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.github_principal
}

# --- What Phase 3's pipeline needs, on top of the three grants above -----------------------------
#
# Exactly one grant, and the shortness of this list is a decision rather than luck. CI builds the
# image with `docker build` in the runner and pushes it with the artifactregistry.writer above
# (spec D20), so nothing here touches Cloud Build: no builds.create, no actAs on app-build, no
# write on the staging bucket. `gcloud builds submit` stays the by-hand path, run by a human as
# themselves, and app-build's grants in build.tf are unchanged.

# Read the service's own logs after a deploy. The `logs` target of scripts/verify-deployment.sh
# (issue #198) is the only check that can see a boot-time application warning at all — everything else observes the
# service from outside, where a failing-open quota looks identical to a healthy one.
#
# Viewer, not admin: CI never writes, exports or deletes a log.
#
# PROJECT-SCOPED, which P1-D5 would rather it were not, and the reason is structural: Cloud Logging
# has no per-service log resource to bind a role to. What that costs is worth stating plainly rather
# than argued away — roles/logging.viewer also reads the project's Admin Activity audit log, so this
# principal can see the IAM history, and **this repository is public, so anything a workflow prints
# from it lands in a world-readable Actions log.**
#
# Accepted on those terms. The bound is not that the entries are harmless; it is that only the
# deploy pipeline holds this, it reads a single filtered query, and the application's own logger
# redacts row content before anything reaches Cloud Logging. Narrowing it further means a log-view
# binding on _Default — a configuration nothing else in this project uses — and that trade is
# available if the audit-log reach ever matters more than the consistency.
resource "google_project_iam_member" "ci_log_viewer" {
  project = var.project_id
  role    = "roles/logging.viewer"
  member  = local.github_principal
}
