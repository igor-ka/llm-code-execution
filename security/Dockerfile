# Test/run image for the auth-security agent. Build context is the REPO ROOT so we can
# import the backend's real `app.auth` (the code under test) via PYTHONPATH.
#   docker build -f security/Dockerfile -t llm-auth-agent:test .
FROM python:3.12-slim

WORKDIR /work

# Deps are pinned loosely to match the backend; kept in one layer for cache friendliness.
RUN pip install --no-cache-dir \
    "anthropic>=0.40" "pyjwt[crypto]>=2.9" "cryptography>=42" "httpx>=0.27" \
    "fastapi>=0.115" "uvicorn[standard]>=0.30" "pydantic>=2.7" "pydantic-settings>=2.3" \
    "pytest>=8.2" "ruff>=0.6"

# Real auth code under test (we only import app.auth/app.config/app.schemas).
COPY backend/ /work/backend/
COPY security/ /work/security/

ENV PYTHONPATH=/work/backend
WORKDIR /work/security

# Default: run the test suite. Override CMD to run the agent (python -m secagent.run).
CMD ["pytest", "-q"]
