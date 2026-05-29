"""Sandbox backend abstraction.

This interface is the seam that keeps the app honest about its GCP future: locally we run
`DockerBackend`, but a `CloudRunBackend` (Cloud Run Jobs / microVM) or a gVisor-backed GKE
runner implements the exact same `execute()` contract with no changes to callers.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.schemas import SandboxResult


@dataclass(frozen=True)
class ExecutionLimits:
    timeout_seconds: int
    memory_mb: int
    cpus: float
    pids_limit: int
    max_output_chars: int


class SandboxBackend(ABC):
    """Runs untrusted code in an isolated environment and returns captured output."""

    @abstractmethod
    def execute(self, code: str, language: str, limits: ExecutionLimits) -> SandboxResult:
        """Execute `code` for `language`, enforcing `limits`. Must never raise on
        ordinary program failure (non-zero exit, stderr, timeout) — those are reported
        in the returned SandboxResult. Raise only on infrastructure errors."""
        raise NotImplementedError
