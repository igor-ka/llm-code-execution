import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import {
  AUDIENCE,
  ISSUER,
  authSettings,
  makeAlgNoneToken,
  makeKeypair,
  makeProtectedApp,
  makeToken,
  type Keypair,
} from "./helpers/auth.js";

let kp: Keypair;
let other: Keypair;
beforeAll(async () => {
  kp = await makeKeypair();
  other = await makeKeypair();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const app = () => makeProtectedApp(authSettings(), kp.publicKey);

describe("require_principal", () => {
  it("valid token passes and yields claims", async () => {
    const resp = await request(app())
      .get("/protected")
      .set(bearer(await makeToken(kp.privateKey)));
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ user_id: "auth0|abc123", tenant_id: "org_xyz" });
  });

  it("scope via permissions array passes", async () => {
    const t = await makeToken(kp.privateKey, {
      scope: "openid profile",
      permissions: ["execute:code"],
    });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(200);
  });

  it("missing scope is 403", async () => {
    const t = await makeToken(kp.privateKey, { scope: "openid profile", permissions: [] });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(403);
  });

  it("lookalike scope 'execute:codex' is 403", async () => {
    const t = await makeToken(kp.privateKey, { scope: "openid execute:codex", permissions: [] });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(403);
  });

  it("bad signature is 401", async () => {
    const t = await makeToken(other.privateKey); // signed by the wrong key
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(401);
  });

  it("alg=none token is 401", async () => {
    expect((await request(app()).get("/protected").set(bearer(makeAlgNoneToken()))).status).toBe(
      401,
    );
  });

  it("wrong audience is 401", async () => {
    const t = await makeToken(kp.privateKey, { aud: "someone-else" });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(401);
  });

  it("wrong issuer is 401", async () => {
    const t = await makeToken(kp.privateKey, { iss: "https://evil.example.com/" });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(401);
  });

  it("expired is 401", async () => {
    const t = await makeToken(kp.privateKey, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect((await request(app()).get("/protected").set(bearer(t))).status).toBe(401);
  });

  it("missing header is 401", async () => {
    expect((await request(app()).get("/protected")).status).toBe(401);
  });

  it("garbage header is 401", async () => {
    expect(
      (await request(app()).get("/protected").set({ Authorization: "Basic xyz" })).status,
    ).toBe(401);
  });

  it("auth disabled allows anonymous", async () => {
    const resp = await request(makeProtectedApp(authSettings({ authRequired: false }))).get(
      "/protected",
    );
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ user_id: null, tenant_id: null });
  });
});

// keep the imports honest for the typecheck
void AUDIENCE;
void ISSUER;
