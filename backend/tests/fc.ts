/**
 * One place that configures fast-check, so every property suite is deterministic by default.
 *
 * WHY PINNED RATHER THAN RANDOM. fast-check defaults to a fresh seed per run, so a property can
 * pass ninety-nine times and fail on the hundredth. The failure is real — it is a counterexample,
 * not a flake — but this repository treats a red build as a hard stop, and a gate that fails for a
 * reason unrelated to the change under review is the one thing that gets a gate ignored. Worse
 * here than elsewhere: the mutation gate reads a test failure as a KILL, so a run that fails for an
 * unrelated reason makes that gate pass for the wrong reason.
 *
 * So: CI is a deterministic regression suite over a fixed seed, and the SEARCH happens locally.
 * `FC_SEED=$RANDOM npm run test` explores; a counterexample it finds is a bug to fix, and the seed
 * that found it is worth pinning here alongside the original.
 */
import fc from "fast-check";

const raw = process.env.FC_SEED;
const seed = raw ? Number(raw) : 20260831;
if (!Number.isFinite(seed)) throw new Error(`FC_SEED is not a number: ${raw}`);

fc.configureGlobal({ seed, numRuns: 200 });

export { fc, seed };
