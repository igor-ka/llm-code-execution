import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // `reports`, `.stryker-tmp` and `.mutation-selftest-strong` are mutation-testing output, and they
  // must be listed here as well as in .prettierignore — ESLint flat config does not skip
  // dot-directories on its own. `.stryker-tmp` is a full copy of src/ and tests/, so without this a
  // Stryker run interrupted before `cleanTempDir` leaves the next `./verify.sh lint` double-
  // reporting every real file.
  {
    ignores: [
      "dist",
      "node_modules",
      ".venv",
      "reports",
      ".stryker-tmp",
      ".mutation-selftest-strong",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `tests/fc.ts` is the only place fast-check may be imported from. Its `configureGlobal` call
    // pins the seed and numRuns, and the whole determinism argument depends on every property suite
    // getting that side effect: a direct `import fc from "fast-check"` silently gets a fresh seed
    // per run, which surfaces months later as an intermittent red build — and the mutation gate
    // reads a test failure as a KILL, so an unrelated failure makes THAT gate pass for the wrong
    // reason. tests/fc.ts itself is exempt; it is the module doing the configuring.
    files: ["tests/**/*.ts"],
    ignores: ["tests/fc.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "fast-check",
              message: "Import { fc } from tests/fc.js — it pins the seed and numRuns.",
            },
          ],
        },
      ],
    },
  },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
