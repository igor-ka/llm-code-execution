import type { Owner, Session, Run, NewRun, SessionPage, ListOptions } from "./types.js";

/** Thrown when a session_id is supplied but is not owned by the caller (→ 404 upstream). */
export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFound";
  }
}

/**
 * Storage seam for per-user chat history — the isolation contract is structural:
 * every method takes an Owner and MUST filter on owner.userId. Implementations never
 * expose a row a different user owns.
 */
export interface HistoryStore {
  /** List the owner's sessions (most-recently-active first), optional ILIKE search + paging. */
  listSessions(owner: Owner, opts: ListOptions): Promise<SessionPage>;
  /** The owner's session with its runs (ascending), or null if not owned / absent. */
  getSession(owner: Owner, id: string): Promise<(Session & { runs: Run[] }) | null>;
  /** Rename the owner's session; null if not owned / absent. */
  renameSession(owner: Owner, id: string, title: string): Promise<Session | null>;
  /** Delete the owner's session (runs cascade); false if not owned / absent. */
  deleteSession(owner: Owner, id: string): Promise<boolean>;
  /** Delete every session (and run) the owner has; returns the session count removed. */
  clearAll(owner: Owner): Promise<number>;
  /**
   * Append a run. sessionId null → create a fresh session (title auto-derived from prompt).
   * sessionId given but not owned → throws SessionNotFound. Bumps the session's updated_at.
   */
  appendRun(
    owner: Owner,
    sessionId: string | null,
    run: NewRun,
  ): Promise<{ session: Session; run: Run }>;
  /** Delete one run of the owner's; false if not owned / absent. */
  deleteRun(owner: Owner, id: string): Promise<boolean>;
  /** Release resources (pg pool). No-op for the in-memory store. */
  close(): Promise<void>;
}

/** Derive a session title from the first prompt: first line, trimmed, ≤60 chars. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  const base = firstLine.length > 0 ? firstLine : "New chat";
  return base.length > 60 ? base.slice(0, 57).trimEnd() + "…" : base;
}
