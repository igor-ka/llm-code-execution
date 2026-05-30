"""Docker-based sandbox backend.

Each execution runs in a throwaway, heavily-restricted container:
  - no network (network_mode="none")
  - capped memory (+ no swap), CPU, and PIDs
  - read-only root filesystem with a small tmpfs at /sandbox for the code file
  - all Linux capabilities dropped + no-new-privileges
  - non-root user (baked into the image)
  - wall-clock timeout enforced here (the container is killed if it overruns)
  - auto-removed so nothing persists between runs

The code is passed via stdin to a tiny runner so we never mount host paths or rely on the
container filesystem being writable beyond the tmpfs.
"""
import time

import docker
from docker.errors import ContainerError, ImageNotFound

from app.sandbox.base import ExecutionLimits, SandboxBackend
from app.schemas import SandboxResult

# Map of supported languages -> how to run a single source file inside the sandbox image.
# Extending to new languages is a matter of adding an entry here (and to the image).
_LANG_RUNNERS = {
    "python": {
        "filename": "code.py",
        "cmd": ["python", "-I", "-B", "/sandbox/code.py"],
    },
}

_WORKDIR = "/sandbox"


class DockerBackend(SandboxBackend):
    def __init__(self, image: str):
        self._image = image
        self._client = docker.from_env()

    def execute(self, code: str, language: str, limits: ExecutionLimits) -> SandboxResult:
        runner = _LANG_RUNNERS.get(language)
        if runner is None:
            return SandboxResult(
                stdout="",
                stderr=f"Unsupported language: {language!r}",
                exit_code=2,
                duration_ms=0,
                timed_out=False,
            )

        # The container writes the provided code to the tmpfs and executes it. Using a
        # shell heredoc avoids mounting any host path into the untrusted container.
        bootstrap = (
            f"cat > {_WORKDIR}/{runner['filename']} <<'__LLM_EOF__'\n"
            f"{code}\n"
            "__LLM_EOF__\n"
            "exec " + " ".join(runner["cmd"])
        )

        container = None
        started = time.monotonic()
        timed_out = False
        try:
            container = self._client.containers.run(
                self._image,
                command=["sh", "-c", bootstrap],
                detach=True,
                # --- isolation / hardening ---
                network_mode="none",
                mem_limit=f"{limits.memory_mb}m",
                memswap_limit=f"{limits.memory_mb}m",  # == mem_limit disables swap
                nano_cpus=int(limits.cpus * 1_000_000_000),
                pids_limit=limits.pids_limit,
                read_only=True,
                # Writable, ephemeral scratch space: /sandbox holds the code file,
                # /tmp is general scratch (the system prompt promises code a writable /tmp).
                # Everything else stays read-only.
                tmpfs={_WORKDIR: "rw,size=8m,mode=1777", "/tmp": "rw,size=16m,mode=1777"},
                cap_drop=["ALL"],
                security_opt=["no-new-privileges"],
                user="1000:1000",
                working_dir=_WORKDIR,
                # Keep stdout/stderr separate so we can report them distinctly.
                stdout=True,
                stderr=True,
            )

            try:
                result = container.wait(timeout=limits.timeout_seconds)
                exit_code = int(result.get("StatusCode", -1))
            except Exception:
                # Timed out (or daemon hiccup): force-kill and report a timeout.
                timed_out = True
                exit_code = 124
                try:
                    container.kill()
                except Exception:
                    pass

            duration_ms = int((time.monotonic() - started) * 1000)

            stdout = container.logs(stdout=True, stderr=False).decode("utf-8", "replace")
            stderr = container.logs(stdout=False, stderr=True).decode("utf-8", "replace")
            if timed_out:
                stderr = (
                    stderr + f"\n[sandbox] killed after {limits.timeout_seconds}s timeout"
                ).strip()

            return SandboxResult(
                stdout=_truncate(stdout, limits.max_output_chars),
                stderr=_truncate(stderr, limits.max_output_chars),
                exit_code=exit_code,
                duration_ms=duration_ms,
                timed_out=timed_out,
            )
        except ImageNotFound:
            return SandboxResult(
                stdout="",
                stderr=(
                    f"[sandbox] image {self._image!r} not found. Build it first: "
                    "`docker build -t llm-sandbox:latest backend/sandbox-image`."
                ),
                exit_code=1,
                duration_ms=int((time.monotonic() - started) * 1000),
                timed_out=False,
            )
        except ContainerError as exc:  # non-zero exit with combined output
            return SandboxResult(
                stdout="",
                stderr=_truncate(str(exc), limits.max_output_chars),
                exit_code=exc.exit_status,
                duration_ms=int((time.monotonic() - started) * 1000),
                timed_out=False,
            )
        finally:
            if container is not None:
                try:
                    container.remove(force=True)  # ensure --rm semantics even on timeout
                except Exception:
                    pass


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…[truncated, {len(text) - limit} more chars]"
