# Vendored skills — attribution

The `writing-plans/` and `receiving-code-review/` skills in this directory are
adapted from **claude-code-staff-engineer** by Fareed Khan
(https://github.com/FareedKhan-dev/claude-code-staff-engineer), used under the
MIT License. Only the plan-review and review-reception pieces were vendored;
the upstream SessionStart hook, the global "1% rule" handbook, and the
TDD/forensic/worktree/orchestration skills were intentionally **not** installed.
Cross-skill references to those uninstalled parts were removed so each skill
here stands alone.

The PR-level code review and security review referenced in `CLAUDE.md` use the
built-in `code-review` and `security-review` skills, not vendored code.

---

MIT License

Copyright (c) 2026 Fareed Khan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
