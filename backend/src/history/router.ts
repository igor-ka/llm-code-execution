import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { HistoryStore } from "./store.js";
import type { Owner } from "./types.js";
import { RenameSessionRequest, ListQuery, sessionWire, sessionWithRunsWire } from "./dto.js";
import { HttpError } from "../errors.js";

/** Validate with Zod and map failures to 422 — mirrors the safeParse+HttpError idiom the
 *  /api/execute handler already uses (server.ts). Avoids touching the shared error handler,
 *  which does not translate Zod errors. Returns the schema's OUTPUT type (post-coerce/default). */
function parseOr422<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(422, r.error.issues[0]?.message ?? "Invalid request body");
  return r.data;
}

/** History is identity-scoped: no verified userId ⇒ the feature does not exist here (404).
 *  Returning the same 404 as a missing resource keeps anonymous mode indistinguishable from
 *  "no such route" (INV-6). */
const requireIdentity: RequestHandler = (_req, res, next) => {
  const p = res.locals.principal as { userId: string | null } | undefined;
  if (!p?.userId) {
    next(new HttpError(404, "Not found"));
    return;
  }
  next();
};

/** Read the owner from the verified principal. Safe because `requireIdentity` has already
 *  rejected any request whose principal.userId is null. */
const ownerOf = (res: Response): Owner => {
  const p = res.locals.principal as { userId: string; tenantId: string | null };
  return { userId: p.userId, tenantId: p.tenantId };
};

/** Owner-scoped sessions CRUD + search + single-run delete. Every route filters on the
 *  verified principal; a cross-owner or absent id is always a 404 (never distinguished). */
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
