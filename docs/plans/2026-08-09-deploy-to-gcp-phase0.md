# Phase 0: Deployability Hardening Implementation Plan

**Goal:** Make the app survive a container platform — structured logs, a shutdown that drains,
migrations that tolerate two instances booting together, and a single production artifact that
serves the SPA and the API from one origin — with no GCP dependency anywhere.

**Architecture:** Every change is provider-agnostic and verified by the existing `verify.sh`
scripts. The backend gains two small modules (`log.ts`, `shutdown.ts`) and one serving module
(`staticSite.ts`); `index.ts` becomes a real composition root that owns the Postgres pool and the
Redis client so shutdown can close them, injecting both through the `deps` seam `createApp`
already exposes. The frontend build emits its production CSP as data; the backend reads it at boot
and refuses to serve the SPA without it. A repo-root `Dockerfile` combines the two into one image.

**Tech Stack:** TypeScript, Node 22, Express 5, `pg`, `redis`, Vitest + supertest (backend);
React, Vite, Vitest (frontend); Docker multi-stage build.

**PR boundaries:** six PRs, one child issue each. Child issues are filed once this plan is
approved (`docs/sdlc.md`: children come after the plan), one per row, in this order:

| PR | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Structured logging (`log.ts`), adopted at every non-CLI `console` site | — |
| 2 | Advisory-locked migration runner | — |
| 3 | Composition root owns pool + Redis; graceful `SIGTERM` shutdown; `PORT` from env | PR 1 |
| 4 | The build emits the production CSP; the backend serves the SPA under it | PR 1, PR 3 |
| 5 | Single production image (SPA + API, one origin) | PR 3, PR 4 |
| 6 | ADR-0004 — the hosting decision | — |

PRs 1, 2 and 6 are independent and can land in any order. **PR 4 depends on 1 and 3** for reasons
that are easy to miss: Step 11 locates the error handler by the log line PR 1 introduces, and
edits the boot log PR 3 introduces. **PR 4 is one child, not two**, even though "emit the policy"
and "serve under the policy" are separable commits: emitting a file nobody reads is not a
deliverable, and splitting them would leave a merged PR whose only effect is a build artifact with
no consumer.

**Before filing the child issues, rebase onto `main`.** This branch was cut before #80 landed, so
it does not yet carry the `PR shape` workflow that enforces the one-child rule at merge time.

---

## Why Phase 0 is its own plan

The skill's scope check asks whether the requirements should be split. They should — but by
*phase*, not by task. Phase 0 is app-only and produces working, independently valuable software:
after it, the app is deployable *anywhere*, and nothing in it presupposes Cloud Run, Cloud SQL, or
Terraform. Phases 1–3 from [the spec](../specs/2026-08-09-deploy-to-gcp.md) (D3) get their own
plans, written when their turn comes, so Terraform learning stays isolated from app debugging.

**This supersedes the unmerged draft** at commit `6b2bdba`
(`docs/plans/2026-08-04-phase0-deployability.md`, branch `worktree-phase0-deployability`). That
draft's Tasks 4 and 5 built an in-process rate limiter and semaphore; epic #62 shipped both
properly — Redis-backed quota plus a concurrency-cap decorator — on 2026-08-09. Tasks 1, 2, 3, 6
and 7 there are still sound and this plan reuses their code where it survives review. The draft
branch should be deleted once this lands.

## What changed since the draft

Read this before following any task; it is why the code below differs from `6b2bdba`.

1. **`index.ts` already fails fast on `REDIS_URL`** (`assertRedisConfigured`, `index.ts:13`) and
   already opens a *temporary* migration pool it closes immediately (`index.ts:17-24`).
2. **`createApp` has grown a `deps` seam with six slots** — `settings`, `llm`, `sandbox`,
   `history`, `quota`, `requirePrincipal` (`server.ts:27-34`). Task 3 uses `history` and `quota`
   rather than inventing a new injection point.
3. **There is now a third resource to close on shutdown**: `RedisQuotaStore` holds a connection
   and already exposes `close()` (`redisQuota.ts:152`).
4. **`middleware.test.ts:79` spies on `console.error`.** Task 1 routes that log through the new
   logger, which writes to `console.log`; that test must move with it or it will fail.
5. **Single origin is now a decision** (spec D9), which is why Task 4 serves the SPA from Express
   instead of building the nginx image the draft planned. No nginx, no `Dockerfile.dev` split.

---

## File Structure

**Backend — created**

| File | Responsibility |
| --- | --- |
| `backend/src/log.ts` | Structured log emitter. One function per severity; JSON (Cloud Logging shape) or human text, chosen by `LOG_FORMAT`. |
| `backend/src/shutdown.ts` | Signal sequencer: stop accepting → drain → cleanup → exit, with a hard deadline. No `process`, no real timers in its core, so it is testable. |
| `backend/src/staticSite.ts` | Serve the built SPA with its production CSP, including the history fallback. |
| `backend/tests/log.test.ts` | Output shape, both formats, `Error` unwrapping, circular safety. |
| `backend/tests/shutdown.test.ts` | Ordering, idempotency, hard deadline, cleanup failure. |
| `backend/tests/staticSite.test.ts` | CSP header, asset serving, deep-link fallback, `/api` never swallowed, boot refusal when the policy is missing. |
| `backend/tests/fixtures/public/index.html` | Fixture SPA. |
| `backend/tests/fixtures/public/csp.txt` | Fixture policy. |

**Backend — modified**

| File | Change |
| --- | --- |
| `backend/src/config.ts` | Add `logFormat`, `publicDir`, `port`. |
| `backend/src/history/migrate.ts` | Session-level advisory lock over the whole run, on one dedicated client. |
| `backend/src/index.ts` | Own the pool and the Redis store; inject both; install the shutdown handler; listen on `settings.port`. |
| `backend/src/server.ts` | Log through `log.ts`; mount the static site when `publicDir` is set. |
| `backend/src/limits/middleware.ts` | Fail-open alarm goes through `log.error`. |
| `backend/src/limits/redisQuota.ts` | Connection error goes through `log.error`. |
| `backend/tests/config.test.ts` | Cover the three new settings. |
| `backend/tests/limits/middleware.test.ts` | Spy `console.log`, not `console.error`. |
| `backend/tests/history/migrate.test.ts` | Concurrent-runner regression test. |
| `backend/Dockerfile` | Pin `ENV PORT=8000` so the dev image's `EXPOSE 8000` stays true. |
| `backend/verify.sh` | Build the production image in the `docker` target. |

**Frontend — modified**

| File | Change |
| --- | --- |
| `frontend/vite.config.ts` | Build-only plugin emitting `dist/csp.txt` from the same `buildCsp()`. |
| `frontend/verify.sh` | Assert the built output carries the policy. |

**Repo root — created:** `Dockerfile` (production image), `.dockerignore` (the repo-root build
context — `frontend/.dockerignore` does not apply to it).
**Repo root — modified:** `.env.example` (Task 3), `docker-compose.yml` (Task 3), `README.md`
(Tasks 3, 5, 6), `docs/sdlc.md` (Tasks 4, 5), `docs/adr/0004-*.md` (Task 6).

---

## Task 1: Structured logging

Cloud Logging parses one JSON object per line and promotes `severity` and `message` to
first-class filterable fields; everything else becomes structured metadata. Without this, every
remote log line is an undifferentiated blob and no alert can be built on it — including the
fail-open quota alarm that ADR-0003 S9 calls the only thing between a Redis outage and an
unbounded bill.

Scope is deliberately tight: create the logger, adopt it at the four non-CLI `console` sites.
`cli-migrate.ts` keeps plain `console` — it is a developer one-shot that never runs in a
container.

**Files:**
- Create: `backend/src/log.ts`, `backend/tests/log.test.ts`
- Modify: `backend/src/config.ts`, `backend/tests/config.test.ts`, `backend/src/server.ts`,
  `backend/src/limits/middleware.ts`, `backend/src/limits/redisQuota.ts`,
  `backend/tests/limits/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/log.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeLogger } from "../src/log.js";

describe("makeLogger (json)", () => {
  it("emits one JSON line with Cloud Logging's severity/message fields", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.info("backend listening", { port: 8080 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      severity: "INFO",
      message: "backend listening",
      port: 8080,
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

    log.info("backend listening", { port: 8080 });

    expect(lines[0]).toBe('INFO  backend listening {"port":8080}');
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
 * first-class, filterable fields; everything else becomes structured metadata. Locally that is
 * unreadable, so `text` stays the default and `LOG_FORMAT=json` opts in.
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
      value instanceof Error
        ? { message: value.message, stack: value.stack, name: value.name }
        : value;
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
 *
 * This reads process.env directly rather than getSettings(). That is load-bearing: config.ts
 * imports dotenv, and a logger importing config.ts would create a cycle the moment config.ts
 * wanted to log. `logFormat` still appears in Settings because that is where configuration is
 * documented.
 */
export const log: Logger = makeLogger(
  (process.env.LOG_FORMAT as LogFormat) === "json" ? "json" : "text",
  (line) => console.log(line),
);
```

- [ ] **Step 4: Add `logFormat` to settings**

In `backend/src/config.ts`, add to the `Settings` interface immediately after `historyEnabled`:

```ts
  logFormat: "json" | "text"; // "json" for Cloud Logging ingestion; "text" for humans
```

In `loadSettings`, add to the returned object immediately after `historyEnabled`:

```ts
    logFormat: str(env.LOG_FORMAT, "text") === "json" ? "json" : "text",
```

- [ ] **Step 5: Add the config test**

Append to `backend/tests/config.test.ts` (reuse the imports already at the top of that file):

```ts
describe("logFormat", () => {
  it("defaults to text", () => {
    expect(loadSettings({}).logFormat).toBe("text");
  });

  it("is json when LOG_FORMAT=json", () => {
    expect(loadSettings({ LOG_FORMAT: "json" }).logFormat).toBe("json");
  });

  it("falls back to text for an unrecognized value", () => {
    expect(loadSettings({ LOG_FORMAT: "logfmt" }).logFormat).toBe("text");
  });
});
```

- [ ] **Step 6: Run both test files to verify they pass**

Run: `cd backend && npx vitest run tests/log.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 7: Adopt the logger at the four container-facing sites**

In `backend/src/server.ts`, add to the imports:

```ts
import { log } from "./log.js";
```

Replace line 154:

```ts
          console.error("history persist failed (continuing):", err);
```

with:

```ts
          log.error("history persist failed (continuing)", { err });
```

Replace line 224:

```ts
      console.error(err);
```

with:

```ts
      log.error("unhandled request error", { err });
```

In `backend/src/limits/middleware.ts`, add `import { log } from "../log.js";` and replace the
`console.error(...)` call at line 33 (keeping the comment above it exactly as it is):

```ts
        log.error("quota store unavailable — FAILING OPEN, requests are unmetered", { err });
```

In `backend/src/limits/redisQuota.ts`, add `import { log } from "../log.js";` and replace line 89:

```ts
      log.error("redis client error", { err });
```

- [ ] **Step 8: Move the middleware test's spy onto the new sink**

In `backend/tests/limits/middleware.test.ts`, inside
`it("fails OPEN when the store throws, and says so loudly (D5, S9)")`, replace lines 79-82:

```ts
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(app(broken)).post("/api/execute").send({ prompt: "1" }).expect(200);
    expect(spy).toHaveBeenCalled(); // silence would violate S9
    spy.mockRestore();
```

with:

```ts
    // The alarm now goes through log.ts, whose sink is console.log — severity is a field, not a
    // stream. Left on console.error, this spy would pass vacuously and stop guarding S9 at all.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await request(app(broken)).post("/api/execute").send({ prompt: "1" }).expect(200);
    expect(spy).toHaveBeenCalled(); // silence would violate S9
    expect(String(spy.mock.calls[0]?.[0])).toContain("FAILING OPEN");
    spy.mockRestore();
```

The added assertion is the point of the change: the old test only proved *something* was written
to a stream, which would still pass if the alarm degraded to a debug line.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && ./verify.sh test`

Expected: PASS.

- [ ] **Step 10: Format, lint, commit**

```bash
cd backend && npm run format && npm run lint && cd ..
git add backend/src/log.ts backend/tests/log.test.ts backend/src/config.ts \
        backend/tests/config.test.ts backend/src/server.ts \
        backend/src/limits/middleware.ts backend/src/limits/redisQuota.ts \
        backend/tests/limits/middleware.test.ts
git commit -m "feat(obs): structured JSON logging for container platforms"
```

---

## Task 2: Advisory-lock the migration runner

**The bug.** `index.ts:20` runs `migrate()` at boot and `migrations/001_history.sql` is a bare
`CREATE TABLE`. On any platform that starts more than one instance at once, two processes race:
both find the migration unapplied, both execute it, and the loser dies on
`relation "sessions" already exists`. A dying container at boot is a crash loop, which on Cloud
Run is a failed deployment. It cannot reproduce locally because Compose starts exactly one
backend.

**The fix.** A session-level `pg_advisory_lock` held across the whole run, on one dedicated
client. Advisory locks are session-scoped, so acquiring on a pooled connection and migrating on a
different one would serialize nothing.

**Files:**
- Modify: `backend/src/history/migrate.ts`, `backend/tests/history/migrate.test.ts`

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

```bash
docker compose up -d postgres
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app \
  npx vitest run --no-file-parallelism tests/history/migrate.test.ts
```

Expected: FAIL on the new test with `relation "sessions" already exists` or a duplicate-key
violation. The pre-existing idempotency test still passes.

If the new test *passes* before the fix, the race did not interleave — re-run it a few times. It
should fail reliably; if it never fails, stop and investigate, because the regression gate is
worthless otherwise.

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
 * waits here, then finds nothing to do. Without it, both instances race on CREATE TABLE and the
 * loser crashes at boot — invisible locally (one container), fatal on a multi-instance platform.
 *
 * The lock is session-scoped, so every statement must run on this one dedicated client; taking
 * the lock on a pooled connection and migrating on another would serialize nothing.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await applyPending(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    // Releasing to the pool also drops any session locks if the unlock above never ran.
    client.release();
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

Expected: PASS — `pgStore`, `migrate` and `isolation` suites green.

- [ ] **Step 6: Commit**

```bash
cd backend && npm run format && npm run lint && cd ..
git add backend/src/history/migrate.ts backend/tests/history/migrate.test.ts
git commit -m "fix(history): serialize migrations with an advisory lock"
```

---

## Task 3: Composition root, graceful shutdown, and `PORT`

**Three problems, one task.** Container platforms send `SIGTERM` and follow with `SIGKILL` a few
seconds later; nothing handles it today, so in-flight executions are severed and connections
abandoned. Fixing it exposes the second problem: nothing *can* close those resources, because
`createApp` builds the pg pool (`server.ts:102`) and the Redis client (`server.ts:86`) privately
and never hands them back. The third is trivial but blocking: `index.ts:6` hardcodes port 8000,
and Cloud Run injects `PORT` (8080 by default).

The fix uses seams that already exist: `index.ts` builds the pool, the history store and the
quota store, injects them via `deps`, and owns their lifecycle. The lazy fallbacks in `server.ts`
stay exactly as they are, so every test that calls `createApp()` is unaffected.

**Files:**
- Create: `backend/src/shutdown.ts`, `backend/tests/shutdown.test.ts`
- Modify: `backend/src/index.ts`, `backend/src/config.ts`, `backend/tests/config.test.ts`,
  `backend/Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`

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
  // NOTE: only the force-exit test uses fake timers. vi.waitFor polls on a timer, so pairing it
  // with fake timers in the same test hangs — keep the two techniques in separate tests.
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

  it("defaults to a grace period inside Cloud Run's 10s SIGTERM→SIGKILL window", () => {
    // Pins the intent, not the number: at exactly 10s the force-exit and the platform's kill
    // land together and the timer is decorative. It has to fire while we are still alive.
    vi.useFakeTimers();
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({ server, exit, log: () => {} });

    shutdown("SIGTERM");
    vi.advanceTimersByTime(9_000);
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
 * Container platforms send SIGTERM and follow it with SIGKILL after a short grace period. The job
 * here is to use that window: stop accepting new connections, let in-flight requests finish,
 * release external resources (pg pool, Redis client), and exit cleanly — while guaranteeing we
 * exit *at all* if something hangs, since a stuck process just gets SIGKILLed and looks like a
 * crash.
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
  /**
   * Hard deadline before we give up waiting for connections to drain.
   *
   * Deliberately UNDER the platform's own SIGTERM→SIGKILL window (Cloud Run's is 10s). At
   * exactly 10s this timer and the kill fire together and the force-exit never helps — the
   * process still dies looking like a crash, which is the outcome it exists to prevent.
   */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: (message: string, fields?: Fields) => void;
}

export function makeShutdown({
  server,
  cleanup,
  graceMs = 8_000,
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
          log("shutdown: cleanup failed", {
            err: err instanceof Error ? err.message : String(err),
          });
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

- [ ] **Step 5: Add `port` to settings**

In `backend/src/config.ts`, add to the `Settings` interface after `logFormat`:

```ts
  port: number; // Cloud Run injects PORT; 8080 is its default contract
```

In `loadSettings`, add to the returned object after `logFormat`:

```ts
    port: posInt("PORT", env.PORT, 8080),
```

Append to `backend/tests/config.test.ts`:

```ts
describe("port", () => {
  it("defaults to 8080, the Cloud Run contract", () => {
    expect(loadSettings({}).port).toBe(8080);
  });

  it("takes PORT from the environment", () => {
    expect(loadSettings({ PORT: "3000" }).port).toBe(3000);
  });
});
```

> **Note the port change is user-visible, and Compose alone does not contain it.** The backend
> has listened on 8000 since the Python original. Four things still assume it and only one of
> them is Compose: `README.md:27` states the entrypoint *"listens on :8000"*; the README's
> "run locally without Compose" recipe exports `../.env` and expects 8000; and **both** frontend
> consumers default to it — `frontend/src/api.ts:3` and `frontend/src/history.ts:7`. `.env.example`
> is the odd one out: it has **no `PORT` entry at all**, which is exactly why a host-run backend
> would silently move to 8080 while the SPA kept calling 8000.
>
> Steps 9–11 below pin 8000 in all three places a human touches (Compose, `.env.example`, the
> README) rather than chasing the new default through the frontend.

- [ ] **Step 6: Rewrite `index.ts` as the composition root**

Replace the entire contents of `backend/src/index.ts`:

```ts
import type { Pool } from "pg";
import { createApp } from "./server.js";
import { getSettings, assertRedisConfigured } from "./config.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";
import { PostgresHistoryStore } from "./history/pgStore.js";
import type { HistoryStore } from "./history/store.js";
import { RedisQuotaStore } from "./limits/redisQuota.js";
import { makeShutdown } from "./shutdown.js";
import { log } from "./log.js";

/**
 * Composition root. Everything with a lifecycle is built here and injected, because shutdown has
 * to be able to close it: createApp()'s lazy fallbacks construct a pool and a Redis client that
 * nothing outside the closure can reach. Those fallbacks stay for tests and for callers that do
 * not inject — this file simply wins when it does.
 */
async function main(): Promise<void> {
  const settings = getSettings();
  // Fail fast rather than serve traffic with the budget control absent (ADR-0003 D6).
  // Deliberately here and not in createApp: createApp is the seam every backend test builds on,
  // so a hard Redis dependency there would become a hard dependency of every unit test (S10).
  assertRedisConfigured(settings);

  let pool: Pool | undefined;
  let history: HistoryStore | undefined;
  if (settings.databaseUrl) {
    pool = makePool(settings.databaseUrl);
    await migrate(pool);
    // History is an authenticated feature; historyEnabled already encodes auth-on + DB-set.
    if (settings.historyEnabled) history = new PostgresHistoryStore(pool);
  }

  const quota = new RedisQuotaStore(settings.redisUrl);

  const server = createApp({ settings, history, quota }).listen(settings.port, "0.0.0.0", () => {
    log.info("backend listening", {
      port: settings.port,
      historyEnabled: history !== undefined,
      authRequired: settings.authRequired,
    });
  });

  const shutdown = makeShutdown({
    server,
    cleanup: async () => {
      await quota.close();
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

One thing this changes on purpose: the migration pool is no longer opened and closed. The same
pool now serves migrations *and* the store, which is what makes `pool.end()` on shutdown
meaningful — previously the only pool that outlived boot was the private one inside `createApp`,
which nothing could reach.

- [ ] **Step 7: Verify the whole suite still passes**

Run: `cd backend && ./verify.sh test`

Expected: PASS. `main.test.ts` builds `createApp` directly with fakes and never imports
`index.ts`, so it is unaffected.

- [ ] **Step 8: Verify shutdown by hand — against the built entrypoint, not the watcher**

Build first and run the compiled output. `npm run dev` runs `tsx watch`, and signalling the
watcher does **not** reliably forward SIGTERM to the child process that holds the handler — you
would be testing tsx, not this code.

```bash
docker compose up -d postgres redis
cd backend && npm run build
DATABASE_URL=postgres://app:app@localhost:5432/app REDIS_URL=redis://localhost:6379 \
  AUTH_REQUIRED=false LOG_FORMAT=json PORT=8000 node dist/index.js
```

In a second terminal:

```bash
curl -s localhost:8000/api/health   # -> {"status":"ok"}
pkill -TERM -f "node dist/index.js"
```

Expected in the first terminal: a `shutdown: draining` JSON line, then `shutdown: complete`, and
the process exits on its own with no stack trace. Task 5 Step 3 repeats this against the
production image, which is the check that actually matters.

- [ ] **Step 9: Pin the port in Compose**

In `docker-compose.yml`, add `PORT: "8000"` to the backend service's environment (next to the
existing variables) so the published `8000:8000` mapping keeps working against the new 8080
default.

- [ ] **Step 10: Pin it in `.env.example` and the dev image**

`.env.example` has no `PORT` entry today, so a host-run backend would silently move to 8080 while
both SPA consumers keep calling 8000. Add to `.env.example`, in the section where the other
backend variables live:

```bash
# Port the backend listens on. 8080 is the default because that is Cloud Run's contract; local
# tooling (Compose, the SPA's VITE_API_BASE default) expects 8000, so keep it pinned here.
PORT=8000
```

And in `backend/Dockerfile` — the **dev** image, still used by Compose — make its own default
match what it advertises, so `EXPOSE 8000` stops being a lie the moment the app default moves:

```dockerfile
ENV PORT=8000
EXPOSE 8000
```

(Add the `ENV` line immediately above the existing `EXPOSE 8000`.)

- [ ] **Step 11: Correct the README**

`README.md:27` describes the entrypoint as *"(migrates the history DB, then listens on :8000)"*.
Change it to name the new default and the pin — something like *"listens on `$PORT` (8080 by
default; pinned to 8000 for local work)"*. Check the surrounding layout block and the
"run locally without Compose" recipe for any other bare `:8000` that is now conditional.

- [ ] **Step 12: Commit**

```bash
cd backend && npm run format && npm run lint && cd ..
git add backend/src/shutdown.ts backend/tests/shutdown.test.ts backend/src/index.ts \
        backend/src/config.ts backend/tests/config.test.ts backend/Dockerfile \
        docker-compose.yml .env.example README.md
git commit -m "feat(runtime): graceful SIGTERM shutdown over an owned pool and Redis client"
```

---

## Task 4: Ship the production CSP, and serve the SPA under it

**The bug.** `frontend/src/csp.ts` builds a genuinely strict policy, but `vite.config.ts:17-23`
attaches it only as a response header from the Vite **dev** and **preview** servers — both Vite
processes. A production deploy serves static files: no Vite, no header, **no CSP at all**.
`csp.test.ts` does not catch it because it tests the policy *builder*, not the delivery. That is a
silent loss of the app's main XSS defence on a build where the access token lives in JS memory.

A `<meta http-equiv>` tag is not an acceptable fix: `frame-ancestors` is ignored in meta form, so
clickjacking protection would be lost. It has to be a real header, which means the *server* needs
the policy. Since spec D9 makes the backend that server, the build emits the policy as data and
the backend applies it — one source of truth, and the backend **refuses to serve the SPA without
it**, matching the `REDIS_URL` posture: never run with a security control silently absent.

**Files:**
- Modify: `frontend/vite.config.ts`, `frontend/verify.sh`
- Create: `backend/src/staticSite.ts`, `backend/tests/staticSite.test.ts`,
  `backend/tests/fixtures/public/index.html`, `backend/tests/fixtures/public/csp.txt`
- Modify: `backend/src/config.ts`, `backend/tests/config.test.ts`, `backend/src/server.ts`,
  `backend/src/index.ts`, `docs/sdlc.md`

> **`frontend/verify.sh` is inside the SDLC-docs contract.** `scripts/check-sdlc-sync.sh` watches
> `frontend/verify.sh` alongside `backend/verify.sh`, `.claude/skills/` and `.github/workflows/`,
> so this PR **must** touch `docs/sdlc.md` (Step 4a) or the `SDLC docs` job fails. `[skip-sdlc-sync]`
> would not be honest here — the build target gains two real gates.

- [ ] **Step 1: Emit the policy from the build**

Replace the contents of `frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp } from "./src/csp";

/**
 * Emit the production CSP alongside the bundle.
 *
 * Without this the policy exists only as a header set by the Vite dev/preview servers, so a
 * static deploy of dist/ ships with no CSP whatsoever. The server that hosts dist/ reads this
 * file and sets the header, which keeps buildCsp() the single source of truth.
 */
function emitCsp(policy: string): Plugin {
  return {
    name: "emit-csp",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "csp.txt", source: `${policy}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const auth0Domain = env.VITE_AUTH0_DOMAIN || "";

  // The production policy takes the RAW value, mirroring api.ts's `?? default` exactly. The dev
  // fallback must not leak in here: the production image builds with VITE_API_BASE="" (the API is
  // same-origin), and `"" || "http://localhost:8000"` would bake a plaintext localhost origin
  // into connect-src — shipped in csp.txt, and caught by Task 5's grep as a build defect.
  const prodCsp = buildCsp({ apiBase: env.VITE_API_BASE ?? "", auth0Domain, dev: false });
  // The dev server keeps the convenience fallback; nothing it emits is ever deployed.
  const devCsp = buildCsp({
    apiBase: env.VITE_API_BASE || "http://localhost:8000",
    auth0Domain,
    dev: true,
  });

  return {
    plugins: [react(), emitCsp(prodCsp)],
    // Dev server gets an HMR-compatible policy; `vite preview` (the production-build serving
    // path) gets the strict one.
    server: {
      port: 5173,
      headers: { "Content-Security-Policy": devCsp },
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

- [ ] **Step 2: Verify the build emits it**

```bash
cd frontend && npm run build && cat dist/csp.txt
```

Expected: one line beginning `default-src 'self'; script-src 'self';` and containing
`frame-ancestors 'none'`. The exact `connect-src` depends on the `VITE_*` values present at build
time.

- [ ] **Step 3: Gate it in `frontend/verify.sh`**

This is the regression gate for the original defect: a unit test cannot catch "the deployed server
forgot the header", but a check on the build output can. Replace line 36:

```bash
build()   { run npm run build; }
```

with:

```bash
build() {
  run npm run build
  # Regression gate: the production CSP must ship with the bundle. It used to exist only as a
  # Vite dev/preview response header, so static deploys silently served no CSP at all.
  run test -f dist/csp.txt
  run grep -q "script-src 'self'" dist/csp.txt
}
```

And update the usage comment on line 11:

```bash
#   build    tsc -b && vite build (+ assert the production CSP shipped)
```

- [ ] **Step 4: Run the frontend checks**

Run: `cd frontend && SKIP_INSTALL=1 SKIP_DOCKER=1 ./verify.sh`

Expected: PASS, with the two new `test -f` / `grep` steps visible in the output.

- [ ] **Step 4a: Update `docs/sdlc.md` for the `verify.sh` change**

Required, not optional — see the note under **Files** above. In whatever part of `docs/sdlc.md`
describes what the frontend `build` target covers, add one sentence: the build now emits
`dist/csp.txt` and the target fails if the production policy is missing from it. Do not create a
new section.

- [ ] **Step 5: Create the backend test fixtures**

Create `backend/tests/fixtures/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>fixture SPA</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

Create `backend/tests/fixtures/public/csp.txt` (one line, newline-terminated):

```
default-src 'self'; script-src 'self'; frame-ancestors 'none'
```

- [ ] **Step 6: Write the failing test**

Create `backend/tests/staticSite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCspPolicy, mountStaticSite } from "../src/staticSite.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "public");

function appServing(dir: string) {
  const app = express();
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  mountStaticSite(app, dir);
  return app;
}

describe("readCspPolicy", () => {
  it("reads the policy the build emitted", () => {
    expect(readCspPolicy(fixtures)).toBe(
      "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );
  });

  it("throws when csp.txt is absent, rather than serving without a CSP", () => {
    expect(() => readCspPolicy(join(fixtures, "nope"))).toThrow(/csp\.txt/);
  });
});

describe("mountStaticSite", () => {
  it("serves index.html at the root with the production CSP header", async () => {
    const res = await request(appServing(fixtures)).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("serves a deep link with index.html so client-side routing works", async () => {
    const res = await request(appServing(fixtures)).get("/sessions/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it("never answers an /api path with the SPA", async () => {
    const res = await request(appServing(fixtures)).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it("leaves real API routes alone", async () => {
    const res = await request(appServing(fixtures)).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not serve csp.txt itself — it is server config, not a public asset", async () => {
    const res = await request(appServing(fixtures)).get("/csp.txt");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">'); // fell through to the SPA, not the raw policy
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/staticSite.test.ts`

Expected: FAIL — `Failed to resolve import "../src/staticSite.js"`.

- [ ] **Step 8: Write the implementation**

Create `backend/src/staticSite.ts`:

```ts
/**
 * Serve the built SPA from the API process.
 *
 * Spec D9: one Cloud Run service, one origin. That deletes a class of bug this repo has already
 * hit once — ADR-0003 D7 records that `Retry-After` was invisible to the browser because it is
 * not CORS-safelisted — and it means the API and the app can never disagree about their origin.
 *
 * The CSP is read from the file the frontend build emits rather than rebuilt here: buildCsp()
 * lives in the frontend package and duplicating it would let the two drift. A missing policy is
 * fatal, not a warning — serving the SPA without its CSP is running with a security control
 * silently absent, which is the same failure mode ADR-0003 D6 refuses for REDIS_URL.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read the policy the build emitted. Throws if it is missing or obviously not a prod policy. */
export function readCspPolicy(publicDir: string): string {
  const file = join(publicDir, "csp.txt");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `cannot read ${file} — the SPA build must emit csp.txt (see frontend/vite.config.ts). ` +
        `Refusing to serve the app without its Content-Security-Policy.`,
    );
  }
  const policy = raw.trim();
  if (!policy.includes("script-src 'self'")) {
    throw new Error(`${file} does not contain a production script-src; refusing to serve`);
  }
  return policy;
}

/**
 * Mount static serving + the SPA history fallback. Call this AFTER the API routes and BEFORE the
 * error handler: the fallback answers anything unmatched, so anything mounted later is dead.
 */
export function mountStaticSite(app: Express, publicDir: string): void {
  const policy = readCspPolicy(publicDir);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", policy);
    next();
  });

  // index:false — the fallback below owns "/", so directory indexing would answer it twice.
  const serveAssets = express.static(publicDir, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // csp.txt is server configuration, not a public asset. Skipping it here lets the request
    // fall through to the SPA fallback rather than handing the policy to anyone who asks.
    if (req.path === "/csp.txt") return next();
    return serveAssets(req, res, next);
  });

  const indexHtml = join(publicDir, "index.html");
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Only GET/HEAD reach the SPA; anything else unmatched is a genuine 404/405.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // An unmatched /api path is an API 404, never the SPA. Returning index.html there would turn
    // every client typo into a 200 with HTML, which breaks fetch callers in the most confusing
    // way available.
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(indexHtml);
  });
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd backend && npx vitest run tests/staticSite.test.ts`

Expected: PASS — all seven tests.

- [ ] **Step 10: Add `publicDir` to settings**

In `backend/src/config.ts`, add to the `Settings` interface after `port`:

```ts
  publicDir: string; // absolute path to the built SPA; empty disables SPA serving (dev default)
```

Add `import { resolve } from "node:path";` to the imports at the top of `config.ts`, and in
`loadSettings`, after `port`:

```ts
    // resolve() because res.sendFile() rejects a relative path: left relative, the mistake
    // surfaces as a 500 on every SPA request instead of at the boundary where it was made.
    publicDir: env.PUBLIC_DIR ? resolve(env.PUBLIC_DIR) : "",
```

Append to `backend/tests/config.test.ts`:

```ts
describe("publicDir", () => {
  it("defaults to empty, so the API-only dev topology is unchanged", () => {
    expect(loadSettings({}).publicDir).toBe("");
  });

  it("takes PUBLIC_DIR from the environment", () => {
    expect(loadSettings({ PUBLIC_DIR: "/app/public" }).publicDir).toBe("/app/public");
  });

  it("resolves a relative path, which res.sendFile would otherwise reject at request time", () => {
    expect(loadSettings({ PUBLIC_DIR: "./public" }).publicDir).toBe(resolve("./public"));
  });
});
```

That last test needs `import { resolve } from "node:path";` in the test file too.

- [ ] **Step 11: Mount it in `server.ts`**

In `backend/src/server.ts`, add to the imports:

```ts
import { mountStaticSite } from "./staticSite.js";
```

Find the final error-handling middleware — the last `app.use` in the file, the four-argument one
containing `log.error("unhandled request error", { err })` after PR 1 renamed it — and insert
**immediately before it**, after the history router mount:

```ts
  // Serve the built SPA from this process when one is bundled with it (spec D9, single origin).
  // Must sit after every API route and before the error handler: the fallback inside answers
  // anything unmatched, so a route mounted later would never be reached.
  if (settings.publicDir) mountStaticSite(app, settings.publicDir);
```

Then add `publicDir` to the boot log in `backend/src/index.ts`, so the deployed process states
whether it is serving the SPA — the difference between "the image is wrong" and "the app is
broken" is otherwise invisible:

```ts
    log.info("backend listening", {
      port: settings.port,
      historyEnabled: history !== undefined,
      authRequired: settings.authRequired,
      publicDir: settings.publicDir || null,
    });
```

- [ ] **Step 12: Run the full backend suite**

Run: `cd backend && ./verify.sh test`

Expected: PASS. Existing suites never set `PUBLIC_DIR`, so the branch is off for all of them.

- [ ] **Step 13: Verify end to end by hand**

```bash
cd frontend && VITE_API_BASE= npm run build
cd ../backend
PUBLIC_DIR="$(cd ../frontend/dist && pwd)" REDIS_URL=redis://localhost:6379 \
  AUTH_REQUIRED=false PORT=8000 npm run dev
```

Then:

```bash
curl -sI localhost:8000/ | grep -i content-security-policy
curl -s localhost:8000/api/health
curl -sI localhost:8000/deep/link | head -1   # -> HTTP/1.1 200 OK (the SPA)
```

Expected: a real CSP header on the SPA response, a working health endpoint, and the deep link
answered by the SPA.

- [ ] **Step 14: Commit**

```bash
cd backend && npm run format && npm run lint
cd ../frontend && npm run format && npm run lint
cd ..
git add frontend/vite.config.ts frontend/verify.sh backend/src/staticSite.ts \
        backend/tests/staticSite.test.ts backend/tests/fixtures backend/src/config.ts \
        backend/tests/config.test.ts backend/src/server.ts backend/src/index.ts docs/sdlc.md
git commit -m "fix(csp): emit the production policy at build and serve the SPA under it"
```

---

## Task 5: One production image

Today `frontend/Dockerfile` runs the Vite dev server — `'unsafe-eval'`, a file watcher, no build
optimisation — and `backend/Dockerfile` documents that it "talks to the host Docker daemon". The
deploy needs neither. This task adds a repo-root `Dockerfile` producing the single artifact spec
D9 describes: the built SPA served by the API process, listening on `PORT`, running non-root.

The per-side dev images stay exactly as they are; `docker compose up` is untouched.

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `backend/verify.sh`, `docs/sdlc.md`, `README.md`

- [ ] **Step 1: Write the repo-root `.dockerignore` — first, not last**

Docker reads `.dockerignore` from the **context** root. The context here is the repo root, where
none exists; `frontend/.dockerignore` does not apply. Without this file, `COPY frontend/ ./` in
stage 1 copies the host's `frontend/node_modules` over the freshly-`npm ci`'d tree, and the build
dies on esbuild's platform check (host binaries are darwin-arm64; the image is linux). CI would
not catch it — the `Backend checks` job never installs frontend deps — so this is the
green-in-CI/broken-locally failure mode, in a script whose entire purpose is local/CI parity.

Create `.dockerignore` at the repo root:

```gitignore
# Context root for the production image (see ./Dockerfile). Each stage installs its own deps;
# copying host node_modules over them breaks the build with platform-mismatched binaries.
**/node_modules
**/dist
**/.vite
.git
.github
docs
security
*.md
.env
.env.*
!.env.example
```

- [ ] **Step 2: Write the Dockerfile**

Create `Dockerfile` at the repo root:

```dockerfile
# Production image: the SPA and the API in one container, one origin (see docs/specs D9).
#
# The two per-side Dockerfiles remain the DEV images used by docker-compose. This is the only
# artifact intended for a hosted environment: no Docker socket, no dev server, non-root, and it
# listens on $PORT because that is the Cloud Run contract.

# --- Stage 1: build the SPA -------------------------------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Vite inlines VITE_* at BUILD time, so a given image is bound to one environment. These are
# public SPA values (PKCE, no client secret), so baking them leaks nothing. VITE_API_BASE is
# deliberately EMPTY: the API is same-origin in this image, and api.ts uses `?? default`, which
# keeps an explicit empty string instead of falling back to http://localhost:8000.
ARG VITE_API_BASE=""
ARG VITE_AUTH0_DOMAIN=""
ARG VITE_AUTH0_CLIENT_ID=""
ARG VITE_AUTH0_AUDIENCE=""
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN \
    VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID \
    VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE
# Fail the BUILD rather than ship an app that blocks its own login. The CSP's connect-src and
# frame-src are derived from VITE_AUTH0_DOMAIN; built empty, the policy is still valid, still
# strict, still passes every check — and silently forbids the Auth0 token endpoint and the
# silent-auth iframe. staticSite.ts makes a MISSING policy fatal but cannot detect a WRONG one,
# so this is the only place the mistake is catchable.
RUN test -n "$VITE_AUTH0_DOMAIN" || { \
      echo "VITE_AUTH0_DOMAIN is required: build with --build-arg VITE_AUTH0_DOMAIN=<tenant>"; \
      exit 1; }
RUN npm run build

# --- Stage 2: compile the backend -------------------------------------------------------------
FROM node:22-slim AS backend
WORKDIR /be
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# --- Stage 3: runtime -------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
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
```

- [ ] **Step 3: Build it and check the three things that silently break**

```bash
docker build --build-arg VITE_AUTH0_DOMAIN=tenant.us.auth0.com -t llm-code-execution:prod .
```

The build arg is mandatory — Step 2's assertion fails without it. Any value works for this local
check; it only has to be non-empty.

Then, in order:

```bash
# 1. Nothing may have baked in the localhost API base — not the bundle, and not csp.txt.
#    This is why the production policy uses `?? ""` rather than `|| "http://localhost:8000"`.
docker run --rm llm-code-execution:prod \
  sh -c "grep -rl 'localhost:8000' /app/public || echo 'CLEAN: no localhost baked in'"

# 2. The CSP must have shipped, and must name the Auth0 origin.
docker run --rm llm-code-execution:prod cat /app/public/csp.txt

# 3. It must run as a non-root user.
docker run --rm llm-code-execution:prod id -u   # -> 1000, not 0
```

Expected: `CLEAN: no localhost baked in`; a policy line containing `script-src 'self'` **and**
`https://tenant.us.auth0.com`; uid 1000.

Check 1 is the one that fails loudly if the `?? ""` in Task 4 Step 1 was written as `||` —
`grep` finds the origin inside `csp.txt`, exits 0, and `CLEAN` never prints.

- [ ] **Step 4: Run the image against the local services**

```bash
docker compose up -d postgres redis
docker run --rm -p 8080:8080 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e AUTH_REQUIRED=false \
  -e LOG_FORMAT=json \
  llm-code-execution:prod
```

In a second terminal:

```bash
curl -s localhost:8080/api/health          # -> {"status":"ok"}
curl -sI localhost:8080/ | grep -i content-security-policy
```

Expected: health OK, a real CSP header, and JSON log lines in the first terminal. Stop it with
Ctrl-C and confirm you see `shutdown: draining` then `shutdown: complete` — that is Task 3's work
proving itself in the artifact that will actually be deployed.

- [ ] **Step 5: Add it to `backend/verify.sh`**

The production image is the backend's artifact — it is the backend process that serves the SPA —
so it belongs to that side's script. Replace the `docker_()` function:

```bash
docker_() {
  run docker build -t llm-code-execution-backend:verify .
  run docker build -t llm-sandbox:verify ./sandbox-image
  # The production artifact (repo-root Dockerfile, repo-root context): the SPA and the API in one
  # image. Built here because it is the backend process that serves the SPA.
  #
  # The VITE_AUTH0_DOMAIN placeholder satisfies the Dockerfile's build-time assertion. It proves
  # the WIRING, never the value: a real deploy passes its real tenant, and an image built by this
  # script must never be deployed.
  run docker build -f ../Dockerfile \
    --build-arg VITE_AUTH0_DOMAIN=verify.invalid \
    -t llm-code-execution:verify ..
}
```

No CI change is needed: `.github/workflows/ci.yml` already invokes `./verify.sh docker` as one
step, so the new build runs inside the existing `Backend checks` job and the job-name contract is
untouched.

**State the coupling this creates**, in the PR description and in Step 7's `docs/sdlc.md`
sentence: `Backend checks` now builds the frontend too, so a frontend-only regression fails the
*backend* job, and that job gets slower. That is an acceptable price for having the deployable
artifact built on every PR, but it should be a decision on the record rather than a surprise the
first time someone bisects a red backend job caused by a React change.

- [ ] **Step 6: Run the backend checks**

Run: `cd backend && SKIP_INSTALL=1 ./verify.sh docker`

Expected: three image builds, all green.

- [ ] **Step 7: Update `docs/sdlc.md`**

`backend/verify.sh` is in the SDLC-docs contract's trigger list, so this PR must touch
`docs/sdlc.md` or the `SDLC docs` job fails. Add the production image to wherever that document
describes what `verify.sh docker` covers — two sentences: what the repo-root `Dockerfile` is and
why it exists (single origin, no Docker socket), and the coupling from Step 5 (`Backend checks`
now builds the frontend). Do not invent a new section for it.

- [ ] **Step 8: Update the README**

Per `CLAUDE.md`, the README moves in the same change: add the repo-root `Dockerfile` and
`.dockerignore` to the project layout, and note in the verification section that
`./verify.sh docker` now builds three images.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile .dockerignore backend/verify.sh docs/sdlc.md README.md
git commit -m "feat(deploy): one production image serving the SPA and the API"
```

---

## Task 6: ADR-0004 — the hosting decision

The decision to host on Cloud Run, to execute untrusted code in Cloud Run sandboxes, and to accept
a preview dependency for it is expensive to reverse and currently lives only in a spec. `docs/`
is explicit that decisions belong in `adr/`, permanent and superseded rather than edited.

**Files:**
- Create: `docs/adr/0004-hosting-and-sandbox-execution.md`
- Modify: `README.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0004-hosting-and-sandbox-execution.md`, following the structure of
`docs/adr/0003-rate-limiting-approach.md` exactly (read it first — match its headings, its
Status/Context/Decision/Consequences shape, and its habit of naming rejected options with the
reason each was rejected).

It records, with the reasoning already written in
[the spec](../specs/2026-08-09-deploy-to-gcp.md) — cite, do not paste:

- **D1** Cloud Run, not GKE (rejected: GKE at ~$75–110/mo idle; Terraform is the learning goal,
  Kubernetes is not).
- **D6** Cloud Run sandboxes execute the untrusted code (rejected: Cloud Run Jobs, needing Direct
  VPC egress plus a deny-all firewall at priority > 1000 merely to regain today's `--network
  none`; rejected: Docker on a VM). **Accepted cost: a Pre-GA dependency**, bounded by the
  `SandboxBackend` seam.
- **D7** The per-execution memory, CPU and PID caps do not survive the move; the concurrency cap
  and the wall-clock timeout carry the load, and the gap is documented rather than hidden.
- **D8** Upstash over Memorystore, and what that means for ADR-0003's fail-open path.
- **Status:** `Accepted`. Note that D6 is the entry most likely to need superseding, and that
  superseding means a new ADR, never an edit to this one.

- [ ] **Step 2: Update the README's roadmap line**

The roadmap currently reads *"GCP deploy: a `CloudRunBackend` implementing `SandboxBackend`, or
GKE + gVisor."* Replace it with the decided approach and a link to ADR-0004. Do **not** claim the
deploy has happened — Phase 0 does not deploy anything.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0004-hosting-and-sandbox-execution.md README.md
git commit -m "docs(adr): record the hosting and sandbox-execution decision"
```

---

## Final verification

Run both scripts exactly as CI does, from a clean tree with every service up:

```bash
docker compose up -d postgres redis
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app \
  REDIS_URL=redis://localhost:6379 ./verify.sh
cd ../frontend && ./verify.sh
```

Expected: both green, including the new `csp.txt` gate and the three-image docker target (the
third build passes `--build-arg VITE_AUTH0_DOMAIN=verify.invalid`; a placeholder is enough to
satisfy the assertion, and an image built by `verify.sh` is never deployable).

Then confirm the four Phase 0 outcomes by hand, against the production image rather than the dev
topology:

| Outcome | Check |
| --- | --- |
| Logs are machine-readable | `LOG_FORMAT=json`, boot the image, confirm each line parses as JSON with a `severity` field |
| Shutdown drains | Ctrl-C the running container; see `shutdown: draining` → `shutdown: complete`, exit 0 |
| Migrations tolerate a race | The concurrency test in `migrate.test.ts` passes against a real Postgres |
| One origin, with a CSP | `curl -sI localhost:8080/` shows the policy; the SPA calls `/api/*` relatively |

## Explicitly out of scope

Named so their absence is deliberate, not forgotten:

- **Anything GCP.** No Terraform, no Cloud Run, no Cloud SQL, no `CloudRunSandboxBackend`. Phase 1
  and Phase 2.
- **Replacing `DockerBackend`.** It stays the local backend and stays the default. The new backend
  arrives in Phase 2, behind the same seam.
- **Removing the Docker socket from `docker-compose.yml`.** Local development still uses it; the
  production image simply never gets one.
- **Health/readiness endpoints beyond `/api/health`.** Cloud Run's default TCP probe is enough,
  and a readiness endpoint that lies is worse than none.
- **Request-scoped log correlation.** A trace ID per request is worth having and is not what
  blocks a deploy.
- **Retiring `frontend/Dockerfile`.** It is the dev image; Compose still uses it.
