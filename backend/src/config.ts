/**
 * Application configuration, loaded from environment / repo-root .env.
 *
 * Centralizing limits here is deliberate: it is the seam where per-tenant overrides
 * will later plug in (resolve a Settings variant from tenantId) without touching
 * call sites — mirrors the original config.py.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// Repo-root env files for local dev. `.env` carries this worktree's stack identity (slot,
// ports); `.env.shared` carries everything identical across worktrees (API key, OIDC, limits)
// and is a symlink inside a worktree, so the key exists once. Most-specific first because
// dotenv never overrides an already-set key — process.env still wins over both, and in Docker
// both are absent (env arrives via compose env_file), where this simply no-ops.
loadDotenv({ path: ["../.env", "../.env.shared"] });

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
  logFormat: "json" | "text"; // "json" for Cloud Logging ingestion; "text" for humans
  port: number; // Cloud Run injects PORT; 8080 is its default contract
  shutdownGraceMs: number; // must stay UNDER the platform SIGTERM->SIGKILL window
  publicDir: string; // absolute path to the built SPA; empty disables SPA serving (dev default)
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
/**
 * A positive INTEGER, or the default. Unlike num(), this REFUSES malformed input instead of
 * silently yielding NaN.
 *
 * That distinction is load-bearing for the rate limits: every comparison against NaN is false,
 * so `RATE_LIMIT_BURST=1_000` (a plausible typo — JS numeric separators are not valid in
 * Number()) would make the quota allow everything and `SANDBOX_MAX_CONCURRENT=1_0` would make
 * the concurrency cap never saturate. Both controls would be off, with no error and no log —
 * exactly the "running with the control absent" state D6 exists to prevent.
 *
 * Integer, not merely positive, for the same reason one step further out: these are discrete
 * counts and whole seconds. A fractional window reaches Redis EXPIRE, which rejects non-integer
 * seconds — the script then errors on every call, the middleware takes its fail-open path, and
 * the quota is silently disabled. Same destination as NaN, by a longer road.
 */
const posInt = (name: string, v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return n;
};

// Matches pydantic bool coercion: empty/false/0/no/off -> false, anything else -> true.
const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : !["", "false", "0", "no", "off"].includes(v.toLowerCase());

/**
 * A positive integer that is also a legal TCP port. posInt alone accepts 70000, which passes
 * config and then fails asynchronously inside listen() — where it escapes the fatal-log path
 * entirely and surfaces as a raw ERR_SOCKET_BAD_PORT stack.
 */
const tcpPort = (name: string, v: string | undefined, dflt: number): number => {
  const n = posInt(name, v, dflt);
  if (n > 65535) {
    throw new Error(`${name} must be a valid TCP port (1-65535), got ${JSON.stringify(v)}`);
  }
  return n;
};

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
    logFormat: str(env.LOG_FORMAT, "text") === "json" ? "json" : "text",
    port: tcpPort("PORT", env.PORT, 8080),
    // 8s, inside Cloud Run's 10s window. At exactly 10s the force-exit fires with the
    // platform kill and is decorative.
    shutdownGraceMs: posInt("SHUTDOWN_GRACE_MS", env.SHUTDOWN_GRACE_MS, 8000),
    // resolve() because res.sendFile() rejects a relative path: left relative, the mistake
    // surfaces as a 500 on every SPA request instead of at the boundary where it was made.
    publicDir: env.PUBLIC_DIR ? resolve(env.PUBLIC_DIR) : "",
    // Rate limiting. Defaults are deliberately conservative: 10 requests/minute of burst and
    // 100/hour sustained per identity, and 4 concurrent sandboxes (at 256 MB and 0.5 CPU each,
    // roughly what a 4-core/8 GB dev box tolerates). All tunable — they are config, not
    // architecture. See docs/specs/2026-08-08-per-user-rate-limiting.md.
    redisUrl: str(env.REDIS_URL, ""),
    quotaBurst: posInt("RATE_LIMIT_BURST", env.RATE_LIMIT_BURST, 10),
    quotaBurstWindowSeconds: posInt(
      "RATE_LIMIT_BURST_WINDOW_SECONDS",
      env.RATE_LIMIT_BURST_WINDOW_SECONDS,
      60,
    ),
    quotaSustained: posInt("RATE_LIMIT_SUSTAINED", env.RATE_LIMIT_SUSTAINED, 100),
    quotaSustainedWindowSeconds: posInt(
      "RATE_LIMIT_SUSTAINED_WINDOW_SECONDS",
      env.RATE_LIMIT_SUSTAINED_WINDOW_SECONDS,
      3600,
    ),
    sandboxMaxConcurrent: posInt("SANDBOX_MAX_CONCURRENT", env.SANDBOX_MAX_CONCURRENT, 4),
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
