/**
 * Per-user quota enforcement for /api/execute. Mounted AFTER requirePrincipal (so the
 * identity is the verified sub, never a header) and BEFORE llm.generate, which is what makes
 * a refusal cost zero Anthropic spend (S3).
 *
 * Note it also runs before the route's Zod validation, so a well-formed-JSON-but-invalid body
 * still consumes quota. That is deliberate — do not "fix" it by moving validation earlier.
 *
 * It does NOT cover malformed JSON: express.json() is mounted app-wide ahead of this, so a
 * syntactically broken body 422s before requirePrincipal or this middleware ever run. Those
 * requests are unmetered. They cost nothing downstream (no identity, no LLM, no sandbox), so
 * that is acceptable — but the invariant is narrower than "every rejected request is charged".
 */
import type { RequestHandler } from "express";
import type { Principal } from "../auth.js";
import { log } from "../log.js";
import type { QuotaStore, QuotaLimits } from "./quota.js";
import { quotaKey } from "./quota.js";
import { HttpError } from "../errors.js";

export function makeQuotaMiddleware(store: QuotaStore, limits: QuotaLimits): RequestHandler {
  return (_req, res, next) => {
    const principal = (res.locals.principal ?? { userId: null }) as Principal;
    void (async () => {
      let decision;
      try {
        decision = await store.consume(quotaKey(principal.userId), limits);
      } catch (err) {
        // FAIL OPEN (D5). The in-process sandbox concurrency cap still bounds the host, so an
        // outage degrades protection rather than removing it — the exposure narrows to
        // Anthropic spend for its duration. That is precisely why this logs at error level:
        // S9 treats silence here as a defect, because this line is the only thing standing
        // between a Redis outage and an unbounded bill.
        log.error("quota store unavailable — FAILING OPEN, requests are unmetered", { err });
        next();
        return;
      }
      if (decision.allowed) {
        next();
        return;
      }
      next(
        new HttpError(
          429,
          "Rate limit exceeded. Please wait before sending another request.",
          decision.retryAfterSeconds,
        ),
      );
    })();
  };
}
