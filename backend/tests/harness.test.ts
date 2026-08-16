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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

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

/**
 * Every project's pinned env, straight from the config under test.
 *
 * Per project, not once: the pin has to hold in each of them, and a project added later without
 * it would reintroduce the leak in exactly the run that project defines.
 */
async function pinnedPerProject(): Promise<Record<string, string>[]> {
  const config = (await import("../vitest.config.js")).default as {
    test?: {
      env?: Record<string, string>;
      projects?: { test?: { env?: Record<string, string> } }[];
    };
  };
  const projects = config.test?.projects;
  if (projects?.length) return projects.map((p) => p.test?.env ?? {});
  return [config.test?.env ?? {}];
}

describe("test harness: the datastore gate", () => {
  // CI has no repo-root env file, so the behavioural check below is vacuous there — this one is
  // not. Delete the pin and this fails immediately, everywhere.
  it("pins both datastore variables in every vitest project", async () => {
    const perProject = await pinnedPerProject();
    expect(perProject.length).toBeGreaterThan(0);
    for (const env of perProject) {
      expect(Object.keys(env).sort()).toEqual([...KEYS].sort());
    }
  });

  // The reason the split works is that only ONE unit-project suite touches Postgres, so there is
  // nothing for it to race. But `include: ["tests/**/*.test.ts"]` means the next Postgres suite
  // someone adds lands in the unit project by DEFAULT, in parallel with isolation.test.ts, whose
  // beforeEach migrates and then TRUNCATEs — reintroducing exactly the corruption this split
  // removed. A comment cannot hold that; this does.
  //
  // Keyed on `makePool`, the only way to open a pool here. Deliberately not on RedisQuotaStore:
  // redisQuotaOffline.test.ts imports it to prove the fail-open path against a CLOSED port and
  // needs no live server, so it belongs in the unit project.
  it("keeps every Postgres-touching suite out of the unit project's parallel pool", async () => {
    const config = (await import("../vitest.config.js")).default as {
      test?: { projects?: { test?: { name?: string; include?: string[] } }[] };
    };
    const integration =
      (config.test?.projects ?? []).find((p) => p.test?.name === "integration")?.test?.include ??
      [];

    const testsDir = join(repoRoot, "backend", "tests");
    const touchesPostgres = walk(testsDir)
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => /^import[^;]*\bmakePool\b/m.test(readFileSync(f, "utf8")))
      .map((f) => relative(join(repoRoot, "backend"), f));

    expect(touchesPostgres.length).toBeGreaterThan(0); // the guard must not pass by finding nothing
    for (const file of touchesPostgres) expect(integration).toContain(file);
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
