import { defineConfig } from "vitest/config";

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

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: fromShell,
  },
});
