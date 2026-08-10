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
  let unlocked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await applyPending(client);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        unlocked = true;
      } catch {
        // Swallowed on purpose: the release below destroys the connection, which ends the
        // session and takes the lock with it. Rethrowing here would mask a real migration error.
      }
    }
  } finally {
    // release(true) DESTROYS the connection instead of returning it to the pool.
    //
    // This matters and is easy to get wrong: an advisory lock taken with pg_advisory_lock is
    // SESSION-scoped, and returning a client to the pool does NOT end its session — node-postgres
    // issues no DISCARD ALL. A client handed back while still holding the lock would keep it for
    // the life of the pool, and the next migrate() on this process would block forever on a lock
    // held by an idle connection three feet away. Destroying is cheap: migrations run once, at
    // boot, on one connection.
    client.release(unlocked ? undefined : true);
  }
}
