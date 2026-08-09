# Per-user rate limiting and quotas — Implementation Plan

**Goal:** Stop one caller from exhausting the Anthropic budget or the host, by adding a
Redis-backed per-user request quota ahead of the LLM call and an in-process cap on concurrent
sandbox executions.

**Architecture:** Two independent controls, matching the two resources. A `QuotaStore` seam
(in-memory + Redis, same shape as the existing `HistoryStore`) is consulted by an Express
middleware mounted after `requirePrincipal` and before `llm.generate`; it fails **open** on any
store error (D5). A `ConcurrencyLimiter` counts in-process slots; a `ConcurrencyLimitedBackend`
decorator wraps any `SandboxBackend` to enforce them, and `/api/execute` peeks at saturation
before spending on the LLM. Refusals travel through the existing `HttpError` → `{detail}` path.

**Tech Stack:** TypeScript, Express 5, `redis` (node-redis v5) with one Lua script for atomicity,
Vitest, Docker Compose.

**Spec:** [`docs/specs/2026-08-08-per-user-rate-limiting.md`](../specs/2026-08-08-per-user-rate-limiting.md)
— decisions D1–D8 and criteria S1–S11 are referenced by name throughout. **Read it first.**

---

## Design notes the tasks assume

Four points that are load-bearing and easy to get wrong.

**1. Why the quota consults Redis but the cap does not (D8).** A per-user budget is global — the
same `sub` hitting two instances must share one allowance, so the counter lives in Redis. Host
capacity is *local*: each instance protects the host it runs on, so an in-process count is the
correct semantics under horizontal scaling, not a compromise.

**2. Two enforcement points for one cap, and why.** S3 requires that a refused request cost zero
Anthropic spend, but the authoritative slot acquisition can only happen at the moment of execution
— which is *after* `llm.generate`. So `/api/execute` does a cheap `limiter.saturated` peek before
the LLM call (fast-fail, saves the spend in the common saturated case) and the decorator does the
real `tryAcquire()` at launch. **Residual, accepted:** a request that passes the peek can still be
refused at acquire, having already paid for one LLM call. The alternative — holding a sandbox slot
across the whole LLM call — would idle scarce slots for seconds and would make no-code-path
requests consume sandbox capacity they never use.

**3. The counter needs no lock.** Node is single-threaded and `tryAcquire()` contains no `await`
between reading and incrementing `active`, so the check-and-increment is atomic within a tick. A
mutex here would be cargo cult.

**4. Denied requests must not consume quota.** A naive `INCR`-then-compare charges the caller for
requests it refused, so a client in a retry loop burns its own sustained window without ever
succeeding. The Lua script in Task 3 therefore *reads* both windows, refuses without incrementing
if either is already at its limit, and only consumes when it is going to allow. Lua makes that
read-then-write atomic; doing it in two round trips would race.

---

## File structure

| File | Responsibility |
| --- | --- |
| `backend/src/limits/quota.ts` | `QuotaStore` seam, `QuotaDecision` type, key derivation |
| `backend/src/limits/memoryQuota.ts` | In-memory `QuotaStore` — tests, and the oracle for the contract suite |
| `backend/src/limits/redisQuota.ts` | Redis `QuotaStore` (one Lua script, one round trip) |
| `backend/src/limits/middleware.ts` | Express middleware: derive key, consume, 429 or fail open |
| `backend/src/limits/concurrency.ts` | `ConcurrencyLimiter` — in-process slot counting |
| `backend/src/sandbox/concurrencyLimited.ts` | `SandboxBackend` decorator enforcing the limiter |
| `backend/src/config.ts` | *(modify)* new settings + `assertRedisConfigured` |
| `backend/src/errors.ts` | *(modify)* `HttpError` carries `retryAfterSeconds` |
| `backend/src/server.ts` | *(modify)* mount middleware, saturation peek, expose header, wire decorator |
| `backend/src/index.ts` | *(modify)* D6 boot check — composition root only |
| `frontend/src/api.ts` | *(modify)* typed `ApiError` carrying status + retry hint |

Tests mirror the source tree under `backend/tests/limits/`.

---

## Task 1: Configuration

**Files:**
- Modify: `backend/src/config.ts`
- Test: `backend/tests/config.test.ts`

**Why `assertRedisConfigured` is separate from `loadSettings`:** S10. Every backend test calls
`loadSettings({})`; if that threw on a missing `REDIS_URL`, the whole suite would need Redis. The
check is a standalone function called only from `index.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/config.test.ts`:

```ts
import { loadSettings, assertRedisConfigured } from "../src/config.js";

describe("rate-limit settings", () => {
  it("defaults are conservative and safe", () => {
    const s = loadSettings({});
    expect(s.redisUrl).toBe("");
    expect(s.quotaBurst).toBe(10);
    expect(s.quotaBurstWindowSeconds).toBe(60);
    expect(s.quotaSustained).toBe(100);
    expect(s.quotaSustainedWindowSeconds).toBe(3600);
    expect(s.sandboxMaxConcurrent).toBe(4);
  });

  it("reads overrides from the environment", () => {
    const s = loadSettings({
      REDIS_URL: "redis://localhost:6379",
      RATE_LIMIT_BURST: "3",
      RATE_LIMIT_BURST_WINDOW_SECONDS: "5",
      RATE_LIMIT_SUSTAINED: "30",
      RATE_LIMIT_SUSTAINED_WINDOW_SECONDS: "600",
      SANDBOX_MAX_CONCURRENT: "2",
    });
    expect(s.redisUrl).toBe("redis://localhost:6379");
    expect(s.quotaBurst).toBe(3);
    expect(s.quotaBurstWindowSeconds).toBe(5);
    expect(s.quotaSustained).toBe(30);
    expect(s.quotaSustainedWindowSeconds).toBe(600);
    expect(s.sandboxMaxConcurrent).toBe(2);
  });

  it("assertRedisConfigured throws when REDIS_URL is empty (D6)", () => {
    expect(() => assertRedisConfigured(loadSettings({}))).toThrow(/REDIS_URL/);
  });

  it("assertRedisConfigured passes when REDIS_URL is set", () => {
    expect(() =>
      assertRedisConfigured(loadSettings({ REDIS_URL: "redis://localhost:6379" })),
    ).not.toThrow();
  });

  it("loadSettings itself never throws without REDIS_URL (S10)", () => {
    expect(() => loadSettings({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/config.test.ts`
Expected: FAIL — `assertRedisConfigured` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/config.ts`, add to the `Settings` interface (after `historyEnabled`):

```ts
  redisUrl: string;
  quotaBurst: number;
  quotaBurstWindowSeconds: number;
  quotaSustained: number;
  quotaSustainedWindowSeconds: number;
  sandboxMaxConcurrent: number;
```

Add to the object returned by `loadSettings` (after `historyEnabled`):

```ts
    // Rate limiting. Defaults are deliberately conservative: 10 requests/minute of burst
    // and 100/hour sustained per identity, and 4 concurrent sandboxes (at 256 MB and 0.5
    // CPU each, roughly what a 4-core/8 GB dev box tolerates). All tunable; see
    // docs/specs/2026-08-08-per-user-rate-limiting.md.
    redisUrl: str(env.REDIS_URL, ""),
    quotaBurst: num(env.RATE_LIMIT_BURST, 10),
    quotaBurstWindowSeconds: num(env.RATE_LIMIT_BURST_WINDOW_SECONDS, 60),
    quotaSustained: num(env.RATE_LIMIT_SUSTAINED, 100),
    quotaSustainedWindowSeconds: num(env.RATE_LIMIT_SUSTAINED_WINDOW_SECONDS, 3600),
    sandboxMaxConcurrent: num(env.SANDBOX_MAX_CONCURRENT, 4),
```

Append at the end of the file:

```ts
/**
 * Fail fast when the quota store is not configured (D6): the backend refuses to start
 * rather than run with the budget control silently absent.
 *
 * Deliberately NOT part of loadSettings(): createApp is the seam every backend test builds
 * on, and a hard Redis dependency there would become a hard dependency of every unit test
 * (S10). Call this from the composition root only — see src/index.ts.
 */
export function assertRedisConfigured(settings: Settings): void {
  if (settings.redisUrl === "") {
    throw new Error(
      "REDIS_URL is not set. The per-user request quota requires Redis; the backend " +
        "refuses to start without it rather than serve traffic unprotected. " +
        "Set REDIS_URL (docker-compose provides one at redis://redis:6379).",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.ts backend/tests/config.test.ts
git commit -m "feat(limits): rate-limit settings + assertRedisConfigured (D6, S10)"
```

---

## Task 2: The `QuotaStore` seam and its in-memory implementation

**Files:**
- Create: `backend/src/limits/quota.ts`, `backend/src/limits/memoryQuota.ts`
- Test: `backend/tests/limits/quotaContract.ts`, `backend/tests/limits/memoryQuota.test.ts`

The contract suite is a shared function, exactly like the `HistoryStore` one: Task 3 runs the same
suite against Redis, so the two implementations cannot diverge.

- [ ] **Step 1: Write the failing contract suite**

Create `backend/tests/limits/quotaContract.ts`:

```ts
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

    it("does not consume quota for refused requests (design note 4)", async () => {
      for (let i = 0; i < TEST_LIMITS.burst; i++) await store.consume(key, TEST_LIMITS);
      // Hammer while refused. If refusals consumed the sustained window, these would
      // exhaust it (burst 3 + 10 refusals > sustained 5) and the caller would stay locked
      // out past the burst window.
      for (let i = 0; i < 10; i++) {
        expect((await store.consume(key, TEST_LIMITS)).allowed).toBe(false);
      }
      expect(await store.usage(key)).toEqual({ burst: 3, sustained: 3 });
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
```

Create `backend/tests/limits/memoryQuota.test.ts`:

```ts
import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import { quotaContract } from "./quotaContract.js";

quotaContract("MemoryQuotaStore", async () => new MemoryQuotaStore());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/limits/memoryQuota.test.ts`
Expected: FAIL — cannot resolve `../../src/limits/quota.js`.

- [ ] **Step 3: Write the seam**

Create `backend/src/limits/quota.ts`:

```ts
/**
 * Per-user request quota seam. Same shape as the HistoryStore seam: one interface, an
 * in-memory implementation used by unit tests, and a real one used in production, with a
 * single shared contract suite proving they behave identically.
 *
 * Counting requests (not tokens) is deliberate — see D3 in the spec. Refusals are decided
 * BEFORE llm.generate so a refused request costs nothing (S3).
 */

export interface QuotaLimits {
  burst: number;
  burstWindowSeconds: number;
  sustained: number;
  sustainedWindowSeconds: number;
}

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface QuotaStore {
  /**
   * Charge one request against `key`. Returns allowed:false WITHOUT consuming quota when
   * either window is already at its limit, so a client in a retry loop cannot burn its own
   * sustained allowance while being refused.
   */
  consume(key: string, limits: QuotaLimits): Promise<QuotaDecision>;
  /** Current counts — for tests and diagnostics only. */
  usage(key: string): Promise<{ burst: number; sustained: number }>;
  /** Release resources (connections). No-op for the in-memory store. */
  close(): Promise<void>;
}

/**
 * Bucket key for a principal. Anonymous callers share ONE bucket (D2): with
 * AUTH_REQUIRED=false there is no sub to key on, and keying on IP would mean trusting
 * X-Forwarded-For — a spoofable header, and therefore a limiter bypass. A single shared
 * anonymous bucket is effectively a global rate limit, which is the right posture for a
 * mode that only exists for local development.
 */
export function quotaKey(userId: string | null): string {
  return userId === null ? "quota:anon" : `quota:user:${userId}`;
}
```

- [ ] **Step 4: Write the in-memory implementation**

Create `backend/src/limits/memoryQuota.ts`:

```ts
/**
 * In-memory QuotaStore: fixed windows held in a Map. Correct for a single process and used
 * by the unit suites as the oracle for the Redis implementation.
 *
 * NOT the production store — a per-process counter would give N instances N x the intended
 * limit and would reset on every restart, making redeploy a quota bypass (D1, S7).
 */
import type { QuotaStore, QuotaLimits, QuotaDecision } from "./quota.js";

interface Window {
  count: number;
  resetAtMs: number;
}

export class MemoryQuotaStore implements QuotaStore {
  private readonly windows = new Map<string, Window>();

  private bump(key: string, windowSeconds: number, limit: number, consume: boolean): number {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAtMs) {
      w = { count: 0, resetAtMs: now + windowSeconds * 1000 };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return Math.max(1, Math.ceil((w.resetAtMs - now) / 1000));
    if (consume) w.count += 1;
    return 0;
  }

  async consume(key: string, limits: QuotaLimits): Promise<QuotaDecision> {
    // Check both windows before consuming either, so a refusal charges nothing and a
    // partial charge is impossible.
    const burstRetry = this.bump(`${key}:b`, limits.burstWindowSeconds, limits.burst, false);
    if (burstRetry > 0) return { allowed: false, retryAfterSeconds: burstRetry };
    const sustainedRetry = this.bump(
      `${key}:s`,
      limits.sustainedWindowSeconds,
      limits.sustained,
      false,
    );
    if (sustainedRetry > 0) return { allowed: false, retryAfterSeconds: sustainedRetry };

    this.bump(`${key}:b`, limits.burstWindowSeconds, limits.burst, true);
    this.bump(`${key}:s`, limits.sustainedWindowSeconds, limits.sustained, true);
    return { allowed: true };
  }

  async usage(key: string): Promise<{ burst: number; sustained: number }> {
    const now = Date.now();
    const read = (k: string): number => {
      const w = this.windows.get(k);
      return !w || now >= w.resetAtMs ? 0 : w.count;
    };
    return { burst: read(`${key}:b`), sustained: read(`${key}:s`) };
  }

  async close(): Promise<void> {}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run tests/limits/memoryQuota.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/limits/quota.ts backend/src/limits/memoryQuota.ts backend/tests/limits/
git commit -m "feat(limits): QuotaStore seam, in-memory store, shared contract suite"
```

---

## Task 3: The Redis quota store

**Files:**
- Create: `backend/src/limits/redisQuota.ts`
- Test: `backend/tests/limits/redisQuota.test.ts`
- Modify: `backend/package.json`

Gated on `REDIS_URL` exactly like the Postgres suites are gated on `DATABASE_URL` — **and it
carries the same trap: a green `verify.sh` is not evidence this ran.**

- [ ] **Step 1: Add the dependency**

```bash
cd backend && npm install redis@^5.0.0
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/limits/redisQuota.test.ts`:

```ts
/**
 * Redis QuotaStore against a live server. Self-skips without REDIS_URL, mirroring the
 * DATABASE_URL-gated Postgres suites — and with the same trap: a green ./verify.sh does
 * NOT mean these ran. Use `REDIS_URL=... ./verify.sh test:integration`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { RedisQuotaStore } from "../../src/limits/redisQuota.js";
import { quotaContract, TEST_LIMITS } from "./quotaContract.js";

const url = process.env.REDIS_URL;

describe.skipIf(!url)("RedisQuotaStore", () => {
  const stores: RedisQuotaStore[] = [];

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
    // An untrusted attacker minting fresh subs must not be able to grow Redis without
    // bound: every key this store writes expires.
    expect(ttls.burst).toBeGreaterThan(0);
    expect(ttls.sustained).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && REDIS_URL=redis://localhost:6379 npx vitest run tests/limits/redisQuota.test.ts`
Expected: FAIL — cannot resolve `redisQuota.js`. (Start Redis first:
`docker run --rm -p 6379:6379 redis:7-alpine`.)

- [ ] **Step 4: Write the implementation**

Create `backend/src/limits/redisQuota.ts`:

```ts
/**
 * Redis-backed QuotaStore — the production store (D1). Shared state is required because a
 * per-user budget is global: the same sub hitting two instances must share one allowance,
 * and Cloud Run autoscales horizontally by default.
 *
 * One Lua script does the whole decision in a single round trip. Lua is not decoration:
 * the store must READ both windows, refuse without incrementing if either is at its limit,
 * and only then consume both. Split across round trips that read-then-write would race, and
 * a bare INCR would charge callers for requests it refused.
 */
import { createClient, type RedisClientType } from "redis";
import type { QuotaStore, QuotaLimits, QuotaDecision } from "./quota.js";

// KEYS[1] burst key, KEYS[2] sustained key
// ARGV: burstLimit, burstWindow, sustainedLimit, sustainedWindow
// Returns 0 when allowed, else the seconds to wait.
const SCRIPT = `
local function retry_for(key, window)
  local ttl = redis.call('TTL', key)
  if ttl < 1 then return window end
  return ttl
end

local burst = tonumber(redis.call('GET', KEYS[1]) or '0')
if burst >= tonumber(ARGV[1]) then
  return retry_for(KEYS[1], tonumber(ARGV[2]))
end

local sustained = tonumber(redis.call('GET', KEYS[2]) or '0')
if sustained >= tonumber(ARGV[3]) then
  return retry_for(KEYS[2], tonumber(ARGV[4]))
end

-- Allowed: consume both windows. EXPIRE only on creation, so a hammering client cannot
-- extend its own window; each key dies a fixed time after the window's first request.
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return 0
`;

export class RedisQuotaStore implements QuotaStore {
  private readonly client: RedisClientType;
  private connecting: Promise<void> | undefined;

  constructor(url: string) {
    // Do not let node-redis retry forever: the middleware fails open (D5), so a request
    // must find out quickly that Redis is gone rather than hanging on /api/execute.
    this.client = createClient({
      url,
      socket: { connectTimeout: 1000, reconnectStrategy: (retries) => Math.min(retries * 200, 2000) },
    });
    // An 'error' listener is mandatory — without one, node-redis emits an unhandled
    // 'error' event and takes the process down, turning D5's fail-open into a crash.
    this.client.on("error", (err) => {
      console.error("[quota] redis error:", err instanceof Error ? err.message : err);
    });
  }

  private async ready(): Promise<RedisClientType> {
    if (!this.client.isOpen) {
      this.connecting ??= this.client.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    return this.client;
  }

  async consume(key: string, limits: QuotaLimits): Promise<QuotaDecision> {
    const client = await this.ready();
    const retryAfter = (await client.eval(SCRIPT, {
      keys: [`${key}:b`, `${key}:s`],
      arguments: [
        String(limits.burst),
        String(limits.burstWindowSeconds),
        String(limits.sustained),
        String(limits.sustainedWindowSeconds),
      ],
    })) as number;
    return retryAfter === 0
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: Number(retryAfter) };
  }

  async usage(key: string): Promise<{ burst: number; sustained: number }> {
    const client = await this.ready();
    const [b, s] = await Promise.all([client.get(`${key}:b`), client.get(`${key}:s`)]);
    return { burst: Number(b ?? 0), sustained: Number(s ?? 0) };
  }

  /** TTLs of both window keys — used by the S6 regression test. */
  async ttls(key: string): Promise<{ burst: number; sustained: number }> {
    const client = await this.ready();
    const [b, s] = await Promise.all([client.ttl(`${key}:b`), client.ttl(`${key}:s`)]);
    return { burst: b, sustained: s };
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}
```

> `close()` is the node-redis **v5** teardown method. If `npm install` resolves v4 instead, use
> `await this.client.quit()` — check the installed major before assuming.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && REDIS_URL=redis://localhost:6379 npx vitest run tests/limits/redisQuota.test.ts`
Expected: PASS — 6 tests (5 contract + the TTL regression).

Then confirm the gate works:
Run: `cd backend && npx vitest run tests/limits/redisQuota.test.ts`
Expected: skipped, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add backend/src/limits/redisQuota.ts backend/tests/limits/redisQuota.test.ts \
        backend/package.json backend/package-lock.json
git commit -m "feat(limits): Redis quota store — atomic two-window Lua, TTL on every key"
```

---

## Task 4: `HttpError` carries a retry hint

**Files:**
- Modify: `backend/src/errors.ts`, `backend/src/server.ts`
- Test: `backend/tests/main.test.ts`

Both refusals need `Retry-After`. **The header is invisible to the SPA today** — it is not
CORS-safelisted and `server.ts` sets no `exposedHeaders`, so the browser cannot read it
cross-origin. Exposing it via CORS is the fix (D7); inventing a parallel JSON field would be a
second channel for the same fact.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/main.test.ts`:

```ts
it("serialises a retry hint as Retry-After and exposes it to the browser (D7)", async () => {
  const app = createApp({
    settings: openSettings(),
    llm: { generate: async () => { throw new HttpError(429, "Too many requests", 42); } } as never,
  });
  const resp = await request(app).post("/api/execute").send({ prompt: "hi" });
  expect(resp.status).toBe(429);
  expect(resp.body).toEqual({ detail: "Too many requests" });
  expect(resp.headers["retry-after"]).toBe("42");
  expect(resp.headers["access-control-expose-headers"]).toContain("Retry-After");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/main.test.ts -t "retry hint"`
Expected: FAIL — `HttpError` takes 2 arguments.

- [ ] **Step 3: Extend `HttpError`**

Replace the body of `backend/src/errors.ts`:

```ts
/** An error carrying an HTTP status and a `detail` string (the shape the SPA reads). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    /** Seconds until the caller may retry — emitted as the Retry-After header. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}
```

- [ ] **Step 4: Emit and expose the header**

In `backend/src/server.ts`, change the CORS line (currently line 43):

```ts
  // Retry-After is not a CORS-safelisted response header, so without exposedHeaders the
  // cross-origin SPA cannot read it at all — the throttling UI would have no retry hint.
  app.use(cors({ origin: settings.frontendOrigin, exposedHeaders: ["Retry-After"] }));
```

In the final error handler, replace the whole `err instanceof HttpError` branch with:

```ts
      if (err instanceof HttpError) {
        if (err.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(err.retryAfterSeconds));
        }
        res.status(err.status).json({ detail: err.detail });
        return;
      }
```

If `main.test.ts` does not already import `HttpError`, add
`import { HttpError } from "../src/errors.js";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run tests/main.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/errors.ts backend/src/server.ts backend/tests/main.test.ts
git commit -m "feat(limits): HttpError carries Retry-After; expose it via CORS (D7)"
```

---

## Task 5: Quota middleware, mounted before the LLM call

**Files:**
- Create: `backend/src/limits/middleware.ts`
- Test: `backend/tests/limits/middleware.test.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/limits/middleware.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import type { QuotaStore } from "../../src/limits/quota.js";
import { fakePrincipal } from "../helpers/auth.js";

const settings = () =>
  loadSettings({ AUTH_REQUIRED: "false", ANTHROPIC_API_KEY: "test", RATE_LIMIT_BURST: "2" });

const noCodeLlm = { generate: async () => ({ shouldExecute: false, message: "nope", language: null, code: null }) };

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
      consume: async () => { throw new Error("ECONNREFUSED"); },
      usage: async () => ({ burst: 0, sustained: 0 }),
      close: async () => {},
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(app(broken)).post("/api/execute").send({ prompt: "1" }).expect(200);
    expect(spy).toHaveBeenCalled(); // silence would violate S9
    spy.mockRestore();
  });

  it("shares one bucket across anonymous callers (D2)", async () => {
    const store = new MemoryQuotaStore();
    await request(app(store, null)).post("/api/execute").send({ prompt: "1" }).expect(200);
    await request(app(store, null)).post("/api/execute").send({ prompt: "2" }).expect(200);
    await request(app(store, null)).post("/api/execute").send({ prompt: "3" }).expect(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/limits/middleware.test.ts`
Expected: FAIL — `createApp` has no `quota` dependency.

- [ ] **Step 3: Write the middleware**

Create `backend/src/limits/middleware.ts`:

```ts
/**
 * Per-user quota enforcement for /api/execute. Mounted AFTER requirePrincipal (so the
 * identity is the verified sub, never a header) and BEFORE llm.generate, which is what
 * makes a refusal cost zero Anthropic spend (S3).
 */
import type { RequestHandler } from "express";
import type { Principal } from "../auth.js";
import type { QuotaStore, QuotaLimits } from "./quota.js";
import { quotaKey } from "./quota.js";
import { HttpError } from "../errors.js";

export function makeQuotaMiddleware(store: QuotaStore, limits: QuotaLimits): RequestHandler {
  return (_req, res, next) => {
    const principal = (res.locals.principal ?? { userId: null }) as Principal;
    void (async () => {
      let decision;
      try {
        decision = await store.consume(quotaKey(principal.userId), limits);
      } catch (err) {
        // FAIL OPEN (D5). The in-process sandbox concurrency cap still bounds the host, so
        // an outage degrades protection rather than removing it — the exposure narrows to
        // Anthropic spend for its duration. That is precisely why this logs at error level:
        // S9 treats silence here as a defect, because this line is the only thing standing
        // between a Redis outage and an unbounded bill.
        console.error(
          "[quota] store unavailable — FAILING OPEN, requests are unmetered:",
          err instanceof Error ? err.message : err,
        );
        next();
        return;
      }
      if (decision.allowed) {
        next();
        return;
      }
      next(
        new HttpError(
          429,
          "Rate limit exceeded. Please wait before sending another request.",
          decision.retryAfterSeconds,
        ),
      );
    })();
  };
}
```

- [ ] **Step 4: Wire it into `createApp`**

In `backend/src/server.ts`, add to `AppDeps`:

```ts
  quota?: QuotaStore; // per-user request quota (D1); tests inject MemoryQuotaStore
```

Add the imports:

```ts
import type { QuotaStore } from "./limits/quota.js";
import { RedisQuotaStore } from "./limits/redisQuota.js";
import { makeQuotaMiddleware } from "./limits/middleware.js";
```

After the `getHistory` block, add the store and middleware:

```ts
  // Quota store seam. Tests inject deps.quota and win outright; production builds one
  // RedisQuotaStore over a single connection. index.ts has already refused to boot if
  // REDIS_URL is unset (D6), so an empty url here only happens in tests that inject.
  const quota: QuotaStore | undefined =
    deps.quota ?? (settings.redisUrl ? new RedisQuotaStore(settings.redisUrl) : undefined);
  const quotaMiddleware: RequestHandler = quota
    ? makeQuotaMiddleware(quota, {
        burst: settings.quotaBurst,
        burstWindowSeconds: settings.quotaBurstWindowSeconds,
        sustained: settings.quotaSustained,
        sustainedWindowSeconds: settings.quotaSustainedWindowSeconds,
      })
    : (_req, _res, next) => next();
```

Change the `/api/execute` route signature so the quota runs after auth and before the body:

```ts
  app.post("/api/execute", requirePrincipal, quotaMiddleware, async (req, res, next) => {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run tests/limits/middleware.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/limits/middleware.ts backend/src/server.ts backend/tests/limits/middleware.test.ts
git commit -m "feat(limits): enforce the per-user quota before the LLM call (S1-S4, D5)"
```

---

## Task 6: Sandbox concurrency cap

**Files:**
- Create: `backend/src/limits/concurrency.ts`, `backend/src/sandbox/concurrencyLimited.ts`
- Test: `backend/tests/limits/concurrency.test.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/limits/concurrency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { ConcurrencyLimiter } from "../../src/limits/concurrency.js";
import { ConcurrencyLimitedBackend } from "../../src/sandbox/concurrencyLimited.js";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import { fakePrincipal } from "../helpers/auth.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";
import { HttpError } from "../../src/errors.js";

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
    const throwing: SandboxBackend = { execute: async () => { throw new Error("boom"); } };
    const wrapped = new ConcurrencyLimitedBackend(throwing, limiter);
    await expect(wrapped.execute("x", "python", {} as never)).rejects.toThrow("boom");
    expect(limiter.saturated).toBe(false); // leak here would wedge the service permanently
  });

  it("refuses with 503 rather than launching beyond the cap (S5)", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const throwing: SandboxBackend = { execute: async () => { throw new Error("unreached"); } };
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
      settings: loadSettings({ AUTH_REQUIRED: "false", ANTHROPIC_API_KEY: "t", RATE_LIMIT_BURST: "100" }),
      llm: { generate: async () => ({ shouldExecute: true, language: "python", code: "print(1)", message: null }) } as never,
      sandbox: new ConcurrencyLimitedBackend(backend, limiter),
      sandboxLimiter: limiter, // the peek must consult the SAME limiter as the decorator
      quota: new MemoryQuotaStore(),
      requirePrincipal: fakePrincipal("user-a"),
    });

    const inflight = [0, 1, 2, 3, 4].map(() =>
      request(app).post("/api/execute").send({ prompt: "go" }),
    );
    // Give the three excess requests time to be refused while the two holders block.
    await new Promise((r) => setTimeout(r, 50));
    releaseAll();
    const responses = await Promise.all(inflight);

    expect(peak()).toBeLessThanOrEqual(2);
    expect(responses.filter((r) => r.status === 503).length).toBeGreaterThan(0);
    for (const r of responses.filter((x) => x.status === 503)) {
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/limits/concurrency.test.ts`
Expected: FAIL — cannot resolve `concurrency.js`.

- [ ] **Step 3: Write the limiter**

Create `backend/src/limits/concurrency.ts`:

```ts
/**
 * In-process cap on concurrent sandbox executions.
 *
 * In-process is the CORRECT semantics here, not a compromise (D8): each backend instance
 * protects the host it runs on, so the count is naturally per-instance — unlike the per-user
 * quota, which is a global budget and therefore lives in Redis.
 *
 * No mutex: Node is single-threaded and tryAcquire() has no await between reading and
 * incrementing `active`, so the check-and-increment is atomic within a tick.
 */
export class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly max: number) {}

  get saturated(): boolean {
    return this.active >= this.max;
  }

  /**
   * Take a slot, or null when full. The returned function releases it and is idempotent —
   * a double release must not invent capacity, and a leaked slot wedges the service for the
   * lifetime of the process.
   */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
```

- [ ] **Step 4: Write the decorator**

Create `backend/src/sandbox/concurrencyLimited.ts`:

```ts
/**
 * SandboxBackend decorator enforcing the concurrency cap. A decorator rather than a change
 * inside DockerBackend so the future CloudRunBackend inherits the cap unchanged and
 * DockerBackend keeps one responsibility.
 *
 * Rejecting is within the base contract: that contract forbids rejecting on ordinary
 * program failure (non-zero exit, stderr, timeout), which this is not — it is a refusal to
 * start at all.
 */
import type { SandboxBackend, ExecutionLimits } from "./base.js";
import type { SandboxResult } from "../schemas.js";
import type { ConcurrencyLimiter } from "../limits/concurrency.js";
import { HttpError } from "../errors.js";

/** Seconds hinted to a caller refused at the cap — a slot frees within one sandbox timeout. */
const RETRY_AFTER_SECONDS = 5;

export class ConcurrencyLimitedBackend implements SandboxBackend {
  constructor(
    private readonly inner: SandboxBackend,
    private readonly limiter: ConcurrencyLimiter,
  ) {}

  async execute(code: string, language: string, limits: ExecutionLimits): Promise<SandboxResult> {
    const release = this.limiter.tryAcquire();
    if (release === null) {
      // 503, not 429: the quota already passed, so this caller is inside its own allowance
      // and is being refused because of OTHER users' load. 429 would blame the wrong party.
      throw new HttpError(
        503,
        "The service is at capacity. Please retry in a few seconds.",
        RETRY_AFTER_SECONDS,
      );
    }
    try {
      return await this.inner.execute(code, language, limits);
    } finally {
      release();
    }
  }
}
```

- [ ] **Step 5: Wire it in, with the pre-LLM peek**

In `backend/src/server.ts`, add the imports:

```ts
import { ConcurrencyLimiter } from "./limits/concurrency.js";
import { ConcurrencyLimitedBackend } from "./sandbox/concurrencyLimited.js";
```

Add to `AppDeps`:

```ts
  sandboxLimiter?: ConcurrencyLimiter; // test seam: share one limiter with an injected sandbox
```

Replace the `getSandbox` block:

```ts
  // One limiter per app, shared by the decorator (authoritative) and the peek below.
  // Injectable because tests that supply their own wrapped `sandbox` must be able to hand
  // the peek the SAME limiter — otherwise the peek consults an idle counter and the two
  // enforcement points silently diverge under test while sharing one limiter in production.
  const sandboxLimiter =
    deps.sandboxLimiter ?? new ConcurrencyLimiter(settings.sandboxMaxConcurrent);
  let sandbox = deps.sandbox;
  const getSandbox = (): SandboxBackend => {
    if (!sandbox) {
      sandbox = new ConcurrencyLimitedBackend(
        new DockerBackend(settings.sandboxImage),
        sandboxLimiter,
      );
    }
    return sandbox;
  };
```

In the `/api/execute` handler, immediately before the `getLlm().generate(prompt)` try block:

```ts
      // Cheap saturation peek BEFORE spending on the LLM (S3). The decorator's tryAcquire is
      // still authoritative — a request can pass here and be refused at launch, having paid
      // for one LLM call. Holding a slot across generation instead would idle scarce capacity
      // for seconds, and no-code-path requests would consume sandboxes they never use.
      if (sandboxLimiter.saturated) {
        throw new HttpError(503, "The service is at capacity. Please retry in a few seconds.", 5);
      }
```

> Note for the implementer: an injected `deps.sandbox` is *not* auto-wrapped — the test wraps it
> itself and passes `deps.sandboxLimiter` so both enforcement points share one counter. Without
> that second injection the peek would consult a limiter nothing ever acquires from, and the test
> would prove only half of what it appears to.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run tests/limits/concurrency.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/limits/concurrency.ts backend/src/sandbox/concurrencyLimited.ts \
        backend/src/server.ts backend/tests/limits/concurrency.test.ts
git commit -m "feat(limits): cap concurrent sandbox executions, 503 on saturation (S5, D8)"
```

---

## Task 7: Refuse to boot without Redis

**Files:**
- Modify: `backend/src/index.ts`
- Test: `backend/tests/limits/boot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/limits/boot.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run tests/limits/boot.test.ts`
Expected: the second test FAILS if the guard was wrongly placed inside `createApp`; both pass
once Task 1 and Task 5 are correct. **This test exists to stay failing if someone later "helpfully"
moves the check into `createApp`.**

- [ ] **Step 3: Add the guard to the composition root**

In `backend/src/index.ts`, as the first statement of `main()`:

```ts
  const settings = getSettings();
  // Fail fast rather than serve traffic with the budget control absent (D6). Deliberately
  // here and not in createApp: createApp is the seam every backend test builds on.
  assertRedisConfigured(settings);
```

and extend the import:

```ts
import { getSettings, assertRedisConfigured } from "./config.js";
```

- [ ] **Step 4: Run tests and verify manually**

Run: `cd backend && npx vitest run tests/limits/boot.test.ts`
Expected: PASS.

Run: `cd backend && REDIS_URL= npx tsx src/index.ts`
Expected: exits non-zero, printing the `REDIS_URL is not set` message. Not listening on :8000.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/tests/limits/boot.test.ts
git commit -m "feat(limits): refuse to boot without REDIS_URL (D6)"
```

---

## Task 8: Infrastructure — Compose, env, CI, verify.sh

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `backend/verify.sh`, `backend/package.json`,
  `.github/workflows/ci.yml`, **`docs/sdlc.md`**

> ⚠️ **This task trips the `SDLC docs` CI job.** It touches `backend/verify.sh` and
> `.github/workflows/**`, and the check requires `docs/sdlc.md` to change in the *same PR*.
> Step 5 does that. Do not reach for `[skip-sdlc-sync]` — this is a real process change, since
> the integration gate stops being about `DATABASE_URL` alone.

- [ ] **Step 1: Add the Redis service to Compose**

In `docker-compose.yml`, add to `services`:

```yaml
  # Quota counters for the per-user rate limiter. Deliberately has NO volume: the counters
  # are windowed and disposable, and losing them on restart costs at most one window of
  # over-allowance. (The backend still refuses to boot without this service — D6.)
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
```

Add to the backend service's `environment`:

```yaml
      # Reach Redis over the compose network by service name (overrides any localhost
      # REDIS_URL from .env, which is only correct for host-run processes).
      REDIS_URL: redis://redis:6379
```

Add to the backend service's `depends_on`:

```yaml
      redis:
        condition: service_healthy
```

- [ ] **Step 2: Document the variables**

Append to `.env.example`:

```bash
# --- Rate limiting (Redis) ---
# The per-user request quota is REQUIRED: the backend refuses to start without REDIS_URL
# rather than serve traffic with the budget control absent. The docker-compose `redis`
# service is reachable from the backend container as redis://redis:6379.
REDIS_URL=redis://localhost:6379
# Per-identity request allowance: a short burst window plus a longer sustained one.
RATE_LIMIT_BURST=10
RATE_LIMIT_BURST_WINDOW_SECONDS=60
RATE_LIMIT_SUSTAINED=100
RATE_LIMIT_SUSTAINED_WINDOW_SECONDS=3600
# Maximum sandbox containers running at once, across all users, on this instance.
SANDBOX_MAX_CONCURRENT=4
```

- [ ] **Step 3: Extend the integration gate**

In `backend/package.json`, add the Redis suite to `test:integration`:

```json
    "test:integration": "tsc -p tsconfig.test.json && vitest run --no-file-parallelism tests/history/pgStore.test.ts tests/history/migrate.test.ts tests/history/isolation.test.ts tests/limits/redisQuota.test.ts"
```

In `backend/verify.sh`, replace `integration()`:

```bash
integration() {
  if [[ -z "${DATABASE_URL:-}" && -z "${REDIS_URL:-}" ]]; then
    echo
    echo "==> skipping integration tests (DATABASE_URL and REDIS_URL not set)"
    return 0
  fi
  [[ -n "${DATABASE_URL:-}" ]] || echo "==> note: DATABASE_URL unset, Postgres suites will self-skip"
  [[ -n "${REDIS_URL:-}" ]]    || echo "==> note: REDIS_URL unset, Redis suites will self-skip"
  run npm run test:integration
}
```

Update the usage comment at the top of the file:

```bash
#   test:integration contract suites against a real Postgres and Redis
#                    (requires DATABASE_URL and/or REDIS_URL; each self-skips when unset)
```

- [ ] **Step 4: Add Redis to CI**

In `.github/workflows/ci.yml`, add to the backend job's `services`:

```yaml
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

Add `REDIS_URL` to the `Integration test` step's `env`:

```yaml
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
          REDIS_URL: redis://localhost:6379
```

- [ ] **Step 5: Update `docs/sdlc.md` (required by CI)**

In the *Verify* section, replace the trap callout so it covers both services:

```markdown
> **The trap worth internalising:** the Postgres history suites and the Redis quota suite
> **self-skip when `DATABASE_URL` / `REDIS_URL` are unset**. A green `./verify.sh` is *not*
> evidence they ran. Touching `src/history/**`, `migrations/**`, or `src/limits/**` means
> running `DATABASE_URL=… REDIS_URL=… ./verify.sh test:integration` explicitly.
```

In *How this meets CI/CD*, update the Postgres bullet:

```markdown
- **Postgres and Redis run as service containers**, and only the `Integration test` step sets
  `DATABASE_URL` / `REDIS_URL` — which is exactly why the DB-free `Test` step still skips those
  suites.
```

- [ ] **Step 6: Verify the whole thing end to end**

```bash
docker compose up -d redis postgres
cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app REDIS_URL=redis://localhost:6379 \
  ./verify.sh
```
Expected: every target passes, and the integration step reports the Redis suite running rather
than skipping.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example backend/verify.sh backend/package.json \
        .github/workflows/ci.yml docs/sdlc.md
git commit -m "chore(limits): Redis in Compose + CI; integration gate covers both services"
```

---

## Task 9: Surface the refusal in the SPA

**Files:**
- Modify: `frontend/src/api.ts`, `frontend/src/App.tsx`
- Test: `frontend/src/api.test.ts`

`execute()` currently throws a bare `Error(detail)`, discarding the status and the header. The UI
cannot distinguish "you are throttled, wait 42s" from "the backend fell over".

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/api.test.ts`:

```ts
import { ApiError, execute } from "./api";

it("throws an ApiError carrying status and retry hint on 429", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ detail: "Rate limit exceeded." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "42" },
      }),
    ),
  );
  await expect(execute("hi")).rejects.toMatchObject({
    name: "ApiError",
    status: 429,
    retryAfterSeconds: 42,
  });
});

it("throws an ApiError with no retry hint when the header is absent", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ detail: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  await expect(execute("hi")).rejects.toMatchObject({
    status: 500,
    retryAfterSeconds: undefined,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL — `ApiError` is not exported.

- [ ] **Step 3: Add the typed error**

In `frontend/src/api.ts`, add above `execute`:

```ts
/**
 * A non-2xx response, preserving what the UI needs to react. The backend exposes
 * Retry-After via Access-Control-Expose-Headers; without that the browser could not read
 * it cross-origin at all.
 */
export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail);
  }
}
```

Replace the error branch of `execute`:

```ts
  if (!resp.ok) {
    let detail = `Request failed (${resp.status})`;
    try {
      const errBody = (await resp.json()) as { detail?: string };
      if (errBody?.detail) detail = errBody.detail;
    } catch {
      /* keep default detail */
    }
    const header = resp.headers.get("Retry-After");
    const retryAfter = header !== null && Number.isFinite(Number(header)) ? Number(header) : undefined;
    throw new ApiError(resp.status, detail, retryAfter);
  }
```

- [ ] **Step 4: Use it in the UI**

`onRun` is the only `execute()` call site (`frontend/src/App.tsx:114-127`). Replace its catch
block — currently lines 122-123:

```tsx
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
```

with:

```tsx
    } catch (e) {
      setError(throttleMessage(e) ?? (e instanceof Error ? e.message : String(e)));
    } finally {
```

Add above the component:

```tsx
/**
 * Turn a throttling refusal into something actionable. 429 is "you went too fast"; 503 is
 * "everyone did" — the distinction matters to the user, since only one of them is their doing.
 * Returns null for anything else so ordinary errors keep their existing message.
 */
function throttleMessage(e: unknown): string | null {
  if (!(e instanceof ApiError) || (e.status !== 429 && e.status !== 503)) return null;
  const wait = e.retryAfterSeconds;
  const when = wait !== undefined ? ` Try again in ${wait}s.` : "";
  return e.status === 429
    ? `You're sending requests too quickly.${when}`
    : `The service is at capacity.${when}`;
}
```

and extend the import to `import { ApiError, execute } from "./api";`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && ./verify.sh test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/App.tsx frontend/src/api.test.ts
git commit -m "feat(frontend): distinguish 429/503 with a retry hint (D7)"
```

---

## Task 10: Documentation

**Files:**
- Create: `docs/adr/0003-rate-limiting-approach.md`
- Modify: `README.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0003-rate-limiting-approach.md`, continuing the existing sequence and format
(see `0002-agentic-auth-security-testing.md`). It records the three decisions that are expensive
to reverse — **D1** (Redis, with in-process and Postgres as the rejected options), **D5**
(fail-open, and why the concurrency cap is what makes that safe), and **D8** (immediate refusal,
no queue; and why the two controls legitimately store state in different places). Status:
`Accepted`. Link the spec.

- [ ] **Step 2: Update the README**

Delete the *No rate limiting / concurrency cap* bullet from *Known limitations* (currently
`README.md:203-204`). In its place, under the hardened list, add:

```markdown
**Rate limiting.** Every `/api/execute` is charged against a per-user quota keyed on the verified
`sub` (Redis-backed, so the limit holds across instances and restarts) *before* any Anthropic call
— over-quota returns `429` with `Retry-After`. Concurrent sandbox executions are capped per
instance; excess is refused with `503` rather than queued. The backend refuses to start without
`REDIS_URL`. See [ADR-0003](docs/adr/0003-rate-limiting-approach.md).
```

Update the *Roadmap* line that promises "per-user quotas / rate limiting" as future work, and add
`REDIS_URL` plus the `RATE_LIMIT_*` and `SANDBOX_MAX_CONCURRENT` variables to the settings table.
Add `redis` to the Compose services described in the setup steps, and note that a fresh clone now
needs it running.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0003-rate-limiting-approach.md README.md
git commit -m "docs: ADR-0003 rate limiting; README posture and setup"
```

---

## Verification before the PR

```bash
docker compose up -d redis postgres
cd backend  && DATABASE_URL=postgres://app:app@localhost:5432/app \
               REDIS_URL=redis://localhost:6379 ./verify.sh
cd ../frontend && ./verify.sh
```

Then the two mandatory review passes from `CLAUDE.md` — `code-review` and `security-review`
against the pending diff — with findings evaluated through `receiving-code-review` before any are
applied.

## Requirement coverage

| Criterion | Task |
| --- | --- |
| S1 429 over quota | 2, 5 |
| S2 cross-user independence | 2, 5 |
| S3 zero spend on refusal | 5 (quota), 6 (peek) |
| S4 no-code path charged | 5 |
| S5 concurrency never exceeds N | 6 |
| S6 bounded state / TTLs | 3 |
| S7 survives restart | 3 (Redis is the mechanism) |
| S8 refuses to boot | 1, 7 |
| S9 fails open + alarms | 5 |
| S10 unit tests need no Redis | 1, 7 |
| S11 both verify.sh green | 8, and the final verification above |
| D1–D8 | ADR in 10 |

## Suggested child issues

One per independently deliverable slice, labelled `enhancement`, created after this plan is
reviewed:

| # | Slice | Tasks |
| --- | --- | --- |
| R1 | Quota seam + in-memory store + config | 1, 2 |
| R2 | Redis quota store | 3 |
| R3 | Enforce on `/api/execute` (429 + Retry-After) | 4, 5 |
| R4 | Sandbox concurrency cap (503) | 6 |
| R5 | Boot guard + infrastructure (Compose, CI, verify.sh, sdlc.md) | 7, 8 |
| R6 | SPA throttling UX | 9 |
| R7 | ADR + README | 10 |

R1 lands first. R2/R4 can then proceed in parallel; R3 needs R1+R2; R5 needs R2; R6 needs R3+R4.
