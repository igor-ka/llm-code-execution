# Spec: deploy the app so users can reach it

Epic: [#79](https://github.com/igor-ka/llm-code-execution/issues/79) · Status: **all questions
answered (D1–D10) — ready to plan**

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

## Open questions

**None — all resolved (D1–D10).** Two items deferred as configuration rather than architecture:
the Cloud Run instance size (follows from D7 and the concurrency cap — chosen in the plan, verified
in Phase 2), and the GCP region (must satisfy Cloud Run gen2 + sandboxes preview availability and
Cloud SQL in one place; a Phase 1 lookup, not a design decision).

## Residual risk

Recorded rather than solved:

1. **Preview dependency** (D6). A Pre-GA feature can change or be withdrawn. Mitigated by the
   `SandboxBackend` seam — a change is one class, not a rewrite.
2. **Per-execution resource caps weaken** (D7). Bounded by the concurrency cap and the timeout,
   but a hostile payload can degrade the instance it runs on.
3. **A security control's state sits with a third party** (D8). Upstash holds the quota counters,
   so its availability and its own rate limits now feed the fail-open path. Bounded by the same
   alarm ADR-0003 S9 already demands.
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
