import { resolveApiBase } from "./apiBase";
// Thin client for the per-user chat-history endpoints. Every call is authenticated with a
// bearer token and reads a `{detail}` error body, mirroring api.ts. History is an
// authenticated feature: the backend 404s these routes for anonymous callers.

import type { MessageResponse, ResultResponse } from "./api";

const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE);

// A session as it appears in the list wire. `run_count` is present in the list but omitted
// by the detail wire, so it is optional here.
export type SessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  run_count?: number;
};

// A persisted run: the /api/execute response union plus its provenance columns. Because it is
// a superset of ExecuteResponse, the same renderer draws both live and historical runs.
export type RunProvenance = { id: string; session_id: string; created_at: string; prompt: string };
export type RunView = (MessageResponse | ResultResponse) & RunProvenance;

// A session with its runs. The detail view derives its count from `runs.length`, not
// `run_count` (which the detail wire omits).
export type SessionDetail = SessionSummary & { runs: RunView[] };

export type SessionList = { sessions: SessionSummary[]; total: number };

function authHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// Read the server's `{detail}` on a non-2xx response, falling back to a status-coded default.
async function errorDetail(resp: Response): Promise<string> {
  let detail = `Request failed (${resp.status})`;
  try {
    const body = (await resp.json()) as { detail?: string };
    if (body?.detail) detail = body.detail;
  } catch {
    /* keep default detail */
  }
  return detail;
}

async function ensureOk(resp: Response): Promise<void> {
  if (!resp.ok) throw new Error(await errorDetail(resp));
}

export async function listSessions(token: string, q?: string): Promise<SessionList> {
  const query = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const resp = await fetch(`${API_BASE}/api/sessions${query}`, { headers: authHeaders(token) });
  await ensureOk(resp);
  return (await resp.json()) as SessionList;
}

export async function getSession(token: string, id: string): Promise<SessionDetail> {
  const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, {
    headers: authHeaders(token),
  });
  await ensureOk(resp);
  return (await resp.json()) as SessionDetail;
}

export async function renameSession(
  token: string,
  id: string,
  title: string,
): Promise<SessionSummary> {
  const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ title }),
  });
  await ensureOk(resp);
  return (await resp.json()) as SessionSummary;
}

export async function deleteSession(token: string, id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  await ensureOk(resp);
}

export async function clearHistory(token: string): Promise<{ deleted: number }> {
  const resp = await fetch(`${API_BASE}/api/sessions`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  await ensureOk(resp);
  return (await resp.json()) as { deleted: number };
}

export async function deleteRun(token: string, id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/api/runs/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  await ensureOk(resp);
}
