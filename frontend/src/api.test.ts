import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute, fetchAuthConfig, type MessageResponse, type ResultResponse } from "./api";

// A minimal stand-in for the parts of the fetch Response we rely on.
function mockResponse(opts: { ok: boolean; status?: number; json: () => unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: () => Promise.resolve(opts.json()),
  } as unknown as Response;
}

describe("execute", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses and returns a message response", async () => {
    const payload: MessageResponse = { type: "message", message: "no code needed" };
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => payload }));

    await expect(execute("hi")).resolves.toEqual(payload);
  });

  it("parses and returns a result response", async () => {
    const payload: ResultResponse = {
      type: "result",
      language: "python",
      code: "print(1)",
      stdout: "1\n",
      stderr: "",
      exit_code: 0,
      duration_ms: 42,
      timed_out: false,
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => payload }));

    await expect(execute("compute")).resolves.toEqual(payload);
  });

  it("sends a correctly shaped POST request", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ type: "message", message: "ok" }) }),
    );

    await execute("my prompt");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/execute");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({ prompt: "my prompt" });
  });

  it("attaches a Bearer Authorization header when a token is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ type: "message", message: "ok" }) }),
    );

    await execute("my prompt", "tok-123");

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when no token is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ type: "message", message: "ok" }) }),
    );

    await execute("my prompt");

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws the server-provided detail on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: false, status: 400, json: () => ({ detail: "bad prompt" }) }),
    );

    await expect(execute("x")).rejects.toThrow("bad prompt");
  });

  it("throws a default message when the error body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 503,
        json: () => {
          throw new Error("not json");
        },
      }),
    );

    await expect(execute("x")).rejects.toThrow("Request failed (503)");
  });

  it("throws a default message when the error body has no detail", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: false, status: 500, json: () => ({}) }));

    await expect(execute("x")).rejects.toThrow("Request failed (500)");
  });
});

describe("fetchAuthConfig", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GETs /api/config and maps auth_required", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ auth_required: false }) }),
    );

    await expect(fetchAuthConfig()).resolves.toEqual({ authRequired: false });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("http://localhost:8000/api/config");
  });

  it("fails secure (authRequired true) when the field is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => ({}) }));

    await expect(fetchAuthConfig()).resolves.toEqual({ authRequired: true });
  });

  it("throws on a non-2xx response so the caller can fall back to the secure default", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: false, status: 503, json: () => ({}) }));

    await expect(fetchAuthConfig()).rejects.toThrow("Failed to load config (503)");
  });
});
