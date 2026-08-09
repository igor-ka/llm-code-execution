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

export type QuotaDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

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
