/**
 * OIDC bearer-token verification for protected endpoints (port of auth.py).
 *
 * SPA-direct bearer: the frontend sends `Authorization: Bearer <jwt>` and this
 * middleware verifies it against the provider's JWKS (RS256), then derives identity
 * from the claims. Secure by default: when authRequired is true, every request must
 * carry a valid, in-scope token; authRequired=false yields an anonymous principal.
 */
import type { RequestHandler, Request } from "express";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import type { Settings } from "./config.js";
import { HttpError } from "./errors.js";

export const REQUIRED_SCOPE = "execute:code";

export interface Principal {
  userId: string | null;
  tenantId: string | null;
}

// A key resolver is either a static key (tests) or a remote JWKS function (prod).
type KeyInput = JWTVerifyGetKey | KeyLike;

// One cached JWKS resolver per URL — mirrors the lru_cached PyJWKClient.
const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksFor(url: string): JWTVerifyGetKey {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

function bearerToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  const firstSpace = header.indexOf(" ");
  const scheme = firstSpace === -1 ? header : header.slice(0, firstSpace);
  const token = firstSpace === -1 ? "" : header.slice(firstSpace + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "Missing or malformed Authorization header");
  }
  return token;
}

function hasRequiredScope(claims: JWTPayload): boolean {
  const scope = claims.scope;
  if (typeof scope === "string" && scope.trim().split(/\s+/).includes(REQUIRED_SCOPE)) {
    return true;
  }
  const perms = (claims as { permissions?: unknown }).permissions;
  return Array.isArray(perms) && perms.includes(REQUIRED_SCOPE);
}

/**
 * Build the requirePrincipal middleware. `keyOverride` (a static public key) is used
 * by tests in place of the remote JWKS; production omits it and resolves via JWKS URL.
 */
export function makeRequirePrincipal(settings: Settings, keyOverride?: KeyInput): RequestHandler {
  return async (req, res, next) => {
    if (!settings.authRequired) {
      res.locals.principal = { userId: null, tenantId: null } satisfies Principal;
      next();
      return;
    }
    try {
      const token = bearerToken(req); // throws HttpError(401) if missing/malformed
      const key = keyOverride ?? jwksFor(settings.oidcJwksUrl);
      const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
        issuer: settings.oidcIssuer,
        audience: settings.oidcAudience,
        algorithms: ["RS256"],
        // `sub` is required, not optional: OIDC mandates it, and every downstream control is
        // keyed on it. Without it a verified token yields userId null, which would drop the
        // caller into the shared anonymous quota bucket — letting one such caller exhaust the
        // allowance of every other, and defeating per-user isolation.
        requiredClaims: ["exp", "iss", "aud", "sub"],
      });
      if (!hasRequiredScope(payload)) {
        next(new HttpError(403, `Token is missing the required scope '${REQUIRED_SCOPE}'`));
        return;
      }
      res.locals.principal = {
        userId: payload.sub ?? null,
        tenantId: (payload as { org_id?: string }).org_id ?? null,
      } satisfies Principal;
      next();
    } catch (err) {
      // A missing-header HttpError is already a 401; any jose failure maps to 401 too.
      if (err instanceof HttpError) {
        next(err);
        return;
      }
      next(new HttpError(401, "Invalid authentication token"));
    }
  };
}
