# Memorystore for Valkey — the quota store (spec D17, superseding D8's Upstash).
#
# Valkey rather than Memorystore for Redis: node-priced instead of per-GiB, so the smallest node
# (SHARED_CORE_NANO, ~CAD 0.045/hr) undercuts Redis Basic's 1 GiB floor (~CAD 0.069/GiB-hr) by
# roughly a third. Google has also frozen Memorystore for Redis on 7.2 and moved development to
# Valkey. It speaks the same protocol, so `RedisQuotaStore` and the `redis` npm client are
# unchanged — the swap is infrastructure, not application code.
#
# THE COST MODEL IS TEARDOWN-WHEN-IDLE. This node bills per hour of EXISTENCE, not of use, and
# Memorystore has no "stop" — only delete. Left running it is ~CAD 33/month; destroyed between
# work sessions it is ~CAD 3/month at ten hours a week. `terraform destroy` is therefore not an
# end-of-project ritual here, it is the normal end of a working session. See
# docs/runbooks/gcp-teardown.md.

# Valkey is reachable only over Private Service Connect, which needs a VPC to attach to. This is
# the complexity P2-D3 avoided for Cloud SQL by using the built-in connector — there is no
# equivalent for Memorystore, so the VPC arrives here or Valkey does not work at all.
resource "google_compute_network" "main" {
  name = "app-net"
  # No auto subnets: they create one per region in every region Google has, which is a lot of
  # address space and a lot of things to read past when auditing what exists.
  auto_create_subnetworks = false

  depends_on = [google_project_service.phase1]
}

resource "google_compute_subnetwork" "main" {
  name          = "app-subnet"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.0.0.0/24"
}

# Lets Memorystore create its own PSC endpoints in the subnet above, rather than requiring an
# endpoint to be reserved by hand before the instance exists. Without it, instance creation fails
# with a message about no service connection policy for the network.
resource "google_network_connectivity_service_connection_policy" "valkey" {
  name          = "valkey-psc"
  location      = var.region
  service_class = "gcp-memorystore"
  network       = google_compute_network.main.id

  psc_config {
    subnetworks = [google_compute_subnetwork.main.id]
  }

  depends_on = [google_project_service.phase1]
}

resource "google_memorystore_instance" "quota" {
  instance_id = "app-valkey"
  location    = var.region

  # The smallest node Memorystore offers, and one shard with no replicas. The quota store holds a
  # handful of counters keyed on the verified `sub`, each with a TTL — this is orders of magnitude
  # more memory than it needs, and it is still the cheapest thing available.
  node_type   = "SHARED_CORE_NANO"
  shard_count = 1
  # Zero replicas: a replica doubles the bill to protect a counter whose loss costs one window of
  # unmetered requests. ADR-0003's fail-open posture already accepts that outcome.
  replica_count = 0

  desired_psc_auto_connections {
    network    = google_compute_network.main.id
    project_id = var.project_id
  }

  # The day-91 teardown, and every idle-time teardown, must not need an edit-and-retry.
  deletion_protection_enabled = false

  depends_on = [google_network_connectivity_service_connection_policy.valkey]
}


output "valkey_endpoint" {
  description = "host:port for REDIS_URL. Changes on every rebuild — repopulate the secret after."
  # A flat "10.0.0.2:6379". The raw attribute is a list of endpoints, each holding a list of
  # connections, each holding a list of psc_auto_connection — so `terraform output -raw` on it
  # fails with "complex type", which is the wrong thing to discover mid-rebuild.
  #
  # The DISCOVERY connection is selected by name, not by position: the instance also exposes a
  # second connection (10.0.0.3) with no connection_type and port 0, and taking [0] would be a
  # coin flip that happens to work today.
  #
  # This address is PRIVATE — the PSC endpoint inside app-subnet — which is why the Cloud Run
  # service needs Direct VPC egress to reach it.
  value = one(flatten([
    for e in google_memorystore_instance.quota.endpoints : [
      for c in e.connections : [
        for p in c.psc_auto_connection :
        "${p.ip_address}:${p.port}" if p.connection_type == "CONNECTION_TYPE_DISCOVERY"
      ]
    ]
  ]))
}
