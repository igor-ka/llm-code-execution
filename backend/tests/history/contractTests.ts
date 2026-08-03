/**
 * Shared HistoryStore contract suite. Lives under tests/ (not src/) so the production
 * build — tsc -p tsconfig.json, which includes only src/ — never compiles these vitest
 * imports into dist/. H1 (Postgres) imports runHistoryContract from here via "./contractTests.js".
 */
import { expect, it, describe } from "vitest";
import type { HistoryStore } from "../../src/history/store.js";
import type { Owner } from "../../src/history/types.js";

const A: Owner = { userId: "auth0|aaa", tenantId: null };
const B: Owner = { userId: "auth0|bbb", tenantId: null };

/** Run the full HistoryStore contract against `make()` (fresh, empty store per call). */
export function runHistoryContract(name: string, make: () => Promise<HistoryStore>): void {
  describe(`HistoryStore contract: ${name}`, () => {
    it("appendRun with null sessionId creates a session titled from the prompt", async () => {
      const s = await make();
      const { session, run } = await s.appendRun(A, null, {
        kind: "message",
        prompt: "hello there",
        message: "hi",
      });
      expect(session.title).toBe("hello there");
      expect(run.sessionId).toBe(session.id);
      const page = await s.listSessions(A, { limit: 50, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.sessions[0].runCount).toBe(1);
      await s.close();
    });

    it("isolates: B cannot see, get, rename, or delete A's session", async () => {
      const s = await make();
      const { session } = await s.appendRun(A, null, {
        kind: "message",
        prompt: "p",
        message: "m",
      });
      expect((await s.listSessions(B, { limit: 50, offset: 0 })).total).toBe(0);
      expect(await s.getSession(B, session.id)).toBeNull();
      expect(await s.renameSession(B, session.id, "hijacked")).toBeNull();
      expect(await s.deleteSession(B, session.id)).toBe(false);
      // A's session is untouched.
      expect((await s.getSession(A, session.id))?.title).toBe("p");
      await s.close();
    });

    it("appendRun to a session the caller does not own throws SessionNotFound", async () => {
      const s = await make();
      const { session } = await s.appendRun(A, null, {
        kind: "message",
        prompt: "p",
        message: "m",
      });
      await expect(
        s.appendRun(B, session.id, { kind: "message", prompt: "x", message: "y" }),
      ).rejects.toThrow("Session not found");
      await s.close();
    });

    it("deleteRun is owner-scoped and getSession returns runs in order", async () => {
      const s = await make();
      const { session, run: r1 } = await s.appendRun(A, null, {
        kind: "result",
        prompt: "one",
        language: "python",
        code: "print(1)",
        stdout: "1\n",
        stderr: "",
        exitCode: 0,
        durationMs: 12,
        timedOut: false,
      });
      const { run: r2 } = await s.appendRun(A, session.id, {
        kind: "message",
        prompt: "two",
        message: "m",
      });
      expect(await s.deleteRun(B, r1.id)).toBe(false); // not B's
      expect(await s.deleteRun(A, r1.id)).toBe(true);
      const got = await s.getSession(A, session.id);
      expect(got?.runs.map((r) => r.id)).toEqual([r2.id]);
      await s.close();
    });

    it("clearAll removes only the caller's sessions", async () => {
      const s = await make();
      await s.appendRun(A, null, { kind: "message", prompt: "a", message: "m" });
      await s.appendRun(B, null, { kind: "message", prompt: "b", message: "m" });
      expect(await s.clearAll(A)).toBe(1);
      expect((await s.listSessions(A, { limit: 50, offset: 0 })).total).toBe(0);
      expect((await s.listSessions(B, { limit: 50, offset: 0 })).total).toBe(1);
      await s.close();
    });

    it("search matches the owner's titles/prompts case-insensitively", async () => {
      const s = await make();
      await s.appendRun(A, null, { kind: "message", prompt: "Fibonacci numbers", message: "m" });
      await s.appendRun(A, null, { kind: "message", prompt: "sort a list", message: "m" });
      const hit = await s.listSessions(A, { q: "FIBON", limit: 50, offset: 0 });
      expect(hit.total).toBe(1);
      expect(hit.sessions[0].title).toBe("Fibonacci numbers");
      await s.close();
    });
  });
}
