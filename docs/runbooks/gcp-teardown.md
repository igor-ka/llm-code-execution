# Runbook: tear down the GCP environment

> **This destroys everything, and there are no backups.** Every secret payload, the entire chat
> history database, every image in the registry, and the Terraform state itself. That is by
> design — the spec's Boundaries put backups, PITR and DR explicitly out of scope, because the
> data here is disposable learning data. If anything in this project has become worth keeping,
> copy it out **before** you start.

## Two different teardowns

**Between working sessions** (the normal one, spec D17). Memorystore and Cloud SQL bill per hour
of *existence*, and Memorystore has no "stop" — only delete. Leaving them up costs ~CAD 55/month;
destroying them between sessions costs ~CAD 3/month at ten hours a week. Run steps 1 and 2 only, keep
the state bucket and the project, and rebuild from
[`gcp-bootstrap.md`](gcp-bootstrap.md) next time. Budget **15–20 minutes** for the rebuild, mostly
Cloud SQL, plus repopulating the six secret payloads.

**At the end (day 91, or for good).** Everything below, including the state bucket and the
project.

Both start the same way; the difference is how far down the page you go.

## When

**Day 91 of the free trial**, or any time the environment is not needed. The trial activation
date is recorded at the top of [`gcp-bootstrap.md`](gcp-bootstrap.md); day 91 is the deadline,
and a day early costs nothing while a day late can cost real money.

You do not need a reason beyond "not using it". The whole environment is reproducible from
`infra/` plus that runbook — rebuilding is cheaper than leaving it running.

## 1. Delete the Cloud Run service — Terraform will not

`terraform destroy` does not remove the service, because Terraform does not own it: the provider
cannot express `--sandbox-launcher` and strips it on every apply, so the service is deployed by
hand on purpose ([ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md)). Delete it first,
before the database and Valkey disappear from under it:

```bash
gcloud run services delete app --region=us-central1 --project=llm-code-exec-260815 --quiet
```

Cloud Run scales to zero, so a forgotten service costs nothing per hour — which is exactly why it
is easy to leave behind. It still holds the public `allUsers` invoker binding and a URL that
answers, and after the destroy below it answers with 500s. Deleting it is about not leaving a
public endpoint pointed at a torn-down backend, not about money.

The image in Artifact Registry goes with the registry in the next step.

## 2. Destroy what Terraform owns

```bash
cd infra
terraform plan -destroy      # read it
terraform destroy
```

Read the plan before confirming. This is the one operation here with no undo, and the plan is
the last chance to notice that it is about to remove something you did not expect.

Expect the registry, the runtime service account, all six secret containers and their versions,
both budgets, the Cloud SQL instance, the Valkey instance with its VPC and PSC policy, and the
workload identity pool and provider.

**If this is a between-sessions teardown, stop here.** The state bucket and the project stay, and
`terraform apply` rebuilds everything from the same configuration. Two things do not come back by
themselves: the secret payloads (deliberately not in Terraform — S6) and the Valkey endpoint,
which is newly allocated on each rebuild.

Do not hand-assemble them: **[`gcp-bootstrap.md`](gcp-bootstrap.md) §10 carries all six
commands**, including the two that change on every rebuild (`database-url` gets a fresh generated
password, `redis-url` a newly allocated PSC endpoint). Run that section verbatim, then redeploy
with [`gcp-deploy.md`](gcp-deploy.md) — the service was deleted in step 1 and no `terraform apply`
brings it back.

## 3. Remove the state bucket — the one thing Terraform does not own

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

## 4. Delete the project — the belt-and-braces check

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

## 5. Prove zero — and note what is no longer watching

The one resource no `terraform plan` will ever mention is the Cloud Run service, so check it by
hand — an empty list is the only confirmation step 1 actually ran:

```bash
gcloud run services list --region=us-central1 --project=llm-code-exec-260815   # → 0 items
```

Then wait a day for billing to settle and read the billing report for the project:

```
https://console.cloud.google.com/billing/<ACCOUNT_ID>/reports
```

**No budget survives to alarm on this.** Both `google_billing_budget` resources are destroyed in
step 2, so this manual check is the *only* backstop — skip it and a resource that outlived the
teardown bills silently.

Leaving a budget alive would contradict "zero billable resources" just as much, so the fix is to
read the report, not to keep an alarm behind. One deliberate look beats a permanent exception.

## 6. Rebuilding

Start again at [`gcp-bootstrap.md`](gcp-bootstrap.md). Everything in `infra/` is reproducible into
a fresh project; the only steps that are not automated are the ones that never were — creating the
account, and populating the secret payloads.

---

## Appendix: the S7 rehearsal, run 2026-08-16

A destroy-and-rebuild against the live project, sparing only what step 4 explains. Recorded here
because a reproducibility claim nobody has exercised is an assumption.

```
terraform state list | sort            → 30 addresses

terraform plan -destroy -target=…      → Plan: 0 to add, 0 to change, 18 to destroy
terraform destroy  -target=…           → Destroy complete! Resources: 18 destroyed

gcloud artifacts repositories list     → 0
gcloud secrets list                    → 0
gcloud iam service-accounts list       → 0 (app-runtime)
gcloud billing budgets list            → 0
gcloud iam workload-identity-pools list→ github ACTIVE   (deliberately spared)

terraform apply                        → Apply complete! Resources: 18 added
terraform state list | sort            → IDENTICAL to the 30 recorded before
```

Then the one manual step a rebuild always needs, because payloads are not in Terraform (S6):

```
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets versions add anthropic-api-key --data-file=-
terraform state pull | grep -c "sk-ant"   → 0
```

**What this proves:** the configuration reproduces its own resources exactly — the *reproduce*
half of S7.

**What it does not:** "zero billable resources". The rehearsal deliberately spares the workload
identity pool (soft-deleted for ~30 days, so a rebuild would 409 on the same ID) and the state
bucket (P1-D2). Both are removed only by the full teardown above, which ends in
`gcloud projects delete`. **That half of S7 closes on day 91, not here.**
