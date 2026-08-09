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

  /** Whether every slot is taken. The single definition of "full" — tryAcquire consults it. */
  get saturated(): boolean {
    return this.active >= this.max;
  }

  /**
   * Take a slot, or null when full. The returned function releases it and is idempotent — a
   * double release must not invent capacity, and a leaked slot wedges the service for the
   * lifetime of the process.
   */
  tryAcquire(): (() => void) | null {
    if (this.saturated) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
