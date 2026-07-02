/**
 * Sandbox backend abstraction (port of base.py). The seam that keeps the app honest
 * about its GCP future: locally we run DockerBackend, but a CloudRunBackend or a
 * gVisor-backed GKE runner implements the exact same execute() contract with no changes
 * to callers.
 */
import type { SandboxResult } from "../schemas.js";

export interface ExecutionLimits {
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  maxOutputChars: number;
}

export interface SandboxBackend {
  /**
   * Execute `code` for `language`, enforcing `limits`. Must never reject on ordinary
   * program failure (non-zero exit, stderr, timeout) — those are reported in the
   * returned SandboxResult. Reject only on infrastructure errors.
   */
  execute(code: string, language: string, limits: ExecutionLimits): Promise<SandboxResult>;
}
