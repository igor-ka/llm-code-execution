import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import {
  AUDIENCE,
  ISSUER,
  authSettings,
  makeKeypair,
  makeProtectedApp,
  makeToken,
  type Keypair,
} from "./helpers/auth.js";
import {
  MUTANTS,
  audienceNotChecked,
  authDisabled,
  expiryNotChecked,
  substringScope,
} from "./mutants.js";

let kp: Keypair;
beforeAll(async () => {
  kp = await makeKeypair();
});
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const ctx = () => ({ publicKey: kp.publicKey, issuer: ISSUER, audience: AUDIENCE });
const app = () => makeProtectedApp(authSettings(), kp.publicKey);

describe("mutation coverage: mutant accepts, real gate rejects", () => {
  it("expiry hole caught", async () => {
    const expired = await makeToken(kp.privateKey, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await expiryNotChecked(expired, ctx())).toBe(200);
    expect((await request(app()).get("/protected").set(bearer(expired))).status).toBe(401);
  });

  it("substring-scope hole caught", async () => {
    const t = await makeToken(kp.privateKey, { scope: "openid execute:codex", permissions: [] });
    expect(await substringScope(t, ctx())).toBe(200);
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(403);
  });

  it("audience hole caught", async () => {
    const t = await makeToken(kp.privateKey, { aud: "https://wrong" });
    expect(await audienceNotChecked(t, ctx())).toBe(200);
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(401);
  });

  it("auth-disabled hole caught", async () => {
    expect(await authDisabled(null, ctx())).toBe(200);
    expect((await request(app()).get("/protected")).status).toBe(401);
  });

  it("every mutant still accepts a normal valid token", async () => {
    const t = await makeToken(kp.privateKey);
    for (const mutant of Object.values(MUTANTS)) {
      expect(await mutant(t, ctx())).toBe(200);
    }
  });
});
