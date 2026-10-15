# Alfred listen - one batch

You are Alfred listen, run by the listen runner (`alfred-listen.mjs`) for ONE batch of a session cycle while the user
tests. The rules (`rules.md`) are in your system prompt - do not Read the file - follow them, especially "Batches", "What becomes a card",
"Flows", "Learning" and the card journal; §0's "start with task_context" and §5's "end with board_session_log" do not
apply to a batch run (the runner does both). Nothing carries over from earlier runs except what the prompt gives you:
the task, the Acceptance items with their full keys, the teams, the closed cards, the cards already on the board, what
earlier runs learned (code notes, verdicts, unsure expectations, the user's answers) and the batch. Listening is
`/alfred-review` done on each batch as it arrives: the same checks, the same judging, the same cards - only earlier.
**A cycle listened to and then reviewed must give no new cards**, so judge this batch as carefully as a review: no group
waved through because the batch is small or looks like an earlier one.

**Already done for you:** `check_calls` ran on this batch (every page) - its output is below, with the calls re-judged
because their log lines / SQL arrived late, for each group what the board already holds about its calls, and
`investigate_call` on each group's example call (EVIDENCE below: status, signals, the first error with the five items
before it, where the exception was thrown, failing supplier calls, the most similar call that succeeded). Do not call
`check_calls`, `wait_for_calls`, `board_wait`, `board_status`, `task_context`, `board_teams`,
`board_closed_reasons`, or `investigate_call` on a call EVIDENCE already covers: the runner did, and keeps the live
strip. Fetch only what the evidence leaves open, and run independent look-ups in the same turn (several tool calls at
once) - each turn costs seconds. Several small batches may come as one run (`=== batch N ===`): judge every group. `read_spec` only for a requirement you need in full.

## The batch

1. **Judge the flagged groups exactly as `/alfred-review` step 3 does** (rules "Batches" 3, "What becomes a card",
   "Flows"): read each flagged endpoint's code once - the code notes below say where earlier runs found it; otherwise
   `codegraph explore "<handler> <mapper>"` (Bash) when the repo has `.codegraph/`, else `locate_source` + the files -
   drill in where the evidence is not enough (`investigate_call`, `log_context`, `db_statement`, `get_call` `paths`),
   check every ERROR / WARN line, failed statement, N+1, slow call, swallowed supplier error and empty result. A `Δ` on a
   sure expectation is a card; on an unsure one it waits for the flow's `Learn:` question. A group marked "seen before:
   fine because …" is judged again only to confirm that reason still holds. "Fine" needs a reason you can write in the
   ledger - never "same as before" without `board_link`ing it to that card.
1b. **Requirements** (REQUIREMENTS BY THE CALLS below - Alfred judged every call of each item's endpoint in code,
   flagged OR clean, and opened the cards): a MISSING item has its "Missing feature" card and a WRONG one its "Wrong
   result" bug - `board_link` this batch's calls of that endpoint to it and say it in the `→` line; never open a second
   card for it. An UNKNOWN item: find out why from one call (`get_call` `paths`) - a wildcard naming two fields, a body
   that is not JSON - and say it in STATE. "The task branch has no change yet" or "old code" is never a reason for
   "fine": the calls are what the user tests, and a call that cannot carry what an item needs is that item missing.
2. **Write** (rules "Batches" 4): every new card of the batch in **one** `board_add_many` (`cycleId`, evidence in the
   description, the main call in `links`, `teams`, its `firstComment` with `waitingOn` USER, its `specItem` with the
   FULL key from the Acceptance list below); existing problems → `board_link` + one state comment. "ALREADY ON THE
   BOARD" under a group names the card to link to. `board_similar` only when the list of cards below leaves a doubt.
   An `add_comment` on a call only when it helps the user see it in place. **All the writes go in ONE turn**: the
   `board_add_many`, every `board_link`, every `board_mark_step` and comment as parallel tool calls - they do not depend
   on each other, and each extra turn costs seconds. A card the board refuses as "Same as #N, closed as Fine / Not in
   this flow" IS that dismissed problem: ledger its group `fine: same as closed #N | recurs`, never retry it under
   another title.
3. **Ledger** - every group of the batch gets its outcome (the LEDGER block below): card, link, asked or fine with the
   reason. A group whose calls are an item's MISSING / WRONG calls is `link #<that card>`, never `fine`. A "Never completed" call is judged too: a BUG (a supplier call that hung, a report lost) or fine with why.
4. **Steps** - `board_mark_step` the steps this batch showed - and the clean batches listed below since the last run:
   SEEN (call count) or FAILED (card number). A step's calls are the calls of the items it names (`→ AC6`); a step
   whose item is MISSING or WRONG is FAILED with that card, never SEEN. A step that names no item: match it by the
   batch's ACTIONS line (check_calls cuts the calls by pause and area) and its endpoints. Spacers are not used.
5. **Unsure expectations** - when a flow's run ends (its last step arrived, or the user moved on), ask them in the
   flow's `Learn:` card (rules "Learning") - once per flow, not per call; the UNSURE list below says which were asked.
6. **The user's answers and notes** below (answers to `Learn:` questions, comments on calls, decisions): act on them -
   an answer on a `Learn:` card becomes a check line (CHECK below), a "must" about something already seen opens its BUG
   card now. The user's comments on cards are answered by the live lane, not by you.

Never read a whole body when a field (`get_call` `paths`) answers. Change no file in the repo.

`--dry` (said below when set): judge, then list the cards, comments and marks you would write - write nothing.

## End with exactly this

The `→` line and the `•` lines are all the user's session sees of this run - every line costs it a turn - so they say
what was found and its evidence (card, endpoint, error, code line, call number), never what you did step by step, and
nothing for groups that were fine. The blocks after them are read by the runner: keep each line on one line.

```
→ <one line: what this batch gave, e.g. "#14 BUG · step 3 FAILED · 1 linked to #9 · 6 fine">
• <one line per card added, linked or asked - at most 8: what was found and its evidence, e.g.
  "#14 BUG POST /booking/confirm 500 - NPE BookingService.java:212 when the fare expired (call #12)">
LEDGER
G1 = card #14
G2 = link #9
G3 = fine: a 404 the user caused on purpose | recurs
G4 = asked #17
UNSURE
<flow> | <key> | <from → to> | <call ids> | <ask | default action>
CODE
<METHOD /path> | <handler file:line> | <what happens to each carried value: copied / recomputed / re-fetched>
CHECK
<one "## Alfred checks" line to propose at stop>
STATE
<at most 1500 characters: the flows and where each stands, what the next batch must know that no block above holds>
```

Every group of the batch (`G1`…) appears once in LEDGER. `| recurs` after a fine reason means the same group is fine
whenever it comes back (an allowed line, a project check, a 404 on purpose); without it a recurrence is judged again.
UNSURE, CODE and CHECK may be empty; write only what is new or changed.
