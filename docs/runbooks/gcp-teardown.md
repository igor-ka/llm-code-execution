# Runbook: tear down the GCP environment

> **This destroys everything, and there are no backups.** Every secret payload, the entire chat
> history database, every image in the registry, and the Terraform state itself. That is by
> design — the spec's Boundaries put backups, PITR and DR explicitly out of scope, because the
> data here is disposable learning data. If anything in this project has become worth keeping,
> copy it out **before** you start.

## Two different teardowns

**Between working sessions** (the normal one, spec D17). Memorystore and Cloud SQL bill per hour
of *existence*, and Memorystore has no "stop" — only delete. Leaving them up costs ~CAD 55/month;
destroying them between sessions costs ~CAD 3/month at ten hours a week. Run step 1 and the
**targeted** destroy in step 2 only — not the plain `terraform destroy`, which would take Workload
Identity Federation with it and break continuous deployment for a month (see §2). Keep the state
bucket and the project, and rebuild from [`gcp-bootstrap.md`](gcp-bootstrap.md) next time. Budget
**15–20 minutes** for the rebuild, mostly Cloud SQL, plus repopulating **two** secret payloads —
the targeted destroy leaves the other four standing.

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

### Between working sessions — targeted, and that is not an optimisation

`terraform destroy` with no arguments destroys `google_iam_workload_identity_pool.github`. Pools
**soft-delete**: the ID is reserved for about 30 days and cannot be reused (§4 says the same thing
from the other direction), so the next `terraform apply` cannot re-create it — and since Phase 3
that pool is how GitHub Actions authenticates. A full destroy at the end of a working session
therefore leaves **continuous deployment broken until the reservation lapses**, with a rebuild that
looks fine right up to the `auth` step of the next push.

So the between-sessions teardown destroys the things that bill by the hour, and nothing else:

```bash
cd infra
TARGETS=(
  -target=google_sql_database_instance.main
  -target=google_memorystore_instance.quota
  -target=google_network_connectivity_service_connection_policy.valkey
  -target=google_compute_subnetwork.main
  -target=google_compute_network.main
)
terraform plan -destroy "${TARGETS[@]}"      # read it
terraform destroy "${TARGETS[@]}"
```

Terraform prints a warning that resource targeting is not a recommended practice. It is right in
general and wrong here: the alternative is a month without CD.

Everything left standing is free or close to it — the service accounts, both budgets, the six secret
**containers**, the workload identity pool, the Artifact Registry repository (a few images, cents a
month) and the staging bucket (7-day lifecycle).

> **Repopulate `redis-url` BEFORE you redeploy. A stale value is worse than a missing one.**
>
> This is the one hazard the targeted destroy introduces, and it is the reason it gets a warning
> box rather than a bullet. Under the full destroy the secret *containers* went too, so a redeploy
> that skipped the repopulate step failed loudly with "secret not found". They now survive — holding
> the **old** PSC endpoint, which is not reachable after the rebuild.
>
> `assertRedisConfigured` only checks that `REDIS_URL` is non-empty (`backend/src/config.ts`), and
> `RedisQuotaStore` connects lazily, so that service **starts, passes its probe, answers
> `/api/health` with `ok`, and fails every quota lookup open** — a publicly invokable endpoint
> spending Anthropic credits with no rate limiting, indistinguishable from healthy from outside.
> That is #191 and #195's failure mode, reintroduced by the teardown rather than by the app.

Only **`redis-url`** genuinely changes. `database-url` does not, and the reason is worth stating
because it is not obvious: `-target` destroys the named resource and everything that *depends on*
it, so `google_sql_user.app` goes — but `random_password.db` is a **dependency** of that user, not a
dependent of the instance, so it survives in state. The re-applied user gets the identical password,
and the connection name `<project>:<region>:app-db` is unchanged. Adding a new `database-url`
version on every rebuild is therefore pure waste, and Secret Manager bills per active version.

> **Unverified, and worth watching the first time:** Cloud SQL has historically reserved a deleted
> instance's name for several days. If `terraform apply` fails to re-create `app-db` because the
> name is still held, that is this, not a configuration fault — and it would make the targeted
> destroy unusable on a same-week cadence. Record what actually happens in the appendix.

`-exclude` would express this better than five `-target`s. Terraform 1.15.8 does not have it —
`terraform plan -exclude=…` fails with *"flag provided but not defined"*. Revisit when the pinned
version gains it.

**If this is a between-sessions teardown, stop here** — and the rebuild has three steps in this
order, because the second one is what the warning above is about:

1. `cd infra && terraform apply` — brings back Cloud SQL, Valkey, the VPC and the PSC policy.
2. Repopulate **`redis-url`** from the newly allocated endpoint, using
   [`gcp-bootstrap.md`](gcp-bootstrap.md) §10's command for it. `database-url` does not need it.
3. Redeploy the service with [`gcp-deploy.md`](gcp-deploy.md) — **`terraform apply` does not bring
   it back**, because Terraform does not own it (ADR-0005), and step 1 of this runbook deleted it.
   Use that runbook's `create` path: the service does not exist, and the deploy target refuses to
   create one.

### At the end (day 91, or for good)

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

After a **full** destroy nothing comes back by itself: every secret payload is gone (deliberately not
in Terraform — S6), and the Valkey endpoint is newly allocated. That is the difference from the
targeted path above, where only `redis-url` needs attention.

Do not hand-assemble them: **[`gcp-bootstrap.md`](gcp-bootstrap.md) §10 carries all six
commands**, including the two that change on every rebuild (`database-url` gets a fresh generated
password, `redis-url` a newly allocated PSC endpoint). Run that section verbatim, then redeploy
with [`gcp-deploy.md`](gcp-deploy.md) — the service was deleted in step 1 and no `terraform apply`
brings it back. Use the **`create`** target: `deploy` deliberately exits 3 when there is no service
to deploy a revision of, because a new service's first revision takes 100% of traffic and cannot be
verified first.

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

**After a FULL teardown, no budget survives to alarm on this.** Both `google_billing_budget`
resources are destroyed by the day-91 destroy — though not by the targeted one above, which leaves
them watching — so after the full teardown this manual check is the *only* backstop — skip it and a resource that outlived the
teardown bills silently.

Leaving a budget alive would contradict "zero billable resources" just as much, so the fix is to
read the report, not to keep an alarm behind. One deliberate look beats a permanent exception.

## 6. Rebuilding

Start again at [`gcp-bootstrap.md`](gcp-bootstrap.md). Everything in `infra/` is reproducible into
a fresh project; the only steps that are not automated are the ones that never were — creating the
account, and populating the secret payloads.

Then re-run [`gcp-isolation-probes.md`](gcp-isolation-probes.md). The isolation claims are properties
of the *running* service, not of the repository, so a rebuild invalidates the last recorded run —
and two of the three defects that have reached this deployment were found by exactly that
procedure.

---

## Appendix: the S7 rehearsal, run 2026-08-16

> **This rehearsal exercised the FULL destroy of 18 targeted resources, not the five-address
> between-sessions destroy introduced later.** It is evidence for reproducibility, not for that
> procedure — which, as of this writing, has not been run. This file's own standard applies:
> *a reproducibility claim nobody has exercised is an assumption.*
>
> **The address count below is also stale, and by more than it looks.** It predates all of Phase 2 —
> Cloud SQL, Memorystore for Valkey, the VPC, the build identity and its staging bucket — plus
> Phase 3's `ci_log_viewer`. A `terraform state list` on 2026-08-18 returns **50**, not 30. Re-read
> the count from the live state rather than from this record.

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
