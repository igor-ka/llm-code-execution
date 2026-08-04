/**
 * Auth-test fixtures. No network, no real Auth0: generate a throwaway RSA keypair,
 * mint our own RS256 JWTs with jose, and pass the local public key straight to the
 * verifier (jose accepts a key in place of a remote JWKS). Mirrors conftest.py.
 */
import express, { type Express, type RequestHandler } from "express";
import { SignJWT, generateKeyPair, type KeyLike } from "jose";
import { makeRequirePrincipal } from "../../src/auth.js";
import { HttpError } from "../../src/errors.js";
import { loadSettings, type Settings } from "../../src/config.js";

export const ISSUER = "https://issuer.example.com/";
export const AUDIENCE = "https://api.example.test";
export const JWKS_URL = "https://issuer.example.com/.well-known/jwks.json";

export interface Keypair {
  publicKey: KeyLike;
  privateKey: KeyLike;
}

export async function makeKeypair(): Promise<Keypair> {
  return generateKeyPair("RS256", { extractable: true });
}

/** Mint an RS256 token with valid defaults; `overrides` replace any claim. */
export async function makeToken(
  privateKey: KeyLike,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    sub: "auth0|abc123",
    org_id: "org_xyz",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: now + 300,
    scope: "openid profile execute:code",
    ...overrides,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).sign(privateKey);
}

/** An unsigned (alg=none) token — must be rejected regardless of claims. */
export function makeAlgNoneToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc({
    sub: "x",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: now + 300,
    scope: "execute:code",
  });
  return `${header}.${payload}.`;
}

export function authSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...loadSettings({}),
    authRequired: true,
    oidcIssuer: ISSUER,
    oidcAudience: AUDIENCE,
    oidcJwksUrl: JWKS_URL,
    ...overrides,
  };
}

/**
 * A requirePrincipal stand-in for tests: sets res.locals.principal directly, no token needed.
 * Pass userId=null to exercise anonymous mode (history persists nothing / routes 404).
 */
export function fakePrincipal(
  userId: string | null,
  tenantId: string | null = null,
): RequestHandler {
  return (_req, res, next) => {
    res.locals.principal = { userId, tenantId };
    next();
  };
}

/** Minimal app exposing the real requirePrincipal middleware, keyed to a local public key. */
export function makeProtectedApp(settings: Settings, publicKey?: KeyLike): Express {
  const app = express();
  app.use(express.json());
  app.get("/protected", makeRequirePrincipal(settings, publicKey), (_req, res) => {
    const p = res.locals.principal ?? { userId: null, tenantId: null };
    res.json({ user_id: p.userId, tenant_id: p.tenantId });
  });
  // Error handler mirroring the production one (see server.ts).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ detail: err.detail });
        return;
      }
      res.status(500).json({ detail: "Internal server error" });
    },
  );
  return app;
}
