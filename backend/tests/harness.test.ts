/**
 * Guards the gate that decides whether the Postgres and Redis suites run.
 *
 * Those suites skip on an unset DATABASE_URL / REDIS_URL, and `npm run test` is documented as the
 * DB-free run. But `src/config.ts` calls dotenv on the repo-root env files at import time, so
 * without the pin in vitest.config.ts any test reaching config.ts creates those variables mid-run
 * and the suites start connecting to whatever those files name.
 *
 * Two assertions, because neither alone is enough. The first works everywhere, including CI where
 * no env file exists, and fails if the pin is ever deleted. The second is the real proof and can
 * only run where an env file actually declares a value to leak.
 */
import { describe, it, expect } from "vitest";
import { parse } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYS = ["DATABASE_URL", "REDIS_URL"] as const;

/**
 * What the variables held BEFORE dotenv could run — captured at module scope, which vitest
 * evaluates before this file imports anything of ours, and each test file gets its own module
 * registry. With the pin in place this is the shell's value; without it, unset.
 *
 * Read from here rather than from the config's own pin: consulting the pin would make the check
 * below skip itself whenever the pin is missing, which is precisely when it needs to fire.
 */
const beforeDotenv: Record<string, string | undefined> = {
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
};

/** The pinned values, straight from the config under test. */
async function pinned(): Promise<Record<string, string>> {
  const config = (await import("../vitest.config.js")).default as {
    test?: { env?: Record<string, string> };
  };
  return config.test?.env ?? {};
}

describe("test harness: the datastore gate", () => {
  // CI has no repo-root env file, so the behavioural check below is vacuous there — this one is
  // not. Delete the pin and this fails immediately, everywhere.
  it("pins both datastore variables in vitest.config.ts", async () => {
    expect(Object.keys(await pinned()).sort()).toEqual([...KEYS].sort());
  });

  it("does not let a repo-root env file supply a datastore URL the shell did not", async () => {
    // config.ts reads BOTH, most-specific first, and dotenv does not override an existing key —
    // so `.env` wins over `.env.shared` for a key in both. Merged in that precedence.
    const declared: Record<string, string> = {};
    for (const file of [".env.shared", ".env"]) {
      const path = join(repoRoot, file);
      // dotenv's own parser, not a hand-rolled regex: it strips surrounding quotes and inline
      // comments, and a mismatch there would make this guard pass vacuously — a no-op in exactly
      // the case it exists to catch.
      if (existsSync(path)) Object.assign(declared, parse(readFileSync(path)));
    }

    // Importing config.ts is what runs dotenv. Do it explicitly: relying on some other suite to
    // have imported it first would make this assertion pass for the wrong reason.
    await import("../src/config.js");

    for (const key of KEYS) {
      if (declared[key] === undefined) continue;
      // Only meaningful when the SHELL supplied nothing. When it does export a value it is
      // normally the identical string — that is where worktree-new.sh writes this slot's URLs,
      // and exporting them is the documented way to get integration coverage — so asserting
      // inequality there would fail while the pin is working perfectly.
      if ((beforeDotenv[key] ?? "") !== "") continue;
      expect(process.env[key] ?? "").not.toBe(declared[key]);
    }
  });
});
