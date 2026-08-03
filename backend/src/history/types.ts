/** Domain types for chat history. Wire (snake_case) shapes live in dto.ts. */

/** The isolation key, derived from the verified token — never from the request body. */
export interface Owner {
  userId: string; // verified `sub`; history requires a non-null userId
  tenantId: string | null; // verified `org_id`, stored but not part of the v1 predicate
}

export interface Session {
  id: string;
  userId: string;
  tenantId: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The content of a run: the prompt plus the /api/execute response union. Shared by NewRun
 * (what a caller hands appendRun) and Run (that plus provenance) so the two cannot drift.
 */
export type RunPayload = { prompt: string } & (
  | { kind: "message"; message: string }
  | {
      kind: "result";
      language: string;
      code: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }
);

/** What a caller hands appendRun — everything except server-assigned provenance. */
export type NewRun = RunPayload;

/** A persisted run: the payload plus server-assigned provenance columns. */
export type Run = { id: string; sessionId: string; userId: string; createdAt: Date } & RunPayload;

export interface SessionPage {
  sessions: (Session & { runCount: number })[];
  total: number;
}

export interface ListOptions {
  q?: string;
  limit: number;
  offset: number;
}
