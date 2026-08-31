import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".venv"] },
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
