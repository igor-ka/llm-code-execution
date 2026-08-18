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
# Usage: ./scripts/deploy-cloud-run.sh <target>
#   help          (default) print this usage. The default is deliberately NOT `all`: every other
#                 target here changes production.
#   all           preflight + build + deploy + verify + promote
#   preflight     does the credential work, and is there a service to deploy a revision of?
#   build         docker build + push, linux/amd64. What CI runs.
#   build:remote  the same Dockerfile via Cloud Build. What a human on Apple Silicon runs.
#   deploy        gcloud beta run deploy — always a NO-TRAFFIC candidate. Refuses to create.
#   create        the FIRST deploy after a rebuild. By hand only; CI never calls this.
#   verify        scripts/verify-deployment.sh against the candidate (or `verify live`)
#   promote       100% of traffic to the VERIFIED candidate, then CHECK THE SPLIT
#
# Exit contract — the workflow branches on it, so it is interface, not implementation detail:
#   0  the target succeeded
#   3  nothing to deploy: the Terraform layer is torn down, or the service does not exist yet
#      (spec D17 — the environment is destroyed between sessions). NOT a failure.
#   2  usage: unknown target
#   1  everything else, including a credential that does not work
#
# The 2 and 3 codes are ONLY ever produced by this script's own `exit` statements. Child processes
# with their own exit vocabularies are normalised to 1 (see verify), because a child exiting 3 for
# its own reasons would otherwise be read by the workflow as "nothing to deploy" and finish green.
# gcloud's own failures still surface as gcloud's status; it uses 1 for errors and 2 only for
# malformed invocations, which are this script's bugs and are covered by the test suite.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-llm-code-exec-260815}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-app}"
TAG="${TAG:-}"
CANDIDATE_TAG="candidate"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-./scripts/verify-deployment.sh}"
# Cloud Run's status is eventually consistent with its spec, so the promote readback polls rather
# than reading once. Overridable so the test suite does not sleep.
PROMOTE_POLL_ATTEMPTS="${PROMOTE_POLL_ATTEMPTS:-10}"
PROMOTE_POLL_SECONDS="${PROMOTE_POLL_SECONDS:-3}"

# Derived, never read from `terraform output` — see the header.
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/app"
BUILD_SA="app-build@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_BUCKET="gs://${PROJECT_ID}-build-source"
RUNTIME_SA="app-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SQL_INSTANCE="${PROJECT_ID}:${REGION}:app-db"

# The usage text IS the header comment block, printed without its "# " prefix — so there is one
# copy of it and `--help` cannot drift from what the file says. Matched on content rather than line
# numbers, which would silently print the wrong block the first time the header grows a line.
usage() {
  awk '/^# Usage:/{f=1} f && /^#/{sub(/^# ?/, ""); print; next} f{exit}' "$0"
}

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

# Checked BEFORE anything is deployed, never after. `create` and `all` both deploy and then verify,
# so a missing verifier discovered at verify time would leave a live, unverified revision behind —
# which is the one outcome this script exists to prevent.
require_verify_script() {
  if [[ ! -x "$VERIFY_SCRIPT" ]]; then
    echo "verification script not found or not executable: ${VERIFY_SCRIPT}" >&2
    echo "  Nothing has been deployed. Until it exists, use the 'deploy' target and verify by" >&2
    echo "  hand from docs/runbooks/gcp-deploy.md section 4 rather than 'all' or 'create'." >&2
    exit 1
  fi
}

# "present" or "absent", and a hard exit 1 on anything else.
#
# `list --filter` rather than `describe`, and the difference is the whole point: list exits 0 with
# EMPTY output when the service does not exist, and non-zero ONLY on a real failure. `describe`
# exits non-zero for both, so reading it with stderr discarded turns PERMISSION_DENIED, a disabled
# API and a network blip into "the service does not exist" — which this script reports as exit 3,
# which the workflow reports as green. That is the decorative-probe pattern the three-stage
# preflight exists to avoid, and it would have applied to the stage that matters most.
service_state() {
  local out
  if ! out="$(gcloud run services list --region="$REGION" --project="$PROJECT_ID" \
    --filter="metadata.name=${SERVICE}" --format='value(metadata.name)' 2>&1)"; then
    echo "cannot list Cloud Run services in ${PROJECT_ID}/${REGION} — this is an ERROR, not an" >&2
    echo "absent service, and it must not be reported as 'nothing to deploy':" >&2
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    exit 1
  fi
  if [[ -z "$out" ]]; then echo absent; else echo present; fi
}

service_url() {
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)'
}

# Prints "<url>\t<revisionName>" for the no-traffic candidate, or nothing when there is none.
# Selected by TAG rather than by position: the traffic list also carries the serving entry, and
# `[0]` is a coin flip that happens to work today.
#
# `|| true` on the gcloud side is load-bearing under `set -o pipefail`: without it a failing
# describe makes the whole pipeline non-zero, the caller's assignment inherits that, and errexit
# kills the script before any diagnostic can print — an operator gets a silent exit 1.
candidate() {
  { gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --format=json 2>/dev/null || true; } |
    CANDIDATE_TAG="$CANDIDATE_TAG" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
wanted = os.environ["CANDIDATE_TAG"]
for t in d.get("status", {}).get("traffic", []):
    if t.get("tag") == wanted and t.get("url"):
        print("%s\t%s" % (t["url"], t.get("revisionName", "")))
        break
'
}

latest_revision() {
  gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
    --format='value(status.latestCreatedRevisionName)'
}

preflight() {
  echo
  echo "==> preflight"

  # STAGE 1 — does the credential work? This must FAIL the job, never report "torn down".
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
  #
  # `list --filter`, for the same reason stage 3 uses it: `describe` with stderr discarded reports a
  # disabled artifactregistry API, a missing repository-read grant and a network blip identically
  # to a torn-down environment — and this stage's answer is exit 3, which the workflow finishes
  # green. Stage 1 proving the credential works does not cover it: that call is a different API
  # with a different permission.
  #
  # stdout and stderr are kept APART here, unlike stage 3: `artifacts repositories list` prints a
  # "Listing items under project …" banner on stderr even on success, so folding the streams
  # together would make the empty (torn-down) case look non-empty and this stage could never fire.
  local repos rc=0 errfile
  errfile="$(mktemp)"
  repos="$(gcloud artifacts repositories list --location="$REGION" --project="$PROJECT_ID" \
    --filter="name~/repositories/app$" --format='value(name)' 2>"$errfile")" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "    cannot list Artifact Registry repositories in ${PROJECT_ID}/${REGION} — this is an" >&2
    echo "    ERROR, not a torn-down environment, and must not be reported as 'nothing to deploy':" >&2
    sed 's/^/      /' "$errfile" >&2
    rm -f "$errfile"
    exit 1
  fi
  rm -f "$errfile"
  if [[ -z "$repos" ]]; then
    echo "    no Artifact Registry repository 'app' in ${PROJECT_ID}/${REGION}."
    echo "    The environment is torn down — see docs/runbooks/gcp-teardown.md."
    echo "    Rebuild it with docs/runbooks/gcp-bootstrap.md, then run the 'create' target."
    exit 3
  fi

  # STAGE 3 — is there a SERVICE? Cloud Run gives a brand-new service's first revision 100% of
  # traffic, so `--no-traffic` cannot exist on a create and the one invariant — no user ever sees
  # an unverified revision — would have to carry an exception. It does not: creating the service is
  # the `create` target, run by hand after a rebuild (spec D4/S9), and CI stops here.
  local state
  state="$(service_state)"
  if [[ "$state" == absent ]]; then
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

  # cloudbuild.yaml hardcodes `us-central1-docker.pkg.dev/$PROJECT_ID/app/app:${_TAG}`, so it and
  # this script's REGISTRY/SERVICE derivation are two definitions of one value. Overriding either
  # variable would push an image the deploy then cannot pull — and a failed deploy leaves the
  # service template pointing at a missing image, which the runbook records as poisoning every
  # later mutation. Refuse rather than diverge.
  if [[ "$REGION" != "us-central1" || "$SERVICE" != "app" ]]; then
    echo "build:remote only works with REGION=us-central1 and SERVICE=app." >&2
    echo "  cloudbuild.yaml hardcodes us-central1-docker.pkg.dev/\$PROJECT_ID/app/app:\${_TAG}," >&2
    echo "  so REGION=${REGION} SERVICE=${SERVICE} would push an image 'deploy' cannot pull." >&2
    echo "  Use the 'build' target, which derives the whole path from these variables." >&2
    exit 1
  fi

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
  local mode="${1:?deploy_revision needs 'candidate' or 'live'}"
  local origin project_number

  # FRONTEND_ORIGIN must be the service's own URL. On `deploy` the service exists, so READ it
  # rather than reconstructing it — the `<service>-<number>.<region>.run.app` shape is Cloud Run's
  # current convention, not a guarantee, and a service issued a legacy `-uc.a.run.app` URL would
  # otherwise be told to trust an origin nobody uses. That is the #188 failure class exactly:
  # nothing visibly breaks, because Cloud Run serves the SPA and the API from one origin and
  # same-origin requests never consult CORS.
  if [[ "$mode" == candidate ]]; then
    origin="$(service_url)"
  else
    # Only `create` has no URL to read, so this is the one place the shape has to be assumed.
    project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
    if [[ -z "$project_number" ]]; then
      echo "gcloud projects describe returned an empty project number for ${PROJECT_ID}." >&2
      exit 1
    fi
    origin="https://${SERVICE}-${project_number}.${REGION}.run.app"
  fi
  if [[ -z "$origin" ]]; then
    echo "could not determine the service origin — refusing to deploy with an empty" >&2
    echo "FRONTEND_ORIGIN, which would advertise the localhost default (#188)." >&2
    exit 1
  fi

  # `local -a x=()` plus `"${x[@]}"` is an unbound-variable error under `set -u` on bash 3.2, which
  # is what /bin/bash still is on macOS. The `${x[@]+…}` form is the portable expansion.
  local -a traffic_flags=()
  if [[ "$mode" == candidate ]]; then
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
  # a create that looked fine can leave a URL that 403s for everyone. Idempotent, and re-asserting
  # it is the documented expected state after every rebuild.
  run gcloud run services add-iam-policy-binding "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" \
    --member=allUsers --role=roles/run.invoker
}

# What CI runs. Refuses to create the service, on purpose: the first revision of a new service
# takes 100% of traffic immediately, so it cannot be verified before users reach it, and this
# pipeline's one invariant does not get an exception. `preflight` already catches this; the check
# is repeated here so calling `deploy` directly cannot skip it.
deploy() {
  local state
  state="$(service_state)"
  if [[ "$state" == absent ]]; then
    echo "service '${SERVICE}' does not exist — CD does not create it." >&2
    echo "  Run the first deploy after a rebuild by hand:" >&2
    echo "    TAG=${TAG:-<tag>} ./scripts/deploy-cloud-run.sh create" >&2
    exit 3
  fi
  deploy_revision candidate
}

# The by-hand first deploy after a rebuild. Never called by CI. The verifier is checked BEFORE the
# deploy, not after, so a missing one cannot leave a live unverified service behind.
create() {
  require_verify_script
  local state
  state="$(service_state)"
  if [[ "$state" == present ]]; then
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
  verify live
}

# $1 is `candidate` (the default, what CI runs) or `live` (only `create`, which has no candidate).
#
# There is deliberately NO silent fallback from candidate to live. A missing candidate tag after a
# deploy means something went wrong, and falling back would point the HTTP assertions at the URL
# the PREVIOUS revision is serving while scoping the log query to the new one — every check green,
# against code nobody deployed.
verify() {
  require_verify_script
  local mode="${1:-candidate}" url revision line

  if [[ "$mode" == live ]]; then
    url="$(service_url)"
    revision="$(latest_revision)"
  else
    line="$(candidate)"
    if [[ -z "$line" ]]; then
      echo "no '${CANDIDATE_TAG}'-tagged revision on ${SERVICE}." >&2
      echo "  'deploy' always applies that tag, so its absence means the deploy did not take" >&2
      echo "  effect. Refusing to verify the currently-serving revision and call it a pass." >&2
      exit 1
    fi
    url="${line%%$'\t'*}"
    revision="${line##*$'\t'}"
  fi

  if [[ -z "$url" ]]; then
    echo "no service URL to verify — is ${SERVICE} deployed?" >&2
    exit 1
  fi

  # `env`, not a bare assignment prefix: PROJECT_ID and friends are shell variables here, not
  # exported ones, so a child process would otherwise fall back to verify-deployment.sh's own
  # defaults — which are the right values today and silently wrong the first time this script is
  # pointed at a second project.
  #
  # REVISION scopes the child's log query to the revision under test. Without it the query covers
  # the whole service, and the OLD revision — still serving live traffic during candidate
  # verification — can veto a candidate that is fine.
  #
  # The child's exit status is NORMALISED to 1. It has its own exit vocabulary, and this script's
  # 2 and 3 are read by the workflow as "usage" and "nothing to deploy"; passing a child's 3
  # straight through would finish the pipeline green having verified nothing.
  set +e
  run env PROJECT_ID="$PROJECT_ID" REGION="$REGION" SERVICE="$SERVICE" REVISION="$revision" \
    "$VERIFY_SCRIPT" all "$url"
  local rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "verification failed (${VERIFY_SCRIPT} exited ${rc}). NOT promoting." >&2
    exit 1
  fi
}

promote() {
  local line candidate_url candidate_revision latest
  line="$(candidate)"
  if [[ -z "$line" ]]; then
    # Not a no-op and not a success. `deploy` always tags its revision, and `create` never calls
    # promote — so an absent tag here means the deploy did not take effect, and returning 0 would
    # report a green pipeline that moved no traffic at all.
    echo "no '${CANDIDATE_TAG}'-tagged revision to promote on ${SERVICE}." >&2
    echo "  Nothing has been promoted. Traffic is unchanged." >&2
    exit 1
  fi
  candidate_url="${line%%$'\t'*}"
  candidate_revision="${line##*$'\t'}"

  # The candidate must still be the newest revision. --to-latest promotes whatever is newest at the
  # moment it runs, so if a second deploy landed between verify and promote, this one would send
  # 100% of traffic to a revision nothing has verified — and the readback would pass, because it
  # would only ever have asserted "the latest holds 100%".
  latest="$(latest_revision)"
  if [[ "$candidate_revision" != "$latest" ]]; then
    echo "the verified candidate is ${candidate_revision}, but the latest revision is ${latest}." >&2
    echo "  Another deploy landed in between. Refusing to promote an unverified revision." >&2
    echo "  Re-run deploy + verify against the current image." >&2
    exit 1
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

  # Poll rather than read once. Cloud Run's status is eventually consistent with its spec, and the
  # very case this readback was written for — update-traffic erroring out after applying the split,
  # having skipped its own wait — is the case most likely to be read too early. Failing a promote
  # that succeeded is the same wrong conclusion, one layer down.
  local attempt=1
  while true; do
    if gcloud run services describe "$SERVICE" \
      --region="$REGION" --project="$PROJECT_ID" --format=json |
      EXPECT_REVISION="$candidate_revision" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
traffic = d.get("status", {}).get("traffic", [])
want = os.environ["EXPECT_REVISION"]
ok = [t for t in traffic
      if t.get("revisionName") == want and t.get("percent") == 100 and not t.get("tag")]
if not ok:
    print(json.dumps(traffic))
    sys.exit(1)
'; then
      echo "    100% of traffic on ${candidate_revision}"
      break
    fi
    if [[ "$attempt" -ge "$PROMOTE_POLL_ATTEMPTS" ]]; then
      echo "traffic is NOT 100% on ${candidate_revision} after ${attempt} checks." >&2
      echo "  update-traffic may have exited 0 without moving anything. Read the split by hand," >&2
      echo "  then see docs/runbooks/gcp-deploy.md section 5." >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$PROMOTE_POLL_SECONDS"
  done

  # Drop the tag. Until it is removed the candidate stays reachable at a deterministic public URL
  # (the allUsers invoker binding is service-wide, so it covers tag URLs), which is a second door
  # into a revision the main URL may no longer serve. A failure here does not fail the deploy —
  # traffic is already correct — but it must be loud, because the leftover door is invisible.
  if ! run gcloud run services update-traffic "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --remove-tags="$CANDIDATE_TAG"; then
    echo "WARNING: could not remove the '${CANDIDATE_TAG}' tag. Traffic is correct, but the" >&2
    echo "revision stays publicly reachable at ${candidate_url} until it is removed by hand:" >&2
    echo "  gcloud run services update-traffic ${SERVICE} --region=${REGION} \\" >&2
    echo "    --project=${PROJECT_ID} --remove-tags=${CANDIDATE_TAG}" >&2
  fi
}

all() {
  # Before anything is built or deployed: a verifier discovered missing at verify time would leave
  # a candidate revision behind with nothing having checked it.
  require_verify_script
  preflight
  build
  deploy
  verify candidate
  promote
}

case "${1:-help}" in
help | -h | --help) usage ;;
all) all ;;
preflight) preflight ;;
build) build ;;
build:remote) build:remote ;;
deploy) deploy ;;
create) create ;;
verify) verify "${2:-candidate}" ;;
promote) promote ;;
*)
  echo "unknown target: $1" >&2
  echo >&2
  usage >&2
  exit 2
  ;;
esac
