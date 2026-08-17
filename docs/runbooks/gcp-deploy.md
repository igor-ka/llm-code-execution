# Runbook: deploy the app to Cloud Run

Builds the image and deploys the service. Assumes [`gcp-bootstrap.md`](gcp-bootstrap.md) has run
and all six secrets are populated.

`REDIS_URL` must be **set**, or the container exits at boot — `config.ts` refuses to serve traffic
with the quota unprotected. Note what that does *not* prove: the check is that the variable is
non-empty, and `RedisQuotaStore` opens its connection lazily on the first quota operation. A
service with a wrong or unreachable `REDIS_URL` starts, passes its probe, answers `/api/health`
with `ok`, and fails every request that touches the quota. Only step 4's authenticated request
demonstrates Valkey is actually reachable.

**Service URL:** `https://app-530312723651.us-central1.run.app`

**The service is not in Terraform, deliberately** — the provider strips the sandbox launcher on
every apply. This runbook *is* the specification for its shape; see
[ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md).

---

## 1. Build the image — on Cloud Build, not your laptop

```bash
# The substitutions below are shell variables, and nothing has exported them yet. `set -a` marks
# everything sourced for export; without this all three expand to empty strings and the Dockerfile's
# required-argument guard aborts the build.
set -a; . frontend/.env.local; set +a

gcloud builds submit --config=cloudbuild.yaml \
  --project=llm-code-exec-260815 \
  --service-account="projects/llm-code-exec-260815/serviceAccounts/$(cd infra && terraform output -raw build_service_account)" \
  --gcs-source-staging-dir="$(cd infra && terraform output -raw build_source_bucket)/source" \
  --substitutions=_TAG=v2,_AUTH0_DOMAIN="$VITE_AUTH0_DOMAIN",_AUTH0_CLIENT_ID="$VITE_AUTH0_CLIENT_ID",_AUTH0_AUDIENCE="$VITE_AUTH0_AUDIENCE"
```

**Why not `docker build` locally.** Cloud Run needs `linux/amd64`, and on Apple Silicon that is an
emulated build: it took over ten minutes and was killed twice before finishing. The same build on
Cloud Build takes **about two minutes**, natively. An arm64 image is rejected by Cloud Run with a
manifest error that never mentions architecture, so this is not a preference.

**Why `--service-account` is required, and why not the obvious one.** New projects no longer get
the legacy Cloud Build service account, and without this flag the submit fails with a bare
`PERMISSION_DENIED` even as project Owner. The obvious substitute — the Compute Engine default
account, `<number>-compute@developer.gserviceaccount.com` — holds project **Editor**, and build
steps come from `cloudbuild.yaml`, a file in this repository. Running them as Editor makes any
change to that file a project-wide privilege. `app-build` (`infra/build.tf`) holds three grants
instead: `logging.logWriter`, `artifactregistry.writer` on the one repository, and object access to
the one staging bucket.

**Why `--gcs-source-staging-dir`.** By default `gcloud builds submit` uploads the source tree to
`gs://<project>_cloudbuild`, a bucket nothing owns. Reaching it would need project-level storage
access for the build identity — and the Terraform state bucket is in the same project, with the
generated Cloud SQL password in cleartext inside it. The dedicated bucket keeps that grant scoped
to one bucket, and `terraform destroy` removes it with everything else.

**`_TAG` is required and has no default.** A missing substitution fails the submit loudly, which is
the right outcome: the tag is what the deploy below and any rollback refer to, so it must be a
decision, not a leftover. Bump it for a new image (`v1`, `v2`, …) rather than overwriting a tag that
a working revision still points at.

The `VITE_AUTH0_*` values are read from `frontend/.env.local`. They are baked into the bundle at
build time, so a given image is bound to one Auth0 tenant.

## 2. Deploy

```bash
gcloud beta run deploy app \
  --image us-central1-docker.pkg.dev/llm-code-exec-260815/app/app:v2 \
  --region us-central1 --project llm-code-exec-260815 \
  --execution-environment gen2 --sandbox-launcher \
  --service-account app-runtime@llm-code-exec-260815.iam.gserviceaccount.com \
  --add-cloudsql-instances llm-code-exec-260815:us-central1:app-db \
  --set-env-vars SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,SANDBOX_MAX_CONCURRENT=4 \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,OIDC_ISSUER=oidc-issuer:latest,OIDC_AUDIENCE=oidc-audience:latest,OIDC_JWKS_URL=oidc-jwks-url:latest \
  --cpu 2 --memory 2Gi --concurrency 8 --max-instances 2 \
  --network app-net --subnet app-subnet --vpc-egress private-ranges-only \
  --allow-unauthenticated
```

Flags that are not optional, and what breaks without them:

- **`--sandbox-launcher`** — no `/usr/local/gcp/bin/sandbox` in the container, so every execution
  takes the backend's exit-126 path. Requires `gen2`. This is also the flag Terraform cannot
  express, and the reason the service is deployed by this command
  ([ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md)).
- **`--network`/`--subnet`/`--vpc-egress`** — Valkey lives at a private PSC address inside
  `app-net`. Without Direct VPC egress the service **starts healthy**, passes its probe, and then
  fails every quota lookup silently, because the boot guard only checks `REDIS_URL` is non-empty
  and the client connects lazily. `private-ranges-only` keeps public egress (Anthropic, Auth0
  JWKS) off the VPC path.
- **`--concurrency 8`, not 4** — at 4, Cloud Run caps in-flight requests at the same number as
  `SANDBOX_MAX_CONCURRENT`, so the sandbox concurrency cap could never fire and its 503 path would
  be dead code (spec D12).
- **`--service-account`** — omitting it runs the service as the Compute Engine default account,
  which holds project Editor.

`--allow-unauthenticated` is correct and is not a hole: the application's own OIDC gate
authenticates users. Cloud Run IAM would authenticate *Google* identities, which the SPA's users
do not have.

## 3. Make the URL publicly reachable — one-time, org-level

The deploy above prints a warning and the URL returns 403 to anonymous callers:

```
Setting IAM policy failed … One or more users named in the policy do not belong to a
permitted customer, perhaps due to an organization policy.
```

That is **Domain Restricted Sharing** (`constraints/iam.allowedPolicyMemberDomains`), inherited
from the Workspace organization. It blocks granting `allUsers` anywhere in the org. Four commands
fix it for this project only — the last one puts the elevated role back:

```bash
# 1. Give yourself the role that can override the policy. organizationAdmin does NOT include it.
gcloud organizations add-iam-policy-binding 329400054604 \
  --member="user:<you>@<domain>" --role="roles/orgpolicy.policyAdmin" --condition=None

# 2. Override the constraint for THIS PROJECT ONLY.
cat > /tmp/policy.yaml <<'YAML'
name: projects/llm-code-exec-260815/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
    - allowAll: true
YAML
gcloud org-policies set-policy /tmp/policy.yaml --project=llm-code-exec-260815

# 3. Then the invoker binding the deploy could not set.
gcloud run services add-iam-policy-binding app --region=us-central1 \
  --member=allUsers --role=roles/run.invoker --project=llm-code-exec-260815

# 4. GIVE THE ROLE BACK. The project override in step 2 persists on its own; the org-wide power to
#    edit ANY policy does not need to, and outlives its purpose by default if you skip this.
gcloud organizations remove-iam-policy-binding 329400054604 \
  --member="user:<you>@<domain>" --role="roles/orgpolicy.policyAdmin" --condition=None
```

Step 1 is a **persistent privilege change on your organization**, which is why it is a human step
rather than something the deploy does — and why step 4 is not optional. `roles/orgpolicy.policyAdmin`
can rewrite every constraint in the organization, and it is needed for about ten seconds. Step 2 is
scoped to one project; the org-wide guardrail stays in place everywhere else, and survives step 4.

A rebuild after teardown needs steps 3 only — the project-level policy override is not
Terraform-owned and is not deleted by `terraform destroy`, so steps 1, 2 and 4 are genuinely
one-time unless the project itself is deleted.

## 4. Confirm

```bash
curl -s https://app-530312723651.us-central1.run.app/api/health          # {"status":"ok"}
curl -sI https://app-530312723651.us-central1.run.app/ | grep -i content-security-policy
```

Those two prove the container is up and the CSP is the production one. **Neither says anything
about Valkey or Cloud SQL**, because `/api/health` touches neither and both clients connect lazily.
For that, open the URL, log in, and ask for *"the first 20 Fibonacci numbers"*:

- an answer at all → Auth0, the JWKS fetch and the Anthropic egress path all work;
- **no `429` and no 500 from the quota check** → the per-user quota reached Valkey over Direct VPC
  egress, which is the only end-to-end evidence that `REDIS_URL` is reachable rather than merely
  set;
- the numbers being *correct* → the sandbox launched, found `/usr/bin/python3`, and returned real
  stdout. A sandbox that cannot start fails here and nowhere earlier (#185).

Add the URL to Auth0's Allowed Callback URLs, Allowed Logout URLs and Allowed Web Origins first —
Auth0 matches those exactly, and without it the login redirect fails with a callback-mismatch error
that names no list.

## 5. Roll back

```bash
gcloud run revisions list --service=app --region=us-central1
gcloud run services update-traffic app --region=us-central1 --to-revisions=<previous>=100
```

## 6. Tear down at the end of a session

See [`gcp-teardown.md`](gcp-teardown.md). Cloud Run itself scales to zero and costs nothing idle;
what bills by the hour is Cloud SQL and Valkey.
