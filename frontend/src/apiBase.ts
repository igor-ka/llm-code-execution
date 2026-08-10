/**
 * Where the SPA talks to its API — defined ONCE, because two definitions silently disagree.
 *
 * The Content-Security-Policy's `connect-src` is generated from this same value at build time
 * (see vite.config.ts). If the policy and the code computed the origin differently, a build could
 * ship a bundle that calls one origin under a policy that permits another — and the failure is
 * invisible until the browser blocks every request at runtime, because the policy still *looks*
 * strict to any check.
 *
 * `??` and not `||`: an explicitly empty value means "same origin", which is what the production
 * image builds with (the API and the SPA are one Cloud Run service). Only an absent value falls
 * back to the local dev backend.
 */
export function resolveApiBase(raw: string | undefined): string {
  return raw ?? "http://localhost:8000";
}
