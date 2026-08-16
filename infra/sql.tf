# The smallest thing that runs Postgres. db-f1-micro is shared-core: no SLA, and that is the right
# trade for disposable learning data on a fixed budget (~$8-10/mo of the trial credits).
resource "google_sql_database_instance" "main" {
  name             = "app-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    # ENTERPRISE explicitly. The API now defaults new instances to ENTERPRISE_PLUS, which REFUSES
    # shared-core tiers outright:
    #
    #   Error 400: Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition.
    #
    # Its cheapest predefined tier is a performance-optimised machine costing many times the
    # trial's entire monthly burn. Left to the default this line is not a preference — it is the
    # difference between ~$10/mo and blowing the credits on a database nobody queries.
    edition = "ENTERPRISE"
    tier    = "db-f1-micro"

    ip_configuration {
      # A public IP with NOTHING authorised to use it (spec D11).
      #
      # The first draft said "no public IP" and set ipv4_enabled = false. Cloud SQL rejects that
      # outright — "At least one of Public IP or Private IP connectivity must be enabled" — and
      # Cloud Run's built-in connector needs a public IP or a private IP plus Direct VPC egress.
      # Private IP would mean a VPC, a peering range and an egress path, which P2-D3 declines.
      #
      # So the address exists and no network may reach it: every connection is brokered by the
      # Cloud SQL Auth Proxy, authorised by IAM, over TLS. authorized_networks stays EMPTY — an
      # entry here is the one edit that would turn this into a real exposure.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"

      # NO authorized_networks block, and its ABSENCE is the control — it is a block type, not an
      # argument, so there is no `= []` to write. Empty means no address may connect directly.
      # Adding one entry here is the single edit that turns this into a real exposure.
    }

    backup_configuration {
      # Off, deliberately. The spec's Boundaries put backups out of scope: this database holds
      # disposable learning data and the day-91 teardown destroys it regardless. Enabling them
      # would cost storage for a recovery nobody will perform.
      enabled = false
    }
  }

  # The day-91 teardown must not need an edit-and-retry under time pressure (S7). This mirrors the
  # prevent_destroy gate's reasoning for a field that gate does not match.
  deletion_protection = false

  depends_on = [google_project_service.phase1]
}

resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
}

# A password the human never sees and never types. Terraform holds it in state, which is exactly
# where S6 draws its line: state lives in a private, versioned, non-public bucket, and the
# alternative — a human-chosen password pasted through a runbook — is worse in every dimension.
resource "random_password" "db" {
  length = 32
  # No punctuation: this value is interpolated into a postgresql:// URL, and a stray @ or / would
  # silently split the connection string into the wrong host and database.
  special = false
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
