/**
 * Adversarial cross-user isolation battery — the security proof for per-user chat history.
 * The INV-1..8 matrix runs at the HTTP layer against BOTH stores: the in-memory oracle
 * (always) and real Postgres (when DATABASE_URL is set), so isolation is proven against the
 * actual SQL, not just the model. INV-7 is a planted-hole regression (historyMutants.ts):
 * each mutant leaks where the real store denies, proving the battery would catch a dropped
 * owner filter. See the "Isolation invariants (security spec)" section of the plan.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { HistoryStore } from "../../src/history/store.js";
import type { Owner } from "../../src/history/types.js";
import type { LLMService } from "../../src/llm.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";
import type { GenerationResult, SandboxResult } from "../../src/schemas.js";
import { fakePrincipal } from "../helpers/auth.js";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";
import { PostgresHistoryStore } from "../../src/history/pgStore.js";
import {
  LeakyGetSession,
  LeakyDeleteRun,
  LeakyDeleteSession,
  LeakyAppendRun,
  LeakyListSessions,
  LeakyClearAll,
} from "./historyMutants.js";

const settings = loadSettings({ AUTH_REQUIRED: "false" });
const A: Owner = { userId: "auth0|A", tenantId: null };
const B: Owner = { userId: "auth0|B", tenantId: null };
const RANDOM_UUID = "99999999-9999-4999-8999-999999999999";

const MESSAGE_GEN: GenerationResult = {
  shouldExecute: false,
  language: null,
  code: null,
  message: "not a coding task",
};
const RESULT: SandboxResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 0,
  timedOut: false,
};

function fakeLlm(result: GenerationResult): LLMService {
  return { generate: async () => result } as unknown as LLMService;
}
function countingSandbox(): SandboxBackend & { calls: number } {
  const box = {
    calls: 0,
    async execute() {
      box.calls += 1;
      return RESULT;
    },
  };
  return box as unknown as SandboxBackend & { calls: number };
}

function appFor(store: HistoryStore, userId: string | null, sandbox = countingSandbox()) {
  return createApp({
    settings,
    history: store,
    requirePrincipal: fakePrincipal(userId),
    llm: fakeLlm(MESSAGE_GEN),
    sandbox,
  });
}

function runIsolationBattery(name: string, makeStore: () => Promise<HistoryStore>): void {
  describe(`isolation battery: ${name}`, () => {
    let store: HistoryStore;
    let appA: ReturnType<typeof createApp>;
    let appB: ReturnType<typeof createApp>;
    let appAnon: ReturnType<typeof createApp>;
    let sandboxB: SandboxBackend & { calls: number };

    beforeEach(async () => {
      store = await makeStore();
      sandboxB = countingSandbox();
      appA = appFor(store, "auth0|A");
      appB = appFor(store, "auth0|B", sandboxB);
      appAnon = appFor(store, null);
    });
    afterEach(async () => {
      await store.close();
    });

    /** Seed one session (with one run) owned by A; returns its ids. */
    async function seedA() {
      return store.appendRun(A, null, { kind: "message", prompt: "A private", message: "m" });
    }

    it("INV-1 list/search never returns another user's data", async () => {
      await seedA();
      expect((await request(appB).get("/api/sessions")).body.total).toBe(0);
      expect((await request(appB).get("/api/sessions").query({ q: "private" })).body.total).toBe(0);
    });

    it("INV-2 cross-user GET/PATCH/DELETE session → 404, victim unchanged", async () => {
      const { session } = await seedA();
      expect((await request(appB).get(`/api/sessions/${session.id}`)).status).toBe(404);
      expect(
        (await request(appB).patch(`/api/sessions/${session.id}`).send({ title: "hijack" })).status,
      ).toBe(404);
      expect((await request(appB).delete(`/api/sessions/${session.id}`)).status).toBe(404);
      const still = await request(appA).get(`/api/sessions/${session.id}`);
      expect(still.status).toBe(200);
      expect(still.body.title).toBe("A private");
    });

    it("INV-3 cross-user DELETE run → 404, A's run survives", async () => {
      const { session, run } = await seedA();
      expect((await request(appB).delete(`/api/runs/${run.id}`)).status).toBe(404);
      expect((await store.getSession(A, session.id))?.runs).toHaveLength(1);
    });

    it("INV-4 execute with another user's session_id → 404, victim untouched, sandbox unrun", async () => {
      const { session } = await seedA();
      const resp = await request(appB)
        .post("/api/execute")
        .send({ prompt: "steal", session_id: session.id });
      expect(resp.status).toBe(404);
      expect(sandboxB.calls).toBe(0);
      expect((await store.getSession(A, session.id))?.runs).toHaveLength(1);
    });

    it("INV-5 clear-all deletes only the caller's data", async () => {
      await seedA();
      await store.appendRun(B, null, { kind: "message", prompt: "B data", message: "m" });
      expect((await request(appB).delete("/api/sessions")).body).toEqual({ deleted: 1 });
      expect((await store.listSessions(A, { limit: 50, offset: 0 })).total).toBe(1);
    });

    it("INV-6 anonymous: history routes 404, execute persists nothing", async () => {
      const { session } = await seedA();
      expect((await request(appAnon).get("/api/sessions")).status).toBe(404);
      expect((await request(appAnon).get(`/api/sessions/${session.id}`)).status).toBe(404);
      expect((await request(appAnon).delete("/api/sessions")).status).toBe(404);
      const exec = await request(appAnon).post("/api/execute").send({ prompt: "hi" });
      expect(exec.status).toBe(200);
      expect(exec.body.session_id).toBeUndefined();
      // Anon wrote nothing; only A's seeded session exists.
      expect((await store.listSessions(A, { limit: 50, offset: 0 })).total).toBe(1);
    });

    it("INV-8 enumeration: a real foreign id and a random id return identical 404s", async () => {
      const { session } = await seedA();
      const foreign = await request(appB).get(`/api/sessions/${session.id}`);
      const random = await request(appB).get(`/api/sessions/${RANDOM_UUID}`);
      expect(foreign.status).toBe(404);
      expect(random.status).toBe(404);
      expect(foreign.body).toEqual(random.body); // identical body → no existence leak
    });
  });
}

runIsolationBattery("memory", async () => new MemoryHistoryStore());

// Same battery against real Postgres — gated on DATABASE_URL (the integration entrypoint sets
// it). Each store starts from a truncated schema; run serially (--no-file-parallelism).
const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)("postgres", () => {
  runIsolationBattery("postgres", async () => {
    const pool = makePool(url as string);
    await migrate(pool);
    await pool.query("TRUNCATE sessions, runs RESTART IDENTITY CASCADE");
    return new PostgresHistoryStore(pool);
  });
});

// INV-7 — planted-hole regression: each mutant drops one owner filter and LEAKS across users;
// the real store DENIES the same access. Proves the battery would catch a lost `WHERE user_id`.
describe("INV-7 planted-hole regression: mutant leaks, real store denies", () => {
  it("dropped user_id in getSession lets B read A's session", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyGetSession();
    const { session: rs } = await real.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    const { session: ms } = await mutant.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    expect(await real.getSession(B, rs.id)).toBeNull(); // real DENIES
    expect(await mutant.getSession(B, ms.id)).not.toBeNull(); // mutant LEAKS
    await real.close();
    await mutant.close();
  });

  it("dropped user_id in deleteRun lets B delete A's run", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyDeleteRun();
    const { run: rr } = await real.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    const { run: mr } = await mutant.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    expect(await real.deleteRun(B, rr.id)).toBe(false); // real DENIES
    expect(await mutant.deleteRun(B, mr.id)).toBe(true); // mutant LEAKS
    await real.close();
    await mutant.close();
  });

  it("dropped user_id in deleteSession lets B delete A's session", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyDeleteSession();
    const { session: rs } = await real.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    const { session: ms } = await mutant.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    expect(await real.deleteSession(B, rs.id)).toBe(false); // real DENIES
    expect(await mutant.deleteSession(B, ms.id)).toBe(true); // mutant LEAKS
    await real.close();
    await mutant.close();
  });

  it("dropped owner check in appendRun lets B write into A's session", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyAppendRun();
    const { session: rs } = await real.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    const { session: ms } = await mutant.appendRun(A, null, {
      kind: "message",
      prompt: "p",
      message: "m",
    });
    await expect(
      real.appendRun(B, rs.id, { kind: "message", prompt: "x", message: "y" }),
    ).rejects.toThrow(); // real DENIES
    const leaked = await mutant.appendRun(B, ms.id, { kind: "message", prompt: "x", message: "y" });
    expect(leaked.session.id).toBe(ms.id); // mutant LEAKS: wrote into A's session
    await real.close();
    await mutant.close();
  });

  it("dropped user_id in listSessions lets B read A's sessions", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyListSessions();
    await real.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
    await mutant.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
    expect((await real.listSessions(B, { limit: 50, offset: 0 })).total).toBe(0); // real DENIES
    expect((await mutant.listSessions(B, { limit: 50, offset: 0 })).total).toBe(1); // mutant LEAKS
    await real.close();
    await mutant.close();
  });

  it("dropped user_id in clearAll lets B wipe A's data (the destructive hole)", async () => {
    const real = new MemoryHistoryStore();
    const mutant = new LeakyClearAll();
    await real.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
    await mutant.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
    await real.clearAll(B); // real: no-op for A
    await mutant.clearAll(B); // mutant: wipes everyone
    expect((await real.listSessions(A, { limit: 50, offset: 0 })).total).toBe(1); // real DENIES: A survives
    expect((await mutant.listSessions(A, { limit: 50, offset: 0 })).total).toBe(0); // mutant LEAKS: A wiped
    await real.close();
    await mutant.close();
  });
});
