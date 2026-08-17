import type { Pool } from "pg";
import { createApp } from "./server.js";
import {
  getSettings,
  assertRedisConfigured,
  assertFrontendOriginConfigured,
  stackSlotWarnings,
} from "./config.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";
import { PostgresHistoryStore } from "./history/pgStore.js";
import type { HistoryStore } from "./history/store.js";
import { RedisQuotaStore } from "./limits/redisQuota.js";
import { makeShutdown, exitAfterFlush } from "./shutdown.js";
import { log, configureLogger } from "./log.js";

/**
 * Composition root. Everything with a lifecycle is built here and injected, because shutdown has
 * to be able to close it: createApp()'s lazy fallbacks construct a pool and a Redis client that
 * nothing outside the closure can reach. Those fallbacks stay for tests and for callers that do
 * not inject — this file simply wins when it does.
 */
async function main(): Promise<void> {
  const settings = getSettings();
  // The composition root decides the log format, so settings stay the single source of truth
  // and log.ts never has to import config.ts (which loads dotenv) and create a cycle.
  configureLogger(settings.logFormat);

  // Signal handlers go on BEFORE the async startup work, not after listen(). migrate() can block
  // for up to the advisory lock's lock_timeout, and a SIGTERM arriving in that window would
  // otherwise get the default disposition: killed abruptly, no log, indistinguishable from a
  // crash. Until the server exists there is nothing to drain, so we just leave cleanly.
  let shutdown = (signal: string): void => {
    log.info("shutdown: signalled during startup, exiting before the server was listening", {
      signal,
    });
    exitAfterFlush(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Fail fast rather than serve traffic with the budget control absent (ADR-0003 D6).
  // Deliberately here and not in createApp: createApp is the seam every backend test builds on,
  // so a hard Redis dependency there would become a hard dependency of every unit test (S10).
  assertRedisConfigured(settings);

  // Same reasoning, for the CORS allowlist: the deployed service must not name a localhost origin
  // as trusted. Fires only on SANDBOX_BACKEND=cloudrun, so local runs are untouched.
  assertFrontendOriginConfigured(settings);

  // A worktree whose .env claims one slot but points a service at another writes to the wrong
  // datastore silently. Warn, don't throw: this is a consistency check, not a security control.
  for (const warning of stackSlotWarnings()) log.warn(`stack slot: ${warning}`);

  // One pool for the process: it runs the migrations and then backs the history store. Before
  // this, migrations opened a throwaway pool and createApp() lazily built a second one that
  // nothing could reach — which left no way to close it on shutdown.
  let pool: Pool | undefined;
  let history: HistoryStore | undefined;
  if (settings.databaseUrl) {
    pool = makePool(settings.databaseUrl);
    await migrate(pool);
    // History is an authenticated feature; historyEnabled already encodes auth-on + DB-set.
    if (settings.historyEnabled) history = new PostgresHistoryStore(pool);
  }

  const quota = new RedisQuotaStore(settings.redisUrl);

  const server = createApp({ settings, history, quota }).listen(settings.port, "0.0.0.0", () => {
    log.info("backend listening", {
      port: settings.port,
      historyEnabled: history !== undefined,
      authRequired: settings.authRequired,
      // States whether this process is serving the SPA: the difference between "the image is
      // wrong" and "the app is broken" is otherwise invisible from the logs.
      publicDir: settings.publicDir || null,
    });
  });

  // listen() reports failures asynchronously via 'error' (EADDRINUSE, EACCES on a privileged
  // port). By then main()'s promise has resolved, so main().catch below would never see it and
  // Node's default for an unhandled 'error' event is to rethrow — a raw stack instead of the
  // structured fatal line.
  server.on("error", (err) => {
    log.error("fatal: server error", { err, port: settings.port });
    exitAfterFlush(1);
  });

  shutdown = makeShutdown({
    server,
    graceMs: settings.shutdownGraceMs,
    cleanup: async () => {
      // allSettled, not sequential awaits: during a platform shutdown Redis is often going down
      // with us, so quota.close() can reject — and a sequential await would skip pool.end()
      // entirely, leaving Postgres connections to be severed by process.exit instead of drained.
      await Promise.allSettled([quota.close(), pool?.end()]);
    },
    log: (level, message, fields) => log[level](message, fields),
  });
}

main().catch((err) => {
  log.error("fatal: backend failed to start", { err });
  exitAfterFlush(1);
});
