/**
 * SandboxBackend backed by Cloud Run sandboxes.
 *
 * Cloud Run injects /usr/local/gcp/bin/sandbox into the container when the service is deployed
 * with --sandbox-launcher. `sandbox do` creates an ephemeral sandbox, runs one command in it, and
 * deletes it — the same shape as `docker run --rm`, which is why this slots into the existing
 * port with no change to callers.
 *
 * What this gets for free, and DockerBackend has to ask for: outbound network is denied by
 * default, the host filesystem is read-only, and the sandbox cannot read the service's
 * environment variables or reach the metadata server. That last one matters most here — the
 * runtime identity's access token lives on that metadata server.
 *
 * What it does NOT get, and the README must say so (spec D7/D13/D16/S4): per-execution memory,
 * CPU and PID caps; processes inside run with sudo; and the readable filesystem is the
 * APPLICATION image, so /app/dist and /app/node_modules are visible. The concurrency cap and the
 * wall-clock timeout below are what bound a runaway payload now.
 */
import { spawn } from "node:child_process";
import type { SandboxBackend, ExecutionLimits } from "./base.js";
import type { SandboxResult } from "../schemas.js";
import { log } from "../log.js";

const LANG_RUNNERS: Record<string, string[]> = {
  python: ["python3", "-I", "-B", "-c"],
};

/** Renders a capped buffer plus however many characters were thrown away while capping. */
function rendered(kept: string, dropped: number): string {
  return dropped === 0 ? kept : `${kept}\n…[truncated, ${dropped} more chars]`;
}

export class CloudRunSandboxBackend implements SandboxBackend {
  constructor(readonly cliPath = "/usr/local/gcp/bin/sandbox") {}

  async execute(code: string, language: string, limits: ExecutionLimits): Promise<SandboxResult> {
    const runner = LANG_RUNNERS[language];
    if (!runner) {
      return {
        stdout: "",
        stderr: `Unsupported language: '${language}'`,
        exitCode: 2,
        durationMs: 0,
        timedOut: false,
      };
    }

    // --write gives the sandbox a tmpfs overlay to write into; the base filesystem stays
    // read-only. NO --allow-egress, ever: deny-by-default egress is the property that makes this
    // backend match `--network none`, and passing it once would silently undo the isolation the
    // README claims. The code travels as a single argv element with no shell involved, so there
    // is no quoting or injection surface.
    const args = ["do", "--write", "--", ...runner, code];

    const started = process.hrtime.bigint();
    return await new Promise<SandboxResult>((resolve) => {
      // detached: its own process group. `sandbox do` runs the interpreter as a GRANDCHILD, so
      // killing only the CLI leaves it alive holding the stdio pipes — and 'close' never fires
      // while a pipe is held. execute() would then not return until the payload finished on its
      // own: the timeout would bound nothing and ConcurrencyLimitedBackend would never release
      // the slot. Those two are the only controls left after D7, so this is load-bearing.
      const child = spawn(this.cliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let timedOut = false;
      let settled = false;

      // Bound what is RETAINED, not merely what is reported. Accumulating without limit and
      // truncating at the end lets hostile code stream gigabytes into THIS process before the
      // timeout fires — and D7 removes the per-execution memory cap, so nothing else stands
      // between a print-loop and the whole Cloud Run instance. The pipes are still drained, just
      // not stored: stopping the reads would block the child instead.
      const cap = limits.maxOutputChars;
      let stdout = "";
      let stderr = "";
      let stdoutDropped = 0;
      let stderrDropped = 0;

      child.stdout.on("data", (c: Buffer) => {
        const chunk = c.toString();
        const room = Math.max(0, cap - stdout.length);
        if (room > 0) stdout += chunk.slice(0, room);
        stdoutDropped += chunk.length - Math.min(room, chunk.length);
      });
      child.stderr.on("data", (c: Buffer) => {
        const chunk = c.toString();
        const room = Math.max(0, cap - stderr.length);
        if (room > 0) stderr += chunk.slice(0, room);
        stderrDropped += chunk.length - Math.min(room, chunk.length);
      });

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: rendered(stdout, stdoutDropped),
          stderr: rendered(stderr, stderrDropped),
          exitCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          timedOut,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL to the whole GROUP: the payload is untrusted and under no obligation to handle
        // a signal politely, and the interpreter is a grandchild.
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {
          child.kill("SIGKILL"); // already gone
        }
      }, limits.timeoutSeconds * 1000);

      child.on("error", (err) => {
        // The CLI is missing or not executable — infrastructure, not a program failure. Reported
        // as a result rather than a rejection so the base contract holds, but logged at error
        // level: it means the service was deployed without --sandbox-launcher.
        log.error("sandbox CLI could not be spawned", { err, cli: this.cliPath });
        stderr = `${stderr}\nsandbox CLI unavailable at ${this.cliPath}`;
        finish(126);
      });

      // 'exit', not 'close': exit fires when the process ends, close waits for every pipe to
      // drain — including one a killed grandchild may still hold. Give the streams a bounded
      // moment to flush, the same shape as dockerBackend's Promise.race([streamEnded, delay]).
      child.on("exit", (code) => {
        // Disarm FIRST. The 200ms flush below is a window in which the deadline could otherwise
        // still fire, flip timedOut, and turn a run that finished successfully a few milliseconds
        // early into a reported timeout with exit 124.
        clearTimeout(timer);
        const exitCode = timedOut ? 124 : (code ?? 1);
        const flush = setTimeout(() => finish(exitCode), 200);
        flush.unref?.();
      });
    });
  }
}
