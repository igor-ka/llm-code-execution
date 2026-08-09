/**
 * D6's boot guard, and the constraint that keeps it from poisoning the test suite.
 *
 * The second test is the important one: it stays failing if someone later "helpfully" moves
 * assertRedisConfigured into createApp, which would make every backend test require Redis.
 */
import { describe, it, expect } from "vitest";
import { assertRedisConfigured, loadSettings } from "../../src/config.js";
import { createApp } from "../../src/server.js";

describe("boot guard (D6)", () => {
  it("names the missing variable so the failure is self-explanatory", () => {
    expect(() => assertRedisConfigured(loadSettings({}))).toThrow(/REDIS_URL/);
  });

  it("does NOT block createApp — unit tests must run without Redis (S10)", () => {
    expect(() => createApp({ settings: loadSettings({}) })).not.toThrow();
  });
});
