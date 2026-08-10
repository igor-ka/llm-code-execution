# 4. Hosting and sandbox execution

- **Status:** Accepted
- **Date:** 2026-08-09
- **Tracking:** epic [#79](https://github.com/igor-ka/llm-code-execution/issues/79) (Phase 0 work items [#83](https://github.com/igor-ka/llm-code-execution/issues/83)–[#88](https://github.com/igor-ka/llm-code-execution/issues/88))
- **Related:** spec [2026-08-09-deploy-to-gcp](../specs/2026-08-09-deploy-to-gcp.md); rate-limiting ADR [0003](0003-rate-limiting-approach.md); auth ADR [0001](0001-authentication-approach.md)

> **Reading the `D<n>` / `S<n>` codes.** This ADR records the decisions that are expensive to
> reverse: **D1** (Cloud Run), **D6** (sandbox execution), **D7** (per-execution caps) and **D8**
> (Redis). The remaining decisions and all success criteria live in
> [the spec](../specs/2026-08-09-deploy-to-gcp.md) — D2–D5, D9, D10 and S1–S12 are recorded there
> only.

## Context

The application runs on a developer laptop and nowhere else. Everything shipped so far — the auth
gate ([#9](https://github.com/igor-ka/llm-code-execution/issues/9)), per-user history
([#37](https://github.com/igor-ka/llm-code-execution/issues/37)), per-user quotas
([#62](https://github.com/igor-ka/llm-code-execution/issues/62)) — is built for multiple users and
reachable by none of them.

The binding constraint is not hosting in general; it is **the sandbox**. `DockerBackend` drives the
host's Docker daemon through a mounted `/var/run/docker.sock`, which is equivalent to root on the
host. No managed platform will host that, and no amount of configuration makes it safe.

Two further constraints shape everything below:

- **Terraform is an explicit learning goal. Kubernetes explicitly is not.**
- **Trial credits only, no out-of-pocket spend.** The environment is expected to be destroyed on
  day 91 and rebuilt on demand, not kept running at $0.

This is a security decision as much as an infrastructure one. Today's threat model rests on
*"nobody but the author can reach it."* Deployment removes that assumption, and every control that
was previously belt-and-braces becomes load-bearing on the day the URL becomes public.

## Decision

### D1 — Cloud Run, not GKE

Cloud Run scales to zero and **removes** the host-Docker-socket problem rather than hosting it.

*Rejected: GKE + gVisor.* It would have taught Kubernetes with Terraform as a thin wrapper around
cluster creation — the inverse of the learning goal — and cost roughly $75–110/month in nodes even
idle, about $250 of the 90-day credits before deploying anything.

*Rejected: a Compute Engine VM running Docker as today.* Zero sandbox rework, full fidelity, and it
keeps the socket — but the VM bills around the clock, host patching becomes ours, and scale-to-zero
is lost.

### D6 — Cloud Run sandboxes execute the untrusted code

[Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) reached public preview
in July 2026: a native sandbox **inside** the instance, enabled with `--sandbox-launcher` and
invoked as `/usr/local/gcp/bin/sandbox do -- <cmd>` from the backend process.

It is not merely adequate, it is a better fit than what this epic originally assumed. Measured
against what `DockerBackend` enforces today:

| Property | Docker today | Cloud Run sandboxes |
| --- | --- | --- |
| Network | `--network none` | **Denied by default** |
| Credentials | nothing passed in | no host env, no secrets, **no metadata server** |
| Filesystem | read-only + tmpfs (a write outside tmpfs **fails**) | read-only base; a write anywhere **succeeds** into a discarded memory overlay |
| Startup | sub-second | ~500 ms |
| Per-execution CPU/mem/PID caps | enforced | **undocumented** (D7) |

Two properties *improve*: egress is denied without configuring anything, and the sandbox cannot
reach the metadata server — a concern the local backend never had to think about because there was
no metadata server to reach.

**The filesystem row is not an equivalence, and the difference is observable.** Both designs
contain the write — nothing reaches the host, nothing persists past the execution. But under
`ReadonlyRootfs` a write outside the tmpfs *fails* with `EROFS`, while in a sandbox it *succeeds*
into an overlay that is then thrown away. The containment outcome is the same; the behaviour the
README documents is not. Spec **S3** requires the existing check *"writing outside the tmpfs is
blocked"* to pass against the deployed backend — that check must be **restated** for this backend
(*a write outside the tmpfs does not persist and is invisible to the host*), not merely re-run and
expected to go green.

*Rejected: Cloud Run Jobs per execution.* GA rather than preview, and it keeps per-execution
resource caps. But Cloud Run tasks have **default internet egress**, so matching today's
`--network none` requires Direct VPC egress plus a deny-all egress firewall rule — which must sit
below the implied allow-egress rule at priority 65535, GCP evaluating the LOWEST priority number
first — a pile of configuration whose only purpose is to get back to where we already are. It also costs
seconds of startup per execution instead of milliseconds.

**Accepted cost: a hard dependency on a Pre-GA feature.** No SLA, and the CLI surface can change.
Bounded by the [`SandboxBackend`](../../backend/src/sandbox/base.ts) seam — a withdrawal costs one
class, not a rewrite — and by `DockerBackend` remaining the local path regardless.

### D7 — The per-execution CPU, memory and PID caps do not survive

`DockerBackend` enforces 256 MB, 0.5 CPU and 64 PIDs per execution. Sandboxes share the host
instance's allocation, and Google **documents** no per-sandbox equivalents — the precise claim is
that none are documented, not that none exist; no probe was run. Either way this design does not
rely on them. **The lost enforcement is a real regression and it is accepted, not hidden.**

What partially carries the load instead: the concurrency cap from ADR-0003 bounds how many
sandboxes run at once, and the wall-clock timeout still kills a runaway. Neither is a substitute
for a per-execution ceiling, as the next paragraph sets out.

**Escape** risk does not grow — the sandbox boundary is what stops a payload reaching the host,
and that boundary is unchanged. **Availability blast radius does grow, and this ADR should not
pretend otherwise.** Under Docker a runaway allocation was capped at 256 MB and killed that one
execution. Without a per-sandbox ceiling, a single execution can exhaust the whole instance,
taking down every concurrent request on it and the instance itself — so "size the instance so N
concurrent sandboxes fit" is a capacity plan for well-behaved payloads, not a guarantee that N
hostile ones fit. The concurrency cap bounds *how many* run; the timeout bounds *how long*;
neither bounds *how much* any one of them consumes.

Spec criterion S4 requires this gap in the README's security posture *before* launch, because a
silent regression is worse than a stated one. If it proves unacceptable in practice, the honest
fixes are an instance-level memory ceiling or a return to Cloud Run Jobs — both of which mean a
superseding ADR, not an edit to this one.

*Rejected: falling back to Cloud Run Jobs to keep the caps.* That pays the egress workaround and
seconds of latency to preserve a property that matters less than the one it would cost.

### D8 — Upstash for the quota store, not Memorystore

ADR-0003 D6 means the backend will not boot without `REDIS_URL`, so this cannot be deferred.
Upstash's free tier (256 MB, 500k commands/month) costs nothing; Memorystore Basic is ~$36/month,
about **$110 of the $300** for a counter holding a handful of keys. The credits go to Cloud SQL and
Cloud Run instead.

*Rejected: Memorystore.* The better Terraform exercise — private IP, VPC peering — but a third of
the budget for the least interesting resource.

*Rejected: Redis co-located on the Cloud Run instance.* Free, and it dies with the instance, which
reintroduces exactly the restart-bypass ADR-0003 D1 rejected.

**Accepted cost: a third party holds the state of a security control**, outside the GCP blast
radius and outside `terraform destroy`. ADR-0003 D5's fail-open path now also covers *"the third
party is down or has rate-limited us"* — a likelier event than a Memorystore outage.

## Consequences

- **A Pre-GA feature is on the critical path.** D6 is the entry most likely to need superseding.
  Superseding means a new ADR, never an edit to this one.
- **The README's security posture must state what the sandbox no longer enforces** (D7) before the
  app is reachable. An honest gap beats a silent one.
- **The quota's failure modes widen** (D8): a third party's availability now feeds ADR-0003's
  fail-open path, and the Upstash provider needs its own credential in Terraform.
- **The isolation checks in the README are no longer inherited, and one of them changes meaning.**
  They were verified against `DockerBackend`; every one must be re-run against the deployed
  backend before this is called done (spec S3) — and the filesystem check must be **restated**
  first, because a write outside the tmpfs no longer fails, it succeeds into a discarded overlay.
  Re-running it unchanged would report a regression that is not one, or paper over the fact that
  the observable behaviour differs.
- **"Deployed" is a state with an end date.** The environment is deliberately destroyable and the
  credits expire; day 91 is a `terraform destroy`, not a renewal, unless the billing decision is
  revisited.
- The bug-issue rule in [`docs/sdlc.md`](../sdlc.md) — currently parked with *"this rule arrives
  with the Cloud Run work"* — activates when Phase 2 lands.
