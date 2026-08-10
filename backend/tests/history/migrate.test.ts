/**
 * Migration-runner integration test. Gated on DATABASE_URL exactly like pgStore.test.ts, so
 * the DB-free unit run skips it. Proves migrate() is idempotent (running twice is a no-op),
 * creates the history tables, and serializes concurrent runners.
 */
import { describe, it, expect } from "vitest";
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
 * Reset to an empty database.
 *
 * Dropping the schema rather than a hardcoded table list is deliberate: naming
 * `runs, sessions, schema_migrations` means the day a 002 migration creates a new table, the
 * reset drops the ledger (so 002 replays) but not its table, and the replay fails with
 * `relation "..." already exists` — a failure that looks like a locking bug and is not.
 */
async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
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
