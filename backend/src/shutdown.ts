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

/**
 * Exit without truncating the logs that explain why.
 *
 * Under a container runtime stdout is a PIPE, which makes writes asynchronous — and
 * `process.exit()` does not flush what is still buffered. Exiting directly after a log call can
 * therefore drop the last line, which is exactly the line you need: "shutdown: complete", or
 * worse, "fatal: backend failed to start", leaving an exit-1 container with empty logs.
 *
 * Writing an empty string queues the callback behind whatever is already in the buffer.
 */
export function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
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
   *
   * **A long `/api/execute` cannot finish inside this window and is not meant to.** Judge +
   * generate are unbounded LLM round trips and the sandbox adds up to `SANDBOX_TIMEOUT_SECONDS`
   * on top. Such a request is doomed either way — the platform kills the instance at 10s
   * regardless — so the choice is only whether we exit under our own power with a log line
   * saying so, or get SIGKILLed silently. The former is strictly more diagnosable. Tune with
   * `SHUTDOWN_GRACE_MS` if the platform's window ever differs.
   */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: (message: string, fields?: Fields) => void;
}

export function makeShutdown({
  server,
  cleanup,
  graceMs = 8_000,
  exit = exitAfterFlush,
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
