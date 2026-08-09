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
  redisUrl: string;
  quotaBurst: number;
  quotaBurstWindowSeconds: number;
  quotaSustained: number;
  quotaSustainedWindowSeconds: number;
  sandboxMaxConcurrent: number;
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
    // Rate limiting. Defaults are deliberately conservative: 10 requests/minute of burst and
    // 100/hour sustained per identity, and 4 concurrent sandboxes (at 256 MB and 0.5 CPU each,
    // roughly what a 4-core/8 GB dev box tolerates). All tunable — they are config, not
    // architecture. See docs/specs/2026-08-08-per-user-rate-limiting.md.
    redisUrl: str(env.REDIS_URL, ""),
    quotaBurst: num(env.RATE_LIMIT_BURST, 10),
    quotaBurstWindowSeconds: num(env.RATE_LIMIT_BURST_WINDOW_SECONDS, 60),
    quotaSustained: num(env.RATE_LIMIT_SUSTAINED, 100),
    quotaSustainedWindowSeconds: num(env.RATE_LIMIT_SUSTAINED_WINDOW_SECONDS, 3600),
    sandboxMaxConcurrent: num(env.SANDBOX_MAX_CONCURRENT, 4),
  };
}

/**
 * Fail fast when the quota store is not configured (D6): the backend refuses to start rather
 * than run with the budget control silently absent. History's "off when unconfigured" pattern
 * is deliberately NOT reused here — history is a feature, this is a security control.
 *
 * Deliberately not part of loadSettings(): createApp is the seam every backend test builds on,
 * and a hard Redis dependency there would become a hard dependency of every unit test (S10).
 * Call this from the composition root only — see src/index.ts.
 */
export function assertRedisConfigured(settings: Settings): void {
  if (settings.redisUrl === "") {
    throw new Error(
      "REDIS_URL is not set. The per-user request quota requires Redis; the backend refuses " +
        "to start without it rather than serve traffic unprotected. Set REDIS_URL " +
        "(docker-compose provides one at redis://redis:6379).",
    );
  }
}

let cached: Settings | undefined;

/** Cached process-wide settings (analog of the lru_cached get_settings()). */
export function getSettings(): Settings {
  if (!cached) cached = loadSettings();
  return cached;
}
