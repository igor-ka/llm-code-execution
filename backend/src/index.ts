import { createApp } from "./server.js";
import { getSettings } from "./config.js";
import { makePool } from "./history/pool.js";
import { migrate } from "./history/migrate.js";

const PORT = 8000;

async function main(): Promise<void> {
  const settings = getSettings();
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
  createApp().listen(PORT, "0.0.0.0", () => {
    console.log(`llm-code-execution backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
