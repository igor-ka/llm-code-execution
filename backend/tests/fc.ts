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

const PINNED = 20260831;
const raw = process.env.FC_SEED;

/**
 * `raw !== undefined`, NOT `raw ? …`. `FC_SEED=$RANDOM` is the documented local search, and
 * `$RANDOM` is a bash/zsh builtin — under `sh`, `dash`, or `env -i` it expands to the empty string.
 * A truthiness test then falls back to the pinned seed and the run is byte-identical to CI, with no
 * error and no log: you believe you explored 200 fresh cases and explored zero. That is the "you
 * think you have coverage and you don't" failure this file exists to prevent.
 *
 * `Number.isInteger` and not `Number.isFinite`, matching the `posInt` standard src/config.ts sets
 * for numeric environment input: `Number("1.5")`, `Number("-3")`, `Number("0x10")` and `Number(" ")`
 * all pass isFinite and all silently become a seed nobody can reproduce from what they typed.
 */
let seed = PINNED;
if (raw !== undefined) {
  if (raw.trim() === "") throw new Error("FC_SEED is set but empty — did $RANDOM expand under sh?");
  seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`FC_SEED must be a non-negative integer, got: ${raw}`);
  }
}

fc.configureGlobal({ seed, numRuns: 200 });

export { fc, seed };
