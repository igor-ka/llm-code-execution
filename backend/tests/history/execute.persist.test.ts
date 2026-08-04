/**
 * Persist-on-execute (H2): /api/execute records each run into the caller's own session,
 * best-effort and owner-scoped. Uses the in-memory HistoryStore as the injected double and
 * the fakePrincipal seam to switch between an authenticated owner and anonymous mode.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import type { LLMService } from "../../src/llm.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";
import type { GenerationResult, SandboxResult } from "../../src/schemas.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { Owner } from "../../src/history/types.js";
import { fakePrincipal } from "../helpers/auth.js";

const openSettings = (over = {}) => loadSettings({ AUTH_REQUIRED: "false", ...over });

function fakeLlm(result: GenerationResult | (() => Promise<never>)): LLMService {
  return {
    generate: async () => {
      if (typeof result === "function") return result();
      return result;
    },
  } as unknown as LLMService;
}

function fakeSandbox(result: SandboxResult): SandboxBackend & { calls: number } {
  const box = {
    calls: 0,
    async execute() {
      box.calls += 1;
      return result;
    },
  };
  return box as unknown as SandboxBackend & { calls: number };
}

const MESSAGE_GEN: GenerationResult = {
  shouldExecute: false,
  language: null,
  code: null,
  message: "Not a coding task.",
};
const RESULT: SandboxResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 0,
  timedOut: false,
};
const OWNER_A: Owner = { userId: "auth0|aaa", tenantId: null };

/** Build an app with the given principal, sharing `store` so tests can inspect it directly. */
function appWith(
  store: MemoryHistoryStore,
  requirePrincipal = fakePrincipal("auth0|aaa"),
  llm: LLMService = fakeLlm(MESSAGE_GEN),
  sandbox: SandboxBackend & { calls: number } = fakeSandbox(RESULT),
) {
  return createApp({ settings: openSettings(), llm, sandbox, history: store, requirePrincipal });
}

describe("POST /api/execute — persist on execute", () => {
  it("(a) authenticated execute persists a run and returns session_id + run_id", async () => {
    const store = new MemoryHistoryStore();
    const resp = await request(appWith(store)).post("/api/execute").send({ prompt: "hello there" });

    expect(resp.status).toBe(200);
    expect(resp.body.type).toBe("message");
    expect(typeof resp.body.session_id).toBe("string");
    expect(typeof resp.body.run_id).toBe("string");

    const page = await store.listSessions(OWNER_A, { limit: 50, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.sessions[0].runCount).toBe(1);
    expect(page.sessions[0].id).toBe(resp.body.session_id);
  });

  it("(b) a follow-up execute with the returned session_id appends to the same session", async () => {
    const store = new MemoryHistoryStore();
    const app = appWith(store);

    const first = await request(app).post("/api/execute").send({ prompt: "first" });
    expect(first.status).toBe(200);
    const sessionId = first.body.session_id as string;

    const second = await request(app)
      .post("/api/execute")
      .send({ prompt: "second", session_id: sessionId });
    expect(second.status).toBe(200);
    expect(second.body.session_id).toBe(sessionId); // same session
    expect(second.body.run_id).not.toBe(first.body.run_id); // a distinct run

    const page = await store.listSessions(OWNER_A, { limit: 50, offset: 0 });
    expect(page.total).toBe(1); // still exactly one session
    const got = await store.getSession(OWNER_A, sessionId);
    expect(got?.runs).toHaveLength(2);
    expect(got?.runs.map((r) => r.prompt)).toEqual(["first", "second"]);
  });

  it("(c) anonymous execute persists nothing and omits session_id / run_id", async () => {
    const store = new MemoryHistoryStore();
    const resp = await request(appWith(store, fakePrincipal(null)))
      .post("/api/execute")
      .send({ prompt: "hello" });

    expect(resp.status).toBe(200);
    // Byte-identical to the pre-history contract: no persistence trailer.
    expect(resp.body).toEqual({ type: "message", message: "Not a coding task." });
    // And nothing was written for anyone.
    expect((await store.listSessions(OWNER_A, { limit: 50, offset: 0 })).total).toBe(0);
  });

  it("(d) execute with an unknown session_id returns 404 before running any code", async () => {
    const store = new MemoryHistoryStore();
    // An LLM that throws proves the owner-scoped pre-check short-circuits first.
    const llm = fakeLlm(async () => {
      throw new Error("LLM must not run");
    });
    const sandbox = fakeSandbox(RESULT);
    const resp = await request(appWith(store, fakePrincipal("auth0|aaa"), llm, sandbox))
      .post("/api/execute")
      .send({ prompt: "hi", session_id: "11111111-1111-4111-8111-111111111111" });

    expect(resp.status).toBe(404);
    expect(sandbox.calls).toBe(0);
  });

  it("(d') execute with another user's session_id returns 404 and leaves the victim untouched", async () => {
    const store = new MemoryHistoryStore();
    const B: Owner = { userId: "auth0|bbb", tenantId: null };
    // User B owns a session with one run.
    const { session } = await store.appendRun(B, null, {
      kind: "message",
      prompt: "b's private chat",
      message: "m",
    });

    const llm = fakeLlm(async () => {
      throw new Error("LLM must not run");
    });
    const sandbox = fakeSandbox(RESULT);
    const resp = await request(appWith(store, fakePrincipal("auth0|aaa"), llm, sandbox))
      .post("/api/execute")
      .send({ prompt: "steal", session_id: session.id });

    expect(resp.status).toBe(404);
    expect(sandbox.calls).toBe(0);
    // INV-4: the victim session is unchanged, and A still cannot see it.
    const victim = await store.getSession(B, session.id);
    expect(victim?.runs).toHaveLength(1);
    expect(await store.getSession(OWNER_A, session.id)).toBeNull();
  });
});
