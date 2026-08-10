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
import { join } from "node:path";

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
  if (!policy.includes("script-src 'self'")) {
    throw new Error(`${file} does not contain a production script-src; refusing to serve`);
  }
  return policy;
}

/**
 * Mount static serving + the SPA history fallback. Call this AFTER the API routes and BEFORE the
 * error handler: the fallback answers anything unmatched, so anything mounted later is dead.
 */
export function mountStaticSite(app: Express, publicDir: string): void {
  const policy = readCspPolicy(publicDir);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", policy);
    next();
  });

  // index:false — the fallback below owns "/", so directory indexing would answer it twice.
  const serveAssets = express.static(publicDir, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // csp.txt is server configuration, not a public asset. Skipping it here lets the request
    // fall through to the SPA fallback rather than handing the policy to anyone who asks.
    if (req.path === "/csp.txt") return next();
    return serveAssets(req, res, next);
  });

  const indexHtml = join(publicDir, "index.html");
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Only GET/HEAD reach the SPA; anything else unmatched is a genuine 404/405.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // An unmatched /api path is an API 404, never the SPA. Returning index.html there would turn
    // every client typo into a 200 with HTML, which breaks fetch callers in the most confusing
    // way available. Note the bare "/api" is checked too — startsWith("/api/") alone would let
    // exactly that one path through.
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    res.sendFile(indexHtml);
  });
}
