/**
 * The shared HistoryStore contract suite, run against a REAL Postgres. Gated on
 * DATABASE_URL: the DB-free unit run (npm run test) skips this file; the integration
 * target (verify.sh test:integration) sets DATABASE_URL and exercises it. This proves the
 * Postgres impl satisfies the identical contract — isolation and recency ordering included —
 * that the in-memory oracle does.
 *
 * "Gated on DATABASE_URL" means the SHELL's, pinned by vitest.config.ts. Without that pin the
 * gate leaks: src/config.ts runs dotenv on the repo-root .env at import time, so any test
 * reaching config.ts would create the variable mid-run and this suite would stop skipping and
 * start connecting — to whatever that .env names.
 */
import { describe } from "vitest";
import { runHistoryContract } from "./contractTests.js";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";
import { PostgresHistoryStore } from "../../src/history/pgStore.js";

const url = process.env.DATABASE_URL;

(url ? describe : describe.skip)("postgres", () => {
  runHistoryContract("postgres", async () => {
    const pool = makePool(url!);
    await migrate(pool);
    // Fresh state per store: the contract asserts cross-user isolation and ordering within a
    // single test, not cross-test carryover, so a truncate between tests is sufficient.
    await pool.query("TRUNCATE sessions, runs RESTART IDENTITY CASCADE");
    return new PostgresHistoryStore(pool);
  });
});
