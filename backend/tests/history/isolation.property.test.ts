/**
 * INV-1..5 as PROPERTIES rather than examples, against BOTH stores.
 *
 * isolation.test.ts asserts these invariants over cases a human (or a model) chose. That is the
 * weakness this file addresses: whoever picked the cases picked them from the same understanding
 * that produced the code, so a shared misunderstanding survives every one of them. The generator
 * does not share it — it is not reasoning, it is trying things.
 *
 * PARAMETERISED OVER makeStore, exactly like runIsolationBattery. An earlier version ran against
 * MemoryHistoryStore only, so the SQL owner filter — the thing isolation.test.ts exists to prove —
 * got no generated coverage at all, while the file header claimed the invariant was "about the
 * SYSTEM".
 *
 * ONE STORE AND ONE SERVER PAIR PER SUITE, reset between runs. Two reasons, both learned the hard
 * way. A fresh store per run means 200 unclosed Postgres pools per property. And handing supertest
 * an app makes it spin up an ephemeral server per REQUEST, which at these volumes fails on socket
 * churn rather than on logic.
 *
 * The reset is NOT clearAll(): that is the method INV-5 tests, and using it for setup would make
 * the test circular. Memory swaps the object; Postgres truncates.
 *
 * The oracle is the INVARIANT, written in isolation.test.ts and docs/testing-notes.md. Never a
 * reading of memoryStore.ts, pgStore.ts or router.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { fc } from "../fc.js";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import { PostgresHistoryStore } from "../../src/history/pgStore.js";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";
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

/**
 * One generated step. `index` addresses a session or run the model already knows about — fast-check
 * cannot generate a runtime id, so it generates a number and the applier takes it modulo the ids
 * that exist. That is what lets rename / delete-session / delete-run appear in a sequence at all;
 * without them the alphabet is {append, clear} and the four router verbs where INV-2 and INV-3 live
 * are unreachable.
 */
type Op =
  | { kind: "append"; owner: Owner; prompt: string }
  | { kind: "clear"; owner: Owner }
  | { kind: "rename"; owner: Owner; index: number; title: string }
  | { kind: "deleteSession"; owner: Owner; index: number }
  | { kind: "deleteRun"; owner: Owner; index: number };

const ownerArb = fc.constantFrom(A, B);
const idxArb = fc.nat({ max: 50 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("append" as const),
      owner: ownerArb,
      prompt: fc.string({ minLength: 1, maxLength: 16 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("clear" as const), owner: ownerArb }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("rename" as const),
      owner: ownerArb,
      index: idxArb,
      title: fc.string({ minLength: 1, maxLength: 16 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("deleteSession" as const),
      owner: ownerArb,
      index: idxArb,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("deleteRun" as const),
      owner: ownerArb,
      index: idxArb,
    }),
    weight: 2,
  },
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 20 });

/** The model: who owns what, maintained entirely independently of the system under test. */
class Model {
  sessions = new Map<string, string>(); // sessionId -> ownerId
  runs = new Map<string, string>(); // runId -> sessionId
  titles = new Map<string, string>(); // sessionId -> current title
  runPrompt = new Map<string, string>(); // runId -> its prompt (NOT keyed by session: a deleted
  //                                        run must stop being searchable, and keying by session
  //                                        kept its prompt alive — found by this property)

  /**
   * The expected search result, computed with the CONTRACT's semantics: a case-insensitive
   * LITERAL substring over the title or any run prompt. `src/history/store.ts` states this and
   * warns that a SQL implementation must escape LIKE wildcards so it cannot diverge from the
   * in-memory oracle — so the model computes `includes()` and the store must match it exactly.
   * Bounding the result by "no more than the owner has" is NOT enough: an unescaped `%` widens
   * the match WITHIN the owner's own rows, which such a check waves through. Verified.
   */
  matching(owner: Owner, q: string) {
    const needle = q.toLowerCase();
    return this.idsOf(owner)
      .filter((id) => {
        const title = (this.titles.get(id) ?? "").toLowerCase();
        if (title.includes(needle)) return true;
        return [...this.runs.entries()].some(
          ([rid, sid]) =>
            sid === id && (this.runPrompt.get(rid) ?? "").toLowerCase().includes(needle),
        );
      })
      .sort();
  }
  idsOf(owner: Owner) {
    return [...this.sessions.entries()]
      .filter(([, o]) => o === owner.userId)
      .map(([id]) => id)
      .sort();
  }
  runsOf(owner: Owner) {
    return [...this.runs.entries()]
      .filter(([, sid]) => this.sessions.get(sid) === owner.userId)
      .map(([rid]) => rid)
      .sort();
  }
  dropSession(id: string) {
    this.sessions.delete(id);
    this.titles.delete(id);
    for (const [rid, sid] of this.runs) {
      if (sid === id) {
        this.runs.delete(rid);
        this.runPrompt.delete(rid);
      }
    }
  }
}

function runPropertySuite(
  name: string,
  makeStore: () => Promise<HistoryStore>,
  reset: () => Promise<void>,
  numRuns: number,
) {
  describe(`isolation properties: ${name}`, () => {
    let store: HistoryStore;
    const servers: Record<string, Server> = {};
    const srv = (o: Owner) => servers[o.userId];

    beforeAll(async () => {
      store = await makeStore();
      for (const owner of [A, B]) {
        servers[owner.userId] = createApp({
          settings,
          history: store,
          requirePrincipal: fakePrincipal(owner.userId),
          llm: { generate: async () => MESSAGE_GEN } as unknown as LLMService,
          sandbox: {
            execute: async () => {
              throw new Error("unused");
            },
          } as unknown as SandboxBackend,
        }).listen(0);
      }
    });

    afterAll(async () => {
      for (const s of Object.values(servers)) await new Promise<void>((r) => s.close(() => r()));
      await store?.close();
    });

    /** Apply one generated sequence through the HTTP layer, keeping the model in step. */
    async function drive(ops: Op[], m: Model) {
      for (const op of ops) {
        if (op.kind === "append") {
          const { session, run } = await store.appendRun(op.owner, null, {
            kind: "message",
            prompt: op.prompt,
            message: "ok",
          });
          m.sessions.set(session.id, op.owner.userId);
          m.runs.set(run.id, session.id);
          m.titles.set(session.id, session.title);
          m.runPrompt.set(run.id, op.prompt);
          continue;
        }
        if (op.kind === "clear") {
          const res = await request(srv(op.owner)).delete("/api/sessions");
          expect(res.status).toBe(200);
          for (const id of m.idsOf(op.owner)) m.dropSession(id);
          continue;
        }
        // The remaining three address an existing row. An owner with nothing yet is a legitimate
        // generated state, not a reason to skip: the request still goes out and must 404.
        const own = op.kind === "deleteRun" ? m.runsOf(op.owner) : m.idsOf(op.owner);
        const target = own.length
          ? own[op.index % own.length]
          : "00000000-0000-4000-8000-000000000000";
        const hit = own.length > 0;

        if (op.kind === "rename") {
          const res = await request(srv(op.owner))
            .patch(`/api/sessions/${target}`)
            .send({ title: op.title });
          expect(res.status).toBe(hit ? 200 : 404);
          if (hit) m.titles.set(target, op.title);
        } else if (op.kind === "deleteSession") {
          const res = await request(srv(op.owner)).delete(`/api/sessions/${target}`);
          expect(res.status).toBe(hit ? 204 : 404);
          if (hit) m.dropSession(target);
        } else {
          const res = await request(srv(op.owner)).delete(`/api/runs/${target}`);
          expect(res.status).toBe(hit ? 204 : 404);
          if (hit) {
            m.runs.delete(target);
            m.runPrompt.delete(target);
          }
        }
      }
    }

    it("INV-1: a listing returns exactly the caller's sessions, for any interleaving", async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, async (ops) => {
          await reset();
          const m = new Model();
          await drive(ops, m);

          // BOTH DIRECTIONS. Walking the returned rows checking none is foreign also passes when
          // the listing returns nothing at all — verified, on an earlier version of this file.
          for (const owner of [A, B]) {
            const res = await request(srv(owner)).get("/api/sessions").query({ limit: 100 });
            expect(res.status).toBe(200);
            expect(res.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
              m.idsOf(owner),
            );
            expect(res.body.total).toBe(m.idsOf(owner).length);
          }
        }),
        { numRuns },
      );
    });

    it("INV-1 search: ?q= narrows within the caller's own rows and never widens past them", async () => {
      await fc.assert(
        // The query alphabet is weighted toward LIKE metacharacters. A plain fc.string emits `%`
        // or `_` only rarely, so the unescaped-wildcard bug this property exists to find would be
        // reached by chance rather than by design.
        fc.asyncProperty(
          opsArb,
          fc.oneof(
            fc.constantFrom("%", "_", "%%", "a%", "%a", "\\", "%_%"),
            fc.string({ minLength: 1, maxLength: 8 }),
          ),
          async (ops, q) => {
            await reset();
            const m = new Model();
            await drive(ops, m);

            // The search branch is the one src/history/store.ts flags as able to diverge from the
            // in-memory oracle — a Postgres impl must escape LIKE wildcards in `q`. fc.string
            // generates `%` and `_`, which is exactly the input that finds an unescaped LIKE.
            for (const owner of [A, B]) {
              const res = await request(srv(owner)).get("/api/sessions").query({ q, limit: 100 });
              expect(res.status).toBe(200);
              expect(res.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
                m.matching(owner, q),
              );

              // A SECOND QUERY, DRAWN FROM THE DATA. A random `q` almost never exercises the
              // prompt-matching branch: `titleFromPrompt` seeds the title from the first prompt, so
              // a session matching on its prompt usually matches on its title too and dropping the
              // prompt subquery changes nothing. Verified — a planted `OR FALSE AND EXISTS` survived
              // the generated query alone. Searching for a prompt that a rename has decoupled from
              // its title is what reaches that branch.
              const live = [...m.runs.entries()].find(
                ([, sid]) => m.sessions.get(sid) === owner.userId,
              );
              if (live) {
                const needle = m.runPrompt.get(live[0]) ?? "";
                if (needle.trim() !== "") {
                  const r2 = await request(srv(owner))
                    .get("/api/sessions")
                    .query({ q: needle, limit: 100 });
                  expect(r2.status).toBe(200);
                  expect(r2.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
                    m.matching(owner, needle),
                  );
                }
              }
            }
          },
        ),
        { numRuns },
      );
    });

    it("INV-2/3: every one of A's ids is a 404 for B, on every addressable verb", async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, async (ops) => {
          await reset();
          const m = new Model();
          await drive(ops, m);

          const aSessions = m.idsOf(A);
          const aRuns = m.runsOf(A);
          for (const id of aSessions.slice(0, 3)) {
            expect((await request(srv(B)).get(`/api/sessions/${id}`)).status).toBe(404);
            expect(
              (await request(srv(B)).patch(`/api/sessions/${id}`).send({ title: "hijack" })).status,
            ).toBe(404);
            expect((await request(srv(B)).delete(`/api/sessions/${id}`)).status).toBe(404);
          }
          for (const rid of aRuns.slice(0, 3)) {
            expect((await request(srv(B)).delete(`/api/runs/${rid}`)).status).toBe(404);
          }
          // …and none of it damaged A.
          const after = await request(srv(A)).get("/api/sessions").query({ limit: 100 });
          expect(after.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(aSessions);
        }),
        { numRuns },
      );
    });

    it("INV-5: clear-all removes the caller's rows and leaves the other owner's untouched", async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, async (ops) => {
          await reset();
          const m = new Model();
          // Seed both owners so neither side of the assertion is vacuous. Measured on an earlier
          // version: a quarter of runs had no B data, reducing "B survived" to expect([]) === [].
          for (const owner of [A, B]) {
            const { session, run } = await store.appendRun(owner, null, {
              kind: "message",
              prompt: "seed",
              message: "ok",
            });
            m.sessions.set(session.id, owner.userId);
            m.runs.set(run.id, session.id);
          }
          await drive(ops, m);

          // id AND run_count: runs are data too, and clearAll deletes them in an inner loop keyed
          // on sessionId — exactly the nested filter a mutant drops.
          const listB = async () => {
            const res = await request(srv(B)).get("/api/sessions").query({ limit: 100 });
            expect(res.status).toBe(200);
            return res.body.sessions
              .map((x: { id: string; run_count: number }) => ({ id: x.id, run_count: x.run_count }))
              .sort((l: { id: string }, r: { id: string }) => l.id.localeCompare(r.id));
          };

          const before = await listB();
          const del = await request(srv(A)).delete("/api/sessions");
          expect(del.status).toBe(200);
          expect(await listB()).toEqual(before);

          const afterA = await request(srv(A)).get("/api/sessions").query({ limit: 100 });
          expect(afterA.body.total).toBe(0);
          expect(afterA.body.sessions).toEqual([]);
        }),
        { numRuns },
      );
    });
  });
}

// Memory: reset by swapping the object. Cheap, so the full run count.
{
  let mem = new MemoryHistoryStore();
  const proxy: HistoryStore = {
    appendRun: (...a) => mem.appendRun(...a),
    listSessions: (...a) => mem.listSessions(...a),
    getSession: (...a) => mem.getSession(...a),
    renameSession: (...a) => mem.renameSession(...a),
    deleteSession: (...a) => mem.deleteSession(...a),
    clearAll: (...a) => mem.clearAll(...a),
    deleteRun: (...a) => mem.deleteRun(...a),
    close: () => mem.close(),
  };
  runPropertySuite(
    "memory",
    async () => proxy,
    async () => {
      mem = new MemoryHistoryStore();
    },
    200,
  );
}

// Postgres: same properties against the actual SQL, gated on DATABASE_URL like the battery.
// TRUNCATE rather than clearAll() for the reset — clearAll is what INV-5 tests.
//
// FEWER RUNS, deliberately. Every run is a TRUNCATE plus up to twenty round trips to a real
// database; at 200 runs across four properties this suite would dominate the integration step. 40
// still explores far more interleavings than the battery's hand-picked cases, and the memory suite
// above runs the full 200 over the same generator.
const url = process.env.DATABASE_URL;
if (url) {
  const pool = makePool(url);
  runPropertySuite(
    "postgres",
    async () => {
      await migrate(pool);
      return new PostgresHistoryStore(pool);
    },
    async () => {
      await pool.query("TRUNCATE sessions, runs RESTART IDENTITY CASCADE");
    },
    40,
  );
}
