import { Pool } from "pg";

/** One pool per process; construct lazily so /api/health boots without a DB. */
export function makePool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
