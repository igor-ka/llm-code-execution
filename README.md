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
  verify.sh                  checks (eslint + prettier + vitest + tsc + docker); +test:integration (Postgres, Redis)
frontend/                    React + Vite UI
  src/                       App.tsx, api.ts, history.ts, components/ (HistorySidebar, SessionView, RunResult)
  verify.sh                  one-command checks (lint + format + vitest + build + docker)
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
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

The `/api/execute` auth gate is **on by default**. Set the `OIDC_ISSUER`, `OIDC_AUDIENCE`,
and `OIDC_JWKS_URL` values for your provider (see `.env.example` and the Auth0 tenant setup
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
`.env.example` tune the limits — see *Rate limiting* under Security posture.

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

## Run locally without Compose

```bash
# 1. Build the sandbox execution image (must match SANDBOX_IMAGE in .env)
docker build -t llm-sandbox:latest backend/sandbox-image

# 2. Backend
cd backend
npm install
export $(grep -v '^#' ../.env | xargs)   # load env
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
   are `VITE_AUTH0_DOMAIN` / `VITE_AUTH0_CLIENT_ID`. For local dev, add `http://localhost:5173`
   to **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**.
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
  restricted socket proxy, or the planned `CloudRunBackend` (which removes the socket entirely).
- Internal exception detail is surfaced in some error responses; HTTP only (no TLS).

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
drift (CI invokes the same scripts).

- **Backend:** `cd backend && ./verify.sh` — installs deps, runs ESLint + Prettier + Vitest,
  type-checks/builds (`tsc`), and builds three Docker images: the dev backend image, the sandbox
  image, and the repo-root production image — then asserts inside that image that the production
  CSP shipped, that the policy names no plaintext origin, and that the runtime user is not root.
- **Frontend:** `cd frontend && ./verify.sh` — installs deps, runs ESLint + Prettier +
  Vitest, type-checks/builds, and builds the frontend Docker image.

Both accept `SKIP_INSTALL=1` (reuse the current environment) and `SKIP_DOCKER=1`
(host checks only, skip the image build).

CI runs two additional checks that have no local equivalent, because both read pull-request
metadata rather than a working tree. The **`SDLC docs`** job compares a pull request against
its base ref and fails if the change touches the development process (`.claude/skills/**`,
either `verify.sh`, `scripts/**`, or `.github/workflows/**`) without updating
[`docs/sdlc.md`](docs/sdlc.md). The **`PR shape`** job fails a pull request whose body would
close more than one issue — `[multi-child]` in the title is the visible exception. That document
describes how a change gets from an idea to `main` — phases, gates, and how they meet CI.

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
- **GCP deploy: decided, not yet done.** Cloud Run (not GKE), with untrusted code executed by
  [Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) behind the
  existing `SandboxBackend` seam — egress denied by default and no metadata server, at the cost
  of a preview dependency and the per-execution memory/CPU/PID caps, which are undocumented there
  and which this design does not rely on — one runaway execution can therefore degrade the whole
  instance rather than just itself. See [ADR-0004](docs/adr/0004-hosting-and-sandbox-execution.md) and the
  [spec](docs/specs/2026-08-09-deploy-to-gcp.md). Phase 0 (deployability hardening) is landing
  now; nothing is hosted yet.
- Vertex AI for Claude (swap the client in `llm.ts`), more languages, artifact/chart return.
