# Runbook: bootstrap a GCP project for this repo

Stands up a GCP project from nothing to "`terraform apply` works", for Phase 1 of
[epic #79](https://github.com/igor-ka/llm-code-execution/issues/79). Nothing is deployed by this
runbook — no Cloud Run service, no database. It builds the *place* a deploy will later go.

Follow it top to bottom. Every command is copy-pasteable; `<project-id>` is the only value you
substitute.

> **This costs money in exactly one way.** Step 2 links a billing account, which starts the
> $300/90-day trial clock. The exit is [`gcp-teardown.md`](gcp-teardown.md) on day 91 —
> a `terraform destroy` and a project deletion, not a pause. Write the activation date down in
> step 1 or you will be guessing at it in three months.

---

## 1. Prerequisites

```bash
brew install terraform google-cloud-sdk
```

No Homebrew? Both ship standalone binaries —
[Terraform](https://developer.hashicorp.com/terraform/install) and the
[gcloud CLI](https://cloud.google.com/sdk/docs/install). The gcloud CLI needs Python 3.10–3.14;
macOS ships 3.9, so a standalone CPython plus `CLOUDSDK_PYTHON` is the usual fix.

Then activate the $300/90-day free trial at
[console.cloud.google.com](https://console.cloud.google.com/) — it needs a card, which is not
charged unless you explicitly upgrade.

**Trial activation date: `____-__-__`**

Fill that in. It is `var.trial_start_date`, it is what makes the credit-burn budget measure the
trial rather than a calendar month, and it is the date the teardown works back from. Day 91 is the
deadline; a day early costs nothing, a day late can cost real money.

## 2. Create and link the project

A dedicated project, not the "My First Project" GCP creates at signup: the teardown ends in
`gcloud projects delete`, and that would take anything else in a shared project with it.

```bash
gcloud projects create llm-code-exec-<suffix> --name="LLM code execution"
gcloud config set project llm-code-exec-<suffix>
gcloud billing accounts list                       # note the ACCOUNT_ID
gcloud billing projects link llm-code-exec-<suffix> --billing-account=<ACCOUNT_ID>
```

`gcloud config set project` matters beyond convenience: several later commands
(`gcloud secrets versions add`, the teardown checks) take no `--project` flag and read it.

## 3. Authenticate

```bash
gcloud auth login
gcloud auth application-default login
```

Two logins, and the second is the one Terraform reads. `gcloud auth login` authenticates the CLI;
Terraform uses Application Default Credentials, written by the second command to
`~/.config/gcloud/application_default_credentials.json`. Running only the first produces a
confusing failure where `gcloud` works and `terraform plan` reports no credentials.

Headless or on a phone? `gcloud auth login --no-launch-browser --update-adc` prints a URL, takes a
verification code back, and `--update-adc` does both logins at once.

## 4. Enable the two APIs Terraform cannot enable for itself

```bash
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  --project llm-code-exec-<suffix>
```

Not redundant with `infra/apis.tf`. `data "google_project" "this"` is read at **plan** time,
before any resource in `apis.tf` can be created, and `user_project_override` bills that read to
this project — so a project without Cloud Resource Manager fails the plan with a 403 that
`apis.tf` never gets far enough to fix. Idempotent; costs nothing if they were already on.

## 5. Confirm Cloud Run sandboxes exist in your region

Five minutes, and it settles the assumption the whole sandbox design rests on
([D6](../specs/2026-08-09-deploy-to-gcp.md)) while changing region is still one line:

```bash
gcloud services enable run.googleapis.com --project llm-code-exec-<suffix>
gcloud beta run deploy sandbox-probe --region us-central1 \
  --image us-docker.pkg.dev/cloudrun/container/hello \
  --execution-environment gen2 --sandbox-launcher --no-allow-unauthenticated --quiet
gcloud beta run services describe sandbox-probe --region us-central1 \
  --format='value(spec.template.spec.containers[0].sandboxLauncher)'   # expect: True
gcloud run services delete sandbox-probe --region us-central1 --quiet
```

Verified `True` in `us-central1` on 2026-08-15. If it is ever rejected — unknown flag, or the
region is unsupported — **stop and raise it**. The choices are a different region (change
`var.region`, nothing else) or the Cloud Run Jobs backend D6 rejected, and both are decisions.

## 6. Bootstrap the state bucket

```bash
./infra/bootstrap.sh llm-code-exec-<suffix> us-central1
```

Idempotent — re-running prints `already exists` and exits 0. It creates
`gs://<project-id>-tfstate` with object versioning (the only recovery path for a corrupted state
file), uniform bucket-level access, public access prevention, and noncurrent versions capped at
10.

## 7. Initialise Terraform

```bash
cd infra
terraform init -backend-config="bucket=llm-code-exec-<suffix>-tfstate"
cp terraform.tfvars.example terraform.tfvars     # then fill in the real values
git check-ignore -v terraform.tfvars             # must print a line naming infra/.gitignore
```

Run that last command. `terraform.tfvars` holds your project and billing identifiers, and
`infra/verify.sh` fails the build if it is ever tracked — better to find out here than in review.

The GitHub values in it are a **trust boundary**, not labels: `github_repository` is interpolated
into the principal that receives the deploy roles, so it decides whose Actions may deploy. The
numeric IDs are numeric because logins can be renamed and re-registered by someone else.

## 8. Apply

```bash
terraform plan       # read it — this is the review
terraform apply
```

Expected on a fresh project: 8 `google_project_service` resources. Then confirm the state went to
the bucket rather than to disk:

```bash
ls terraform.tfstate                                    # No such file or directory
gcloud storage ls "gs://llm-code-exec-<suffix>-tfstate/phase1/"   # default.tfstate
```

## 9. Populate the secrets

Secret *containers* are created by Terraform; their *payloads* never are, because a
`google_secret_manager_secret_version` resource puts the plaintext in state, in plan output, and
in any log that prints a plan (spec S6). `infra/verify.sh` fails the build if one is ever added.

Payloads arrive out of band with `gcloud secrets versions add`. **Filled in by PR 4 (#133)**,
which creates the containers.

## 10. What this runbook does not manage

**The state bucket.** Terraform does not own it, deliberately (P1-D2): a bucket managed by the
state it stores makes every `terraform destroy` a special case, and "zero billable resources"
would then depend on remembering a manual `terraform state rm` under time pressure.

It is created here in step 6 and deleted as the final step of
[`gcp-teardown.md`](gcp-teardown.md), which is also where the day-91 deadline lives.
