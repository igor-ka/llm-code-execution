# Strix vs. our auth agent — comparison record (2026-06-13, #24)

## Setup
- **Our agent:** hand-rolled ReAct loop; holds the mock IdP signing key + `mint_token`; seeded
  14-hypothesis checklist; focused on `POST /api/execute`. Real run: Sonnet. Mutant run: Haiku.
- **Strix 1.0.4:** OSS autonomous pentest agent; black-box; driven by **Haiku**
  (`anthropic/claude-haiku-4-5`), `quick` scan mode, non-interactive; given the *same* auth-focused
  instruction (endpoint, RS256/JWKS, required claims, "test expired tokens").
- **Target:** the test stack (mock OIDC + backend). Two variants: real `auth.py`, and a mutant
  with expiry verification disabled (`verify_exp=False`, ground-truth id `expiry-bypass`, HIGH).
  The mutant was deployed by bind-mounting a patched `auth.py` over the container — the repo's
  `auth.py` was never modified.
- **Cost:** Strix real $2.79, Strix mutant $3.05 (each ~2.7–2.9M input tokens — ~10× our agent);
  our agent on the mutant ~$0.30. Strix found **0** vulnerabilities in both runs.

## Results (ground-truth scored via `compare.py`)

| Target | Metric | Our agent | Strix |
|---|---|:--:|:--:|
| Mutant (`expiry_not_checked`), **no credential** | recall | **1.00** | 0.00 |
| | precision | 1.00 | 1.00 |
| Mutant, **credential leveled** (see below) | recall | **1.00** | **1.00** |
| | precision | 1.00 | 1.00 |
| Real `auth.py` | recall | 0.00 | 0.00 |
| | precision | 1.00 | 1.00 |

- Mutant (uncredentialed): only our agent found `expiry-bypass`.
- Real: both clean, zero false positives; both "missed" `empty-sub` (ours suppresses it by design
  per the bypass-only threat model; Strix concluded the gate holds).

See `compare-mutant.txt`, `compare-real.txt` for the full diffs.

## Why Strix missed the mutant — it is an ACCESS asymmetry, not a reasoning gap

Strix tested expiry thoroughly (expired 1s / 1hr / 1day / 1yr ago — see `strix-mutant.notes.json`)
but signed those tokens with its **own generated key**. They were rejected at the **signature**
check — one layer *before* the broken expiry check — so it never exercised the expiry path and
concluded *"expiration properly enforced — NO VULNERABILITY"*. Its report notes
*"JWKS Endpoint Not Found… app requires specific IdP signing keys."* Our agent holds the mock
IdP signing key (given to it precisely to test validation logic), minted a validly-signed token
with a past `exp`, reached the expiry check, and caught the bug.

### This is NOT mainly "white-box vs black-box." Three independent axes:
1. **Credential / key access (the decisive one here).** Our agent was handed the IdP *signing
   key* + `mint_token`. That is a **privileged test fixture**, not "white-box" — a real external
   attacker wouldn't have it either. It lets the tester reach validation logic *behind* the
   signature gate. Strix had no key, so it physically could not construct a validly-signed
   expired token.
2. **Task scope (specialist vs generalist).** Our agent is aimed at this one gate with a seeded
   checklist; Strix is a broad scanner that had to *discover* the JWKS (and failed to).
3. **Source visibility (the actual white/black-box axis).** Our agent *may* read `auth.py`;
   Strix may not. For THIS mutant it was irrelevant — the blocker was the key (axis 1), not
   source. A white-box reader with no key could *spot* the bug in code but still couldn't
   *exploit* it at runtime.

**Severity nuance:** an expiry-not-checked bug is only reachable by someone who can already
present a validly-signed token — e.g., a legitimate user replaying their *own* expired token.
That's a real bug, but its real-world exploitability is narrower than an unauthenticated bypass.

## Credential-leveled re-run (apples-to-apples) — the decisive test

We re-ran Strix on the same expiry mutant but **handed it the credential it lacked**: a
pre-minted, validly-signed *expired* token (minted by us with the mock IdP key), plus a narrow
"replay this token, report accept/reject" instruction. Result: Strix flipped **miss → catch**
— it reported the expiry bypass as CRITICAL (recall 1.00, precision 1.00; `compare-leveled.txt`,
`strix-leveled.*`). The narrow credentialed scope also cut cost from **~$3.05 → $0.17** (149K vs
2.9M input tokens), since it didn't have to crawl/discover.

**Conclusion: the gap was the credential, not tool quality.** Given equal credentials, both tools
find the bug. This is the apples-to-apples answer.

### Build-vs-buy takeaway
- For **validation-logic bugs reachable only with a minting credential** (expiry, audience,
  signature-internal): an off-the-shelf agent (Strix) is competitive *once you supply the
  credential* — and cheaper in a narrow scope. The custom agent's edge here is **integration**:
  it mints the tokens itself (no manual fixturing), works the seeded checklist automatically, and
  is ~10× cheaper per *broad* run.
- The honest case for the custom agent is therefore NOT "it finds bugs Strix can't" — it's:
  (1) it bakes in the privileged test fixture (key + `mint_token`) so validation-logic testing is
  push-button; (2) tight cost/scope control; (3) tailored reporting + a ground-truth eval; (4) the
  learning value of owning the loop. If those don't matter to you, a credentialed Strix covers the
  same class.
- Best of both: run Strix for **black-box breadth** and the custom agent for **push-button,
  credentialed validation depth** — they target different tiers.

## How to make the comparison fair / more informative (replan)
- **Level the credential axis per test.** For key-gated mutants (expiry, audience, signature),
  hand Strix the same starting material: a pre-minted *validly-signed expired* token to replay
  (clean), or the signing key itself (full symmetry). Then the result measures reasoning, not
  key access. (Costs another ~$3/Strix run — not yet done.)
- **Choose mutants by capability tier.** `auth_disabled` (no-token → 200) is black-box
  discoverable and would compare the tools symmetrically; expiry/audience are not, without
  leveling. Match the mutant to the capability being compared.
- **Compare within tiers.** Also run *our* agent in a no-key/black-box mode and compare that to
  Strix on equal footing; then show separately what the key fixture *adds*.
- **Always annotate capabilities** (source? key? credentials? scope) so a reader knows the
  controlled vs uncontrolled variables.

## How to evolve our agent given this
- **Make the capability tier explicit and configurable**, and run two passes:
  - *insider/validation mode* (has key + `mint_token`) — tests validation-logic correctness
    behind the signature gate (where it is uniquely strong);
  - *outsider/black-box mode* (no key; only tokens obtainable via the real login flow, or none)
    — tests what a true external attacker reaches.
- **Tag each finding with the capability required to exploit it**, and let real-world severity
  reflect that (key-gated correctness bug < unauthenticated bypass). This keeps findings honest
  and makes head-to-heads against black-box tools fair.
- **Treat Strix as complementary, not a competitor.** Generalist black-box breadth (Strix) and
  specialist key-privileged validation depth (ours) find different classes; a mature program
  runs both and scores each on the class it targets.

## Caveats
- **Strix schema (now confirmed via the leveled run):** a run that finds vulnerabilities writes
  `strix_runs/<run>/vulnerabilities.json` — a LIST of objects (`title, severity, description,
  impact, technical_analysis, poc_description, poc_script_code, remediation_steps, cvss, cwe,
  endpoint, method`) plus per-vuln markdown under `vulnerabilities/`. `run.json` is narrative-only
  (`scan_results`); a clean run has no `vulnerabilities.json` (→ `normalize_strix` yields `[]`,
  correct). Feed **`vulnerabilities.json`** to `compare.py`. The narrative must NOT be keyword-mined
  (it labels attacks *tested-and-safe* → false positives). `normalize_strix` was updated to this schema.
- Single mutant, `quick` mode, Haiku driver throughout. A `deep`-mode or stronger-model Strix run
  may differ — but the credential blocker (axis 1) persists regardless of effort/model, as the
  leveled run isolated.
- The committed Strix artifacts have JWTs redacted (`<REDACTED-JWT>`) — they were validly-signed
  tokens for the throwaway local mock IdP, not real secrets, but not worth committing.
