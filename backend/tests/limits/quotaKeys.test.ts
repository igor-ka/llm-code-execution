/**
 * The two quota window keys must land on the SAME cluster slot.
 *
 * Memorystore for Valkey is always a cluster, even at `shard_count = 1`, and in cluster mode every
 * key in one command must hash to the same slot. `consume()` passes two keys to a single `EVAL`,
 * so keys that hash apart make the whole script fail with:
 *
 *   CROSSSLOT Keys in request don't hash to the same slot
 *
 * D5 fails OPEN on a quota-store error, so the effect is not a visible outage — it is silently
 * unmetered requests. That is #191, and it ran in production undetected.
 *
 * Local Redis is a single node with no slots at all, so neither the integration suite nor any
 * amount of manual testing against docker-compose can reproduce it. This suite therefore asserts
 * the invariant arithmetically rather than behaviourally: it computes the slot the way Redis and
 * Valkey do and requires the two keys to agree.
 */
import { describe, it, expect } from "vitest";
import { quotaKeys } from "../../src/limits/redisQuota.js";

/**
 * CRC16/XMODEM over the hash-tag substring, mod 16384 — the algorithm from the Redis cluster
 * specification. If a `{…}` tag is present and non-empty, only its contents are hashed; that is
 * the entire mechanism for forcing two keys onto one slot.
 */
function crc16(input: string): number {
  const bytes = Buffer.from(input, "utf8");
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function slot(key: string): number {
  const open = key.indexOf("{");
  if (open !== -1) {
    const close = key.indexOf("}", open + 1);
    if (close > open + 1) return crc16(key.slice(open + 1, close)) % 16384;
  }
  return crc16(key) % 16384;
}

describe("cluster slot arithmetic used by these tests", () => {
  // A test that carries its own implementation of someone else's algorithm can pass vacuously by
  // being wrong in both places. This is CRC16/XMODEM's published check value, and the worked
  // example from the Redis cluster spec.
  it("matches the published CRC16/XMODEM check value", () => {
    expect(crc16("123456789")).toBe(0x31c3);
  });

  it("hashes only the hash tag, per the cluster spec", () => {
    expect(slot("{user1000}.following")).toBe(slot("{user1000}.followers"));
    expect(slot("foo")).not.toBe(slot("bar"));
  });
});

describe("quotaKeys", () => {
  it.each([
    "quota:auth0|abc123",
    "quota:v993Ljhr45IX1VHJaPzHsgXDoErJKaCj@clients",
    "quota:ip:203.0.113.9",
    // Braces in the identity itself must not split the tag and reintroduce the bug.
    "quota:weird{sub}name",
  ])("puts both window keys on one slot for %s", (key) => {
    const [burst, sustained] = quotaKeys(key);
    expect(burst).not.toBe(sustained);
    expect(slot(burst)).toBe(slot(sustained));
  });

  it("keeps different identities on independent keys", () => {
    const [aBurst] = quotaKeys("quota:a");
    const [bBurst] = quotaKeys("quota:b");
    expect(aBurst).not.toBe(bBurst);
  });
});
