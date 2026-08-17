# Phase 2: The Deploy Implementation Plan

**Goal:** Put the running application behind a public HTTPS URL on Cloud Run, executing untrusted
code in Cloud Run sandboxes, with the isolation properties of the local build re-proven against
the deployed service rather than inherited from it.

**Architecture:** A new `CloudRunSandboxBackend` implements the existing `SandboxBackend` port by
shelling out to the `sandbox` CLI that Cloud Run injects when a service is deployed with
`--sandbox-launcher`. Cloud SQL replaces the Compose Postgres and Memorystore for Valkey replaces
the Compose Redis; both arrive as secrets the runtime identity may read, wired at deploy time. The first
deploy is performed **by hand** (D4/S9) and only then captured in Terraform.

**Tech Stack:** Terraform (`infra/`), Cloud Run gen2 + sandboxes (preview), Cloud SQL for
PostgreSQL, Memorystore for Valkey behind a private VPC/PSC endpoint, the existing TypeScript
backend and its `SandboxBackend` seam.

**PR boundaries:** six PRs, one child issue each. Child issues are filed once this plan is
approved (`docs/sdlc.md`: children come after the plan), in this order:

| PR | Deliverable | Depends on |
| --- | --- | --- |
| 1 | `CloudRunSandboxBackend` + a Python interpreter in the production image | — |
| 2 | Cloud SQL instance, database, and its connection secret | Phase 1 #152–#155 merged |
| 3 | Memorystore for Valkey, its VPC/PSC, and the secret | Phase 1 #152–#155 merged |
| 4 | The Cloud Run service — deployed by hand first, then captured in Terraform | PRs 1–3 |
| 5 | The isolation re-verification battery (S3) and the honest README posture (S4) | PR 4 |
| 6 | Rollback exercise (S10), ADR-0004 supersession, epic close-out | PR 4 |

PR 1 is independent of everything and touches only application code. PRs 2 and 3 are independent
of each other but both wait on Phase 1's branches reaching `main` — see "What this plan inherits".

---

## Why Phase 2 is its own plan

Phase 1 built the place; this fills it. The split is the spec's D3 and it holds: Phase 1's work
was Terraform against an empty project, and this phase's hardest problems are application-level
(a new sandbox backend) and verification-level (proving isolation survived the move). Mixing them
would have put Terraform debugging and sandbox debugging in the same PR.

## What this plan inherits

**Applied to the project, but NOT yet on `main`.** Every resource below exists in
`llm-code-exec-260815` and in Terraform state, while the files that declare them
(`identity.tf`, `registry.tf`, `secrets.tf`, `wif.tf`, `budget.tf`, `outputs.tf`) sit on the
unmerged branches of #152–#155. **PRs 2, 3 and 4 of this plan cannot start until those merge** —
PR 2 modifies `infra/outputs.tf`, and PRs 2–3 populate secret containers, none of which exist on
`main` today. Check before starting, and adjust the file lists to whatever is true then.

- Registry `us-central1-docker.pkg.dev/llm-code-exec-260815/app`
- Runtime identity `app-runtime@llm-code-exec-260815.iam.gserviceaccount.com`, holding **nothing**
  at project level and per-secret accessor bindings only
- Six secret containers; only `anthropic-api-key` has a payload
- Keyless federation for `igor-ka/llm-code-execution` on `refs/heads/main`
- Two budgets, and a teardown runbook whose deadline is **2026-11-07**

## Decisions this plan makes

**P2-D1 — The sandbox is the `sandbox` CLI, spawned as a child process.** Cloud Run injects
`/usr/local/gcp/bin/sandbox` into the container when the service is deployed with
`--sandbox-launcher`. `CloudRunSandboxBackend` spawns `sandbox do --write -- python3 …` and reads
its stdout/stderr, exactly as `DockerBackend` spawns a container today. No network calls, no new
SDK: the seam already exists and this is one more implementation of it.

**P2-D2 — The production image gains a Python interpreter.** Non-obvious and load-bearing: a
sandbox gets a **read-only view of the host container's filesystem**, so the interpreter that runs
user code must be present in the *application* image. Today that image is `node:22-slim` with no
Python, so the first `sandbox do -- python3` would fail with `command not found` — a failure that
looks like a sandbox problem and is a packaging one. The separate `backend/sandbox-image/`
(`python:3.12-slim`) becomes local-only, used by `DockerBackend`.

**P2-D3 — Cloud SQL is reached over the built-in connector, with a public IP and no authorized
networks** (spec D11). `--add-cloudsql-instances` gives the Cloud Run service a Unix socket
brokered by the Cloud SQL Auth Proxy, authorised by IAM. No VPC, no peering, no Serverless VPC
connector.

The first draft of this plan said "no public IP" and set `ipv4_enabled = false`. Cloud SQL refuses
that outright — *"At least one of Public IP or Private IP connectivity must be enabled"* — and the
connector needs a public IP or a private IP plus Direct VPC egress. The IP therefore exists, and
`authorized_networks` is empty so nothing may use it directly: every connection goes through the
proxy, IAM-authorised and TLS-enforced.

**P2-D4 — Instance sizing: 2 vCPU / 2 GiB, `max-instances=2`, request concurrency 8** (spec D12).
Sandboxes share the instance's CPU and memory, so it must hold four concurrent executions plus the
app; `max-instances=2` bounds a runaway bill on a fixed budget.

**Concurrency is 8, not 4, and the difference is load-bearing.** Cloud Run caps in-flight requests
per instance. At 4 it would be impossible for a fifth request to reach
`ConcurrencyLimiter.tryAcquire()`, so the cap could never refuse and its 503 path would be dead
code — while D7 nominates that very cap as the replacement for the per-execution limits it
removes. A control that cannot fire is worse than no control, because it reads as present.

**P2-D5 — The first deploy is by hand, and Terraform captures it afterwards.** S9 and D4. A
`gcloud run deploy` whose flags are read one at a time is how the flags get understood; a
`google_cloud_run_v2_service` resource written first is how a wrong one gets applied twice.

---

## File Structure

**Created — backend**

| File | Responsibility |
| --- | --- |
| `backend/src/sandbox/cloudRunSandbox.ts` | `CloudRunSandboxBackend` — spawns the `sandbox` CLI, enforces the timeout, truncates output. |
| `backend/tests/sandbox/cloudRunSandbox.test.ts` | Contract tests against a fake `sandbox` executable on PATH. |

**Modified — backend**

| File | Change |
| --- | --- |
| `backend/src/config.ts` | Add `sandboxBackend` (`docker` \| `cloudrun`), defaulting to `docker`. |
| `backend/src/server.ts` | Select the backend from config at the existing `getSandbox()` seam. |
| `Dockerfile` | Install `python3` in the runtime stage; document why the interpreter lives here. |

**Created — infra**

| File | Responsibility |
| --- | --- |
| `infra/sql.tf` | Cloud SQL instance, database, user, and the `database-url` wiring. |
| `infra/run.tf` | The Cloud Run service, added in PR 4 **after** the by-hand deploy. |

**Created — docs**

| File | Responsibility |
| --- | --- |
| `docs/runbooks/gcp-deploy.md` | The by-hand deploy, the rollback, and the isolation battery. |

---

## PR 1 — the sandbox backend

### Task 1: The backend, test-first

**Files:**
- Create: `backend/src/sandbox/cloudRunSandbox.ts`, `backend/tests/sandbox/cloudRunSandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/sandbox/cloudRunSandbox.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudRunSandboxBackend } from "../../src/sandbox/cloudRunSandbox.js";

const limits = {
  timeoutSeconds: 2,
  memoryMb: 256,
  cpus: 0.5,
  pidsLimit: 64,
  maxOutputChars: 100,
};

// A fake `sandbox` binary. The real one is injected by Cloud Run and cannot exist locally, so the
// contract under test is "what this class does with the CLI", not the CLI itself.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-fake-"));
  const fake = join(dir, "sandbox");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
# Echo the arguments so the test can assert on them, then behave like the payload asked.
printf '%s\\n' "$*" > "${dir}/args.txt"
case "$*" in
  *EXIT_NONZERO*) echo "boom" >&2; exit 3 ;;
  *HANG*)         sleep 30 ;;
  *FLOOD*)        for i in $(seq 1 500); do printf 'x'; done ;;
  *)              echo "hello from the sandbox" ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CloudRunSandboxBackend", () => {
  it("runs code and returns stdout with exit code 0", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    const result = await backend.execute("print('hi')", "python", limits);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from the sandbox");
    expect(result.timedOut).toBe(false);
  });

  it("never passes --allow-egress: deny-by-default is the whole point", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    await backend.execute("print('hi')", "python", limits);

    const args = (await import("node:fs")).readFileSync(join(dir, "args.txt"), "utf8");
    expect(args).not.toContain("--allow-egress");
    expect(args).toContain("--write"); // the tmpfs overlay the code writes into
  });

  it("reports a non-zero exit without rejecting", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    const result = await backend.execute("EXIT_NONZERO", "python", limits);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("kills a run that outlives the timeout and says so", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    const result = await backend.execute("HANG", "python", limits);

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("returns within the timeout rather than waiting for the payload", async () => {
    // The regression this guards: killing only the CLI leaves the interpreter holding the stdio
    // pipes, `close` never fires, and execute() hangs for the payload's full runtime — so the
    // timeout bounds nothing and the concurrency slot is never released.
    const backend = new CloudRunSandboxBackend("sandbox");
    const started = Date.now();

    await backend.execute("HANG", "python", limits);

    expect(Date.now() - started).toBeLessThan(limits.timeoutSeconds * 1000 + 1000);
  });

  it("truncates output past maxOutputChars", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    const result = await backend.execute("FLOOD", "python", limits);

    expect(result.stdout.length).toBeLessThan(300);
    expect(result.stdout).toContain("truncated");
  });

  it("rejects an unsupported language without spawning anything", async () => {
    const backend = new CloudRunSandboxBackend("sandbox");
    const result = await backend.execute("puts 1", "ruby", limits);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unsupported language");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run tests/sandbox/cloudRunSandbox.test.ts`

Expected: FAIL — `Failed to resolve import "../../src/sandbox/cloudRunSandbox.js"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/sandbox/cloudRunSandbox.ts`:

```ts
/**
 * SandboxBackend backed by Cloud Run sandboxes.
 *
 * Cloud Run injects /usr/local/gcp/bin/sandbox into the container when the service is deployed
 * with --sandbox-launcher. `sandbox do` creates an ephemeral sandbox, runs one command in it, and
 * deletes it — the same shape as `docker run --rm`, which is why this slots into the existing
 * port with no change to callers.
 *
 * What this gets for free, and DockerBackend has to ask for: outbound network is denied by
 * default, the host filesystem is read-only, and the sandbox cannot read the service's
 * environment variables or reach the metadata server. That last one matters here — the runtime
 * identity's token lives on that metadata server.
 *
 * What it does NOT get, and the README must say so (spec D7/S4): per-execution memory, CPU and
 * PID caps. Sandboxes share the instance's allocation. The concurrency cap and the wall-clock
 * timeout below are what bound a runaway payload now.
 */
import { spawn } from "node:child_process";
import type { SandboxBackend, ExecutionLimits } from "./base.js";
import type { SandboxResult } from "../schemas.js";
import { log } from "../log.js";

const LANG_RUNNERS: Record<string, string[]> = {
  python: ["python3", "-I", "-B", "-c"],
};

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated, ${text.length - limit} more chars]`;
}

export class CloudRunSandboxBackend implements SandboxBackend {
  constructor(private readonly cli = "/usr/local/gcp/bin/sandbox") {}

  async execute(code: string, language: string, limits: ExecutionLimits): Promise<SandboxResult> {
    const runner = LANG_RUNNERS[language];
    if (!runner) {
      return {
        stdout: "",
        stderr: `Unsupported language: '${language}'`,
        exitCode: 2,
        durationMs: 0,
        timedOut: false,
      };
    }

    // --write gives the sandbox a tmpfs overlay to write into; the base filesystem stays
    // read-only. NO --allow-egress, ever: deny-by-default egress is the property that makes this
    // backend match `--network none`, and passing it once would silently undo the isolation the
    // README claims. The code is passed with `-c` rather than written to a file, so nothing has
    // to be cleaned up and no path is shared.
    const args = ["do", "--write", "--", ...runner, code];

    const started = process.hrtime.bigint();
    return await new Promise<SandboxResult>((resolve) => {
      // detached: its own process group. `sandbox do` runs the interpreter as a GRANDCHILD, so
      // killing only the CLI leaves python3 alive holding the stdio pipes — and `close` never
      // fires while a pipe is held. execute() would then not return until the payload finished on
      // its own: the wall-clock timeout would bound nothing and ConcurrencyLimitedBackend would
      // never release the slot. After D7 removes the per-execution caps, those two are the only
      // controls left, so this is load-bearing rather than tidy.
      const child = spawn(this.cli, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL to the whole GROUP, not just the CLI: the payload is untrusted and under no
        // obligation to handle a signal politely, and the interpreter is a grandchild.
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {
          child.kill("SIGKILL"); // the group is already gone
        }
      }, limits.timeoutSeconds * 1000);

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: truncate(stdout, limits.maxOutputChars),
          stderr: truncate(stderr, limits.maxOutputChars),
          exitCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          timedOut,
        });
      };

      child.on("error", (err) => {
        // The CLI is missing or not executable — an infrastructure fault, not a program failure.
        // Reported as a result rather than a rejection so the base contract holds, but logged at
        // error level because it means the service was deployed without --sandbox-launcher.
        log.error("sandbox CLI could not be spawned", { err, cli: this.cli });
        stderr += `\nsandbox CLI unavailable at ${this.cli}`;
        finish(126);
      });
      // `exit`, not `close`. exit fires when the process ends; close waits for every pipe to
      // drain, including one a killed grandchild may still hold. Give the streams a bounded
      // moment to flush afterwards — the same shape as dockerBackend.ts's
      // `Promise.race([streamEnded, delay(500)])`.
      child.on("exit", (code) => {
        const flush = setTimeout(() => finish(timedOut ? 124 : (code ?? 1)), 200);
        flush.unref?.();
      });
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/sandbox/cloudRunSandbox.test.ts`

Expected: PASS — all six.

- [ ] **Step 5: Select the backend from configuration**

In `backend/src/config.ts`, add to `Settings` after `sandboxMaxConcurrent`:

```ts
  sandboxBackend: "docker" | "cloudrun"; // "cloudrun" requires --sandbox-launcher on the service
```

and in `loadSettings`, after `sandboxMaxConcurrent`:

```ts
    // Defaults to docker so every local run and every existing test is unchanged. The deployed
    // service sets SANDBOX_BACKEND=cloudrun explicitly — a default of "cloudrun" would make a
    // misconfigured local run fail with a missing CLI instead of an obvious message.
    sandboxBackend: str(env.SANDBOX_BACKEND, "docker") === "cloudrun" ? "cloudrun" : "docker",
```

In `backend/src/server.ts`, add the import:

```ts
import { CloudRunSandboxBackend } from "./sandbox/cloudRunSandbox.js";
```

and replace the body of `getSandbox()`'s construction with:

```ts
      const inner =
        settings.sandboxBackend === "cloudrun"
          ? new CloudRunSandboxBackend()
          : new DockerBackend(settings.sandboxImage);
      sandbox = new ConcurrencyLimitedBackend(
        inner,
        new ConcurrencyLimiter(settings.sandboxMaxConcurrent),
        settings.sandboxTimeoutSeconds,
      );
```

- [ ] **Step 6: Cover the selection**

Append to `backend/tests/config.test.ts`:

```ts
describe("sandboxBackend", () => {
  it("defaults to docker, so local runs and tests are unchanged", () => {
    expect(loadSettings({}).sandboxBackend).toBe("docker");
  });

  it("is cloudrun when SANDBOX_BACKEND=cloudrun", () => {
    expect(loadSettings({ SANDBOX_BACKEND: "cloudrun" }).sandboxBackend).toBe("cloudrun");
  });

  it("falls back to docker for an unrecognized value", () => {
    expect(loadSettings({ SANDBOX_BACKEND: "firecracker" }).sandboxBackend).toBe("docker");
  });
});
```

- [ ] **Step 7: Put a Python interpreter in the production image**

In the runtime stage of the repo-root `Dockerfile`, immediately after `WORKDIR /app`:

```dockerfile
# python3 lives in the APPLICATION image, which is not obvious and is load-bearing.
#
# A Cloud Run sandbox gets a read-only view of THIS container's filesystem — it is not a separate
# image. So the interpreter that runs user code has to be here, or `sandbox do -- python3` fails
# with "command not found", a packaging fault that reads like a sandbox fault.
#
# backend/sandbox-image/ (python:3.12-slim) is now local-only: DockerBackend runs it as a separate
# container, which is exactly the model Cloud Run does not have.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 8: Prove the interpreter shipped**

Add to `backend/verify.sh`'s production-image assertions, inside the existing `docker run` block:

```bash
    # The sandbox runs user code against THIS image's filesystem, so the interpreter must be here.
    command -v python3 >/dev/null || { echo "python3 missing from the production image" >&2; exit 1; }
```

- [ ] **Step 8a: Update `docs/sdlc.md` — required, not optional**

`backend/verify.sh` is in `scripts/check-sdlc-sync.sh`'s watched set, so the `SDLC docs` check
fails without this. Add one sentence wherever that document describes what the production-image
assertions cover: the image must carry a `python3` interpreter, because a Cloud Run sandbox
executes against the application image's own filesystem. `[skip-sdlc-sync]` would not be honest —
this is a genuine new check.

- [ ] **Step 9: Full verification**

```bash
cd backend && ./verify.sh
```

Expected: all suites green, three images built, and the new `python3` assertion passing inside the
production image.

- [ ] **Step 10: Commit**

```bash
cd .. && git add backend/src/sandbox/cloudRunSandbox.ts backend/tests/sandbox/cloudRunSandbox.test.ts \
    backend/src/config.ts backend/tests/config.test.ts backend/src/server.ts \
    backend/verify.sh Dockerfile docs/sdlc.md
git commit -m "feat(sandbox): Cloud Run sandbox backend behind the existing seam"
```

---

## PR 2 — Cloud SQL

### Task 2: The instance, database and user

**Files:**
- Create: `infra/sql.tf`
- Modify: `infra/apis.tf` (add `sqladmin.googleapis.com`), `infra/outputs.tf`

- [ ] **Step 1: Enable the API**

In `infra/apis.tf`, add one entry to `local.phase1_apis`:

```hcl
    "sqladmin.googleapis.com",
    "run.googleapis.com",
```

`run.googleapis.com` is here rather than in PR 4 because PR 4 both deploys and `terraform import`s
a Cloud Run service, and an API enabled in the same plan that first uses it is a dependency-order
problem waiting to happen. `servicenetworking` is deliberately absent — P2-D3 takes no VPC.

**Do not rename `local.phase1_apis` or the `google_project_service.phase1` resource**, tempting as
it is now that the list spans two phases. The local is cosmetic, but the resource address is not:
renaming it needs `terraform state mv` for all eight instances, and a rename that half-lands
leaves Terraform planning to destroy and recreate API enablements. The name is a historical label;
the churn is real.

- [ ] **Step 2: Write the instance**

Create `infra/sql.tf`:

```hcl
# The smallest thing that runs Postgres. db-f1-micro is shared-core: no SLA, and that is the right
# trade for disposable learning data on a fixed budget (~$8-10/mo of the trial credits).
resource "google_sql_database_instance" "main" {
  name             = "app-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier = "db-f1-micro"

    ip_configuration {
      # A public IP with NOTHING authorised to use it. Cloud SQL requires public or private
      # connectivity — `ipv4_enabled = false` alone is rejected with "At least one of Public IP or
      # Private IP connectivity must be enabled" — and the built-in connector needs one of the
      # two. So the address exists and no network may reach it: every connection is brokered by
      # the Auth Proxy, authorised by IAM, over TLS. Spec D11.
      ipv4_enabled    = true
      ssl_mode        = "ENCRYPTED_ONLY"
      authorized_networks = []
    }

    backup_configuration {
      # Off, deliberately. The spec's Boundaries put backups out of scope: this database holds
      # disposable learning data and the day-91 teardown destroys it regardless. Enabling them
      # would cost storage for a recovery nobody will perform.
      enabled = false
    }
  }

  # The day-91 teardown must not need an edit-and-retry under time pressure (S7). This mirrors the
  # prevent_destroy gate's reasoning, for a field that gate does not match.
  deletion_protection = false

  depends_on = [google_project_service.phase1]
}

resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
}

# A password the human never sees and never types. Terraform holds it in state, which is exactly
# the tradeoff S6 draws the line at: state lives in a private, versioned, non-public bucket, and
# the alternative — a human-chosen password pasted into a runbook — is worse in every dimension.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
```

- [ ] **Step 3: Declare the random provider**

In `infra/versions.tf`, add to `required_providers`:

```hcl
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
```

- [ ] **Step 3a: Regenerate the provider lock for both platforms**

```bash
cd infra
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
```

Adding a provider without this leaves `.terraform.lock.hcl` carrying hashes for one platform, and
`Terraform checks` fails on Linux with a checksum error that names no cause. The Phase 1 plan
documents the same trap.

- [ ] **Step 4: Verify and apply**

```bash
cd infra && ./verify.sh && terraform apply
```

Expected: the instance takes 5–10 minutes. `terraform apply` reports **6 added** — the four SQL
resources plus the two new `google_project_service.phase1` entries.

- [ ] **Step 5: Populate `database-url` from the values Terraform holds**

```bash
INSTANCE="$(terraform output -raw sql_connection_name)"
PASSWORD="$(terraform output -raw db_password)"
printf 'postgresql://app:%s@localhost/app?host=/cloudsql/%s' "$PASSWORD" "$INSTANCE" \
  | gcloud secrets versions add database-url --data-file=-
```

The `host=/cloudsql/<connection-name>` form is the Unix socket the Cloud SQL connector mounts into
the Cloud Run container. Add the two outputs it reads to `infra/outputs.tf`:

```hcl
output "sql_connection_name" {
  description = "project:region:instance — what --add-cloudsql-instances takes."
  value       = google_sql_database_instance.main.connection_name
}

output "db_password" {
  description = "Generated application database password. Read once to populate the secret."
  value       = random_password.db.result
  sensitive   = true
}
```

- [ ] **Step 6: Commit**

```bash
git add infra/sql.tf infra/apis.tf infra/outputs.tf infra/versions.tf infra/.terraform.lock.hcl
git commit -m "feat(infra): cloud sql instance reached over the built-in connector"
```

---

## PR 3 — Memorystore for Valkey

### Task 3: The quota store, and the VPC it needs

**Superseded 2026-08-16 by spec D17.** This task said Upstash. It now says Memorystore for
Valkey: everything inside GCP, paid for deliberately, on a teardown-when-idle model
(~CAD 33/month left running, ~CAD 3 destroyed between sessions).

**Files:**
- Create: `infra/valkey.tf`
- Modify: `infra/apis.tf`, `docs/runbooks/gcp-teardown.md`, `README.md`

- [ ] **Step 1: The VPC, because Valkey cannot be reached without one**

Valkey is reachable only over Private Service Connect, which needs a network to attach to — the
complexity P2-D3 avoided for Cloud SQL via the built-in connector, and for which Memorystore has
no equivalent. `infra/valkey.tf` therefore carries a `google_compute_network`, a
`google_compute_subnetwork` and a `google_network_connectivity_service_connection_policy` before
the instance itself.

Enable `compute`, `memorystore` and `networkconnectivity` in `infra/apis.tf`.

- [ ] **Step 2: The instance**

`SHARED_CORE_NANO`, one shard, **zero replicas** — a replica doubles the bill to protect a counter
whose loss costs one window of unmetered requests, which ADR-0003's fail-open posture already
accepts. `deletion_protection_enabled = false`, because every session-end teardown must not need
an edit-and-retry.

- [ ] **Step 3: The endpoint output, selected by name**

The instance exposes **two** connections: the discovery one and a second with no
`connection_type` and port 0. Select on `connection_type == "CONNECTION_TYPE_DISCOVERY"` — taking
`[0]` is a coin flip that happens to work today. Flatten to `host:port`, because
`terraform output -raw` on the raw attribute fails with "complex type".

- [ ] **Step 4: Populate the secret**

```bash
printf 'redis://%s' "$(terraform output -raw valkey_endpoint)" \
  | gcloud secrets versions add redis-url --data-file=-
```

`redis://`, not `rediss://` — this is a private PSC endpoint inside the project VPC, not an
internet-facing service, and Memorystore does not present a TLS listener on it by default.

**The endpoint is newly allocated on every rebuild**, so this command belongs in the teardown
runbook's rebuild section, not only here.

## PR 4 — the service

### Task 4: Deploy by hand

**Files:**
- Create: `docs/runbooks/gcp-deploy.md`

- [ ] **Step 1: Build and push the image**

```bash
REGISTRY="us-central1-docker.pkg.dev/llm-code-exec-260815/app"
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
docker build --platform linux/amd64 \
  --build-arg VITE_AUTH0_DOMAIN=<tenant>.auth0.com \
  --build-arg VITE_AUTH0_CLIENT_ID=<client-id> \
  --build-arg VITE_AUTH0_AUDIENCE=<api-identifier> \
  -t "$REGISTRY/app:v1" .
docker push "$REGISTRY/app:v1"
```

`--platform linux/amd64` is not optional on an Apple Silicon machine: the default build is arm64
and Cloud Run refuses it with a manifest error that does not mention architecture.

- [ ] **Step 2: Deploy, reading each flag**

```bash
gcloud beta run deploy app \
  --image "$REGISTRY/app:v1" \
  --region us-central1 \
  --execution-environment gen2 \
  --sandbox-launcher \
  --service-account app-runtime@llm-code-exec-260815.iam.gserviceaccount.com \
  --add-cloudsql-instances "$(cd infra && terraform output -raw sql_connection_name)" \
  --set-env-vars SANDBOX_BACKEND=cloudrun,LOG_FORMAT=json,AUTH_REQUIRED=true,SANDBOX_MAX_CONCURRENT=4 \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,OIDC_ISSUER=oidc-issuer:latest,OIDC_AUDIENCE=oidc-audience:latest,OIDC_JWKS_URL=oidc-jwks-url:latest \
  --cpu 2 --memory 2Gi --concurrency 8 --max-instances 2 \
  --network app-net --subnet app-subnet --vpc-egress private-ranges-only \
  --allow-unauthenticated
```

`--network`/`--subnet` are **not optional** (spec D17): Valkey lives at a private PSC address
inside `app-net`, so without Direct VPC egress the service starts, passes its health check, and
then fails every quota lookup — `assertRedisConfigured` only checks the variable is non-empty and
`RedisQuotaStore` connects lazily, so the failure surfaces as the quota silently failing open
rather than as a boot error. `private-ranges-only` keeps public egress (the Anthropic API, Auth0
JWKS) on the default path rather than routing it through the VPC.

`--allow-unauthenticated` is correct and is not a hole: the application's own OIDC gate is what
authenticates users (`AUTH_REQUIRED=true`). Cloud Run IAM would authenticate *Google* identities,
which the SPA's users do not have.

- [ ] **Step 3: Record the URL**

```bash
gcloud run services describe app --region us-central1 --format='value(status.url)'
```

Expected shape: `https://app-530312723651.us-central1.run.app`. **This is the URL the epic has
been working toward.** Put it in `docs/runbooks/gcp-deploy.md` and in the README.

- [ ] **Step 4: Add the Auth0 callback**

In the Auth0 application settings, add that URL to Allowed Callback URLs, Allowed Logout URLs and
Allowed Web Origins. Auth0 matches these exactly; without it the login redirect fails with a
callback-mismatch error that says nothing about which list is missing the value.

- [ ] **Step 5: Smoke-test the happy path**

Open the URL, log in, and send *"compute the first 20 Fibonacci numbers"*. Expect generated Python
and correct output — **that is S1.**

- [ ] **Step 6: Capture it in Terraform**

Create `infra/run.tf` describing the service exactly as deployed. Two fields must be written
explicitly, because a default gets them wrong in a way nothing else catches:

```hcl
    # Without this the applied revision has NO sandbox launcher: /usr/local/gcp/bin/sandbox
    # disappears from the serving revision and every execution takes the backend's exit-126 path.
    # An apply would silently undo the by-hand deploy. Available since provider 7.43.0; the
    # repo's `~> 7.42` constraint resolves 7.44.0, so no version bump is needed.
    sandbox_launcher = true
```

```hcl
  # Explicit, for the same S7 reason sql.tf gives: the day-91 teardown must not need an
  # edit-and-retry under time pressure. infra/verify.sh's gate greps for `prevent_destroy` and
  # does not match this field, so the gate will not catch a wrong default.
  deletion_protection = false
```

Then:

```bash
cd infra
terraform import google_cloud_run_v2_service.app \
  projects/llm-code-exec-260815/locations/us-central1/services/app
terraform plan
```

Expected: **no behavioural changes** (spec D15). A hand-written resource imported from
`gcloud run deploy` will show residual diffs on `launch_stage`, gcloud-set annotations, `traffic`,
probes and the Cloud SQL volume. Chasing an empty plan invites either churn or a quiet skip;
instead, list the residual diff in `docs/runbooks/gcp-deploy.md` and confirm each entry is
cosmetic. Anything that would change behaviour is fixed in the file, never on the service — the
running service is the thing that was verified.

- [ ] **Step 7: Commit**

```bash
git add infra/run.tf docs/runbooks/gcp-deploy.md
git commit -m "feat(deploy): the cloud run service, by hand then captured"
```

---

## PR 5 — prove the isolation survived

### Task 5: Re-run the battery against the deployed sandbox

This is S3, and it is the task most likely to be skipped because everything already "works".

**Files:**
- Modify: `docs/runbooks/gcp-deploy.md`, `README.md`

- [ ] **Step 1: Network egress must be denied**

Prompt: *"fetch https://example.com and print the status code"*. Expected: the generated Python
fails with a DNS or connection error. **A 200 means `--allow-egress` leaked in and the deploy is
not safe to keep.**

- [ ] **Step 2: The filesystem — expectations corrected for sudo**

Prompt: *"write a file to /etc/passwd and read back /etc/shadow"*.

**Expect these to SUCCEED**, and that is not a failure of the deploy. Sandboxed processes run with
`sudo` privileges (spec D13) and `--write` gives them an overlay, so the write lands in an
ephemeral in-memory layer and the read returns the *application image's* file. Neither outlives
the execution, and neither is a host secret.

What must still hold, and is the real assertion: **the change is invisible to the next execution.**
Run the write, then a second prompt reading the same path, and confirm the second sees the
original content. A persisted change would mean the overlay is shared and the isolation is not
per-execution.

Also record what the payload *can* now read (spec D16): `/app/dist`, `/app/node_modules`,
`/app/migrations` and the built SPA are all visible, because the sandbox sees the application
image. Locally it saw only `python:3.12-slim`.

- [ ] **Step 3: The metadata server must be unreachable**

Prompt: *"fetch http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token with header Metadata-Flavor: Google"*. Expected: failure.

This one has no local equivalent — `DockerBackend` never had a metadata server to protect. It is
the check that proves a compromised payload cannot steal the runtime identity's token.

- [ ] **Step 4: A runaway must be killed**

Prompt: *"loop forever"*. Expected: `timed_out: true` at `SANDBOX_TIMEOUT_SECONDS`.

- [ ] **Step 5: A fork bomb must not take the instance down**

Prompt: *"fork bomb"*. Expected: the service survives and continues serving. **Record what actually
happens** — with no PID cap (D7), the honest outcome may be a degraded or restarted instance, and
that is the finding S4 exists to publish.

- [ ] **Step 5a: Exercise the batteries that S5 names**

S5 asks for the auth gate, the history isolation battery and the quota refusals **against the
deployed environment**, and nothing else in this plan does it:

1. **Auth gate** — `curl -s -o /dev/null -w '%{http_code}' <URL>/api/execute -X POST -H 'content-type: application/json' -d '{"prompt":"hi"}'` → expect **401**, not 200.
2. **History isolation (INV-1…8)** — log in as one user, create a session, then request that
   session id while authenticated as a second user → expect **404**, never 403 and never the row.
3. **Quota** — send requests past `RATE_LIMIT_BURST` within the burst window → expect **429** with
   a `Retry-After` header.

Record the observed status codes in the runbook. A criterion asserted from local tests is a
criterion not met.

- [ ] **Step 6: Write the truth into the README**

Update the security posture section with what the deployed sandbox does and does not enforce.
Per-execution memory, CPU and PID caps do **not** survive the move to Cloud Run sandboxes; the
concurrency cap and the wall-clock timeout are what bound a payload now. State it plainly — S4
asks for an honest gap, not a reassuring one.

- [ ] **Step 7: Commit**

```bash
git add docs/runbooks/gcp-deploy.md README.md
git commit -m "docs(security): re-verify sandbox isolation against the deployed service"
```

---

## PR 6 — rollback, ADR, close-out

### Task 6: Prove a bad revision can be undone

**Files:**
- Modify: `docs/runbooks/gcp-deploy.md`, `docs/adr/0004-hosting-and-sandbox-execution.md`,
  `README.md`

- [ ] **Step 1: Deploy a deliberately broken revision**

```bash
gcloud beta run deploy app --image "$REGISTRY/app:does-not-exist" --region us-central1 \
  --execution-environment gen2 --sandbox-launcher
```

Break the **image tag**, not `REDIS_URL` (spec D14). An unreachable Redis is not broken: the boot
guard only checks the variable is non-empty and `RedisQuotaStore` connects lazily, so that
revision starts healthy and merely fails the quota **open** — S10 would be "proven" by rolling
back a revision that was serving fine with a security control silently off.

The constraint to work within: a revision that fails to *start* never receives traffic, so there
is nothing to roll back from. A bad image tag fails at deploy time and leaves the previous
revision serving — which is what makes the next step a rollback of *traffic* rather than of a
broken deploy. If the deploy is rejected outright, record that as the finding: Cloud Run refused
to route to it, which is itself the protection S10 asks about.

- [ ] **Step 2: Roll back and time it**

```bash
gcloud run services update-traffic app --region us-central1 --to-revisions=<previous>=100
```

Expected: healthy within seconds. **That is S10.** Record the command and the elapsed time in the
runbook.

- [ ] **Step 3: Supersede the ADR where reality differed**

ADR-0004 is immutable; if Phase 2 contradicted any of D6–D10 — the caps, the region, the
connector choice — write **ADR-0005** superseding it rather than editing. If nothing contradicted
it, add nothing.

- [ ] **Step 4: Close the epic**

Update #79 with the URL, the applied-vs-planned differences, and which success criteria are met.
S1–S5, S10 close here; S6–S9 and S11 closed in Phase 1; **S7's "zero billable resources" half
stays open until the day-91 teardown runs.**

- [ ] **Step 5: Commit**

```bash
git add docs/ README.md
git commit -m "docs: rollback proof, ADR supersession, epic close-out"
```

---

## Definition of done for Phase 2

| Spec criterion | How this plan satisfies it |
| --- | --- |
| S1 | PR 4 Step 5 — a real prompt, a real execution, from the public URL. |
| S2 | Structural: the image has no Docker socket and Cloud Run cannot mount one. |
| S3 | PR 5 Steps 1–5, run against the deployed sandbox, not inherited. |
| S4 | PR 5 Step 6 — the caps that did not survive are written into the README. |
| S5 | The auth gate is on (`AUTH_REQUIRED=true`); history and quota exercised via the live URL. |
| S10 | PR 6 Steps 1–2 — a broken revision, then a timed rollback. |
| S12 | Budgets from Phase 1 watch the spend; the README stops claiming the app is unreachable. |

**Not claimed:** S6–S9 and S11 closed in Phase 1. S7's teardown half closes on day 91.

## Explicitly out of scope

- **CD.** Phase 3, and deliberately after a by-hand deploy (S9).
- **A custom domain.** The generated `run.app` URL is the deliverable.
- **Multi-region, autoscaling beyond `max-instances=2`, CDN.** One user reaching the app is the bar.
- **Narrowing `run.admin`.** Phase 1 granted it project-scoped because no service existed; now one
  does, but retargeting CI's permissions belongs with the CD work that uses them.

---

## Plan review log

Staff-engineer review 2026-08-16 — **applied without asking** (mechanical; each verified against
the codebase before transcribing):

- **Task 1 Step 3**: the timeout did not bound the call. `SIGKILL` to the `sandbox` CLI leaves the
  interpreter grandchild holding the stdio pipes, so `close` never fires — reproduced at +12s for
  a 2s timeout. Now spawns `detached`, kills the process **group**, resolves on `exit` with a
  bounded flush and a `settled` guard. A test pins that `execute()` returns within timeout + 1s.
- **Task 1 Step 8a (new)**: `backend/verify.sh` is a watched path, so PR 1 must update
  `docs/sdlc.md` or the `SDLC docs` check fails. Added the step and the file to Step 10's `git add`.
- **Task 2 Step 1**: added `run.googleapis.com` alongside `sqladmin` — PR 4 deploys and imports a
  Cloud Run service. Also stated that the `google_project_service.phase1` resource must **not** be
  renamed (it needs `terraform state mv` for eight instances).
- **Task 2 Step 3a (new)**: `terraform providers lock -platform=darwin_arm64 -platform=linux_amd64`
  after adding `hashicorp/random`, and `.terraform.lock.hcl` added to the commit.
- **Task 2 Step 4**: expected count corrected from 4 to **6** (four SQL resources plus two API
  enablements).
- **Header / "What this plan inherits"**: Phase 1's `identity.tf`, `registry.tf`, `secrets.tf`,
  `wif.tf`, `budget.tf` and `outputs.tf` are applied to the project but exist only on the unmerged
  branches of #152–#155. PRs 2–4 now declare that dependency.
- **PR 4 Step 6**: `run.tf` must set `sandbox_launcher = true` (a default apply would strip the
  launcher from the serving revision) and `deletion_protection = false` (the `prevent_destroy`
  gate does not match this field).
- **Definition of done, S5**: added PR 5 Step 5a — auth gate 401, cross-owner 404, quota 429,
  each against the deployed URL. The DoD claimed S5 without a step that met it.

**Escalated to the user, awaiting decision** — six judgment findings, listed in the conversation:
the Cloud SQL `ipv4_enabled = false` contradiction (P2-D3), `--concurrency 4` making the
concurrency cap unreachable (P2-D4), sudo-in-sandbox versus the local `CapDrop: ALL` posture,
the "broken revision" in PR 6 that is not actually broken, the strict no-changes bar on the
Terraform import, and whether S4 records that the sandbox can now read the application image.

**Judgment findings decided 2026-08-16** — all six escalated items were resolved as recommended
and are recorded as **D11–D16** in [the spec](../specs/2026-08-09-deploy-to-gcp.md), which is
where decisions live. Applied here:

- **P2-D3** rewritten: public IP with `authorized_networks = []` and `ssl_mode = ENCRYPTED_ONLY`.
  `ipv4_enabled = false` alone is rejected by Cloud SQL.
- **P2-D4** rewritten: request concurrency **8**, not 4 — at 4 the sandbox concurrency cap could
  never fire, making D7's nominated replacement control dead code.
- **PR 5 Step 2** rewritten: the `/etc/passwd` write and `/etc/shadow` read are expected to
  **succeed** under sudo; the real assertion is that the change is invisible to the next
  execution. Adds the D16 note about `/app` being readable.
- **PR 6 Step 1** rewritten: break the image tag, not `REDIS_URL` — an unreachable Redis boots
  healthy and fails the quota open.
- **PR 4 Step 6** relaxed to "no behavioural changes", with the residual diff listed in the
  runbook.

---

## Outcome log — 2026-08-17

Phase 2 shipped. What the plan did not anticipate, recorded here because the plan is the artefact
someone will read next time:

**Four defects reached the deployed service, and every one was invisible to a fully green
`verify.sh`.** That is the real finding of this phase, and it is a fact about the *gates*, not
about carelessness:

| Issue | Defect | Why nothing local could catch it |
| --- | --- | --- |
| [#185](https://github.com/igor-ka/llm-code-execution/issues/185) | Sandbox `PATH` is empty; a bare `python3` resolved against nothing, so **no code ran at all** | Every local shell has a `PATH`; the image assertion proved packaging, not lookup |
| [#188](https://github.com/igor-ka/llm-code-execution/issues/188) | Service advertised `Access-Control-Allow-Origin: http://localhost:5173` | Cloud Run serves the SPA and API from one origin, and same-origin requests never consult CORS |
| [#191](https://github.com/igor-ka/llm-code-execution/issues/191) | Quota rejected on every call (`CROSSSLOT`); **rate limiting never functioned**, silently, because D5 fails open | Local Redis is a single node with no slots; Memorystore for Valkey is a cluster at any size |
| — | `update-traffic` moves traffic and *then* exits non-zero after a failed deploy | Only a rollback rehearsal on a real service shows this |

The pattern is one thing: **a check that cannot fail the way production fails is not a gate.** Each
fix therefore changed the gate as well as the code — an absolute-path assertion, a boot-time origin
guard, a slot-arithmetic test, and a runbook that says to read the logs rather than trust a `200`.

**Plan-vs-applied differences:**

- **PR 4 did not put the service in Terraform**, and should not. The provider does not model
  `sandboxLauncher` and strips it on every apply, which would silently remove code execution from a
  healthy-looking service on an unrelated database change. Recorded as
  [ADR-0005](../adr/0005-cloud-run-service-outside-terraform.md), with the reversal condition and
  the teardown obligation that follows.
- **A dedicated Cloud Build identity was added** (`infra/build.tf`). The plan had the build running
  as the Compute Engine default account, which holds project **Editor** — and build steps come from
  `cloudbuild.yaml`, a file in this repository.
- **PR 5 grew two probes.** A hostname connect failure only proves there is no DNS, so a raw-IP
  connect was added; and the fork-bomb probe gained an orphan-survival check, which is what turned
  D7's "the timeout is the mitigation" from an assertion into a measurement.
- **`_TAG` became a required Cloud Build substitution** rather than a literal edited per rebuild.

**Success criteria:** S1–S6 and S8–S12 met. **S7 is half-met by design** — the reproduce half was
rehearsed (teardown runbook appendix); zero-billable-resources closes at the day-91 teardown.

**No decision in D6–D16 was contradicted.** The probes *confirmed* the uncomfortable ones: D7 (200
of 200 forks succeeded — no PID cap), D13 (`os.getuid() == 0`), D16 (`/app` readable). ADR-0004
stands unamended; ADR-0005 adds a decision rather than superseding one.
