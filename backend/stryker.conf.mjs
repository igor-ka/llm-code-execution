/**
 * Stryker configuration for the diff-scoped mutation gate. See ADR 0006 and
 * scripts/mutation-scope.sh.
 *
 * THERE IS DELIBERATELY NO `mutate` KEY. A CLI `--mutate` COMPLETELY REPLACES the config value
 * rather than merging with it, and the gate always passes `--mutate` from
 * scripts/mutation-scope.sh. A `mutate` key here would be dead weight that looks authoritative —
 * the eligible set lives in .mutation-scope.json and nowhere else.
 *
 * THERE IS ALSO NO `thresholds` KEY, and that is the same decision in a second place. A
 * `break: 100` would work — Stryker's score is `detected / valid` and NoCoverage counts against it,
 * so it fails on exactly the two statuses scripts/mutation-decide.mjs blocks. It is omitted
 * deliberately: it is a mutation SCORE, which ADR 0006 rules out, and its failure message is the
 * non-actionable "score 97.3 is below break threshold 100" rather than a named file and line. One
 * gate, and it is the one that can tell you what to fix.
 *
 * NO `concurrency` KEY either — it is passed on the command line, because the safe value depends on
 * which files are in scope. See the mutation() target in backend/verify.sh.
 */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  // Record which tests touch which lines once, then run only those per mutant. Without this every
  // mutant re-runs all 247 tests and the gate becomes unaffordable. Measured: 1.13 tests per mutant
  // on concurrency.ts, 4.45 across the datastore-free eligible set.
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "json"],
  // Default is 5000. The datastore-gated suites talk to Postgres and Redis over a socket, and
  // vitest.config.ts serializes the whole run whenever DATABASE_URL or REDIS_URL is set — so a
  // mutant's test run is slower here than the DB-free numbers suggest.
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
