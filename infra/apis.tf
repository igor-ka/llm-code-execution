# Exactly the APIs Phase 1 uses. Phase 2 enables its own (run, sqladmin, servicenetworking) in its
# own plan — an unused enabled API is not a cost, but it is an unexplained line in a review.
locals {
  # iamcredentials: token exchange for Workload Identity Federation.
  # sts: the endpoint WIF trades an OIDC token at.
  # Comments sit above the list, not as trailing comments inside it: `terraform fmt` aligns a run
  # of trailing comments and breaks the run at any line without one, so a partly-commented list
  # reformats on the first `fmt -check` and reddens the gate.
  phase1_apis = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "compute.googleapis.com",
    "memorystore.googleapis.com",
    "networkconnectivity.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_project_service" "phase1" {
  for_each = toset(local.phase1_apis)

  project = var.project_id
  service = each.value

  # Destroying the project's API enablement on `terraform destroy` is the wrong default here.
  # Enabled APIs cost nothing, disabling one can fail while dependent resources still exist, and
  # the day-91 teardown deletes the whole project anyway. Leaving them on keeps destroy boring.
  disable_on_destroy = false
}
