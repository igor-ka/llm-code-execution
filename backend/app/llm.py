"""LLM service: a single structured Claude call that BOTH judges whether code
generation is appropriate for the prompt AND generates the code if it is.

We force a single tool call (`emit_decision`) so the model always returns the
exact `{should_execute, language, code, message}` shape — no free-text parsing.
The large, static system prompt is marked with `cache_control` so it is served
from Anthropic's prompt cache across requests (see the claude-api skill).
"""
import anthropic

from app.schemas import GenerationResult

# Languages we can actually execute in the sandbox today. Kept in sync with the
# runners in app/sandbox/docker_backend.py.
_SUPPORTED_LANGUAGES = ["python"]

_SYSTEM_PROMPT = f"""You are a code-generation assistant for a sandboxed execution service.

For each user prompt you must decide whether generating runnable code is the right
response, then call the `emit_decision` tool exactly once with your decision.

Generate code (should_execute = true) when the prompt describes a programming task,
a computation, data manipulation, an algorithm, or anything best answered by running
code. Produce a single self-contained program that prints its results to stdout.

Do NOT generate code (should_execute = false) when the prompt is conversational,
a general-knowledge question, a request for an opinion, or otherwise not something a
short program should answer. In that case, leave code/language empty and put a short,
friendly explanation in `message` telling the user that this request doesn't call for
code execution and inviting them to rephrase as a coding/computation task.

Constraints on generated code:
- Only these languages may be used: {", ".join(_SUPPORTED_LANGUAGES)}.
- The code runs in a locked-down sandbox with NO network access, a read-only
  filesystem (except a small /tmp), strict CPU/memory/time limits, and no ability to
  install packages. Only the Python standard library plus numpy are available.
- The program must be self-contained, require no input, and print its output.
- Never include explanations or markdown fences in the `code` field — just the source.
"""

# Forced-tool schema: the single source of truth for the response shape.
_DECISION_TOOL = {
    "name": "emit_decision",
    "description": "Emit the decision about whether to generate code, and the code if so.",
    "input_schema": {
        "type": "object",
        "properties": {
            "should_execute": {
                "type": "boolean",
                "description": "True if code should be generated and executed for this prompt.",
            },
            "language": {
                "type": "string",
                "enum": _SUPPORTED_LANGUAGES,
                "description": "Programming language of the generated code (only when should_execute is true).",
            },
            "code": {
                "type": "string",
                "description": "Self-contained source code that prints its result (only when should_execute is true).",
            },
            "message": {
                "type": "string",
                "description": "Friendly explanation shown to the user when should_execute is false.",
            },
        },
        "required": ["should_execute"],
    },
}


class LLMService:
    def __init__(self, api_key: str, model: str):
        self._client = anthropic.Anthropic(api_key=api_key)
        self._model = model

    def generate(self, prompt: str) -> GenerationResult:
        """Run the single structured call and return a validated GenerationResult."""
        response = self._client.messages.create(
            model=self._model,
            max_tokens=4096,
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            tools=[_DECISION_TOOL],
            tool_choice={"type": "tool", "name": "emit_decision"},
            messages=[{"role": "user", "content": prompt}],
        )

        decision = _extract_tool_input(response)
        return GenerationResult(
            should_execute=bool(decision.get("should_execute", False)),
            language=decision.get("language"),
            code=decision.get("code"),
            message=decision.get("message"),
        )


def _extract_tool_input(response: anthropic.types.Message) -> dict:
    """Pull the forced tool_use block's input out of the response."""
    for block in response.content:
        if block.type == "tool_use" and block.name == "emit_decision":
            # SDK already parses tool input into a dict.
            return dict(block.input)
    # Forced tool_choice should guarantee a tool_use block; guard anyway.
    raise ValueError("Model did not return the expected emit_decision tool call")
