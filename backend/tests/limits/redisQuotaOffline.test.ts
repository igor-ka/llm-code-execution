/**
 * The fail-open path (D5) only works if an unreachable Redis produces a REJECTION. If the
 * command instead sits in node-redis' offline queue, /api/execute hangs forever — strictly
 * worse than the fail-closed posture the spec rejected. This test is the guard on that, and
 * it needs no live Redis (a closed port is a more faithful outage than a mock), so it runs
 * on every pass rather than hiding behind the REDIS_URL gate.
 */
import { describe, it, expect } from "vitest";
import { RedisQuotaStore } from "../../src/limits/redisQuota.js";
import { TEST_LIMITS } from "./quotaContract.js";

describe("RedisQuotaStore when Redis is unreachable", () => {
  it("rejects within a bounded time instead of hanging (S9)", async () => {
    // Port chosen to have nothing listening; connect fails with ECONNREFUSED.
    const store = new RedisQuotaStore("redis://127.0.0.1:6390");
    const started = Date.now();
    await expect(store.consume("offline-key", TEST_LIMITS)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    await store.close().catch(() => {});
  });
});
