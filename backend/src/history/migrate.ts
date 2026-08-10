import type { Pool, PoolClient } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "../log.js";

// migrations/ sits at the backend root. From src/history (tsx/dev/test) or dist/history
// (built) two levels up lands on backend/ (resp. backend/dist -> backend), then migrations.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/**
 * Arbitrary but fixed application-wide key for the migration advisory lock. Any other process
 * using this same number on this database would contend with migrations, so it must not be
 * reused elsewhere.
 */
const MIGRATION_LOCK_KEY = 8410572301199;

/**
 * Bound on how long we wait for the lock. `pg_advisory_lock` waits FOREVER by default, and this
 * call happens before the server starts listening — so an unreleased lock means a process that
 * never opens its port, never logs, and never exits. That is a real scenario on the target
 * platform: an instance SIGKILLed mid-migration leaves a server-side backend holding the lock
 * until TCP keepalives reap it, which can be hours. Every replacement instance would hang, with
 * a startup-probe timeout as the only symptom.
 *
 * A timeout converts that silent hang into a diagnosable crash with a real Postgres error. The
 * tradeoff is accepted deliberately: a genuinely slow migration running on another instance can
 * make this one crash and retry, which is noisy but visible — and these migrations are small.
 */
const LOCK_TIMEOUT = "30s";

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
 *
 * **Constraint worth knowing before this meets managed Postgres:** session-level advisory locks
 * do not survive a TRANSACTION-mode connection pooler. Behind PgBouncer in transaction pooling —
 * or Cloud SQL's built-in pooling, which is transaction-mode — lock and unlock can land on
 * different server connections, and two instances would migrate concurrently again with no error
 * to show for it. The unlock result is checked below so that failure is at least loud.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await applyPending(client);
    } finally {
      try {
        const res = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1) AS unlocked",
          [MIGRATION_LOCK_KEY],
        );
        // false means this session did not hold the lock — the signature of a transaction-mode
        // pooler having moved us to a different backend, i.e. migrations are no longer
        // serialized at all. Postgres does not raise for this, so silence would be total.
        if (res.rows[0]?.unlocked === false) {
          log.warn("migration advisory lock was not held by this session at unlock", {
            hint: "a transaction-mode connection pooler breaks session-level advisory locks",
          });
        }
      } catch (err) {
        // Not rethrown: that would mask a real migration error from applyPending. Logged
        // because destroying the connection below is otherwise this path's only trace.
        log.warn("migration advisory unlock failed; dropping the connection to release it", {
          err,
        });
      }
    }
  } finally {
    // release(true) DESTROYS the connection instead of returning it to the pool. Unconditionally,
    // for two reasons.
    //
    // The lock: it is SESSION-scoped, and returning a client to the pool does NOT end its session
    // — node-postgres issues no DISCARD ALL. A client handed back while still holding it would
    // keep it for the life of the pool, and the next migrate() would block on a lock held by an
    // idle connection three feet away.
    //
    // The session state: migration files are arbitrary SQL. A `SET search_path`, `SET role`, temp
    // table or prepared statement in any future migration would otherwise ride this connection
    // back into the pool and affect unrelated queries.
    //
    // Cost is one reconnect, once, at boot.
    client.release(true);
  }
}
