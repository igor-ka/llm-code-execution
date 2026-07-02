/**
 * LLM service: a single structured Claude call that BOTH judges whether code generation
 * is appropriate AND generates the code if it is (port of llm.py).
 *
 * We force one tool call (emit_decision) so the model always returns the exact
 * {should_execute, language, code, message} shape — no free-text parsing. The large,
 * static system prompt is marked with cache_control so it is served from Anthropic's
 * prompt cache across requests.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { GenerationResult } from "./schemas.js";

// Languages we can actually execute in the sandbox today. Kept in sync with the
// runners in sandbox/dockerBackend.ts.
const SUPPORTED_LANGUAGES = ["python"] as const;

const SYSTEM_PROMPT = `You are a code-generation assistant for a sandboxed execution service.

For each user prompt you must decide whether generating runnable code is the right
response, then call the \`emit_decision\` tool exactly once with your decision.

Generate code (should_execute = true) when the prompt describes a programming task,
a computation, data manipulation, an algorithm, or anything best answered by running
code. Produce a single self-contained program that prints its results to stdout.

Do NOT generate code (should_execute = false) when the prompt is conversational,
a general-knowledge question, a request for an opinion, or otherwise not something a
short program should answer. In that case, leave code/language empty and put a short,
friendly explanation in \`message\` telling the user that this request doesn't call for
code execution and inviting them to rephrase as a coding/computation task.

Constraints on generated code:
- Only these languages may be used: ${SUPPORTED_LANGUAGES.join(", ")}.
- The code runs in a locked-down sandbox with NO network access, a read-only
  filesystem (except a small /tmp), strict CPU/memory/time limits, and no ability to
  install packages. Only the Python standard library plus numpy are available.
- The program must be self-contained, require no input, and print its output.
- Never include explanations or markdown fences in the \`code\` field — just the source.
`;

// Forced-tool schema: the single source of truth for the response shape.
const DECISION_TOOL: Anthropic.Tool = {
  name: "emit_decision",
  description: "Emit the decision about whether to generate code, and the code if so.",
  input_schema: {
    type: "object",
    properties: {
      should_execute: {
        type: "boolean",
        description: "True if code should be generated and executed for this prompt.",
      },
      language: {
        type: "string",
        enum: [...SUPPORTED_LANGUAGES],
        description:
          "Programming language of the generated code (only when should_execute is true).",
      },
      code: {
        type: "string",
        description:
          "Self-contained source code that prints its result (only when should_execute is true).",
      },
      message: {
        type: "string",
        description: "Friendly explanation shown to the user when should_execute is false.",
      },
    },
    required: ["should_execute"],
  },
};

const DecisionInput = z.object({
  should_execute: z.boolean().default(false),
  language: z.string().nullish(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

export class LLMService {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
    this.model = model;
  }

  async generate(prompt: string): Promise<GenerationResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "emit_decision" },
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "emit_decision",
    );
    if (!block) {
      throw new Error("Model did not return the expected emit_decision tool call");
    }
    const d = DecisionInput.parse(block.input);
    return {
      shouldExecute: d.should_execute,
      language: d.language ?? null,
      code: d.code ?? null,
      message: d.message ?? null,
    };
  }
}
