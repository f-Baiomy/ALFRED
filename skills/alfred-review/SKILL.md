---
name: alfred-review
description: Review a recorded Alfred session cycle after the fact - check every call against the spec in one pass, fill the board (new cards, new evidence on existing ones, no duplicates), compare with earlier runs of the same flow for regressions, annotate the cycle, tick the test steps and suggest checklist marks. Use when the user says "review cycle X", "check this recording", or "/alfred-review".
argument-hint: "<cycle> [--dry]"
---

# Alfred review

Read `rules.md` in this skill's folder first and follow it - especially "What becomes a card" and the card journal.

## 1. Context

`task_context` on the cycle (rules §0) - the task, its description, scope, decisions, requirements with the user's
marks, test steps, open findings, earlier runs. `read_spec` only for a requirement you need in full,
`board_closed_reasons` for the project, the repo's "Project checks" (rules) when there are any. The task branch's change
(rules §0 "Checking the code against the task"): `git diff --stat <base>...HEAD` and the files behind each requirement.
`board_status` WATCHING with `step` "reviewing <cycle>".

## 2. Map the flow

Group the calls into the brief's test steps by the user's spacers and comments; with no spacers, `suggest_spacers`
and use them as the grouping (do not add them without asking). Match each step to the Acceptance items it exercises.

## 3. Check every call - one pass

`check_calls` on the whole cycle, every page (rules "Batches"): every call checked, the flagged ones in groups with their evidence, the flows
and their hop diffs (`Δ`). Then the rules' "Flows" on what it found: read each flagged endpoint's code once, write the
expectations - sure (judged now) or unsure (asked in step 4) - and judge every flagged group; the ledger gives each one
its outcome. Drill in only where the evidence is not enough (`investigate_call`, `log_context`, `db_statement`, a field
with `get_call` `paths`). Update `board_status` `step` as you go ("reviewing <cycle> · 120 calls · 9 flagged in 4 groups · 3 cards").

## 4. Fill the board

- New problems → one `board_add_many` with their `teams`, each with its `firstComment` (the first state comment) and `specItem` (the Acceptance item) in the same call (+ `board_ask` for questions).
- A card whose teams no longer fit what this recording shows → `board_assign` with the reason.
- Problem already on a card → no new card: `board_link` the new calls and a state comment "seen again in <cycle>".
- Two existing cards that are one problem → `board_propose` MERGE.
- A card the user dismissed → skip.
- Acceptance item never exercised → TASK; spec vs behaviour conflict → QUESTION.
- Unsure expectations → the flow's `Learn:` card (rules "Learning"), one batched question per flow.

## 5. Regressions

`compare_cycles` with the previous cycles of the same flow (similar name or brief), and `board_regressions` for the
project: an endpoint that worked before and fails now → a BUG flagged URGENT "Regression since <cycle>"; a Done /
Verified card failing again → `board_propose` REOPEN with the failing calls. A card whose problem no longer shows →
state comment "not seen in <cycle>".

**Shape regressions - still 200, but different.** The baseline is the flow's confirmed `good run` (rules "Good runs");
with none confirmed, the last earlier run of the flow that had no open BUG on the step - and say in the session log that
the baseline is not confirmed. For each step, `diff_calls` its main call against the baseline's same step (same endpoint,
same position in the flow). Look only at the shape, not the values that are meant to differ (ids, times, tokens):

- a field the baseline response had and this one lacks, or that is now empty / null → **BUG** "Regression since
  <baseline cycle>: <field> missing" (URGENT when an Acceptance item or a project check needs it);
- a field whose type or format changed (number → string, `2026-10-13` → `13/10/2026`, an amount losing its currency)
  → **BUG**;
- a list that is now much shorter for the same input (search results, segments, passengers) → **QUESTION** flagged
  NEEDS_DECISION;
- a new field → nothing, unless the spec says otherwise.

No earlier run of the flow → skip, and say so in the session log.

**What was learned** (rules "Learning", "Good runs"): a run in this cycle that looks good → propose it as the flow's
reference; then one before / after of the new `## Alfred checks` lines - save only on yes.

## 6. Annotate and mark

`add_comment` on each problem call in the cycle; `board_mark_step` every step (SEEN / FAILED / UNTESTED);
`board_suggest_mark` each Acceptance item with clear evidence (PASS / FAIL with the call and SQL mentions; CANT_TELL
when the cycle did not cover it).

`--dry`: list everything above you would do, and stop.

## 7. Finish

`board_status` STOPPED. `board_session_log`: did (`120/120 checked · 9 flagged in 4 groups · 3 cards · 1 linked`), found (cards added / updated, regressions, untested
steps and items), next (what waits on the user). Summary, then: "`/alfred-triage` to sort the Inbox".
