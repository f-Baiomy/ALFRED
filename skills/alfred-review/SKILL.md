---
name: alfred-review
description: Review a recorded Alfred session cycle after the fact - check every call against the spec in one pass, fill the board (new cards, new evidence on existing ones, no duplicates), compare with earlier runs of the same flow for regressions, annotate the cycle, tick the test steps and suggest checklist marks. Use when the user says "review cycle X", "check this recording", or "/alfred-review".
argument-hint: "<AB#1234 | board name or id | cycle> [--dry]"
---

# Alfred review

Read `rules.md` in this skill's folder first and follow it - especially "What becomes a card" and the card journal.

**Boards** (specs/030): a board (`AB#1234`, its name or id - rules §0 "Naming a board") reviews its newest cycle, or the one the user names; `check_calls` takes the board too.


Boards (specs/027): reviewing a board reads every cycle on it; a cycle shared with other boards is reviewed for this board's requirements, and each finding goes where `board_home` says (rules section 0, "Boards and cycles"). `board_cycle_verdicts` shows each call against each board.

## 1. Context

`task_context` on the cycle (rules §0) - the task, its description, scope, decisions, requirements with the user's
marks, test steps, open findings, earlier runs. `read_spec` only for a requirement you need in full,
`board_closed_reasons` for the project, the repo's "Project checks" (rules) when there are any. The task branch's change
(rules §0 "Checking the task against what was asked"): `git diff --stat <base>...HEAD` and the files behind each
requirement - a hint, never the verdict. `board_requirements`: each Acceptance item's verdict by the calls (Alfred
judges every call in code, so a cycle recorded before the evidence was written is judged on this read too); items
with NO_EVIDENCE → draft it now with `board_evidence_put` and read `board_requirements` again.
`board_status` WATCHING with `step` "reviewing <cycle>".

## 2. Map the flow

Group the calls into the brief's test steps by the Acceptance items each step names (`→ AC6`: the step's calls are
its items' calls); for a step that names none, by the actions `check_calls` cuts the calls into (pause and area,
learned from the cycle) and its endpoints. Spacers are not used and none are added.

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
- Requirements by the calls (rules "Requirement status"): MISSING / WRONG already have their card - link the calls
  and check it links the item; NO_DATA → a QA TASK for the test data; NOT_EXERCISED → TASK with the item's howTo;
  MANUAL → check the page's code and `board_suggest_mark` ("met by code") or ask; spec vs behaviour conflict →
  QUESTION. Never "fine" for a call that misses an item because the code is old.
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

## Team tracker (specs/028)

For each new card: an open tracker bug it matches gets a link proposal (`team_link_card`, no `askedIn`); a real defect
with none may get `team_create_item` - a bundle the user approves, with the card's description, no secrets. Say which
cards wait on such a bundle in the summary.
