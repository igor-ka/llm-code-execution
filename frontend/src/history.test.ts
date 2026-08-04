import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistory,
  deleteRun,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  type SessionDetail,
  type SessionList,
} from "./history";

// A minimal stand-in for the parts of the fetch Response we rely on.
function mockResponse(opts: { ok: boolean; status?: number; json?: () => unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: () => Promise.resolve(opts.json ? opts.json() : {}),
  } as unknown as Response;
}

function lastCall() {
  const calls = vi.mocked(fetch).mock.calls;
  return calls[calls.length - 1]!;
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

describe("history client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists sessions with a bearer token and no query", async () => {
    const payload: SessionList = {
      sessions: [{ id: "s1", title: "Fib", created_at: "t", updated_at: "t", run_count: 2 }],
      total: 1,
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => payload }));

    await expect(listSessions("tok-1")).resolves.toEqual(payload);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/sessions");
    expect(authHeader(init)).toBe("Bearer tok-1");
  });

  it("URL-encodes the search query when provided", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ sessions: [], total: 0 }) }),
    );

    await listSessions("tok-1", "a b&c");
    expect(lastCall()[0]).toBe("http://localhost:8000/api/sessions?q=a%20b%26c");
  });

  it("omits the query param for a blank search", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: true, json: () => ({ sessions: [], total: 0 }) }),
    );

    await listSessions("tok-1", "   ");
    expect(lastCall()[0]).toBe("http://localhost:8000/api/sessions");
  });

  it("gets a single session with its runs", async () => {
    const detail: SessionDetail = {
      id: "s1",
      title: "Fib",
      created_at: "t",
      updated_at: "t",
      runs: [
        {
          type: "message",
          message: "hi",
          id: "r1",
          session_id: "s1",
          created_at: "t",
          prompt: "p",
        },
      ],
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => detail }));

    await expect(getSession("tok-1", "s1")).resolves.toEqual(detail);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/sessions/s1");
    expect(authHeader(init)).toBe("Bearer tok-1");
  });

  it("renames a session with a PATCH carrying the new title", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => ({ id: "s1", title: "New", created_at: "t", updated_at: "t" }),
      }),
    );

    await renameSession("tok-1", "s1", "New");
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/sessions/s1");
    expect(init?.method).toBe("PATCH");
    expect(authHeader(init)).toBe("Bearer tok-1");
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({ title: "New" });
  });

  it("deletes a session with a DELETE and no body", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, status: 204 }));

    await expect(deleteSession("tok-1", "s1")).resolves.toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/sessions/s1");
    expect(init?.method).toBe("DELETE");
    expect(authHeader(init)).toBe("Bearer tok-1");
  });

  it("clears all history and returns the deleted count", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, json: () => ({ deleted: 3 }) }));

    await expect(clearHistory("tok-1")).resolves.toEqual({ deleted: 3 });
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/sessions");
    expect(init?.method).toBe("DELETE");
  });

  it("deletes one run with a DELETE to /api/runs/:id", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, status: 204 }));

    await expect(deleteRun("tok-1", "r1")).resolves.toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:8000/api/runs/r1");
    expect(init?.method).toBe("DELETE");
    expect(authHeader(init)).toBe("Bearer tok-1");
  });

  it("throws the server-provided detail on an error response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: false, status: 404, json: () => ({ detail: "Session not found" }) }),
    );

    await expect(getSession("tok-1", "nope")).rejects.toThrow("Session not found");
  });

  it("throws a status-coded default when the error body lacks a detail", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: false, status: 500, json: () => ({}) }));

    await expect(listSessions("tok-1")).rejects.toThrow("Request failed (500)");
  });
});
