# Production image: the SPA and the API in one container, one origin (docs/specs D9).
#
# The two per-side Dockerfiles remain the DEV images used by docker-compose. This is the only
# artifact intended for a hosted environment: no Docker socket, no dev server, non-root, and it
# listens on $PORT because that is the Cloud Run contract.

# --- Stage 1: build the SPA -------------------------------------------------------------------
FROM node:26-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Vite inlines VITE_* at BUILD time, so a given image is bound to one environment. These are
# public SPA values (PKCE, no client secret), so baking them leaks nothing. VITE_API_BASE is
# deliberately EMPTY: the API is same-origin in this image, and src/apiBase.ts resolves an empty
# value to same-origin rather than falling back to http://localhost:8000.
ARG VITE_API_BASE=""
ARG VITE_AUTH0_DOMAIN=""
ARG VITE_AUTH0_CLIENT_ID=""
ARG VITE_AUTH0_AUDIENCE=""
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN \
    VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID \
    VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE
# Fail the BUILD rather than ship an app that cannot log in. All three values are inlined into the
# bundle and passed straight to Auth0Provider (frontend/src/main.tsx): the domain also drives the
# CSP's connect-src and frame-src, the client ID identifies the app, and the audience is what makes
# Auth0 return a JWT the backend can verify instead of an opaque token. Built empty, the bundle is
# valid, the policy is valid and strict, every check passes — and login is broken. staticSite.ts
# makes a MISSING policy fatal but cannot detect a WRONG one, so this is the only catchable point.
# printenv, not `eval "val=\$$v"`: eval expands the value unquoted, so an audience containing a
# space dies with an opaque "not found" instead of the intended message, and one containing `;` or
# backticks would execute at build time.
RUN for v in VITE_AUTH0_DOMAIN VITE_AUTH0_CLIENT_ID VITE_AUTH0_AUDIENCE; do \
      [ -n "$(printenv "$v")" ] || { echo "$v is required: pass --build-arg $v=<value>"; exit 1; }; \
    done
RUN npm run build

# --- Stage 2: compile the backend -------------------------------------------------------------
FROM node:26-slim AS backend
WORKDIR /be
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# --- Stage 3: runtime -------------------------------------------------------------------------
FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production

# python3 lives in the APPLICATION image, which is not obvious and is load-bearing.
#
# A Cloud Run sandbox gets a READ-ONLY VIEW OF THIS CONTAINER'S filesystem — it is not a separate
# image. So the interpreter that runs user code has to be here, or `sandbox do -- python3` fails
# with "command not found": a packaging fault that reads like a sandbox fault.
#
# backend/sandbox-image/ (python:3.12-slim) is now local-only. DockerBackend runs it as a separate
# container, which is exactly the model Cloud Run does not have.
# numpy too, and that is not a nicety: llm.ts tells the model "Only the Python standard library
# plus numpy are available", so generated programs import it freely. backend/sandbox-image/ pins
# the same version for DockerBackend — the two runtimes must agree, or the same prompt succeeds
# locally and fails with ModuleNotFoundError in production.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-numpy \
  && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend /be/dist ./dist
# Migrations are read at runtime (migrate.ts resolves ../../migrations relative to dist/history).
COPY backend/migrations ./migrations
# The SPA, including csp.txt — staticSite.ts refuses to serve without it.
COPY --from=frontend /fe/dist ./public
ENV PUBLIC_DIR=/app/public
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
