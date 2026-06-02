"""FastAPI entrypoint wiring the prompt -> judge -> generate -> sandbox -> result flow."""
import logging
from functools import lru_cache

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.auth import Principal, require_principal
from app.config import Settings, get_settings
from app.llm import LLMService
from app.sandbox.base import ExecutionLimits
from app.sandbox.docker_backend import DockerBackend
from app.schemas import ExecuteRequest, MessageResponse, ResultResponse

logger = logging.getLogger("llm_code_execution")

app = FastAPI(title="LLM Code Execution")

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_settings.frontend_origin],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Lazily constructed singletons so the app can boot (and serve /api/health) even
# before ANTHROPIC_API_KEY / Docker are configured.
@lru_cache
def _llm() -> LLMService:
    s = get_settings()
    if not s.anthropic_api_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not configured")
    return LLMService(api_key=s.anthropic_api_key, model=s.llm_model)


@lru_cache
def _sandbox() -> DockerBackend:
    return DockerBackend(image=get_settings().sandbox_image)


def _limits(s: Settings) -> ExecutionLimits:
    return ExecutionLimits(
        timeout_seconds=s.sandbox_timeout_seconds,
        memory_mb=s.sandbox_memory_mb,
        cpus=s.sandbox_cpus,
        pids_limit=s.sandbox_pids_limit,
        max_output_chars=s.sandbox_max_output_chars,
    )


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/execute", response_model=None)
def execute(req: ExecuteRequest, principal: Principal = Depends(require_principal)):
    """Judge the prompt, generate code if appropriate, run it in the sandbox.

    `require_principal` enforces auth before we reach this body (401/403 on failure) and
    yields the verified caller. When auth is disabled it yields an anonymous principal.
    """
    settings = get_settings()

    try:
        generation = _llm().generate(req.prompt)
    except HTTPException:
        raise
    except Exception as exc:  # surface LLM/transport errors as 502
        logger.exception("LLM generation failed")
        raise HTTPException(status_code=502, detail=f"Code generation failed: {exc}") from exc

    # The prompt doesn't warrant code -> return the friendly message, run nothing.
    if not generation.should_execute:
        return MessageResponse(
            message=generation.message
            or "This request doesn't look like something I should write and run code for."
        )

    if not generation.code or not generation.language:
        raise HTTPException(status_code=502, detail="Model chose to execute but returned no code")

    result = _sandbox().execute(generation.code, generation.language, _limits(settings))
    return ResultResponse(
        language=generation.language,
        code=generation.code,
        stdout=result.stdout,
        stderr=result.stderr,
        exit_code=result.exit_code,
        duration_ms=result.duration_ms,
        timed_out=result.timed_out,
    )
