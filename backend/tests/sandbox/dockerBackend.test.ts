/**
 * The "image not found" path is the one place the backend tells a human what to run. With
 * per-slot tags (llm-sandbox:slot1, …) a hardcoded `llm-sandbox:latest` in that sentence sends
 * them to build an image the backend will never look for — and the symptom, an execution that
 * keeps failing after you "built the image", gives no hint why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createContainer = vi.fn();

vi.mock("dockerode", () => ({
  default: class {
    createContainer = createContainer;
    modem = { demuxStream: vi.fn() };
  },
}));

const { DockerBackend } = await import("../../src/sandbox/dockerBackend.js");

describe("DockerBackend: image not found", () => {
  beforeEach(() => {
    createContainer.mockReset();
    createContainer.mockRejectedValue(
      Object.assign(new Error("no such image"), { statusCode: 404 }),
    );
  });

  const limits = {
    timeoutSeconds: 5,
    memoryMb: 256,
    cpus: 0.5,
    pidsLimit: 64,
    maxOutputChars: 20000,
  };

  it("names the image it actually looked for, in both halves of the message", async () => {
    const result = await new DockerBackend("llm-sandbox:slot2").execute(
      "print(1)",
      "python",
      limits,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("image 'llm-sandbox:slot2' not found");
    // The remediation must build the SAME tag, not a hardcoded one.
    expect(result.stderr).toContain("docker build -t llm-sandbox:slot2 backend/sandbox-image");
    expect(result.stderr).not.toContain("llm-sandbox:latest");
  });
});
