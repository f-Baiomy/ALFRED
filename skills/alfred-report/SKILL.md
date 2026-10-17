---
name: alfred-report
description: Summarise QA work from the Alfred board for a stand-up, a PR or a hand-over - found, fixed, verified, still open, the decisions the user made, regressions, spec coverage - for one cycle, one task or a time span. Shown in chat; saved as a file only when asked. Use when the user says "report", "summary for stand-up", "what did we do", or "/alfred-report".
argument-hint: "[cycle | project] [since <date>] [--file]"
---

# Alfred report

Read `rules.md` in this skill's folder first. This skill only reads the board; it writes a file only when the user
asks (`--file`, or "save it").

Boards (specs/027): a report covers one board - its brief, requirements, cards (home and related), and every cycle on it (rules section 0, "Boards and cycles").

1. Scope: a cycle (`get_brief`, its cards via `board_search` with `cycleId`), a project, and a time span ("today",
   "since Monday" → `board_search` / `board_changes` with `since`).
2. Gather: `board_search` for every card in scope (with its last comment), `board_get` for the ones whose decisions
   matter (the user's answers to questions), `get_brief` test steps and `read_spec` checklist (marks, cards per item)
   for each cycle, `board_requirements` for each cycle (each item's verdict by the calls and its deciding call - a
   Requirements table in the report, MISSING first), `board_regressions`.
3. Write it like this - short lines, card numbers as `#n`, no evidence dumps:

```
## QA report - <cycle or project> - <date span>

Found      5 (3 bugs, 1 risk, 1 question) · Fixed 3 · Verified 2 · Still open 2
Decisions  #11 PCC list filtered by branch (you, 10/11) · #12 closed as Fine: 401 before login is expected
Fixed      #9 discount saved (OrderMapper.java:142) - verified in "ODY-482 retest"
Open       #14 waits on you (question, 2 d) · #15 To do
Regressions  none / #7 login 500 again since 10/11 (reopen proposed)
Spec       Acceptance 4/5 PASS · 1 not tested (Refund flow)
Calls      by the requirement check: 3 met · 1 missing (#41) · 1 no data - one row per item in the Requirements table
Test steps 4/5 seen · step 5 not tested
Teams      Backend 2 open (#14, #15) · Frontend 1 (#15) · Database 0 · no team: #16
Next       answer #14 · re-test step 5
```

4. `--file`: save as Markdown where the user says (default: `qa-report-<date>.md` in the repo root) and say the path.
   For a cycle, also `board_session_log` an entry "report written".
