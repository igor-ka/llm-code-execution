# 5. The Cloud Run service stays outside Terraform

- **Status:** Accepted
- **Date:** 2026-08-17
- **Tracking:** epic [#79](https://github.com/igor-ka/llm-code-execution/issues/79), child [#161](https://github.com/igor-ka/llm-code-execution/issues/161)
- **Related:** hosting ADR [0004](0004-hosting-and-sandbox-execution.md) (D1, D6); spec [2026-08-09-deploy-to-gcp](../specs/2026-08-09-deploy-to-gcp.md) (D6, D16); runbooks [gcp-deploy](../runbooks/gcp-deploy.md), [gcp-teardown](../runbooks/gcp-teardown.md)

## Context

Everything else in this project's GCP footprint is Terraform-managed: the VPC, Cloud SQL,
Memorystore for Valkey, Artifact Registry, the runtime service account, the six secrets, the
budget, Workload Identity Federation. `infra/verify.sh` gates it and `terraform destroy` removes
it. #161 asked for the Cloud Run service to be **"deployed by hand, then captured in Terraform"**
on the same basis, and a code review correctly flagged that no `infra/run.tf` exists.

It should not. The blocker is specific and load-bearing.

`--sandbox-launcher` is what puts `/usr/local/gcp/bin/sandbox` in the container, and without it
`CloudRunSandboxBackend` has no way to execute anything — every request takes the exit-126 path.
On the API it is `sandboxLauncher: true`, a field of the **container spec**. The Terraform provider
does not model it
([hashicorp/terraform-provider-google#28426](https://github.com/hashicorp/terraform-provider-google/issues/28426),
open, filed 2026-07-22).

The consequence is worse than "cannot be set declaratively". The provider sends a complete
container spec on every apply, and Cloud Run treats that request as authoritative, so **Terraform
actively removes the launcher** from the serving revision each time anything about the service
changes. `lifecycle { ignore_changes = … }` does not help: there is no attribute to ignore.

That failure mode is the one this project has already paid for once. In [#185](https://github.com/igor-ka/llm-code-execution/issues/185)
the sandbox was misconfigured in a way that left the service **healthy** — the container started,
the probe passed, `/api/health` returned `ok` — and broke only when a user actually ran code.
Putting the service in Terraform would install a recurring, silent version of exactly that: an
unrelated `terraform apply` on the database or the VPC would strip code execution from the running
service and nothing would say so.

## Decision

**The Cloud Run service is deployed by the `gcloud beta run deploy` command in
[`docs/runbooks/gcp-deploy.md`](../runbooks/gcp-deploy.md) and is deliberately absent from
Terraform state.** #161's acceptance criterion is narrowed accordingly: what is captured in
Terraform is everything the service *depends on*, plus the identity it runs as.

Three obligations come with that, and they are the price of the decision:

1. **The deploy command is the specification.** It lives in the runbook in full, with every flag
   annotated by what breaks without it. It is idempotent — re-running it produces a new revision
   with the same shape — so it is re-derivable, just not enforced.
2. **Teardown must delete the service explicitly.** `terraform destroy` will not, because
   Terraform does not own it. [`gcp-teardown.md`](../runbooks/gcp-teardown.md) step 1 does it
   first, and the "prove zero" step lists it.
3. **The runtime service account stays in Terraform.** The service is unmanaged; the identity it
   assumes, and therefore its blast radius, is not. `--service-account` in the deploy command
   references a Terraform-managed account, so IAM remains reviewable in `infra/`.

## Alternatives considered

- **Manage the service in Terraform and re-apply `sandboxLauncher` with `gcloud` after every
  apply.** This is the workaround the upstream issue documents, and its reporter measures a
  ~3-minute window per deploy in which sandboxes cannot launch. It converts a static gap into an
  intermittent one — the harder kind to diagnose — and depends on a follow-up command nobody
  remembers when the apply was for something else.
- **Manage the service in Terraform and drop the sandbox backend on the deployed instance.** This
  is coherent but abandons D6, the decision the entire hosting choice was made to serve.
- **Wait for provider support.** Nothing about the timeline is in this project's control, and the
  service is needed now. This is the reversal condition rather than an alternative.

## Consequences

- Drift is possible: someone can change the deployed service by hand and no plan will report it.
  Mitigated only by the runbook and by the service being cheap to redeploy from scratch, which the
  destroy-between-sessions model exercises regularly.
- `terraform destroy` is no longer sufficient for a full teardown. The teardown runbook is the
  authority, not the tool.
- One deployment concern now lives in two places — the image and its build in `cloudbuild.yaml`,
  the runtime shape in the runbook — rather than one.

## Reversal

Reverse this when the Google provider models `sandboxLauncher` on
`google_cloud_run_v2_service` — track
[#28426](https://github.com/hashicorp/terraform-provider-google/issues/28426). At that point write
`infra/run.tf`, `terraform import` the existing service, confirm the plan is empty **and** confirm
a `sandbox` binary is still present in a fresh revision before trusting it. The import is the easy
half; the empty plan is the part that has to be verified rather than assumed.
