# Runbook: tear down the GCP environment

> **This destroys everything, and there are no backups.** Every secret payload, the entire chat
> history database, every image in the registry, and the Terraform state itself. That is by
> design — the spec's Boundaries put backups, PITR and DR explicitly out of scope, because the
> data here is disposable learning data. If anything in this project has become worth keeping,
> copy it out **before** you start.

## When

**Day 91 of the free trial**, or any time the environment is not needed. The trial activation
date is recorded at the top of [`gcp-bootstrap.md`](gcp-bootstrap.md); day 91 is the deadline,
and a day early costs nothing while a day late can cost real money.

You do not need a reason beyond "not using it". The whole environment is reproducible from
`infra/` plus that runbook — rebuilding is cheaper than leaving it running.

## 1. Destroy what Terraform owns

```bash
cd infra
terraform plan -destroy      # read it
terraform destroy
```

Read the plan before confirming. This is the one operation here with no undo, and the plan is
the last chance to notice that it is about to remove something you did not expect.

Expect the registry, the runtime service account, all six secret containers and their versions,
both budgets, and the workload identity pool and provider.

## 2. Remove the state bucket — the one thing Terraform does not own

```bash
gcloud storage rm --recursive --all-versions "gs://<project-id>-tfstate"
```

Terraform never managed this bucket, deliberately (P1-D2): a bucket managed by the state it
stores makes every destroy a special case, and "zero billable resources" would then rest on
remembering a manual `terraform state rm` under time pressure.

**`--all-versions` is required, not decorative.** `bootstrap.sh` enables object versioning, so
without it the noncurrent versions survive and the bucket delete fails with a confusing
"not empty".

This deletes the state itself, which is why it is genuinely last: after this, Terraform has no
memory of what it built.

## 3. Delete the project — the belt-and-braces check

```bash
gcloud projects delete <project-id>
```

The only way to be certain nothing is left billing. Reversible for 30 days if you change your
mind.

**This is also what disposes of the workload identity pool.** Pools *soft-delete*: the ID is
reserved for about 30 days and cannot be reused, so `terraform destroy` alone leaves one behind —
free, but present, and it will refuse to re-create a pool with the same ID inside that window.
The rebuild rehearsal in the Phase 1 plan deliberately spares the pool for exactly this reason, so
if you see one after a destroy, it is expected rather than something the teardown missed.

## 4. Prove zero — and note what is no longer watching

Wait a day for billing to settle, then read the billing report for the project:

```
https://console.cloud.google.com/billing/<ACCOUNT_ID>/reports
```

**No budget survives to alarm on this.** Both `google_billing_budget` resources are destroyed in
step 1, so this manual check is the *only* backstop — skip it and a resource that outlived the
teardown bills silently.

Leaving a budget alive would contradict "zero billable resources" just as much, so the fix is to
read the report, not to keep an alarm behind. One deliberate look beats a permanent exception.

## 5. Rebuilding

Start again at [`gcp-bootstrap.md`](gcp-bootstrap.md). Everything in `infra/` is reproducible into
a fresh project; the only steps that are not automated are the ones that never were — creating the
account, and populating the secret payloads.
