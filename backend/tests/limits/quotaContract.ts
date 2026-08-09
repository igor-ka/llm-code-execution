/**
 * Shared contract for every QuotaStore. Run against the in-memory store (fast, always) and
 * against Redis (gated on REDIS_URL). Both must behave identically — that equivalence is
 * what lets unit tests trust the in-memory store as an oracle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { QuotaStore, QuotaLimits } from "../../src/limits/quota.js";

export const TEST_LIMITS: QuotaLimits = {
  burst: 3,
  burstWindowSeconds: 60,
  sustained: 5,
  sustainedWindowSeconds: 3600,
};

export function quotaContract(name: string, makeStore: () => Promise<QuotaStore>): void {
  describe(`QuotaStore contract: ${name}`, () => {
    let store: QuotaStore;
    let key: string;
    let n = 0;

    beforeEach(async () => {
      store = await makeStore();
      key = `test:${Date.now()}:${n++}`; // fresh identity per test — no cross-test bleed
    });

    it("allows requests below the burst limit", async () => {
      for (let i = 0; i < TEST_LIMITS.burst; i++) {
        expect((await store.consume(key, TEST_LIMITS)).allowed).toBe(true);
      }
    });

    it("refuses once the burst limit is reached, with a positive retry hint (S1)", async () => {
      for (let i = 0; i < TEST_LIMITS.burst; i++) await store.consume(key, TEST_LIMITS);
      const decision = await store.consume(key, TEST_LIMITS);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.retryAfterSeconds).toBeGreaterThan(0);
        expect(decision.retryAfterSeconds).toBeLessThanOrEqual(TEST_LIMITS.burstWindowSeconds);
      }
    });

    it("keeps identities independent (S2)", async () => {
      const other = `${key}:other`;
      for (let i = 0; i < TEST_LIMITS.burst; i++) await store.consume(key, TEST_LIMITS);
      expect((await store.consume(key, TEST_LIMITS)).allowed).toBe(false);
      expect((await store.consume(other, TEST_LIMITS)).allowed).toBe(true);
    });

    it("does not consume quota for refused requests", async () => {
      for (let i = 0; i < TEST_LIMITS.burst; i++) await store.consume(key, TEST_LIMITS);
      // Hammer while refused. If refusals consumed the sustained window, these would exhaust
      // it (burst 3 + 10 refusals > sustained 5) and the caller would stay locked out well
      // past the burst window it actually breached.
      for (let i = 0; i < 10; i++) {
        expect((await store.consume(key, TEST_LIMITS)).allowed).toBe(false);
      }
      expect(await store.usage(key)).toEqual({ burst: 3, sustained: 3 });
    });

    it("keeps state bounded as identities accumulate (S6)", async () => {
      // An attacker minting fresh subs must not grow the store without bound. Redis enforces
      // this with TTLs; the in-memory oracle must hold the same property or the two stores are
      // not equivalent where it matters most.
      const short = { ...TEST_LIMITS, burstWindowSeconds: 1, sustainedWindowSeconds: 1 };
      for (let i = 0; i < 1200; i++) await store.consume(`${key}:churn:${i}`, short);
      await new Promise((r) => setTimeout(r, 1100)); // let every window expire
      await store.consume(`${key}:churn:final`, short);
      expect(await store.usage(`${key}:churn:0`)).toEqual({ burst: 0, sustained: 0 });
    });

    it("refuses on the sustained window even when the burst window is clear", async () => {
      const wide: QuotaLimits = { ...TEST_LIMITS, burst: 100, burstWindowSeconds: 60 };
      for (let i = 0; i < wide.sustained; i++) {
        expect((await store.consume(key, wide)).allowed).toBe(true);
      }
      const decision = await store.consume(key, wide);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.retryAfterSeconds).toBeGreaterThan(TEST_LIMITS.burstWindowSeconds);
      }
    });
  });
}
