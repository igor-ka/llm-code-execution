/** Zod request schema, internal result types, and response builders for the API. */
import { z } from "zod";

// --- API request ---
// tenant_id / user_id are intentionally NOT request fields; they are derived
// server-side from the verified token (see auth.ts) so they cannot be spoofed.
export const ExecuteRequest = z.object({
  prompt: z.string().min(1).max(8000),
  session_id: z.string().uuid().optional(), // continue an existing session; omit to start one
});
export type ExecuteRequest = z.infer<typeof ExecuteRequest>;

// --- Internal: result of the single structured Claude call ---
export interface GenerationResult {
  shouldExecute: boolean;
  language: string | null;
  code: string | null;
  message: string | null;
}

// --- Internal: result of running code in a sandbox ---
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

// --- API responses (discriminated by `type`, snake_case on the wire) ---
// Optional persistence trailer: `session_id`/`run_id` appear only when the run was persisted
// for an authenticated caller (both present, or neither). Anonymous / history-off omits them,
// keeping the response byte-identical to the pre-history contract.
type Persisted = { sessionId?: string; runId?: string };
const persistedWire = (p?: Persisted) =>
  p?.sessionId && p?.runId ? { session_id: p.sessionId, run_id: p.runId } : {};

export function messageResponse(message: string, p?: Persisted) {
  return { type: "message" as const, message, ...persistedWire(p) };
}

export function resultResponse(language: string, code: string, r: SandboxResult, p?: Persisted) {
  return {
    type: "result" as const,
    language,
    code,
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
    timed_out: r.timedOut,
    ...persistedWire(p),
  };
}
