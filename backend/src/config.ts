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
  sandboxBackend: "docker" | "cloudrun"; // "cloudrun" requires --sandbox-launcher on the service
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

/**
 * "docker" | "cloudrun", or a hard failure. Absent means docker; anything else present must be
 * one of the two, because the consequence of guessing is a service that boots healthy and fails
 * every execution.
 */
const sandboxBackendFrom = (v: string | undefined): "docker" | "cloudrun" => {
  if (v === undefined || v === "") return "docker";
  if (v === "docker" || v === "cloudrun") return v;
  throw new Error(`SANDBOX_BACKEND must be "docker" or "cloudrun", got ${JSON.stringify(v)}`);
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
    // Absent -> docker, so every local run and existing test is unchanged. But a PRESENT and
    // unrecognised value is refused, not quietly downgraded: on Cloud Run there is no Docker
    // socket, so a typo would pass startup and every execution would fail at request time. Same
    // reasoning as posInt() above — running with the wrong backend silently is the failure mode.
    sandboxBackend: sandboxBackendFrom(env.SANDBOX_BACKEND),
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

/**
 * Refuse to serve the deployed backend with a localhost CORS origin.
 *
 * `FRONTEND_ORIGIN` defaults to the dev origin, the deploy command never set it, and the deployed
 * service was therefore answering every request with
 * `Access-Control-Allow-Origin: http://localhost:5173`. Nothing broke, because Cloud Run serves the
 * SPA and the API from the same origin and same-origin requests never consult CORS — which is
 * exactly why it went unnoticed until the live service was probed by hand.
 *
 * **Honest severity: low.** `cors()` is configured without `credentials`, and this API authenticates
 * with a bearer token held in memory, never a cookie. A page on localhost:5173 therefore cannot
 * ride a victim's session — it would need its own token, and with one it could call the API from
 * anything. The guard is here because the config was simply wrong, because the harm stops being
 * theoretical the day anything cookie-based is added, and because a deployment that quietly names a
 * developer's laptop as a trusted origin is not a posture worth keeping.
 *
 * `sandboxBackend` is the discriminator rather than NODE_ENV or authRequired, and that choice is
 * load-bearing: `cloudrun` requires `--sandbox-launcher` on a Cloud Run service, so it cannot run
 * on a laptop at all, while both of the others are true in ordinary local runs. A guard that fires
 * during `npm run dev` gets deleted instead of fixed.
 */
export function assertFrontendOriginConfigured(settings: Settings): void {
  if (settings.sandboxBackend !== "cloudrun") return;
  const raw = settings.frontendOrigin;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FRONTEND_ORIGIN is not a valid origin (${JSON.stringify(raw)}).`);
  }
  // Before touching `origin`: for a non-special scheme it serializes to the string "null", which
  // would make the shape check below throw with a nonsense correction.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`FRONTEND_ORIGIN must be an http(s) origin, got ${JSON.stringify(raw)}.`);
  }
  // A URL is not an origin. `new URL()` happily accepts a trailing slash, a path or a query, and
  // `cors()` emits whatever string it was handed — while a browser's `Origin` header carries none
  // of those. The result would be an allowlist entry no request can ever match: CORS silently
  // failing on the deployed service, where same-origin requests hide it completely.
  //
  // Rejecting rather than normalizing, so the value the operator set is the value that runs. The
  // message carries the corrected string so the fix is a copy-paste.
  if (url.origin !== raw) {
    throw new Error(
      `FRONTEND_ORIGIN is ${JSON.stringify(raw)}, which is a URL rather than a bare origin. ` +
        "A browser's Origin header has no trailing slash, path or query, so this would never " +
        `match one. Use ${JSON.stringify(url.origin)}.`,
    );
  }
  // `URL.hostname` brackets an IPv6 literal — `http://[::1]:5173` gives `"[::1]"`, never `"::1"` —
  // and the whole 127/8 block is loopback, not just 127.0.0.1.
  const host = url.hostname;
  if (host === "localhost" || host === "[::1]" || host.startsWith("127.")) {
    throw new Error(
      `FRONTEND_ORIGIN is ${JSON.stringify(raw)}, a localhost origin, but ` +
        "SANDBOX_BACKEND=cloudrun means this is the deployed service. It would advertise a " +
        "developer's laptop as a permitted CORS origin. Set FRONTEND_ORIGIN to the service's own " +
        "URL (see docs/runbooks/gcp-deploy.md).",
    );
  }
}

/**
 * Slot N owns `base + N * SLOT_STEP` for each service — see "Parallel worktrees" in README.md.
 *
 * `PORT` is deliberately absent. Compose pins the container's listener to 8000 regardless of slot
 * (`docker-compose.yml`, `environment:`) and publishes it on `BACKEND_PORT`, so checking `PORT`
 * would warn on every single Compose boot of a non-zero slot — and a check that cries wolf on the
 * normal path teaches you to skip the one that matters. `BACKEND_PORT` carries the same
 * information from `.env` and is correct in both topologies. A host-run backend that gets `PORT`
 * wrong is self-revealing anyway: it either collides on bind or its own SPA cannot reach it.
 */
const SLOT_STEP = 10;
const SLOT_PORT_BASES: Record<string, number> = {
  BACKEND_PORT: 8000,
  FRONTEND_PORT: 5173,
  PG_PORT: 5432,
  REDIS_PORT: 6379,
  FRONTEND_ORIGIN: 5173,
  DATABASE_URL: 5432,
  REDIS_URL: 6379,
};

/** Sandbox image tags follow `…:slot<N>`. Anything else is left alone — a custom image is fine. */
const SLOT_IMAGE_TAG = /:slot(\d+)$/;

/**
 * The local port a value points at, or undefined when there is nothing checkable.
 *
 * Bare numbers are the `*_PORT` variables. For URLs, non-localhost hosts are skipped
 * deliberately: under Compose these are rewritten to service names on the compose network
 * (`postgres:5432`), where the host-port scheme does not apply at all. Only a host-run process
 * uses localhost, and only a host-run process can land on another slot's datastore.
 */
function localPort(raw: string): number | undefined {
  if (raw === "") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined;
  return url.port === "" ? undefined : Number(url.port);
}

/**
 * Warn when this worktree's env claims a stack slot its ports do not match.
 *
 * `.env` carries nine values that must agree, and the failure when they don't is silent: a
 * worktree on slot 1 whose DATABASE_URL still says 5432 writes its chat history into slot 0's
 * Postgres and reports nothing. Warnings rather than a throw — unlike REDIS_URL (D6) this is a
 * consistency check, not a security control, and a developer may have deliberate reasons to
 * point one service somewhere else.
 */
export function stackSlotWarnings(env: Env = process.env): string[] {
  const raw = env.STACK_SLOT;
  if (raw === undefined || raw.trim() === "") return [];
  const slot = Number(raw);
  if (!Number.isInteger(slot) || slot < 0) {
    return [`STACK_SLOT is ${JSON.stringify(raw)}, which is not a slot number; ports unchecked.`];
  }
  const warnings: string[] = [];
  for (const [name, base] of Object.entries(SLOT_PORT_BASES)) {
    const actual = localPort(str(env[name], ""));
    if (actual === undefined) continue;
    const expected = base + slot * SLOT_STEP;
    if (actual !== expected) {
      warnings.push(
        `${name} points at port ${actual}, but STACK_SLOT=${slot} owns ${expected}. ` +
          `This worktree is sharing another slot's service.`,
      );
    }
  }

  // The image tag is the one non-port value that matters here, and it is the one whose mistake is
  // worst: image tags are daemon-wide, so a slot-1 worktree left on slot 0's tag executes slot 0's
  // sandbox image — defeating the isolation the per-slot tag exists to provide.
  const image = str(env.SANDBOX_IMAGE, "");
  const tagged = SLOT_IMAGE_TAG.exec(image);
  if (tagged && Number(tagged[1]) !== slot) {
    warnings.push(
      `SANDBOX_IMAGE is "${image}", but STACK_SLOT=${slot} owns ":slot${slot}". ` +
        `This worktree would execute another slot's sandbox image.`,
    );
  } else if (!tagged && image !== "" && slot !== 0) {
    warnings.push(
      `SANDBOX_IMAGE is "${image}", which carries no ":slot${slot}" tag, so it is shared with ` +
        `every other worktree on this Docker daemon.`,
    );
  }
  return warnings;
}

let cached: Settings | undefined;

/** Cached process-wide settings (analog of the lru_cached get_settings()). */
export function getSettings(): Settings {
  if (!cached) cached = loadSettings();
  return cached;
}
