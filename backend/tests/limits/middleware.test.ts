import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import type { QuotaStore } from "../../src/limits/quota.js";
import { fakePrincipal } from "../helpers/auth.js";

const settings = () =>
  loadSettings({ AUTH_REQUIRED: "false", ANTHROPIC_API_KEY: "test", RATE_LIMIT_BURST: "2" });

const noCodeLlm = {
  generate: async () => ({
    shouldExecute: false,
    message: "nope",
    language: null,
    code: null,
  }),
};

function app(quota: QuotaStore, userId: string | null = "user-a") {
  return createApp({
    settings: settings(),
    llm: noCodeLlm as never,
    quota,
    requirePrincipal: fakePrincipal(userId),
  });
}

describe("quota middleware", () => {
  it("returns 429 with Retry-After once the quota is exhausted (S1)", async () => {
    const store = new MemoryQuotaStore();
    const a = app(store);
    await request(a).post("/api/execute").send({ prompt: "1" }).expect(200);
    await request(a).post("/api/execute").send({ prompt: "2" }).expect(200);
    const resp = await request(a).post("/api/execute").send({ prompt: "3" });
    expect(resp.status).toBe(429);
    expect(Number(resp.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("never calls the LLM for a refused request (S3)", async () => {
    const store = new MemoryQuotaStore();
    const generate = vi.fn(noCodeLlm.generate);
    const a = createApp({
      settings: settings(),
      llm: { generate } as never,
      quota: store,
      requirePrincipal: fakePrincipal("user-a"),
    });
    await request(a).post("/api/execute").send({ prompt: "1" });
    await request(a).post("/api/execute").send({ prompt: "2" });
    await request(a).post("/api/execute").send({ prompt: "3" }).expect(429);
    expect(generate).toHaveBeenCalledTimes(2); // not 3 — the refusal cost nothing
  });

  it("throttling one user does not affect another (S2)", async () => {
    const store = new MemoryQuotaStore();
    for (const p of ["1", "2", "3"]) {
      await request(app(store, "user-a")).post("/api/execute").send({ prompt: p });
    }
    await request(app(store, "user-a")).post("/api/execute").send({ prompt: "x" }).expect(429);
    await request(app(store, "user-b")).post("/api/execute").send({ prompt: "x" }).expect(200);
  });

  it("charges the no-code path too (S4)", async () => {
    const store = new MemoryQuotaStore();
    await request(app(store)).post("/api/execute").send({ prompt: "tell me a joke" }).expect(200);
    expect((await store.usage("quota:user:user-a")).burst).toBe(1);
  });

  it("fails OPEN when the store throws, and says so loudly (D5, S9)", async () => {
    const broken: QuotaStore = {
      consume: async () => {
        throw new Error("ECONNREFUSED");
      },
      usage: async () => ({ burst: 0, sustained: 0 }),
      close: async () => {},
    };
    // The alarm now goes through log.ts, whose sink is console.log — severity is a field, not a
    // stream. Left on console.error, this spy would pass vacuously and stop guarding S9 at all.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await request(app(broken)).post("/api/execute").send({ prompt: "1" }).expect(200);
    expect(spy).toHaveBeenCalled(); // silence would violate S9
    expect(String(spy.mock.calls[0]?.[0])).toContain("FAILING OPEN");
    spy.mockRestore();
  });

  it("shares one bucket across anonymous callers (D2)", async () => {
    const store = new MemoryQuotaStore();
    await request(app(store, null)).post("/api/execute").send({ prompt: "1" }).expect(200);
    await request(app(store, null)).post("/api/execute").send({ prompt: "2" }).expect(200);
    await request(app(store, null)).post("/api/execute").send({ prompt: "3" }).expect(429);
  });
});
