/**
 * HTTP-layer tests for the owner-scoped history router. Cross-user isolation is exercised by
 * pointing TWO apps at ONE shared store, each wired with a different fakePrincipal — so a
 * request as B genuinely hits A's persisted rows and must still 404. A third app is anonymous
 * (userId=null) to prove the feature is invisible without an identity.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { Owner } from "../../src/history/types.js";
import { fakePrincipal } from "../helpers/auth.js";

const A: Owner = { userId: "auth0|A", tenantId: null };
const B: Owner = { userId: "auth0|B", tenantId: null };
const settings = loadSettings({ AUTH_REQUIRED: "false" });

let store: MemoryHistoryStore;
let appA: ReturnType<typeof createApp>;
let appB: ReturnType<typeof createApp>;
let appAnon: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new MemoryHistoryStore();
  appA = createApp({ settings, history: store, requirePrincipal: fakePrincipal("auth0|A") });
  appB = createApp({ settings, history: store, requirePrincipal: fakePrincipal("auth0|B") });
  appAnon = createApp({ settings, history: store, requirePrincipal: fakePrincipal(null) });
});

/** Seed one message-run session for owner `o` directly through the store (not the HTTP API). */
async function seed(o: Owner, prompt: string) {
  return store.appendRun(o, null, { kind: "message", prompt, message: "m" });
}

describe("history router — listing & search", () => {
  it("GET /api/sessions returns only the caller's sessions", async () => {
    await seed(A, "A's chat");
    await seed(B, "B's chat");

    const ra = await request(appA).get("/api/sessions");
    expect(ra.status).toBe(200);
    expect(ra.body.total).toBe(1);
    expect(ra.body.sessions).toHaveLength(1);
    expect(ra.body.sessions[0].title).toBe("A's chat");
    expect(ra.body.sessions[0].run_count).toBe(1);

    const rb = await request(appB).get("/api/sessions");
    expect(rb.body.total).toBe(1);
    expect(rb.body.sessions[0].title).toBe("B's chat");
  });

  it("GET /api/sessions?q= filters case-insensitively over the caller's data", async () => {
    await seed(A, "Fibonacci numbers");
    await seed(A, "sort a list");

    const hit = await request(appA).get("/api/sessions").query({ q: "FIBON" });
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);
    expect(hit.body.sessions[0].title).toBe("Fibonacci numbers");
  });

  it("GET /api/sessions with a malformed query is 422", async () => {
    const resp = await request(appA).get("/api/sessions").query({ limit: "abc" });
    expect(resp.status).toBe(422);
  });
});

describe("history router — single session access is owner-scoped", () => {
  it("A can GET / PATCH / DELETE its own session", async () => {
    const { session } = await seed(A, "keep me");

    const got = await request(appA).get(`/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe("keep me");
    expect(got.body.runs).toHaveLength(1);

    const renamed = await request(appA).patch(`/api/sessions/${session.id}`).send({ title: "new" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("new");

    const del = await request(appA).delete(`/api/sessions/${session.id}`);
    expect(del.status).toBe(204);
    expect((await request(appA).get(`/api/sessions/${session.id}`)).status).toBe(404);
  });

  it("B's GET / PATCH / DELETE of A's session id all 404, and A's session is untouched", async () => {
    const { session } = await seed(A, "A's secret");

    expect((await request(appB).get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect(
      (await request(appB).patch(`/api/sessions/${session.id}`).send({ title: "hijacked" })).status,
    ).toBe(404);
    expect((await request(appB).delete(`/api/sessions/${session.id}`)).status).toBe(404);

    // A's session survives unchanged.
    const still = await request(appA).get(`/api/sessions/${session.id}`);
    expect(still.status).toBe(200);
    expect(still.body.title).toBe("A's secret");
  });

  it("GET / PATCH / DELETE of an absent id 404 the same way", async () => {
    const missing = "sess_does_not_exist";
    expect((await request(appA).get(`/api/sessions/${missing}`)).status).toBe(404);
    expect(
      (await request(appA).patch(`/api/sessions/${missing}`).send({ title: "x" })).status,
    ).toBe(404);
    expect((await request(appA).delete(`/api/sessions/${missing}`)).status).toBe(404);
  });

  it("PATCH with no title is 422", async () => {
    const { session } = await seed(A, "rename target");
    const resp = await request(appA).patch(`/api/sessions/${session.id}`).send({});
    expect(resp.status).toBe(422);
  });
});

describe("history router — run deletion is owner-scoped", () => {
  it("DELETE /api/runs/:id: B cannot delete A's run; A can, and it is gone", async () => {
    const { run } = await seed(A, "with a run");

    expect((await request(appB).delete(`/api/runs/${run.id}`)).status).toBe(404);
    expect((await request(appA).delete(`/api/runs/${run.id}`)).status).toBe(204);
    // Already deleted → indistinguishable 404.
    expect((await request(appA).delete(`/api/runs/${run.id}`)).status).toBe(404);
  });
});

describe("history router — clear all is owner-scoped", () => {
  it("DELETE /api/sessions clears only the caller's sessions", async () => {
    await seed(A, "a1");
    await seed(A, "a2");
    await seed(B, "b1");

    const cleared = await request(appA).delete("/api/sessions");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ deleted: 2 });

    expect((await request(appA).get("/api/sessions")).body.total).toBe(0);
    expect((await request(appB).get("/api/sessions")).body.total).toBe(1);
  });
});

describe("history router — anonymous principal cannot see the feature", () => {
  it("every history route returns 404 when userId is null", async () => {
    const { session, run } = await seed(A, "exists");

    expect((await request(appAnon).get("/api/sessions")).status).toBe(404);
    expect((await request(appAnon).delete("/api/sessions")).status).toBe(404);
    expect((await request(appAnon).get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect(
      (await request(appAnon).patch(`/api/sessions/${session.id}`).send({ title: "x" })).status,
    ).toBe(404);
    expect((await request(appAnon).delete(`/api/sessions/${session.id}`)).status).toBe(404);
    expect((await request(appAnon).delete(`/api/runs/${run.id}`)).status).toBe(404);

    // A's data is untouched by any anonymous attempt.
    expect((await request(appA).get("/api/sessions")).body.total).toBe(1);
  });
});
