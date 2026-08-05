/**
 * Deliberately-broken HistoryStore variants — mutation-testing fixtures for isolation, the
 * store analogue of mutants.ts (auth). Each mutant faithfully delegates to a real in-memory
 * store EXCEPT one method, which drops its owner filter (simulating a lost `WHERE user_id`).
 * isolation.test.ts asserts each mutant LEAKS across users where the real store DENIES,
 * proving the battery has the sensitivity to catch a dropped owner predicate.
 */
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { HistoryStore } from "../../src/history/store.js";
import type {
  Owner,
  Session,
  Run,
  NewRun,
  SessionPage,
  ListOptions,
} from "../../src/history/types.js";

type SessionWithRuns = Session & { runs: Run[] };

/**
 * Faithful delegator that also records each row's TRUE owner, so a mutant can resolve a row
 * without the requester's identity — i.e. exactly as a query that forgot to filter on the
 * requester would. On its own this class is fully owner-scoped (it just delegates); the
 * subclasses below each plant one hole.
 */
class DelegatingStore implements HistoryStore {
  protected inner = new MemoryHistoryStore();
  protected sessionOwner = new Map<string, Owner>();
  protected runOwner = new Map<string, Owner>();

  async appendRun(owner: Owner, sessionId: string | null, run: NewRun) {
    const r = await this.inner.appendRun(owner, sessionId, run);
    this.sessionOwner.set(r.session.id, owner);
    this.runOwner.set(r.run.id, owner);
    return r;
  }
  listSessions(owner: Owner, opts: ListOptions): Promise<SessionPage> {
    return this.inner.listSessions(owner, opts);
  }
  getSession(owner: Owner, id: string): Promise<SessionWithRuns | null> {
    return this.inner.getSession(owner, id);
  }
  renameSession(owner: Owner, id: string, title: string): Promise<Session | null> {
    return this.inner.renameSession(owner, id, title);
  }
  deleteSession(owner: Owner, id: string): Promise<boolean> {
    return this.inner.deleteSession(owner, id);
  }
  clearAll(owner: Owner): Promise<number> {
    return this.inner.clearAll(owner);
  }
  deleteRun(owner: Owner, id: string): Promise<boolean> {
    return this.inner.deleteRun(owner, id);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** FLAW: getSession ignores the requester — resolves by the row's true owner (cross-user read). */
export class LeakyGetSession extends DelegatingStore {
  getSession(_requester: Owner, id: string): Promise<SessionWithRuns | null> {
    const owner = this.sessionOwner.get(id);
    return owner ? this.inner.getSession(owner, id) : Promise.resolve(null);
  }
}

/** FLAW: deleteRun ignores the requester (cross-user delete). */
export class LeakyDeleteRun extends DelegatingStore {
  deleteRun(_requester: Owner, id: string): Promise<boolean> {
    const owner = this.runOwner.get(id);
    return owner ? this.inner.deleteRun(owner, id) : Promise.resolve(false);
  }
}

/** FLAW: deleteSession ignores the requester (cross-user delete). */
export class LeakyDeleteSession extends DelegatingStore {
  deleteSession(_requester: Owner, id: string): Promise<boolean> {
    const owner = this.sessionOwner.get(id);
    return owner ? this.inner.deleteSession(owner, id) : Promise.resolve(false);
  }
}

/** FLAW: appendRun writes into a session owned by someone else instead of throwing (cross-user write). */
export class LeakyAppendRun extends DelegatingStore {
  async appendRun(requester: Owner, sessionId: string | null, run: NewRun) {
    if (sessionId !== null) {
      const owner = this.sessionOwner.get(sessionId);
      if (owner && owner.userId !== requester.userId) {
        const r = await this.inner.appendRun(owner, sessionId, run); // writes as the victim
        this.runOwner.set(r.run.id, owner);
        return r;
      }
    }
    return super.appendRun(requester, sessionId, run);
  }
}

/** Distinct seeded owners (by userId) — the collection-op mutants below sweep across all of them. */
function distinctOwners(m: Map<string, Owner>): Owner[] {
  const seen = new Map<string, Owner>();
  for (const o of m.values()) seen.set(o.userId, o);
  return [...seen.values()];
}

/** FLAW: listSessions returns EVERY owner's sessions, not just the caller's (cross-user read). */
export class LeakyListSessions extends DelegatingStore {
  async listSessions(_requester: Owner, opts: ListOptions): Promise<SessionPage> {
    const pages = await Promise.all(
      distinctOwners(this.sessionOwner).map((o) =>
        this.inner.listSessions(o, { limit: 1000, offset: 0 }),
      ),
    );
    const all = pages.flatMap((p) => p.sessions);
    return { sessions: all.slice(opts.offset, opts.offset + opts.limit), total: all.length };
  }
}

/** FLAW: clearAll deletes EVERY owner's sessions, not just the caller's — the destructive
 *  cross-user hole (one user's "clear my history" wipes everyone). */
export class LeakyClearAll extends DelegatingStore {
  async clearAll(_requester: Owner): Promise<number> {
    let n = 0;
    for (const o of distinctOwners(this.sessionOwner)) n += await this.inner.clearAll(o);
    this.sessionOwner.clear();
    this.runOwner.clear();
    return n;
  }
}
