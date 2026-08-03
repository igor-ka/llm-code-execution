# Per-User Chat History Implementation Plan

**Goal:** Persist each user's prompt→execute activity as isolated, grouped **sessions**
of **runs** in Postgres, so a signed-in user can list, reopen, search, rename, delete,
and clear their own history — and no other user can ever see it.

**Architecture:** Introduce the project's first datastore behind a swappable
`HistoryStore` interface (same seam pattern as `SandboxBackend`). Isolation is
**structural**: every store method takes an `Owner` derived from the verified token and
filters `WHERE user_id = :sub`; cross-owner id access returns 404. A thin **foundation**
issue fixes the interface + domain types + Zod DTOs + an in-memory test double, after
which four tracks (Postgres impl, persist-on-execute, history REST router, frontend UI)
proceed in parallel against that contract, then an adversarial isolation battery and docs
close it out.

**Tech Stack:** Node 22, TypeScript, Express 5, `pg` (node-postgres, raw SQL — no ORM,
matching the repo's hand-rolled `dockerode`/`jose` style), a minimal in-repo SQL migration
runner, Zod (DTOs), Vitest + Supertest (tests). Frontend: React + Vite (existing), no new
routing dependency (local state).

---

## How this maps to GitHub issues (the "spine" + fan-out)

This plan is the master reference. It is realized on GitHub as **one epic (spine) issue**
mirroring the format of epic #9, plus **seven child issues** (`H0`–`H6`). The epic body
carries the locked decisions and a checklist linking the children. **No issues are created
until this plan has passed the staff-engineer review and you have approved it.**

Dependency graph (the only hard serialization point is H0):

```
                 ┌─> H1  Postgres impl + migrations + compose/CI ─┐
   H0            ├─> H2  Persist-on-execute                        ├─> H5  Isolation/security battery ─> H6 Docs
 Foundation ─────┼─> H3  History REST router                      ─┘
 (interface,     └─> H4  Frontend history UI ──────────────────────────────(integrates in H5 / manual QA)
  DTOs, double)
```

- **H0 blocks everything**; it is small (pure TS: interface, types, DTOs, in-memory double).
- **H1–H4 run fully in parallel** after H0 — each codes against the `HistoryStore`
  interface and the in-memory double, so none needs a running Postgres or another track's
  code. The shared `createApp` store seam (`AppDeps.history` + the `getHistory()` getter,
  and the additive `history_enabled` flag on `GET /api/config`) is **owned by H0**, so H1
  (fills in production `PostgresHistoryStore` construction inside `getHistory`), H2 (reads it
  in the `/api/execute` handler), H3 (reads it at the router mount line), and H4 (reads
  `history_enabled` on the client) each extend a **different region** — no shared new symbol
  is introduced by two issues, so there is no ownership collision or merge hazard.
- **H5** is the integration + adversarial isolation proof; it depends on H1+H2+H3 being
  wired. **H6** is docs. H4 integrates against the live endpoints once H2/H3 land (it can
  develop against the in-memory double / a mock in the meantime).

---

## Contracts that must not change (verify against these throughout)

- **Existing HTTP API stays backward-compatible.** `GET /api/health` unchanged.
  `GET /api/config` gains one **additive** field `history_enabled` alongside the existing
  `auth_required` (old clients ignore unknown keys; the frontend reads it to show/hide the
  history UI). `POST /api/execute` keeps its existing request/response for **anonymous**
  callers (auth disabled): body `{prompt}`, responses `{type:"message",…}` /
  `{type:"result",…}` in **snake_case**, same status codes (401/403/422/502/503). The only
  additions are **optional** request field `session_id` and **optional** response fields
  `session_id` + `run_id`, present only when the caller is authenticated and persistence
  succeeds. `frontend/src/api.ts` consumes these keys verbatim.
- **Identity is server-derived, never from the body.** `Owner` comes from
  `res.locals.principal` (`{userId: sub, tenantId: org_id}`), exactly as `auth.ts` sets it.
  A `session_id`/`run_id`/path `:id` is only ever honored after an owner-scoped lookup.
- **CI job names** `Backend checks` / `Frontend checks` stay (ruleset contract). New work
  adds *steps inside* the backend job (a Postgres service + an integration-test step) and a
  `test:integration` / `migrate` target inside `verify.sh` — never a new job name.
- **`verify.sh` is the single source of truth** for checks; CI calls the same script.

## Locked decisions (from the requirements conversation)

- **Datastore: Postgres, dockerized**, behind a `HistoryStore` interface. First concrete
  impl is `PostgresHistoryStore`; the interface keeps the choice from leaking into call sites.
- **Model: grouped sessions.** `sessions` (1) ⇒ `runs` (N). One-shot per run (no `llm.ts`
  change, no multi-turn context). The no-code "message" path is persisted too.
- **Controls (all in v1):** list + reopen, search, rename, delete one run, delete one
  session, clear all.
- **Isolation keyed on the verified `sub`.** Enforced in the data layer on every method.
  `runs.user_id` is denormalized as defense-in-depth. Cross-owner access → **404** (never
  leaks existence). `tenant_id` (`org_id`) is stored alongside for future tenant-scoped
  views but is **not** part of the v1 isolation predicate (per-user, as asked).
- **History is an authenticated feature.** With `AUTH_REQUIRED=false` there is no `sub`;
  `/api/execute` then simply does not persist (unchanged behavior), and the history
  endpoints refuse (see open question (c)).

## Resolved decisions (accepted defaults)

Surfaced for sign-off and **accepted 2026-08-03**; each is now locked. The recommended
default was taken in every case (a)–(f).

- **(a) DB access layer.** Recommended: **`pg` (raw SQL) + a ~40-line in-repo migration
  runner** applying ordered `migrations/*.sql`, tracked in a `schema_migrations` table.
  Matches the repo's explicit, minimal-dependency style. Alternatives: `node-pg-migrate`
  (more machinery) or Prisma (an ORM + codegen + a second schema source of truth — heavier
  than this codebase's grain).
- **(b) Integration-test strategy.** Recommended: unit tests stay DB-free (run against the
  in-memory double) and always run; a separate **`verify.sh test:integration`** target runs
  the same contract suite against a real Postgres, **gated on `DATABASE_URL` being set**
  (skips with a clear message otherwise, mirroring `SKIP_DOCKER`). CI adds a `postgres`
  **service container** to the `Backend checks` job and an "Integration test" step.
  Alternative: Testcontainers (identical local/CI, but adds a Docker dependency to the test
  step, which currently has none).
- **(c) Anonymous-mode behavior for history routes.** Recommended: when the principal has a
  **null `userId`** (auth disabled), the history routes return **404** (the feature does not
  exist without identity). Alternatives: 401 or 501. `/api/execute` remains fully functional
  and simply does not persist.
- **(d) Search implementation for v1.** Recommended: case-insensitive **`ILIKE`** over
  session `title` + run `prompt`, scoped to the owner. Alternative/scale path: a `pg_trgm`
  GIN index or a `tsvector` full-text column (noted as a follow-up, not v1).
- **(e) Persistence-failure policy on `/api/execute`.** Recommended: **best-effort** — a
  history write that throws is logged and swallowed; the execute response is still returned
  (without `session_id`/`run_id`) so a DB hiccup never breaks code execution. Alternative:
  fail the request (rejected — couples core function to the new subsystem).
- **(f) Retention.** None in v1 (history is unbounded per user). Noted as a follow-up
  (retention window / per-user row cap) alongside the existing per-user quota roadmap item.

---

## Isolation invariants (security spec)

This feature exists to satisfy one hard requirement: **no user can ever see or affect
another user's history.** That requirement is specified here as numbered invariants, each
mapped to the test(s) that prove it. This spec is the source of truth; the epic **cannot be
closed until every invariant is green against both the in-memory store and Postgres**. H5
carries these as explicit acceptance criteria.

| # | Invariant | Proven by |
|---|-----------|-----------|
| **INV-1** | A user's `listSessions`/search never returns another user's session or run. | H0 contract (`isolates…`, `clearAll…`, `search…`); H3 `router.test.ts` (list/search scoping); H5 matrix |
| **INV-2** | `GET`/`PATCH`/`DELETE /api/sessions/:id` for a session the caller does not own returns **404**, indistinguishable from a nonexistent id. | H0 contract (`isolates…` → null/false); H3 `router.test.ts` (cross-user 404); H5 matrix |
| **INV-3** | `DELETE /api/runs/:id` for an unowned run returns 404 / `false` and deletes nothing. | H0 contract (`deleteRun is owner-scoped`); H3 `router.test.ts`; H5 matrix |
| **INV-4** | `POST /api/execute` / `appendRun` with a `session_id` the caller does not own returns **404** and writes **nothing** to the other user's session. | H0 contract (`appendRun … throws SessionNotFound`); H2 `execute.persist.test.ts`; H5 matrix (verifies the victim session is unchanged) |
| **INV-5** | `clearAll` / `DELETE /api/sessions` deletes only the caller's data. | H0 contract (`clearAll removes only the caller's sessions`); H3 `router.test.ts`; H5 matrix |
| **INV-6** | In anonymous mode (`AUTH_REQUIRED=false`, `userId` null) every history route returns 404 and `/api/execute` persists nothing (no `session_id`/`run_id` in the response). | H2 `execute.persist.test.ts` (anonymous case); H3 `router.test.ts` (anonymous 404); H5 anonymous-mode test |
| **INV-7** | Deliberately weakening any owner filter (a planted hole) makes the isolation battery **fail** — i.e. the tests would catch a regression that drops `WHERE user_id`. | H5 `historyMutants.ts` (mutation-style planted-hole assertions) |
| **INV-8** | Enumeration is not possible: a real foreign id and a random UUID both yield an **identical** 404 (same status, same body) — no existence/shape/timing leak. | H5 enumeration guard |

Every `HistoryStore` method takes an `Owner` as its first argument, so an implementation
*cannot* be called without an owner to filter on — INV-1…INV-5 are structural, not
incidental. INV-6…INV-8 guard the wiring and guard against future regressions.

---

## Data model

`backend/migrations/001_history.sql` (applied by the runner in H1; the shape is fixed here
in H0 so every track codes to it):

```sql
-- gen_random_uuid() lives in pgcrypto (bundled with modern Postgres images).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,                 -- verified `sub`
  tenant_id   TEXT,                          -- verified `org_id`, nullable
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Primary list query: a user's sessions, most-recently-active first.
CREATE INDEX idx_sessions_user_updated ON sessions (user_id, updated_at DESC);

CREATE TABLE runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,                 -- denormalized owner (defense-in-depth)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('message','result')),
  message     TEXT,                          -- kind='message'
  language    TEXT,                          -- kind='result' below
  code        TEXT,
  stdout      TEXT,
  stderr      TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  timed_out   BOOLEAN
);
CREATE INDEX idx_runs_session ON runs (session_id, created_at);
CREATE INDEX idx_runs_user ON runs (user_id);
```

Deleting a session cascades its runs. "Clear all" deletes the owner's sessions (runs
cascade). Every read/write is predicated on `user_id`.

---

## File structure

```
backend/
  migrations/
    001_history.sql              schema above (H1)
  src/
    history/
      types.ts                   Owner, Session, Run, NewRun, SessionPage (H0)
      store.ts                   HistoryStore interface + SessionNotFound error (H0)
      dto.ts                     Zod request schemas + snake_case wire builders (H0)
      memoryStore.ts             in-memory HistoryStore (tests + local double) (H0)
      pgStore.ts                 PostgresHistoryStore (H1)
      pool.ts                    pg Pool factory from DATABASE_URL (H1)
      migrate.ts                 minimal ordered-SQL migration runner (H1)
      router.ts                  Express Router: sessions CRUD + search + run delete (H3)
      contractTests.ts           shared suite run against BOTH stores (H0 defines; H1 reuses)
    config.ts                    + databaseUrl, historyEnabled (H1)
    schemas.ts                   ExecuteRequest gains optional session_id; response builders
                                 gain optional session_id/run_id (H2)
    server.ts                    execute handler persists (H2); mounts history router (H3)
    index.ts                     runs migrations on boot before listen (H1)
  tests/
    history/
      memoryStore.test.ts        contract suite vs memory (H0)
      pgStore.test.ts            contract suite vs Postgres, gated on DATABASE_URL (H1)
      execute.persist.test.ts    persist-on-execute (H2)
      router.test.ts             endpoint behavior + isolation (H3)
      isolation.test.ts          adversarial cross-user matrix + planted-hole (H5)
  verify.sh                      + migrate, + test:integration targets (H1)
frontend/
  src/
    api.ts                       session methods + execute(session_id) (H4)
    history.ts                   typed client types for sessions/runs (H4)
    components/
      HistorySidebar.tsx         sessions list, search, new, rename, delete, clear (H4)
      SessionView.tsx            runs of the selected session + the run form (H4)
    App.tsx                      compose sidebar + session view (H4)
docs/
  plans/2026-08-02-per-user-chat-history.md   this file
.env.example                     + DATABASE_URL (H1)
docker-compose.yml               + postgres service & volume; backend DATABASE_URL (H1)
.github/workflows/ci.yml         + postgres service & Integration-test step (H1)
README.md                        datastore, security posture, roadmap (H6)
```

---

## Issue H0 — Foundation: interface, domain types, DTOs, in-memory double

**Why first:** fixes the contract every other track compiles against. Pure TS; no Postgres,
no Express wiring. Ships with a fully-tested in-memory store so H2/H3/H4 have a working
dependency to inject immediately.

**Files:**
- Create: `backend/src/history/types.ts`, `backend/src/history/store.ts`,
  `backend/src/history/dto.ts`, `backend/src/history/memoryStore.ts`,
  `backend/src/history/contractTests.ts`
- Modify: `backend/src/server.ts` (the shared store seam — `AppDeps.history` +
  `getHistory()` getter + additive `history_enabled` on `GET /api/config`),
  `backend/tests/helpers/auth.ts` (add the `fakePrincipal` seam),
  `backend/tests/config.test.ts` (assert `history_enabled` present)
- Test: `backend/tests/history/memoryStore.test.ts`

- [ ] **Step 1: Domain types.** Create `backend/src/history/types.ts`:

```ts
/** Domain types for chat history. Wire (snake_case) shapes live in dto.ts. */

/** The isolation key, derived from the verified token — never from the request body. */
export interface Owner {
  userId: string; // verified `sub`; history requires a non-null userId
  tenantId: string | null; // verified `org_id`, stored but not part of the v1 predicate
}

export interface Session {
  id: string;
  userId: string;
  tenantId: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted run mirrors the /api/execute response union plus provenance columns. */
export type Run = {
  id: string;
  sessionId: string;
  userId: string;
  createdAt: Date;
  prompt: string;
} & (
  | { kind: "message"; message: string }
  | {
      kind: "result";
      language: string;
      code: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }
);

/** What a caller hands appendRun — everything except server-assigned provenance. */
export type NewRun = { prompt: string } & (
  | { kind: "message"; message: string }
  | {
      kind: "result";
      language: string;
      code: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }
);

export interface SessionPage {
  sessions: (Session & { runCount: number })[];
  total: number;
}

export interface ListOptions {
  q?: string;
  limit: number;
  offset: number;
}
```

- [ ] **Step 2: The interface + error.** Create `backend/src/history/store.ts`:

```ts
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
  appendRun(owner: Owner, sessionId: string | null, run: NewRun): Promise<{ session: Session; run: Run }>;
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
```

- [ ] **Step 3: DTOs (Zod requests + snake_case wire builders).** Create
  `backend/src/history/dto.ts`. Run wire shape **equals** the `/api/execute` response union
  plus `{id, session_id, created_at, prompt}`, so the frontend renders past runs with the
  same component:

```ts
import { z } from "zod";
import type { Session, Run } from "./types.js";

export const CreateSessionRequest = z.object({ title: z.string().min(1).max(120).optional() });
export const RenameSessionRequest = z.object({ title: z.string().min(1).max(120) });
export const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function sessionWire(s: Session & { runCount?: number }) {
  return {
    id: s.id,
    title: s.title,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    ...(s.runCount === undefined ? {} : { run_count: s.runCount }),
  };
}

export function runWire(r: Run) {
  const base = {
    id: r.id,
    session_id: r.sessionId,
    created_at: r.createdAt.toISOString(),
    prompt: r.prompt,
  };
  if (r.kind === "message") return { ...base, type: "message" as const, message: r.message };
  return {
    ...base,
    type: "result" as const,
    language: r.language,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
    timed_out: r.timedOut,
  };
}

export function sessionWithRunsWire(s: Session & { runs: Run[] }) {
  return { ...sessionWire(s), runs: s.runs.map(runWire) };
}
```

- [ ] **Step 4: Write the shared contract test suite.** Create
  `backend/src/history/contractTests.ts` — a function that, given a store factory, exercises
  the whole interface **including isolation**. H1 reuses it against Postgres verbatim:

```ts
import { expect, it, describe } from "vitest";
import type { HistoryStore } from "./store.js";
import type { Owner } from "./types.js";

const A: Owner = { userId: "auth0|aaa", tenantId: null };
const B: Owner = { userId: "auth0|bbb", tenantId: null };

/** Run the full HistoryStore contract against `make()` (fresh, empty store per call). */
export function runHistoryContract(name: string, make: () => Promise<HistoryStore>) {
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
      const { session } = await s.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
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
      const { session } = await s.appendRun(A, null, { kind: "message", prompt: "p", message: "m" });
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
      const { run: r2 } = await s.appendRun(A, session.id, { kind: "message", prompt: "two", message: "m" });
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
```

- [ ] **Step 5: Run the suite — it fails (no impl).** Wire a throwaway
  `backend/tests/history/memoryStore.test.ts` that calls
  `runHistoryContract("memory", async () => new MemoryHistoryStore())`.
  Run: `cd backend && npx vitest run tests/history/memoryStore.test.ts`
  Expected: FAIL — `MemoryHistoryStore` is not defined.

- [ ] **Step 6: Implement `MemoryHistoryStore`.** Create
  `backend/src/history/memoryStore.ts`. It is a real, ordered, owner-filtered store — not a
  stub — so it is a faithful oracle for the contract and safe to inject in H2/H3 tests:

```ts
import type { HistoryStore } from "./store.js";
import { SessionNotFound, titleFromPrompt } from "./store.js";
import type { Owner, Session, Run, NewRun, SessionPage, ListOptions } from "./types.js";

/** Deterministic ids without Date.now/Math.random (both are fine in prod code, but a
 *  monotonic counter keeps tests stable and ordering explicit). */
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
    const stored: Run = {
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
```

- [ ] **Step 7: Run the suite — it passes.**
  Run: `cd backend && npx vitest run tests/history/memoryStore.test.ts`
  Expected: PASS (all contract cases green).

- [ ] **Step 8: Add the shared store seam to `createApp` (owned here so H1–H4 stay parallel).**
  In `backend/src/server.ts`: add `history?: HistoryStore` to `AppDeps`; construct the getter
  next to the existing `getLlm`/`getSandbox` singletons; and surface the flag on `/api/config`.
  H1 later extends the getter body to build the real Postgres store; H2/H3 only *read* it.

```ts
// in AppDeps:  history?: HistoryStore;   (import type { HistoryStore } from "./history/store.js")

// alongside getLlm/getSandbox in createApp:
let history = deps.history;
// H0 returns only an injected store (tests). H1 extends this to lazily build a
// PostgresHistoryStore when settings.historyEnabled, caching it in `history`.
const getHistory = (): HistoryStore | undefined => history;

// extend GET /api/config (additive — old clients ignore the new key):
app.get("/api/config", (_req, res) => {
  res.json({ auth_required: settings.authRequired, history_enabled: getHistory() !== undefined });
});
```

  Update `backend/tests/config.test.ts` to assert the response carries `history_enabled`.
  ESLint stays green because `getHistory` is used by `/api/config` immediately.

- [ ] **Step 9: Add the `fakePrincipal` test seam.** In `backend/tests/helpers/auth.ts` add a
  reusable middleware factory so H2/H3 tests can inject an identity without a real token:

```ts
import type { RequestHandler } from "express";
/** A requirePrincipal stand-in for tests: sets res.locals.principal directly.
 *  Pass userId=null to exercise anonymous mode. */
export function fakePrincipal(userId: string | null, tenantId: string | null = null): RequestHandler {
  return (_req, res, next) => {
    res.locals.principal = { userId, tenantId };
    next();
  };
}
```

- [ ] **Step 10: Full backend verify + commit.**
  Run: `cd backend && SKIP_DOCKER=1 ./verify.sh` — Expected: lint + format + tsc + vitest pass.

```bash
git add backend/src/history backend/tests/history/memoryStore.test.ts \
  backend/src/server.ts backend/tests/helpers/auth.ts backend/tests/config.test.ts
git commit -m "feat(history): HistoryStore interface, DTOs, in-memory store + contract suite; createApp store seam + /api/config history_enabled"
```

**H0 done ⇒ H1, H2, H3, H4 can start in parallel** (all four extend the H0-owned
`getHistory` seam in disjoint regions).

---

## Issue H1 — Postgres impl + migrations + compose/CI service

**Depends on:** H0. **Parallel with:** H2, H3, H4.

**Files:**
- Create: `backend/src/history/pool.ts`, `backend/src/history/migrate.ts`,
  `backend/src/history/cli-migrate.ts`, `backend/migrations/001_history.sql`,
  `backend/src/history/pgStore.ts`, `backend/tests/history/pgStore.test.ts`,
  `backend/tests/history/migrate.test.ts`
- Modify: `backend/src/config.ts` (+`databaseUrl`, +`historyEnabled`),
  `backend/src/server.ts` (extend the H0 `getHistory` getter to build the real store),
  `backend/src/index.ts` (run migrations before listen),
  `backend/package.json` (+`pg`, +`@types/pg`; +`test:integration` script),
  `backend/verify.sh` (+`migrate`, +`test:integration` targets),
  `.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`

- [ ] **Step 1: Add deps.**
  Run: `cd backend && npm install pg && npm install -D @types/pg`

- [ ] **Step 2: Config.** In `backend/src/config.ts` add to `Settings` and `loadSettings`:

```ts
// in interface Settings
databaseUrl: string;
historyEnabled: boolean; // convenience: authRequired && databaseUrl set

// in loadSettings(), before the return, compute historyEnabled:
const databaseUrl = str(env.DATABASE_URL, "");
// ...add to the returned object:
//   databaseUrl,
//   historyEnabled: bool(env.AUTH_REQUIRED, true) && databaseUrl !== "",
```

- [ ] **Step 3: pg pool factory.** Create `backend/src/history/pool.ts`:

```ts
import { Pool } from "pg";

/** One pool per process; construct lazily so /api/health boots without a DB. */
export function makePool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
```

- [ ] **Step 4: Migration SQL.** Create `backend/migrations/001_history.sql` with the exact
  schema from the **Data model** section above.

- [ ] **Step 5: Minimal migration runner (TDD).** Create
  `backend/tests/history/migrate.test.ts` first (gated like the pgStore suite, see Step 8),
  asserting `migrate(pool)` is idempotent (running twice is a no-op and both tables exist).
  Then create `backend/src/history/migrate.ts`:

```ts
import type { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Apply any *.sql in migrations/ not yet recorded, in filename order, each in a txn. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (done.rowCount) continue;
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
```

- [ ] **Step 6: Implement `PostgresHistoryStore`.** Create `backend/src/history/pgStore.ts`
  implementing every `HistoryStore` method with owner-scoped SQL. Isolation predicate is in
  **every** statement. Key statements (full file implements all methods):

```ts
import type { Pool, PoolClient } from "pg";
import type { HistoryStore } from "./store.js";
import { SessionNotFound, titleFromPrompt } from "./store.js";
import type { Owner, Session, Run, NewRun, SessionPage, ListOptions } from "./types.js";

export class PostgresHistoryStore implements HistoryStore {
  constructor(private pool: Pool) {}

  async listSessions(owner: Owner, opts: ListOptions): Promise<SessionPage> {
    const like = opts.q ? `%${opts.q}%` : null;
    // Owner-scoped; optional ILIKE over title OR any run prompt in the session.
    const where = like
      ? `s.user_id = $1 AND (s.title ILIKE $2 OR EXISTS
           (SELECT 1 FROM runs r WHERE r.session_id = s.id AND r.prompt ILIKE $2))`
      : `s.user_id = $1`;
    const params: unknown[] = like ? [owner.userId, like] : [owner.userId];
    const totalRes = await this.pool.query(
      `SELECT count(*)::int AS n FROM sessions s WHERE ${where}`,
      params,
    );
    const rows = await this.pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM runs r WHERE r.session_id = s.id) AS run_count
         FROM sessions s WHERE ${where}
         ORDER BY s.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, opts.offset],
    );
    return { total: totalRes.rows[0].n, sessions: rows.rows.map(rowToSessionWithCount) };
  }

  async getSession(owner: Owner, id: string) {
    const s = await this.pool.query(`SELECT * FROM sessions WHERE id = $1 AND user_id = $2`, [
      id,
      owner.userId,
    ]);
    if (!s.rowCount) return null; // not owned OR absent → indistinguishable to the caller
    const runs = await this.pool.query(
      `SELECT * FROM runs WHERE session_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return { ...rowToSession(s.rows[0]), runs: runs.rows.map(rowToRun) };
  }

  async renameSession(owner: Owner, id: string, title: string): Promise<Session | null> {
    const res = await this.pool.query(
      `UPDATE sessions SET title = $3, updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, owner.userId, title],
    );
    return res.rowCount ? rowToSession(res.rows[0]) : null;
  }

  async deleteSession(owner: Owner, id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM sessions WHERE id = $1 AND user_id = $2`, [
      id,
      owner.userId,
    ]);
    return (res.rowCount ?? 0) > 0; // runs cascade via FK
  }

  async clearAll(owner: Owner): Promise<number> {
    const res = await this.pool.query(`DELETE FROM sessions WHERE user_id = $1`, [owner.userId]);
    return res.rowCount ?? 0;
  }

  async appendRun(owner: Owner, sessionId: string | null, run: NewRun) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await this.resolveSession(client, owner, sessionId, run.prompt);
      const inserted = await client.query(
        `INSERT INTO runs (session_id, user_id, prompt, kind, message, language, code, stdout, stderr, exit_code, duration_ms, timed_out)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        runInsertParams(session.id, owner.userId, run),
      );
      await client.query(`UPDATE sessions SET updated_at = now() WHERE id = $1`, [session.id]);
      await client.query("COMMIT");
      return { session, run: rowToRun(inserted.rows[0]) };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async resolveSession(
    client: PoolClient,
    owner: Owner,
    sessionId: string | null,
    prompt: string,
  ): Promise<Session> {
    if (sessionId === null) {
      const res = await client.query(
        `INSERT INTO sessions (user_id, tenant_id, title) VALUES ($1,$2,$3) RETURNING *`,
        [owner.userId, owner.tenantId, titleFromPrompt(prompt)],
      );
      return rowToSession(res.rows[0]);
    }
    const res = await client.query(`SELECT * FROM sessions WHERE id = $1 AND user_id = $2`, [
      sessionId,
      owner.userId,
    ]);
    if (!res.rowCount) throw new SessionNotFound(sessionId);
    return rowToSession(res.rows[0]);
  }

  async deleteRun(owner: Owner, id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM runs WHERE id = $1 AND user_id = $2`, [
      id,
      owner.userId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Row mappers (rowToSession/rowToRun/rowToSessionWithCount) + runInsertParams live at file
// bottom; they map snake_case columns to the camelCase domain types and expand the NewRun
// union into positional params (nulls for the absent branch's columns).
```

- [ ] **Step 7: Reuse the contract suite against Postgres.** Create
  `backend/tests/history/pgStore.test.ts`:

```ts
import { runHistoryContract } from "../../src/history/contractTests.js";
import { makePool } from "../../src/history/pool.js";
import { migrate } from "../../src/history/migrate.js";
import { PostgresHistoryStore } from "../../src/history/pgStore.js";

import { describe } from "vitest";

const url = process.env.DATABASE_URL;
// Gated: unit runs (no DB) skip this file; the integration target sets DATABASE_URL.
(url ? describe : describe.skip)("postgres", () => {
  runHistoryContract("postgres", async () => {
    const pool = makePool(url!);
    await migrate(pool);
    // Fresh state per store: truncate is fine — the contract asserts cross-user isolation,
    // not cross-test carryover.
    await pool.query("TRUNCATE sessions, runs RESTART IDENTITY CASCADE");
    return new PostgresHistoryStore(pool);
  });
});
```

- [ ] **Step 8a: CLI migration wrapper.** Create `backend/src/history/cli-migrate.ts` — the
  file `verify.sh migrate` invokes (this is the artifact the earlier plan draft left dangling):

```ts
import { getSettings } from "../config.js";
import { makePool } from "./pool.js";
import { migrate } from "./migrate.js";

/** `node --import tsx src/history/cli-migrate.ts` — apply pending migrations, then exit. */
const url = getSettings().databaseUrl;
if (!url) {
  console.error("DATABASE_URL is not set; nothing to migrate.");
  process.exit(1);
}
const pool = makePool(url);
migrate(pool)
  .then(() => pool.end())
  .then(() => {
    console.log("migrations applied.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

- [ ] **Step 8b: `verify.sh` targets + `package.json` script.** Add to `backend/package.json`
  scripts: `"test:integration": "tsc -p tsconfig.test.json && vitest run tests/history/pgStore.test.ts tests/history/migrate.test.ts"`.
  In `backend/verify.sh` add functions and case entries:

```bash
migrate() { run node --import tsx src/history/cli-migrate.ts; }
integration() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "==> skipping integration tests (DATABASE_URL not set)"; return 0
  fi
  run npm run test:integration
}
# add to case: test:integration) integration ;;   migrate) migrate ;;
# and call `integration` inside all() after test_.
```

- [ ] **Step 9: Run migrations on boot.** In `backend/src/index.ts`, when
  `settings.databaseUrl` is set, `await migrate(makePool(...))` before `listen`. Guard so an
  empty `DATABASE_URL` (anonymous/local mode) boots without a DB.

- [ ] **Step 9b: Build the real store in the H0 `getHistory` seam.** Extend the getter added
  in H0 Step 8 so production constructs a single cached `PostgresHistoryStore` (one pool) when
  history is enabled; tests still win via the injected `deps.history`:

```ts
// backend/src/server.ts — replace the H0 getter body:
let history = deps.history;
const getHistory = (): HistoryStore | undefined => {
  if (history) return history;
  if (settings.historyEnabled) history = new PostgresHistoryStore(makePool(settings.databaseUrl));
  return history;
};
```

  This is the *only* place the production store is constructed — H2 and H3 just call
  `getHistory()`. Add a test (injected store beats construction; `historyEnabled=false` →
  `undefined`).

- [ ] **Step 10: `.env.example`, compose, CI.**
  - `.env.example`: add `DATABASE_URL=postgres://app:app@localhost:5432/app` under a new
    "History (Postgres)" section, with a note that leaving it empty disables persistence.
  - `docker-compose.yml`: add a `postgres:16` service (env `POSTGRES_USER/PASSWORD/DB`), a
    named volume `pgdata`, `backend.depends_on: [postgres]`, and
    `backend.environment.DATABASE_URL: postgres://app:app@postgres:5432/app`.
  - `.github/workflows/ci.yml`, **`Backend checks` job (name unchanged)**: add a `postgres`
    **service** with a health check, and after the existing `Test` step add:

```yaml
      - name: Integration test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
        run: ./verify.sh test:integration
```

- [ ] **Step 11: Verify + commit.** With a local Postgres up
  (`docker compose up -d postgres`), run
  `cd backend && DATABASE_URL=postgres://app:app@localhost:5432/app SKIP_DOCKER=1 ./verify.sh`
  then `./verify.sh test:integration`. Expected: contract suite passes against Postgres.

```bash
git add backend/src/history/{pool,migrate,pgStore}.ts backend/migrations backend/tests/history/{pgStore,migrate}.test.ts \
  backend/src/config.ts backend/src/index.ts backend/package.json backend/package-lock.json backend/verify.sh \
  .env.example docker-compose.yml .github/workflows/ci.yml
git commit -m "feat(history): Postgres store, migration runner, compose+CI Postgres service"
```

---

## Issue H2 — Persist on execute

**Depends on:** H0. **Parallel with:** H1, H3, H4. **Touches only** the `/api/execute`
handler + `schemas.ts` (no overlap with H3's router file).

**Files:**
- Modify: `backend/src/schemas.ts` (optional `session_id` in `ExecuteRequest`; optional
  `session_id`/`run_id` on response builders), `backend/src/server.ts` (persist in the
  `/api/execute` handler via the H0-owned `getHistory()` seam — the `AppDeps.history` field
  and getter already exist)
- Test: `backend/tests/history/execute.persist.test.ts`

- [ ] **Step 1: Extend schemas.** In `backend/src/schemas.ts`:

```ts
export const ExecuteRequest = z.object({
  prompt: z.string().min(1).max(8000),
  session_id: z.string().uuid().optional(), // continue an existing session; omit to start one
});
```

  And give both builders an optional trailer merged into the wire object:

```ts
type Persisted = { sessionId?: string; runId?: string };
const persistedWire = (p?: Persisted) =>
  p?.sessionId && p?.runId ? { session_id: p.sessionId, run_id: p.runId } : {};

export function messageResponse(message: string, p?: Persisted) {
  return { type: "message" as const, message, ...persistedWire(p) };
}
export function resultResponse(language: string, code: string, r: SandboxResult, p?: Persisted) {
  return {
    type: "result" as const,
    language,
    code,
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
    timed_out: r.timedOut,
    ...persistedWire(p),
  };
}
```

- [ ] **Step 2: Write the failing test.** `backend/tests/history/execute.persist.test.ts`
  builds the app via `createApp({ ..., history: new MemoryHistoryStore(), requirePrincipal:
  fakePrincipal("auth0|aaa") })` and asserts: (a) an authed message-path execute returns
  `session_id`+`run_id` and creates one session with one run; (b) a follow-up execute with
  that `session_id` appends a second run to the same session; (c) an **anonymous** app
  (`requirePrincipal` sets `userId:null`) returns **no** `session_id`/`run_id` and persists
  nothing; (d) an execute with an unowned/unknown `session_id` returns **404**.
  Run: `npx vitest run tests/history/execute.persist.test.ts` → FAIL.

- [ ] **Step 3: Wire persistence in `server.ts`.** Read the H0-owned seam via `getHistory()`.
  In the `/api/execute` handler: derive the owner from the principal; **before** invoking the
  sandbox, if a `session_id` was supplied, verify ownership so a bad id 404s *without* burning
  a sandbox run (INV-4 stays enforced by `appendRun` regardless — this is an optimization plus
  a fast, cheap 404). After computing the response, persist **best-effort**:

```ts
const principal = res.locals.principal as Principal;
const owner = principal.userId ? { userId: principal.userId, tenantId: principal.tenantId } : null;
const store = getHistory();
const sessionId = parsed.data.session_id ?? null;

// Fast owner-scoped pre-check: reject an unowned/unknown session_id before we run any code.
if (owner && store && sessionId && (await store.getSession(owner, sessionId)) === null) {
  throw new HttpError(404, "session_id not found");
}

async function persist(newRun: NewRun): Promise<{ sessionId: string; runId: string } | undefined> {
  if (!owner || !store) return undefined; // anonymous or history off → skip (contract, INV-6)
  try {
    const { session, run } = await store.appendRun(owner, sessionId, newRun);
    return { sessionId: session.id, runId: run.id };
  } catch (err) {
    if (err instanceof SessionNotFound) throw new HttpError(404, "session_id not found"); // race safety net
    console.error("history persist failed (continuing):", err); // best-effort: never break execute
    return undefined;
  }
}
```

  Then for the message path: `const p = await persist({ kind: "message", prompt, message });
  res.json(messageResponse(message, p && { sessionId: p.sessionId, runId: p.runId }));` — and
  analogously for the result path with `{ kind: "result", prompt, language, code, ...result }`.
  The `SessionNotFound` → 404 inside `persist` is a race safety net (the pre-check normally
  catches it); every other persist error is swallowed so a DB hiccup never breaks execution
  (decision (e)).

- [ ] **Step 4: Production store construction is already owned by H1.** H2 only *reads*
  `getHistory()`; the lazy `PostgresHistoryStore` build lives in the H0/H1 seam (H1 Step 9b).
  Nothing to wire here — just confirm `getHistory()` is in scope in the handler.

- [ ] **Step 5: Run tests — pass.** `npx vitest run tests/history/execute.persist.test.ts` → PASS.
  Then `SKIP_DOCKER=1 ./verify.sh` green.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/schemas.ts backend/src/server.ts backend/tests/history/execute.persist.test.ts
git commit -m "feat(history): persist each execute into the caller's session (best-effort, owner-scoped)"
```

---

## Issue H3 — History REST router (sessions CRUD + search + run delete)

**Depends on:** H0. **Parallel with:** H1, H2, H4. Self-contained router module; mounted in
`server.ts` with a single line to avoid conflicts with H2.

**Files:**
- Create: `backend/src/history/router.ts`, `backend/tests/history/router.test.ts`
- Modify: `backend/src/server.ts` (one `app.use(...)` line)

Endpoints (all require an authenticated principal via a `requireIdentity` guard that 404s
when `userId` is null — open question (c)):

| Method & path | Behavior | Not-owned/absent |
|---|---|---|
| `GET /api/sessions?q=&limit=&offset=` | list owner's sessions (+`run_count`), search | — |
| `GET /api/sessions/:id` | session + runs | 404 |
| `PATCH /api/sessions/:id` `{title}` | rename | 404 |
| `DELETE /api/sessions/:id` | delete (runs cascade) | 404 |
| `DELETE /api/sessions` | clear all → `{deleted: n}` | — |
| `DELETE /api/runs/:id` | delete one run | 404 |

- [ ] **Step 1: Write failing router tests.** `router.test.ts` builds an app with a
  `MemoryHistoryStore` seeded for two users and asserts, via Supertest: list returns only the
  caller's sessions; `GET`/`PATCH`/`DELETE` of another user's session id all return **404**;
  search filters; `DELETE /api/sessions` clears only the caller's; `DELETE /api/runs/:id` is
  owner-scoped; and every route returns **404** under an anonymous principal.
  Run: `npx vitest run tests/history/router.test.ts` → FAIL.

- [ ] **Step 2: Implement the router.** Create `backend/src/history/router.ts`:

```ts
import { Router, type RequestHandler } from "express";
import type { HistoryStore } from "./store.js";
import type { Owner } from "./types.js";
import { CreateSessionRequest, RenameSessionRequest, ListQuery, sessionWire, sessionWithRunsWire } from "./dto.js";
import { HttpError } from "../errors.js";
import type { ZodType } from "zod";

/** Validate with Zod and map failures to 422 — mirrors the safeParse+HttpError idiom the
 *  /api/execute handler already uses (server.ts). Avoids touching the shared error handler. */
function parseOr422<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(422, r.error.issues[0]?.message ?? "Invalid request body");
  return r.data;
}

/** History is identity-scoped: no verified userId ⇒ the feature does not exist here (404). */
const requireIdentity: RequestHandler = (_req, res, next) => {
  const p = res.locals.principal as { userId: string | null } | undefined;
  if (!p?.userId) {
    next(new HttpError(404, "Not found"));
    return;
  }
  next();
};

const ownerOf = (res: { locals: { principal: { userId: string; tenantId: string | null } } }): Owner => ({
  userId: res.locals.principal.userId,
  tenantId: res.locals.principal.tenantId,
});

export function historyRouter(store: HistoryStore): Router {
  const r = Router();
  r.use(requireIdentity);

  r.get("/sessions", async (req, res, next) => {
    try {
      const q = parseOr422(ListQuery, req.query);
      const page = await store.listSessions(ownerOf(res), q);
      res.json({ sessions: page.sessions.map(sessionWire), total: page.total });
    } catch (e) {
      next(e);
    }
  });

  r.delete("/sessions", async (_req, res, next) => {
    try {
      res.json({ deleted: await store.clearAll(ownerOf(res)) });
    } catch (e) {
      next(e);
    }
  });

  r.get("/sessions/:id", async (req, res, next) => {
    try {
      const s = await store.getSession(ownerOf(res), req.params.id);
      if (!s) throw new HttpError(404, "Session not found");
      res.json(sessionWithRunsWire(s));
    } catch (e) {
      next(e);
    }
  });

  r.patch("/sessions/:id", async (req, res, next) => {
    try {
      const { title } = parseOr422(RenameSessionRequest, req.body);
      const s = await store.renameSession(ownerOf(res), req.params.id, title);
      if (!s) throw new HttpError(404, "Session not found");
      res.json(sessionWire(s));
    } catch (e) {
      next(e);
    }
  });

  r.delete("/sessions/:id", async (req, res, next) => {
    try {
      if (!(await store.deleteSession(ownerOf(res), req.params.id)))
        throw new HttpError(404, "Session not found");
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  r.delete("/runs/:id", async (req, res, next) => {
    try {
      if (!(await store.deleteRun(ownerOf(res), req.params.id)))
        throw new HttpError(404, "Run not found");
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return r;
}
// Note: CreateSessionRequest is used by the optional POST /api/sessions (explicit new chat).
// Include it if the UI needs to create an empty session before the first run; otherwise
// sessions are created implicitly by appendRun and this import can be dropped.
```

- [ ] **Step 3: Mount it (ordering matters).** In `server.ts`, mount the router **after** the
  `/api/health`, `/api/config`, and `/api/execute` routes (those terminate their own chains,
  so there is no double-auth on `/api/execute`), and only when a store exists:

```ts
const store = getHistory();
if (store) app.use("/api", requirePrincipal, historyRouter(store));
```

  `requirePrincipal` populates `res.locals.principal` (guaranteeing it for `/api/sessions*`
  and `/api/runs/:id`), then the router's `requireIdentity` 404s when `userId` is null
  (anonymous mode, INV-6). **No error-handler change is needed** — the router validates with
  `parseOr422` (safeParse → `HttpError(422)`), matching the existing `/api/execute` idiom.
  Do **not** insert this `app.use` above the health route.

- [ ] **Step 4: Run tests — pass.** `npx vitest run tests/history/router.test.ts` → PASS;
  `SKIP_DOCKER=1 ./verify.sh` green.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/history/router.ts backend/tests/history/router.test.ts backend/src/server.ts
git commit -m "feat(history): sessions REST router (list/get/rename/delete/clear + run delete), owner-scoped"
```

---

## Issue H4 — Frontend history UI

**Depends on:** H0 (the wire contract). **Parallel with:** H1–H3; integrates against live
endpoints once H2/H3 land (develop against a mock or the running backend).

**Files:**
- Create: `frontend/src/history.ts` (client types + fetch helpers),
  `frontend/src/components/HistorySidebar.tsx`, `frontend/src/components/SessionView.tsx`,
  and matching `*.test.tsx` / `*.test.ts`
- Modify: `frontend/src/api.ts` (session methods; `execute(prompt, token, sessionId?)` returns
  `session_id`/`run_id`), `frontend/src/App.tsx` (compose sidebar + session view + selection
  state)

- [ ] **Step 1: Client types + helpers (TDD).** In `frontend/src/history.ts` define
  `SessionSummary` (`{id,title,created_at,updated_at,run_count?}` — `run_count` is present in
  the **list** wire but omitted by the **detail** wire, so it is optional), `RunView` (the run
  wire union = existing `MessageResponse`/`ResultResponse` + `{id,session_id,created_at,prompt}`),
  and `SessionDetail` (`SessionSummary & {runs: RunView[]}`; the detail view derives its count
  from `runs.length`, not `run_count`). Add fetch helpers
  `listSessions(token,q?)`, `getSession(token,id)`, `renameSession`, `deleteSession`,
  `clearHistory`, `deleteRun` — each attaching the bearer token and reading `{detail}` on
  error (mirror `api.ts`). Write `history.test.ts` first (mock `fetch`), then implement.

- [ ] **Step 2: `api.ts` execute + config change (TDD).** Extend `execute` to accept an
  optional `sessionId` and include it in the body; broaden `ResultResponse`/`MessageResponse`
  with optional `session_id`/`run_id`. Extend `fetchAuthConfig` to also read the additive
  `history_enabled` field (`AuthConfig` gains `historyEnabled: boolean`, defaulting to
  `false`). Update `api.test.ts` to assert the body carries `session_id` when provided, that
  the new response fields parse, and that `history_enabled` is read. Implement.

- [ ] **Step 3: `HistorySidebar` (TDD).** Component: search box (debounced → `listSessions`),
  "New chat" button, a list of sessions (title + relative time), and per-item rename/delete
  plus a "Clear all" action with a confirm. Props: `sessions`, `selectedId`,
  `onSelect/onNew/onRename/onDelete/onClear/onSearch`. `HistorySidebar.test.tsx`: renders
  sessions, calls `onSelect` on click, `onDelete` after confirm, `onSearch` on typing.

- [ ] **Step 4: `SessionView` (TDD).** Renders the selected session's runs (reuse the existing
  code/stdout/stderr rendering from `App.tsx`, extracted into a `RunResult` piece so live and
  historical runs share one renderer) followed by the prompt form. On submit, calls
  `execute(prompt, token, selectedId)` and appends the returned run; if the response carries a
  new `session_id`, notify the parent to refresh the sidebar and select it.
  `SessionView.test.tsx`: submitting posts with the current session id and renders the new run.

- [ ] **Step 5: `App.tsx` composition.** Hold `sessions`, `selectedId`, `detail` state; load
  sessions after login; wire the sidebar and session view; "New chat" clears selection so the
  next run creates a session. **Render the sidebar only when `historyEnabled && isAuthenticated`**
  (from the extended `fetchAuthConfig`); otherwise behave exactly as today — no history, no
  sidebar (covers anonymous/`AUTH_REQUIRED=false` and history-disabled backends). Update
  `App.test.tsx` for both the authed-with-history layout and the history-disabled fallback.

- [ ] **Step 6: Verify + commit.** `cd frontend && SKIP_DOCKER=1 ./verify.sh` green.

```bash
git add frontend/src/history.ts frontend/src/components frontend/src/api.ts frontend/src/App.tsx frontend/src/**/*.test.*
git commit -m "feat(history): sessions sidebar, session view, search/rename/delete/clear UI"
```

---

## Issue H5 — Isolation & security battery (the "no one else can see it" proof)

**Depends on:** H1 + H2 + H3. Mirrors the repo's auth-bypass + mutation-test culture
(`tests/mutants.ts`, `tests/authMutation.test.ts`). This issue is where isolation is
*proven*, not just implemented.

**Files:**
- Create: `backend/tests/history/isolation.test.ts`,
  `backend/tests/history/historyMutants.ts` (planted-hole verifiers)
- Modify: README security section pointer (in H6)

**Acceptance criteria — every invariant from the *Isolation invariants (security spec)*
section must be green against BOTH stores (memory always; Postgres when `DATABASE_URL` is
set). This is the epic's close-gate.**

- [ ] INV-1 list/search never leaks another user's data — Step 1
- [ ] INV-2 cross-user `GET`/`PATCH`/`DELETE` session → 404 — Step 1
- [ ] INV-3 cross-user `DELETE` run → 404 — Step 1
- [ ] INV-4 execute with an unowned `session_id` → 404, victim session unchanged — Step 1
- [ ] INV-5 clear-all deletes only the caller's data — Step 1
- [ ] INV-6 anonymous mode: history routes 404, execute persists nothing — Step 2
- [ ] INV-7 planted-hole (dropped `user_id` filter) makes the battery fail — Step 3
- [ ] INV-8 enumeration: real foreign id and random id give identical 404s — Step 4

- [ ] **Step 1: Cross-user matrix (Supertest, real router + persist).** For every verb
  (`GET/PATCH/DELETE /api/sessions/:id`, `DELETE /api/runs/:id`, `GET /api/sessions/:id` after
  the other user created it, and `POST /api/execute` with `session_id` belonging to the other
  user): user B always gets **404** and user A's data is provably unchanged afterward.
  Parameterize the app over both stores (memory always; Postgres when `DATABASE_URL` set) so
  the same matrix runs in unit and integration.

- [ ] **Step 2: Anonymous-mode refusal.** With `AUTH_REQUIRED=false` (principal `userId:null`),
  assert **every** `/api/sessions*` and `/api/runs/:id` route returns 404, and `/api/execute`
  works but persists nothing and omits `session_id`/`run_id`.

- [ ] **Step 3: Planted-hole regression (mutation-style).** In `historyMutants.ts` implement
  deliberately-broken predicates — e.g. an `appendRun`/`getSession` that drops the
  `user_id` filter, a `deleteRun` that ignores the owner — and assert the isolation matrix
  **fails** against each hole. This proves the battery would catch a future regression that
  weakens the WHERE clause (same technique as `authMutation.test.ts`).

- [ ] **Step 4: `pg` enumeration guard.** Assert `getSession(B, <A's real id>)` and a random
  UUID both return exactly 404 with an identical body — no timing/shape difference that leaks
  existence.

- [ ] **Step 5: Verify + commit.** Run unit + (with DB) integration; both green.

```bash
git add backend/tests/history/isolation.test.ts backend/tests/history/historyMutants.ts
git commit -m "test(history): adversarial cross-user isolation matrix + planted-hole regression"
```

---

## Issue H6 — Docs: README, security posture, roadmap

**Depends on:** H1–H5 landing. Per CLAUDE.md, README is updated in the same body of work
when documented surfaces change (datastore, security posture, setup, roadmap).

- [ ] **Step 1: Layout + setup.** Add the `postgres` service to the Compose description and
  the `DATABASE_URL` env to the setup + `.env.example` walkthrough; note that empty
  `DATABASE_URL` disables persistence and that history requires auth.
- [ ] **Step 2: Security posture.** Document the isolation model (owner-scoped queries keyed
  on the verified `sub`, cross-owner → 404, denormalized `runs.user_id` defense-in-depth,
  identity-scoped routes 404 when anonymous) and point at the H5 battery, alongside the
  existing auth-bypass retrospective.
- [ ] **Step 3: Roadmap/known-limitations.** Tick "session persistence" from the roadmap;
  add the deferred follow-ups: retention window / per-user row cap, full-text search
  (pg_trgm/tsvector), and per-user quotas keyed on `sub` (ties to the existing quota item).
- [ ] **Step 4: Verify prose against reality, commit.**

```bash
git add README.md
git commit -m "docs: per-user chat history — datastore, isolation posture, roadmap"
```

---

## Epic (spine) issue body — to create on GitHub after approval

> **Title:** `Epic: per-user chat history (grouped sessions, Postgres, isolated)`
>
> Tracking issue for per-user chat history. **Decisions are locked** (below); the linked
> issues are the work items. Fan-out: H0 lands first, then H1–H4 in parallel, then H5/H6.
>
> **Locked decisions:** Postgres behind a `HistoryStore` interface · grouped sessions ⇒ runs ·
> controls: list/reopen/search/rename/delete-one/clear-all · isolation keyed on verified `sub`
> (cross-owner → 404; `runs.user_id` denormalized) · history is an authenticated feature
> (anonymous mode persists nothing, routes 404).
>
> **Sequence**
> - [ ] H0 — Foundation: `HistoryStore` interface, domain types, Zod DTOs, in-memory double + contract suite
> - [ ] H1 — Postgres store, migration runner, Compose + CI Postgres service *(parallel)*
> - [ ] H2 — Persist each execute into the caller's session *(parallel)*
> - [ ] H3 — History REST router (sessions CRUD + search + run delete) *(parallel)*
> - [ ] H4 — Frontend history UI (sidebar, session view, search/rename/delete/clear) *(parallel)*
> - [ ] H5 — Adversarial cross-user isolation battery + planted-hole regression
> - [ ] H6 — Docs: README datastore/security-posture/roadmap
>
> **Decisions (accepted, see plan):** (a) `pg` + raw SQL · (b) integration tests via a CI
> Postgres service, `DATABASE_URL`-gated · (c) anonymous history routes → 404 · (d) search via
> ILIKE for v1 · (e) best-effort persistence on execute · (f) no retention in v1.
>
> **Close-gate:** this epic cannot be checked off until the *Isolation invariants* spec
> (INV-1…INV-8) is green against both the in-memory store and Postgres (proven by H5).

---

## Self-review notes (author)

- **Requirement coverage:** per-user save (H2) · isolation/no-cross-user (H0 contract + H3
  routes + H5 proof) · grouped sessions (data model + H0/H1) · list+reopen (H3 GET, H4) ·
  search (H0 ILIKE contract, H1 SQL, H3 `q`, H4 search box) · delete one (H3 `DELETE /runs`) ·
  clear all (H3 `DELETE /sessions`) · Postgres (H1) · spine+fan-out (issue map). ✔
- **Type consistency:** `Owner`/`Session`/`Run`/`NewRun` defined once in H0 `types.ts` and
  imported everywhere; wire builders (`sessionWire`/`runWire`) defined once in H0 `dto.ts` and
  reused by H3; `HistoryStore` method names identical across `store.ts`, `memoryStore.ts`,
  `pgStore.ts`, and `contractTests.ts`. `SessionNotFound` → 404 mapping appears in both H2 and
  H3 consistently. ✔
- **Backward compatibility:** `/api/execute` additions are optional and gated on an
  authenticated principal + a configured store, so anonymous/no-DB behavior is byte-identical
  to today. ✔
- **Placeholder scan:** the two intentionally-deferred details (row-mapper helpers at the
  bottom of `pgStore.ts`; optional `POST /api/sessions`) are described with their exact
  behavior, not left as "TBD". The previously-dangling `cli-migrate.ts` is now created in
  H1 Step 8a. ✔

- **Staff-engineer review incorporated (2026-08-03):** (1) the shared `createApp` store seam
  is owned by **H0** (`AppDeps.history` + `getHistory()` + additive `/api/config`
  `history_enabled`), so H1–H4 stay genuinely parallel with no symbol-ownership collision;
  (2) the history router validates via `parseOr422` (safeParse → `HttpError(422)`), so **no**
  shared error-handler change is needed and malformed queries return 422, not 500; (3)
  `cli-migrate.ts` is a first-class H1 artifact. Advisory items folded in: `fakePrincipal`
  test seam (H0), `import { describe }` in the pg suite, an owner-scoped pre-check before the
  sandbox runs on a supplied `session_id` (H2), `run_count` reconciled as optional/derived
  (H4), and the explicit H3 mount-ordering constraint. The reviewer independently confirmed
  the isolation design holds; those guarantees are now specified as INV-1…INV-8. ✔
```
