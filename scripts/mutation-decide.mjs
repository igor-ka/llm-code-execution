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
const byStatus = new Map();
let total = 0;

for (const [file, entry] of Object.entries(report.files ?? {})) {
  for (const mutant of entry.mutants ?? []) {
    total += 1;
    byStatus.set(mutant.status, (byStatus.get(mutant.status) ?? 0) + 1);
    const line = mutant.location?.start?.line ?? "?";
    if (BLOCKING.has(mutant.status)) {
      offenders.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    } else if (!ACCEPTABLE.has(mutant.status)) {
      unknown.push(`  ${file}:${line}  ${mutant.mutatorName}  (${mutant.status})`);
    }
  }
}

// Zero mutants from a NON-EMPTY scope is routine, not a fault: a changed line can be a comment, an
// import, a blank line or a type-only declaration, none of which Stryker can mutate. An earlier
// version treated this as a wiring fault and exited 1 — which blocked any PR whose only edit to an
// eligible file was a doc comment, with no escape, because there is no mutant to suppress. The
// wiring is proven by mutation:selftest, which is where that assurance belongs.
if (total === 0) {
  console.log("mutation-decide: the changed lines contain nothing mutable (comments, imports, types).");
  process.exit(0);
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

// Report the BREAKDOWN, not just a total. `Ignored` means a suppression was honoured and
// `RuntimeError` means Stryker could not build the mutant — neither is a kill, and rolling them
// into "all killed" hides exactly what review is supposed to see.
const breakdown = [...byStatus.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([status, n]) => `${n} ${status}`)
  .join(", ");
console.log(`mutation-decide: ${total} mutant(s) — ${breakdown}. Nothing survived.`);
if (byStatus.has("Ignored")) {
  console.log(`  ${byStatus.get("Ignored")} suppressed by a // Stryker disable comment — review the reasons.`);
}
if (byStatus.has("RuntimeError") || byStatus.has("CompileError")) {
  console.log("  Some mutants could not be built or run; that is Stryker's failure, not the tests'.");
}
