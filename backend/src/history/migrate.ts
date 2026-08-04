import type { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// migrations/ sits at the backend root. From src/history (tsx/dev/test) or dist/history
// (built) two levels up lands on backend/ (resp. backend/dist -> backend), then migrations.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Apply any *.sql in migrations/ not yet recorded, in filename order, each in its own txn.
 *  Idempotent: already-applied files are skipped via the schema_migrations ledger. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (done.rowCount) continue;
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
