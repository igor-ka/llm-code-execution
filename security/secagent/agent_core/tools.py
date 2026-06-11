"""Tool abstraction + the generic (domain-agnostic) tools every module reuses.

A `Tool` is an Anthropic tool-use schema plus a Python handler. Network tools go through
`LoopbackHTTP`, which **refuses any non-loopback host** — the agent can only ever touch the
local target under test.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from .report import AttemptLedger, FindingStore

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


class NonLoopbackTarget(ValueError):
    """Raised when a target base URL is not a loopback address."""


@dataclass
class Tool:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[..., str]

    def schema(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self, tools: Optional[List[Tool]] = None) -> None:
        self._tools: Dict[str, Tool] = {}
        for t in tools or []:
            self.add(t)

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def schemas(self) -> List[Dict[str, Any]]:
        return [t.schema() for t in self._tools.values()]

    def dispatch(self, name: str, payload: Dict[str, Any]) -> str:
        if name not in self._tools:
            return f"ERROR: unknown tool {name!r}"
        try:
            return self._tools[name].handler(**payload)
        except Exception as exc:  # surfaced to the model as a tool error, not a crash
            return f"ERROR: {type(exc).__name__}: {exc}"


class LoopbackHTTP:
    """HTTP client pinned to a single local target. Injectable for tests (ASGITransport).

    Two safety properties: (1) the base URL is fixed at construction and tools take only
    method+path, so the model can never redirect a request to another host; (2) the host
    must be loopback by default. An operator may add known-local hosts via
    `extra_allowed_hosts` (e.g. a compose service name) — this is an operator choice, never
    the model's.
    """

    def __init__(
        self,
        base_url: str,
        client: Optional[httpx.Client] = None,
        extra_allowed_hosts: Optional[set] = None,
    ) -> None:
        host = urlparse(base_url).hostname
        allowed = LOOPBACK_HOSTS | (extra_allowed_hosts or set())
        if host not in allowed:
            raise NonLoopbackTarget(
                f"refusing non-loopback target {host!r}; agent may only touch the local TUT"
            )
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(base_url=self.base_url, timeout=15.0)

    def request(
        self,
        method: str,
        path: str,
        token: Optional[str] = None,
        json_body: Optional[dict] = None,
    ) -> Dict[str, Any]:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        resp = self._client.request(method.upper(), path, headers=headers, json=json_body)
        try:
            body: Any = resp.json()
        except Exception:
            body = resp.text
        return {"status": resp.status_code, "body": body}


def _truncate(text: str, limit: int = 1500) -> str:
    return text if len(text) <= limit else text[:limit] + " …[truncated]"


class LogTail:
    """Read-only tail of the target's server log.

    White-box observability without the Docker socket: the target writes its logs to a file on
    a shared volume (see docker-compose.test.yml) and the agent only ever *reads* it. The agent
    gets no control over the target's host — just visibility into stack traces, leaked error
    detail, and which code path a request hit.
    """

    def __init__(self, path: str) -> None:
        self.path = path

    def tail(self, lines: int = 50) -> str:
        try:
            rows = Path(self.path).read_text().splitlines()
        except FileNotFoundError:
            return f"(no log file at {self.path})"
        return "\n".join(rows[-lines:]) if rows else "(log is empty)"


def make_generic_tools(
    http: LoopbackHTTP,
    findings: FindingStore,
    ledger: Optional[AttemptLedger] = None,
    logs: Optional[LogTail] = None,
    seed_ids: Optional[set] = None,
) -> List[Tool]:
    """Tools reusable by any capability module: probe an endpoint, record a finding,
    optionally note a tested hypothesis to durable memory (ledger), and read the target's
    server logs (logs). When `seed_ids` is given, note_attempt gains a validated `seed_id`
    parameter so baseline coverage can be tracked by identity (see the coverage gate)."""

    def call_endpoint(
        method: str, path: str, token: Optional[str] = None, body: Optional[dict] = None
    ) -> str:
        result = http.request(method, path, token=token, json_body=body)
        return _truncate(json.dumps(result))

    def record_finding(
        severity: str,
        title: str,
        hypothesis: str,
        repro: str,
        evidence: str,
        recommendation: str,
    ) -> str:
        findings.add(
            severity=severity,
            title=title,
            hypothesis=hypothesis,
            repro=repro,
            evidence=evidence,
            recommendation=recommendation,
        )
        return f"recorded [{severity}] {title!r} (total findings: {len(findings.findings)})"

    tools = [
        Tool(
            name="call_endpoint",
            description=(
                "Send an HTTP request to the local target under test and return "
                "{status, body}. Use this to PROVE a hypothesis against the live app."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "method": {"type": "string", "description": "HTTP method, e.g. POST"},
                    "path": {"type": "string", "description": "Path, e.g. /api/execute"},
                    "token": {
                        "type": "string",
                        "description": "Optional bearer token (omit to send none)",
                    },
                    "body": {"type": "object", "description": "Optional JSON request body"},
                },
                "required": ["method", "path"],
            },
            handler=call_endpoint,
        ),
        Tool(
            name="record_finding",
            description=(
                "Record a confirmed finding. Only call this after the hypothesis has "
                "reproduced against the live endpoint via call_endpoint."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["info", "low", "medium", "high", "critical"],
                    },
                    "title": {"type": "string"},
                    "hypothesis": {"type": "string"},
                    "repro": {"type": "string", "description": "Exact steps to reproduce"},
                    "evidence": {"type": "string", "description": "Observed response/behavior"},
                    "recommendation": {"type": "string"},
                },
                "required": [
                    "severity",
                    "title",
                    "hypothesis",
                    "repro",
                    "evidence",
                    "recommendation",
                ],
            },
            handler=record_finding,
        ),
    ]

    if ledger is not None:
        known = sorted(seed_ids) if seed_ids else []

        def note_attempt(
            hypothesis: str, outcome: str, seed_id: Optional[str] = None
        ) -> str:
            if seed_id and known and seed_id not in known:
                return f"ERROR: unknown seed_id {seed_id!r}; known ids: {known}"
            return ledger.add(hypothesis, outcome, seed_id=seed_id)

        properties: Dict[str, Any] = {
            "hypothesis": {"type": "string"},
            "outcome": {"type": "string"},
        }
        if known:
            properties["seed_id"] = {
                "type": "string",
                "enum": known,
                "description": (
                    "If this attempt addresses one of the seeded baseline hypotheses, its "
                    "id (so coverage is tracked by identity). Omit for derived hypotheses."
                ),
            }

        tools.append(
            Tool(
                name="note_attempt",
                description=(
                    "Record that you tested a hypothesis and what happened (e.g. 'rejected "
                    "with 401'). Call this after each test so you don't repeat work — the "
                    "ledger is kept even when older conversation is trimmed. Pass seed_id "
                    "when the attempt covers a seeded baseline hypothesis."
                ),
                input_schema={
                    "type": "object",
                    "properties": properties,
                    "required": ["hypothesis", "outcome"],
                },
                handler=note_attempt,
            )
        )

    if logs is not None:

        def read_backend_logs(lines: int = 50) -> str:
            n = max(1, min(int(lines), 500))
            return _truncate(logs.tail(n), 4000)

        tools.append(
            Tool(
                name="read_backend_logs",
                description=(
                    "Read the tail of the target backend's server logs (read-only). Use to "
                    "observe server-side behavior an HTTP response hides — stack traces, leaked "
                    "internal error detail, or which code path a request took."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "lines": {
                            "type": "integer",
                            "description": "How many trailing log lines to read (default 50).",
                        }
                    },
                    "required": [],
                },
                handler=read_backend_logs,
            )
        )

    return tools
