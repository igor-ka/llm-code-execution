import { z } from "zod";
import type { Session, Run } from "./types.js";

export const CreateSessionRequest = z.object({ title: z.string().min(1).max(120).optional() });
export const RenameSessionRequest = z.object({ title: z.string().min(1).max(120) });
export const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function sessionWire(s: Session & { runCount?: number }) {
  return {
    id: s.id,
    title: s.title,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    ...(s.runCount === undefined ? {} : { run_count: s.runCount }),
  };
}

export function runWire(r: Run) {
  const base = {
    id: r.id,
    session_id: r.sessionId,
    created_at: r.createdAt.toISOString(),
    prompt: r.prompt,
  };
  if (r.kind === "message") return { ...base, type: "message" as const, message: r.message };
  return {
    ...base,
    type: "result" as const,
    language: r.language,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
    timed_out: r.timedOut,
  };
}

export function sessionWithRunsWire(s: Session & { runs: Run[] }) {
  return { ...sessionWire(s), runs: s.runs.map(runWire) };
}
