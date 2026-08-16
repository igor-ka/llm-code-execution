/**
 * The wiring test the unit tests cannot give you.
 *
 * config.test.ts proves the VALUE parses; cloudRunSandbox.test.ts proves the CLASS behaves.
 * Neither notices if server.ts stops consulting settings.sandboxBackend — every existing test
 * would stay green while production silently ran DockerBackend on a host with no Docker socket.
 *
 * This drives createApp() end to end and observes which backend answered, using the one signal
 * that distinguishes them without a live sandbox: CloudRunSandboxBackend reports a missing CLI as
 * exit 126 with "sandbox CLI unavailable", and DockerBackend never produces that string.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { loadSettings } from "../../src/config.js";
import type { LLMService } from "../../src/llm.js";

// One structured call that both judges and generates — the shape main.test.ts fakes.
const fakeLlm = {
  generate: async () => ({
    shouldExecute: true,
    language: "python",
    code: "print('hi')",
    message: null,
  }),
} as unknown as LLMService;

describe("sandbox backend selection through createApp", () => {
  it("routes execution to the Cloud Run backend when SANDBOX_BACKEND=cloudrun", async () => {
    const settings = loadSettings({
      SANDBOX_BACKEND: "cloudrun",
      AUTH_REQUIRED: "false",
      ANTHROPIC_API_KEY: "test",
    });

    const res = await request(createApp({ settings, llm: fakeLlm }))
      .post("/api/execute")
      .send({ prompt: "anything" });

    // The CLI does not exist off Cloud Run, and that is the point: only CloudRunSandboxBackend
    // fails this way. Reaching it at all proves server.ts honoured the setting.
    expect(res.status).toBe(200);
    expect(res.body.exit_code).toBe(126);
    expect(res.body.stderr).toContain("sandbox CLI unavailable");
  });
});
