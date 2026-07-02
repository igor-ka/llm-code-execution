/**
 * Deliberately-broken variants of the auth check — mutation-testing fixtures.
 * Each mutant mirrors the real verification but plants exactly one hole and returns an
 * HTTP status (200 accepted / 401 / 403) as a pure async function. authMutation.test.ts
 * asserts each hole is ACCEPTED by its mutant yet REJECTED by the real gate, proving the
 * regression battery has the sensitivity to catch that class of bug. Mirrors _mutants.py.
 *
 * Note (as in the Python original): an "HS256 allowed" mutant is not valid ground truth —
 * key-type confusion is refused by the library — so we plant jose-exploitable flaws.
 */
import { jwtVerify, type JWTPayload, type KeyLike } from "jose";

const REQUIRED_SCOPE = "execute:code";

function hasScope(claims: JWTPayload): boolean {
  const scope = claims.scope;
  if (typeof scope === "string" && scope.trim().split(/\s+/).includes(REQUIRED_SCOPE)) return true;
  const perms = (claims as { permissions?: unknown }).permissions;
  return Array.isArray(perms) && perms.includes(REQUIRED_SCOPE);
}

interface Ctx {
  publicKey: KeyLike;
  issuer: string;
  audience: string;
}

/** FLAW: token expiry is not verified (huge clock tolerance), so an expired token passes. */
export async function expiryNotChecked(token: string | null, ctx: Ctx): Promise<number> {
  if (!token) return 401;
  try {
    const { payload } = await jwtVerify(token, ctx.publicKey, {
      issuer: ctx.issuer,
      audience: ctx.audience,
      algorithms: ["RS256"],
      clockTolerance: 10 ** 12, // planted hole: expiry effectively ignored
    });
    return hasScope(payload) ? 200 : 403;
  } catch {
    return 401;
  }
}

/** FLAW: scope checked by substring, so 'execute:codex' satisfies 'execute:code'. */
export async function substringScope(token: string | null, ctx: Ctx): Promise<number> {
  if (!token) return 401;
  try {
    const { payload } = await jwtVerify(token, ctx.publicKey, {
      issuer: ctx.issuer,
      audience: ctx.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iss", "aud"],
    });
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return scope.includes(REQUIRED_SCOPE) ? 200 : 403; // planted hole: substring, not split
  } catch {
    return 401;
  }
}

/** FLAW: audience is not verified, so a token minted for any audience is accepted. */
export async function audienceNotChecked(token: string | null, ctx: Ctx): Promise<number> {
  if (!token) return 401;
  try {
    const { payload } = await jwtVerify(token, ctx.publicKey, {
      issuer: ctx.issuer, // planted hole: no `audience` option
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iss"],
    });
    return hasScope(payload) ? 200 : 403;
  } catch {
    return 401;
  }
}

/** FLAW: the gate is effectively off — accepts everything, even with no token. */
export async function authDisabled(_token: string | null, _ctx: Ctx): Promise<number> {
  return 200;
}

export const MUTANTS = { expiryNotChecked, substringScope, audienceNotChecked } as const;
