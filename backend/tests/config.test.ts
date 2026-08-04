import { describe, it, expect } from "vitest";
import { loadSettings } from "../src/config.js";

describe("loadSettings", () => {
  it("applies documented defaults on an empty environment", () => {
    const s = loadSettings({});
    expect(s.anthropicApiKey).toBe("");
    expect(s.llmModel).toBe("claude-sonnet-4-6");
    expect(s.sandboxImage).toBe("llm-sandbox:latest");
    expect(s.sandboxTimeoutSeconds).toBe(10);
    expect(s.sandboxMemoryMb).toBe(256);
    expect(s.sandboxCpus).toBe(0.5);
    expect(s.sandboxPidsLimit).toBe(64);
    expect(s.sandboxMaxOutputChars).toBe(20000);
    expect(s.frontendOrigin).toBe("http://localhost:5173");
    expect(s.authRequired).toBe(true);
    expect(s.oidcIssuer).toBe("");
    expect(s.oidcAudience).toBe("");
    expect(s.oidcJwksUrl).toBe("");
    expect(s.databaseUrl).toBe("");
    expect(s.historyEnabled).toBe(false);
  });

  it("enables history only when auth is required AND DATABASE_URL is set", () => {
    // Both conditions -> enabled.
    expect(loadSettings({ DATABASE_URL: "postgres://x" }).historyEnabled).toBe(true);
    // Auth off -> no identity -> disabled even with a DB configured.
    expect(
      loadSettings({ DATABASE_URL: "postgres://x", AUTH_REQUIRED: "false" }).historyEnabled,
    ).toBe(false);
    // No DB configured -> disabled even with auth on.
    expect(loadSettings({ AUTH_REQUIRED: "true" }).historyEnabled).toBe(false);
    // databaseUrl is passed through verbatim.
    expect(loadSettings({ DATABASE_URL: "postgres://x" }).databaseUrl).toBe("postgres://x");
  });

  it("parses AUTH_REQUIRED=false as boolean false", () => {
    expect(loadSettings({ AUTH_REQUIRED: "false" }).authRequired).toBe(false);
    expect(loadSettings({ AUTH_REQUIRED: "true" }).authRequired).toBe(true);
    expect(loadSettings({ AUTH_REQUIRED: "0" }).authRequired).toBe(false);
  });

  it("coerces numeric limits from strings", () => {
    const s = loadSettings({ SANDBOX_MEMORY_MB: "512", SANDBOX_CPUS: "1.5" });
    expect(s.sandboxMemoryMb).toBe(512);
    expect(s.sandboxCpus).toBe(1.5);
  });
});
