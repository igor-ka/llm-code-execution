import { describe, it, expect } from "vitest";
import request from "supertest";
import { ConcurrencyLimiter } from "../../src/limits/concurrency.js";
import { ConcurrencyLimitedBackend } from "../../src/sandbox/concurrencyLimited.js";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import { fakePrincipal } from "../helpers/auth.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";

/** A backend that blocks until released, so concurrency is observable. */
function blockingBackend() {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const backend: SandboxBackend = {
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    },
  };
  return { backend, releaseAll: () => releases.splice(0).forEach((r) => r()), peak: () => peak };
}

describe("ConcurrencyLimiter", () => {
  it("hands out at most `max` slots", () => {
    const limiter = new ConcurrencyLimiter(2);
    const a = limiter.tryAcquire();
    const b = limiter.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
    expect(limiter.saturated).toBe(true);
    a!();
    expect(limiter.saturated).toBe(false);
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  it("ignores a double release, so one caller cannot inflate capacity", () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire()!;
    release();
    release();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull(); // still 1, not 2
  });

  it("releases the slot when the inner backend throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const throwing: SandboxBackend = {
      execute: async () => {
        throw new Error("boom");
      },
    };
    const wrapped = new ConcurrencyLimitedBackend(throwing, limiter);
    await expect(wrapped.execute("x", "python", {} as never)).rejects.toThrow("boom");
    expect(limiter.saturated).toBe(false); // a leak here would wedge the service permanently
  });

  it("refuses with 503 rather than launching beyond the cap (S5)", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const throwing: SandboxBackend = {
      execute: async () => {
        throw new Error("unreached");
      },
    };
    const wrapped = new ConcurrencyLimitedBackend(throwing, limiter);
    limiter.tryAcquire(); // occupy the only slot
    await expect(wrapped.execute("x", "python", {} as never)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("/api/execute under saturation", () => {
  it("never exceeds the cap and refuses the excess with 503 (S5)", async () => {
    const { backend, releaseAll, peak } = blockingBackend();
    const limiter = new ConcurrencyLimiter(2);
    const app = createApp({
      settings: loadSettings({
        AUTH_REQUIRED: "false",
        ANTHROPIC_API_KEY: "t",
        RATE_LIMIT_BURST: "100",
      }),
      llm: {
        generate: async () => ({
          shouldExecute: true,
          language: "python",
          code: "print(1)",
          message: null,
        }),
      } as never,
      sandbox: new ConcurrencyLimitedBackend(backend, limiter),
      quota: new MemoryQuotaStore(),
      requirePrincipal: fakePrincipal("user-a"),
    });

    // CRITICAL: supertest requests are LAZY. `request(app).post(...).send(...)` builds a
    // thenable and dispatches nothing until .then() is called. Without the .then() below, no
    // request reaches the app before releaseAll() fires on an empty array, and the test hangs
    // until the suite times out rather than failing an assertion.
    const inflight = [0, 1, 2, 3, 4].map(() =>
      request(app)
        .post("/api/execute")
        .send({ prompt: "go" })
        .then((r) => r),
    );
    // Let the two winners occupy both slots and the three losers be refused.
    await new Promise((r) => setTimeout(r, 50));
    releaseAll();
    const responses = await Promise.all(inflight);

    // Exact counts, not `toBeLessThanOrEqual` — a cap of 2 that only ever ran 1 request would
    // satisfy an inequality while proving nothing.
    expect(peak()).toBe(2);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
    const refused = responses.filter((r) => r.status === 503);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    }
  });
});
