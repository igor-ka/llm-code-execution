import { it, expect } from "vitest";
import { overLimit } from "./src/toggle.js";

// DELIBERATELY WEAK: it calls the function and asserts only its type, so flipping `>` to `>=`
// changes nothing it can see. This fixture exists to be failed — scripts/tests/mutation-gate.test.sh
// runs Stryker against it and asserts the gate REJECTS it.
it("returns a boolean", () => {
  expect(typeof overLimit(1, 2)).toBe("boolean");
});
