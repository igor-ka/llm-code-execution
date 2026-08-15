# Per-worktree application stacks Implementation Plan

**Goal:** Let two or more git worktrees each run their own backend, frontend, Postgres and Redis
at the same time, so parallel feature work is not serialized on "who owns the stack".

**Architecture:** One integer, `STACK_SLOT`, derives every host-facing port (`base + slot * 10`).
Slot 0 is today's ports exactly, so the existing single-tree workflow and CI are unchanged.
Compose already isolates containers, networks and the `pgdata` volume by project name — the only
real collision is the four published host ports, which become `${VAR:-default}` substitutions. The
repo-root env file splits in two: `.env.shared` (identical across worktrees — API key, OIDC,
limits; a symlink inside a worktree) and `.env` (this worktree's slot, ports,
`COMPOSE_PROJECT_NAME`, and a per-slot `SANDBOX_IMAGE` tag). A `scripts/worktree-new.sh` then
turns "I want to work on X" into a worktree that can actually run.

**Tech Stack:** Docker Compose (v2 spec, `env_file` with `required: false`), Vite 8, dotenv 16.4
(array `path`), bash + the existing `scripts/tests/*.test.sh` harness.

**PR boundaries:**

- **PR 1: slot-parameterized local stack — closes #137.** `docker-compose.yml` host ports, the
  `.env` / `.env.shared` split, `vite.config.ts` dev port, README. Touches no SDLC-watched path.
- **PR 2: `scripts/worktree-new.sh` — closes #138.** The bootstrap script, its test, and
  `docs/sdlc.md`. Depends on PR 1 for the env-file contract it generates. Adds no CI job: the
  script is local developer tooling, its test runs locally, and CI never creates a worktree.

Both are independently deliverable: after PR 1 a second stack runs by hand-writing a `.env`;
PR 2 removes the hand-writing. Epic: #136.

---

## File Structure

**PR 1**

| File | Action | Responsibility |
| --- | --- | --- |
| `frontend/src/devPort.ts` | create | Resolve the Vite dev-server port from the environment. One definition, mirroring `apiBase.ts`. |
| `frontend/src/devPort.test.ts` | create | Unit tests for the above. |
| `frontend/vite.config.ts` | modify (`:43-46`) | Use the resolver; add `strictPort` so a collision fails loudly. |
| `frontend/.env.example` | modify | Document `VITE_DEV_PORT`. |
| `docker-compose.yml` | modify | Parameterize the four published host ports; read the split env files. |
| `.env.example` | modify | Becomes the slot-0 stack file; points at `.env.shared.example`. |
| `.env.shared.example` | create | The across-worktree half: API key, model, OIDC, limits. |
| `.gitignore` | modify | Ignore `.env.shared`. |
| `backend/src/config.ts` | modify (`:11-14`) | Load both root env files for a host-run backend. |
| `README.md` | modify | Setup split, the Auth0 origin pool, a "Parallel worktrees" section. |

**PR 2**

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/worktree-new.sh` | create | Create a worktree, allocate a slot, link/generate env, install deps. |
| `scripts/tests/worktree-new.test.sh` | create | Unit tests for the pure helpers (slot allocation, env block). Run locally, not in CI. |
| `docs/sdlc.md` | modify | Document that `scripts/` now also holds developer tooling, and the slot contract. |
| `README.md` | modify | Point the worktree section at the script. |

**The slot table** (`base + slot * 10`), fixed by this plan and referenced by every task:

| Slot | Backend | Frontend | Postgres | Redis |
| --- | --- | --- | --- | --- |
| 0 (main tree) | 8000 | 5173 | 5432 | 6379 |
| 1 | 8010 | 5183 | 5442 | 6389 |
| 2 | 8020 | 5193 | 5452 | 6399 |
| 3 | 8030 | 5203 | 5462 | 6409 |

---

## Task 1: The dev-port resolver

**Files:**
- Create: `frontend/src/devPort.ts`
- Test: `frontend/src/devPort.test.ts`

- [ ] **Step 0: Branch for PR 1**

```bash
git checkout main && git pull && git checkout -b feat/slot-parameterized-stack
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/devPort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveDevPort, DEFAULT_DEV_PORT } from "./devPort";

describe("resolveDevPort", () => {
  it("defaults to 5173 when unset", () => {
    expect(resolveDevPort(undefined)).toBe(DEFAULT_DEV_PORT);
  });

  it("defaults when the value is blank", () => {
    expect(resolveDevPort("")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("   ")).toBe(DEFAULT_DEV_PORT);
  });

  it("uses a valid port", () => {
    expect(resolveDevPort("5183")).toBe(5183);
  });

  // A bad value must not become a *different usable port* silently: with strictPort on,
  // falling back to 5173 either binds the slot-0 origin Auth0 already knows, or fails the
  // bind outright. Both are visible; a silent 5174 is not.
  it("falls back on values that are not usable TCP ports", () => {
    expect(resolveDevPort("nope")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("5183.5")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("0")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("-1")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("65536")).toBe(DEFAULT_DEV_PORT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/devPort.test.ts
```

Expected: FAIL — `Failed to resolve import "./devPort"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/devPort.ts`:

```ts
/**
 * Which port the Vite dev server binds — defined ONCE, for the same reason as `apiBase.ts`.
 *
 * Parallel worktrees each run their own stack on slot-derived ports (see the "Parallel
 * worktrees" section of README.md). The frontend port is the one that is NOT free to drift:
 * Auth0's allowed callback / logout / web origins are an exact-match allowlist, so an
 * unexpected origin fails login rather than warning. `vite.config.ts` pairs this with
 * `strictPort: true` so a taken port is an error, not a silent hop to 5174.
 */
export const DEFAULT_DEV_PORT = 5173;

export function resolveDevPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEV_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_DEV_PORT;
  return port;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd frontend && npx vitest run src/devPort.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/devPort.ts frontend/src/devPort.test.ts
git commit -m "feat(frontend): resolve the dev-server port from VITE_DEV_PORT"
```

---

## Task 2: Wire the resolver into the Vite config

**Files:**
- Modify: `frontend/vite.config.ts:1-5` (imports), `frontend/vite.config.ts:35` (env read), `frontend/vite.config.ts:43-46` (server block)
- Modify: `frontend/.env.example`

- [ ] **Step 1: Add the import**

In `frontend/vite.config.ts`, after the existing `resolveApiBase` import (line 6):

```ts
import { buildCsp } from "./src/csp";
import { resolveApiBase } from "./src/apiBase";
import { resolveDevPort } from "./src/devPort";
```

- [ ] **Step 2: Resolve the port alongside the other env reads**

In the same file, immediately after the `const apiBase = resolveApiBase(env.VITE_API_BASE);` line:

```ts
  const apiBase = resolveApiBase(env.VITE_API_BASE);
  // Slot-derived so two worktrees can serve the SPA at once. `loadEnv` merges prefixed
  // process.env over the .env files, so Compose can set this without a per-worktree file.
  const devPort = resolveDevPort(env.VITE_DEV_PORT);
```

- [ ] **Step 3: Use it in the server block**

Replace the `server:` block:

```ts
    server: {
      port: devPort,
      // Never silently hop to the next free port: the next port is an origin Auth0 has not
      // been told about, and the failure would surface as a login error far from its cause.
      strictPort: true,
      headers: { "Content-Security-Policy": devCsp },
    },
```

- [ ] **Step 4: Document the variable**

Append to `frontend/.env.example`:

```
# Optional: Vite dev-server port (defaults to 5173). Set per worktree by
# scripts/worktree-new.sh — see "Parallel worktrees" in README.md. Any value used here must
# also be registered in the Auth0 SPA's allowed callback / logout / web origins.
# VITE_DEV_PORT=5173
```

- [ ] **Step 5: Verify the frontend checks still pass**

```bash
cd frontend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh
```

Expected: `✓ frontend: all passed.` — in particular the `build` target's `dist/csp.txt`
assertions, which are unaffected because the CSP derives from `apiBase`, not the dev port.

- [ ] **Step 6: Verify the port actually moves**

```bash
cd frontend && VITE_DEV_PORT=5183 npx vite --host &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5183/
kill %1
```

Expected: `200`.

- [ ] **Step 7: Commit**

```bash
git add frontend/vite.config.ts frontend/.env.example
git commit -m "feat(frontend): bind the dev server to the slot port, strictly"
```

---

## Task 3: Split the repo-root env file

**Files:**
- Create: `.env.shared.example`
- Modify: `.env.example`, `.gitignore`, `backend/src/config.ts:11-14`

The split is what lets a worktree share one copy of the API key (a symlink) while holding its
own ports. `.env.shared` is **optional everywhere** — a single-tree checkout with one fat `.env`
keeps working, and CI never has either file.

- [ ] **Step 1: Create `.env.shared.example`**

```
# Settings that are IDENTICAL across every worktree. In a worktree created by
# scripts/worktree-new.sh this file is a symlink to the main checkout's copy, so the API key
# exists once and rotating it is one edit.
#
#   cp .env.shared.example .env.shared

# Anthropic API (get a key from https://console.anthropic.com — this is a *developer*
# account separate from a Claude Pro/Max subscription; buy a little pay-as-you-go credit).
ANTHROPIC_API_KEY=sk-ant-...

# Model used for code generation + the "should this run code?" judgment.
LLM_MODEL=claude-sonnet-4-6

# --- Sandbox resource limits (per execution) ---
SANDBOX_TIMEOUT_SECONDS=10
SANDBOX_MEMORY_MB=256
SANDBOX_CPUS=0.5
SANDBOX_PIDS_LIMIT=64
SANDBOX_MAX_OUTPUT_CHARS=20000

# --- Auth (OIDC bearer-token validation on /api/execute) ---
# On by default (secure by default); fill in the OIDC_* values below to use it.
# Uncomment the next line to opt out and run the backend without an identity provider.
# AUTH_REQUIRED=false
# For Auth0: issuer is https://<tenant-domain>/ (trailing slash), audience is the API
# identifier, and the JWKS lives at <issuer>.well-known/jwks.json.
OIDC_ISSUER=
OIDC_AUDIENCE=
OIDC_JWKS_URL=

# How long shutdown waits for in-flight requests before forcing an exit. MUST stay under the
# platform's own SIGTERM->SIGKILL window (Cloud Run's is 10s), or the force-exit fires at the
# same instant as the kill and does nothing.
SHUTDOWN_GRACE_MS=8000

# Absolute path to the built SPA. When set, the backend serves the app and the API from ONE
# origin (the production image sets it to /app/public); empty — the default — leaves the
# backend API-only, which is the local Compose topology where Vite serves the SPA.
PUBLIC_DIR=

# --- Logging ---
# `text` (default) for readable local output; `json` emits one Cloud Logging-shaped object per
# line, which is what you want in any hosted environment.
LOG_FORMAT=text

# --- Rate limiting ---
# Per-identity request allowance: a short burst window plus a longer sustained one.
RATE_LIMIT_BURST=10
RATE_LIMIT_BURST_WINDOW_SECONDS=60
RATE_LIMIT_SUSTAINED=100
RATE_LIMIT_SUSTAINED_WINDOW_SECONDS=3600
# Maximum sandbox containers running at once on this instance, across all users.
SANDBOX_MAX_CONCURRENT=4
```

- [ ] **Step 2: Replace `.env.example` with the slot half**

`.env.example` becomes *this worktree's stack identity* only. Overwrite it entirely:

```
# This worktree's stack identity: which ports it publishes and which Compose project it is.
# Everything that does NOT vary per worktree lives in .env.shared (see .env.shared.example).
#
#   cp .env.example .env && cp .env.shared.example .env.shared
#
# scripts/worktree-new.sh generates this file for a new worktree; this copy is slot 0, the
# main checkout, whose ports are the ones the README and every curl example use.

# Slot 0-3. Every port below is `base + STACK_SLOT * 10`. The frontend port must be
# registered in the Auth0 SPA's allowed callback / logout / web origins — see README.md.
STACK_SLOT=0

# Slot 0 pins the name Compose ALREADY derives from this directory. It is written down rather
# than left implicit so that renaming the checkout cannot silently orphan the pgdata volume —
# and deliberately NOT given a slotN form, which would orphan it immediately: Compose would look
# for llmce-slot0_pgdata, not find it, and start with an empty history. Worktrees, which want a
# fresh database anyway, get llmce-slot<N>-<slug>.
COMPOSE_PROJECT_NAME=llm-code-execution

# Published host ports. Container-internal ports never change.
BACKEND_PORT=8000
FRONTEND_PORT=5173
PG_PORT=5432
REDIS_PORT=6379

# CORS origin for the frontend dev server — must match FRONTEND_PORT.
FRONTEND_ORIGIN=http://localhost:5173

# Port the backend listens on when run on the host (`npm run dev`). The application default is
# 8080 because that is Cloud Run's contract; Compose pins the container to 8000 and publishes
# it on BACKEND_PORT.
PORT=8000

# Per-slot sandbox image tag. `llm-sandbox:latest` is shared across the whole Docker daemon,
# so without this a worktree editing backend/sandbox-image/ silently changes what every other
# worktree's backend EXECUTES.
SANDBOX_IMAGE=llm-sandbox:slot0

# --- Host-run connection strings ---
# These are what a backend or an integration suite running ON THE HOST uses. Compose overrides
# both with the compose-network service names (see docker-compose.yml).
DATABASE_URL=postgres://app:app@localhost:5432/app
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 3: Ignore the new file**

In `.gitignore`, under `# Env & secrets`, change:

```
# Env & secrets
.env
.env.local
.env.shared
```

- [ ] **Step 4: Load both files in the host-run backend**

In `backend/src/config.ts`, replace lines 11-14:

```ts
// Repo-root env files for local dev. `.env` carries this worktree's stack identity (slot,
// ports); `.env.shared` carries everything identical across worktrees (API key, OIDC, limits)
// and is a symlink inside a worktree, so the key exists once. Most-specific first because
// dotenv never overrides an already-set key — process.env still wins over both, and in Docker
// both are absent (env arrives via compose env_file), where this simply no-ops.
loadDotenv({ path: ["../.env", "../.env.shared"] });
```

- [ ] **Step 5: Verify the backend still loads its config**

```bash
cd backend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh
```

Expected: `✓ backend: all passed.` The config unit tests pass explicit env objects to
`loadSettings`, so they are independent of this line.

- [ ] **Step 6: Verify the split end to end on the host**

Perform the split in your own checkout, then boot the backend against it:

```bash
cp .env.shared.example .env.shared
# move your real ANTHROPIC_API_KEY and OIDC_* values from .env into .env.shared,
# then replace .env with the slot-0 template from Step 2.
cd backend && npm run dev &
sleep 4
curl -s localhost:8000/api/health
kill %1
```

Expected: `{"status":"ok"}` — proving the key arrived from `.env.shared` and the port from
`.env`. If the backend exits with the `REDIS_URL is not set` guard, start Redis first
(`docker compose up -d redis`).

- [ ] **Step 7: Commit**

```bash
git add .env.example .env.shared.example .gitignore backend/src/config.ts
git commit -m "feat(env): split the root env into per-worktree stack + shared settings"
```

---

## Task 4: Parameterize the published host ports, and make the sandbox error name its real tag

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/src/sandbox/dockerBackend.ts:158`
- Test: `backend/tests/sandbox/dockerBackend.test.ts` (create)

Per-slot image tags are what make the hardcoded remediation string at `dockerBackend.ts:158`
wrong, so it is fixed here rather than left as a follow-up. Note this pulls
`backend/src/sandbox/**` into the change, which per `CLAUDE.md` means the `security-and-hardening`
skill's threat-model-first path applies to this PR — the threat model being written is exactly
the one this plan already owes: *what changes when the sandbox image tag becomes per-slot?*

- [ ] **Step 1: Read both env files in the backend service**

Replace the `env_file` block of the `backend` service:

```yaml
    env_file:
      # Shared across worktrees (API key, OIDC, limits). Optional so a single-tree checkout
      # with one fat .env, and CI, both keep working with no such file.
      - path: .env.shared
        required: false
      # This worktree's stack identity. Listed second so it wins on any overlapping key.
      - .env
```

- [ ] **Step 2: Publish the backend on the slot port**

In the same service:

```yaml
    ports:
      - "${BACKEND_PORT:-8000}:8000"
```

The `PORT: "8000"` line in `environment:` stays — the container-internal port never varies,
only the host side does.

- [ ] **Step 3: Publish Postgres and Redis on their slot ports**

In `postgres`:

```yaml
    # Exposed on the host so local integration tests can reach it. The host port is
    # slot-derived so two worktrees' stacks do not fight over 5432.
    ports:
      - "${PG_PORT:-5432}:5432"
```

In `redis`:

```yaml
    # Exposed on the host so local integration tests can reach it; slot-derived like Postgres.
    ports:
      - "${REDIS_PORT:-6379}:6379"
```

- [ ] **Step 4: Point the frontend at the slot's backend, on the slot's own port**

Replace the whole `frontend` service:

```yaml
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    environment:
      VITE_API_BASE: http://localhost:${BACKEND_PORT:-8000}
      # Vite binds this inside the container too, so the mapping is port:port. `loadEnv` merges
      # prefixed process.env over the .env files, so this wins over a copied-in .env.local.
      VITE_DEV_PORT: "${FRONTEND_PORT:-5173}"
    ports:
      - "${FRONTEND_PORT:-5173}:${FRONTEND_PORT:-5173}"
    depends_on:
      - backend
```

- [ ] **Step 5: Verify slot 0 is byte-for-byte today's topology**

```bash
docker compose config | grep -A2 'published'
```

Expected: published `8000`, `5173`, `5432`, `6379` — the current ports, because every
substitution defaults to them.

- [ ] **Step 6: Verify a slot-1 override moves every port**

```bash
BACKEND_PORT=8010 FRONTEND_PORT=5183 PG_PORT=5442 REDIS_PORT=6389 \
  docker compose config | grep -E 'published|target'
```

Expected: published `8010`, `5183`, `5442`, `6389`, with targets `8000`, `5183`, `5432`, `6379`.

- [ ] **Step 7: Verify two stacks actually run at once**

From the main checkout (slot 0) and any existing worktree with a slot-1 `.env`:

```bash
docker compose up -d --build                       # main tree
curl -s localhost:8000/api/health                  # -> {"status":"ok"}
cd .claude/worktrees/<existing> && docker compose up -d --build
curl -s localhost:8010/api/health                  # -> {"status":"ok"}
docker compose ps --format '{{.Name}}'             # names prefixed llmce-slot1
```

Expected: both health checks return `{"status":"ok"}` and no port-bind error. Tear down with
`docker compose down` in each tree.

- [ ] **Step 8: Commit the Compose change**

```bash
git add docker-compose.yml
git commit -m "feat(compose): derive every published host port from the stack slot"
```

- [ ] **Step 9: Write the failing test for the remediation string**

`dockerBackend.ts` has no test file today. Create `backend/tests/sandbox/dockerBackend.test.ts`:

```ts
/**
 * The "image not found" path is the one place the backend tells a human what to run. With
 * per-slot tags (llm-sandbox:slot1, …) a hardcoded `llm-sandbox:latest` in that sentence sends
 * them to build an image the backend will never look for — and the symptom, an execution that
 * keeps failing after you "built the image", gives no hint why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createContainer = vi.fn();

vi.mock("dockerode", () => ({
  default: class {
    createContainer = createContainer;
    modem = { demuxStream: vi.fn() };
  },
}));

const { DockerBackend } = await import("../../src/sandbox/dockerBackend.js");

describe("DockerBackend: image not found", () => {
  beforeEach(() => {
    createContainer.mockReset();
    createContainer.mockRejectedValue(Object.assign(new Error("no such image"), {
      statusCode: 404,
    }));
  });

  const limits = {
    timeoutSeconds: 5,
    memoryMb: 256,
    cpus: 0.5,
    pidsLimit: 64,
    maxOutputChars: 20000,
  };

  it("names the image it actually looked for, in both halves of the message", async () => {
    const result = await new DockerBackend("llm-sandbox:slot2").execute(
      "print(1)",
      "python",
      limits,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("image 'llm-sandbox:slot2' not found");
    // The remediation must build the SAME tag, not a hardcoded one.
    expect(result.stderr).toContain("docker build -t llm-sandbox:slot2 backend/sandbox-image");
    expect(result.stderr).not.toContain("llm-sandbox:latest");
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

```bash
cd backend && npx vitest run tests/sandbox/dockerBackend.test.ts
```

Expected: FAIL on the second assertion — the message says `llm-sandbox:latest`.

- [ ] **Step 11: Fix the message**

In `backend/src/sandbox/dockerBackend.ts`, replace line 158 so the remediation interpolates the
same field the sentence above it already does:

```ts
          stderr:
            `[sandbox] image '${this.image}' not found. Build it first: ` +
            `\`docker build -t ${this.image} backend/sandbox-image\`.`,
```

- [ ] **Step 12: Run the backend checks**

```bash
cd backend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh
```

Expected: `✓ backend: all passed.`, including the new test.

- [ ] **Step 13: Commit**

```bash
git add backend/src/sandbox/dockerBackend.ts backend/tests/sandbox/dockerBackend.test.ts
git commit -m "fix(sandbox): the image-not-found remediation must name the image it wanted"
```

---

## Task 5: Document the split and the origin pool

**Files:**
- Modify: `README.md` — Setup (`:64-69`), Auth0 tenant setup step 2 (`:137-140`), local-without-Compose (`:110-124`), plus a new section after "Run (Docker Compose)"

- [ ] **Step 1: Update Setup**

Replace the Setup code block and the paragraph under it:

````markdown
## Setup

```bash
cp .env.example .env               # this checkout's stack: slot, ports, Compose project
cp .env.shared.example .env.shared # shared across worktrees: API key, OIDC, limits
# edit .env.shared and set ANTHROPIC_API_KEY=sk-ant-...
```

Two files, because a second worktree needs its own ports but must not need its own copy of your
API key: `.env.shared` is symlinked into each worktree, `.env` is generated per worktree. A
single checkout can keep everything in one `.env` if you prefer — `.env.shared` is optional
everywhere.
````

- [ ] **Step 2: Repoint every reference that moved into `.env.shared`**

Four edits, all of them cases where the README would otherwise send a reader to a file that no
longer holds the variable — or, worse, to a build command that produces the wrong tag.

In the "Run locally without Compose" block, replace the backend env export:

```bash
# .env.shared first, so this worktree's .env wins on any overlapping key — matching how
# Compose (later env_file wins) and dotenv (earlier path wins) both resolve the pair.
export $(grep -hv '^#' ../.env.shared ../.env | xargs)   # load env
```

At `README.md:72`, the `OIDC_*` values now live in the shared file:

```markdown
and `OIDC_JWKS_URL` values for your provider (see `.env.shared.example` and the Auth0 tenant
```

At `README.md:89`, so do the rate-limit tunables:

```markdown
`.env.shared.example` tune the limits — see *Rate limiting* under Security posture.
```

At `README.md:109`, the host-run sandbox build must produce the tag slot 0 actually runs —
`.env.example` now says `SANDBOX_IMAGE=llm-sandbox:slot0`, so building `:latest` would leave the
backend looking for an image that does not exist:

```bash
# 1. Build the sandbox execution image (must match SANDBOX_IMAGE in .env)
docker build -t llm-sandbox:slot0 backend/sandbox-image
```

- [ ] **Step 3: Update Auth0 step 2 to register the pool**

Replace the second half of Auth0 setup step 2:

```markdown
   are `VITE_AUTH0_DOMAIN` / `VITE_AUTH0_CLIENT_ID`. For local dev, add **all four slot
   origins** — `http://localhost:5173`, `:5183`, `:5193`, `:5203` — to **Allowed Callback
   URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**. These are an exact-match
   allowlist, so a worktree on an unregistered port fails login with no useful error; register
   the pool once and every slot works. See *Parallel worktrees* below.
```

- [ ] **Step 4: Add the "Parallel worktrees" section**

Insert after the "Run (Docker Compose — recommended)" section:

````markdown
## Parallel worktrees

Two features at once means two git worktrees, and each needs its own stack — the ports are the
only thing that genuinely collides (Compose already gives each worktree its own containers,
network and `pgdata` volume, keyed on `COMPOSE_PROJECT_NAME`).

Every host-facing port derives from one variable, `STACK_SLOT`, as `base + slot * 10`:

| Slot | Backend | Frontend | Postgres | Redis |
| --- | --- | --- | --- | --- |
| 0 (main checkout) | 8000 | 5173 | 5432 | 6379 |
| 1 | 8010 | 5183 | 5442 | 6389 |
| 2 | 8020 | 5193 | 5452 | 6399 |
| 3 | 8030 | 5203 | 5462 | 6409 |

The pool stops at four because **Auth0's allowed origins are an exact-match allowlist** — every
frontend port has to be registered in the dashboard (see the Auth0 setup above), so the ports
cannot be arbitrary.

`SANDBOX_IMAGE` is per-slot too (`llm-sandbox:slot1`). Image tags are daemon-wide: without this,
a worktree editing `backend/sandbox-image/` would silently change what every *other* worktree's
backend executes.

To set a worktree up by hand, create the worktree, symlink the shared files, and write its `.env`
from `.env.example` with the slot's four ports:

```bash
git worktree add -b feat/thing .claude/worktrees/thing origin/main
cd .claude/worktrees/thing
ln -s ../../../.env.shared .env.shared                                    # the API key, once
ln -s ../../../../.claude/settings.local.json .claude/settings.local.json # permission allowlist
cp ../../../frontend/.env.local frontend/.env.local  # copied, not linked: build context
printf 'VITE_DEV_PORT=5183\nVITE_API_BASE=http://localhost:8010\n' >> frontend/.env.local
cp ../../../.env.example .env
# then set STACK_SLOT, COMPOSE_PROJECT_NAME, and every port-derived value:
# BACKEND_PORT, FRONTEND_PORT, PG_PORT, REDIS_PORT, FRONTEND_ORIGIN, PORT, SANDBOX_IMAGE,
# DATABASE_URL, REDIS_URL. Leaving any of them at slot 0 silently points this worktree at
# slot 0's Postgres, Redis or container names.
(cd backend && npm ci) && (cd frontend && npm ci)
```

The `printf` is not optional: `strictPort` means a worktree whose `frontend/.env.local` still
carries slot 0's values fails to bind 5173 outright rather than drifting to another port.

`frontend/.env.local` is copied rather than symlinked because `frontend/` is the frontend
image's Docker build context, and a symlink pointing outside it does not survive `COPY . .`.
Those are public SPA values, not secrets, so a copy costs nothing.

`node_modules` is deliberately not shared: lockfiles diverge per branch, so each worktree
installs its own (~284 MB).
````

- [ ] **Step 5: Verify the README claims are true**

```bash
grep -n "5183\|.env.shared\|STACK_SLOT" README.md | head
docker compose config >/dev/null && echo "compose file still valid"
```

Expected: the new references are present and Compose still parses.

- [ ] **Step 6: Commit and open PR 1**

```bash
git add README.md docs/plans/2026-08-13-per-worktree-stacks.md
git commit -m "docs: the env split, the slot table, and the Auth0 origin pool"
git push -u origin feat/slot-parameterized-stack
gh pr create --title "feat(compose): slot-parameterized local stack" \
  --body "Every published host port derives from STACK_SLOT, so two worktrees can run their own stacks at once. Slot 0 is today's ports exactly.

Closes #137"
```

Then correct both issue bodies, which were written before the plan and still name the shared
file `.env.secrets`. The file holds `LOG_FORMAT`, `PUBLIC_DIR`, `SHUTDOWN_GRACE_MS` and the
rate-limit tunables alongside the API key, so "secrets" mislabels most of its contents:

```bash
gh issue view 137 --json body -q .body | sed 's/\.env\.secrets/.env.shared/g' | gh issue edit 137 --body-file -
gh issue view 138 --json body -q .body | sed 's/\.env\.secrets/.env.shared/g' | gh issue edit 138 --body-file -
```

- [ ] **Step 7: Run the two mandated reviews before handing the PR over**

Per `CLAUDE.md`: the `code-review` skill and the `security-review` skill against the pending
diff, then evaluate each finding with `receiving-code-review` before applying anything. The
security-relevant claim to check hardest is the per-slot `SANDBOX_IMAGE` tag — it is the change
that stops one worktree altering what another one executes.

---

## Task 6: The worktree script's tests

**Files:**
- Create: `scripts/tests/worktree-new.test.sh`

Branch off `main` again after PR 1 merges:

```bash
git checkout main && git pull && git checkout -b feat/worktree-bootstrap
```

The script's pure parts — which slot to hand out, and what its `.env` says — are the parts worth
testing. The git and `npm ci` work is not: it is one command each, and a test of it would be a
test of git.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/worktree-new.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for the pure helpers in scripts/worktree-new.sh. The script sources cleanly with
# WORKTREE_NEW_LIB=1 (defining functions, running nothing), so the slot arithmetic and the
# generated env block can be tested without touching git or the network.
set -uo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=../worktree-new.sh
WORKTREE_NEW_LIB=1 source ./worktree-new.sh
# The sourced script runs `set -euo pipefail`, which lands in THIS shell. Errexit has to go
# back off or the deliberate failure case below would abort the suite instead of being asserted.
set +e

pass=0
fail=0

# eq <name> <expected> <actual>
eq() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  ✗ %s\n      expected: %s\n      got:      %s\n' "$name" "$want" "$got"
  fi
}

# fails <name> <command...> — asserts a non-zero exit.
fails() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    fail=$((fail + 1))
    printf '  ✗ %s — expected non-zero exit\n' "$name"
  else
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  fi
}

echo "worktree-new.sh"

# --- port_for: base + slot * 10 ---
eq "slot 0 is today's backend port"  8000 "$(port_for 8000 0)"
eq "slot 1 backend"                  8010 "$(port_for 8000 1)"
eq "slot 3 frontend"                 5203 "$(port_for 5173 3)"
eq "slot 2 postgres"                 5452 "$(port_for 5432 2)"
eq "slot 1 redis"                    6389 "$(port_for 6379 1)"

# --- free_slot: lowest unused slot in 1..SLOT_MAX ---
eq "first worktree gets slot 1"      1 "$(free_slot 0)"
eq "second gets slot 2"              2 "$(free_slot 0 1)"
eq "gaps are reused before growing"  1 "$(free_slot 0 2 3)"
eq "out-of-order input still works"  2 "$(free_slot 3 0 1)"
fails "an exhausted pool is an error" free_slot 0 1 2 3

# --- stack_env: the generated .env ---
block="$(stack_env 1 llmce-slot1-thing)"
grep_line() { printf '%s\n' "$block" | grep -m1 "^$1=" || true; }

eq "slot"      "STACK_SLOT=1"                                  "$(grep_line STACK_SLOT)"
eq "project"   "COMPOSE_PROJECT_NAME=llmce-slot1-thing"        "$(grep_line COMPOSE_PROJECT_NAME)"
eq "backend"   "BACKEND_PORT=8010"                             "$(grep_line BACKEND_PORT)"
eq "frontend"  "FRONTEND_PORT=5183"                            "$(grep_line FRONTEND_PORT)"
eq "postgres"  "PG_PORT=5442"                                  "$(grep_line PG_PORT)"
eq "redis"     "REDIS_PORT=6389"                               "$(grep_line REDIS_PORT)"
eq "cors"      "FRONTEND_ORIGIN=http://localhost:5183"         "$(grep_line FRONTEND_ORIGIN)"
eq "listen"    "PORT=8010"                                     "$(grep_line PORT)"
eq "sandbox"   "SANDBOX_IMAGE=llm-sandbox:slot1"               "$(grep_line SANDBOX_IMAGE)"
eq "database"  "DATABASE_URL=postgres://app:app@localhost:5442/app" "$(grep_line DATABASE_URL)"
eq "redis url" "REDIS_URL=redis://localhost:6389"              "$(grep_line REDIS_URL)"

# --- slugify: Compose project names are lowercase alnum, dash, underscore ---
eq "uppercase folds"     "llmce-slot1-fix-auth" "$(project_name 1 'Fix/Auth')"
eq "dots and spaces go"  "llmce-slot2-a-b-c"    "$(project_name 2 'a. b c')"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Make it executable and run it to verify it fails**

```bash
chmod +x scripts/tests/worktree-new.test.sh
./scripts/tests/worktree-new.test.sh
```

Expected: FAIL — `./worktree-new.sh: No such file or directory`.

- [ ] **Step 3: Commit the test**

```bash
git add scripts/tests/worktree-new.test.sh
git commit -m "test(scripts): the slot arithmetic and generated env for worktree-new"
```

---

## Task 7: The worktree script

**Files:**
- Create: `scripts/worktree-new.sh`

- [ ] **Step 1: Write the implementation**

Create `scripts/worktree-new.sh`:

```bash
#!/usr/bin/env bash
# One command to open a worktree that can actually run the app.
#
# A bare `git worktree add` produces a tree that cannot run anything: node_modules is absent,
# and every gitignored file — .env.shared, frontend/.env.local, and .claude/settings.local.json
# (the permission allowlist, whose absence makes a fresh Claude Code session re-prompt for
# permissions it already has) — is missing. This creates the worktree, allocates a stack slot
# so its ports do not collide with any other tree, links the shared files, generates the
# per-worktree env, and installs dependencies.
#
# Usage:  scripts/worktree-new.sh <slug>
#   SLOT_MAX   highest slot to hand out (default 3 — bounded by the frontend origins
#              registered in Auth0; see "Parallel worktrees" in README.md)
#
# Sourcing with WORKTREE_NEW_LIB=1 defines the helpers without running anything, which is how
# scripts/tests/worktree-new.test.sh exercises the slot arithmetic.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLOT_MAX="${SLOT_MAX:-3}"

# Port bases, one per published service. Slot N gets base + N*10 — see the slot table in
# README.md, which these four numbers define.
BASE_BACKEND=8000
BASE_FRONTEND=5173
BASE_PG=5432
BASE_REDIS=6379

port_for() { echo $(( $1 + $2 * 10 )); }

# free_slot <used-slot>... -> the lowest slot in 1..SLOT_MAX that is not in use.
# Slot 0 is reserved for the main checkout, whose ports the README documents.
free_slot() {
  local candidate used
  for ((candidate = 1; candidate <= SLOT_MAX; candidate++)); do
    for used in "$@"; do
      [[ "$used" == "$candidate" ]] && continue 2
    done
    echo "$candidate"
    return 0
  done
  echo "no free stack slot: 1..${SLOT_MAX} are all in use." >&2
  echo "Remove a worktree, or raise SLOT_MAX after registering the extra frontend origin" >&2
  echo "in the Auth0 SPA's allowed callback / logout / web origins." >&2
  return 1
}

# project_name <slot> <slug> -> a Compose project name. Compose accepts lowercase
# alphanumerics, dash and underscore only; anything else becomes a dash.
project_name() {
  local slot="$1" slug
  slug="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+|-+$//g')"
  printf 'llmce-slot%s-%s\n' "$slot" "$slug"
}

# stack_env <slot> <project-name> -> the worktree's .env, on stdout.
stack_env() {
  local slot="$1" project="$2"
  local backend frontend pg redis
  backend="$(port_for "$BASE_BACKEND" "$slot")"
  frontend="$(port_for "$BASE_FRONTEND" "$slot")"
  pg="$(port_for "$BASE_PG" "$slot")"
  redis="$(port_for "$BASE_REDIS" "$slot")"
  cat <<EOF
# Generated by scripts/worktree-new.sh — this worktree's stack identity. Do not commit.
# Settings shared with every other worktree live in .env.shared (a symlink to the main
# checkout's copy). See "Parallel worktrees" in README.md for the slot table.
STACK_SLOT=${slot}
COMPOSE_PROJECT_NAME=${project}

BACKEND_PORT=${backend}
FRONTEND_PORT=${frontend}
PG_PORT=${pg}
REDIS_PORT=${redis}

FRONTEND_ORIGIN=http://localhost:${frontend}
PORT=${backend}

# Per-slot tag: image tags are daemon-wide, so a shared one would let this worktree's edits to
# backend/sandbox-image/ change what every other worktree's backend executes.
SANDBOX_IMAGE=llm-sandbox:slot${slot}

# Host-run connection strings. Compose overrides both with compose-network service names.
DATABASE_URL=postgres://app:app@localhost:${pg}/app
REDIS_URL=redis://localhost:${redis}
EOF
}

# used_slots -> every STACK_SLOT currently claimed, one per line: the main checkout plus each
# registered worktree. A tree with no .env yet claims nothing.
used_slots() {
  local dir
  {
    printf '%s\n' "$ROOT"
    git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print $2}'
  } | sort -u | while read -r dir; do
    [[ -f "$dir/.env" ]] || continue
    sed -nE 's/^STACK_SLOT=([0-9]+).*/\1/p' "$dir/.env" | head -1
  done
}

main() {
  local slug="${1:-}"
  # No slashes: the symlink targets below are literal `../..` chains, which are only correct
  # for a single directory level under .claude/worktrees/.
  if [[ ! "$slug" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "usage: scripts/worktree-new.sh <slug>   (letters, digits, dot, dash, underscore)" >&2
    exit 2
  fi

  # Run from the main checkout only. In a linked worktree `.git` is a file, not a directory —
  # and creating a worktree from inside one would nest .claude/worktrees/ inside itself.
  if [[ ! -d "$ROOT/.git" ]]; then
    echo "✗ run this from the main checkout, not from a worktree." >&2
    exit 1
  fi

  local dir="$ROOT/.claude/worktrees/$slug"
  if [[ -e "$dir" ]]; then
    echo "✗ $dir already exists." >&2
    exit 1
  fi

  local slot project
  slot="$(free_slot $(used_slots))"
  project="$(project_name "$slot" "$slug")"

  echo "==> slot ${slot} — backend $(port_for "$BASE_BACKEND" "$slot"), frontend $(port_for "$BASE_FRONTEND" "$slot")"

  git -C "$ROOT" fetch origin
  git -C "$ROOT" worktree add -b "feat/$slug" "$dir" origin/main

  # Gitignored files a worktree does not inherit. These two are symlinked rather than copied so
  # the API key and the permission allowlist each keep exactly one source of truth. Relative
  # targets — an absolute one would break if the checkout is ever moved. `.claude/worktrees/`
  # is two levels below the root, so `$dir` needs ../../.. and a file one level inside it
  # needs ../../../.. to reach the root.
  [[ -f "$ROOT/.env.shared" ]] && ln -sfn "../../../.env.shared" "$dir/.env.shared"
  [[ -f "$ROOT/.claude/settings.local.json" ]] &&
    ln -sfn "../../../../.claude/settings.local.json" "$dir/.claude/settings.local.json"

  stack_env "$slot" "$project" > "$dir/.env"

  # frontend/.env.local is COPIED, not symlinked: `frontend/` is the frontend image's Docker
  # build context, and a symlink pointing outside the context does not survive `COPY . .` —
  # the containerized frontend would lose its Auth0 configuration. Copying is fine here because
  # these are public SPA values, not secrets (see frontend/.env.example).
  if [[ -f "$ROOT/frontend/.env.local" ]]; then
    # `|| true`: grep exits 1 on no match, and under `set -e` that would abort here — AFTER
    # the worktree and branch exist, leaving a half-built tree behind.
    grep -E '^VITE_AUTH0_' "$ROOT/frontend/.env.local" > "$dir/frontend/.env.local" || true
  fi
  printf 'VITE_DEV_PORT=%s\nVITE_API_BASE=http://localhost:%s\n' \
    "$(port_for "$BASE_FRONTEND" "$slot")" "$(port_for "$BASE_BACKEND" "$slot")" \
    >> "$dir/frontend/.env.local"

  (cd "$dir/backend" && npm ci)
  (cd "$dir/frontend" && npm ci)

  echo
  echo "✓ worktree ready: $dir"
  echo "  cd $dir && docker compose up --build"
  echo "  frontend: http://localhost:$(port_for "$BASE_FRONTEND" "$slot")"
}

if [[ "${WORKTREE_NEW_LIB:-}" != "1" ]]; then
  main "$@"
fi
```

- [ ] **Step 2: Make it executable and run the tests**

```bash
chmod +x scripts/worktree-new.sh
./scripts/tests/worktree-new.test.sh
```

Expected: `23 passed, 0 failed`.

- [ ] **Step 3: Verify it end to end**

```bash
./scripts/worktree-new.sh scratch-check
cd .claude/worktrees/scratch-check
grep STACK_SLOT .env
ls -l .env.shared .claude/settings.local.json   # symlinks, resolving to the main checkout
cat frontend/.env.local                          # a real file: Auth0 values + this slot's ports
docker compose up -d --build
curl -s "localhost:$(sed -nE 's/^BACKEND_PORT=//p' .env)/api/health"
```

Expected: a slot ≥ 1, two resolving symlinks, a `frontend/.env.local` carrying both the
`VITE_AUTH0_*` values and `VITE_DEV_PORT`, and `{"status":"ok"}` — while the main checkout's
stack is also up.

- [ ] **Step 4: Tear the scratch worktree down**

```bash
docker compose down
cd ../../..   # back to the main checkout — ROOT is internal to the script, not your shell
git worktree remove .claude/worktrees/scratch-check --force
git branch -D feat/scratch-check
```

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree-new.sh
git commit -m "feat(scripts): worktree-new.sh — a worktree that can run the app"
```

---

## Task 8: Update the SDLC contract

**Files:**
- Modify: `docs/sdlc.md` — the "Changing this SDLC" section at `:464-479`

`scripts/` is an SDLC-watched path, so this PR must touch `docs/sdlc.md` or the `SDLC docs` job
fails. That is not a formality here: the doc's claim that `scripts/` contains exactly two CI
checks stops being true with this PR.

**No CI job is added.** `worktree-new.sh` is local developer tooling — CI never creates a
worktree, so a CI run of its test would assert nothing about anything CI does. Its test is a
local pre-push command, and the failure mode it guards against (bad slot arithmetic) surfaces
the instant a developer runs the script. This also leaves the `:303-311` mirroring rule and its
two metadata-level exceptions exactly as written, which is the outcome to prefer: that rule is
load-bearing, and widening it for a dev script would weaken it.

- [ ] **Step 1: Correct the "Changing this SDLC" rationale**

Replace the paragraph at `:477-479`:

```markdown
That last entry is deliberate: this document describes the exact semantics of the checks in
`scripts/` — their watched paths, failure messages and escape hatches — so a change to one that
skipped the doc would leave the two silently disagreeing.

`scripts/` also holds **developer tooling** that is not a CI check: `scripts/worktree-new.sh`
creates a git worktree with its own application stack. The watched-path rule covers it too, and
that is the right outcome rather than an accident — the stack-slot contract it encodes (which
ports a slot owns, and the Auth0 origins that bound the pool) is process, and a change to it
that skipped the docs would leave `README.md`'s slot table describing a scheme the script no
longer implements. Its unit tests, `scripts/tests/worktree-new.test.sh`, run **locally only**:
CI never creates a worktree, so there is nothing there for them to protect. That is why they are
absent from the two jobs listed above, and why they are not an exception to the `verify.sh`
mirroring rule — there is no CI check to mirror.
```

- [ ] **Step 2: Verify the SDLC check passes on this very PR**

```bash
BASE_SHA="$(git merge-base HEAD origin/main)" ./scripts/check-sdlc-sync.sh
./scripts/tests/check-sdlc-sync.test.sh
./scripts/tests/worktree-new.test.sh
```

Expected: `✓ SDLC-governed files changed and docs/sdlc.md was updated in the same change`,
then both suites green.

- [ ] **Step 3: Commit**

```bash
git add docs/sdlc.md
git commit -m "docs(sdlc): scripts/ now holds developer tooling, not only CI checks"
```

---

## Task 9: Point the README at the script, and open PR 2

**Files:**
- Modify: `README.md` — the "Parallel worktrees" section added in Task 5

- [ ] **Step 1: Replace the manual recipe with the script**

In the "Parallel worktrees" section, replace the "To set a worktree up by hand…" paragraph and
its code block:

````markdown
One command creates a worktree that can actually run:

```bash
scripts/worktree-new.sh thing
cd .claude/worktrees/thing && docker compose up --build
```

It allocates the lowest free slot, creates the branch off a freshly fetched `origin/main`, and
supplies the gitignored files a worktree does not inherit: `.env.shared` and
`.claude/settings.local.json` are symlinked back to this checkout (the second is the permission
allowlist — without it a fresh Claude Code session re-prompts for everything you have already
granted), while `.env` and `frontend/.env.local` are generated with the slot's ports. Then it
runs `npm ci` on both sides. It fails with a clear message when all four slots are taken.

`node_modules` is deliberately not shared: lockfiles diverge per branch, so each worktree
installs its own (~284 MB).
````

- [ ] **Step 2: Verify both sides still pass**

```bash
(cd backend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh)
(cd frontend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh)
```

Expected: both print their `✓ … all passed.` line.

- [ ] **Step 3: Commit and open PR 2**

```bash
git add README.md
git commit -m "docs: point the worktree section at scripts/worktree-new.sh"
git push -u origin feat/worktree-bootstrap
gh pr create --title "feat(scripts): worktree-new.sh — one command to open a working worktree" \
  --body "Creates a worktree with its own stack slot, the gitignored files it cannot inherit, and installed dependencies.

Closes #138"
```

- [ ] **Step 4: Run the two mandated reviews**

`code-review` and `security-review` against the pending diff, then `receiving-code-review` on
the findings. The thing to look at hardest is the symlinking: the script links a file holding an
API key into a new directory, so the relative-path computation and the "link, never copy"
property are both worth a second pair of eyes.

---

## Verification: the whole thing works

After both PRs merge, from a clean `main`:

```bash
scripts/worktree-new.sh alpha
scripts/worktree-new.sh beta
docker compose up -d --build                                    # main tree, slot 0
(cd .claude/worktrees/alpha && docker compose up -d --build)     # slot 1
(cd .claude/worktrees/beta  && docker compose up -d --build)     # slot 2
curl -s localhost:8000/api/health
curl -s localhost:8010/api/health
curl -s localhost:8020/api/health
```

Expected: three `{"status":"ok"}` responses. Then, proving the integration suites no longer
share a database:

```bash
(cd .claude/worktrees/alpha/backend && set -a && . ../.env && set +a && npm run test:integration)
(cd .claude/worktrees/beta/backend  && set -a && . ../.env && set +a && npm run test:integration)
```

Expected: both green, run concurrently, each against its own Postgres and Redis.

---

## Plan review log

Staff-engineer review 2026-08-13 — applied without asking:

- Task 1: added Step 0 creating `feat/slot-parameterized-stack`; Task 5 Step 6 pushed a branch
  nothing had created.
- Task 5 Step 2: reversed the README export order to `../.env.shared ../.env`, so this
  worktree's `.env` wins — the original had `.env.shared` winning, the opposite of both other
  loaders.
- Task 5 Step 2: repointed `README.md:72` (`OIDC_*`) and `README.md:89` (`RATE_LIMIT_*`,
  `SANDBOX_MAX_CONCURRENT`) at `.env.shared.example`, where those variables now live.
- Task 5 Step 2: `README.md:109` now builds `llm-sandbox:slot0`, matching the new
  `.env.example`; building `:latest` would leave the host-run backend without its image.
- Task 5 Step 4: the manual recipe now names all nine slot-derived values, not "five".
- Task 5 Step 4: the manual recipe appends `VITE_DEV_PORT` / `VITE_API_BASE` to the copied
  `frontend/.env.local` — without it, a PR-1-era worktree hard-fails the bind under
  `strictPort`.
- Task 5 Step 6: added this plan file to the `git add`; nothing had committed it.
- Task 7 Step 1: `|| true` on the `VITE_AUTH0_` grep — exit 1 on no match would abort the
  script under `set -e` after the worktree already existed.
- Task 7 Step 4: teardown uses `cd ../../..`; `ROOT` is internal to the script and unset in the
  user's shell, so `cd "$ROOT"` was a silent no-op that made the `git worktree remove` fail.
- File Structure and Task 2 Files: corrected the `vite.config.ts` line references to `:1-5`,
  `:35`, `:43-46` (were `:1-8`, `:24-26`, `:50-55`).

The reviewer independently verified — and the plan relies on — the Compose `required: false`
semantics on v5.3.0, Vite's `loadEnv` merging prefixed `process.env` over file values, dotenv's
first-file-wins array precedence (installed version is 16.6.1, not the 16.4 the plan cited), and
the full bash suite under macOS bash 3.2.57 printing `23 passed, 0 failed`.

Escalated to the user. Two decided, two open:

- **`worktree-new.test.sh` in CI — decided: no CI job.** The script is local developer tooling
  and CI never creates a worktree, so a CI run of its test would assert nothing about CI. Task 8
  now changes only `docs/sdlc.md`, and the `:303-311` mirroring rule keeps its two
  metadata-level exceptions unchanged.
- **`dockerBackend.ts:158` — decided: fix in PR 1**, with a test, as Task 4 Steps 9-13. Per-slot
  tags are what make the hardcoded `llm-sandbox:latest` remediation wrong, so it belongs with the
  change that causes it. This pulls `backend/src/sandbox/**` into PR 1 and with it the
  `security-and-hardening` threat-model-first path.
- **`.env.secrets` → `.env.shared` — decided: keep `.env.shared`.** The file carries
  `LOG_FORMAT`, `PUBLIC_DIR`, `SHUTDOWN_GRACE_MS` and the rate limits as well as the API key, so
  "secrets" mislabels most of it. Issues #137/#138 are re-worded in Task 5 Step 6.
- **Slot 0's `COMPOSE_PROJECT_NAME` — decided: pin it to `llm-code-execution`**, the name
  Compose already derives from the directory, so the existing `llm-code-execution_pgdata` volume
  stays attached and local chat history survives. Writing it down also stops a future rename of
  the checkout from orphaning the volume silently.

All four escalations are resolved; implementation started 2026-08-13.

## Implementation log

**Found during Task 3, escalated and decided 2026-08-13: worktrees under a dot-prefixed
directory could not run `backend/verify.sh` at all.** `send` applies its dotfile guard to every
segment of an absolute path, so `res.sendFile(indexHtml)` at `staticSite.ts:98` 404'd every deep
link whenever the checkout lived under `.claude/worktrees/` — two failures in
`tests/staticSite.test.ts`, in a tree where the whole point is to be able to work. Proved
path-independent with a probe run from the non-dotted main checkout: dotted `publicDir` → 404,
plain → 200, same unmodified source.

Decision: fix it in PR 1 rather than relocate worktrees. `res.sendFile("index.html", { root:
publicDir })` confines the guard to the part a request controls, which is the only part it was
for; relocating would have left the bug in place and fought Claude Code's own
`.claude/worktrees/` convention. The regression test serves the existing fixture through a
committed `tests/fixtures/.dotted/` directory so it fails on any checkout path, not only a
hidden one.

**Found while running the PR-1 checks: `frontend/verify.sh` failed in any worktree on slot ≥ 1.**
`api.ts` and `history.ts` read `import.meta.env.VITE_API_BASE` at module load, so the unit suite
inherited the slot's port from `frontend/.env.local` and asserted the developer's local config
instead of the client's URL construction. Pinned with vitest's `test.env`. Same class as the
dot-path bug: a change that made the tests depend on where they run.

**PR 1 code review (`code-review high`), incorporated 2026-08-13.** No correctness bugs in the
changed code; the reviewer independently confirmed all three env-precedence claims and the
`send` dot-check mechanism. Seven findings, six applied — see the commit
`fix(worktrees): close the silent-misconfiguration paths found in review`.

One finding **deferred to PR 2, deliberately**: `backend/verify.sh` builds and then *runs*
`llm-code-execution:verify` (`:70`), and those `:verify` tags are daemon-wide, so two worktrees
running `./verify.sh` concurrently can have one tree's CSP/non-root assertions execute the
other's image. This is real — and it is the same shared-tag hazard this plan fixes for
`SANDBOX_IMAGE`. It lands in PR 2 rather than PR 1 because `backend/verify.sh` and
`frontend/verify.sh` are SDLC-watched paths: touching them requires `docs/sdlc.md` in the same
PR, which PR 2 already owns and PR 1 otherwise has no business in. Until then the hazard needs
two worktrees verifying at the same instant, which needs PR 2's tooling to be routine.
**Add to PR 2:** derive the tag suffix automatically inside both scripts — e.g.
`basename "$(git rev-parse --show-toplevel)"` — so it is unique per worktree with nothing to
remember, and deterministic in CI.

---

**PR 2 (#141), 2026-08-15 — shipped, with both reviews incorporated.**

The deferred `verify.sh` tag fix landed here as planned, though not in the form the note above
suggested: `git rev-parse --show-toplevel` was replaced by a root captured from the script's own
location (correct in an exported tree, and it cannot depend on how the script was invoked), and
the basename alone turned out to be neither unique — `worktree-new.sh llm-code-execution` would
give a worktree the main checkout's tag — nor bounded against Docker's 128-character tag limit.
The tag is now `verify-<name-truncated>-<cksum of the full path>`.

`code-review high` returned seven findings, all applied. Every one was the same shape as PR 1's:
a mistake with no signal. The two that mattered most were `slot_of` piping sed into `head -1`
(under the inherited `pipefail`, a SIGPIPE can kill `used_slots` mid-loop, dropping claims and
handing out a slot twice) and the script reporting `✓ worktree ready` for a tree with no API key.

Copilot then found six more on the fixes themselves, all applied. The significant one was that
slot allocation is check-then-act: two concurrent runs could both claim the same slot. That is now
serialised behind an atomic `mkdir` lock spanning the read and the `.env` write. It also correctly
pushed back on the "warn about a missing `.env.shared`" approach — the unsplit layout is
documented as supported, so `.env.shared` now falls back to a symlink to the root `.env`, which
the env-file ordering makes safe in both topologies.

Four defects were caught in the fixes themselves while verifying them, which is the argument for
running the checks rather than reasoning about them: `${BASH_SOURCE[0]}` broke under
`backend/verify.sh` invoked from the repo root; `basename`'s trailing newline was translated into
a dash by `tr -c`, so every tag ended in one; the EXIT trap read `local`s that were out of scope
by the time it fired, so `set -u` killed the handler before it released the lock; and the
`.env` fallback was filed under "will NOT run yet" when it does in fact run.

Epic #136 complete.
