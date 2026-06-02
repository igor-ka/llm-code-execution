"""Application configuration, loaded from environment / .env.

Centralizing limits here is deliberate: it is the seam where per-tenant overrides will
later plug in (e.g. resolve a Settings variant from tenant_id) without touching call sites.
"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM
    anthropic_api_key: str = ""
    llm_model: str = "claude-sonnet-4-6"

    # Sandbox execution limits (per run)
    sandbox_image: str = "llm-sandbox:latest"
    sandbox_timeout_seconds: int = 10
    sandbox_memory_mb: int = 256
    sandbox_cpus: float = 0.5
    sandbox_pids_limit: int = 64
    sandbox_max_output_chars: int = 20_000

    # CORS
    frontend_origin: str = "http://localhost:5173"

    # Auth (OIDC bearer-token validation on protected endpoints).
    # Off by default so the app stays usable before the frontend sends tokens;
    # flip auth_required=True once login is wired (see issue #6 / epic #9).
    auth_required: bool = False
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_url: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
