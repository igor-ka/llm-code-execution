// Thin client for the backend /api/execute endpoint.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export type MessageResponse = {
  type: "message";
  message: string;
};

export type ResultResponse = {
  type: "result";
  language: string;
  code: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
};

export type ExecuteResponse = MessageResponse | ResultResponse;

export type AuthConfig = { authRequired: boolean };

// Ask the backend whether it enforces auth, so the UI mirrors it instead of guessing.
// Fails secure: any error or missing field is treated as "auth required".
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const resp = await fetch(`${API_BASE}/api/config`);
  if (!resp.ok) throw new Error(`Failed to load config (${resp.status})`);
  const body = (await resp.json()) as { auth_required?: boolean };
  return { authRequired: body.auth_required ?? true };
}

export async function execute(prompt: string, accessToken?: string): Promise<ExecuteResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const resp = await fetch(`${API_BASE}/api/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt }),
  });

  if (!resp.ok) {
    let detail = `Request failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      /* keep default detail */
    }
    throw new Error(detail);
  }

  return (await resp.json()) as ExecuteResponse;
}
