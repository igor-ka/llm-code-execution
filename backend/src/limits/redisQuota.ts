/**
 * Redis-backed QuotaStore — the production store (D1). Shared state is required because a
 * per-user budget is global: the same sub hitting two instances must share one allowance,
 * and Cloud Run autoscales horizontally by default. It also survives a restart, so redeploy
 * is not a quota bypass (S7).
 *
 * One Lua script does the whole decision in a single round trip. Lua is not decoration: the
 * store must READ both windows, refuse without incrementing if either is at its limit, and
 * only then consume both. Split across round trips that read-then-write would race, and a
 * bare INCR would charge callers for requests it refused.
 */
import { createClient } from "redis";
import { log } from "../log.js";
import type { QuotaStore, QuotaLimits, QuotaDecision } from "./quota.js";

/**
 * Hard ceiling on how long a quota check may take. D5 fails OPEN on error — but only an
 * error triggers that, and a command that hangs forever hangs /api/execute forever, which is
 * strictly worse than the fail-closed posture the spec rejected. This timeout is what turns
 * "Redis is unreachable" into a rejection the middleware can actually catch.
 */
const QUOTA_TIMEOUT_MS = 250;

// KEYS[1] burst key, KEYS[2] sustained key
// ARGV: burstLimit, burstWindow, sustainedLimit, sustainedWindow
// Returns 0 when allowed, else the seconds to wait.
const SCRIPT = `
local function retry_for(key, window)
  local ttl = redis.call('TTL', key)
  if ttl < 1 then return window end
  return ttl
end

-- Evaluate BOTH windows and return the longest wait. Returning the burst TTL as soon as the
-- burst window is full would advertise a retry time at which the sustained window is still
-- exhausted, so an obedient client is guaranteed a second 429.
local wait = 0

local burst = tonumber(redis.call('GET', KEYS[1]) or '0')
if burst >= tonumber(ARGV[1]) then
  wait = retry_for(KEYS[1], tonumber(ARGV[2]))
end

local sustained = tonumber(redis.call('GET', KEYS[2]) or '0')
if sustained >= tonumber(ARGV[3]) then
  local s = retry_for(KEYS[2], tonumber(ARGV[4]))
  if s > wait then wait = s end
end

if wait > 0 then return wait end

-- Allowed: consume both windows. EXPIRE only on creation, so a hammering client cannot
-- extend its own window; each key dies a fixed time after the window's first request.
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return 0
`;

/**
 * The two window keys for one identity, forced onto a single cluster slot.
 *
 * The `{…}` is a hash tag: when a key contains one, Redis and Valkey hash **only the tag** to pick
 * the slot. Wrapping the shared prefix therefore guarantees both keys land together, which is not
 * cosmetic — cluster mode refuses any command whose keys span slots, and `consume()` sends both to
 * one `EVAL`:
 *
 *   CROSSSLOT Keys in request don't hash to the same slot
 *
 * Memorystore for Valkey is a cluster even at `shard_count = 1`, so on the deployed service that
 * error was every quota check, and D5's fail-open turned it into silently unmetered requests
 * (#191). Local Redis is a single node with no slots, which is why nothing caught it: the
 * invariant is asserted arithmetically in `tests/limits/quotaKeys.test.ts` instead.
 *
 * Every method that builds these keys goes through here. Two of them drifting apart would leave
 * `usage()` and `ttls()` reading keys `consume()` never wrote — a green test suite over a store
 * that counts nothing.
 *
 * Enough for one shard. A multi-shard instance would also need a cluster-aware client to follow
 * MOVED redirects; the hash tag is what makes that a client change rather than a redesign.
 */
export function quotaKeys(key: string): [burst: string, sustained: string] {
  return [`{${key}}:b`, `{${key}}:s`];
}

export class RedisQuotaStore implements QuotaStore {
  // ReturnType<> rather than RedisClientType: the latter's generic defaults do not line up
  // with what createClient() actually returns and produce a spurious assignability error.
  private readonly client: ReturnType<typeof createClient>;
  // node-redis resolves connect() with the client, not void — hold it as unknown so callers
  // can only await it, never accidentally depend on what it resolves to.
  private connecting: Promise<unknown> | undefined;

  constructor(url: string) {
    // Three settings, all load-bearing for D5. Get any of them wrong and fail-open becomes
    // hang-forever:
    //   disableOfflineQueue - without it, commands issued while the client is reconnecting
    //                         sit in an offline queue indefinitely instead of rejecting.
    //                         isOpen stays TRUE through a disconnect (isReady is the flag
    //                         that flips), so nothing else would catch this.
    //   reconnectStrategy   - must eventually return an Error, or the client retries forever
    //                         and never surfaces a failure.
    //   connectTimeout      - bounds the INITIAL connect only; commands are bounded by
    //                         QUOTA_TIMEOUT_MS above.
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (retries) =>
          retries > 5 ? new Error("redis unreachable") : Math.min(retries * 200, 2000),
      },
    });
    // An 'error' listener is mandatory: without one, node-redis emits an unhandled 'error'
    // event and takes the process down, turning D5's fail-open into a crash.
    this.client.on("error", (err: unknown) => {
      log.error("redis client error", { err });
    });
  }

  private async ready(): Promise<ReturnType<typeof createClient>> {
    if (!this.client.isOpen) {
      this.connecting ??= this.client.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    return this.client;
  }

  /** Reject rather than hang. See QUOTA_TIMEOUT_MS. */
  private async bounded<T>(op: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`quota store timed out after ${QUOTA_TIMEOUT_MS}ms`)),
        QUOTA_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([op(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async consume(key: string, limits: QuotaLimits): Promise<QuotaDecision> {
    // The whole operation is bounded, connect included — an unreachable host makes ready()
    // itself slow, not just the command.
    const retryAfter = await this.bounded(async () => {
      const client = await this.ready();
      return (await client.eval(SCRIPT, {
        keys: quotaKeys(key),
        arguments: [
          String(limits.burst),
          String(limits.burstWindowSeconds),
          String(limits.sustained),
          String(limits.sustainedWindowSeconds),
        ],
      })) as number;
    });
    return Number(retryAfter) === 0
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: Number(retryAfter) };
  }

  async usage(key: string): Promise<{ burst: number; sustained: number }> {
    const client = await this.ready();
    const [burstKey, sustainedKey] = quotaKeys(key);
    const [b, s] = await Promise.all([client.get(burstKey), client.get(sustainedKey)]);
    return { burst: Number(b ?? 0), sustained: Number(s ?? 0) };
  }

  /** TTLs of both window keys — used by the S6 regression test. */
  async ttls(key: string): Promise<{ burst: number; sustained: number }> {
    const client = await this.ready();
    const [burstKey, sustainedKey] = quotaKeys(key);
    const [b, s] = await Promise.all([client.ttl(burstKey), client.ttl(sustainedKey)]);
    return { burst: b, sustained: s };
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}
