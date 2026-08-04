/**
 * Migration-runner integration test. Gated on DATABASE_URL exactly like pgStore.test.ts, so
 * the DB-free unit run skips it. Proves migrate() is idempotent (running twice is a no-op)
 * and creates the history tables.
 */
import { describe, it, expect } from "vitest";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";

const url = process.env.DATABASE_URL;

(url ? describe : describe.skip)("migrate", () => {
  it("is idempotent and creates the history tables", async () => {
    const pool = makePool(url!);
    try {
      // Start from a clean slate so the ledger assertion is deterministic across reruns.
      await pool.query("DROP TABLE IF EXISTS runs, sessions, schema_migrations CASCADE");
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

      // Exactly one migration recorded despite running migrate() twice.
      const rec = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM schema_migrations",
      );
      expect(rec.rows[0].n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
