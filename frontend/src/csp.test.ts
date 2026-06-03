import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

const opts = { apiBase: "http://localhost:8000", auth0Domain: "tenant.us.auth0.com" };

function directive(csp: string, name: string): string | undefined {
  return csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
}

describe("buildCsp", () => {
  it("locks script-src to 'self' in production (no inline, no eval)", () => {
    const csp = buildCsp({ ...opts, dev: false });
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("restricts connect-src to self, the API, and the Auth0 tenant", () => {
    const csp = buildCsp({ ...opts, dev: false });
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' http://localhost:8000 https://tenant.us.auth0.com",
    );
  });

  it("denies framing and plugins, and allows the Auth0 silent-auth frame", () => {
    const csp = buildCsp({ ...opts, dev: false });
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-src")).toBe("frame-src https://tenant.us.auth0.com");
  });

  it("relaxes script-src and adds the HMR websocket in dev", () => {
    const csp = buildCsp({ ...opts, dev: true });
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws:");
  });

  it("omits Auth0 origins when the domain is not configured", () => {
    const csp = buildCsp({ apiBase: "http://localhost:8000", auth0Domain: "", dev: false });
    expect(csp).not.toContain("https://");
    expect(directive(csp, "frame-src")).toBeUndefined();
  });
});
