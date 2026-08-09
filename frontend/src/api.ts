// Thin client for the backend /api/execute endpoint.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export type MessageResponse = {
  type: "message";
  message: string;
  // Present only when the caller is authenticated and the run was persisted.
  session_id?: string;
  run_id?: string;
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
  // Present only when the caller is authenticated and the run was persisted.
  session_id?: string;
  run_id?: string;
};

export type ExecuteResponse = MessageResponse | ResultResponse;

export type AuthConfig = { authRequired: boolean; historyEnabled: boolean };

// Ask the backend whether it enforces auth and whether per-user history is available, so the
// UI mirrors the server instead of guessing. Fails secure: any error or missing field is
// treated as "auth required"; history defaults to off (an unknown key ⇒ no history UI).
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const resp = await fetch(`${API_BASE}/api/config`);
  if (!resp.ok) throw new Error(`Failed to load config (${resp.status})`);
  const body = (await resp.json()) as { auth_required?: boolean; history_enabled?: boolean };
  return {
    authRequired: body.auth_required ?? true,
    historyEnabled: body.history_enabled ?? false,
  };
}

/**
 * A non-2xx response, preserving what the UI needs to react rather than flattening it to a
 * string. `retryAfterSeconds` comes from the Retry-After header, which the backend exposes via
 * Access-Control-Expose-Headers — without that the browser could not read it cross-origin.
 */
export class ApiError extends Error {
  // `override` is required: `name` is declared on Error and the app tsconfig sets
  // noImplicitOverride.
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail);
  }
}

/** Parse Retry-After as delta-seconds; undefined when absent or not a number. */
function retryAfterFrom(resp: Response): number | undefined {
  const raw = resp.headers?.get("Retry-After");
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export async function execute(
  prompt: string,
  accessToken?: string,
  sessionId?: string,
): Promise<ExecuteResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const body: { prompt: string; session_id?: string } = { prompt };
  if (sessionId) body.session_id = sessionId;

  const resp = await fetch(`${API_BASE}/api/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = `Request failed (${resp.status})`;
    try {
      const errBody = (await resp.json()) as { detail?: string };
      if (errBody?.detail) detail = errBody.detail;
    } catch {
      /* keep default detail */
    }
    throw new ApiError(resp.status, detail, retryAfterFrom(resp));
  }

  return (await resp.json()) as ExecuteResponse;
}
