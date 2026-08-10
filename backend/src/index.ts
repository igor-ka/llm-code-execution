import type { Pool } from "pg";
import { createApp } from "./server.js";
import { getSettings, assertRedisConfigured } from "./config.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";
import { PostgresHistoryStore } from "./history/pgStore.js";
import type { HistoryStore } from "./history/store.js";
import { RedisQuotaStore } from "./limits/redisQuota.js";
import { makeShutdown } from "./shutdown.js";
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
  // Fail fast rather than serve traffic with the budget control absent (ADR-0003 D6).
  // Deliberately here and not in createApp: createApp is the seam every backend test builds on,
  // so a hard Redis dependency there would become a hard dependency of every unit test (S10).
  assertRedisConfigured(settings);

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
    });
  });

  const shutdown = makeShutdown({
    server,
    cleanup: async () => {
      await quota.close();
      await pool?.end();
    },
    log: (message, fields) => log.info(message, fields),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal: backend failed to start", { err });
  process.exit(1);
});
