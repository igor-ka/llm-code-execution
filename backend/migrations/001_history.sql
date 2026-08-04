-- Per-user chat history: grouped sessions (1) => runs (N).
-- Every read/write in the store is predicated on user_id; runs.user_id is denormalized
-- as defense-in-depth. Deleting a session cascades its runs.

-- gen_random_uuid() lives in pgcrypto (bundled with modern Postgres images).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,                 -- verified `sub`
  tenant_id   TEXT,                          -- verified `org_id`, nullable
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Primary list query: a user's sessions, most-recently-active first. The unique id
-- tiebreaker matches the store's `ORDER BY updated_at DESC, id DESC` for a deterministic
-- total order and correct pagination.
CREATE INDEX idx_sessions_user_recent ON sessions (user_id, updated_at DESC, id DESC);

CREATE TABLE runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,                 -- denormalized owner (defense-in-depth)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('message','result')),
  message     TEXT,                          -- kind='message'
  language    TEXT,                          -- kind='result' below
  code        TEXT,
  stdout      TEXT,
  stderr      TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  timed_out   BOOLEAN
);
CREATE INDEX idx_runs_session ON runs (session_id, created_at);
CREATE INDEX idx_runs_user ON runs (user_id);
