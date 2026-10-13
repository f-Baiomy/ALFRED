---
name: alfred-listen
description: Listen to an Alfred session cycle live while the user tests - check every new call (HTTP, ERROR/WARN logs, SQL, supplier calls, Redis, values that drift between the steps of a flow) against the cycle's spec in batches, open cards with evidence and a first state comment, tick the test steps, and answer the user's comments on the board as they come. Use when the user says "listen to cycle X", "watch while I test", or "/alfred-listen".
argument-hint: "<cycle> [--dry] [--finish]"
---

# Alfred listen

Read `rules.md` in this skill's folder first and follow it - especially "Batches", "What becomes a card" and the card
journal. Listening is `/alfred-review` done on each batch of new calls as they arrive: the same checks, the same
judging, the same cards - only earlier. **A cycle listened to and then reviewed must give no new cards.** Three things
make that true: every batch is judged as carefully as a review (no group waved through because the batch is small or
looks like an earlier one), calls checked before their log lines / SQL arrived are re-judged when they arrive
(`check_calls` does it: `rechecked`, `recheckPending`), and Stop runs review's own finish (regressions, shape
regressions, unexercised requirements, annotations).

`--finish`: the listening ended without Stop (the session was interrupted, the user closed it) - run only **Stop**
below on the cycle.

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

1. **Wait and check - one call**: `check_calls` with `sinceCallId` = the last `check_calls` reply's `lastCallId`,
   `waitSec: 60`, `settleSec: 5` and `boardCursor` (`now` the first time, then the reply's `board.cursor`). It waits
   until the user pauses after a burst of calls - or until a call checked too early gets its late log lines / SQL
   (`recheckPending`) - then checks the batch, re-judges those late calls, and returns the user's board changes on this
   cycle too. Nothing arrived (`waited: nothing arrived`, `checked: 0`) → call it again. Never check per call, never
   `wait_for_calls` or `board_wait` beside it (a turn waits for its slowest call).
2. **The rest of the batch** - more groups than one page (`next` not null) → `check_calls` with `offset: next`,
   `untilCallId` = the reply's `lastCallId`, the same `sinceCallId`, no `waitSec` - until `next` is null. Carry
   `lastCallId` to the next batch (a call still running is in the next batch, not lost).
3. **Judge the flagged groups exactly as `/alfred-review` step 3 does** (rules "Batches" 3, "What becomes a card",
   "Flows"): read each flagged endpoint's code once, drill in where the evidence is not enough (`investigate_call`,
   `log_context`, `db_statement`, `get_call` `paths`), check every ERROR / WARN line, failed statement, N+1, slow call,
   swallowed supplier error and empty result. A `Δ` on a sure expectation is a card; on an unsure one it waits for the
   flow's `Learn:` question. "Fine" needs a reason you can write in the ledger - never "same as before" without
   `board_link`ing it to that card.
4. **Write** (rules "Batches" 4): every new card of the batch in **one** `board_add_many` (`cycleId`, evidence in the
   description, the main call in `links`, `teams`, its `firstComment` with `waitingOn` USER, its `specItem`); existing
   problems → `board_link` + one state comment. An `add_comment` on a call only when it helps the user see it in place.
5. **Ledger** - every group of the batch gets its outcome: card (linking all its calls), link, asked or fine with the reason.
6. **Steps** - `board_mark_step` the steps this batch showed: SEEN (call count) or FAILED (card number).
7. **Unsure expectations** - when a flow's run ends (its last step arrived, or the user moved on), ask them in the
   flow's `Learn:` card (rules "Learning") - once per flow, not per call.
8. **The user's change** - the `board` part of the step 1 reply (changes on this cycle's cards; for the rest of the
   project, `board_changes` with your own cursor - it answers at once). When `/alfred-live` runs (the user started it,
   or the reply says `/alfred-live is answering the user`), only note the changes and skip the rest of this step: a
   comment → answer it in its thread (`board_reply` with `replyTo`); an answer
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
4. **Review's finish, in full** - what `/alfred-review` does after checking, so a review afterwards finds nothing new:
   - **Requirements** - an Acceptance item the cycle never exercised → TASK; spec vs behaviour conflict → QUESTION;
     a requirement no code change touches and the calls show is not done → TASK (rules §0).
   - **Regressions** - `compare_cycles` with the previous cycles of the same flow and `board_regressions` for the
     project: an endpoint that worked before and fails now → BUG flagged URGENT "Regression since <cycle>"; a Done /
     Verified card failing again → `board_propose` REOPEN with the calls; a card whose problem no longer shows → state
     comment "not seen in <cycle>".
   - **Shape regressions** - for each step, `diff_calls` its main call against the flow's good run (rules "Good runs";
     else the last earlier run with no open BUG on the step, said so in the session log): a field missing or now empty
     → BUG; a type or format change → BUG; a list much shorter for the same input → QUESTION flagged NEEDS_DECISION.
   - **Logging gaps** - a failure with no log line → TASK flagged AFFECTS_PROJECT (rules "What becomes a card").
   - **Annotate** - `add_comment` on each problem call in the cycle.
5. **What was learned** (rules "Learning", "Good runs"): a run of a flow that looks good → propose it as the reference;
   then one before / after of the new `## Alfred checks` lines (answers, allowed lines, sure expectations from the
   code, confirmed good runs) - save only on yes.
6. `board_status` STOPPED. `board_session_log` on the cycle: did (`120/120 checked · 9 flagged in 4 groups · 3 cards · 1 linked`,
   batches), found (cards added / updated, steps seen / failed / untested, marks suggested, Acceptance items
   with no evidence), next. Summary to the user, then: "Sort the Inbox: `/alfred-triage`".
