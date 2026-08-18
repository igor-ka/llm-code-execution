#!/usr/bin/env bash
# The Cloud Run deploy, as ONE script the human and CI both run.
#
# ADR-0005 makes this command the SPECIFICATION for the service's shape, because the Terraform
# provider does not model `sandboxLauncher` and strips it on every apply. A specification that
# exists only as prose in a runbook drifts the moment CI grows its own copy of the command — so
# the command lives here, docs/runbooks/gcp-deploy.md keeps the annotations that say why each flag
# is there and what breaks without it, and .github/workflows/deploy.yml calls these targets. Same
# contract verify.sh already has in this repo: CI runs the same script, so the two cannot drift.
#
# NOTHING HERE READS TERRAFORM STATE, deliberately. State holds the generated Cloud SQL password
# in cleartext — infra/build.tf refuses the build identity project-level storage access for
# exactly that reason — so giving CI the state bucket would hand every future pipeline the
# database password. Every value below is a constant or is derived from the resource names
# Terraform itself uses. A rename in infra/ therefore breaks this loudly on the next run instead
# of silently.
#
# Usage: ./scripts/deploy-cloud-run.sh [target]
#   all           (default) preflight + build + deploy + verify + promote
#   preflight     does the credential work, and is there a service to deploy a revision of?
#   build         docker build + push, linux/amd64. What CI runs.
#   build:remote  the same Dockerfile via Cloud Build. What a human on Apple Silicon runs.
#   deploy        gcloud beta run deploy — always a NO-TRAFFIC candidate. Refuses to create.
#   create        the FIRST deploy after a rebuild. By hand only; CI never calls this.
#   verify        scripts/verify-deployment.sh against whichever URL the deploy produced
#   promote       100% of traffic to the latest ready revision, then CHECK THE SPLIT
#
# Exit contract — the workflow branches on it, so it is interface, not implementation detail:
#   0  the target succeeded
#   3  nothing to deploy: the Terraform layer is torn down, or the service does not exist yet
#      (spec D17 — the environment is destroyed between sessions). NOT a failure.
#   2  unknown target
#   1  anything else, including a credential that does not work
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-llm-code-exec-260815}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-app}"
TAG="${TAG:-}"
CANDIDATE_TAG="candidate"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-./scripts/verify-deployment.sh}"

# Derived, never read from `terraform output` — see the header.
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/app"
BUILD_SA="app-build@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_BUCKET="gs://${PROJECT_ID}-build-source"
RUNTIME_SA="app-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SQL_INSTANCE="${PROJECT_ID}:${REGION}:app-db"

run() {
  echo
  echo "==> $*"
  "$@"
}

require_tag() {
  if [[ -z "$TAG" ]]; then
    echo "TAG is required and has no default." >&2
    echo "  It is what this deploy and any rollback name, so it must be a decision rather than a" >&2
    echo "  leftover. CI passes the commit SHA; by hand, pass TAG=v4 or similar." >&2
    exit 1
  fi
}

require_auth0_args() {
  # The three VITE_AUTH0_* values are inlined into the SPA bundle at build time. A bundle built
  # without them is valid, has a strict CSP, passes every check, and cannot log in — so this is a
  # guard rather than tidiness. The Dockerfile refuses them too, but that failure arrives minutes
  # later inside a remote build.
  local missing=0 v
  for v in VITE_AUTH0_DOMAIN VITE_AUTH0_CLIENT_ID VITE_AUTH0_AUDIENCE; do
    if [[ -z "${!v:-}" ]]; then
      echo "$v is empty — it is baked into the SPA bundle and login breaks silently without it." >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    echo "  Locally: set -a; . frontend/.env.local; set +a" >&2
    echo "  In CI:   repository variables, not secrets — these ship in a public JS bundle." >&2
    exit 1
  fi
}

service_url() {
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)' 2>/dev/null
}

# The URL of the no-traffic candidate, or empty when there is none. Selected by TAG rather than by
# position: the traffic list also carries the serving entry, and `[0]` is a coin flip that happens
# to work today — the same mistake infra/valkey.tf's endpoint selection had to avoid.
candidate_url() {
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json 2>/dev/null |
    CANDIDATE_TAG="$CANDIDATE_TAG" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
wanted = os.environ["CANDIDATE_TAG"]
for t in d.get("status", {}).get("traffic", []):
    if t.get("tag") == wanted and t.get("url"):
        print(t["url"])
        break
'
}

preflight() {
  echo
  echo "==> preflight"

  # STAGE 1 — does the credential work? This must FAIL the job, never report "torn down".
  #
  # A single registry probe would treat every non-zero exit as "the environment is gone", including
  # PERMISSION_DENIED, an expired federated token, a disabled API and a network failure — so a wrong
  # IAM grant or a wrong workload_identity_provider variable would finish GREEN saying the
  # environment is torn down. That is the decorative-assertion pattern applied to the one step that
  # decides whether anything else runs.
  if ! gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' >/dev/null; then
    echo "    cannot read project ${PROJECT_ID}." >&2
    echo "    This is a CREDENTIAL problem, not a torn-down environment: the federated identity" >&2
    echo "    could not authenticate or lacks resourcemanager.projects.get. Check the" >&2
    echo "    GCP_WORKLOAD_IDENTITY_PROVIDER variable and infra/wif.tf." >&2
    exit 1
  fi
  echo "    credential works"

  # STAGE 2 — is there an environment? The Artifact Registry repository is the cheapest proof that
  # the Terraform layer exists, and it is destroyed between working sessions (spec D17), so this is
  # the EXPECTED state most of the time rather than a failure.
  if ! gcloud artifacts repositories describe app \
    --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "    no Artifact Registry repository 'app' in ${PROJECT_ID}/${REGION}."
    echo "    The environment is torn down — see docs/runbooks/gcp-teardown.md."
    echo "    Rebuild it with docs/runbooks/gcp-bootstrap.md, then run the 'create' target."
    exit 3
  fi

  # STAGE 3 — is there a SERVICE? Cloud Run gives a brand-new service's first revision 100% of
  # traffic, so `--no-traffic` cannot exist on a create and the phase's one invariant — no user
  # ever sees an unverified revision — would have to carry an exception. It does not: creating the
  # service is the `create` target, run by hand after a rebuild (spec D4/S9), and CI stops here.
  if [[ -z "$(service_url)" ]]; then
    echo "    service '${SERVICE}' does not exist yet."
    echo "    CD does not create it: the first revision of a new service takes 100% of traffic"
    echo "    immediately, so it cannot be verified before users reach it. Run this once by hand:"
    echo "      TAG=<tag> ./scripts/deploy-cloud-run.sh create"
    exit 3
  fi
  echo "    environment and service present"
}

# What CI runs. `ubuntu-latest` is amd64, so this is a native build with no emulation — the reason
# builds went to Cloud Build in the first place does not apply there. Needs no IAM beyond the
# artifactregistry.writer the federated principal already holds.
build() {
  require_tag
  require_auth0_args

  # --platform is explicit rather than implied by the host. Cloud Run rejects an arm64 image with a
  # manifest error that never mentions architecture, and this script is also run from a laptop.
  run docker build --platform linux/amd64 \
    --build-arg "VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN}" \
    --build-arg "VITE_AUTH0_CLIENT_ID=${VITE_AUTH0_CLIENT_ID}" \
    --build-arg "VITE_AUTH0_AUDIENCE=${VITE_AUTH0_AUDIENCE}" \
    -t "${REGISTRY}/${SERVICE}:${TAG}" .

  run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  run docker push "${REGISTRY}/${SERVICE}:${TAG}"
}

# The by-hand path on Apple Silicon, where the build above is emulated: it took over ten minutes and
# was OOM-killed twice. Cloud Build does the same Dockerfile natively in about two minutes. Same
# image, different transport — cloudbuild.yaml is the definition it submits.
build:remote() {
  require_tag
  require_auth0_args

  run gcloud builds submit --config=cloudbuild.yaml \
    --project="$PROJECT_ID" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
    --gcs-source-staging-dir="${BUILD_BUCKET}/source" \
    --substitutions=_TAG="$TAG",_AUTH0_DOMAIN="$VITE_AUTH0_DOMAIN",_AUTH0_CLIENT_ID="$VITE_AUTH0_CLIENT_ID",_AUTH0_AUDIENCE="$VITE_AUTH0_AUDIENCE"
}

# One deploy command, two intents. `deploy` is what CI runs and always produces a candidate that
# serves nobody; `create` is the by-hand first deploy after a rebuild, where Cloud Run gives the
# first revision 100% and there is no alternative. Sharing the body is what keeps the service's
# shape identical either way — ADR-0005 makes that shape the specification, so it must not have two
# definitions. $1 is `candidate` or `live`.
deploy_revision() {
  require_tag
  local project_number origin
  project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  # FRONTEND_ORIGIN must be the service's own URL, and on a create the service has no URL yet — so
  # it is computed from the project number rather than read back, and verify-deployment.sh asserts
  # afterwards that the computed value equals status.url. #188 is what a wrong value looks like:
  # nothing visibly breaks, because Cloud Run serves the SPA and the API from one origin and
  # same-origin requests never consult CORS.
  origin="https://${SERVICE}-${project_number}.${REGION}.run.app"

  # `local -a x=()` plus `"${x[@]}"` is an unbound-variable error under `set -u` on bash 3.2, which
  # is what /bin/bash still is on macOS. The `${x[@]+…}` form is the portable expansion.
  local -a traffic_flags=()
  if [[ "${1:?deploy_revision needs 'candidate' or 'live'}" == candidate ]]; then
    # A candidate that receives no traffic. This is the whole safety model of this pipeline: five
    # defects have reached this service and every one passed a fully green verify.sh, so a
    # revision is not trusted because it deployed — it is trusted because verify-deployment.sh
    # passed against it while nobody was being served by it.
    traffic_flags=(--no-traffic "--tag=${CANDIDATE_TAG}")
  fi

  run gcloud beta run deploy "$SERVICE" \
    --image "${REGISTRY}/${SERVICE}:${TAG}" \
    --region "$REGION" --project "$PROJECT_ID" \
    --execution-environment gen2 --sandbox-launcher \
    --service-account "$RUNTIME_SA" \
    --add-cloudsql-instances "$SQL_INSTANCE" \
    --set-env-vars "SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,SANDBOX_MAX_CONCURRENT=4,FRONTEND_ORIGIN=${origin}" \
    --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,OIDC_ISSUER=oidc-issuer:latest,OIDC_AUDIENCE=oidc-audience:latest,OIDC_JWKS_URL=oidc-jwks-url:latest \
    --cpu 2 --memory 2Gi --concurrency 8 --max-instances 2 \
    --network app-net --subnet app-subnet --vpc-egress private-ranges-only \
    --allow-unauthenticated \
    ${traffic_flags[@]+"${traffic_flags[@]}"}

  # The invoker binding, explicitly and every time. Domain Restricted Sharing makes
  # --allow-unauthenticated print a warning and carry on rather than fail (deploy runbook §3), so
  # a create that looked fine can leave a URL that 403s for everyone. Idempotent.
  run gcloud run services add-iam-policy-binding "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" \
    --member=allUsers --role=roles/run.invoker
}

# What CI runs. Refuses to create the service, on purpose: the first revision of a new service
# takes 100% of traffic immediately, so it cannot be verified before users reach it, and this
# pipeline's one invariant does not get an exception. `preflight` already catches this; the check is
# repeated here so calling `deploy` directly cannot skip it.
deploy() {
  if [[ -z "$(service_url)" ]]; then
    echo "service '${SERVICE}' does not exist — CD does not create it." >&2
    echo "  Run the first deploy after a rebuild by hand:" >&2
    echo "    TAG=${TAG:-<tag>} ./scripts/deploy-cloud-run.sh create" >&2
    exit 3
  fi
  deploy_revision candidate
}

# The by-hand first deploy after a rebuild. Never called by CI. It verifies immediately afterwards
# because there is no candidate window to verify inside — the revision is already serving, so the
# check is a smoke test rather than a gate, and a failure means deleting the service by hand.
create() {
  if [[ -n "$(service_url)" ]]; then
    echo "service '${SERVICE}' already exists — use 'deploy', which produces a candidate that" >&2
    echo "serves nobody until it has been verified." >&2
    exit 1
  fi
  echo
  echo "==> creating ${SERVICE}. Cloud Run gives the first revision 100% of traffic, so this one"
  echo "    is live before it is verified. That is why CD refuses this path. If the verification"
  echo "    below fails, delete it rather than leaving it public:"
  echo "      gcloud run services delete ${SERVICE} --region=${REGION} --project=${PROJECT_ID}"
  deploy_revision live
  verify
}

verify() {
  local url
  url="$(candidate_url)"
  if [[ -z "$url" ]]; then
    url="$(service_url)"
  fi
  if [[ -z "$url" ]]; then
    echo "no service URL to verify — is ${SERVICE} deployed?" >&2
    exit 1
  fi

  # Scope the log check to the revision just deployed. Without this the query covers the whole
  # service, and the OLD revision — the one still serving live traffic during candidate
  # verification — can veto promotion of a candidate that is fine.
  local revision
  revision="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
    --format='value(status.latestCreatedRevisionName)' 2>/dev/null)"

  # `env`, not a bare assignment prefix: PROJECT_ID and friends are shell variables here, not
  # exported ones, so a child process would otherwise fall back to verify-deployment.sh's own
  # defaults — which are the right values today and silently wrong the first time this script is
  # pointed at a second project.
  run env PROJECT_ID="$PROJECT_ID" REGION="$REGION" SERVICE="$SERVICE" REVISION="$revision" \
    "$VERIFY_SCRIPT" all "$url"
}

promote() {
  if [[ -z "$(candidate_url)" ]]; then
    echo
    echo "==> no candidate revision — the deploy created the service and it is already serving."
    return 0
  fi
  # --to-latest, NEVER --to-revisions. Pinning traffic to a named revision makes the *next* deploy
  # serve nobody: gcloud reports Done and the only hint is one word in its own success line,
  # "serving 0 percent of traffic" (deploy runbook §5).
  #
  # And the exit code is ignored on purpose. The 2026-08-17 rollback drill recorded update-traffic
  # moving traffic correctly and THEN exiting non-zero on a stale service template. A pipeline that
  # trusts the exit code concludes the promote failed while it succeeded, and whatever it does next
  # is worse than doing nothing. The split below is the actual answer.
  run gcloud run services update-traffic "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --to-latest || true

  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json |
    python3 -c '
import json, sys
d = json.load(sys.stdin)
traffic = d.get("status", {}).get("traffic", [])
serving = [t for t in traffic
           if t.get("latestRevision") and t.get("percent") == 100 and not t.get("tag")]
if not serving:
    print("traffic is NOT 100% on the latest revision:", json.dumps(traffic), file=sys.stderr)
    print("update-traffic may have exited 0 without moving anything. Read the split, then see",
          file=sys.stderr)
    print("docs/runbooks/gcp-deploy.md section 5.", file=sys.stderr)
    sys.exit(1)
print("    100% of traffic on", serving[0].get("revisionName"))
'
}

all() {
  preflight
  build
  deploy
  verify
  promote
}

case "${1:-all}" in
all) all ;;
preflight) preflight ;;
build) build ;;
build:remote) build:remote ;;
deploy) deploy ;;
create) create ;;
verify) verify ;;
promote) promote ;;
*)
  echo "unknown target: $1" >&2
  exit 2
  ;;
esac
