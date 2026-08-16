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

/**
 * Serialize the whole run whenever a datastore is in play.
 *
 * `pgStore.test.ts`, `migrate.test.ts` and `isolation.test.ts` share ONE schema — `migrate` drops
 * tables and replays the migrations while `pgStore` truncates and inserts — so running them
 * concurrently corrupts each other's fixtures. That constraint used to live in a single npm
 * script (`--no-file-parallelism`) while nothing stopped the same files running another way, so a
 * plain `npm run test` with `DATABASE_URL` exported raced. It lives here now, and so holds for
 * every invocation: the npm scripts, `verify.sh`, and a bare `npx vitest run <file>`.
 *
 * Conditional rather than unconditional because the race has a precondition: with neither variable
 * set those suites skip, so there is nothing to serialize and the common DB-free run keeps its
 * parallelism (~9s here against ~14s serialized).
 *
 * Deliberately NOT solved by splitting the suites into two vitest projects. That looks tidier and
 * is wrong twice over: projects run CONCURRENTLY — measured, both start before either ends — so a
 * file listed in both races itself; and `isolation.test.ts` and `migrate.test.ts` each carry
 * unconditional non-database blocks (the INV-1..8 memory matrix, the migrate error-reporting
 * tests) that excluding the file from the DB-free run would silently drop.
 */
const datastoreInPlay = fromShell.DATABASE_URL !== "" || fromShell.REDIS_URL !== "";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: fromShell,
    fileParallelism: !datastoreInPlay,
  },
});
