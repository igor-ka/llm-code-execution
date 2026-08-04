/**
 * Application configuration, loaded from environment / repo-root .env.
 *
 * Centralizing limits here is deliberate: it is the seam where per-tenant overrides
 * will later plug in (resolve a Settings variant from tenantId) without touching
 * call sites — mirrors the original config.py.
 */
import { config as loadDotenv } from "dotenv";

// Repo-root .env for local dev, matching the README's `export $(... ../.env ...)`.
// process.env always wins (dotenv does not override) and the file is absent in
// Docker (env arrives via compose env_file), where this simply no-ops.
loadDotenv({ path: "../.env" });

export interface Settings {
  anthropicApiKey: string;
  llmModel: string;
  sandboxImage: string;
  sandboxTimeoutSeconds: number;
  sandboxMemoryMb: number;
  sandboxCpus: number;
  sandboxPidsLimit: number;
  sandboxMaxOutputChars: number;
  frontendOrigin: string;
  authRequired: boolean;
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUrl: string;
  databaseUrl: string;
  historyEnabled: boolean; // convenience: authRequired && databaseUrl set
}

type Env = Record<string, string | undefined>;

const str = (v: string | undefined, dflt: string): string => (v === undefined ? dflt : v);
const num = (v: string | undefined, dflt: number): number =>
  v === undefined || v === "" ? dflt : Number(v);
// Matches pydantic bool coercion: empty/false/0/no/off -> false, anything else -> true.
const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : !["", "false", "0", "no", "off"].includes(v.toLowerCase());

export function loadSettings(env: Env = process.env): Settings {
  const databaseUrl = str(env.DATABASE_URL, "");
  const authRequired = bool(env.AUTH_REQUIRED, true);
  return {
    anthropicApiKey: str(env.ANTHROPIC_API_KEY, ""),
    llmModel: str(env.LLM_MODEL, "claude-sonnet-4-6"),
    sandboxImage: str(env.SANDBOX_IMAGE, "llm-sandbox:latest"),
    sandboxTimeoutSeconds: num(env.SANDBOX_TIMEOUT_SECONDS, 10),
    sandboxMemoryMb: num(env.SANDBOX_MEMORY_MB, 256),
    sandboxCpus: num(env.SANDBOX_CPUS, 0.5),
    sandboxPidsLimit: num(env.SANDBOX_PIDS_LIMIT, 64),
    sandboxMaxOutputChars: num(env.SANDBOX_MAX_OUTPUT_CHARS, 20000),
    frontendOrigin: str(env.FRONTEND_ORIGIN, "http://localhost:5173"),
    authRequired,
    oidcIssuer: str(env.OIDC_ISSUER, ""),
    oidcAudience: str(env.OIDC_AUDIENCE, ""),
    oidcJwksUrl: str(env.OIDC_JWKS_URL, ""),
    databaseUrl,
    // History is an authenticated feature: it exists only when auth is on AND a DB is
    // configured. Anonymous/local mode (no DATABASE_URL) boots with history disabled.
    historyEnabled: authRequired && databaseUrl !== "",
  };
}

let cached: Settings | undefined;

/** Cached process-wide settings (analog of the lru_cached get_settings()). */
export function getSettings(): Settings {
  if (!cached) cached = loadSettings();
  return cached;
}
