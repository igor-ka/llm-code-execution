import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudRunSandboxBackend } from "../../src/sandbox/cloudRunSandbox.js";

const limits = {
  timeoutSeconds: 2,
  memoryMb: 256,
  cpus: 0.5,
  pidsLimit: 64,
  maxOutputChars: 100,
};

// A fake `sandbox` binary. The real one is injected by Cloud Run and cannot exist locally, so what
// is under test is what this class does WITH the CLI, not the CLI itself. spawn() without a shell
// resolves via execvp, which reads PATH — so putting the fake first is enough.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-fake-"));
  const fake = join(dir, "sandbox");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" > "${dir}/args.txt"
case "$*" in
  *EXIT_NONZERO*) echo "boom" >&2; exit 3 ;;
  *HANG*)         sleep 30 ;;
  *FLOOD*)        for i in $(seq 1 500); do printf 'x'; done ;;
  *DELUGE*)       for i in $(seq 1 4000); do printf '%0.sx' $(seq 1 100); done ;;
  *)              echo "hello from the sandbox" ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CloudRunSandboxBackend", () => {
  it("runs code and returns stdout with exit code 0", async () => {
    const result = await new CloudRunSandboxBackend("sandbox").execute(
      "print('hi')",
      "python",
      limits,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from the sandbox");
    expect(result.timedOut).toBe(false);
  });

  it("never passes --allow-egress: deny-by-default is the whole point", async () => {
    await new CloudRunSandboxBackend("sandbox").execute("print('hi')", "python", limits);

    const args = readFileSync(join(dir, "args.txt"), "utf8");
    expect(args).not.toContain("--allow-egress");
    expect(args).toContain("--write"); // the tmpfs overlay the code writes into
  });

  it("spawns the interpreter by ABSOLUTE path, because the sandbox PATH is empty", async () => {
    // Regression for #185. The sandbox inherits no environment, so PATH is [] and a bare
    // `python3` fails with "no such file or directory" — on the deployed service only, and only
    // once code actually runs.
    await new CloudRunSandboxBackend("sandbox").execute("print('hi')", "python", limits);

    const args = readFileSync(join(dir, "args.txt"), "utf8");
    expect(args).toContain("/usr/bin/python3");
    expect(args).not.toMatch(/(^|\s)python3(\s|$)/);
  });

  it("reports a non-zero exit without rejecting", async () => {
    const result = await new CloudRunSandboxBackend("sandbox").execute(
      "EXIT_NONZERO",
      "python",
      limits,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("kills a run that outlives the timeout and says so", async () => {
    const result = await new CloudRunSandboxBackend("sandbox").execute("HANG", "python", limits);

    expect(result.timedOut).toBe(true);
  });

  it("returns within the timeout rather than waiting for the payload", async () => {
    // The regression this guards: killing only the CLI leaves the interpreter holding the stdio
    // pipes, `close` never fires, and execute() hangs for the payload's full runtime — so the
    // timeout bounds nothing and the concurrency slot is never released. After D7 removes the
    // per-execution caps, those two are the only controls left.
    const started = Date.now();

    await new CloudRunSandboxBackend("sandbox").execute("HANG", "python", limits);

    expect(Date.now() - started).toBeLessThan(limits.timeoutSeconds * 1000 + 1000);
  });

  it("truncates output past maxOutputChars", async () => {
    const result = await new CloudRunSandboxBackend("sandbox").execute("FLOOD", "python", limits);

    expect(result.stdout.length).toBeLessThan(300);
    expect(result.stdout).toContain("truncated");
  });

  it("retains only maxOutputChars while a payload floods stdout", async () => {
    // Bounding what is REPORTED is not enough. Accumulating everything and truncating at the end
    // lets a print-loop stream hundreds of KB into this process before the timeout fires, and D7
    // removes the per-execution memory cap — nothing else stands between that and the instance.
    const result = await new CloudRunSandboxBackend("sandbox").execute("DELUGE", "python", limits);

    // ~400_000 chars produced; the retained string must stay near the cap, not near the volume.
    expect(result.stdout.length).toBeLessThan(limits.maxOutputChars + 100);
    expect(result.stdout).toContain("truncated");
  });

  it("does not report a timeout for a run that finished just before the deadline", async () => {
    // The exit handler used to leave the deadline armed during its flush window, so a run that
    // completed a few milliseconds early could still be flipped to timedOut and exit 124.
    const result = await new CloudRunSandboxBackend("sandbox").execute("print(1)", "python", {
      ...limits,
      timeoutSeconds: 1,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("rejects an unsupported language without spawning anything", async () => {
    const result = await new CloudRunSandboxBackend("sandbox").execute("puts 1", "ruby", limits);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unsupported language");
  });

  it("defaults to the path Cloud Run injects the CLI at", () => {
    // server.ts constructs this with no argument, so the default is the only value production
    // ever uses and no other test would notice a typo in it.
    expect(new CloudRunSandboxBackend().cliPath).toBe("/usr/local/gcp/bin/sandbox");
  });

  it("reports a missing CLI as an infrastructure fault, not a program failure", async () => {
    const result = await new CloudRunSandboxBackend("/nonexistent/sandbox").execute(
      "print('hi')",
      "python",
      limits,
    );

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("sandbox CLI unavailable");
  });
});
