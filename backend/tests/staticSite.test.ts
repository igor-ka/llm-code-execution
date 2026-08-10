import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCspPolicy, mountStaticSite } from "../src/staticSite.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "public");

function appServing(dir: string) {
  const app = express();
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  mountStaticSite(app, dir);
  return app;
}

describe("readCspPolicy", () => {
  it("reads the policy the build emitted", () => {
    expect(readCspPolicy(fixtures)).toBe(
      "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );
  });

  it("throws when csp.txt is absent, rather than serving the app without a CSP", () => {
    // Same posture as REDIS_URL (ADR-0003 D6): refuse to run with a security control silently
    // absent. A missing policy is a broken build, not a degraded mode.
    expect(() => readCspPolicy(join(fixtures, "nope"))).toThrow(/csp\.txt/);
  });
});

describe("mountStaticSite", () => {
  it("serves index.html at the root with the production CSP header", async () => {
    const res = await request(appServing(fixtures)).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("serves static assets", async () => {
    const res = await request(appServing(fixtures)).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("asset");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("serves a deep link with index.html so client-side routing works", async () => {
    const res = await request(appServing(fixtures)).get("/sessions/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it("never answers an /api path with the SPA", async () => {
    const res = await request(appServing(fixtures)).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it("treats the bare /api root as an API path, not a deep link", async () => {
    // startsWith("/api/") does not match "/api"; without the explicit check this one path
    // answers 200 with HTML while every other unmatched API path 404s.
    const res = await request(appServing(fixtures)).get("/api");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it("leaves real API routes alone", async () => {
    const res = await request(appServing(fixtures)).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not serve csp.txt itself — it is server config, not a public asset", async () => {
    const res = await request(appServing(fixtures)).get("/csp.txt");
    expect(res.status).toBe(404); // skipped by the static handler, then 404'd as a missing file
    expect(res.text).not.toContain("script-src"); // the policy itself never reaches the client
  });

  it("does not answer a non-GET to an unknown path with the SPA", async () => {
    const res = await request(appServing(fixtures)).post("/whatever");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it("does not leak the policy through a doubled slash", async () => {
    // express.static normalizes internally, so `//csp.txt` reached the file even though it does
    // not equal "/csp.txt". The guard normalizes first.
    const res = await request(appServing(fixtures)).get("//csp.txt");
    expect(res.text).not.toContain("script-src");
  });

  it("does not answer //api paths with the SPA either", async () => {
    const res = await request(appServing(fixtures)).get("//api/does-not-exist");
    expect(res.text).not.toContain('<div id="root">');
  });

  it("404s a missing asset instead of answering it with HTML", async () => {
    // A client holding a stale index.html asks for a purged hashed chunk. Answering 200 HTML
    // makes that surface as an opaque module-parse error rather than an honest 404.
    const res = await request(appServing(fixtures)).get("/assets/missing.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });
});

describe("readCspPolicy — production policies only", () => {
  it("rejects a dev policy, which contains script-src 'self' as a substring", async () => {
    // `includes("script-src 'self'")` accepts `script-src 'self' 'unsafe-inline' 'unsafe-eval'`.
    // Serving the SPA with eval enabled is the exact regression this guard exists to prevent.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "csp-"));
    writeFileSync(
      join(dir, "csp.txt"),
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'\n",
    );

    expect(() => readCspPolicy(dir)).toThrow(/script-src/);
  });
});
