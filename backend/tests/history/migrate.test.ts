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

  it("serializes concurrent runners on a fresh database", async () => {
    // Two pools = two sessions = a faithful stand-in for two instances cold-starting together.
    // Without the advisory lock one of these rejects with `relation "sessions" already exists`.
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
        await a.query("DROP TABLE IF EXISTS runs, sessions, schema_migrations CASCADE");

        await expect(Promise.all([migrate(a), migrate(b)])).resolves.toBeDefined();

        const rec = await a.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM schema_migrations",
        );
        expect(rec.rows[0].n, `round ${round}`).toBe(1);
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
});
