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
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">'); // fell through to the SPA, not the raw policy
  });

  it("does not answer a non-GET to an unknown path with the SPA", async () => {
    const res = await request(appServing(fixtures)).post("/whatever");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });
});
