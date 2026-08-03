import type { HistoryStore } from "./store.js";
import { SessionNotFound, titleFromPrompt } from "./store.js";
import type { Owner, Session, Run, NewRun, SessionPage, ListOptions } from "./types.js";

/**
 * In-memory HistoryStore: a real, ordered, owner-filtered store (not a stub), so it is a
 * faithful oracle for the contract suite and safe to inject as the double in other tests.
 * A monotonic counter (not Date.now/Math.random) keeps ids and ordering deterministic.
 */
export class MemoryHistoryStore implements HistoryStore {
  private seq = 0;
  private sessions = new Map<string, Session>();
  private runs = new Map<string, Run>();

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async listSessions(owner: Owner, opts: ListOptions): Promise<SessionPage> {
    const q = opts.q?.toLowerCase();
    let mine = [...this.sessions.values()].filter((s) => s.userId === owner.userId);
    if (q) {
      mine = mine.filter((s) => {
        const inTitle = s.title.toLowerCase().includes(q);
        const inPrompt = [...this.runs.values()].some(
          (r) => r.sessionId === s.id && r.prompt.toLowerCase().includes(q),
        );
        return inTitle || inPrompt;
      });
    }
    mine.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const total = mine.length;
    const page = mine.slice(opts.offset, opts.offset + opts.limit).map((s) => ({
      ...s,
      runCount: [...this.runs.values()].filter((r) => r.sessionId === s.id).length,
    }));
    return { sessions: page, total };
  }

  async getSession(owner: Owner, id: string): Promise<(Session & { runs: Run[] }) | null> {
    const s = this.sessions.get(id);
    if (!s || s.userId !== owner.userId) return null;
    const runs = [...this.runs.values()]
      .filter((r) => r.sessionId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { ...s, runs };
  }

  async renameSession(owner: Owner, id: string, title: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    if (!s || s.userId !== owner.userId) return null;
    const updated = { ...s, title, updatedAt: new Date() };
    this.sessions.set(id, updated);
    return updated;
  }

  async deleteSession(owner: Owner, id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.userId !== owner.userId) return false;
    this.sessions.delete(id);
    for (const [rid, r] of this.runs) if (r.sessionId === id) this.runs.delete(rid);
    return true;
  }

  async clearAll(owner: Owner): Promise<number> {
    let count = 0;
    for (const [sid, s] of this.sessions) {
      if (s.userId !== owner.userId) continue;
      this.sessions.delete(sid);
      count += 1;
      for (const [rid, r] of this.runs) if (r.sessionId === sid) this.runs.delete(rid);
    }
    return count;
  }

  async appendRun(
    owner: Owner,
    sessionId: string | null,
    run: NewRun,
  ): Promise<{ session: Session; run: Run }> {
    let session: Session;
    if (sessionId === null) {
      const now = new Date();
      session = {
        id: this.id("sess"),
        userId: owner.userId,
        tenantId: owner.tenantId,
        title: titleFromPrompt(run.prompt),
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(session.id, session);
    } else {
      const existing = this.sessions.get(sessionId);
      if (!existing || existing.userId !== owner.userId) throw new SessionNotFound(sessionId);
      session = { ...existing, updatedAt: new Date() };
      this.sessions.set(session.id, session);
    }
    const stored = {
      id: this.id("run"),
      sessionId: session.id,
      userId: owner.userId,
      createdAt: new Date(),
      ...run,
    } as Run;
    this.runs.set(stored.id, stored);
    return { session, run: stored };
  }

  async deleteRun(owner: Owner, id: string): Promise<boolean> {
    const r = this.runs.get(id);
    if (!r || r.userId !== owner.userId) return false;
    this.runs.delete(id);
    return true;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
