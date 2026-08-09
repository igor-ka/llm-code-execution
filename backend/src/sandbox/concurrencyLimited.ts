/**
 * SandboxBackend decorator enforcing the concurrency cap. A decorator rather than a change
 * inside DockerBackend so the future CloudRunBackend inherits the cap unchanged and
 * DockerBackend keeps one responsibility.
 *
 * Rejecting is within the base contract: that contract forbids rejecting on ordinary program
 * failure (non-zero exit, stderr, timeout), which this is not — it is a refusal to start at
 * all.
 *
 * Enforcement happens here and nowhere else (D9). A cheaper check before llm.generate would
 * save the API call, but it would also refuse no-code prompts that never touch Docker.
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
