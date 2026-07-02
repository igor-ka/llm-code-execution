import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMService } from "../src/llm.js";

/** Build a fake Anthropic client whose messages.create returns a single emit_decision block. */
function serviceWith(payload: Record<string, unknown>): LLMService {
  const fake = {
    messages: {
      create: async () => ({
        content: [{ type: "tool_use", name: "emit_decision", input: payload }],
      }),
    },
  } as unknown as Anthropic;
  return new LLMService("", "test-model", fake);
}

describe("LLMService.generate", () => {
  it("maps the should_execute path", async () => {
    const svc = serviceWith({ should_execute: true, language: "python", code: "print('hi')" });
    const r = await svc.generate("print hello");
    expect(r.shouldExecute).toBe(true);
    expect(r.language).toBe("python");
    expect(r.code).toBe("print('hi')");
    expect(r.message).toBeNull();
  });

  it("maps the no-code path", async () => {
    const svc = serviceWith({ should_execute: false, message: "That's not a coding task." });
    const r = await svc.generate("tell me a joke");
    expect(r.shouldExecute).toBe(false);
    expect(r.code).toBeNull();
    expect(r.message).toBe("That's not a coding task.");
  });

  it("throws when no emit_decision tool block is returned", async () => {
    const fake = {
      messages: { create: async () => ({ content: [{ type: "text", text: "hello" }] }) },
    } as unknown as Anthropic;
    const svc = new LLMService("", "test-model", fake);
    await expect(svc.generate("anything")).rejects.toThrow();
  });
});
