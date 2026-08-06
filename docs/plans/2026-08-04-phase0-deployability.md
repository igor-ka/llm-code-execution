# Phase 0: Deployability Hardening Implementation Plan

**Goal:** Make the app survivable in a multi-instance, container-orchestrated environment —
closing the six defects that only manifest outside a single-container localhost run — without
introducing any GCP dependency.

**Architecture:** Every change here is provider-agnostic and verifiable by the existing
`verify.sh` scripts. Backend work adds four small, single-responsibility modules (`log.ts`,
`shutdown.ts`, `rateLimit.ts`, `semaphore.ts`) wired in at `index.ts`/`server.ts`, plus an
advisory lock inside the existing migration runner. Frontend work moves the Content-Security-Policy
from a Vite-process-only response header into the build output, and replaces the dev-server
production image with an nginx image that serves the built assets and the generated policy.
Nothing in this plan presupposes Cloud Run, Cloud SQL, or Terraform; Phase 1 and Phase 2 build on
top of it.

**Tech Stack:** TypeScript, Node 22, Express 5, `pg`, Vitest + supertest (backend); React 18,
Vite 5, Vitest (frontend); nginx (unprivileged) for the production frontend image.

---

## Why one plan, not six

The skill's scope check asks whether this should be split. It should not. These six items share
one goal (a deploy that boots and stays up), each is small, and three of them interact directly:
graceful shutdown needs the connection pool that the single-pool refactor creates, and both the
shutdown path and the boot path want the structured logger. Splitting would create coordination
overhead with no independent-deliverable benefit. Tasks are ordered so each commit leaves the
tree green.

## Known limitation accepted by this plan

The rate limiter is **in-process**. With N backend instances the effective limit is N× the
configured value. This is deliberate: a shared-store limiter (Redis/Memorystore) is real money and
real ops for a single-user learning app, and Phase 2 caps Cloud Run `--max-instances` precisely so
that N stays small and known. The plan documents this in `README.md` rather than hiding it. If the
app ever gets open signup, this is the first thing to revisit.

---

## File Structure

**Backend — created:**

| File | Responsibility |
| --- | --- |
| `backend/src/log.ts` | Structured log emitter. One function per severity; JSON (Cloud Logging shape) or human-readable text, selected by config. |
| `backend/src/shutdown.ts` | Signal-handling shutdown sequencer: stop accepting connections → run cleanup → exit, with a hard deadline. Pure and injectable so it is testable without real signals. |
| `backend/src/rateLimit.ts` | Fixed-window per-key request counter + the Express middleware that 429s on refusal. |
| `backend/src/semaphore.ts` | Non-blocking counting semaphore (`tryAcquire`/`release`) used to cap concurrent sandbox executions. |
| `backend/tests/log.test.ts` | Logger output shape, both formats. |
| `backend/tests/shutdown.test.ts` | Ordering, idempotency, and hard-deadline force-exit. |
| `backend/tests/rateLimit.test.ts` | Window behaviour, key isolation, disabled mode. |
| `backend/tests/semaphore.test.ts` | Capacity, release, over-release safety. |

**Backend — modified:**

| File | Change |
| --- | --- |
| `backend/src/history/migrate.ts` | Wrap the whole run in a session-level `pg_advisory_lock` on a single client. |
| `backend/src/index.ts` | One pool for migrations *and* the store; inject the store; install the shutdown handler; log via `log.ts`. |
| `backend/src/server.ts` | Mount the rate-limit middleware on `/api/execute`; gate sandbox execution on the semaphore; log via `log.ts`. |
| `backend/src/config.ts` | Add `rateLimitPerMinute`, `maxConcurrentSandboxes`. (`LOG_FORMAT` is deliberately *not* added — see Task 1.) |
| `backend/tests/history/migrate.test.ts` | Add the concurrent-runner regression test. |
| `backend/tests/config.test.ts` | Cover the three new settings. |
| `backend/tests/main.test.ts` | App-level 429 and 503 coverage. |
| `backend/verify.sh` | No change needed (new tests run under the existing `test` target). |

**Frontend — created:**

| File | Responsibility |
| --- | --- |
| `frontend/nginx.conf` | Production server config: port 8080, SPA history fallback, cache policy, CSP include in every `location`. |
| `frontend/Dockerfile.dev` | The existing Vite dev-server image, moved aside for Compose. |
| `frontend/src/cspConf.test.ts` | Unit test for the nginx-snippet builder. |

**Frontend — modified:**

| File | Change |
| --- | --- |
| `frontend/src/csp.ts` | Add `buildCspConf(policy)` — pure string builder for the nginx snippet. |
| `frontend/vite.config.ts` | Add a build-only plugin that emits `nginx-csp.conf` into `dist/`. |
| `frontend/Dockerfile` | Becomes the production nginx image. |
| `frontend/verify.sh` | Assert the built output actually carries a CSP (regression gate for the original bug). |

**Repo root — modified:** `docker-compose.yml` (frontend uses `Dockerfile.dev`), `.env.example`
(three new vars), `README.md` (layout, env, security posture, roadmap).

---

## Task 1: Structured logging

Cloud Logging parses a JSON line on stdout and promotes `severity` and `message` to first-class
fields; anything else becomes structured metadata you can filter on. Without this, every remote log
line is an undifferentiated text blob. Local development keeps human-readable output.

Scope is deliberately tight: this task creates the logger and adopts it at the boot/shutdown path
and the two `console.error` sites in `server.ts`. `cli-migrate.ts` is a developer-facing one-shot
CLI and intentionally keeps plain `console` — it never runs in a container.

**A note on where `LOG_FORMAT` lives.** It is read from `process.env` inside `log.ts` and is
deliberately **not** added to `Settings`. The tempting move is to put it in `config.ts` alongside
everything else, but that produces config that is never read: the logger is a module-level
singleton constructed at import time, long before anything can hand it a `Settings`. Wiring it
properly would mean either a second logger built in `index.ts` (leaving `server.ts` importing the
first one — two loggers, two formats) or a `configureLogger()` mutation step. Neither is worth it.
`config.ts` documents itself as the seam for *per-tenant* overrides, and log format is not
per-tenant. One env var, read in one place.

**Files:**

- Create: `backend/src/log.ts`
- Create: `backend/tests/log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/log.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeLogger } from "../src/log.js";

describe("makeLogger (json)", () => {
  it("emits one JSON line with Cloud Logging's severity/message fields", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.info("backend listening", { port: 8000 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      severity: "INFO",
      message: "backend listening",
      port: 8000,
    });
  });

  it("maps error() to ERROR severity and serializes an Error's message and stack", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.error("history persist failed", { err: new Error("connection refused") });

    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toBe("history persist failed");
    expect(entry.err.message).toBe("connection refused");
    expect(typeof entry.err.stack).toBe("string");
  });

  it("never throws on a circular field value", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => log.warn("odd", { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe("makeLogger (text)", () => {
  it("emits a human-readable line with the fields appended", () => {
    const lines: string[] = [];
    const log = makeLogger("text", (line) => lines.push(line));

    log.info("backend listening", { port: 8000 });

    expect(lines[0]).toBe('INFO  backend listening {"port":8000}');
  });

  it("omits the field suffix when there are no fields", () => {
    const lines: string[] = [];
    const log = makeLogger("text", (line) => lines.push(line));

    log.info("backend listening");

    expect(lines[0]).toBe("INFO  backend listening");
  });
});

describe("default logger", () => {
  it("writes to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { log } = await import("../src/log.js");
    log.info("hello");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/log.test.ts`

Expected: FAIL — `Failed to resolve import "../src/log.js"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/log.ts`:

```ts
/**
 * Structured logging.
 *
 * In a container platform, logs are the only debugger you have. Cloud Logging (and most
 * aggregators) parse a single JSON object per line and promote `severity` and `message` to
 * first-class, filterable fields; everything else becomes structured metadata. Locally that
 * is unreadable, so `text` format stays the default and `LOG_FORMAT=json` opts in.
 *
 * Deliberately dependency-free and tiny: one emit path, injectable sink for tests.
 */

export type LogFormat = "json" | "text";
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

/** Errors do not survive JSON.stringify (message/stack are non-enumerable) — unwrap them. */
function normalize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error ? { message: value.message, stack: value.stack, name: value.name } : value;
  }
  return out;
}

/** A logging call must never take the process down, whatever it was handed. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export function makeLogger(format: LogFormat, sink: (line: string) => void): Logger {
  const emit = (severity: Severity, message: string, fields?: Fields): void => {
    const normalized = fields ? normalize(fields) : {};
    if (format === "json") {
      sink(safeStringify({ severity, message, ...normalized }));
      return;
    }
    const suffix = Object.keys(normalized).length ? ` ${safeStringify(normalized)}` : "";
    sink(`${severity.padEnd(5)} ${message}${suffix}`);
  };

  return {
    debug: (m, f) => emit("DEBUG", m, f),
    info: (m, f) => emit("INFO", m, f),
    warn: (m, f) => emit("WARNING", m, f),
    error: (m, f) => emit("ERROR", m, f),
  };
}

/**
 * Process-wide logger. Everything goes to stdout: Cloud Run captures both streams, and the
 * `severity` field — not the stream — is what drives log-level filtering.
 */
export const log: Logger = makeLogger(
  (process.env.LOG_FORMAT as LogFormat) === "json" ? "json" : "text",
  (line) => console.log(line),
);
```

The `log` singleton reads `process.env` directly rather than `getSettings()`, for two reasons.
First, a logger that imported `config.ts` would create an import cycle the moment `config.ts`
wanted to log. Second, per the note at the top of this task, routing it through `Settings` would
create a value that nothing ever reads.

One consequence to be aware of: because the singleton is built at module-evaluation time, it picks
up repo-root `.env` values only if something imported `config.ts` (which runs `dotenv`) first. In
practice `index.ts` imports `./server.js` → `./config.js` before `./log.js` evaluates, so local dev
works. Nothing in production depends on that ordering, because there `LOG_FORMAT` is a real
environment variable and no `.env` file exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/log.test.ts`

Expected: PASS, all six tests green.

- [ ] **Step 5: Adopt the logger in `server.ts`**

In `backend/src/server.ts`, add to the imports:

```ts
import { log } from "./log.js";
```

Replace line 124:

```ts
          console.error("history persist failed (continuing):", err);
```

with:

```ts
          log.error("history persist failed (continuing)", { err });
```

Replace line 191 (inside the final error handler):

```ts
      console.error(err);
```

with:

```ts
      log.error("unhandled request error", { err });
```

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && ./verify.sh test`

Expected: PASS. (`main.test.ts` asserts response bodies, not log output, so this is a no-op for it.)

- [ ] **Step 7: Format, lint and commit**

```bash
cd backend && npm run format && npm run lint
git add backend/src/log.ts backend/tests/log.test.ts backend/src/server.ts
git commit -m "feat(obs): structured JSON logging for container platforms"
```

---

## Task 2: Advisory-lock the migration runner

**The bug.** `backend/src/index.ts:16` runs `migrate()` at boot. `backend/migrations/001_history.sql:8`
is a bare `CREATE TABLE sessions`. On any platform that starts more than one instance at once, two
processes race: both find the migration unapplied, both execute it, and the loser dies on
`relation "sessions" already exists` (or a duplicate key on `schema_migrations`). A dying container
at boot is a crash loop, which on Cloud Run is a failed deployment. It cannot reproduce locally
because Compose starts exactly one backend.

**The fix.** A session-level `pg_advisory_lock` held across the whole run. The second instance
blocks until the first finishes, then finds every migration applied and does nothing. This requires
restructuring `migrate()` to use one dedicated client throughout — advisory locks are scoped to a
session, so acquiring on a pooled connection and migrating on a different one would not serialize
anything.

**Files:**

- Modify: `backend/src/history/migrate.ts`
- Modify: `backend/tests/history/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `(url ? describe : describe.skip)("migrate", ...)` block in
`backend/tests/history/migrate.test.ts`:

```ts
  it("serializes concurrent runners on a fresh database", async () => {
    // Two pools = two sessions = a faithful stand-in for two instances cold-starting together.
    // Without the advisory lock one of these rejects with `relation "sessions" already exists`.
    const a = makePool(url!);
    const b = makePool(url!);
    try {
      await a.query("DROP TABLE IF EXISTS runs, sessions, schema_migrations CASCADE");

      await expect(Promise.all([migrate(a), migrate(b)])).resolves.toBeDefined();

      const rec = await a.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
      expect(rec.rows[0].n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

This suite is gated on `DATABASE_URL`. Start the Compose Postgres first:

```bash
docker compose up -d postgres
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app \
  npx vitest run --no-file-parallelism tests/history/migrate.test.ts
```

Expected: FAIL on the new test with a Postgres error along the lines of
`relation "sessions" already exists` or `duplicate key value violates unique constraint`.
The pre-existing idempotency test still passes.

If the new test *passes* before the fix, the race did not happen to interleave — re-run it a few
times. It should fail reliably; if it never fails, stop and investigate before continuing, because
the regression gate is worthless otherwise.

- [ ] **Step 3: Write the implementation**

Replace the whole body of `backend/src/history/migrate.ts`:

```ts
import type { Pool, PoolClient } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// migrations/ sits at the backend root. From src/history (tsx/dev/test) or dist/history
// (built) two levels up lands on backend/ (resp. backend/dist -> backend), then migrations.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/**
 * Arbitrary but fixed application-wide key for the migration advisory lock. Any other process
 * using this same number on this database would contend with migrations, so it must not be
 * reused elsewhere.
 */
const MIGRATION_LOCK_KEY = 8410572301199;

/** Apply any *.sql in migrations/ not yet recorded, in filename order, each in its own txn. */
async function applyPending(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (done.rowCount) continue;
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
}

/**
 * Apply pending migrations, serialized across processes.
 *
 * Idempotent: already-applied files are skipped via the schema_migrations ledger. Safe to run
 * concurrently: a session-level advisory lock means a second instance booting at the same moment
 * waits here, then finds nothing to do. Without it, both instances race on `CREATE TABLE` and the
 * loser crashes at boot — invisible locally (one container), fatal on a multi-instance platform.
 *
 * The lock is session-scoped, so every statement must run on this one dedicated client; taking
 * the lock on a pooled connection and migrating on another would serialize nothing.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    held = true;
    await applyPending(client);
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    held = false;
    client.release();
  } catch (err) {
    // Destroy rather than recycle. `client.release()` does NOT issue DISCARD ALL, so a
    // session-level advisory lock survives a plain release and is only freed when the
    // connection actually closes — which would leave every other instance blocked at the
    // lock until an idle timeout. `release(err)` removes the connection from the pool.
    if (held) client.release(err instanceof Error ? err : new Error(String(err)));
    else client.release();
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app \
  npx vitest run --no-file-parallelism tests/history/migrate.test.ts
```

Expected: PASS — both the idempotency test and the new concurrency test.

- [ ] **Step 5: Run the whole integration suite**

```bash
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app ./verify.sh test:integration
```

Expected: PASS — `pgStore`, `migrate`, and `isolation` suites all green.

- [ ] **Step 6: Commit**

```bash
cd backend && npm run format && npm run lint
git add backend/src/history/migrate.ts backend/tests/history/migrate.test.ts
git commit -m "fix(history): serialize migrations with an advisory lock

Two instances cold-starting together both applied 001_history.sql; the loser
crashed on `relation \"sessions\" already exists`, which is a boot crash loop on
any multi-instance platform. Unreproducible under Compose (one container)."
```

---

## Task 3: Graceful shutdown and a single connection pool

**Two problems, one fix.** Container platforms send `SIGTERM` and then `SIGKILL` a few seconds
later. Today nothing handles `SIGTERM`, so in-flight requests are severed mid-response and
Postgres connections are abandoned rather than closed.

Fixing it exposes a second issue: nothing can close the pool, because `server.ts:72` builds it
privately inside `createApp()` and never hands it back. `index.ts` separately builds a *second*
pool just for migrations. So this task also collapses the two pools into one, created in
`index.ts` and injected through the `deps.history` seam that already exists — the lazy path in
`server.ts` stays exactly as-is for tests and for any caller that does not inject.

**Files:**

- Create: `backend/src/shutdown.ts`
- Create: `backend/tests/shutdown.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/shutdown.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeShutdown } from "../src/shutdown.js";

/** A server stand-in whose close() completion we drive by hand. */
function fakeServer() {
  let finish: (() => void) | undefined;
  return {
    closed: 0,
    close(cb?: () => void) {
      this.closed += 1;
      finish = cb;
    },
    complete() {
      finish?.();
    },
  };
}

describe("makeShutdown", () => {
  // NOTE: only the force-exit test uses fake timers. `vi.waitFor` polls on a timer, so pairing
  // it with fake timers in the same test hangs — keep the two techniques in separate tests.
  afterEach(() => vi.useRealTimers());

  it("stops the server, then cleans up, then exits 0", async () => {
    const order: string[] = [];
    const server = fakeServer();
    const exit = vi.fn((code: number) => void order.push(`exit:${code}`));
    const shutdown = makeShutdown({
      server,
      cleanup: async () => void order.push("cleanup"),
      exit,
      log: () => {},
    });

    shutdown("SIGTERM");
    expect(server.closed).toBe(1);
    expect(order).toEqual([]); // cleanup waits for in-flight requests to drain

    server.complete();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(["cleanup", "exit:0"]);
  });

  it("ignores a second signal while already shutting down", async () => {
    const server = fakeServer();
    const cleanup = vi.fn(async () => {});
    const shutdown = makeShutdown({ server, cleanup, exit: vi.fn(), log: () => {} });

    shutdown("SIGTERM");
    shutdown("SIGINT");

    expect(server.closed).toBe(1);
    server.complete();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("force-exits non-zero if the server never finishes closing", () => {
    vi.useFakeTimers(); // synchronous test: safe to fake time, no vi.waitFor here
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({ server, graceMs: 10_000, exit, log: () => {} });

    shutdown("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits 0 when cleanup rejects", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({
      server,
      cleanup: async () => {
        throw new Error("pool already ended");
      },
      exit,
      log: () => {},
    });

    shutdown("SIGTERM");
    server.complete();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/shutdown.test.ts`

Expected: FAIL — `Failed to resolve import "../src/shutdown.js"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/shutdown.ts`:

```ts
/**
 * Graceful shutdown sequencing.
 *
 * Container platforms send SIGTERM and follow it with SIGKILL after a short grace period. The
 * job here is to use that window: stop accepting new connections, let in-flight requests finish,
 * release external resources (the pg pool), and exit cleanly — while guaranteeing we exit *at all*
 * if something hangs, since a stuck process just gets SIGKILLed and looks like a crash.
 *
 * Kept free of `process` and real timers in its core so it is testable without spawning anything.
 */
import type { Fields } from "./log.js";

/** Structural type for `http.Server` — narrow on purpose so tests can pass a stub. */
export interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown;
}

export interface ShutdownOptions {
  server: ClosableServer;
  /** Release external resources. Errors are logged, never fatal. */
  cleanup?: () => Promise<void>;
  /** Hard deadline before we give up waiting for connections to drain. */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: (message: string, fields?: Fields) => void;
}

export function makeShutdown({
  server,
  cleanup,
  graceMs = 10_000,
  exit = (code) => process.exit(code),
  log = () => {},
}: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    // A platform may send SIGTERM more than once, and an impatient operator adds SIGINT on top.
    // Re-entering would double-run cleanup and race two exits.
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown: draining", { signal, graceMs });

    // Belt and braces: if draining stalls, exit under our own power with a non-zero code rather
    // than waiting to be SIGKILLed. unref() so this timer can never hold the loop open by itself.
    const deadline = setTimeout(() => {
      log("shutdown: grace period expired, forcing exit", { signal });
      exit(1);
    }, graceMs);
    if (typeof deadline.unref === "function") deadline.unref();

    server.close(() => {
      void (async () => {
        try {
          await cleanup?.();
        } catch (err) {
          log("shutdown: cleanup failed", { err: err instanceof Error ? err.message : String(err) });
        }
        clearTimeout(deadline);
        log("shutdown: complete", { signal });
        exit(0);
      })();
    });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run tests/shutdown.test.ts`

Expected: PASS — all four tests.

- [ ] **Step 5: Rewrite `index.ts` to use one pool and install the handler**

Replace the entire contents of `backend/src/index.ts`:

```ts
import type { Pool } from "pg";
import { createApp } from "./server.js";
import { getSettings } from "./config.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";
import { PostgresHistoryStore } from "./history/pgStore.js";
import type { HistoryStore } from "./history/store.js";
import { makeShutdown } from "./shutdown.js";
import { log } from "./log.js";

const PORT = 8000;

async function main(): Promise<void> {
  const settings = getSettings();

  // One pool for the process, used for migrations and then handed to the store. Previously
  // migrations opened and closed their own pool and createApp() lazily built a second one that
  // nothing could reach — which left no way to close it on shutdown. Guarded on DATABASE_URL so
  // the anonymous/local mode boots with no Postgres at all.
  let pool: Pool | undefined;
  let history: HistoryStore | undefined;
  if (settings.databaseUrl) {
    pool = makePool(settings.databaseUrl);
    await migrate(pool);
    // History is an authenticated feature; config.historyEnabled already encodes auth-on + DB-set.
    if (settings.historyEnabled) history = new PostgresHistoryStore(pool);
  }

  const server = createApp({ history }).listen(PORT, "0.0.0.0", () => {
    log.info("backend listening", {
      port: PORT,
      historyEnabled: history !== undefined,
      authRequired: settings.authRequired,
    });
  });

  const shutdown = makeShutdown({
    server,
    cleanup: async () => {
      await pool?.end();
    },
    log: (message, fields) => log.info(message, fields),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal: backend failed to start", { err });
  process.exit(1);
});
```

Note `createApp({ history })` with `history === undefined` is exactly equivalent to today's
`createApp()` — `deps.history` is optional and the lazy fallback in `server.ts:70-74` is untouched.

- [ ] **Step 6: Verify the whole suite still passes**

Run: `cd backend && ./verify.sh test`

Expected: PASS. `main.test.ts` constructs `createApp` directly and never touches `index.ts`, so
its behaviour is unchanged.

- [ ] **Step 7: Verify shutdown by hand**

Use Compose rather than `npm run dev`: `docker compose stop` sends SIGTERM to PID 1 of the
container, which is the closest local analogue of what a container platform actually does. (Do not
verify with `pkill -f "tsx watch"` — that signals the *watcher*, not the child process that
installed the handler, so it proves nothing.)

```bash
docker compose up -d --build backend postgres
curl -s localhost:8000/api/health          # -> {"status":"ok"}
docker compose stop backend                # sends SIGTERM, then SIGKILL after its grace period
docker compose logs backend | tail -5
```

Expected in the log tail: a `shutdown: draining` line, then `shutdown: complete`, and an exit with
no stack trace. Confirm the container stopped on its own rather than being killed:

```bash
docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq backend)"   # -> 0
```

An exit code of `137` means SIGKILL won the race — the handler either was not installed or never
finished.

To see the JSON log shape at the same time, add `LOG_FORMAT=json` to the `backend` service's
`environment:` block in `docker-compose.yml` for the duration of this check, then revert it.

- [ ] **Step 8: Commit**

```bash
cd backend && npm run format && npm run lint
git add backend/src/shutdown.ts backend/tests/shutdown.test.ts backend/src/index.ts
git commit -m "feat(runtime): graceful SIGTERM shutdown over a single pg pool"
```

---

## Task 4: Per-principal rate limiting

`/api/execute` is the endpoint that costs money — every call is an Anthropic request plus a
sandbox container. Nothing throttles it today. Exposed to the internet on a credits-only budget,
one runaway client can burn the budget in an afternoon.

The limiter is a fixed window keyed on the verified `sub`, falling back to the request IP for
anonymous mode. Mounted *after* `requirePrincipal` so the key is a verified identity, not a
spoofable header.

**Files:**

- Create: `backend/src/rateLimit.ts`
- Create: `backend/tests/rateLimit.test.ts`
- Modify: `backend/src/config.ts`
- Modify: `backend/tests/config.test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/tests/main.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/rateLimit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeRateLimiter } from "../src/rateLimit.js";

describe("makeRateLimiter", () => {
  it("allows exactly `limit` requests inside a window, then refuses", () => {
    let now = 1_000_000;
    const limiter = makeRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(false);
  });

  it("reports the seconds remaining until the window resets", () => {
    let now = 1_000_000;
    const limiter = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    limiter.check("user-a");
    now += 15_000;
    expect(limiter.check("user-a")).toEqual({ allowed: false, retryAfterSec: 45 });
  });

  it("starts a fresh window once the old one elapses", () => {
    let now = 1_000_000;
    const limiter = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(false);

    now += 60_001;
    expect(limiter.check("user-a").allowed).toBe(true);
  });

  it("tracks each key independently", () => {
    let now = 1_000_000;
    const limiter = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(false);
    expect(limiter.check("user-b").allowed).toBe(true);
  });

  it("is disabled when the limit is 0", () => {
    const limiter = makeRateLimiter({ limit: 0, windowMs: 60_000 });
    for (let i = 0; i < 50; i += 1) expect(limiter.check("user-a").allowed).toBe(true);
  });

  it("evicts elapsed windows so the map cannot grow without bound", () => {
    let now = 1_000_000;
    const limiter = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    for (let i = 0; i < 100; i += 1) limiter.check(`user-${i}`);
    expect(limiter.size()).toBe(100);

    now += 60_001;
    limiter.check("user-fresh");
    expect(limiter.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/rateLimit.test.ts`

Expected: FAIL — `Failed to resolve import "../src/rateLimit.js"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/rateLimit.ts`:

```ts
/**
 * Per-principal request throttling for the endpoints that cost money.
 *
 * Fixed window, in memory, no dependencies. IMPORTANT: the counter is per *process*, so with N
 * instances the effective ceiling is N x limit. That is an accepted trade-off — a shared-store
 * limiter is real infrastructure — and the deployment compensates by capping max instances.
 * Revisit this the moment the app has untrusted signups.
 */
import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";
import type { Principal } from "./auth.js";

export interface RateLimiterOptions {
  /** Requests permitted per window. 0 disables limiting entirely. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
  /** Live key count — exposed for the eviction test. */
  size(): number;
}

export function makeRateLimiter({
  limit,
  windowMs,
  now = Date.now,
}: RateLimiterOptions): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): RateLimitVerdict {
      if (limit <= 0) return { allowed: true, retryAfterSec: 0 };

      const t = now();
      // Drop every window that has elapsed. Without this the map is an unbounded leak keyed on
      // user id — slow, but a leak, and this runs on a long-lived server process.
      for (const [k, w] of windows) {
        if (w.resetAt <= t) windows.delete(k);
      }

      const existing = windows.get(key);
      if (!existing) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }
      if (existing.count < limit) {
        existing.count += 1;
        return { allowed: true, retryAfterSec: 0 };
      }
      return { allowed: false, retryAfterSec: Math.ceil((existing.resetAt - t) / 1000) };
    },

    size(): number {
      return windows.size;
    },
  };
}

/**
 * Express middleware form. Mount AFTER requirePrincipal so the key is the verified `sub`;
 * anonymous mode has no identity to key on, so it falls back to the socket address.
 *
 * CAVEAT for the deployed case: behind a load balancer, `req.ip` is the balancer's address unless
 * Express `trust proxy` is enabled, which collapses every anonymous caller onto one bucket — i.e.
 * a global limit rather than a per-caller one. That is tolerable only because the deployed
 * configuration runs with auth ON, where the key is always the verified `sub` and `req.ip` is
 * never reached. If anonymous mode is ever exposed behind a proxy, set `trust proxy` first.
 */
export function rateLimitMiddleware(limiter: RateLimiter): RequestHandler {
  return (req, res, next) => {
    const principal = res.locals.principal as Principal | undefined;
    const key = principal?.userId ?? req.ip ?? "anonymous";
    const verdict = limiter.check(key);
    if (verdict.allowed) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(verdict.retryAfterSec));
    next(new HttpError(429, "Rate limit exceeded. Please retry shortly."));
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run tests/rateLimit.test.ts`

Expected: PASS — all six tests.

- [ ] **Step 5: Add the setting**

In `backend/src/config.ts`, add to the `Settings` interface after `historyEnabled` (the last
field):

```ts
  rateLimitPerMinute: number; // per verified principal, per instance; 0 disables
```

And in `loadSettings`, after the `historyEnabled` line:

```ts
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 10),
```

Append to `backend/tests/config.test.ts`:

```ts
describe("rateLimitPerMinute", () => {
  it("defaults to 10", () => {
    expect(loadSettings({}).rateLimitPerMinute).toBe(10);
  });

  it("is overridable", () => {
    expect(loadSettings({ RATE_LIMIT_PER_MINUTE: "60" }).rateLimitPerMinute).toBe(60);
  });

  it("accepts 0 to disable", () => {
    expect(loadSettings({ RATE_LIMIT_PER_MINUTE: "0" }).rateLimitPerMinute).toBe(0);
  });
});
```

- [ ] **Step 6: Wire it into `server.ts`**

Add to the imports in `backend/src/server.ts`:

```ts
import { makeRateLimiter, rateLimitMiddleware } from "./rateLimit.js";
```

Inside `createApp`, immediately after the `requirePrincipal` line (currently line 46):

```ts
  // One limiter per app instance, keyed on the verified principal. Mounted only on /api/execute:
  // that is the endpoint that spends Anthropic credit and launches containers. History reads are
  // cheap and stay unthrottled.
  const executeRateLimit = rateLimitMiddleware(
    makeRateLimiter({ limit: settings.rateLimitPerMinute, windowMs: 60_000 }),
  );
```

Then change the `/api/execute` route signature from:

```ts
  app.post("/api/execute", requirePrincipal, async (req, res, next) => {
```

to:

```ts
  app.post("/api/execute", requirePrincipal, executeRateLimit, async (req, res, next) => {
```

- [ ] **Step 7: Add app-level coverage**

Append to `backend/tests/main.test.ts`:

```ts
describe("rate limiting", () => {
  // Every field of GenerationResult is required (schemas.ts:14-19) — omitting language/code
  // fails `tsc -p tsconfig.test.json`, which runs before vitest and would break the whole suite.
  const gen: GenerationResult = {
    shouldExecute: false,
    language: null,
    code: null,
    message: "nope",
  };

  it("429s past the configured per-minute limit and sets Retry-After", async () => {
    const app = createApp({
      settings: openSettings({ RATE_LIMIT_PER_MINUTE: "2" }),
      llm: fakeLlm(gen),
    });

    expect((await request(app).post("/api/execute").send({ prompt: "hi" })).status).toBe(200);
    expect((await request(app).post("/api/execute").send({ prompt: "hi" })).status).toBe(200);

    const limited = await request(app).post("/api/execute").send({ prompt: "hi" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ detail: "Rate limit exceeded. Please retry shortly." });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not throttle when the limit is 0", async () => {
    const app = createApp({
      settings: openSettings({ RATE_LIMIT_PER_MINUTE: "0" }),
      llm: fakeLlm(gen),
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post("/api/execute").send({ prompt: "hi" })).status).toBe(200);
    }
  });
});
```

- [ ] **Step 8: Run the full suite**

Run: `cd backend && ./verify.sh test`

Expected: PASS. Watch for pre-existing `main.test.ts` cases that issue several `/api/execute`
calls against one app instance — the default limit of 10 is generous, but if any suite exceeds it
the fix is to pass `RATE_LIMIT_PER_MINUTE: "0"` in that test's settings, not to raise the default.

- [ ] **Step 9: Commit**

```bash
cd backend && npm run format && npm run lint
git add backend/src/rateLimit.ts backend/tests/rateLimit.test.ts backend/src/config.ts \
        backend/tests/config.test.ts backend/src/server.ts backend/tests/main.test.ts
git commit -m "feat(limits): per-principal rate limit on /api/execute"
```

---

## Task 5: Sandbox concurrency cap

The rate limiter bounds requests *per user*; it does nothing about aggregate load. Ten users at
their limit still means an unbounded number of simultaneous containers. A counting semaphore caps
how many sandbox executions can be in flight at once and rejects the overflow immediately with
503 rather than queueing — a fast, honest refusal beats a request that silently piles up behind a
lock and then times out.

**Files:**

- Create: `backend/src/semaphore.ts`
- Create: `backend/tests/semaphore.test.ts`
- Modify: `backend/src/config.ts`
- Modify: `backend/tests/config.test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/tests/main.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/semaphore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeSemaphore } from "../src/semaphore.js";

describe("makeSemaphore", () => {
  it("grants up to max permits and then refuses", () => {
    const sem = makeSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
  });

  it("frees a permit on release", () => {
    const sem = makeSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });

  it("reports the number in flight", () => {
    const sem = makeSemaphore(3);
    expect(sem.active()).toBe(0);
    sem.tryAcquire();
    sem.tryAcquire();
    expect(sem.active()).toBe(2);
    sem.release();
    expect(sem.active()).toBe(1);
  });

  it("never lets an extra release push the count below zero", () => {
    const sem = makeSemaphore(1);
    sem.release();
    sem.release();
    expect(sem.active()).toBe(0);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
  });

  it("is disabled when max is 0", () => {
    const sem = makeSemaphore(0);
    for (let i = 0; i < 20; i += 1) expect(sem.tryAcquire()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/semaphore.test.ts`

Expected: FAIL — `Failed to resolve import "../src/semaphore.js"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/semaphore.ts`:

```ts
/**
 * Non-blocking counting semaphore.
 *
 * Caps how many sandbox executions run at once. Refusal is immediate rather than queued: under
 * overload a prompt 503 lets the caller retry, whereas a queue converts overload into latency and
 * then into timeouts, with the work still queued behind it. Node is single-threaded, so no
 * locking is needed — the counter is only ever touched between awaits.
 */
export interface Semaphore {
  /** Take a permit if one is free. Returns false when at capacity. */
  tryAcquire(): boolean;
  /** Give a permit back. Always pair with a successful tryAcquire in a `finally`. */
  release(): void;
  active(): number;
}

export function makeSemaphore(max: number): Semaphore {
  let inFlight = 0;

  return {
    tryAcquire(): boolean {
      if (max <= 0) return true; // 0 disables the cap
      if (inFlight >= max) return false;
      inFlight += 1;
      return true;
    },
    release(): void {
      // Clamp rather than trusting callers: a stray release must not manufacture permits.
      if (inFlight > 0) inFlight -= 1;
    },
    active(): number {
      return inFlight;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run tests/semaphore.test.ts`

Expected: PASS — all five tests.

- [ ] **Step 5: Add the setting**

In `backend/src/config.ts`, add to `Settings` after `rateLimitPerMinute`:

```ts
  maxConcurrentSandboxes: number; // in-flight sandbox executions per instance; 0 disables
```

And in `loadSettings`, after the `rateLimitPerMinute` line:

```ts
    maxConcurrentSandboxes: num(env.MAX_CONCURRENT_SANDBOXES, 4),
```

Append to `backend/tests/config.test.ts`:

```ts
describe("maxConcurrentSandboxes", () => {
  it("defaults to 4", () => {
    expect(loadSettings({}).maxConcurrentSandboxes).toBe(4);
  });

  it("is overridable", () => {
    expect(loadSettings({ MAX_CONCURRENT_SANDBOXES: "1" }).maxConcurrentSandboxes).toBe(1);
  });
});
```

- [ ] **Step 6: Wire it into `server.ts`**

Add to the imports:

```ts
import { makeSemaphore } from "./semaphore.js";
```

`SandboxResult` is also needed for the explicit annotation below. It lives in `schemas.ts`, so
extend the existing import on line 14 rather than adding a new one:

```ts
import {
  ExecuteRequest,
  messageResponse,
  resultResponse,
  type SandboxResult,
} from "./schemas.js";
```

Inside `createApp`, right after the `executeRateLimit` block from Task 4:

```ts
  // Aggregate guard: the rate limiter bounds each caller, this bounds the whole instance. One
  // container per execution means unbounded concurrency is unbounded host memory.
  const sandboxSlots = makeSemaphore(settings.maxConcurrentSandboxes);
```

Then replace the sandbox execution block (currently lines 151-155):

```ts
      const result = await getSandbox().execute(
        generation.code,
        generation.language,
        limitsFrom(settings),
      );
```

with:

```ts
      if (!sandboxSlots.tryAcquire()) {
        throw new HttpError(503, "Server is at sandbox capacity. Please retry shortly.");
      }
      // Explicitly typed rather than relying on evolving-any across try/finally.
      let result: SandboxResult;
      try {
        result = await getSandbox().execute(
          generation.code,
          generation.language,
          limitsFrom(settings),
        );
      } finally {
        // Must release on the failure path too, or one backend error permanently burns a slot.
        sandboxSlots.release();
      }
```

- [ ] **Step 7: Add app-level coverage**

Append to `backend/tests/main.test.ts`:

```ts
describe("sandbox concurrency cap", () => {
  // All four fields are required — see the note in the rate-limiting suite above.
  const gen: GenerationResult = {
    shouldExecute: true,
    language: "python",
    code: "print(1)",
    message: null,
  };

  /** A sandbox that parks until we let it finish, so we can hold a slot open. */
  function blockingSandbox() {
    let unblock: (() => void) | undefined;
    const box = {
      started: 0,
      async execute(): Promise<SandboxResult> {
        box.started += 1;
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return { stdout: "1", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
      },
      finish() {
        unblock?.();
      },
    };
    return box;
  }

  it("503s once every sandbox slot is in flight, and frees the slot afterwards", async () => {
    const sandbox = blockingSandbox();
    const app = createApp({
      settings: openSettings({ MAX_CONCURRENT_SANDBOXES: "1", RATE_LIMIT_PER_MINUTE: "0" }),
      llm: fakeLlm(gen),
      sandbox: sandbox as unknown as SandboxBackend,
    });

    // `.then()` is what actually dispatches the request: supertest's Test extends a superagent
    // Request, which is a LAZY thenable. Assigning it without .then()/.end() sends nothing, so
    // sandbox.started would stay 0 and the vi.waitFor below would time out.
    const first = request(app)
      .post("/api/execute")
      .send({ prompt: "go" })
      .then((r) => r);
    await vi.waitFor(() => expect(sandbox.started).toBe(1));

    const overflow = await request(app).post("/api/execute").send({ prompt: "go" });
    expect(overflow.status).toBe(503);
    expect(overflow.body).toEqual({ detail: "Server is at sandbox capacity. Please retry shortly." });

    sandbox.finish();
    expect((await first).status).toBe(200);

    // Slot released: a later request now gets in rather than 503ing.
    const after = request(app)
      .post("/api/execute")
      .send({ prompt: "go" })
      .then((r) => r);
    await vi.waitFor(() => expect(sandbox.started).toBe(2));
    sandbox.finish();
    expect((await after).status).toBe(200);
  });
});
```

Add `vi` to the existing `vitest` import at the top of `main.test.ts` if it is not already there:

```ts
import { describe, it, expect, vi } from "vitest";
```

- [ ] **Step 8: Run the full suite**

Run: `cd backend && ./verify.sh test`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd backend && npm run format && npm run lint
git add backend/src/semaphore.ts backend/tests/semaphore.test.ts backend/src/config.ts \
        backend/tests/config.test.ts backend/src/server.ts backend/tests/main.test.ts
git commit -m "feat(limits): cap concurrent sandbox executions per instance"
```

---

## Task 6: Deliver the production CSP with the build

**The bug.** `frontend/src/csp.ts` builds a genuinely strict policy, but `frontend/vite.config.ts:17-23`
only attaches it as a response header from the Vite **dev server** and **preview** server. Both are
Vite processes. A production deploy serves the static `dist/` directory — no Vite, no header, **no
CSP at all**. `csp.test.ts` does not catch this because it tests the policy *builder*, not the
delivery. The result is a silent loss of the app's main XSS defence at exactly the moment it starts
to matter, on a build where the access token lives in JS memory.

A `<meta http-equiv>` tag is not an acceptable fix: `frame-ancestors` is ignored in meta form, so
clickjacking protection would be lost. It has to be a real header, which means the *server* needs
the policy — so the build emits a server config fragment generated from the same `buildCsp()`,
keeping one source of truth.

**Files:**

- Modify: `frontend/src/csp.ts`
- Create: `frontend/src/cspConf.test.ts`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/verify.sh`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/cspConf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCsp, buildCspConf } from "./csp";

describe("buildCspConf", () => {
  it("wraps the policy in an nginx add_header directive", () => {
    expect(buildCspConf("default-src 'self'")).toBe(
      `add_header Content-Security-Policy "default-src 'self'" always;\n`,
    );
  });

  it("uses `always` so the header survives error responses too", () => {
    // Without `always`, nginx omits add_header on 4xx/5xx — an error page would ship no CSP.
    expect(buildCspConf("default-src 'self'")).toContain(" always;");
  });

  it("produces a directive containing the real production policy", () => {
    const policy = buildCsp({
      apiBase: "https://api.example.com",
      auth0Domain: "tenant.us.auth0.com",
      dev: false,
    });
    const conf = buildCspConf(policy);
    expect(conf).toContain("script-src 'self'");
    expect(conf).toContain("frame-ancestors 'none'");
    expect(conf).not.toContain("'unsafe-eval'");
  });

  it("rejects a policy containing a double quote, which would break out of the directive", () => {
    expect(() => buildCspConf('default-src "self"')).toThrow(/double quote/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/cspConf.test.ts`

Expected: FAIL — `buildCspConf` is not exported from `./csp`.

- [ ] **Step 3: Add `buildCspConf` to `csp.ts`**

Append to `frontend/src/csp.ts`:

```ts
/**
 * Render the policy as an nginx directive.
 *
 * The production build is static files; only the server can set a real header, and a real header
 * is required because `frame-ancestors` is ignored in a <meta http-equiv> tag. Generating this
 * from buildCsp() at build time keeps one source of truth — the dev server, the preview server
 * and the deployed image cannot drift apart.
 */
export function buildCspConf(policy: string): string {
  if (policy.includes('"')) {
    // The directive is double-quoted; a double quote in the policy would terminate it early and
    // produce a config that either fails to parse or silently truncates the policy.
    throw new Error("CSP policy must not contain a double quote");
  }
  return `add_header Content-Security-Policy "${policy}" always;\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/cspConf.test.ts`

Expected: PASS — all four tests.

- [ ] **Step 5: Emit the file during `vite build`**

Replace the contents of `frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp, buildCspConf } from "./src/csp";

/**
 * Emit the production CSP as an nginx config fragment alongside the bundle.
 *
 * Without this the policy exists only as a header set by the Vite dev/preview servers, so a
 * static deploy of dist/ ships with no CSP whatsoever. The Dockerfile moves this file out of the
 * web root and includes it from the server config.
 */
function emitCspConf(policy: string): Plugin {
  return {
    name: "emit-csp-conf",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "nginx-csp.conf",
        source: buildCspConf(policy),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const cspOpts = {
    apiBase: env.VITE_API_BASE || "http://localhost:8000",
    auth0Domain: env.VITE_AUTH0_DOMAIN || "",
  };
  const prodCsp = buildCsp({ ...cspOpts, dev: false });

  return {
    plugins: [react(), emitCspConf(prodCsp)],
    // Dev server gets an HMR-compatible policy; `vite preview` (the production-build
    // serving path) gets the strict one.
    server: {
      port: 5173,
      headers: { "Content-Security-Policy": buildCsp({ ...cspOpts, dev: true }) },
    },
    preview: {
      headers: { "Content-Security-Policy": prodCsp },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: "./src/test/setup.ts",
      css: false,
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/test/**"],
      },
    },
  };
});
```

- [ ] **Step 6: Verify the build emits the file**

```bash
cd frontend && npm run build && cat dist/nginx-csp.conf
```

Expected output (one line):

```
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://localhost:8000; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
```

The exact `connect-src` and `frame-src` values depend on the `VITE_*` values present at build
time; what matters is that the file exists and contains `script-src 'self'`.

- [ ] **Step 7: Add a build-artifact gate to `verify.sh`**

This is the regression gate for the original defect: a unit test can't catch "the deployed server
forgot the header", but a check on the build output can.

In `frontend/verify.sh`, replace the `build()` line:

```bash
build()   { run npm run build; }
```

with:

```bash
build() {
  run npm run build
  # Regression gate: the production CSP must ship with the bundle. It used to exist only as a
  # Vite dev/preview response header, so static deploys silently shipped with no CSP at all.
  run test -f dist/nginx-csp.conf
  run grep -q "script-src 'self'" dist/nginx-csp.conf
}
```

And update the usage comment near the top of the file:

```bash
#   build    tsc -b && vite build (+ assert the production CSP shipped)
```

- [ ] **Step 8: Run the frontend checks**

Run: `cd frontend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh`

Expected: PASS through lint, format, test and build, with the two new `test -f` / `grep` steps
visible in the output.

- [ ] **Step 9: Commit**

```bash
cd frontend && npm run format && npm run lint
git add frontend/src/csp.ts frontend/src/cspConf.test.ts frontend/vite.config.ts frontend/verify.sh
git commit -m "fix(csp): ship the production CSP with the build

The policy was only ever set as a Vite dev/preview response header, so any
static deploy of dist/ served no CSP at all. The build now emits an nginx
fragment from the same buildCsp(), and verify.sh fails if it is missing."
```

---

## Task 7: Production frontend image

`frontend/Dockerfile` currently runs `npm run dev` — the Vite dev server, with `'unsafe-eval'` in
its policy, no build optimisation, and a file watcher. It must not be what deploys. This task turns
it into a static nginx image and preserves the dev-server image under `Dockerfile.dev` so
`docker compose up` keeps its HMR workflow.

Two details that matter for any container platform: the server listens on **8080** (Cloud Run's
default contract) and runs **non-root** via the unprivileged nginx image, matching the project's
existing posture.

**Files:**

- Create: `frontend/Dockerfile.dev`
- Create: `frontend/nginx.conf`
- Modify: `frontend/Dockerfile`
- Modify: `frontend/verify.sh`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Preserve the dev image**

```bash
git mv frontend/Dockerfile frontend/Dockerfile.dev
```

Then edit the header comment of `frontend/Dockerfile.dev` so it states its role:

```dockerfile
# Frontend DEV image (Vite dev server with HMR) — used by docker-compose for local work.
# The production image is ./Dockerfile, which builds static assets and serves them via nginx.
FROM node:22-slim
```

- [ ] **Step 2: Write the nginx config**

Create `frontend/nginx.conf`:

```nginx
# Production static server for the built SPA.
#
# NOTE ON add_header INHERITANCE: nginx does NOT inherit add_header directives into a location
# block that defines any add_header of its own. Every location that sets a header must therefore
# re-include the CSP, or that location silently serves without one — which is precisely the class
# of bug this whole task exists to fix. Do not "tidy" these includes away.

server {
    # Cloud Run and most container platforms route to 8080 by default.
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Generated at build time from src/csp.ts by the emit-csp-conf Vite plugin.
    include /etc/nginx/csp.conf;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    # Client-side routing: unknown paths must serve the app shell, not a 404.
    location / {
        try_files $uri $uri/ /index.html;
        include /etc/nginx/csp.conf;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
    }

    # The shell must never be cached, or users pin themselves to a stale bundle after a deploy.
    location = /index.html {
        add_header Cache-Control "no-store" always;
        include /etc/nginx/csp.conf;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
    }

    # Vite emits content-hashed filenames, so these are safe to cache forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        include /etc/nginx/csp.conf;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
    }
}
```

- [ ] **Step 3: Write the production Dockerfile**

Create `frontend/Dockerfile`:

```dockerfile
# Production frontend image: build the SPA, serve the static output from nginx.
#
# Vite inlines VITE_* values at BUILD time, so the API base and Auth0 client config are baked
# into the bundle here — a given image is bound to one environment. These are public SPA values
# (no client secret; the SPA uses PKCE), so baking them leaks nothing.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_API_BASE
ARG VITE_AUTH0_DOMAIN
ARG VITE_AUTH0_CLIENT_ID
ARG VITE_AUTH0_AUDIENCE
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN \
    VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID \
    VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE

# The build also emits dist/nginx-csp.conf (see vite.config.ts). Move it out of the bundle so it
# is never served as a static asset — it belongs to the server, not the web root. Doing this in
# the build stage keeps the runtime stage from needing root to write.
RUN npm run build && mv dist/nginx-csp.conf /csp.conf

# Unprivileged nginx: runs as a non-root user and defaults to port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /csp.conf /etc/nginx/csp.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

- [ ] **Step 4: Build and verify the header is actually served**

This is the check that proves the original bug is dead.

```bash
cd frontend
docker build -t llm-frontend:verify .
docker run --rm -d -p 8080:8080 --name csp-check llm-frontend:verify
sleep 2
curl -sI http://localhost:8080/ | grep -i content-security-policy
curl -sI http://localhost:8080/some/spa/route | grep -i content-security-policy
curl -sI http://localhost:8080/index.html | grep -i cache-control
docker rm -f csp-check
```

Expected: the first two `curl`s each print a `content-security-policy:` header containing
`script-src 'self'`; the third prints `cache-control: no-store`. If the second one is empty, the
`add_header` inheritance footgun has bitten — re-check that every `location` re-includes
`/etc/nginx/csp.conf`.

- [ ] **Step 5: Point Compose at the dev image**

In `docker-compose.yml`, change the `frontend` service build block from:

```yaml
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
```

to:

```yaml
  frontend:
    build:
      context: ./frontend
      # Local dev wants HMR, so Compose builds the dev-server image. ./Dockerfile is the
      # production (nginx, static) image that actually deploys.
      dockerfile: Dockerfile.dev
```

- [ ] **Step 6: Build the production image in `verify.sh`**

In `frontend/verify.sh`, replace:

```bash
docker_() { run docker build -t llm-code-execution-frontend:verify .; }
```

with:

```bash
docker_() {
  # The production image is what deploys, so that is what CI must build.
  run docker build -t llm-code-execution-frontend:verify .
  # The dev-server image is what docker-compose builds; keep it from rotting unnoticed.
  run docker build -f Dockerfile.dev -t llm-code-execution-frontend:dev .
}
```

- [ ] **Step 7: Run both verify scripts end to end**

```bash
cd frontend && ./verify.sh
cd ../backend && ./verify.sh
```

Expected: both print their `✓ ... all passed.` line. The backend needs Docker running; if
Postgres is not up, the integration step self-skips with a message, which is expected.

- [ ] **Step 8: Confirm Compose still gives a working dev stack**

```bash
docker compose up --build -d
curl -s localhost:8000/api/health   # -> {"status":"ok"}
curl -sI localhost:5173 | head -1   # -> HTTP/1.1 200 OK
docker compose down
```

- [ ] **Step 9: Commit**

```bash
git add frontend/Dockerfile frontend/Dockerfile.dev frontend/nginx.conf frontend/verify.sh docker-compose.yml
git commit -m "feat(frontend): production nginx image; keep the dev server for Compose

The deployable image was running \`vite dev\`. It now builds static assets and
serves them from unprivileged nginx on 8080 with the generated CSP header."
```

---

## Task 8: Documentation

`CLAUDE.md` requires `README.md` to be updated in the same change whenever commands, layout,
verification steps, security posture or the roadmap move. This change moves four of those five.
The security-posture edit is the important one: "No rate limiting / concurrency cap" is now a
closed item and leaving it listed as an open limitation would mislead the next reader.

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the new settings to `.env.example`**

Insert after the `SANDBOX_MAX_OUTPUT_CHARS` line:

```bash
# --- Request limits (per backend instance) ---
# Per-principal cap on /api/execute, keyed on the verified `sub`. 0 disables. NOTE: this counter
# is per-process, so with N instances the effective ceiling is N x this value.
RATE_LIMIT_PER_MINUTE=10
# Ceiling on simultaneous sandbox executions; excess requests get 503 rather than queueing. 0
# disables.
MAX_CONCURRENT_SANDBOXES=4

# --- Logging ---
# `text` (default) for readable local output; `json` emits one Cloud Logging-shaped object per
# line, which is what you want in any hosted environment. Read directly by src/log.ts, not via
# config.ts — the logger is constructed at import time, before any Settings exist.
LOG_FORMAT=text
```

- [ ] **Step 2: Update the README layout block — additively**

**Do not replace the layout block wholesale.** It already documents the history feature
(`/api/sessions*`, `/api/runs/:id`, `history.ts`, `components/`), and a block replacement would
silently delete accurate documentation. Make four surgical insertions instead.

**(a)** Change only the `index.ts` description line (`README.md:27`), because it now does more:

```
    index.ts                 entrypoint (migrates the history DB, then listens on :8000)
```

becomes:

```
    index.ts                 entrypoint (migrates, serves :8000, drains on SIGTERM)
```

**(b)** Insert four lines immediately after the `errors.ts   HttpError` line, keeping the existing
column alignment:

```
    log.ts                   structured logger (text locally, JSON for log aggregators)
    shutdown.ts              SIGTERM/SIGINT draining + hard-deadline exit
    rateLimit.ts             per-principal fixed-window limiter + Express middleware
    semaphore.ts             concurrency cap for in-flight sandbox executions
```

**(c)** In the `frontend/` block, add `csp.ts` to the `src/` line — keep `history.ts` and
`components/`:

```
  src/                       App.tsx, api.ts, history.ts, csp.ts, components/ (HistorySidebar, SessionView, RunResult)
```

**(d)** Insert three lines after that `src/` line, before `verify.sh`:

```
  nginx.conf                 production static server (port 8080, CSP header, SPA fallback)
  Dockerfile                 production image: vite build + unprivileged nginx
  Dockerfile.dev             dev-server image used by docker-compose (HMR)
```

- [ ] **Step 3: Update the security-posture section**

In **Hardened (verified)**, the CSP sentence currently begins mid-paragraph at `README.md:188`.
Replace this exact text (note it starts with "The frontend also sends", and the line wrapping
matters for an exact match):

```
The frontend also sends a strict
Content-Security-Policy (`script-src
'self'` — no inline/eval, framing denied, network egress limited to the backend API and the
Auth0 tenant) to limit XSS, since the access token lives in JS memory; the dev server relaxes
it just enough for HMR.
```

with:

```
The frontend also sends a strict
Content-Security-Policy (`script-src 'self'` — no inline/eval, framing denied, network egress
limited to the backend API and the Auth0 tenant) to limit XSS, since the access token lives in
JS memory; the dev server relaxes it just enough for HMR. The policy is generated once in
`src/csp.ts` and delivered from that single source three ways: a dev-server header, a
`vite preview` header, and an nginx `add_header` fragment emitted into the production build
(`verify.sh` fails if that fragment is missing).
```

If the exact-match fails because of wrapping, re-read `README.md:186-193` and edit in place —
the substance to add is the final sentence about the three delivery paths.

Then replace the **No rate limiting / concurrency cap** bullet (`README.md:203-204`):

```
- **No rate limiting / concurrency cap.** A burst of requests can exhaust host resources
  (one container each) and API budget. Add per-user quotas + a sandbox concurrency limit.
```

with:

```
- **Rate limiting is per-instance, not global.** `/api/execute` is capped per verified `sub`
  (`RATE_LIMIT_PER_MINUTE`, default 10/min) and in-flight sandbox executions are capped per
  process (`MAX_CONCURRENT_SANDBOXES`, default 4; excess gets a 503 rather than queueing). Both
  counters live in process memory, so with N instances the real ceiling is N x the configured
  value — any deployment must therefore also cap its maximum instance count. A shared-store
  limiter is the fix if this ever takes untrusted signups.
```

- [ ] **Step 4: Update the Verification section**

`README.md:224-225` says the frontend verify "builds the frontend Docker image" — it now builds
two. Replace:

```
- **Frontend:** `cd frontend && ./verify.sh` — installs deps, runs ESLint + Prettier +
  Vitest, type-checks/builds, and builds the frontend Docker image.
```

with:

```
- **Frontend:** `cd frontend && ./verify.sh` — installs deps, runs ESLint + Prettier +
  Vitest, type-checks/builds (asserting the production CSP shipped with the bundle), and builds
  both frontend images: the production nginx one and the dev-server one Compose uses.
```

- [ ] **Step 5: Update the roadmap**

Two bullets move. First, the auth bullet (`README.md:244-246`) lists rate limiting as outstanding;
it is now partly done. Replace:

```
- Auth: backend OIDC token gate and the Auth0 SPA login are both in and verified end-to-end
  (on by default via `AUTH_REQUIRED`); remaining work is multi-tenancy and per-user quotas /
  rate limiting keyed on the verified `sub` (limits centralized in `config.ts`).
```

with:

```
- Auth: backend OIDC token gate and the Auth0 SPA login are both in and verified end-to-end
  (on by default via `AUTH_REQUIRED`). Per-`sub` rate limiting now ships (see *Security
  posture*); remaining work is multi-tenancy and durable per-user quotas that survive a
  restart and are shared across instances.
```

Then replace the GCP deploy bullet (`README.md:250`):

```
- GCP deploy: a `CloudRunBackend` implementing `SandboxBackend`, or GKE + gVisor.
```

with:

```
- GCP deploy: Phase 0 (deployability hardening — migration locking, graceful shutdown, request
  limits, structured logs, a real production frontend image) is done. Next is Terraform for the
  GCP foundation, then a `CloudRunBackend` implementing `SandboxBackend`.
```

- [ ] **Step 6: Verify the README is honest**

Re-read every edited section against the code. Confirm: the quoted defaults (10/min, 4 concurrent)
match `config.ts`; the layout list matches the real tree; the history routes and `components/` are
still documented; and no remaining sentence claims something Phase 0 changed.

```bash
ls backend/src frontend
grep -n "rateLimitPerMinute\|maxConcurrentSandboxes" backend/src/config.ts
grep -n "sessions\|history.ts\|components/" README.md | head
```

The third command must still return the history-feature references — if it does not, the layout
edit was applied as a replacement rather than an insertion. Fix that before committing.

- [ ] **Step 7: Commit**

```bash
git add README.md .env.example
git commit -m "docs: record Phase 0 limits, logging and the production frontend image"
```

---

## Final verification

Run both suites exactly as CI does, from a clean install:

```bash
docker compose up -d postgres
cd backend && ./verify.sh
DATABASE_URL=postgres://app:app@localhost:5432/app ./verify.sh test:integration
cd ../frontend && ./verify.sh
docker compose down
```

Expected: `✓ backend: all passed.` and `✓ frontend: all passed.`

Then confirm the six defects are actually closed:

| # | Defect | Proof |
| --- | --- | --- |
| 1 | Migration race crash-loops on multi-instance boot | `tests/history/migrate.test.ts` concurrent-runner test passes |
| 2 | Production CSP silently absent | `curl -sI` against the built image returns the header on `/` and on an SPA route |
| 3 | Deployable image ran the Vite dev server | `frontend/Dockerfile` is nginx-based; Compose uses `Dockerfile.dev` |
| 4 | No rate limiting | `main.test.ts` 429 case + `Retry-After` |
| 5 | No concurrency cap | `main.test.ts` 503-at-capacity case |
| 6 | Unstructured logs, no graceful shutdown | `LOG_FORMAT=json` emits parseable lines; SIGTERM drains and exits 0 |

## Explicitly out of scope

Named so Phase 1/2 planning does not assume they are done:

- Anything Terraform, GCP, or Cloud Run (Phase 1 and 2).
- `CloudRunJobsBackend` — the `SandboxBackend` interface is unchanged by this plan.
- Shared-store (cross-instance) rate limiting — see the accepted limitation above.
- Replacing the Docker socket in `docker-compose.yml`; local dev keeps `DockerBackend` as-is.
- Auth0 production tenant configuration and any prod origin values.
- Migrating `cli-migrate.ts` to the structured logger — it is a developer CLI, not a service.
