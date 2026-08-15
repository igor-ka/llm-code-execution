import { describe, it, expect } from "vitest";
import { resolveDevPort, DEFAULT_DEV_PORT } from "./devPort";

describe("resolveDevPort", () => {
  it("defaults to 5173 when unset", () => {
    expect(resolveDevPort(undefined)).toBe(DEFAULT_DEV_PORT);
  });

  it("defaults when the value is blank", () => {
    expect(resolveDevPort("")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("   ")).toBe(DEFAULT_DEV_PORT);
  });

  it("uses a valid port", () => {
    expect(resolveDevPort("5183")).toBe(5183);
  });

  // Falling back would be worse than failing: 5173 is a real registered origin, so a typo'd
  // value would quietly serve this worktree on slot 0's port with nothing to notice — Auth0
  // accepts the origin, and the mistake only surfaces later as a bind conflict in the tree that
  // actually owns it.
  it("refuses values that are not usable TCP ports, rather than defaulting", () => {
    for (const bad of ["nope", "5183.5", "0", "-1", "65536", "51 83"]) {
      expect(() => resolveDevPort(bad)).toThrow(/VITE_DEV_PORT/);
    }
  });
});
