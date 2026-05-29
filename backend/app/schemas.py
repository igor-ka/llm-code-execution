"""Pydantic models for the API and internal data flow."""
from typing import Literal, Optional

from pydantic import BaseModel, Field


# --- API request ---
class ExecuteRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)
    # Enterprise seams: threaded through but unused in this phase. They let us add
    # per-tenant config / per-user quotas later without changing the request shape.
    tenant_id: Optional[str] = None
    user_id: Optional[str] = None


# --- Internal: result of the single structured Claude call ---
class GenerationResult(BaseModel):
    should_execute: bool
    language: Optional[str] = None
    code: Optional[str] = None
    message: Optional[str] = None


# --- Internal: result of running code in a sandbox ---
class SandboxResult(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    timed_out: bool


# --- API responses (discriminated by `type`) ---
class MessageResponse(BaseModel):
    """Returned when code generation does not make sense for the prompt."""

    type: Literal["message"] = "message"
    message: str


class ResultResponse(BaseModel):
    """Returned when code was generated and executed in the sandbox."""

    type: Literal["result"] = "result"
    language: str
    code: str
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    timed_out: bool
