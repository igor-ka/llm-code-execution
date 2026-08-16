variable "project_id" {
  type        = string
  description = "The GCP project ID. No default: this must be supplied per environment."

  validation {
    # Google's own rule. Caught here, it is one line of output; caught by the API it is a failed
    # apply partway through a dependency graph.
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be 6-30 chars of lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit."
  }
}

variable "region" {
  type        = string
  description = "The single region every regional resource uses (P1-D1)."
  default     = "us-central1"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID in NNNNNN-NNNNNN-NNNNNN form, for the budget alarms."
}

variable "trial_start_date" {
  type        = string
  description = <<-EOT
    The date the $300/90-day trial was activated, as YYYY-MM-DD. This is what makes the
    credit-burn budget measure the TRIAL rather than a calendar month — see budget.tf. It is also
    the input to the day-91 teardown, so it is recorded in docs/runbooks/gcp-bootstrap.md too.
  EOT

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.trial_start_date))
    error_message = "trial_start_date must be YYYY-MM-DD."
  }
}

variable "github_owner_id" {
  type        = string
  description = <<-EOT
    Numeric GitHub account ID of the repository owner. Numeric, not the login name: logins can be
    renamed and re-registered by someone else, and an attribute condition written against a name
    would then trust the wrong account.
  EOT
}

variable "github_repository_id" {
  type        = string
  description = "Numeric GitHub repository ID, for the same reason as github_owner_id."
}

variable "github_repository" {
  type        = string
  description = <<-EOT
    owner/repo. SECURITY-SENSITIVE: this is interpolated into local.github_principal as
    attribute.repository/<value>, so it decides which repository's Actions may assume the roles
    granted in wif.tf. It is a trust boundary, not a label.

    Renaming the repository on GitHub breaks federation until this value is updated and applied —
    the numeric github_repository_id keeps the OWNER pinned across a rename, but the principalSet
    matches on this string.
  EOT
}

variable "billing_currency" {
  type    = string
  default = "CAD"
  description = <<-EOT
    ISO currency of the billing account, which a budget MUST match. Google rejects any other with
    a bare `INVALID_ARGUMENT` that names no field — a minimal budget fails identically to a
    complex one, so it is worth knowing where to look.

    Read it with: gcloud billing accounts describe <ACCOUNT_ID> --format='value(currencyCode)'
  EOT
}

variable "trial_credit_amount" {
  type    = string
  default = "300"
  description = <<-EOT
    Size of the free-trial grant, in billing_currency, for the credit-burn budget to measure
    against. Google advertises the trial as "$300 USD or local equivalent", so on a non-USD
    account the granted number is NOT necessarily 300 — check the console's billing credits page
    and set this to what it actually says.

    Erring LOW is the safe direction: the alarm fires earlier than the credits run out.
  EOT
}
