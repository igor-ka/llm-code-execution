import { createApp } from "./server.js";
import { getSettings, assertRedisConfigured } from "./config.js";
import { configureLogger } from "./log.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";

const PORT = 8000;

async function main(): Promise<void> {
  const settings = getSettings();
  // The composition root decides the log format, so settings stay the single source of truth
  // and log.ts never has to import config.ts (which loads dotenv) and create a cycle.
  configureLogger(settings.logFormat);
  // Fail fast rather than serve traffic with the budget control absent (D6). Deliberately
  // here and not in createApp: createApp is the seam every backend test builds on, so a hard
  // Redis dependency there would become a hard dependency of every unit test (S10).
  assertRedisConfigured(settings);
  // Apply pending history migrations before serving traffic. Guarded on DATABASE_URL so the
  // anonymous/local mode (no DB configured) boots without a Postgres. The store the app uses
  // later builds its own pool; this temporary pool is closed once migrations complete.
  if (settings.databaseUrl) {
    const pool = makePool(settings.databaseUrl);
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  }
  // NOTE: the two console calls below are still unstructured. P0-3 (#85) rewrites this file as
  // the composition root and moves them onto log.ts along with the shutdown handler.
  createApp().listen(PORT, "0.0.0.0", () => {
    console.log(`llm-code-execution backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
