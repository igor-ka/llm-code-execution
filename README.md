# LLM Code Execution

A web app where you type a prompt, **Claude decides whether code generation makes sense**,
generates the code if it does, and runs it in a **hardened, throwaway sandbox** that can't
affect the host. If the prompt isn't a coding task, you get a friendly message instead of code.

This is a learning project that mirrors an enterprise B2B pattern. The sandbox layer sits
behind a swappable `SandboxBackend` interface so the same OCI image can later run under
**GCP Cloud Run Jobs** (microVM isolation) or **GKE + gVisor** with no app changes.

```
Browser (React) ──POST /api/execute──▶ Express (TypeScript)
                                         │ 1. LLMService.generate(prompt)  ──▶ Claude (single structured call)
                                         │      → { should_execute, language, code?, message? }
                                         │ 2. not should_execute → return message (no sandbox)
                                         │ 3. else SandboxBackend.execute(code) → DockerBackend
                                         ▼
                                   ephemeral, locked-down container
```

## Layout

```
backend/
  src/
    server.ts                Express: /api/execute, /api/health, /api/config, /api/sessions*, /api/runs/:id
    index.ts                 composition root: pool + Redis + migrations, listens on $PORT,
                             graceful SIGTERM shutdown
    shutdown.ts              SIGTERM/SIGINT sequencer: drain, release, exit (hard deadline)
    config.ts                settings + sandbox limits (per-tenant override seam)
    schemas.ts               Zod request + response builders + internal types
    errors.ts                HttpError
    llm.ts                   single structured Claude call (judge + generate) w/ prompt caching
    auth.ts                  OIDC bearer-token middleware (require_principal)
    sandbox/
      base.ts                SandboxBackend interface (the GCP-ready seam)
      dockerBackend.ts       hardened, ephemeral docker run per execution (dockerode)
    history/                 per-user chat history — the second swappable seam
      store.ts               HistoryStore interface (+ SessionNotFound, titleFromPrompt)
      memoryStore.ts         in-memory store (contract oracle + injected test double)
      pgStore.ts             PostgresHistoryStore — owner-scoped, parameterized SQL
      router.ts              owner-scoped sessions CRUD + search + run delete
      dto.ts / types.ts      Zod DTOs + domain types; pool.ts / migrate.ts (SQL runner)
  migrations/                ordered SQL, applied on boot (001_history.sql)
  sandbox-image/Dockerfile   the minimal, non-root EXECUTION image (Python — unchanged)
  tests/                     Vitest suites; history/ = contract + router + persist + isolation battery
  verify.sh                  checks (eslint + prettier + vitest + tsc + docker + npm audit); +test:integration (Postgres, Redis)
frontend/                    React + Vite UI
  src/                       App.tsx, api.ts, history.ts, components/ (HistorySidebar, SessionView, RunResult)
  verify.sh                  one-command checks (lint + format + vitest + build + docker + npm audit)
infra/                       Terraform root for the GCP environment (Phase 1 foundation + Phase 2 data stores)
  apis.tf registry.tf        enabled APIs; Artifact Registry with cleanup policies
  identity.tf secrets.tf     runtime service account; six secret CONTAINERS (payloads never in Terraform)
  wif.tf budget.tf           keyless GitHub federation; credit-burn + real-spend budgets
  sql.tf valkey.tf           Cloud SQL (no public access) and Memorystore for Valkey behind a private VPC/PSC
  tests/                     unit tests for the repo-specific gates and bootstrap.sh, run first by verify.sh
  verify.sh                  selftest + fmt + init -backend=false + validate + gates (no credentials)
  bootstrap.sh               creates the state bucket — the one resource Terraform does not own
docker-compose.yml           local dev topology: backend + frontend + postgres + redis + one-shot sandbox-image build
Dockerfile                   PRODUCTION image: SPA + API in one container, one origin, non-root, no Docker socket
.dockerignore                build context for the production image (the repo root is that context)
```

## Prerequisites

- **Docker** (Desktop or Engine) — required to build/run the sandbox and the compose stack.
  Install from https://www.docker.com/products/docker-desktop/ and make sure the engine is
  running (`docker info` succeeds).
- **Node.js 22+** — to build and run the backend (`node --version`).
- An **Anthropic API key** from https://console.anthropic.com — this is a *developer* account,
  **separate from a Claude Pro/Max subscription**. Add a small amount of pay-as-you-go credit
  ($5–10 is plenty for this project) and create an API key.

## Setup

```bash
cp .env.example .env               # this checkout's stack: slot, ports, Compose project
cp .env.shared.example .env.shared # shared across worktrees: API key, OIDC, limits
# edit .env.shared and set ANTHROPIC_API_KEY=sk-ant-...
```

Two files, because a second worktree needs its own ports but must not need its own copy of your
API key: `.env.shared` is symlinked into each worktree, `.env` is generated per worktree. A
single checkout can keep everything in one `.env` if you prefer — `.env.shared` is optional
everywhere. See [Parallel worktrees](#parallel-worktrees).

The `/api/execute` auth gate is **on by default**. Set the `OIDC_ISSUER`, `OIDC_AUDIENCE`,
and `OIDC_JWKS_URL` values for your provider (see `.env.shared.example` and the Auth0 tenant setup
below). To run the backend without an identity provider for local dev, set `AUTH_REQUIRED=false`
— the endpoint then accepts anonymous requests.

**Per-user chat history** persists each run in **Postgres**, keyed on the verified user, and is
served under `/api/sessions` + `/api/runs`. It is **an authenticated feature**: it activates
only when auth is on **and** `DATABASE_URL` is set. Leaving `DATABASE_URL` empty **disables
persistence** — `/api/execute` then behaves exactly as before (nothing is saved) and the history
UI is hidden. Under Docker Compose the backend reaches the bundled `postgres` service at
`postgres://app:app@postgres:5432/app` (wired in `docker-compose.yml`); the backend applies the
`migrations/` on boot. For a host-run backend, point `DATABASE_URL` at your own Postgres.

**`REDIS_URL` is required** — unlike `DATABASE_URL`, leaving it empty does *not* degrade
gracefully: the backend **refuses to start**. The per-user request quota is a security control,
not an optional feature, so a missing variable must not silently disable it. Compose supplies
`redis://redis:6379`; a host-run backend needs its own Redis (`docker run -p 6379:6379
redis:7-alpine` is enough). The `RATE_LIMIT_*` and `SANDBOX_MAX_CONCURRENT` values in
`.env.shared.example` tune the limits — see *Rate limiting* under Security posture.

## Run (Docker Compose — recommended)

```bash
docker compose up --build
```

This builds the sandbox execution image, starts **postgres** (history datastore) and **redis**
(quota counters), the backend on
**http://localhost:8000** and the frontend on **http://localhost:5173**. Open the frontend
and try a prompt. Because auth is on by default, you'll need the Auth0 setup below (or set
`AUTH_REQUIRED=false` in `.env` for an open local instance — note that history is disabled in
that anonymous mode). History data persists in the `pgdata` volume across restarts (`docker
compose down -v` drops it).

## Parallel worktrees

Two features at once means two git worktrees, and each needs its own stack — the ports are the
only thing that genuinely collides. Compose already gives each worktree its own containers,
network and `pgdata` volume, keyed on `COMPOSE_PROJECT_NAME`, and sandbox containers are created
unnamed with `NetworkMode: "none"`, so those never fight.

Every host-facing port derives from one variable, `STACK_SLOT`, as `base + slot * 10`:

| Slot | Frontend (open this) | Backend API | Postgres | Redis |
| --- | --- | --- | --- | --- |
| 0 (main checkout) | http://localhost:5173 | :8000 | :5432 | :6379 |
| 1 | http://localhost:5183 | :8010 | :5442 | :6389 |
| 2 | http://localhost:5193 | :8020 | :5452 | :6399 |
| 3 | http://localhost:5203 | :8030 | :5462 | :6409 |

Each is a self-contained app in its own browser tab: the SPA on `:5183` only ever calls `:8010`,
whose history lives in the Postgres on `:5442`. You log in per tab — same Auth0 tenant, same
account, separate origins.

The pool stops at four because **Auth0's allowed origins are an exact-match allowlist** — every
frontend port has to be registered in the dashboard (see the Auth0 setup above), so the ports
cannot be arbitrary.

`SANDBOX_IMAGE` is per-slot too (`llm-sandbox:slot1`). Image tags are daemon-wide: without this,
a worktree editing `backend/sandbox-image/` would silently change what every *other* worktree's
backend executes.

One command, run from the main checkout, creates a worktree that can actually run:

```bash
scripts/worktree-new.sh thing                 # branch feat/thing
scripts/worktree-new.sh thing fix/some-bug    # or name the branch yourself
cd .claude/worktrees/thing && docker compose up --build
```

It allocates the lowest free slot (failing with a clear message when all four are taken), creates
the branch off a freshly fetched `origin/main`, and supplies the gitignored files a worktree does
not inherit:

- `.env.shared` and `.claude/settings.local.json` are **symlinked** back to the main checkout, so
  the API key and your permission allowlist each keep one source of truth. Without the second, a
  fresh Claude Code session in the worktree re-prompts for everything you have already granted.
- `.env` and `frontend/.env.local` are **generated** with this slot's ports.

`frontend/.env.local` is generated rather than symlinked because `frontend/` is the frontend
image's Docker build context, and a symlink pointing outside it does not survive `COPY . .` —
the containerized frontend would lose its Auth0 configuration. Those are public SPA values, not
secrets, so a copy costs nothing.

Then it runs `npm ci` on both sides. `node_modules` is deliberately not shared: lockfiles diverge
per branch, so each worktree installs its own (~284 MB).

It refuses to claim success on a worktree that cannot run. If the shared env or the Auth0 values
are missing — or merely *unfilled*, which a copied `.env.shared.example` or `frontend/.env.example`
looks exactly like — it prints no ✓, names what to fix, and **exits non-zero**, so a script or a
session calling it does not proceed into a dead tree. If it fails partway (a registry hiccup during
`npm ci`) it prints the exact commands to retry or to remove what it created.

To remove one: `docker compose down` inside it, then `git worktree remove <path>` and
`git branch -D <branch>` from the main checkout. That frees the slot for the next
`worktree-new.sh`.

Its `verify.sh` images outlive it, though — the tags are keyed on a path that no longer exists, so
nothing will ever reuse or replace them. Reclaim the space when you remove a worktree:

Derive the exact tag the way `verify.sh` does — **before** removing the worktree, while its path
still exists — and match it whole. A bare dirname filter would miss a name longer than 24
characters and would sweep up a second checkout that happens to share the name:

```bash
root=$(cd .claude/worktrees/thing && pwd)          # while it still exists
tag="verify-$(printf '%s' "$(basename "$root")" | tr -c '[:alnum:]._-' '-' | cut -c1-24)-$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -- ":${tag}$" | xargs -r docker image rm
```

The backend warns at startup if a worktree's `.env` claims one slot but points a port, URL or
sandbox image tag at another. Those are the mistakes with no other symptom: one writes this
worktree's chat history into slot 0's Postgres, the other executes slot 0's sandbox image.

Both `verify.sh` scripts tag their throwaway images `verify-<dirname>-<checksum of the full path>`
for the same reason image tags are per-slot: the backend one builds a tag and then runs it, so a
fixed tag would let two worktrees verifying at once execute each other's images. (The bare
directory name would not do — a worktree can share it with the main checkout, and Docker caps a
tag at 128 characters.)

## Run locally without Compose

```bash
# 1. Build the sandbox execution image (must match SANDBOX_IMAGE in .env)
docker build -t llm-sandbox:slot0 backend/sandbox-image

# 2. Backend
cd backend
npm install
# .env.shared first, so this worktree's .env wins on any overlapping key — matching how
# Compose (later env_file wins) and dotenv (earlier path wins) both resolve the pair.
export $(grep -hv '^#' ../.env.shared ../.env | xargs)   # load env
npm run dev            # or: npm run build && npm start

# 3. Frontend (separate terminal)
cd frontend
cp .env.example .env.local   # fill in your Auth0 SPA values (domain, client id, audience)
npm install
npm run dev
```

The frontend requires logging in via Auth0 before you can run a prompt; it sends the access
token to the backend as a bearer token. Set the `VITE_AUTH0_*` values in `frontend/.env.local`
(see `frontend/.env.example`). These are public SPA values, not secrets.

### Auth0 tenant setup (dashboard)

The `.env` values above only work once the tenant is configured. Create **two resources** in
one Auth0 tenant — an API and a Single Page Application — then authorize the app to call the
API:

1. **An API** (Applications → APIs). Its **Identifier** is your `OIDC_AUDIENCE` /
   `VITE_AUTH0_AUDIENCE` (e.g. `https://api.<something>.local`). Under **Permissions**, add a
   scope **`execute:code`** — this is the scope the backend requires.
2. **A Single Page Application** (Applications → Applications). Its **Domain** and **Client ID**
   are `VITE_AUTH0_DOMAIN` / `VITE_AUTH0_CLIENT_ID`. For local dev, add **all four slot
   origins** — `http://localhost:5173`, `:5183`, `:5193`, `:5203` — to **Allowed Callback
   URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**. These are an exact-match
   allowlist, so a worktree on an unregistered port fails login with no useful error; register
   the pool once and every slot works. See [Parallel worktrees](#parallel-worktrees).
3. **Authorize the SPA to request the API** — once per app, *not* per user. On the SPA, open
   **APIs / API Application Access** and grant it user-delegated access to the API. Without
   this, `/authorize` fails with *"Client … is not authorized to access resource server …"*
   even with the correct audience — this is easy to miss.

**Authorization model.** The backend only checks that the token carries `execute:code` (in
either the `scope` string or a `permissions` array). With **RBAC off** (the default), any
logged-in user who requests the `execute:code` scope receives it — so every new signup can use
the app with no per-user setup. Enable **RBAC** (+ *Add Permissions in the Access Token*) only
if you want to gate *which* users may execute; the scope is then filtered to each user's
assigned permissions, which you'd grant via a role / default role / post-registration Action
(not by hand per user — that doesn't scale to open signup).

The backend derives `OIDC_ISSUER` as `https://<domain>/` (trailing slash) and `OIDC_JWKS_URL`
as `https://<domain>/.well-known/jwks.json`. `tenant_id` comes from the `org_id` claim, which
is only present if you use Auth0 Organizations; it stays null otherwise.

## Sandbox hardening (DockerBackend)

Each execution runs in a fresh container with: `--network none`, capped memory (no swap),
CPU and PID limits, a read-only root filesystem + small tmpfs, **all** Linux capabilities
dropped, `no-new-privileges`, a non-root user, a wall-clock timeout (container killed on
overrun), and `--rm` so nothing persists. Output is truncated to a safe size.

## Per-user chat history

Signed-in users get a persistent, **strictly private** history of their runs, grouped into
**sessions** (a session ⇒ many runs; the no-code "message" replies are saved too). The UI adds a
sidebar to list, reopen, search, rename, delete, and clear *your own* history; each `/api/execute`
appends to the current session (or starts one).

**Isolation is the core guarantee — no user can see or touch another's history — and it is
structural, not incidental:**

- Identity comes from the **verified token** (`sub`), never the request body. Every `HistoryStore`
  method takes that owner and filters on it (`WHERE user_id = …`); a session/run you don't own is
  **indistinguishable from one that doesn't exist** — both return **404** (no enumeration leak).
- `runs.user_id` is **denormalized** as defense-in-depth, and history routes **404 for anonymous
  callers** (the feature doesn't exist without an identity). SQL is fully parameterized;
  substring search escapes LIKE wildcards.
- Storage sits behind a swappable **`HistoryStore`** interface (mirroring `SandboxBackend`): an
  in-memory oracle backs tests, `PostgresHistoryStore` backs production; both satisfy one shared
  contract suite.

These invariants (**INV-1…8**) are proven by an **adversarial cross-user battery** run against
*both* stores in `backend/tests/history/isolation.test.ts`, including a **planted-hole regression**
(`historyMutants.ts`) that fails if any owner filter is ever dropped — the same mutation-testing
approach used for the auth gate.

## Security posture

> ⚠️ **This is a local learning build, not production-ready.** The sandbox itself is solid;
> the layers around it are intentionally minimal. Do **not** expose this to untrusted users
> as-is.

**Hardened (verified):** the per-execution sandbox isolation listed above. Generated code is
passed into the container without mounting any host path, and unsupported languages are
rejected server-side. **Per-user chat history is owner-scoped and proven isolated** by the
INV-1…8 battery (see *Per-user chat history* above). The frontend also sends a strict
Content-Security-Policy (`script-src
'self'` — no inline/eval, framing denied, network egress limited to the backend API and the
Auth0 tenant) to limit XSS, since the access token lives in JS memory; the dev server relaxes
it just enough for HMR.

**Rate limiting.** Every `/api/execute` is charged against a per-user quota keyed on the verified
`sub` — Redis-backed, so the limit holds across instances and survives a restart — and the check
runs *before* any Anthropic call, so a refusal costs nothing. Over-quota returns **429** with
`Retry-After`. Concurrent sandbox executions are capped per instance; excess is refused with
**503** rather than queued, because a caller at the cap is inside its own allowance and is being
refused by other users' load. If Redis is unreachable the quota **fails open** and alarms — safe
only because the concurrency cap still bounds the host. The backend refuses to start without
`REDIS_URL` rather than run unprotected. See [ADR-0003](docs/adr/0003-rate-limiting-approach.md).

**Known limitations — close these before any real/multi-tenant deployment:**

- **Authentication is on by default but single-tenant.** `/api/execute` has an OIDC
  bearer-token gate (verifies an access token against the provider's JWKS — signature,
  issuer, audience, expiry, and an `execute:code` scope), and `user_id`/`tenant_id` are
  derived from the verified token claims rather than the request body. The SPA login is wired
  and verified end-to-end; the gate is enforced by default (`AUTH_REQUIRED=true`, set `false`
  only for IdP-less local dev). What's still missing for a real deployment is multi-tenancy.
  See the `OIDC_*` settings below and the auth epic (#9).
- **Rate-limit state is only as good as Redis.** The quota fails open during a Redis outage, so
  Anthropic spend is unbounded for its duration; the sandbox cap still holds. The cap is
  per-instance, which is correct while one backend owns its Docker daemon and wrong if several
  ever share one. See ADR-0003's *Consequences*.
- **Docker socket is mounted into the backend** (`docker-compose.yml`), which is
  root-equivalent control of the host. Acceptable for local dev; in production use a
  restricted socket proxy, or `CloudRunSandboxBackend` (which removes the socket entirely).
- **The GCP environment is destroyed between working sessions, by design.** Memorystore and
  Cloud SQL bill per hour of *existence* and Memorystore cannot be stopped, only deleted, so
  `terraform destroy` is the normal end of a session rather than an end-of-project ritual
  (~CAD 55/month always-on versus ~CAD 3 at ten hours a week). Consequences a reader needs:
  the deployed URL is live only while someone is working, a rebuild takes 15–20 minutes, and
  **`redis-url` must be repopulated before redeploying** — the endpoint is newly allocated on each
  rebuild, and the secret container now survives the teardown holding the *old* value, which boots
  a healthy-looking service whose quota fails open. A full day-91 teardown removes every payload
  instead. See [`docs/runbooks/gcp-teardown.md`](docs/runbooks/gcp-teardown.md).
- **Neither data store is reachable from the internet.** Cloud SQL has a public IP with an empty
  authorized-network list, brokered by the Cloud SQL Auth Proxy and authorised by IAM; Valkey is
  a private PSC endpoint inside the project VPC, so the Cloud Run service reaches it only via
  Direct VPC egress.
- **`SANDBOX_BACKEND=cloudrun` selects a different set of guarantees, and every bullet above
  describes the `docker` default.** The deployed service runs `cloudrun`, so for it three things
  change and none of them is an improvement to gloss over: per-execution memory/CPU/PID caps do
  **not** apply (sandboxes share the instance's allocation), processes inside the sandbox run with
  `sudo` over an ephemeral overlay rather than `CapDrop: ["ALL"]` as uid 1000, and the readable
  filesystem is this application's image, so `/app/dist` and `/app/node_modules` are visible where
  previously only `python:3.12-slim` was. In exchange, egress is denied by default and the metadata
  server — which holds the runtime identity's token — is unreachable. Those last two are the claims
  that matter most, and they are **measured against the deployed service, not inherited** — a raw
  IP connection and the metadata endpoint both return `Network is unreachable`, and a fork bomb's
  detached children are gone by the next execution. The procedure and the recorded run are in
  [`docs/runbooks/gcp-isolation-probes.md`](docs/runbooks/gcp-isolation-probes.md); re-run it after
  every rebuild, because the environment is destroyed between sessions. This note exists so the
  list above is not read as covering both backends.
- **The sandbox inherits no environment at all, `PATH` included.** That is what keeps secrets and
  the metadata server out of it, and it is also why the backend spawns interpreters by absolute
  path (`/usr/bin/python3`): inside a sandbox a bare command name resolves against nothing. A
  bare name passes every local check, because every local shell has a `PATH`, and fails only on
  the deployed service — see #185.
- Internal exception detail is surfaced in some error responses. **TLS:** the deployed service is
  HTTPS-only, terminated by Cloud Run with a managed certificate; the local dev stack is plain
  HTTP, which is why #5 (serve over TLS) stays open for local runs.

These map directly to the Roadmap below. The auth gate is regression-tested in
`backend/tests/` (battery + mutation coverage), and per-user history isolation is likewise
regression-tested (the cross-user INV battery + planted-hole mutants, against both stores); the
[retrospective](docs/design/auth-bypass-agent.md) explains how that testing was arrived at, and
the [ad-hoc security-testing runbook](docs/runbooks/adhoc-auth-security-testing.md) shows how to
drive Claude Code for on-demand discovery testing of the auth gate.

## Production image

`Dockerfile` at the repo root builds the single artifact intended for a hosted environment: the
SPA and the API in one container, one origin, listening on `$PORT`, running non-root, with **no
Docker socket**. The two per-side Dockerfiles remain the dev images `docker compose` uses.

```bash
docker build \
  --build-arg VITE_AUTH0_DOMAIN=<tenant> \
  --build-arg VITE_AUTH0_CLIENT_ID=<client-id> \
  --build-arg VITE_AUTH0_AUDIENCE=<api-audience> \
  -t llm-code-execution:prod .
```

All three build args are **required** — the build fails without them. `VITE_*` values are
inlined at build time, so an image is bound to one environment; built without the Auth0 values
the bundle is valid, the CSP is valid and strict, every check passes, and login is silently
broken. `VITE_API_BASE` is deliberately empty: the API is same-origin here.

## Verification

Each side has a single `verify.sh` that runs everything CI runs — so local and CI can't
drift (CI invokes the same scripts). There are three: backend, frontend, and `infra/`.

- **Backend:** `cd backend && ./verify.sh` — installs deps, runs ESLint + Prettier + Vitest,
  type-checks/builds (`tsc`), and builds three Docker images: the dev backend image, the sandbox
  image, and the repo-root production image — then asserts inside that image that the production
  CSP shipped, that the policy names no plaintext origin, and that the runtime user is not root.
  It begins with `npm audit`, which **fails on high and critical advisories**.
- **Frontend:** `cd frontend && ./verify.sh` — installs deps, runs ESLint + Prettier +
  Vitest, type-checks/builds, builds the frontend Docker image; the same
  `npm audit` gate runs first.
- **Infra:** `cd infra && ./verify.sh` — runs the gate self-tests, then `terraform fmt -check`,
  `init -backend=false`, `validate`, and the repo-specific gates. It needs **no credentials** and
  deliberately runs no `terraform plan`: a plan requires a live project, and planning is a human
  step in [`docs/runbooks/gcp-bootstrap.md`](docs/runbooks/gcp-bootstrap.md).

The audit runs **first, before `npm ci`** — that command executes dependency lifecycle scripts, so
auditing afterwards would let a package with a known install-time vulnerability run before the gate
could reject it. It reads the committed lockfile and needs no `node_modules`. The trade-off is that
a registry outage aborts the pass before the offline checks; reach for a single target then
(`./verify.sh test`). It covers **dev dependencies too** — neither image ships them, but they
execute here and in CI. Moderate and below stay visible in the output and are Dependabot's job; the
threshold and the reasoning live in [`docs/sdlc.md`](docs/sdlc.md).

The backend and frontend scripts accept `SKIP_INSTALL=1` (reuse the current environment) and `SKIP_DOCKER=1`
(host checks only, skip the image build).

CI runs two additional checks that have no local equivalent, because both read pull-request
metadata rather than a working tree. The **`SDLC docs`** job compares a pull request against
its base ref and fails if the change touches the development process (`.claude/skills/**`,
either `verify.sh`, `scripts/**`, or `.github/workflows/**`) without updating
[`docs/sdlc.md`](docs/sdlc.md). The **`PR shape`** job fails a pull request whose body would
close more than one issue — `[multi-child]` in the title is the visible exception. That document
describes how a change gets from an idea to `main` — phases, gates, and how they meet CI.

A fifth workflow, **`Deploy`**, is not a check either and runs on pushes to `main` rather than on
pull requests. It builds the image, deploys a Cloud Run revision that receives **no traffic**,
asserts the deployed service's shape and HTTP surface with `scripts/verify-deployment.sh`, and only
then moves traffic to it — so **merging to `main` now ships a production revision**. It
authenticates with Workload Identity Federation and holds no key. Two things it deliberately does
not do: it will not *create* the service (a new service's first revision takes 100% of traffic and
cannot be verified first, so that stays a human command), and it verifies nothing behind the auth
gate — a real execution, the cross-owner 404 and the quota's 429 all need an authenticated caller
and stay in
[`docs/runbooks/gcp-isolation-probes.md`](docs/runbooks/gcp-isolation-probes.md). See
[`docs/sdlc.md`](docs/sdlc.md) under *Continuous deployment*.

A fourth pull-request workflow, **`Dependabot auto-merge`**, is not a check and gates nothing: on
Dependabot PRs where every dependency is an npm patch or minor bump, it enables GitHub's native
auto-merge, which still waits for all four required checks and for every review thread to be
resolved. Majors are always merged by a human.

The behavioral checks below have been run and pass (✅). Re-run them anytime.

- **Health:** `curl localhost:8000/api/health` → `{"status":"ok"}`.
- ✅ **Happy path:** *"compute the first 20 Fibonacci numbers"* → UI shows generated Python +
  correct stdout; a container is created and removed per run (one new container ID each time).
- ✅ **No-code path:** *"tell me a joke"* → friendly message; **no** container launched.
- ✅ **Isolation checks** (each confirmed contained by the sandbox):
  - network access → fails (`--network none`)
  - reading host paths / writing outside the tmpfs → blocked (read-only FS); `/tmp` is writable
  - infinite loop → killed at `SANDBOX_TIMEOUT_SECONDS` with `timed_out: true` (exit 124)
  - fork bomb → contained by `--pids-limit`

## Roadmap (intentionally out of scope here)

- Auth: backend OIDC token gate and the Auth0 SPA login are both in and verified end-to-end
  (on by default via `AUTH_REQUIRED`); remaining work is multi-tenancy.
- **Rate limiting: shipped** — per-user quota keyed on the verified `sub` plus a sandbox
  concurrency cap (see *Rate limiting* above and ADR-0003). Follow-ups: token-spend accounting
  rather than request counting, and per-tenant limits once multi-tenancy exists.
- **Chat history: shipped** — per-user, isolated, Postgres-backed (see *Per-user chat history*).
  Follow-ups: a retention window / per-user row cap, and richer full-text search (`pg_trgm` or a
  `tsvector` column).
- **GCP deploy: the app is deployed.** `https://app-530312723651.us-central1.run.app` — Cloud Run
  with sandboxes, Cloud SQL and Memorystore for Valkey behind a private VPC. The environment is
  destroyed between working sessions (see the teardown runbook), so that URL is live only while
  someone is working on it. Deploy steps: [`docs/runbooks/gcp-deploy.md`](docs/runbooks/gcp-deploy.md), and a push to `main`
  now deploys automatically — see *Continuous deployment* in [`docs/sdlc.md`](docs/sdlc.md).
- **GCP deploy background: decided, then done.** Cloud Run (not GKE), with untrusted code executed by
  [Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) behind the
  existing `SandboxBackend` seam — egress denied by default and no metadata server, at the cost
  of a preview dependency and the per-execution memory/CPU/PID caps, which are undocumented there
  and which this design does not rely on — one runaway execution can therefore degrade the whole
  instance rather than just itself. See [ADR-0004](docs/adr/0004-hosting-and-sandbox-execution.md) and the
  [spec](docs/specs/2026-08-09-deploy-to-gcp.md). Phases 0–2 have landed, including the isolation
  re-proof against the deployed sandbox
  ([probe runbook](docs/runbooks/gcp-isolation-probes.md)); the rollback drill (#163) is what
  remains. The service itself is **not** in Terraform state, and that is deliberate — see
  [ADR-0005](docs/adr/0005-cloud-run-service-outside-terraform.md).
- Vertex AI for Claude (swap the client in `llm.ts`), more languages, artifact/chart return.
