/** `node --import tsx src/history/cli-migrate.ts` — apply pending migrations, then exit.
 *  Invoked by `verify.sh migrate`; gated on DATABASE_URL being set. */
import { getSettings } from "../config.js";
import { makePool } from "./pool.js";
import { migrate } from "./migrate.js";

const url = getSettings().databaseUrl;
if (!url) {
  console.error("DATABASE_URL is not set; nothing to migrate.");
  process.exit(1);
}
const pool = makePool(url);
migrate(pool)
  .then(() => pool.end())
  .then(() => {
    console.log("migrations applied.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
