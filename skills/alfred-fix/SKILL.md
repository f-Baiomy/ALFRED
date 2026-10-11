---
name: alfred-fix
description: Fix Alfred board cards the user chose - asks which To do cards when none is named and never starts without an answer, posts a plan and waits for Go, then investigates (evidence, code), makes the smallest fix, runs the tests and records the fix, with a state comment at every step. Use when the user says "fix card 11", "work the To do cards", or "/alfred-fix".
argument-hint: "[card# ...] [--dry]"
---

# Alfred fix

Read `rules.md` in this skill's folder first and follow it.

## 1. Which cards - never guess

First catch up: `board_changes` cursor `claude` for the project (as in /alfred-sync) - write the state comment on any
card the user changed, so no answer is missed.

- **No card given**: `board_search` with `status: [TO_DO, IN_PROGRESS]` (mine and the user's). List them - number,
  title, flags, who it waits on, 🔒 blocked by - URGENT / BLOCKER first, and **ask which cards and in what order**.
  Stop here until the user answers. "All" is an answer.
- **Card given**: use it. Not To do / In progress → say where it is and ask before going on.
- **Blocked** (`blockedBy` on the card): skip it while its blocker is not Fixed, and say so.

## 2. Plan, then wait for Go

For each card, in order:

1. `board_get` (every comment, the user's answers), `board_evidence` (the call, SQL, logs in one call),
   `board_move` IN_PROGRESS, `board_status` step "fixing #<n> · reading the evidence".
2. Find the code: `exception_source` / `locate_source` from the stack trace or the endpoint, then read the code.
3. Post the plan as a state comment (`board_comment`): did (what you read), found (the root cause), next (the change:
   files, what changes, the tests you will run, the impact on other flows), `waitingOn` USER. Show it in chat and ask
   **"Go?"**. Stop until the user answers.
   - Flagged AFFECTS_PROJECT, or the change touches code other flows use: say so plainly in the plan.
   - Unclear behaviour or the spec is silent: `board_ask` the question instead of a plan, and stop.

`--dry`: post nothing; show the plans and stop.

## 3. Fix (after Go)

1. The smallest change that fixes the root cause; add or update a test that fails without it.
2. Run the project's tests (`board_status` step "fixing #<n> · running tests"). Failing → fix or report; never record
   a fix whose tests fail.
3. `board_fix`: summary, root cause, files with lines, commit only if the user asked you to commit, tests and their
   result, how to verify (which step of the flow, what to look for), impact. It moves the card to Fixed and it waits on
   a re-test.
4. Next card - its plan, its Go.

## 4. Finish

`board_status` STOPPED. Summary: fixed, still in progress (why), skipped (blocked). `board_session_log` on the cycle
when the cards belong to one. Next: "Record the flow again, then `/alfred-verify <re-test cycle>`".
