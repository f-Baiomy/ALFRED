---
name: alfred-listen
description: Listen to an Alfred session cycle live while the user tests - check every new call (HTTP, ERROR/WARN logs, SQL, supplier calls, Redis, values that drift between the steps of a flow) against the cycle's spec in batches, open cards with evidence and a first state comment, tick the test steps, and answer the user's comments on the board as they come. Use when the user says "listen to cycle X", "watch while I test", or "/alfred-listen".
argument-hint: "<cycle> [--dry]"
---

# Alfred listen

Read `rules.md` in this skill's folder first and follow it - especially "Batches", "What becomes a card" and the card
journal. Listening is `/alfred-review` done on each batch of new calls as they arrive: the same checks, the same
accuracy, a few tool calls per batch however many calls it holds.

## Start

1. The cycle (`list_cycles` by name). `get_cycle` with `limit: 1`: its project and whether it is recording - if not,
   tell the user to press Record (listening still works; it waits for calls).
2. `task_context` on the cycle (rules §0): the task, description, scope and out of scope, decisions, the requirements
   with the user's marks, the test steps, the open findings and earlier runs. Then `read_spec` only for a requirement
   you need in full, `board_closed_reasons` for the project, `board_teams`, the repo's "Project checks" (rules).
3. **Steps need spacers.** Listening matches calls to the brief's steps by the user's spacers. Ask once: "Add a spacer
   in the cycle before each test step - or I group them by endpoint and show you the grouping at the end."
4. Say in two lines what you will check (the Acceptance items, the project checks, the test steps) and that you are
   listening. `board_status` WATCHING with `step` "listening to <cycle>".
5. Calls already in the cycle: the first batch is all of them - `check_calls` without `sinceCallId`.

## Loop - one batch at a time, until the user says stop

1. **Wait** - in one turn, both: `wait_for_calls` with `sinceCallId` (the last `lastCallId`), `settleSec: 8`,
   `timeoutSec: 60` - it returns when the user pauses, with the whole burst of a step - and `board_wait` with
   `by: USER`. Nothing arrived → wait again; never check per call.
2. **Check** - `check_calls` with the same `sinceCallId` - every page (rules "Batches" 2: `offset: next`, `untilCallId`).
   Carry its `lastCallId` to the next batch (a call still
   running is in the next batch, not lost).
3. **Judge the flagged groups** (rules "Batches" 3) - "What becomes a card" and "Flows": a `Δ` on a sure expectation is
   a card, on an unsure one it waits for the flow's `Learn:` question.
4. **Write** (rules "Batches" 3): new cards with `board_add_many` (`cycleId`, evidence in the description, the main call
   in `links`, `teams`), then for each the first state comment (`waitingOn` USER) and `board_link_spec`; existing
   problems → `board_link` + one state comment. An `add_comment` on a call only when it helps the user see it in place.
5. **Ledger** - every group of the batch gets its outcome: card (linking all its calls), link, asked or fine with the reason.
6. **Steps** - `board_mark_step` the steps this batch showed: SEEN (call count) or FAILED (card number).
7. **Unsure expectations** - when a flow's run ends (its last step arrived, or the user moved on), ask them in the
   flow's `Learn:` card (rules "Learning") - once per flow, not per call.
8. **The user's change** (`board_wait`): a comment → answer it in its thread (`board_reply` with `replyTo`); an answer
   to your question → act on it and write the state comment - an answer on a `Learn:` card becomes a check line to
   save at stop, and a "must" about something already seen opens its BUG card now; a move / close → note it on your
   next state comment.
9. `board_status` with the counts: `step` "listening to <cycle> · 340 calls · 12 flagged in 4 groups · 3 cards".

Keep the conversation small: after a batch, remember only the ledger, the flows and their expectations - not the tool
output. Never read a whole body when a field (`get_call` `paths`) answers.

`--dry`: run the batches, list the cards, comments and marks you would write, write nothing.

## Stop

1. **Sweep** (rules "Batches"): `check_calls` with `sweep: true`, every page - only calls never checked or changed since;
   give each group it returns its outcome.
2. **Steps.** With no spacers from the user, show the grouping you used (`suggest_spacers`) and ask before adding
   them; then `board_mark_step` the steps still unmarked (UNTESTED when no call matched).
3. **Acceptance marks.** `board_suggest_mark` each Acceptance item with clear evidence - PASS / FAIL with the call and
   SQL mentions, CANT_TELL when the cycle did not cover it. The user marks; you only suggest.
4. **Regressions.** `board_regressions` for the project: a Done / Verified card whose problem showed again in this
   cycle → `board_propose` REOPEN with the calls. (The full comparison with earlier runs is `/alfred-review`'s.)
5. **What was learned** (rules "Learning", "Good runs"): a run of a flow that looks good → propose it as the reference;
   then one before / after of the new `## Alfred checks` lines (answers, allowed lines, sure expectations from the
   code, confirmed good runs) - save only on yes.
6. `board_status` STOPPED. `board_session_log` on the cycle: did (`120/120 checked · 9 flagged in 4 groups · 3 cards · 1 linked`,
   batches), found (cards added / updated, steps seen / failed / untested, marks suggested, Acceptance items
   with no evidence), next. Summary to the user, then: "Sort the Inbox: `/alfred-triage`".
