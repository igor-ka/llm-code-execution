# Runbook: deploy the app to Cloud Run

Builds the image and deploys the service. Assumes [`gcp-bootstrap.md`](gcp-bootstrap.md) has run
and all six secrets are populated — the backend refuses to boot without a reachable `REDIS_URL`.

**Service URL:** `https://app-530312723651.us-central1.run.app`

---

## 1. Build the image — on Cloud Build, not your laptop

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --project=llm-code-exec-260815 \
  --service-account="projects/llm-code-exec-260815/serviceAccounts/530312723651-compute@developer.gserviceaccount.com" \
  --substitutions=_AUTH0_DOMAIN="$VITE_AUTH0_DOMAIN",_AUTH0_CLIENT_ID="$VITE_AUTH0_CLIENT_ID",_AUTH0_AUDIENCE="$VITE_AUTH0_AUDIENCE"
```

**Why not `docker build` locally.** Cloud Run needs `linux/amd64`, and on Apple Silicon that is an
emulated build: it took over ten minutes and was killed twice before finishing. The same build on
Cloud Build takes **about two minutes**, natively. An arm64 image is rejected by Cloud Run with a
manifest error that never mentions architecture, so this is not a preference.

**Why `--service-account` is required.** New projects no longer get the legacy Cloud Build service
account, and without this flag the submit fails with a bare `PERMISSION_DENIED` even as project
Owner. The account above needs `roles/logging.logWriter`, `roles/artifactregistry.writer` and
`roles/storage.objectUser`, granted once.

The `VITE_AUTH0_*` values are read from `frontend/.env.local`. They are baked into the bundle at
build time, so a given image is bound to one Auth0 tenant.

## 2. Deploy

```bash
gcloud beta run deploy app \
  --image us-central1-docker.pkg.dev/llm-code-exec-260815/app/app:v1 \
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
  takes the backend's exit-126 path. Requires `gen2`.
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
from the Workspace organization. It blocks granting `allUsers` anywhere in the org. Two commands
fix it for this project only:

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
```

Step 1 is a **persistent privilege change on your organization**, which is why it is a human step
rather than something the deploy does. Step 2 is scoped to one project; the org-wide guardrail
stays in place everywhere else.

## 4. Confirm

```bash
curl -s https://app-530312723651.us-central1.run.app/api/health          # {"status":"ok"}
curl -sI https://app-530312723651.us-central1.run.app/ | grep -i content-security-policy
```

Then open the URL, log in, and ask for *"the first 20 Fibonacci numbers"*. Add the URL to Auth0's
Allowed Callback URLs, Allowed Logout URLs and Allowed Web Origins first — Auth0 matches those
exactly, and without it the login redirect fails with a callback-mismatch error that names no
list.

## 5. Roll back

```bash
gcloud run revisions list --service=app --region=us-central1
gcloud run services update-traffic app --region=us-central1 --to-revisions=<previous>=100
```

## 6. Tear down at the end of a session

See [`gcp-teardown.md`](gcp-teardown.md). Cloud Run itself scales to zero and costs nothing idle;
what bills by the hour is Cloud SQL and Valkey.
