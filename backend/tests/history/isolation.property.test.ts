/**
 * INV-1 and INV-5 as PROPERTIES rather than examples.
 *
 * isolation.test.ts asserts these invariants over cases a human (or a model) chose. That is exactly
 * the weakness this file addresses: whoever picked the cases picked them from the same
 * understanding that produced the code, so a shared misunderstanding survives every one of them.
 * The generator does not share it — it is not reasoning, it is trying things.
 *
 * AT THE HTTP LAYER, like the battery it generalises. Asserting against MemoryHistoryStore directly
 * would generalise the STORE's isolation; the invariant is about the SYSTEM, and the router's
 * `ownerOf(res)` derivation is the part most likely to be wrong.
 *
 * ONE LONG-LIVED SERVER PER OWNER, created once for the file. Handing supertest an app makes it
 * spin up and tear down an ephemeral server per request; at numRuns 200 these two properties would
 * make roughly 2,000 of them in one worker, and that pattern fails on socket churn rather than on
 * logic. It would surface as a property failure, which is precisely the nondeterminism tests/fc.ts
 * exists to keep out of a red build.
 *
 * The store must still be FRESH per run, so the app holds a delegating proxy whose target is
 * swapped between runs. Resetting with clearAll() instead would use the very method INV-5 is
 * testing to set up INV-5.
 *
 * The oracle is the INVARIANT, written in isolation.test.ts and docs/testing-notes.md. Never a
 * reading of memoryStore.ts or router.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { fc } from "../fc.js";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import type { HistoryStore } from "../../src/history/store.js";
import type { Owner } from "../../src/history/types.js";
import type { LLMService } from "../../src/llm.js";
import type { SandboxBackend } from "../../src/sandbox/base.js";
import type { GenerationResult } from "../../src/schemas.js";
import { fakePrincipal } from "../helpers/auth.js";

const settings = loadSettings({ AUTH_REQUIRED: "false" });
const A: Owner = { userId: "auth0|A", tenantId: null };
const B: Owner = { userId: "auth0|B", tenantId: null };

const MESSAGE_GEN: GenerationResult = {
  shouldExecute: false,
  language: null,
  code: null,
  message: "not a coding task",
};

/** Swapped for a fresh store at the start of every property run. */
let inner = new MemoryHistoryStore();

/** Delegates every call to whatever `inner` currently is, so the app can outlive the store. */
const proxy: HistoryStore = {
  appendRun: (...a) => inner.appendRun(...a),
  listSessions: (...a) => inner.listSessions(...a),
  getSession: (...a) => inner.getSession(...a),
  renameSession: (...a) => inner.renameSession(...a),
  deleteSession: (...a) => inner.deleteSession(...a),
  clearAll: (...a) => inner.clearAll(...a),
  deleteRun: (...a) => inner.deleteRun(...a),
  close: () => inner.close(),
};

function appFor(userId: string) {
  return createApp({
    settings,
    history: proxy,
    requirePrincipal: fakePrincipal(userId),
    llm: { generate: async () => MESSAGE_GEN } as unknown as LLMService,
    sandbox: {
      execute: async () => {
        throw new Error("unused");
      },
    } as unknown as SandboxBackend,
  });
}

let serverA: Server;
let serverB: Server;
const servers: Record<string, Server> = {};

beforeAll(() => {
  // Port 0 lets the OS pick a free port — two of these, for the whole file.
  serverA = appFor(A.userId).listen(0);
  serverB = appFor(B.userId).listen(0);
  servers[A.userId] = serverA;
  servers[B.userId] = serverB;
});

afterAll(async () => {
  await new Promise<void>((r) => serverA.close(() => r()));
  await new Promise<void>((r) => serverB.close(() => r()));
  await inner.close();
});

/** One step in a generated sequence: who acts, and what they do. */
type Op = { kind: "append"; owner: Owner; prompt: string } | { kind: "clear"; owner: Owner };

const ownerArb = fc.constantFrom(A, B);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("append" as const),
    owner: ownerArb,
    prompt: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({ kind: fc.constant("clear" as const), owner: ownerArb }),
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 25 });

describe("INV-1 as a property: a listing never contains another owner's session", () => {
  it("holds for any interleaving of appends and clears by two owners", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        inner = new MemoryHistoryStore();
        // The model: who owns each live session id, maintained independently of the store.
        const createdBy = new Map<string, string>();

        for (const op of ops) {
          if (op.kind === "append") {
            const { session } = await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: op.prompt,
              message: "ok",
            });
            createdBy.set(session.id, op.owner.userId);
          } else {
            await request(servers[op.owner.userId]).delete("/api/sessions");
            for (const [id, uid] of createdBy) if (uid === op.owner.userId) createdBy.delete(id);
          }
        }

        for (const owner of [A, B]) {
          const res = await request(servers[owner.userId])
            .get("/api/sessions")
            .query({ limit: 100 });
          expect(res.status).toBe(200);
          for (const session of res.body.sessions) {
            expect(createdBy.get(session.id)).toBe(owner.userId);
          }
        }
      }),
    );
  });
});

describe("INV-5 as a property: clear-all deletes only the caller's data", () => {
  it("leaves every session the other owner created, for any prior sequence", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        inner = new MemoryHistoryStore();

        for (const op of ops) {
          if (op.kind === "append") {
            await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: op.prompt,
              message: "ok",
            });
          }
        }

        const listB = async () =>
          (await request(serverB).get("/api/sessions").query({ limit: 100 })).body.sessions.map(
            (x: { id: string }) => x.id,
          );

        const before = await listB();
        await request(serverA).delete("/api/sessions");
        expect(await listB()).toEqual(before);
        expect((await request(serverA).get("/api/sessions").query({ limit: 100 })).body.total).toBe(
          0,
        );
      }),
    );
  });
});
