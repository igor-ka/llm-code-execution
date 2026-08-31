# Escaped defects

One line per defect that reached `main`, naming **the gate that should have caught it and did
not**. This is the calibration loop for [ADR 0006](adr/0006-trusting-ai-written-tests.md): it is
the only evidence that trust in this suite is rising rather than holding still. Ten lines say more
than any score; one line says nothing.

Append, never edit. A defect belongs here whether it was found in review, in production, or by
accident — what matters is that a gate existed and stayed green.

| Date | Defect | Gate that should have caught it | What changed |
| --- | --- | --- | --- |
| 2026-08-14 | The Content-Security-Policy was attached only by the Vite dev and preview servers, so a static deploy of `dist/` shipped with **no CSP at all** | The frontend unit tests on the policy builder — they asserted the policy's content and could not see that no server sent it | `frontend/verify.sh build` now asserts `dist/csp.txt` exists and carries a production `script-src` |
| 2026-08-16 | Negated image assertions (`! grep -q …`) silently passed on a bad image — POSIX exempts a command negated with `!` from `set -e` | The `package` target's own in-image assertions | Rewritten as `if …; then exit 1; fi` in both `verify.sh` scripts |
| 2026-08-17 | A bare `python3` in an image assertion resolved on `PATH` and proved nothing about the sandbox, which runs with `PATH` empty — [#185](https://github.com/igor-ka/llm-code-execution/issues/185) reached production green | The production-image assertion battery | The assertion now uses the absolute `/usr/bin/python3` and imports numpy |
| 2026-08-18 | `npm audit` honours `npm_config_offline` and `npm_config_omit`/`NODE_ENV=production`, so the audit gate had two environment-driven bypasses that both failed **open** | The `Audit` step itself | `--no-offline --include=dev` state the intent explicitly rather than inheriting the environment |

Every entry above was found by **review**, not by the gate noticing. That is the pattern this log
exists to make visible.
