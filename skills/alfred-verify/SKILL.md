---
name: alfred-verify
description: Verify fixes with Alfred - re-test every Fixed card (or the ones named) against the live calls since its fix, or a re-test cycle, by the card's expectations (SQL count, status, log lines, duration, response) with before → after; propose Verified or comment "still failing" with the evidence, check guards and regressions of Done cards, and suggest checklist marks. Use when the user says "verify", "check the fixes", "re-test", or "/alfred-verify".
argument-hint: "[card numbers] [re-test cycle] [project] [--dry]"
---

# Alfred verify

Read `rules.md` in this skill's folder first and follow it. Verified and Done are the user's: you propose.

## 1. What to re-test

- **Cards**: numbers in the arguments (`/alfred-verify 19`, `/alfred-verify 18 19`) → only those; none → every Fixed card.
- **Calls**: by default the **live calls since each fix** - no cycle needed; the user just used the app. A cycle name in
  the arguments (`list_cycles` by name) → only that cycle's calls. An argument in angle brackets (`<re-test cycle>`) is a
  placeholder: ignore it.
- Catch up first: `board_changes` cursor `claude` (state comments for what the user did). `board_status` step
  "verifying #18 #19".

## 2. Fixed cards

1. `board_verify` with the project, `numbers`, and `cycleId` if one was named, `record: true` (keeps each card's
   re-test in its history and returns the report). Verdicts per card:
   - **PASSES** - every call since the fix meets every expectation. Look at the before → after values; when the card has
     no expectations (`statusOnly`) check its own evidence too: the new calls' ERROR / WARN lines (`call_logs`), the SQL
     the card was about (`db_statements`). Then `board_propose` VERIFIED with the calls as evidence, state comment,
     `waitingOn` USER.
   - **FAILS / FLAKY** - state comment with the failing values and calls, `board_move` IN_PROGRESS, `waitingOn` CLAUDE,
     next `/alfred-fix <n>`.
   - **PARTIAL** - a step not done yet, or a duration waiting for more calls: state comment naming what is left,
     `waitingOn` RETEST.
   - **NO_CALLS** - nothing called the endpoint since the fix: state comment "not re-tested yet - <the card's steps>",
     `waitingOn` RETEST. `newBuild` means the app restarted after the fix: say "the new build is running - re-test now".
   - **NOT_CHECKABLE** - the card names no call: say so; ask the user which call shows it.
2. A card whose re-test needs a failure (its card links an `@[rule:...]`): `list_rules` - when it is off, ask the user
   to switch it on and run the step; after, `rule_hits` and judge the calls it touched like any other.
3. A card without expectations: write them now with `board_retest_plan` from its "Verify:" text (ask in chat first,
   show them), so the next re-test checks more than the status.

## 2b. The task

When a cycle is named, or the repo's current branch is the one a cycle's brief names (`task_context` lists the
tasks): `board_requirements` on it - each Acceptance item's verdict by the calls since the last build (`board_verify`
with `cycleId` gives the one-line `task` too). Report it after the Fixed cards:
`Task 61813: NOT DONE - 5 missing (#41), 2 no data, 1 not exercised, 2 manual`. A task is not done while an item is
MISSING or WRONG, whatever the cards say. **No Fixed card of the task** → say it plainly first: "Nothing of task
61813 was fixed or re-tested - verify covers Fixed cards; by the calls the task is …". Never let an unrelated card's
result stand for the task. MET items whose card is still open → `board_propose` as the card's status allows.

## 3. Guards, regressions and the spec

- `board_regressions` for the project: regressions and **guards failed** (a Verified / Done card's expectations broken
  by a later call) → `board_propose` REOPEN with the calls.
- With a re-test cycle: `board_mark_step` its steps; `board_suggest_mark` each Acceptance item with clear evidence
  (PASS / FAIL with mentions; CANT_TELL when not covered).

`--dry`: `board_verify` without `record`, show the verdicts and what you would propose / comment, and stop.

## 4. Finish

`board_status` STOPPED. `board_session_log` on the re-test cycle when there was one. Summary: the report (passed,
failed, flaky, partly checked, not covered) with before → after, proposals waiting for Accept, reopened. Next: accept
the proposals on the board; `/alfred-fix` for what still fails; `/alfred-report` when done.
