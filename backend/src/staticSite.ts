/**
 * Serve the built SPA from the API process.
 *
 * Spec D9: one Cloud Run service, one origin. That deletes a class of bug this repo has already
 * hit once — ADR-0003 D7 records that `Retry-After` was invisible to the browser because it is
 * not CORS-safelisted — and it means the API and the app can never disagree about their origin.
 *
 * The CSP is read from the file the frontend build emits rather than rebuilt here: buildCsp()
 * lives in the frontend package and duplicating it would let the two drift. A missing policy is
 * fatal, not a warning — serving the SPA without its CSP is running with a security control
 * silently absent, which is the same failure mode ADR-0003 D6 refuses for REDIS_URL.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * The request path, collapsed so guards below cannot be walked around.
 *
 * `//csp.txt` and `//api/whatever` do not match a naive `=== "/csp.txt"` or
 * `startsWith("/api/")`, but `express.static` and `res.sendFile` normalize internally and serve
 * them anyway — so the raw policy leaks and unmatched API paths answer with the SPA. Lowercased
 * because a case-insensitive filesystem serves `/CSP.txt` from the same file.
 */
function guardPath(path: string): string {
  return posix.normalize(path).toLowerCase();
}

/** Read the policy the build emitted. Throws if it is missing or obviously not a prod policy. */
export function readCspPolicy(publicDir: string): string {
  const file = join(publicDir, "csp.txt");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `cannot read ${file} — the SPA build must emit csp.txt (see frontend/vite.config.ts). ` +
        `Refusing to serve the app without its Content-Security-Policy.`,
    );
  }
  const policy = raw.trim();
  // Not `includes("script-src 'self'")`: the DEV policy is `script-src 'self' 'unsafe-inline'
  // 'unsafe-eval'`, which contains that substring. A dev policy passing this guard is exactly
  // the regression it exists to prevent — the SPA served with eval enabled, looking fine.
  const scriptSrc = /(?:^|;)\s*script-src\s+([^;]+)/.exec(policy)?.[1]?.trim();
  if (scriptSrc !== "'self'") {
    throw new Error(
      `${file} has script-src ${JSON.stringify(scriptSrc ?? null)}, expected exactly "'self'" — ` +
        `refusing to serve the app under a non-production policy`,
    );
  }
  return policy;
}

/**
 * Set the policy on EVERY response. Mount this BEFORE the API routes.
 *
 * Ordering is the whole point: mounted after them, a route that answers — or throws to the error
 * handler — terminates before this ever runs, so every API response including error bodies would
 * ship without a policy. A JSON 500 is a weaker target than a document, but "the header is on
 * whichever responses happened to fall through" is not a posture anyone can reason about.
 */
export function installCspHeader(app: Express, policy: string): void {
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", policy);
    next();
  });
}

/**
 * Mount static serving + the SPA history fallback. Call this AFTER the API routes and BEFORE the
 * error handler: the fallback answers anything unmatched, so anything mounted later is dead.
 */
export function mountSpaFallback(app: Express, publicDir: string): void {
  // index:false — the fallback below owns "/", so directory indexing would answer it twice.
  const serveAssets = express.static(publicDir, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // csp.txt is server configuration, not a public asset. Skipping it here lets the request
    // fall through to the SPA fallback rather than handing the policy to anyone who asks.
    if (guardPath(req.path) === "/csp.txt") return next();
    return serveAssets(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    // Only GET/HEAD reach the SPA; anything else unmatched is a genuine 404/405.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const path = guardPath(req.path);
    // An unmatched /api path is an API 404, never the SPA. Returning index.html there would turn
    // every client typo into a 200 with HTML, which breaks fetch callers in the most confusing
    // way available. Note the bare "/api" is checked too — startsWith("/api/") alone would let
    // exactly that one path through.
    if (path === "/api" || path.startsWith("/api/")) return next();
    // A request for a FILE that does not exist is a 404, not the SPA. Otherwise a client holding
    // a stale index.html asks for a purged /assets/index-abc123.js and receives HTML with a 200,
    // failing later as an opaque module-parse error instead of an honest missing-asset 404.
    if (posix.basename(path).includes(".")) return next();
    // `root` + a relative name, NOT an absolute path. Handed an absolute path, `send` applies
    // its dotfile guard to EVERY segment of it — including ones no request ever touched — so an
    // app served from under any hidden directory (a git worktree in `.claude/worktrees/`, a
    // deploy under `/opt/.local/app`) 404s every deep link. Scoping to `root` confines that
    // guard to the part the request actually controls, which is the only part it was for.
    res.sendFile("index.html", { root: publicDir });
  });
}
