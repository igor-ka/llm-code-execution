/**
 * Guards the gate that decides whether the Postgres and Redis suites run.
 *
 * Those suites skip on an unset DATABASE_URL / REDIS_URL, and `npm run test` is documented as the
 * DB-free run. But `src/config.ts` calls dotenv on the repo-root `.env` at import time, so without
 * the pin in vitest.config.ts any test reaching config.ts creates those variables mid-run and the
 * suites start connecting to whatever that file names.
 *
 * Two assertions, because neither alone is enough. The first works everywhere, including CI where
 * no `.env` exists, and fails if the pin is ever deleted. The second is the real proof and can
 * only run where a repo-root `.env` actually declares a value to leak.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("test harness: the datastore gate", () => {
  // CI has no repo-root .env, so the behavioural check below is vacuous there — this one is not.
  it("pins both datastore variables in vitest.config.ts", async () => {
    const config = (await import("../vitest.config.js")).default as {
      test?: { env?: Record<string, string> };
    };
    expect(Object.keys(config.test?.env ?? {}).sort()).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });

  it("does not let the repo-root .env supply a datastore URL the shell did not", async () => {
    // Importing config.ts is what runs dotenv. Do it explicitly: relying on some other suite to
    // have imported it first would make this assertion pass for the wrong reason.
    await import("../src/config.js");

    const envFile = join(repoRoot, ".env");
    if (!existsSync(envFile)) {
      // Nothing to leak. The assertion above is what guards this case.
      expect(true).toBe(true);
      return;
    }
    const declared = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .flatMap((line) => {
          const m = /^(DATABASE_URL|REDIS_URL)=(.+)$/.exec(line.trim());
          return m ? [[m[1], m[2]]] : [];
        }),
    );

    for (const key of ["DATABASE_URL", "REDIS_URL"] as const) {
      if (declared[key] === undefined) continue;
      // Importing config.ts is what runs dotenv — do it explicitly so this test does not depend
      // on some other suite having imported it first.
      expect(process.env[key] ?? "").not.toBe(declared[key]);
    }
  });
});
