/**
 * The boot guard — "no REDIS_URL, no boot" — and the constraint that keeps it from poisoning
 * the test suite.
 *
 * The second test is the important one: it stays failing if someone later "helpfully" moves
 * assertRedisConfigured into createApp, which would make every backend test require Redis.
 *
 * Codes: D6 is the decision (docs/adr/0003-rate-limiting-approach.md), S10 the success
 * criterion (docs/specs/2026-08-08-per-user-rate-limiting.md).
 */
import { describe, it, expect } from "vitest";
import { assertRedisConfigured, loadSettings } from "../../src/config.js";
import { createApp } from "../../src/server.js";

describe("boot guard: refuse to start without REDIS_URL (D6)", () => {
  it("names the missing variable so the failure is self-explanatory", () => {
    expect(() => assertRedisConfigured(loadSettings({}))).toThrow(/REDIS_URL/);
  });

  it("does NOT block createApp — unit tests must run without Redis (S10)", () => {
    expect(() => createApp({ settings: loadSettings({}) })).not.toThrow();
  });
});
