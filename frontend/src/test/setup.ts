// Vitest global setup: register jest-dom matchers and unmount React trees
// between tests so the DOM doesn't leak across cases.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
