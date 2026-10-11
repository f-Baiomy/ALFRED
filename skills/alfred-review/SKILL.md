---
name: alfred-review
description: Review a recorded Alfred session cycle after the fact - check every call against the spec in one pass, fill the board (new cards, new evidence on existing ones, no duplicates), compare with earlier runs of the same flow for regressions, annotate the cycle, tick the test steps and suggest checklist marks. Use when the user says "review cycle X", "check this recording", or "/alfred-review".
argument-hint: "<cycle> [--dry]"
---

# Alfred review

Read `rules.md` in this skill's folder first and follow it - especially "What becomes a card" and the card journal.

## 1. Context

The cycle by name (`list_cycles`), `get_cycle` (project, calls). `get_brief` (purpose, test steps, spec files, the
cycle's cards), `read_spec` for each spec file, `board_closed_reasons` for the project. `board_status` WATCHING with
`step` "reviewing <cycle>".

## 2. Map the flow

Group the calls into the brief's test steps by the user's spacers and comments; with no spacers, `suggest_spacers`
and use them as the grouping (do not add them without asking). Match each step to the Acceptance items it exercises.

## 3. Check every call

`problem_calls` / `triage` scoped to the cycle for the obvious ones, then every call of every step with the rules'
checks - `investigate_call`, `call_logs` / `log_context`, `db_statements`, the outbound calls, `redis_commands`.
Update `board_status` `step` as you go ("reviewing <cycle> · 34/120 calls · 3 cards").

## 4. Fill the board

- New problem → `board_add` with its `teams` + first state comment (+ `board_ask` for questions, `board_link_spec` for the item).
- A card whose teams no longer fit what this recording shows → `board_assign` with the reason.
- Problem already on a card → no new card: `board_link` the new calls and a state comment "seen again in <cycle>".
- Two existing cards that are one problem → `board_propose` MERGE.
- A card the user dismissed → skip.
- Acceptance item never exercised → TASK; spec vs behaviour conflict → QUESTION.

## 5. Regressions

`compare_cycles` with the previous cycles of the same flow (similar name or brief), and `board_regressions` for the
project: an endpoint that worked before and fails now → a BUG flagged URGENT "Regression since <cycle>"; a Done /
Verified card failing again → `board_propose` REOPEN with the failing calls. A card whose problem no longer shows →
state comment "not seen in <cycle>".

## 6. Annotate and mark

`add_comment` on each problem call in the cycle; `board_mark_step` every step (SEEN / FAILED / UNTESTED);
`board_suggest_mark` each Acceptance item with clear evidence (PASS / FAIL with the call and SQL mentions; CANT_TELL
when the cycle did not cover it).

`--dry`: list everything above you would do, and stop.

## 7. Finish

`board_status` STOPPED. `board_session_log`: did (calls checked), found (cards added / updated, regressions, untested
steps and items), next (what waits on the user). Summary, then: "`/alfred-triage` to sort the Inbox".
