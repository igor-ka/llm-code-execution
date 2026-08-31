# Escaped defects

One line per defect that reached `main`, naming **the gate that should have caught it and did
not**. This is the calibration loop for ADR 0006 (`docs/adr/0006-trusting-ai-written-tests.md`): it
is the only evidence that trust in this suite is rising rather than holding still. Ten lines say
more than any score; one line says nothing.

**What belongs here:** a defect that got past the gates and onto `main`, whether it was then found
in review, in production, or by accident. A defect caught *before* merge does not belong — the
gates worked.

**Append, never edit** an existing row's first three columns. `Fixed` may be filled in later, since
a defect is often recorded before its remediation ships; leave it `—` until then. Every row cites a
commit or issue so the claim can be checked rather than taken on trust.

| Found | Defect | Gate that should have caught it | How it surfaced | Fixed |
| --- | --- | --- | --- | --- |
| 2026-08-10 | The Content-Security-Policy was attached only by the Vite dev and preview servers, so a static deploy of `dist/` shipped with **no CSP at all** | The frontend unit tests on the policy builder — they asserted the policy's content and could not see that no server sent it | Review | [`7ccd6dc`](https://github.com/igor-ka/llm-code-execution/commit/7ccd6dc) (#113) — `frontend/verify.sh build` now asserts `dist/csp.txt` exists and carries a production `script-src` |
| 2026-08-17 | Negated image assertions (`! grep -q …`) silently passed on a bad image — POSIX exempts a command negated with `!` from `set -e`, so the negation never aborted | The `package` target's own in-image assertions | Review | [`8772f8e`](https://github.com/igor-ka/llm-code-execution/commit/8772f8e) — rewritten as `if …; then exit 1; fi`, and the negative build now checks *why* it failed |
| 2026-08-17 | A bare `python3` in an image assertion resolved on `PATH` and proved nothing about the sandbox, which runs with `PATH` empty — [#185](https://github.com/igor-ka/llm-code-execution/issues/185) reached production green | The production-image assertion battery | Production | [`cd892ac`](https://github.com/igor-ka/llm-code-execution/commit/cd892ac) (#186) — the assertion now uses the absolute `/usr/bin/python3` and imports numpy |
| 2026-08-16 | `npm audit` honours `npm_config_offline` and `npm_config_omit` / `NODE_ENV=production`, so the audit gate had two environment-driven bypasses that both failed **open** | The `Audit` step itself | Review | [`8d3d0be`](https://github.com/igor-ka/llm-code-execution/commit/8d3d0be), [`71871cb`](https://github.com/igor-ka/llm-code-execution/commit/71871cb) — `--no-offline --include=dev` state the intent explicitly rather than inheriting the environment |

**Read the *How it surfaced* column.** Every entry so far says Review or Production — none says
"a gate caught it". That is the pattern this log exists to make countable, and the number to watch
is how often that column starts saying something else.
