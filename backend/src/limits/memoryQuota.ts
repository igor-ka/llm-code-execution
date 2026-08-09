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
   * Read (and lazily roll) one window. Returns 0 when there is room, else the seconds left
   * until it resets. `consume` is false for the check pass so a refusal charges nothing.
   */
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
    if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(Date.now());
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
