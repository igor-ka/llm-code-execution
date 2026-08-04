import type { Pool, PoolClient } from "pg";
import type { HistoryStore } from "./store.js";
import { SessionNotFound, titleFromPrompt } from "./store.js";
import type { Owner, Session, Run, NewRun, SessionPage, ListOptions } from "./types.js";

/**
 * Postgres-backed HistoryStore. The isolation contract is structural: EVERY statement
 * carries the owner's user_id in its WHERE / VALUES, so no query can return or mutate a
 * row a different user owns. Cross-owner reads return null (→ 404 upstream); cross-owner
 * writes throw SessionNotFound. Raw parameterized SQL (no ORM), matching the repo's
 * hand-rolled dockerode/jose style.
 */
export class PostgresHistoryStore implements HistoryStore {
  constructor(private pool: Pool) {}

  async listSessions(owner: Owner, opts: ListOptions): Promise<SessionPage> {
    // Literal-substring search: escape the LIKE metacharacters (%, _, and the escape char
    // itself) in the user's query so ILIKE matches the in-memory oracle's `includes()`
    // semantics — a `%` typed by the user is a literal `%`, not a wildcard.
    const like = opts.q ? `%${escapeLike(opts.q)}%` : null;
    // Owner-scoped; optional ILIKE over the title OR any run prompt in the session.
    const where = like
      ? `s.user_id = $1 AND (s.title ILIKE $2 ESCAPE '\\' OR EXISTS
           (SELECT 1 FROM runs r WHERE r.session_id = s.id AND r.prompt ILIKE $2 ESCAPE '\\'))`
      : `s.user_id = $1`;
    const params: unknown[] = like ? [owner.userId, like] : [owner.userId];
    const totalRes = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions s WHERE ${where}`,
      params,
    );
    const rows = await this.pool.query<SessionCountRow>(
      `SELECT s.*, (SELECT count(*)::int FROM runs r WHERE r.session_id = s.id) AS run_count
         FROM sessions s WHERE ${where}
         ORDER BY s.updated_at DESC, s.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, opts.offset],
    );
    return { total: totalRes.rows[0].n, sessions: rows.rows.map(rowToSessionWithCount) };
  }

  async getSession(owner: Owner, id: string): Promise<(Session & { runs: Run[] }) | null> {
    const s = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions WHERE id = $1 AND user_id = $2`,
      [id, owner.userId],
    );
    if (!s.rowCount) return null; // not owned OR absent → indistinguishable to the caller
    const runs = await this.pool.query<RunRow>(
      `SELECT * FROM runs WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [id],
    );
    return { ...rowToSession(s.rows[0]), runs: runs.rows.map(rowToRun) };
  }

  async renameSession(owner: Owner, id: string, title: string): Promise<Session | null> {
    const res = await this.pool.query<SessionRow>(
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

  async appendRun(
    owner: Owner,
    sessionId: string | null,
    run: NewRun,
  ): Promise<{ session: Session; run: Run }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await resolveSession(client, owner, sessionId, run.prompt);
      const inserted = await client.query<RunRow>(
        `INSERT INTO runs (session_id, user_id, prompt, kind, message, language, code, stdout, stderr, exit_code, duration_ms, timed_out)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        runInsertParams(session.id, owner.userId, run),
      );
      // Bump recency so the session sorts to the front of the owner's list.
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

/** Resolve the target session inside the append transaction: create when sessionId is null,
 *  else load it owner-scoped (throws SessionNotFound if not owned / absent). */
async function resolveSession(
  client: PoolClient,
  owner: Owner,
  sessionId: string | null,
  prompt: string,
): Promise<Session> {
  if (sessionId === null) {
    const res = await client.query<SessionRow>(
      `INSERT INTO sessions (user_id, tenant_id, title) VALUES ($1,$2,$3) RETURNING *`,
      [owner.userId, owner.tenantId, titleFromPrompt(prompt)],
    );
    return rowToSession(res.rows[0]);
  }
  const res = await client.query<SessionRow>(
    `SELECT * FROM sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, owner.userId],
  );
  if (!res.rowCount) throw new SessionNotFound(sessionId);
  return rowToSession(res.rows[0]);
}

/** Escape LIKE/ILIKE wildcards so user input is matched as a literal substring. Escapes the
 *  backslash first (it is the ESCAPE char), then `%` and `_`. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// --- Row shapes + mappers (snake_case columns → camelCase domain types) ---

interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface SessionCountRow extends SessionRow {
  run_count: number;
}

interface RunRow {
  id: string;
  session_id: string;
  user_id: string;
  created_at: Date;
  prompt: string;
  kind: "message" | "result";
  message: string | null;
  language: string | null;
  code: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  timed_out: boolean | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSessionWithCount(row: SessionCountRow): Session & { runCount: number } {
  return { ...rowToSession(row), runCount: row.run_count };
}

function rowToRun(row: RunRow): Run {
  const base = {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    createdAt: row.created_at,
    prompt: row.prompt,
  };
  if (row.kind === "message") {
    return { ...base, kind: "message", message: row.message ?? "" };
  }
  return {
    ...base,
    kind: "result",
    language: row.language ?? "",
    code: row.code ?? "",
    stdout: row.stdout ?? "",
    stderr: row.stderr ?? "",
    exitCode: row.exit_code ?? 0,
    durationMs: row.duration_ms ?? 0,
    timedOut: row.timed_out ?? false,
  };
}

/** Expand a NewRun into the 12 positional params of the runs INSERT — nulls for the columns
 *  the other branch of the union does not carry. */
function runInsertParams(sessionId: string, userId: string, run: NewRun): unknown[] {
  if (run.kind === "message") {
    return [
      sessionId,
      userId,
      run.prompt,
      "message",
      run.message,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
  }
  return [
    sessionId,
    userId,
    run.prompt,
    "result",
    null,
    run.language,
    run.code,
    run.stdout,
    run.stderr,
    run.exitCode,
    run.durationMs,
    run.timedOut,
  ];
}
