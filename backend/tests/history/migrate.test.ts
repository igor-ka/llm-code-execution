/**
 * Migration-runner tests, in two halves.
 *
 * The integration half is gated on DATABASE_URL exactly like pgStore.test.ts, so the DB-free unit
 * run skips it. It proves migrate() is idempotent (running twice is a no-op), creates the history
 * tables, and serializes concurrent runners.
 *
 * The error-reporting half runs everywhere against a fake pool. A real Postgres *can* stage the
 * failure it pins — `pg_terminate_backend` from a second connection does it — but not at a
 * deterministic point in the run, and the interesting instant is the one between a migration
 * failing and its ROLLBACK. The fake puts the break exactly there.
 */
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";

const url = process.env.DATABASE_URL;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** How many migrations SHOULD be in the ledger after a full run — derived, never hardcoded. */
const migrationCount = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length;

/**
 * Every table this application owns. Kept explicit on purpose.
 *
 * `DROP SCHEMA public CASCADE` would be tidier and would survive new migrations automatically,
 * but this reset runs against whatever `DATABASE_URL` points at — a cascade would destroy
 * unrelated objects in a shared or local database, which is a much larger blast radius than the
 * problem deserves.
 *
 * **When a migration adds a table, add it here.** That is a real maintenance point: forget it and
 * the reset drops the ledger (so the migration replays) but not its table, and the replay fails
 * with `relation "..." already exists` — a failure that looks like a locking bug and is not.
 * A visible chore beats a quiet risk of deleting someone's data.
 */
const APP_TABLES = "runs, sessions, schema_migrations";

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${APP_TABLES} CASCADE`);
}

(url ? describe : describe.skip)("migrate", () => {
  it("is idempotent and creates the history tables", async () => {
    const pool = makePool(url!);
    try {
      await resetSchema(pool);
      await migrate(pool);
      await migrate(pool); // second run must be a no-op

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN ('sessions','runs','schema_migrations')
           ORDER BY table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        "runs",
        "schema_migrations",
        "sessions",
      ]);

      // Every migration recorded exactly once despite running migrate() twice.
      const rec = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM schema_migrations",
      );
      expect(rec.rows[0].n).toBe(migrationCount);
    } finally {
      await pool.end();
    }
  });

  it("serializes concurrent runners on a fresh database", async () => {
    // Two pools = two sessions = a faithful stand-in for two instances cold-starting together.
    // Without the advisory lock one of these rejects — proven before the fix, with
    // `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` from two
    // concurrent CREATE TABLE sessions.
    //
    // Repeated, because the interleaving is not enforced: both runners must reach the
    // schema_migrations lookup before either commits its DDL. In practice they do — every await
    // yields the event loop — but "in practice" is not a gate, and a single round that happened
    // to serialize itself would go green with the lock removed. Five fresh-database rounds make
    // an accidental pass vanishingly unlikely at no cost to production code.
    const a = makePool(url!);
    const b = makePool(url!);
    try {
      for (let round = 0; round < 5; round++) {
        await resetSchema(a);

        await expect(Promise.all([migrate(a), migrate(b)])).resolves.toBeDefined();

        const rec = await a.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM schema_migrations",
        );
        expect(rec.rows[0].n, `round ${round}`).toBe(migrationCount);
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
});

/** A statement failure. `breaksConnection` models the socket dying, not just SQL being rejected. */
type Failure = { error: Error; breaksConnection?: boolean };

/**
 * A Pool stand-in covering just the surface migrate() touches: connect(), query(), release().
 * `failOn` decides which statements fail, so a test can break the connection at a chosen point.
 *
 * Every successful query answers `rowCount: 0` (so the ledger lookup reports "not yet applied"
 * and the run proceeds) with `unlocked: true` (so the advisory-unlock check stays quiet).
 *
 * **The client is a real EventEmitter, because that is the mechanism under test.** When pg loses
 * a connection it rejects the in-flight query *and* emits `'error'` on the client; Node throws on
 * an unhandled `'error'`, so a client nobody listens to takes the process down. A `migrate()`
 * that forgets that listener therefore fails here rather than passing on a rejected promise.
 *
 * One honest difference: pg emits from its socket handler, where the throw lands as an uncaught
 * exception and exits the process; this fake throws at the call site instead. The gate is the
 * same — no listener means failure — and the real process death was confirmed by hand against a
 * live Postgres with `pg_terminate_backend`.
 */
function fakePool(failOn: (sql: string) => Failure | undefined) {
  const statements: string[] = [];
  class FakeClient extends EventEmitter {
    release = vi.fn();
    query(sql: string): Promise<unknown> {
      statements.push(sql);
      const failure = failOn(sql);
      if (!failure) return Promise.resolve({ rowCount: 0, rows: [{ unlocked: true }] });
      if (failure.breaksConnection) this.emit("error", failure.error);
      return Promise.reject(failure.error);
    }
  }
  const client = new FakeClient();
  return { statements, client, pool: { connect: async () => client } as unknown as Pool };
}

/**
 * Fails the migration body — identified as the statement right after BEGIN, rather than by its
 * text, so this does not break when 001_history.sql is edited or renamed.
 */
function failMigrationBody(bodyError: Error, rollbackFailure?: Failure) {
  let nextIsBody = false;
  return (sql: string): Failure | undefined => {
    if (sql === "BEGIN") {
      nextIsBody = true;
      return undefined;
    }
    if (nextIsBody) {
      nextIsBody = false;
      return { error: bodyError };
    }
    if (sql === "ROLLBACK") return rollbackFailure;
    return undefined;
  };
}

describe("migrate error reporting", () => {
  it("surfaces the migration error even when the connection dies before the rollback", async () => {
    // The real shape: a migration fails on a SQL error, then Postgres restarts / a proxy drops
    // the connection, so the ROLLBACK that follows fails too. Two ways the original error gets
    // lost — an unguarded `await` on the rollback replacing it, and an unhandled 'error' event
    // killing the process outright. This runs before listen(), on the one client holding the
    // advisory lock, so that error is the entire diagnostic for a failed boot.
    const bodyError = new Error('syntax error at or near "CREAT"');
    const { pool } = fakePool(
      failMigrationBody(bodyError, {
        error: new Error("Connection terminated unexpectedly"),
        breaksConnection: true,
      }),
    );

    await expect(migrate(pool)).rejects.toThrow(bodyError);
  });

  it("listens for connection errors on the client it checks out", async () => {
    // States the invariant the test above relies on: pg-pool strips the idle 'error' listener on
    // acquire, so migrate() must attach its own or a dying connection is an uncaught exception.
    const { client, pool } = fakePool(() => undefined);

    await migrate(pool);

    expect(client.listenerCount("error")).toBeGreaterThan(0);
  });

  it("still attempts the rollback when a migration fails", async () => {
    // Guards the fix from degrading into "skip the rollback": swallowing its error must not
    // mean skipping the statement. Here the rollback succeeds and the original error still wins.
    const bodyError = new Error("boom");
    const { statements, pool } = fakePool(failMigrationBody(bodyError));

    await expect(migrate(pool)).rejects.toThrow(bodyError);
    expect(statements).toContain("ROLLBACK");
  });
});
