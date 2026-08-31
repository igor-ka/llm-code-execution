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

/** One server per owner, keyed by user id — the single binding, so the two cannot drift. */
const servers: Record<string, Server> = {};
const serverFor = (o: Owner) => servers[o.userId];

beforeAll(() => {
  // Port 0 lets the OS pick a free port — two of these, for the whole file.
  for (const owner of [A, B]) servers[owner.userId] = appFor(owner.userId).listen(0);
});

afterAll(async () => {
  // Iterate what actually got created: if the second listen() throws, an unguarded `serverB.close()`
  // reports "Cannot read properties of undefined" and masks the real bind failure.
  for (const server of Object.values(servers)) {
    await new Promise<void>((r) => server.close(() => r()));
  }
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
            const del = await request(serverFor(op.owner)).delete("/api/sessions");
            expect(del.status).toBe(200);
            for (const [id, uid] of createdBy) if (uid === op.owner.userId) createdBy.delete(id);
          }
        }

        // BOTH DIRECTIONS, and this is the whole assertion. An earlier version only walked the
        // returned sessions checking none belonged to the other owner — which a listSessions that
        // returns NOTHING also satisfies, vacuously. Verified: destroying the listing entirely made
        // that version pass. Comparing the sorted id sets makes "shows me everything of mine" and
        // "shows me nothing of theirs" a single check that neither an owner-filter leak nor a
        // wholesale deletion can survive.
        for (const owner of [A, B]) {
          const res = await request(serverFor(owner)).get("/api/sessions").query({ limit: 100 });
          expect(res.status).toBe(200);
          const returned = res.body.sessions.map((x: { id: string }) => x.id).sort();
          const expected = [...createdBy.entries()]
            .filter(([, uid]) => uid === owner.userId)
            .map(([id]) => id)
            .sort();
          expect(returned).toEqual(expected);
          expect(res.body.total).toBe(expected.length);
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

        // Seed one session per owner BEFORE the generated sequence, so the final assertions are
        // never vacuous. Without it, measured over the pinned seed, a quarter of runs generated no
        // B append — `before` was [] and "B's data survived" reduced to expect([]).toEqual([]).
        // A pinned seed makes that dilution permanent and invisible, so it is fixed structurally
        // rather than with fc.pre, which would just discard those runs.
        for (const owner of [A, B]) {
          await inner.appendRun(owner, null, { kind: "message", prompt: "seed", message: "ok" });
        }

        // EVERY generated op is applied, appends and clears alike. An earlier version had no `else`
        // branch, so all clears were silently dropped — and 91% of generated sequences contain one.
        // The prior state was therefore always append-only, and clear-then-append, two consecutive
        // clears, and B-clears-before-A were all unreachable by a test whose name promises "any
        // prior sequence".
        for (const op of ops) {
          if (op.kind === "append") {
            await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: op.prompt,
              message: "ok",
            });
          } else {
            const del = await request(serverFor(op.owner)).delete("/api/sessions");
            expect(del.status).toBe(200);
            // Re-seed the owner that just cleared, so both owners always hold data at the moment
            // of the final clear — which is the only moment this property is about.
            await inner.appendRun(op.owner, null, {
              kind: "message",
              prompt: "reseed",
              message: "ok",
            });
          }
        }

        // id AND run_count: runs are data too, and `clearAll` deletes them in an inner loop keyed
        // on sessionId. Mapping to ids alone would let a clear-all that wipes EVERY owner's runs
        // while deleting only the caller's sessions pass — B's ids unchanged, B's run_count
        // silently zero.
        const listB = async () => {
          const res = await request(serverFor(B)).get("/api/sessions").query({ limit: 100 });
          expect(res.status).toBe(200);
          return res.body.sessions
            .map((x: { id: string; run_count: number }) => ({ id: x.id, run_count: x.run_count }))
            .sort((l: { id: string }, r: { id: string }) => l.id.localeCompare(r.id));
        };

        const before = await listB();
        expect(before.length).toBeGreaterThan(0); // the seeding above guarantees this

        const del = await request(serverFor(A)).delete("/api/sessions");
        expect(del.status).toBe(200);
        expect(del.body.deleted).toBeGreaterThan(0);

        expect(await listB()).toEqual(before);
        const afterA = await request(serverFor(A)).get("/api/sessions").query({ limit: 100 });
        expect(afterA.status).toBe(200);
        expect(afterA.body.total).toBe(0);
        expect(afterA.body.sessions).toEqual([]);
      }),
    );
  });
});
