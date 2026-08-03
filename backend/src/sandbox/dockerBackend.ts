/**
 * Docker-based sandbox backend (port of docker_backend.py). Each execution runs in a
 * throwaway, heavily-restricted container:
 *   - no network (NetworkMode "none")
 *   - capped memory (+ no swap), CPU, and PIDs
 *   - read-only root filesystem with small tmpfs at /sandbox (code file) and /tmp
 *   - all Linux capabilities dropped + no-new-privileges
 *   - non-root user (baked into the image; also enforced here)
 *   - wall-clock timeout enforced here (the container is killed if it overruns)
 *   - force-removed so nothing persists between runs (--rm semantics)
 *
 * The code is passed via stdin to a tiny shell runner so we never mount host paths or
 * rely on the container filesystem being writable beyond the tmpfs.
 */
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { SandboxBackend, ExecutionLimits } from "./base.js";
import type { SandboxResult } from "../schemas.js";

const LANG_RUNNERS: Record<string, { filename: string; cmd: string[] }> = {
  python: { filename: "code.py", cmd: ["python", "-I", "-B", "/sandbox/code.py"] },
};
const WORKDIR = "/sandbox";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const elapsedMs = (start: bigint) => Number((process.hrtime.bigint() - start) / 1_000_000n);

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated, ${text.length - limit} more chars]`;
}

export class DockerBackend implements SandboxBackend {
  private readonly docker: Docker;

  constructor(private readonly image: string) {
    this.docker = new Docker(); // defaults to /var/run/docker.sock
  }

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

    // The container writes the provided code to the tmpfs and executes it. A shell
    // heredoc avoids mounting any host path into the untrusted container.
    const bootstrap =
      `cat > ${WORKDIR}/${runner.filename} <<'__LLM_EOF__'\n` +
      `${code}\n` +
      `__LLM_EOF__\n` +
      `exec ${runner.cmd.join(" ")}`;

    const started = process.hrtime.bigint();
    let container: Docker.Container | undefined;
    let timedOut = false;

    try {
      container = await this.docker.createContainer({
        Image: this.image,
        Cmd: ["sh", "-c", bootstrap],
        Tty: false,
        WorkingDir: WORKDIR,
        User: "1000:1000",
        HostConfig: {
          NetworkMode: "none",
          Memory: limits.memoryMb * 1024 * 1024,
          MemorySwap: limits.memoryMb * 1024 * 1024, // == Memory disables swap
          NanoCpus: Math.round(limits.cpus * 1_000_000_000),
          PidsLimit: limits.pidsLimit,
          ReadonlyRootfs: true,
          Tmpfs: {
            [WORKDIR]: "rw,size=8m,mode=1777",
            "/tmp": "rw,size=16m,mode=1777",
          },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          // Note: AutoRemove intentionally NOT set — we force-remove in finally so we
          // can reliably read logs and enforce the timeout kill first (== Python --rm).
        },
      });

      // Attach BEFORE start so no early output is lost; demux into two buffers.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const outStream = new PassThrough();
      const errStream = new PassThrough();
      outStream.on("data", (c: Buffer) => stdoutChunks.push(c));
      errStream.on("data", (c: Buffer) => stderrChunks.push(c));
      const attach = await container.attach({ stream: true, stdout: true, stderr: true });
      this.docker.modem.demuxStream(attach, outStream, errStream);
      const streamEnded = new Promise<void>((resolve) => {
        attach.on("end", () => resolve());
        attach.on("close", () => resolve());
        attach.on("error", () => resolve());
      });

      await container.start();

      const waitPromise = container.wait();
      const timeoutMs = limits.timeoutSeconds * 1000;
      // Cancelable timer: clear it when wait wins so we don't leave a live ref'd
      // setTimeout per execution (they'd accumulate for the full timeout under load).
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ kind: "timeout" as const }), timeoutMs);
      });
      let outcome: { kind: "done"; code: number } | { kind: "timeout" };
      try {
        outcome = await Promise.race([
          waitPromise.then((r) => ({ kind: "done" as const, code: Number(r?.StatusCode ?? -1) })),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      let exitCode: number;
      if (outcome.kind === "timeout") {
        timedOut = true;
        exitCode = 124;
        await container.kill().catch(() => {});
        await waitPromise.catch(() => {}); // let wait settle after the kill
      } else {
        exitCode = outcome.code;
      }

      // Bounded flush of the attach stream so buffered output lands.
      await Promise.race([streamEnded, delay(500)]);

      const durationMs = elapsedMs(started);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        stderr = `${stderr}\n[sandbox] killed after ${limits.timeoutSeconds}s timeout`.trim();
      }

      return {
        stdout: truncate(stdout, limits.maxOutputChars),
        stderr: truncate(stderr, limits.maxOutputChars),
        exitCode,
        durationMs,
        timedOut,
      };
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e?.statusCode === 404) {
        return {
          stdout: "",
          stderr:
            `[sandbox] image '${this.image}' not found. Build it first: ` +
            "`docker build -t llm-sandbox:latest backend/sandbox-image`.",
          exitCode: 1,
          durationMs: elapsedMs(started),
          timedOut: false,
        };
      }
      return {
        stdout: "",
        stderr: truncate(String(e?.message ?? err), limits.maxOutputChars),
        exitCode: 1,
        durationMs: elapsedMs(started),
        timedOut: false,
      };
    } finally {
      if (container) {
        await container.remove({ force: true }).catch(() => {}); // ensure --rm even on timeout
      }
    }
  }
}
