// Lenient first-pass ESLint flat config. Check-only in CI (no autofix of existing code).
// Uses the recommended (non-type-checked) rule sets for speed; type errors are already
// caught by `tsc -b` in the build step.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
);
