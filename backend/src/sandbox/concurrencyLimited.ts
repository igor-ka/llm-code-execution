/**
 * SandboxBackend decorator enforcing the concurrency cap. A decorator rather than a change
 * inside DockerBackend so the future CloudRunBackend inherits the cap unchanged and
 * DockerBackend keeps one responsibility.
 *
 * Rejecting is within the base contract: that contract forbids rejecting on ordinary program
 * failure (non-zero exit, stderr, timeout), which this is not — it is a refusal to start at
 * all.
 *
 * Enforcement happens here and nowhere else (D9 — "the cap is enforced only at the sandbox
 * launch, never before the LLM call"). A cheaper check before llm.generate would
 * save the API call, but it would also refuse no-code prompts that never touch Docker.
 */
import type { SandboxBackend, ExecutionLimits } from "./base.js";
import type { SandboxResult } from "../schemas.js";
import type { ConcurrencyLimiter } from "../limits/concurrency.js";
import { HttpError } from "../errors.js";

export class ConcurrencyLimitedBackend implements SandboxBackend {
  /**
   * @param retryAfterSeconds hinted to a caller refused at the cap. Must be at least the
   * sandbox timeout: a slot is only guaranteed to free once the longest-running execution is
   * killed, so a shorter hint marches clients straight into a second 503 and amplifies load on
   * an already-saturated service. Pass `settings.sandboxTimeoutSeconds`.
   */
  constructor(
    private readonly inner: SandboxBackend,
    private readonly limiter: ConcurrencyLimiter,
    private readonly retryAfterSeconds: number,
  ) {}

  async execute(code: string, language: string, limits: ExecutionLimits): Promise<SandboxResult> {
    const release = this.limiter.tryAcquire();
    if (release === null) {
      // 503, not 429: the quota already passed, so this caller is inside its own allowance
      // and is being refused because of OTHER users' load. 429 would blame the wrong party.
      throw new HttpError(
        503,
        "The service is at capacity. Please retry in a few seconds.",
        this.retryAfterSeconds,
      );
    }
    try {
      return await this.inner.execute(code, language, limits);
    } finally {
      release();
    }
  }
}
