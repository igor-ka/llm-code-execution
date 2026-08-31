/**
 * Decide the mutation gate from Stryker's JSON report.
 *
 * BLOCK AND COUNT: a mutant that SURVIVED fails the build, and so does one Stryker marked
 * NoCoverage — a line the change added that no test executes. This is deliberately stricter than
 * "score below threshold": it names the offending line, which a score cannot.
 *
 * Timeout counts as detected (Stryker's own semantics: an infinite loop is a defect the suite
 * noticed). CompileError and RuntimeError are Stryker's own failures to build a mutant and are not
 * evidence about the tests either way.
 *
 * AN UNKNOWN STATUS IS A FAILURE, never a pass. This file hard-codes a status vocabulary; if
 * Stryker adds one, the gate must stop rather than silently treat it as acceptable. `Pending` is
 * deliberately absent from both sets: a mutant generated but never run is not evidence about the
 * tests, and it must reach the unknown-status branch rather than be waved through. Do not "fix"
 * that by adding it to ACCEPTABLE.
 */
import { readFileSync } from "node:fs";

const BLOCKING = new Set(["Survived", "NoCoverage"]);
const ACCEPTABLE = new Set(["Killed", "Timeout", "CompileError", "RuntimeError", "Ignored"]);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: mutation-decide.mjs <path-to-stryker-mutation.json>");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`mutation-decide: cannot read the Stryker report at ${reportPath}: ${err.message}`);
  console.error("  A missing or unreadable report is a FAILURE — the gate never passes on absence.");
  process.exit(1);
}

const offenders = [];
const unknown = [];
let total = 0;

for (const [file, entry] of Object.entries(report.files ?? {})) {
  for (const mutant of entry.mutants ?? []) {
    total += 1;
    const line = mutant.location?.start?.line ?? "?";
    if (BLOCKING.has(mutant.status)) {
      offenders.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    } else if (!ACCEPTABLE.has(mutant.status)) {
      unknown.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    }
  }
}

// Zero mutants here means Stryker ran and generated nothing, which is not the same as "the change
// touched no eligible file" — that case is handled by the caller BEFORE Stryker runs. Reaching this
// branch means the scope was non-empty and produced nothing, which is a wiring fault.
if (total === 0) {
  console.error("mutation-decide: the report contains no mutants, but the scope was not empty.");
  process.exit(1);
}

if (unknown.length > 0) {
  console.error(`mutation-decide: ${unknown.length} mutant(s) carry a status this gate does not know:`);
  console.error(unknown.join("\n"));
  console.error("  Update the status vocabulary in scripts/mutation-decide.mjs deliberately.");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`mutation-decide: ${offenders.length} of ${total} mutant(s) were not killed:`);
  console.error(offenders.join("\n"));
  console.error("");
  console.error("Each line above is a change this PR made that no test would notice was wrong.");
  console.error("Kill it with an assertion, or suppress it WITH A REASON:");
  console.error("  // Stryker disable next-line <mutator>: <why no test can kill this>");
  process.exit(1);
}

console.log(`mutation-decide: ${total} mutant(s), all killed.`);
