/**
 * Redis QuotaStore against a live server. Self-skips without REDIS_URL, mirroring the
 * DATABASE_URL-gated Postgres suites — and with the same trap: a green ./verify.sh does NOT
 * mean these ran. Use `REDIS_URL=... ./verify.sh test:integration`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { RedisQuotaStore } from "../../src/limits/redisQuota.js";
import { quotaContract, TEST_LIMITS } from "./quotaContract.js";

const url = process.env.REDIS_URL;
const stores: RedisQuotaStore[] = [];

describe.skipIf(!url)("RedisQuotaStore", () => {
  quotaContract("RedisQuotaStore", async () => {
    const store = new RedisQuotaStore(url!);
    stores.push(store);
    return store;
  });

  it("sets a TTL on every key it creates (S6)", async () => {
    const store = new RedisQuotaStore(url!);
    stores.push(store);
    const key = `test:ttl:${Date.now()}`;
    await store.consume(key, TEST_LIMITS);
    const ttls = await store.ttls(key);
    // An attacker minting fresh subs must not be able to grow Redis without bound: every key
    // this store writes expires.
    expect(ttls.burst).toBeGreaterThan(0);
    expect(ttls.sustained).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
  });
});
