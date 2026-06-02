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

To turn on the `/api/execute` auth gate, also set `AUTH_REQUIRED=true` and the `OIDC_ISSUER`,
`OIDC_AUDIENCE`, and `OIDC_JWKS_URL` values for your provider (see `.env.example`). Left off,
the endpoint stays open — convenient for local dev before login is wired.

## Run (Docker Compose — recommended)

```bash
docker compose up --build
```

This builds the sandbox execution image, starts the backend on
**http://localhost:8000** and the frontend on **http://localhost:5173**. Open the frontend
and try a prompt.

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
npm install
npm run dev
```

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
rejected server-side.

**Known limitations — close these before any real/multi-tenant deployment:**

- **Authentication is implemented but off by default.** `/api/execute` has an OIDC
  bearer-token gate (verifies an access token against the provider's JWKS — signature,
  issuer, audience, expiry, and an `execute:code` scope), and `user_id`/`tenant_id` are now
  derived from the verified token claims rather than the request body. It is gated behind
  `AUTH_REQUIRED` (default `false`) pending the frontend login wiring, so **as shipped the
  endpoint is still open** — set `AUTH_REQUIRED=true` once the SPA sends tokens. See the
  `OIDC_*` settings below and the auth epic (#9).
- **No rate limiting / concurrency cap.** A burst of requests can exhaust host resources
  (one container each) and API budget. Add per-user quotas + a sandbox concurrency limit.
- **Docker socket is mounted into the backend** (`docker-compose.yml`), which is
  root-equivalent control of the host. Acceptable for local dev; in production use a
  restricted socket proxy, or the planned `CloudRunBackend` (which removes the socket entirely).
- Internal exception detail is surfaced in some error responses; HTTP only (no TLS).

These map directly to the Roadmap below. See the in-repo security review notes for detail.

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

- Auth: backend OIDC token gate is in (off by default via `AUTH_REQUIRED`); remaining work is
  the frontend login + flipping it on, then multi-tenancy and per-user quotas / rate limiting
  keyed on the verified `sub` (limits centralized in `config.py`).
- GCP deploy: a `CloudRunBackend` implementing `SandboxBackend`, or GKE + gVisor.
- Vertex AI for Claude (swap the client in `llm.py`), more languages, session persistence,
  artifact/chart return.
```
