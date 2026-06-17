# LLM Code Execution

A web app where you type a prompt, **Claude decides whether code generation makes sense**,
generates the code if it does, and runs it in a **hardened, throwaway sandbox** that can't
affect the host. If the prompt isn't a coding task, you get a friendly message instead of code.

This is a learning project that mirrors an enterprise B2B pattern. The sandbox layer sits
behind a swappable `SandboxBackend` interface so the same OCI image can later run under
**GCP Cloud Run Jobs** (microVM isolation) or **GKE + gVisor** with no app changes.

```
Browser (React) ──POST /api/execute──▶ FastAPI
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
  app/
    main.py                  FastAPI: POST /api/execute, GET /api/health
    config.py                settings + sandbox limits (per-tenant override seam)
    schemas.py               request/response + internal models
    llm.py                   single structured Claude call (judge + generate) w/ prompt caching
    sandbox/
      base.py                SandboxBackend ABC (the GCP-ready seam)
      docker_backend.py      hardened, ephemeral docker run per execution
  sandbox-image/Dockerfile   the minimal, non-root EXECUTION image
  tests/test_llm.py          LLMService parsing/branching (mocked client)
  verify.sh                  one-command checks (ruff + pytest + docker), also run by CI
frontend/                    React + Vite UI
  src/                       App.tsx, api.ts (+ *.test.tsx / *.test.ts unit & component tests)
  verify.sh                  one-command checks (lint + format + vitest + build + docker)
docker-compose.yml           backend + frontend + one-shot sandbox-image build
```

## Prerequisites

- **Docker** (Desktop or Engine) — required to build/run the sandbox and the compose stack.
  Install from https://www.docker.com/products/docker-desktop/ and make sure the engine is
  running (`docker info` succeeds).
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

## Run (Docker Compose — recommended)

```bash
docker compose up --build
```

This builds the sandbox execution image, starts the backend on
**http://localhost:8000** and the frontend on **http://localhost:5173**. Open the frontend
and try a prompt. Because auth is on by default, you'll need the Auth0 setup below (or set
`AUTH_REQUIRED=false` in `.env` for an open local instance).

## Run locally without Compose

```bash
# 1. Build the sandbox execution image (must match SANDBOX_IMAGE in .env)
docker build -t llm-sandbox:latest backend/sandbox-image

# 2. Backend
cd backend
pip install -e ".[dev]"
export $(grep -v '^#' ../.env | xargs)   # load env
uvicorn app.main:app --reload

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

## Security posture

> ⚠️ **This is a local learning build, not production-ready.** The sandbox itself is solid;
> the layers around it are intentionally minimal. Do **not** expose this to untrusted users
> as-is.

**Hardened (verified):** the per-execution sandbox isolation listed above. Generated code is
passed into the container without mounting any host path, and unsupported languages are
rejected server-side. The frontend also sends a strict Content-Security-Policy (`script-src
'self'` — no inline/eval, framing denied, network egress limited to the backend API and the
Auth0 tenant) to limit XSS, since the access token lives in JS memory; the dev server relaxes
it just enough for HMR.

**Known limitations — close these before any real/multi-tenant deployment:**

- **Authentication is on by default but single-tenant.** `/api/execute` has an OIDC
  bearer-token gate (verifies an access token against the provider's JWKS — signature,
  issuer, audience, expiry, and an `execute:code` scope), and `user_id`/`tenant_id` are
  derived from the verified token claims rather than the request body. The SPA login is wired
  and verified end-to-end; the gate is enforced by default (`AUTH_REQUIRED=true`, set `false`
  only for IdP-less local dev). What's still missing for a real deployment is multi-tenancy
  and per-user quotas. See the `OIDC_*` settings below and the auth epic (#9).
- **No rate limiting / concurrency cap.** A burst of requests can exhaust host resources
  (one container each) and API budget. Add per-user quotas + a sandbox concurrency limit.
- **Docker socket is mounted into the backend** (`docker-compose.yml`), which is
  root-equivalent control of the host. Acceptable for local dev; in production use a
  restricted socket proxy, or the planned `CloudRunBackend` (which removes the socket entirely).
- Internal exception detail is surfaced in some error responses; HTTP only (no TLS).

These map directly to the Roadmap below. The auth gate is regression-tested in
`backend/tests/` (battery + mutation coverage); the
[retrospective](docs/design/auth-bypass-agent.md) explains how that testing was arrived at, and
the [ad-hoc security-testing runbook](docs/runbooks/adhoc-auth-security-testing.md) shows how to
drive Claude Code for on-demand discovery testing of the auth gate.

## Verification

Each side has a single `verify.sh` that runs everything CI runs — so local and CI can't
drift (CI invokes the same scripts).

- **Backend:** `cd backend && ./verify.sh` — installs deps, runs `ruff` + `pytest`, and
  builds the backend and sandbox Docker images.
- **Frontend:** `cd frontend && ./verify.sh` — installs deps, runs ESLint + Prettier +
  Vitest, type-checks/builds, and builds the frontend Docker image.

Both accept `SKIP_INSTALL=1` (reuse the current environment) and `SKIP_DOCKER=1`
(host checks only, skip the image build).

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
  (on by default via `AUTH_REQUIRED`); remaining work is multi-tenancy and per-user quotas /
  rate limiting keyed on the verified `sub` (limits centralized in `config.py`).
- GCP deploy: a `CloudRunBackend` implementing `SandboxBackend`, or GKE + gVisor.
- Vertex AI for Claude (swap the client in `llm.py`), more languages, session persistence,
  artifact/chart return.
```
