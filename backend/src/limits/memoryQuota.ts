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

/**
 * Sweep expired entries once the map passes this size. Without it the map grows one entry per
 * distinct identity forever, which would break the equivalence the shared contract suite
 * claims: the Redis store proves bounded state via TTLs (S6), so the oracle must hold the same
 * property rather than merely appear to.
 */
const SWEEP_THRESHOLD = 1000;

export class MemoryQuotaStore implements QuotaStore {
  private readonly windows = new Map<string, Window>();

  /** Drop windows that have already reset. O(n), amortised by the threshold check. */
  private sweep(now: number): void {
    for (const [k, w] of this.windows) {
      if (now >= w.resetAtMs) this.windows.delete(k);
    }
  }

  /**
   * Seconds until `key` has room, or 0 if it has room now. **Pure** — it must never create or
   * roll a window. Redis only creates a key on an allowed INCR, so a check that materialised a
   * zero-count window here would start the clock early on a request the other window refused,
   * expiring early and granting capacity sooner than Redis does. The two stores would then
   * disagree exactly where the contract suite claims they agree.
   */
  private peek(key: string, limit: number, now: number): number {
    const w = this.windows.get(key);
    if (!w || now >= w.resetAtMs) return 0; // absent or rolled over ⇒ empty ⇒ room
    if (w.count < limit) return 0;
    return Math.max(1, Math.ceil((w.resetAtMs - now) / 1000));
  }

  /** Charge one request, creating or rolling the window as needed. */
  private charge(key: string, windowSeconds: number, now: number): void {
    let w = this.windows.get(key);
    if (!w || now >= w.resetAtMs) {
      w = { count: 0, resetAtMs: now + windowSeconds * 1000 };
      this.windows.set(key, w);
    }
    w.count += 1;
  }

  async consume(key: string, limits: QuotaLimits): Promise<QuotaDecision> {
    const now = Date.now();
    if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(now);

    // Evaluate BOTH windows and refuse with the LONGEST wait: reporting the burst window's
    // shorter TTL while the sustained window is also full would guarantee an obedient client a
    // second 429. Checking before charging also means a refusal costs nothing.
    const wait = Math.max(
      this.peek(`${key}:b`, limits.burst, now),
      this.peek(`${key}:s`, limits.sustained, now),
    );
    if (wait > 0) return { allowed: false, retryAfterSeconds: wait };

    this.charge(`${key}:b`, limits.burstWindowSeconds, now);
    this.charge(`${key}:s`, limits.sustainedWindowSeconds, now);
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
