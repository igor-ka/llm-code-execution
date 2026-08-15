# user_project_override + billing_project are NOT optional here, and the reason is easy to miss.
# The Billing Budgets API (budget.tf) rejects Application Default Credentials — the `gcloud auth
# application-default login` path a laptop uses — with a 403 unless requests carry a quota project.
# Without these two lines every `terraform apply` that touches a budget fails with a permissions
# error that reads like a missing IAM role and is not one.
provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

# The project NUMBER — distinct from the ID, and unavoidable: principalSet strings (wif.tf) and
# budget filters (budget.tf) are both defined in terms of the number. Declared here rather than in
# whichever file first needed it, so neither of those files owns a dependency the other has.
#
# Read at plan time via cloudresourcemanager.googleapis.com, which is enabled by hand in the
# plan's Prerequisites — because this data source is read BEFORE apis.tf can enable anything, and
# user_project_override bills the read to this project. `terraform validate` never reads it, which
# is why CI needs no credentials.
data "google_project" "this" {
  project_id = var.project_id
}
