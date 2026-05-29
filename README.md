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
frontend/                    React + Vite UI
docker-compose.yml           backend + frontend + one-shot sandbox-image build
```

## Prerequisites

- **Docker** (Desktop or Engine) — required to build/run the sandbox and the compose stack.
  > ⚠️ Docker is **not** currently installed on this machine. Install Docker Desktop
  > (https://www.docker.com/products/docker-desktop/) before running the steps below.
- An **Anthropic API key** from https://console.anthropic.com — this is a *developer* account,
  **separate from a Claude Pro/Max subscription**. Add a small amount of pay-as-you-go credit
  ($5–10 is plenty for this project) and create an API key.

## Setup

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

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

## Verification

- **Health:** `curl localhost:8000/api/health` → `{"status":"ok"}`.
- **Backend unit tests** (no network / no Docker needed):
  ```bash
  cd backend && pip install -e ".[dev]" && pytest
  ```
- **Happy path:** prompt *"compute the first 20 Fibonacci numbers"* → UI shows generated
  Python + correct stdout; `docker ps -a` shows a container was created and removed.
- **No-code path:** prompt *"tell me a joke"* → UI shows a friendly message; **no** container
  is launched.
- **Isolation checks** (run as prompts, confirm the sandbox contains them):
  - network access → fails (`--network none`)
  - reading host paths / writing outside `/tmp` → blocked (read-only FS)
  - infinite loop → killed at `SANDBOX_TIMEOUT_SECONDS` with `timed_out: true`
  - fork bomb → contained by `--pids-limit`

## Roadmap (intentionally out of scope here)

- Auth, multi-tenancy, per-user quotas / rate limiting (seams left in: `tenant_id`/`user_id`
  on the request, limits centralized in `config.py`).
- GCP deploy: a `CloudRunBackend` implementing `SandboxBackend`, or GKE + gVisor.
- Vertex AI for Claude (swap the client in `llm.py`), more languages, session persistence,
  artifact/chart return.
```
