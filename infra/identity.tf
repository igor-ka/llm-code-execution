# The identity the Cloud Run service RUNS as — not the identity that deploys it. Cloud Run's
# default is the Compute Engine default service account, which holds project Editor: a
# compromised app process would inherit the ability to rewrite the whole project. This account
# starts with nothing, and as of this file it HAS nothing — no bindings accompany it here.
#
# Its only grants will be per-secret accessor bindings, added by #133 in secrets.tf next to the
# secrets they name (P1-D5: per resource, never per project).
resource "google_service_account" "runtime" {
  account_id   = "app-runtime"
  display_name = "Cloud Run runtime identity"
  description  = "Runs the llm-code-execution service. Deploys are performed by a federated GitHub identity, not by this account."

  depends_on = [google_project_service.phase1]
}

# NO artifactregistry.reader for the runtime identity — deliberately.
#
# Cloud Run pulls the image with the Cloud Run SERVICE AGENT
# (service-<number>@serverless-robot-prod.iam.gserviceaccount.com), not with the service's runtime
# identity, and in a same-project setup that agent already holds the access. Granting the runtime
# SA a reader role would hand a compromised application process the ability to enumerate and pull
# every image in the repository, buying nothing — which is exactly what P1-D5 exists to prevent.
#
# If Phase 2 ever pulls from a DIFFERENT project, it is the service agent of the consuming
# project that needs the grant, still not this identity.
