# Spec: deploy the app so users can reach it

Epic: [#79](https://github.com/igor-ka/llm-code-execution/issues/79) · Status: **all questions
answered (D1–D23)** · Phases 0–2 shipped · [Phase 3 plan](../plans/2026-08-17-deploy-to-gcp-phase3.md)
reviewed and approved 2026-08-17

Stack, commands, project layout, code style, and testing strategy are not restated here; they
live in [`CLAUDE.md`](../../CLAUDE.md) and [`README.md`](../../README.md).

## Objective

Put the application somewhere a user who is not the author can reach it, over HTTPS, without
weakening any security property the local build already has. Everything shipped so far — the auth
gate (#9), per-user history (#37), per-user quotas (#62) — is built for multiple users and
reachable by none.

Done means: a URL, a login, a prompt, generated code, and a real execution — with the isolation
checks in [`README.md`](../../README.md) re-verified against the *deployed* sandbox rather than
inherited from the local one.

> **This is a security change, not just an ops change.** Today the app's threat model rests on
> *"nobody but the author can reach it."* Deployment removes that assumption. Every control that
> was previously belt-and-braces becomes load-bearing on the same day the URL becomes public.

## Context — what the code does today

Grounding for the criteria below; no design implied. Verified on `main` @ `86f208d`.

1. [`dockerBackend.ts:37`](../../backend/src/sandbox/dockerBackend.ts#L37) — `new Docker()`
   defaults to `/var/run/docker.sock`, mounted into the backend by
   [`docker-compose.yml`](../../docker-compose.yml). **This is the single hardest blocker.** No
   managed platform will host a container that can drive the host's Docker daemon; a socket mount
   is equivalent to root on the host.
2. [`base.ts`](../../backend/src/sandbox/base.ts) — the `SandboxBackend` seam already exists and
   its docstring already anticipates this work: *"locally we run DockerBackend, but a
   CloudRunBackend … implements the exact same `execute()` contract with no changes to callers."*
   The port is real; only an implementation is missing.
3. [`dockerBackend.ts:71-86`](../../backend/src/sandbox/dockerBackend.ts#L71) — the isolation
   actually enforced per execution: `NetworkMode: "none"`, memory + swap cap, `NanoCpus`,
   `PidsLimit`, `ReadonlyRootfs`, two small tmpfs mounts, `CapDrop: ["ALL"]`,
   `no-new-privileges`, non-root `1000:1000`. **Any replacement backend is measured against this
   list, item by item.**
4. [`concurrencyLimited.ts`](../../backend/src/sandbox/concurrencyLimited.ts) — the concurrency
   cap is a *decorator* over `SandboxBackend`, written so "the future CloudRunBackend inherits the
   cap unchanged." It transfers for free.
5. [`index.ts:25`](../../backend/src/index.ts#L25) — `createApp().listen(...)` and nothing else.
   No `SIGTERM` handler, so every rolling deploy kills in-flight executions and drops the pool
   mid-query.
6. [`migrate.ts:12`](../../backend/src/history/migrate.ts#L12) — `migrate()` opens a transaction
   but takes **no advisory lock**. One instance is fine; two starting together race.
7. No structured logging anywhere in `backend/src` — no logger module, no `LOG_FORMAT`. Cloud
   Logging would ingest unparsed lines, and no alert can be built on them.
8. [`frontend/Dockerfile`](../../frontend/Dockerfile) is a **Vite dev-server image**, by its own
   first comment. There is no production build-and-serve path, so there is also no server that
   emits the production CSP — [`csp.ts`](../../frontend/src/csp.ts) exists but nothing in a
   deployed topology would apply it.
9. Configuration is a repo-root `.env` read by [`config.ts:13`](../../backend/src/config.ts#L13),
   including `ANTHROPIC_API_KEY`. There is no secret-manager path.
10. [`docker-compose.yml`](../../docker-compose.yml) declares five services — backend, sandbox
    image builder, `postgres:16`, `redis:7-alpine`, frontend. Every one of them needs a hosted
    answer or a deliberate omission.

## Boundaries

**In scope**

- A public HTTPS endpoint serving the SPA and the API, with the Auth0 login working against it.
- A `SandboxBackend` implementation that runs on the hosting platform with **no Docker socket**,
  re-verified against the item-by-item list in Context §3.
- Hosted Postgres for history, and a hosted answer for the Redis the quota requires (the backend
  refuses to boot without `REDIS_URL` — ADR-0003 D6).
- Secrets from a secret manager, never baked into an image or a repo file.
- **Deployability hardening of the app itself** (Phase 0): structured logging, graceful shutdown,
  an advisory-locked migration runner, a production frontend image. App-only, no GCP.
- Infrastructure as Terraform, in a new top-level `infra/` directory (D10).
- A **budget alarm** and a documented day-91 teardown, because the funding model is trial credits.
- Re-verification of the existing security batteries against the deployed environment — auth gate,
  history isolation (INV-1…8), quota and concurrency refusals.
- README security posture and roadmap updates, and the ADR that records the hosting decision.

**Out of scope**

- **Multi-tenancy.** `tenantId` stays carried-but-unused; the deploy is single-tenant (#9).
- **Custom domain.** The platform's generated hostname is enough; a domain is cosmetic and costs
  money.
- **Horizontal scale targets, load testing, CDN tuning.** One user reaching the app is the bar.
- **Backups, PITR, DR.** The database holds disposable learning data; day 91 destroys it anyway.
- **Monitoring beyond the budget alarm and the fail-open quota alert** already required by S9 of
  the rate-limiting spec. No dashboards, no SLOs, no paging.
- **Vertex AI for Claude.** Named in the README roadmap; unrelated to reachability.
- **Changing the per-execution limits themselves.** They are re-verified, not re-tuned.

**Non-goal.** This is not "make it production-grade." It is *make it reachable without lying about
its security posture*. Where those conflict, the README's posture section is updated to tell the
truth rather than the deploy being declared done.

## Success criteria

| # | Criterion |
| --- | --- |
| S1 | A second person, on a different machine, can open the URL, log in, and get a correct result for *"compute the first 20 Fibonacci numbers"*. |
| S2 | **No Docker socket exists anywhere in the deployed topology.** Not mounted, not reachable, not optional. |
| S3 | All four README isolation checks re-run **against the deployed backend** and pass: network egress denied, host paths unreadable and the FS read-only outside the writable temp, infinite loop killed at the timeout with `timed_out: true`, fork bomb contained. |
| S4 | Whatever the new backend *cannot* enforce from Context §3 is written down in the README's posture section before launch — not discovered later. An honest gap beats a silent one. |
| S5 | The auth gate, the INV-1…8 history isolation battery, and the 429/503 refusals all pass against the deployed environment, not just locally. |
| S6 | No secret is present in any image layer, any repo file, or any Terraform state committed to git. `ANTHROPIC_API_KEY` reaches the process from a secret manager. |
| S7 | `terraform apply` from an empty project reproduces the environment; `terraform destroy` leaves **zero billable resources**. Both are exercised, not assumed. |
| S8 | A budget alert fires at a threshold below the remaining credits, and the day-91 teardown is a runbook in `docs/runbooks/`, not a memory. |
| S9 | The first successful deploy is performed **by hand**. CD, when it exists, performs the same steps — and no long-lived service-account key exists anywhere. |
| S10 | A bad revision can be rolled back to the previous one, and the rollback is exercised once. |
| S11 | `verify.sh` / CI parity holds: any new check runs in both, and `docs/sdlc.md` is updated in the same PR per the contract. |
| S12 | Running cost stays inside the trial credits, and the README no longer claims the app is HTTP-only or unreachable. |

S3 and S4 are the criteria most likely to be quietly skipped, because they require re-running
adversarial checks against a platform whose isolation you did not build and cannot inspect. S7 is
the one most likely to be *claimed* without evidence — a `destroy` that leaves a bucket, a disk, or
a reserved IP behind is a slow leak against a fixed budget.

## Decisions

D1–D5 carried in from 2026-08-05; D6–D10 answered 2026-08-09. Recorded here so the plan does
not re-litigate them.

**D1 — Cloud Run, not GKE.** Terraform is an explicit learning goal; Kubernetes explicitly is not.
GKE would have taught K8s with Terraform as a thin wrapper around cluster creation, and cost
~$75–110/mo in nodes even idle — roughly $250 of the credits. Cloud Run scales to zero and
*removes* the host-Docker-socket problem rather than hosting it. **Gets an ADR.**

**D2 — Credits only, no out-of-pocket spend.** The $300/90-day trial funds everything. The exit is
`terraform destroy` on day 91 and rebuild on demand, not keep-it-running-at-$0. If that flips,
Cloud SQL is out and it becomes a free-tier `e2-micro` or Neon. Always Free does not survive the
trial automatically — it needs an upgraded billing account.

**D3 — Four phases, deliberately sequenced** so Terraform learning stays isolated from app
debugging: (0) deployability hardening, app-only, no GCP; (1) GCP foundation in Terraform — state
bucket, Artifact Registry, service accounts, Secret Manager, WIF, budget alert — with nothing
deployed; (2) the deploy itself, by hand; (3) CD via GitHub Actions + Workload Identity
Federation.

**D4 — Manual before automated.** Never automate a deploy that has not been done by hand. S9
encodes this.

**D5 — Cloud SQL for Postgres, not self-hosted.** ~$8–10/mo for a shared-core instance — about
$30 of the credits over 90 days — and a far richer Terraform exercise (private IP, VPC peering,
IAM, Secret Manager) than a Postgres container. Shared-core carries no SLA, which is acceptable
for this workload.

Answered 2026-08-09, after the research recorded in the Sources section.

**D6 — Cloud Run sandboxes execute the untrusted code.**
[Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) reached public
preview in July 2026 — after D1–D4 were made, and they change the answer those decisions assumed.
A sandbox runs *inside* the Cloud Run instance: deploy with `--sandbox-launcher`, then call
`/usr/local/gcp/bin/sandbox do -- <cmd>` from the backend process.

| | **Chosen: Cloud Run sandboxes** | Rejected: Cloud Run Jobs | Rejected: Docker on a VM |
| --- | --- | --- | --- |
| Network default | **Deny-by-default** | Internet egress | `--network none` |
| Regains today's isolation? | Natively | Only with Direct VPC egress **+** a deny-all egress rule at priority > 1000 | Already there |
| Startup | ~500 ms | Seconds per execution | Sub-second |
| Credentials | No host env, no secrets, **no metadata server** | Task SA, metadata reachable | N/A |
| Per-execution CPU/mem cap | **Undocumented** (D7) | Yes | Yes |
| Cost | None beyond the instance | Per execution | VM billed 24/7 |
| Maturity | Preview, gen2 only | GA | GA |

*Why it beats the `CloudRunJobsBackend` the epic assumed:* it **improves** two of the three
isolation properties rather than merely restoring them — deny-by-default egress, and no metadata
server, which the local Docker backend never had to think about — and it deletes the entire
Direct-VPC-egress-plus-firewall workaround that Jobs needs just to reach parity. It also makes the
concurrency cap *correctly* scoped: sandboxes share the instance, the cap is per-instance, so
[ADR-0003](../adr/0003-rate-limiting-approach.md)'s residual risk #2 resolves itself instead of
needing a rewrite. Docker-on-a-VM was rejected for contradicting D1 outright — a VM billed around
the clock, host patching we own, and no scale-to-zero.

*Accepted cost:* **a hard dependency on a Pre-GA feature.** No SLA, and the CLI surface can change
under us. Bounded by the [`SandboxBackend`](../../backend/src/sandbox/base.ts) seam — a withdrawal
or breaking change costs one class, not a rewrite — and by the fact that `DockerBackend` remains
the local path either way.

**D7 — The per-execution CPU, memory and PID caps are not replaced. The gap is documented.**
Docker enforces 256 MB, 0.5 CPU and 64 PIDs per execution today
([Context §3](#context--what-the-code-does-today)); sandboxes share the host instance's allocation
and Google documents no per-sandbox equivalents. Rejected: a Phase 2 probe to hunt for
undocumented limits (parks an open security question inside the deploy phase), and falling back to
Jobs for cap fidelity (pays the egress workaround and seconds of latency to keep a property that
matters less than the one it would cost).

What actually holds the line instead: the **concurrency cap** bounds how many sandboxes run at
once, the **wall-clock timeout** still kills runaways, and the instance is sized so N concurrent
sandboxes fit. **The risk changes shape rather than growing** — a memory-hungry payload degrades
the instance it shares instead of escaping it. That is a real regression and S4 makes it visible:
it goes into the README's posture section *before* launch, not after someone finds it.

**D8 — Redis is Upstash's free tier, not Memorystore.**
256 MB and 500k commands/month at $0, against ~$36/mo for Memorystore Basic — about **$110 of the
$300** for a counter holding a handful of keys. The credits go to Cloud SQL and Cloud Run instead.
Rejected: Memorystore (the better Terraform exercise, but a third of the budget for the least
interesting resource) and Redis co-located on the Cloud Run instance (dies with the instance,
reintroducing exactly the restart-bypass ADR-0003 D1 rejected).

*Accepted cost:* **a third party holds the state of a security control**, outside the GCP blast
radius and outside `terraform destroy`. Two consequences the plan must carry: the Upstash
Terraform provider needs its own credential, and ADR-0003's fail-open path (D5 there) now also
covers *"the third party is down or has rate-limited us"* — a likelier event than a Memorystore
outage.

**D9 — The SPA is served from the same Cloud Run service as the API.**
One origin, one deploy path. Rejected: Firebase Hosting — a second toolchain to maintain, resources
partly outside the Terraform story, and it keeps the SPA cross-origin. Single-origin deletes a
class of bug this repo has already hit once: ADR-0003 D7 records that `Retry-After` is invisible to
the browser today because it is not CORS-safelisted. Same-origin makes that irrelevant. It also
makes Phase 0's production nginx image load-bearing rather than incidental.

*Accepted cost:* Cloud Run serves static bytes, and `VITE_*` values are baked at build time, so a
given image is bound to one environment. Both were already true of the Phase 0 image.

**D10 — Terraform lives in `infra/`, gated like everything else.**
A new top-level directory with an `infra/verify.sh` (`terraform fmt -check`, `terraform validate`)
mirrored by a `Terraform checks` CI job, added in Phase 1 alongside the first `.tf` file. The
mirroring rule in [`CLAUDE.md`](../../CLAUDE.md) is repo law and infrastructure does not get an
exemption on its first day. Adding a required check means the "Protect main" ruleset changes in the
same PR — the job-name contract applies here too.

**D11 — Cloud SQL keeps a public IP with an empty authorized-network list, reached over the
built-in connector.** Decided 2026-08-16, replacing the Phase 2 plan's first draft. That draft set
`ipv4_enabled = false` with no private network, which Cloud SQL simply refuses — *"At least one of
Public IP or Private IP connectivity must be enabled"* — and Cloud Run's connector requires either
a public IP or a private IP plus Direct VPC egress. Rejected: private IP with VPC peering, which
is the richer Terraform exercise D5 mentioned but adds a VPC, a peering range and an egress path
to a phase already spending its risk budget on a preview sandbox feature.

*Why "public IP" is not the exposure it sounds like:* `authorized_networks` is empty, so no
address may connect directly; access is brokered by the Cloud SQL Auth Proxy and authorised by
IAM, with TLS enforced. The IP exists; nothing can use it.

**D12 — Cloud Run request concurrency is 8, not 4.** The plan's first draft matched it to
`SANDBOX_MAX_CONCURRENT=4`, which would have made the concurrency cap **unreachable**: Cloud Run
caps in-flight requests per instance, so at most four requests could ever be inside
`tryAcquire()` and it could never refuse. The 503 path would have been dead code in production —
and D7 nominates that cap as the replacement for the per-execution limits it removes. A control
that cannot fire is worse than none, because it reads as present.

**D13 — Sandboxed code runs with `sudo` privileges as a non-root user, and that is accepted.**
Google's code-execution documentation states it. Locally the payload runs under `CapDrop: ["ALL"]`
plus `no-new-privileges` as uid 1000, so this is a **fourth** item off the isolation list in the
spec's Context §3, alongside the memory, CPU and PID caps of D7. Accepted because the writable
layer is an ephemeral in-memory overlay, the environment is not inherited and the metadata server
is unreachable — the payload gains root over a filesystem that is discarded, not over anything
that outlives it. **S4 requires this in the README before launch.**

**D14 — The rollback exercise breaks the image tag, not `REDIS_URL`.** The plan's first draft
deployed a revision with an unreachable Redis and called it broken. It is not:
`assertRedisConfigured` only checks the string is non-empty, and `RedisQuotaStore` connects
lazily, so that revision boots healthy and merely fails the quota **open** (ADR-0003 D5). S10
would have been "proven" by rolling back a revision that was serving traffic with a security
control silently off. Constraint carried into the plan: a revision that fails to *start* never
receives traffic, so there would be nothing to roll back from — the broken revision must start
and then misbehave.

**D15 — `terraform import` of the hand-deployed service targets "no behavioural changes", not an
empty plan.** A hand-written `google_cloud_run_v2_service` imported from `gcloud run deploy` will
show residual diffs on `launch_stage`, gcloud-set annotations, `traffic`, probes and the Cloud SQL
volume. An unreachable bar invites either churn or a quiet skip; the residual diff is listed in
the deploy runbook instead, and reviewed rather than eliminated.

**D16 — The sandbox can read the application image, and S4 records it.** Because sandboxes see the
host container's filesystem read-only (D6), a payload can now read `/app/dist`,
`/app/node_modules`, `/app/migrations` and the built SPA. Locally it saw only `python:3.12-slim`.
No secret is exposed — the environment is not inherited and the metadata server is unreachable —
but *"host paths unreadable"* in the README now means something materially narrower, and saying so
is the whole point of S4.

**D17 — Memorystore for Valkey replaces Upstash, on a teardown-when-idle cost model.**
Decided 2026-08-16, **superseding D8**. The goal changed: keeping every component inside GCP,
accepted as worth paying for, rather than minimising spend by putting one control with a third
party.

*Why Valkey and not Memorystore for Redis:* pulled from GCP's own billing catalog for
`us-central1` in CAD, the account's currency — Valkey is **node**-priced at CAD 0.0448/hr for
`SHARED_CORE_NANO`, while Redis Basic M1 is CAD 0.069/**GiB**-hr against a 1 GiB floor. Roughly a
third cheaper for a store holding a handful of TTL'd counters. Google has also frozen Memorystore
for Redis on 7.2 and moved development to Valkey. Same protocol, so `RedisQuotaStore` and the
`redis` client are untouched — this is an infrastructure swap, not an application change.

*The cost model is the decision, not the line item.* Memorystore bills per hour of **existence**
and has no "stop" — only delete. Always-on is ~CAD 33/month for Valkey plus ~CAD 22 for Cloud SQL;
destroyed between working sessions it is ~CAD 3/month at ten hours a week. So `terraform destroy`
stops being an end-of-project ritual and becomes the normal end of a session, and the S7 rehearsal
that proved destroy/rebuild reproduces state is now load-bearing rather than reassurance.

*Accepted costs, both real:*

1. **A VPC arrives after all.** Valkey is reachable only over Private Service Connect, which needs
   a network to attach to — the complexity P2-D3 avoided for Cloud SQL by using the built-in
   connector. There is no equivalent for Memorystore, so `infra/` now carries a VPC, a subnet and
   a service connection policy, and the Cloud Run service needs Direct VPC egress to reach it.
2. **Every rebuild costs ~15–20 minutes and a secret repopulation.** Mostly Cloud SQL
   provisioning. The endpoint changes on each rebuild, so `redis-url` is repopulated from
   `terraform output valkey_endpoint` — the payloads are deliberately not in Terraform (S6).

*What this buys:* one provider, one bill, one teardown, and D8's residual risk — a third party
holding the state of a security control — disappears.

D18–D23 answered 2026-08-17, raised by the staff review of the
[Phase 3 plan](../plans/2026-08-17-deploy-to-gcp-phase3.md) and decided the same day.

**D18 — CD deploys the application. It never runs `terraform apply`, and it never reads Terraform
state.** ADR-0005 already puts the service outside Terraform, so there is nothing about it for an
apply to do; applying the rest of `infra/` from CI would need Cloud SQL, Compute, Memorystore,
Secret Manager and IAM admin *plus* read-write on the state bucket — the grant `infra/build.tf`
already refuses the build identity, because state holds the generated Cloud SQL password in
cleartext. Every project-specific value the deploy needs is instead derived from the resource names
Terraform itself uses, so a rename breaks the deploy loudly rather than silently. CD's blast radius
stays "can deploy a revision of one service, running as one account".

**D19 — A revision receives no traffic until it has been verified, and CD does not create the
service.** `gcloud beta run deploy --no-traffic --tag=candidate`, then the assertion battery against
the tag URL, then `update-traffic --to-latest` with the resulting split **read back** rather than
trusted (the rollback drill recorded `update-traffic` moving traffic correctly and *then* exiting
non-zero). A failed verification promotes nothing and the previous revision keeps serving.

The invariant has no exception, and that is what costs CD the create path: Cloud Run gives a
brand-new service's first revision 100% of traffic, so it cannot be verified before users reach it.
Since teardown deletes the service every session, that path is common rather than rare — so
creating the service stays a by-hand command, which is what D4 asks for anyway. *Accepted cost:* CD
is not a one-button recovery from a torn-down environment. *Rejected:* letting CD create and then
delete the service on failure, which destroys the evidence and leaves a broken service publicly
reachable in the meantime.

**D20 — CI builds the image in the GitHub runner; Cloud Build is the by-hand path.** `ubuntu-latest`
is amd64, so the emulation problem that put builds on Cloud Build — a `linux/amd64` build on Apple
Silicon takes over ten minutes and was OOM-killed twice — does not exist there, and the federated
principal already holds `artifactregistry.writer`, so the runner path needs **no new IAM**.

*Recorded because it will be re-proposed:* the security argument for Cloud Build does not survive
inspection. It runs "the builder is `app-build`, which cannot deploy" — true, and irrelevant here,
because the federated principal can push an image and deploy it either way. `infra/build.tf`'s
separation protects against a malicious `cloudbuild.yaml` running as project Editor, and that threat
does not change based on who invokes the build. Both transports live in
`scripts/deploy-cloud-run.sh` as `build` and `build:remote`, over one Dockerfile.

**D21 — CD verifies only what needs no credentials, and states what it does not verify.** It reads
the deployed revision's **shape** back from the API and asserts the deploy runbook's flag list —
`sandboxLauncher`, gen2, the VPC interfaces, the Cloud SQL instance, the runtime identity,
concurrency 8, and `FRONTEND_ORIGIN` equal to the service URL — plus `/api/health`, the production
CSP header, and an unauthenticated `POST /api/execute` returning 401.

It cannot cover #191 or #195: the quota keys on the verified `sub` and auth runs first, so no
credential-free request reaches it. Covering them would mean an Auth0 machine-to-machine credential
held permanently in GitHub, for an endpoint that spends money, when
[`gcp-isolation-probes.md`](../runbooks/gcp-isolation-probes.md) says to delete those applications
once the probes are done. That runbook stays the authority, and the pipeline's job summary prints
the gap on every run rather than implying coverage it does not have.

**D22 — The between-sessions teardown is targeted at the billable resources, so federation
survives.** A plain `terraform destroy` removes `google_iam_workload_identity_pool.github`; pools
soft-delete and the ID is reserved for ~30 days, so the next `terraform apply` cannot re-create it
— which after Phase 3 means **CD cannot authenticate for a month**. The teardown runbook already
recorded the soft-delete; what changed is that it became load-bearing. `-exclude` would express this
better and Terraform 1.15.8 does not have it, so the session-end destroy names the five billable
addresses instead. Everything left standing is free or near-free, and the four static secret
payloads now survive a teardown, halving the manual work in a rebuild.

**D23 — Dependabot's auto-merge moves to a GitHub App, so its merges are not an exception.** GitHub
starts no workflow run for a push made with `GITHUB_TOKEN`, and `dependabot-auto-merge.yml` arms
native auto-merge with exactly that token — so an auto-merged bump has always landed on `main` with
no push-side `CI` run, and after Phase 3 would land with no deploy. `docs/sdlc.md` documented the
first half and warned that "anything built later that keys off *CI ran on main* must not assume
otherwise"; CD is that later thing. A minimal GitHub App holding `contents: write` and
`pull_requests: write` mints an installation token that expires in an hour, and the `apply` job uses
it. *Rejected:* a fine-grained PAT, which is a long-lived write-scoped credential in the repository
— the thing P1-D4 avoided on the GCP side; and a scheduled `Deploy` sweep, which reaches the same
end state within a day but leaves Dependabot a bounded exception rather than no exception.

## Open questions

**None blocking — D1–D23 are all decided.** One non-blocking governance question remains open;
it is stated at the end of this section rather than left implicit. Phase 2's six open questions were raised by the staff review of
its plan on 2026-08-16 and decided the same day; they are D11–D16 above. Phase 3's seven were raised
on 2026-08-17 and decided the same day; they are D18–D23, one of them dissolved rather than decided
(`roles/storage.objectUser` and its missing `storage.buckets.get` stopped mattering when D20 removed
the grant).

One item is **open but not blocking**, and is a repository-governance question rather than a deploy
one: now that merging to `main` is production deploy authority (D19, and ADR-0007 records it), the
"Protect main" ruleset still has `required_approving_review_count: 0`. Whether that should change is
undecided. Two items were deferred
as configuration rather than architecture. Both are now closed:

- **GCP region — resolved 2026-08-10: `us-central1`.** The Phase 1 lookup found that Google
  publishes no region list for the sandboxes preview; the
  [configuration docs](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes)
  state the gen2 requirement and the CPU/memory-sharing limitation but say nothing about
  availability. `us-central1` was chosen as the best available proxy — it has Cloud Run gen2 and
  Cloud SQL, and it is where previews land first. Accepted cost: ~40 ms of extra latency from
  Montreal versus `northamerica-northeast1`, and US residency for data the Boundaries section
  already calls disposable. Held in a single `var.region` so reversing it is one line plus a
  rebuild. See [P1-D1](../plans/2026-08-10-deploy-to-gcp-phase1.md).
- **Cloud Run instance size — resolved 2026-08-16: 2 vCPU / 2 GiB, `max-instances=2`,
  concurrency 8.** Sandboxes share the instance's allocation (D7), so it must hold four concurrent
  executions plus the app; `max-instances=2` bounds a runaway bill on a fixed budget. The
  concurrency figure is D12's, not the sandbox cap's. Verified against real executions in Phase 2.

## Residual risk

Recorded rather than solved:

1. **Preview dependency** (D6). A Pre-GA feature can change or be withdrawn. Mitigated by the
   `SandboxBackend` seam — a change is one class, not a rewrite.
2. **Per-execution resource caps weaken** (D7), **and the payload runs with sudo inside the
   sandbox** (D13). Bounded by the concurrency cap and the timeout, but a hostile payload can
   degrade the instance it shares and has root over the ephemeral overlay. It can also read the
   application image (D16). None of this reaches a secret; all of it is narrower than the local
   build, and S4 requires the README to say so before launch.
3. **The environment is destroyed between working sessions** (D17). That is the cost model, not a
   failure — but it means the deployed URL is live only while someone is working, every rebuild
   takes 15–20 minutes, and the secret payloads must be repopulated each time. D8's third-party
   risk is gone with Upstash.
4. **A public URL invites real adversaries.** The quota's fail-open path (ADR-0003 D5) and the
   single-tenant auth model were both accepted when the audience was one person.
5. **Day-91 cliff.** The environment is deliberately destroyable, so "deployed" is a state that
   ends on a known date unless the billing decision is revisited.

## Sources

- [Code execution in Cloud Run](https://docs.cloud.google.com/run/docs/code-execution) ·
  [Configure sandboxes for services](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes) ·
  [Public preview announcement](https://cloud.google.com/blog/topics/developers-practitioners/google-cloud-run-sandboxes-are-in-public-preview)
- [Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc) ·
  [Execute jobs with overrides](https://docs.cloud.google.com/run/docs/execute/jobs)
- [Memorystore for Redis pricing](https://cloud.google.com/memorystore/docs/redis/pricing) ·
  [Upstash pricing](https://upstash.com/pricing/redis) ·
  [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
