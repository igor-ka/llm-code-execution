/**
 * Express app factory wiring the prompt -> judge -> generate -> sandbox -> result flow
 * (port of main.py). requirePrincipal enforces auth before the /api/execute body runs;
 * llm and sandbox are lazily constructed so /api/health boots without ANTHROPIC_API_KEY
 * or Docker configured.
 */
import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import { getSettings, type Settings } from "./config.js";
import { makeRequirePrincipal, type Principal } from "./auth.js";
import { LLMService } from "./llm.js";
import { DockerBackend } from "./sandbox/dockerBackend.js";
import type { SandboxBackend, ExecutionLimits } from "./sandbox/base.js";
import { ExecuteRequest, messageResponse, resultResponse } from "./schemas.js";
import { HttpError } from "./errors.js";
import { SessionNotFound, type HistoryStore } from "./history/store.js";
import { PostgresHistoryStore } from "./history/pgStore.js";
import { makePool } from "./history/pool.js";
import type { NewRun } from "./history/types.js";

export interface AppDeps {
  settings?: Settings;
  llm?: LLMService;
  sandbox?: SandboxBackend;
  history?: HistoryStore; // per-user chat history store (H0 seam; H1 builds the real one)
  requirePrincipal?: RequestHandler; // test seam
}

function limitsFrom(s: Settings): ExecutionLimits {
  return {
    timeoutSeconds: s.sandboxTimeoutSeconds,
    memoryMb: s.sandboxMemoryMb,
    cpus: s.sandboxCpus,
    pidsLimit: s.sandboxPidsLimit,
    maxOutputChars: s.sandboxMaxOutputChars,
  };
}

export function createApp(deps: AppDeps = {}): Express {
  const settings = deps.settings ?? getSettings();
  const app = express();
  app.use(cors({ origin: settings.frontendOrigin }));
  app.use(express.json());

  const requirePrincipal = deps.requirePrincipal ?? makeRequirePrincipal(settings);

  // Lazily-constructed singletons so the app can boot (and serve /api/health) before
  // ANTHROPIC_API_KEY / Docker are configured.
  let llm = deps.llm;
  const getLlm = (): LLMService => {
    if (!llm) {
      if (!settings.anthropicApiKey) {
        throw new HttpError(503, "ANTHROPIC_API_KEY is not configured");
      }
      llm = new LLMService(settings.anthropicApiKey, settings.llmModel);
    }
    return llm;
  };
  let sandbox = deps.sandbox;
  const getSandbox = (): SandboxBackend => {
    if (!sandbox) sandbox = new DockerBackend(settings.sandboxImage);
    return sandbox;
  };
  // History store seam. Tests inject deps.history and win outright. In production, when
  // history is enabled (auth on + DATABASE_URL set), lazily construct a single cached
  // PostgresHistoryStore over one pool. H2 (persist) and H3 (router mount) only read
  // getHistory(); this is the sole place the production store is built.
  let history = deps.history;
  const getHistory = (): HistoryStore | undefined => {
    if (history) return history;
    if (settings.historyEnabled) history = new PostgresHistoryStore(makePool(settings.databaseUrl));
    return history;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Public, unauthenticated: lets the SPA mirror the server's auth requirement so the
  // two can't disagree. The backend remains the single source of truth. `history_enabled`
  // is additive — old clients ignore it; the SPA uses it to show/hide the history UI.
  app.get("/api/config", (_req, res) => {
    res.json({ auth_required: settings.authRequired, history_enabled: getHistory() !== undefined });
  });

  app.post("/api/execute", requirePrincipal, async (req, res, next) => {
    try {
      const parsed = ExecuteRequest.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid request body");
      }
      const { prompt } = parsed.data;

      // Identity is server-derived (auth.ts), never from the body. History persists only for
      // an authenticated owner AND only when a store is present (H1 supplies it in prod).
      // Anonymous (userId null) or history-off leaves the response byte-identical (INV-6).
      const principal = res.locals.principal as Principal;
      const owner = principal.userId
        ? { userId: principal.userId, tenantId: principal.tenantId }
        : null;
      const store = getHistory();
      const sessionId = parsed.data.session_id ?? null;

      // Fast owner-scoped pre-check: reject an unowned/unknown session_id before running any
      // code. appendRun re-checks ownership regardless (INV-4); this is a cheap 404 that also
      // avoids burning a sandbox run on a request that can never persist.
      if (owner && store && sessionId && (await store.getSession(owner, sessionId)) === null) {
        throw new HttpError(404, "session_id not found");
      }

      // Persist a run best-effort (decision (e)): anonymous/history-off → skip; SessionNotFound
      // → 404 (race safety net for the pre-check); every other write error is logged and
      // swallowed so a datastore hiccup never breaks code execution.
      const persist = async (
        newRun: NewRun,
      ): Promise<{ sessionId: string; runId: string } | undefined> => {
        if (!owner || !store) return undefined;
        try {
          const { session, run } = await store.appendRun(owner, sessionId, newRun);
          return { sessionId: session.id, runId: run.id };
        } catch (err) {
          if (err instanceof SessionNotFound) throw new HttpError(404, "session_id not found");
          console.error("history persist failed (continuing):", err);
          return undefined;
        }
      };

      let generation;
      try {
        generation = await getLlm().generate(prompt);
      } catch (err) {
        if (err instanceof HttpError) throw err; // 503 passes through
        const msg = err instanceof Error ? err.message : String(err);
        throw new HttpError(502, `Code generation failed: ${msg}`);
      }

      if (!generation.shouldExecute) {
        const message =
          generation.message ??
          "This request doesn't look like something I should write and run code for.";
        const persisted = await persist({ kind: "message", prompt, message });
        res.json(messageResponse(message, persisted));
        return;
      }

      if (!generation.code || !generation.language) {
        throw new HttpError(502, "Model chose to execute but returned no code");
      }

      const result = await getSandbox().execute(
        generation.code,
        generation.language,
        limitsFrom(settings),
      );
      const persisted = await persist({
        kind: "result",
        prompt,
        language: generation.language,
        code: generation.code,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      });
      res.json(resultResponse(generation.language, generation.code, result, persisted));
    } catch (err) {
      next(err);
    }
  });

  // Final error handler — converts HttpError (and JSON parse errors) to {detail}.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ detail: err.detail });
        return;
      }
      if ((err as { type?: string })?.type === "entity.parse.failed") {
        res.status(422).json({ detail: "Invalid JSON body" });
        return;
      }
      console.error(err);
      res.status(500).json({ detail: "Internal server error" });
    },
  );

  return app;
}
