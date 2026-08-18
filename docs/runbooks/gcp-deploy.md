# Runbook: deploy the app to Cloud Run

Builds the image and deploys the service. Assumes [`gcp-bootstrap.md`](gcp-bootstrap.md) has run
and all six secrets are populated.

`REDIS_URL` must be **set**, or the container exits at boot — `config.ts` refuses to serve traffic
with the quota unprotected. Note what that does *not* prove: the check is that the variable is
non-empty, and `RedisQuotaStore` opens its connection lazily on the first quota operation. A
service with a wrong or unreachable `REDIS_URL` starts, passes its probe, answers `/api/health`
with `ok`, and fails every request that touches the quota — and because the quota fails *open*
(D5), those requests still return `200`. Nothing observable from outside distinguishes a working
quota from a missing one; §4's log check is the only thing that does.

**Service URL:** `https://app-530312723651.us-central1.run.app`

**The service is not in Terraform, deliberately** — the provider strips the sandbox launcher on
every apply. This runbook *is* the specification for its shape; see
[ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md).

---

**The commands live in [`scripts/deploy-cloud-run.sh`](../../scripts/deploy-cloud-run.sh), not in
this file.** [ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md) makes the deploy command
the specification for the service's shape, and a copy here would be a second specification — the
copy being the one that goes stale. This runbook says *why* each flag is there and what breaks
without it; the script is what runs. The script derives every project-specific value from the
resource names Terraform uses and deliberately reads **no Terraform state**, which is the one place
it differs from the `terraform output` calls this runbook used to make: state holds the generated
Cloud SQL password in cleartext, and the same script runs in CI.

## 1. Build the image — on Cloud Build, not your laptop

```bash
# The substitutions below are shell variables, and nothing has exported them yet. `set -a` marks
# everything sourced for export; without this all three expand to empty strings and the script's
# guard aborts before the build starts.
set -a; . frontend/.env.local; set +a

# build:remote, not build. `build` is a native `docker build`, which is what CI runs on an amd64
# runner; on Apple Silicon that same build is emulated. build:remote submits the identical
# Dockerfile to Cloud Build, which does it natively.
TAG=v4 ./scripts/deploy-cloud-run.sh build:remote
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
# FIRST deploy after a rebuild — the service does not exist yet. Cloud Run gives a new service's
# first revision 100% of traffic immediately, so this one is live before it is verified; `create`
# runs the checks straight afterwards and tells you to delete the service if they fail. It refuses
# to start at all if the verification script is missing, rather than deploying and then finding out.
TAG=v4 ./scripts/deploy-cloud-run.sh create

# EVERY deploy after that. `deploy` produces a revision serving nobody, `verify` proves it, and
# only then does `promote` move traffic. These three are exactly what CI runs.
TAG=v4 ./scripts/deploy-cloud-run.sh deploy
TAG=v4 ./scripts/deploy-cloud-run.sh verify
TAG=v4 ./scripts/deploy-cloud-run.sh promote
```

Running the script with no target prints its usage rather than deploying — every target here
changes production, so that is the wrong thing to do by accident.

> **Until `scripts/verify-deployment.sh` lands (issue #198), `create` and `all` refuse to run.**
> Both deploy and then verify, and a verifier discovered missing *after* the deploy would leave a
> live unverified service behind. Use `deploy` and check §4 by hand in the meantime; `deploy` and
> `promote` are unaffected.

The flags those targets pass, and which this section explains, are:

```
--image <registry>/app:<TAG>  --region us-central1  --project llm-code-exec-260815
--execution-environment gen2  --sandbox-launcher
--service-account app-runtime@llm-code-exec-260815.iam.gserviceaccount.com
--add-cloudsql-instances llm-code-exec-260815:us-central1:app-db
--set-env-vars SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,
               SANDBOX_MAX_CONCURRENT=4,FRONTEND_ORIGIN=<the service's own URL>
--set-secrets  ANTHROPIC_API_KEY=…,DATABASE_URL=…,REDIS_URL=…,OIDC_ISSUER=…,
               OIDC_AUDIENCE=…,OIDC_JWKS_URL=… (all :latest)
--cpu 2 --memory 2Gi --concurrency 8 --max-instances 2
--network app-net --subnet app-subnet --vpc-egress private-ranges-only
--allow-unauthenticated          plus an explicit allUsers run.invoker binding, see §3
--no-traffic --tag=candidate     on `deploy` only, never on `create`
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
- **`FRONTEND_ORIGIN`** — its default is `http://localhost:5173`, so omitting it makes the deployed
  service answer every request with `Access-Control-Allow-Origin: http://localhost:5173`. Nothing
  visibly breaks, because Cloud Run serves the SPA and the API from one origin and same-origin
  requests never consult CORS — which is how it shipped that way once already (#188). The backend
  now refuses to boot with a localhost origin when `SANDBOX_BACKEND=cloudrun`, so a missing value
  fails the deploy loudly instead.

- **`--no-traffic --tag=candidate`, on `deploy` but not `create`** — the revision serves nobody
  until §4's checks pass against it. Five defects have reached this service and every one passed a
  fully green `verify.sh`, so a revision is not trusted because it deployed. `create` cannot do
  this: Cloud Run gives a brand-new service's first revision 100% of traffic and there is no other
  revision to hold it, which is exactly why CD refuses to create the service and this step is
  by hand.

`--allow-unauthenticated` is correct and is not a hole: the application's own OIDC gate
authenticates users. Cloud Run IAM would authenticate *Google* identities, which the SPA's users
do not have. The script also issues the `allUsers` `run.invoker` binding explicitly, every time,
because Domain Restricted Sharing makes this flag warn rather than fail (§3) — so a deploy that
looked fine can otherwise leave a URL that 403s for everyone.

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
./scripts/verify-deployment.sh all "$(gcloud run services describe app \
  --region=us-central1 --project=llm-code-exec-260815 --format='value(status.url)')"
```

That replaces the hand-run curls with assertions that fail rather than print, and adds the one thing
curl cannot do: it reads the deployed service's **shape** back from the API and checks it against
this section's flag list — `sandboxLauncher`, the VPC interfaces, the Cloud SQL instance, the runtime
identity, concurrency 8, and `FRONTEND_ORIGIN`. What it still does not cover is everything behind the
auth gate, which stays below.

Those two prove the container is up and the CSP is the production one — and then go run
[`gcp-isolation-probes.md`](gcp-isolation-probes.md), which is where a deploy is actually confirmed.
**Neither of the commands above says anything
about Valkey or Cloud SQL**, because `/api/health` touches neither and both clients connect lazily.
For that, open the URL, log in, and ask for *"the first 20 Fibonacci numbers"*:

- an answer at all → Auth0, the JWKS fetch and the Anthropic egress path all work;
- the numbers being *correct* → the sandbox launched, found `/usr/bin/python3`, and returned real
  stdout. A sandbox that cannot start fails here and nowhere earlier (#185).

**A successful request proves nothing about Valkey.** Getting this wrong is #191: the quota fails
*open* by design (D5), so an unreachable or incompatible store looks exactly like a healthy one
from the outside — `200`, no `429`, no error. The only check that distinguishes them reads the
service's own logs:

```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=app
   AND severity>=WARNING AND jsonPayload.message:*' \
  --project=llm-code-exec-260815 --freshness=1h --limit=20 \
  --format="value(timestamp,severity,jsonPayload.message)"
```

Expect **no output**. `quota store unavailable — FAILING OPEN, requests are unmetered` means the
service is serving traffic with no rate limiting at all.

`jsonPayload.message:*` restricts this to the application's own logs. Without it Cloud Run's request
log contributes a WARNING per `429`, so a correctly rate-limited burst buries the line that matters.

Add the URL to Auth0's Allowed Callback URLs, Allowed Logout URLs and Allowed Web Origins first —
Auth0 matches those exactly, and without it the login redirect fails with a callback-mismatch error
that names no list.

## 5. Roll back

```bash
gcloud run revisions list --service=app --region=us-central1
gcloud run services update-traffic app --region=us-central1 --to-revisions=<previous>=100
```

Four things about this that only a rehearsal tells you. All four come from the drill recorded
below, and the middle two will cost you an outage if you meet them for the first time at 3am.

**A revision that cannot start never receives traffic.** Deploying a nonexistent image tag failed
in 3 seconds, created revision `app-00003-tlp`, left it `Ready: False`, and did not move a single
percent of traffic. `/api/health` answered `200` throughout. This is the property the whole
strategy rests on, and it holds.

**`update-traffic` can move the traffic and still exit non-zero. Check the split, not the exit
code.** After the failed deploy, the rollback command printed the correct new split, actually
applied it — traffic moved to the old revision, which served `200` — and *then* failed with
`ERROR: Image 'app:v99-does-not-exist' not found`. An operator who trusts the exit code concludes
the rollback failed, while it has in fact succeeded, and whatever they try next is likely to be
worse than doing nothing. Verify with:

```bash
gcloud run services describe app --region=us-central1 --format="value(status.traffic)"
curl -s -o /dev/null -w '%{http_code}\n' https://app-530312723651.us-central1.run.app/api/health
```

**A failed deploy leaves the service template pointing at the missing image.** That is the source
of the error above, and it persists: every later service mutation re-validates the template and
reports the same thing. Clear it by deploying a known-good tag with §2's command — not by deleting
the failed revision, which does not touch the template.

**`--to-revisions` pins traffic, so the next deploy serves nobody.** Once traffic names a specific
revision, a later successful deploy creates a revision that receives 0% — you deploy a fix, gcloud
says `Done`, and nothing changes for users. The only hint is one word in gcloud's own success line,
`serving 0 percent of traffic`. Undo it explicitly when the incident is over:

```bash
gcloud run services update-traffic app --region=us-central1 --to-latest
```

`--to-latest` is safe with a broken revision present: it follows the latest *ready* revision, so
`app-00003-tlp` was skipped.

### Recorded drill — 2026-08-17 (S10)

| Step | Command | Elapsed | Outcome |
| --- | --- | --- | --- |
| Break it | `run deploy --image app:v99-does-not-exist` | 3s | `ERROR: Image … not found`. `app-00003-tlp` created, `Ready: False`. Traffic unmoved, health `200`. |
| Roll back | `update-traffic --to-revisions=app-00001-frt=100` | 2s | Traffic moved to `app-00001-frt`, serving `200` — **exit non-zero**, stale-template error. |
| Repair template | `run deploy --image app:v2` | 5s | New revision `app-00004-knc`. Reported the *pinned* revision at "0 percent". |
| Roll forward | `update-traffic --to-revisions=app-00002-qcs=100` | 5s | Clean, health `200`. |
| Unpin | `update-traffic --to-latest` | 5s | `100% LATEST (app-00004-knc)`, health `200`. |

Recovery from a bad deploy is **seconds**, and no step needed a rebuild. What it needs is knowing
that the error message lies.

## 6. Tear down at the end of a session

See [`gcp-teardown.md`](gcp-teardown.md). Cloud Run itself scales to zero and costs nothing idle;
what bills by the hour is Cloud SQL and Valkey.
