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

export async function execute(prompt: string): Promise<ExecuteResponse> {
  const resp = await fetch(`${API_BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
