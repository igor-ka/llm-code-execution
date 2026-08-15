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

  // A bad value must not become a *different usable port* silently: with strictPort on,
  // falling back to 5173 either binds the slot-0 origin Auth0 already knows, or fails the
  // bind outright. Both are visible; a silent 5174 is not.
  it("falls back on values that are not usable TCP ports", () => {
    expect(resolveDevPort("nope")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("5183.5")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("0")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("-1")).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("65536")).toBe(DEFAULT_DEV_PORT);
  });
});
