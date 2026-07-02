import { describe, it, expect } from "vitest";
import { ExecuteRequest, messageResponse, resultResponse } from "../src/schemas.js";

describe("ExecuteRequest", () => {
  it("accepts a 1..8000 char prompt", () => {
    expect(ExecuteRequest.safeParse({ prompt: "hi" }).success).toBe(true);
  });
  it("rejects an empty prompt", () => {
    expect(ExecuteRequest.safeParse({ prompt: "" }).success).toBe(false);
  });
  it("rejects a prompt over 8000 chars", () => {
    expect(ExecuteRequest.safeParse({ prompt: "x".repeat(8001) }).success).toBe(false);
  });
});

describe("response builders emit the exact snake_case wire shape", () => {
  it("messageResponse", () => {
    expect(messageResponse("nope")).toEqual({ type: "message", message: "nope" });
  });
  it("resultResponse", () => {
    const wire = resultResponse("python", "print('x')", {
      stdout: "x\n",
      stderr: "",
      exitCode: 0,
      durationMs: 42,
      timedOut: false,
    });
    expect(wire).toEqual({
      type: "result",
      language: "python",
      code: "print('x')",
      stdout: "x\n",
      stderr: "",
      exit_code: 0,
      duration_ms: 42,
      timed_out: false,
    });
  });
});
