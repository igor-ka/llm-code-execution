import { defineConfig, configDefaults } from "vitest/config";

/**
 * Pin the datastore variables to whatever the SHELL provides — nothing more.
 *
 * `npm run test` is documented as the DB-free run, and the Postgres and Redis suites self-skip on
 * an unset `DATABASE_URL` / `REDIS_URL`. But `src/config.ts` calls dotenv on the repo-root `.env`
 * at import time, and any test that reaches config.ts therefore *creates* those variables mid-run.
 * The suites then stop skipping and try to connect, so the DB-free run fails against whatever the
 * `.env` happens to name. A worktree makes this certain rather than occasional: every generated
 * `.env` points at that slot's own Postgres, which is not running until you start it.
 *
 * This config is evaluated before any test file imports config.ts, so `process.env` here is still
 * the real shell environment. Writing the value back — empty string when absent — makes the key
 * *exist*, and dotenv does not overwrite keys that exist (`hasOwnProperty`, no `override`). The
 * shell stays the single source of truth for whether the integration suites run.
 *
 * What this deliberately does NOT do is decide by reachability. `verify.sh test:integration` and
 * CI set these variables precisely because the datastores are supposed to be up; skipping when a
 * connection fails would turn a broken integration environment into a green run, which is the one
 * outcome worse than a noisy one.
 */
const fromShell = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "",
};

/**
 * The suites that talk to a real datastore and SHARE ONE SCHEMA.
 *
 * `migrate.test.ts` drops tables and replays the migrations while `pgStore.test.ts` truncates and
 * inserts, so running them concurrently corrupts each other's fixtures. That constraint used to
 * live in one npm script (`--no-file-parallelism`) while nothing stopped the same files running
 * another way — so a plain `npm run test` with `DATABASE_URL` exported raced. It lives with the
 * files now.
 */
const DATASTORE_SUITES = [
  "tests/history/pgStore.test.ts",
  "tests/history/migrate.test.ts",
  "tests/limits/redisQuota.test.ts",
];

const shared = { environment: "node" as const, env: fromShell };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.ts"],
          // `isolation.test.ts` is deliberately NOT here: it runs the INV-1..8 matrix against the
          // in-memory oracle unconditionally, and dropping that from the DB-free run would lose
          // security coverage to fix a scheduling problem. Its Postgres half still self-skips
          // without DATABASE_URL, and when the variable IS exported it is the only suite in this
          // project touching the database — so there is nothing left for it to race.
          // Spread configDefaults.exclude, do not replace it: a bare list silently drops vitest's
          // own node_modules/dist/.git exclusions, which costs nothing while `include` stays
          // scoped to tests/ and bites the moment someone widens it.
          exclude: [...configDefaults.exclude, ...DATASTORE_SUITES],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          // isolation.test.ts is in BOTH projects, so a bare `npx vitest run <file>` or `-t <name>`
          // without --project runs it twice, once per project. Harmless — the two groups are
          // serialized, not concurrent — but surprising the first time you see it.
          include: [...DATASTORE_SUITES, "tests/history/isolation.test.ts"],
          // The whole point: one schema, one file at a time. `fileParallelism` is a root-only
          // option in vitest 3.2, so the per-project equivalent is a single fork: every file in
          // this project runs in one process, one after another.
          pool: "forks" as const,
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
