/**
 * Migration-runner tests, in two halves.
 *
 * The integration half is gated on DATABASE_URL exactly like pgStore.test.ts, so the DB-free unit
 * run skips it. It proves migrate() is idempotent (running twice is a no-op), creates the history
 * tables, and serializes concurrent runners.
 *
 * The error-reporting half runs everywhere against a fake pool, because the failure it pins —
 * a broken connection making ROLLBACK reject — cannot be provoked against a healthy Postgres.
 */
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
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

/**
 * A Pool stand-in covering just the surface migrate() touches: connect(), query(), release().
 * `failOn` decides which statements reject, so a test can break the connection at a chosen point.
 *
 * Every successful query answers `rowCount: 0` (so the ledger lookup reports "not yet applied"
 * and the run proceeds) with `unlocked: true` (so the advisory-unlock check stays quiet).
 */
function fakePool(failOn: (sql: string) => Error | undefined) {
  const statements: string[] = [];
  const client = {
    query(sql: string) {
      statements.push(sql);
      const err = failOn(sql);
      return err
        ? Promise.reject(err)
        : Promise.resolve({ rowCount: 0, rows: [{ unlocked: true }] });
    },
    release: vi.fn(),
  };
  return { statements, pool: { connect: async () => client } as unknown as Pool };
}

/**
 * Fails the migration body — identified as the statement right after BEGIN, rather than by its
 * text, so this does not break when 001_history.sql is edited or renamed.
 */
function failMigrationBody(bodyError: Error, rollbackError?: Error) {
  let nextIsBody = false;
  return (sql: string): Error | undefined => {
    if (sql === "BEGIN") {
      nextIsBody = true;
      return undefined;
    }
    if (nextIsBody) {
      nextIsBody = false;
      return bodyError;
    }
    if (sql === "ROLLBACK") return rollbackError;
    return undefined;
  };
}

describe("migrate error reporting", () => {
  it("surfaces the migration error even when the rollback also fails", async () => {
    // The real shape: Postgres restarts or a proxy drops the connection mid-migration, so the
    // migration rejects AND the ROLLBACK that follows rejects. An unguarded `await` on the
    // rollback replaces the original error — and this runs before listen(), on the one client
    // holding the advisory lock, so that error is the entire diagnostic for a failed boot.
    const bodyError = new Error('syntax error at or near "CREAT"');
    const { pool } = fakePool(
      failMigrationBody(bodyError, new Error("Connection terminated unexpectedly")),
    );

    await expect(migrate(pool)).rejects.toThrow(bodyError);
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
