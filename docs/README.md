# Documentation

| Path | Holds | Written when | Mutable? |
| --- | --- | --- | --- |
| [`sdlc.md`](sdlc.md) | The **shared** process — phases, gates, how they meet CI | Never here | **No** — carried byte-identical from [`acb`](https://github.com/igor-ka/acb); send changes with `acb propose` |
| [`sdlc-local.md`](sdlc-local.md) | This repository's half — components, watched paths, the gates only we have | A local process change | Yes — and **required** by the `SDLC docs` CI job |
| [`sdlc-example.md`](sdlc-example.md) | One real feature walked through all seven phases | When the worked example goes stale | Yes |
| [`testing-notes.md`](testing-notes.md) | Testing traps, and where an oracle may come from | A trap needs more than a table row in `CLAUDE.md` | Yes |
| [`adr/`](adr) | **Decisions.** Why an approach was chosen and what was rejected | A choice would be expensive to reverse | **No** — supersede, never edit or delete |
| [`specs/`](specs) | **Problems.** Objective, boundaries, success criteria, open questions | Requirements are unclear enough that building the wrong thing is the risk | Rarely — it records what was agreed |
| [`plans/`](plans) | **Solutions.** Ordered, bite-sized implementation steps | Before writing code for anything multi-step | Superseded by the next plan |
| [`design/`](design) | Design notes and retrospectives for work already built or retired | After the fact, to preserve learning | Yes |
| [`runbooks/`](runbooks) | Step-by-step procedures a human executes on demand | A task will be repeated and is easy to get wrong | Yes |
| [`escaped-defects.md`](escaped-defects.md) | **Calibration.** Every defect that reached `main` and the gate that missed it | After any defect reaches `main` | Append-only — never edit an entry |

## Which one am I writing?

```
Recording a decision and its alternatives?      → adr/      (numbered, permanent)
Defining what to build and what's out of scope? → specs/    (only if open questions exist)
Breaking agreed work into steps?                → plans/
Explaining how something already built works?   → design/
Writing instructions someone will follow later? → runbooks/
Changing how we work?                           → sdlc-local.md (never sdlc.md — it is carried)
Recording a defect a gate should have caught?    → escaped-defects.md
```

## Conventions

- **ADRs**: `adr/NNNN-kebab-title.md`, continuing the existing sequence. Status is
  `Proposed` / `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`. A superseded ADR stays — it
  is the historical record.
- **Specs and plans**: `YYYY-MM-DD-kebab-title.md`. The date is when it was written, not when
  the work lands. A spec and its plan share a name.
- **Everything here is versioned with the code it describes.** Issues link to these documents;
  they never contain them. Design pasted into an issue comment is design you will lose.
