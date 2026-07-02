import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { loadSettings } from "../src/config.js";
import type { LLMService } from "../src/llm.js";
import type { SandboxBackend } from "../src/sandbox/base.js";
import type { GenerationResult, SandboxResult } from "../src/schemas.js";

const openSettings = (over = {}) => loadSettings({ AUTH_REQUIRED: "false", ...over });

function fakeLlm(result: GenerationResult | (() => Promise<never>)): LLMService {
  return {
    generate: async () => {
      if (typeof result === "function") return result();
      return result;
    },
  } as unknown as LLMService;
}

function fakeSandbox(result: SandboxResult): SandboxBackend & { calls: number } {
  const box = {
    calls: 0,
    async execute() {
      box.calls += 1;
      return result;
    },
  };
  return box as unknown as SandboxBackend & { calls: number };
}

describe("public endpoints", () => {
  it("GET /api/health -> {status:ok}", async () => {
    const resp = await request(createApp({ settings: openSettings() })).get("/api/health");
    expect(resp.body).toEqual({ status: "ok" });
  });

  it("GET /api/config reflects auth_required=true", async () => {
    const resp = await request(createApp({ settings: loadSettings({ AUTH_REQUIRED: "true" }) })).get(
      "/api/config",
    );
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ auth_required: true });
  });

  it("GET /api/config reflects auth_required=false", async () => {
    const resp = await request(createApp({ settings: openSettings() })).get("/api/config");
    expect(resp.body).toEqual({ auth_required: false });
  });

  it("GET /api/config is public even when auth is required (no token)", async () => {
    const resp = await request(createApp({ settings: loadSettings({ AUTH_REQUIRED: "true" }) })).get(
      "/api/config",
    );
    expect(resp.status).toBe(200);
  });
});

describe("POST /api/execute", () => {
  it("happy path returns the exact result wire shape and runs the sandbox once", async () => {
    const sandbox = fakeSandbox({
      stdout: "0 1 1 2 3\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
    });
    const app = createApp({
      settings: openSettings(),
      llm: fakeLlm({ shouldExecute: true, language: "python", code: "print(1)", message: null }),
      sandbox,
    });
    const resp = await request(app).post("/api/execute").send({ prompt: "fib" });
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({
      type: "result",
      language: "python",
      code: "print(1)",
      stdout: "0 1 1 2 3\n",
      stderr: "",
      exit_code: 0,
      duration_ms: 12,
      timed_out: false,
    });
    expect(sandbox.calls).toBe(1);
  });

  it("no-code path returns a message and never touches the sandbox", async () => {
    const sandbox = fakeSandbox({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    });
    const app = createApp({
      settings: openSettings(),
      llm: fakeLlm({
        shouldExecute: false,
        language: null,
        code: null,
        message: "Not a coding task.",
      }),
      sandbox,
    });
    const resp = await request(app).post("/api/execute").send({ prompt: "joke" });
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ type: "message", message: "Not a coding task." });
    expect(sandbox.calls).toBe(0);
  });

  it("LLM failure surfaces as 502", async () => {
    const app = createApp({
      settings: openSettings(),
      llm: fakeLlm(async () => {
        throw new Error("boom");
      }),
      sandbox: fakeSandbox({ stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false }),
    });
    const resp = await request(app).post("/api/execute").send({ prompt: "x" });
    expect(resp.status).toBe(502);
  });

  it("missing ANTHROPIC_API_KEY yields 503", async () => {
    // No injected llm -> lazy construction hits the empty key.
    const app = createApp({ settings: openSettings({ ANTHROPIC_API_KEY: "" }) });
    const resp = await request(app).post("/api/execute").send({ prompt: "x" });
    expect(resp.status).toBe(503);
  });

  it("invalid body is 422", async () => {
    const app = createApp({ settings: openSettings() });
    const resp = await request(app).post("/api/execute").send({ prompt: "" });
    expect(resp.status).toBe(422);
  });

  it("is auth-gated: no token yields 401 before any LLM/sandbox work", async () => {
    // No injected requirePrincipal -> the REAL makeRequirePrincipal(settings) runs, proving it
    // is actually wired onto /api/execute. With auth required and no Authorization header,
    // bearerToken throws 401 before any JWKS lookup, LLM call, or sandbox run.
    const sandbox = fakeSandbox({ stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false });
    const app = createApp({
      settings: loadSettings({ AUTH_REQUIRED: "true" }),
      llm: fakeLlm(async () => {
        throw new Error("LLM must not run");
      }),
      sandbox,
    });
    const resp = await request(app).post("/api/execute").send({ prompt: "hello" });
    expect(resp.status).toBe(401);
    expect(sandbox.calls).toBe(0);
  });
});
