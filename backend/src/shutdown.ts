/**
 * Graceful shutdown sequencing.
 *
 * Container platforms send SIGTERM and follow it with SIGKILL after a short grace period. The job
 * here is to use that window: stop accepting new connections, let in-flight requests finish,
 * release external resources (pg pool, Redis client), and exit cleanly — while guaranteeing we
 * exit *at all* if something hangs, since a stuck process just gets SIGKILLed and looks like a
 * crash.
 *
 * Kept free of `process` and real timers in its core so it is testable without spawning anything.
 */
import type { Fields } from "./log.js";

/** Structural type for `http.Server` — narrow on purpose so tests can pass a stub. */
export interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown;
}

export interface ShutdownOptions {
  server: ClosableServer;
  /** Release external resources. Errors are logged, never fatal. */
  cleanup?: () => Promise<void>;
  /**
   * Hard deadline before we give up waiting for connections to drain.
   *
   * Deliberately UNDER the platform's own SIGTERM→SIGKILL window (Cloud Run's is 10s). At
   * exactly 10s this timer and the kill fire together and the force-exit never helps — the
   * process still dies looking like a crash, which is the outcome it exists to prevent.
   */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: (message: string, fields?: Fields) => void;
}

export function makeShutdown({
  server,
  cleanup,
  graceMs = 8_000,
  exit = (code) => process.exit(code),
  log = () => {},
}: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    // A platform may send SIGTERM more than once, and an impatient operator adds SIGINT on top.
    // Re-entering would double-run cleanup and race two exits.
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown: draining", { signal, graceMs });

    // Belt and braces: if draining stalls, exit under our own power with a non-zero code rather
    // than waiting to be SIGKILLed. unref() so this timer can never hold the loop open by itself.
    const deadline = setTimeout(() => {
      log("shutdown: grace period expired, forcing exit", { signal });
      exit(1);
    }, graceMs);
    if (typeof deadline.unref === "function") deadline.unref();

    server.close(() => {
      void (async () => {
        try {
          await cleanup?.();
        } catch (err) {
          log("shutdown: cleanup failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        clearTimeout(deadline);
        log("shutdown: complete", { signal });
        exit(0);
      })();
    });
  };
}
