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
- **A team given** ("fix Backend's cards"): `board_search` with `team: [<id>]` and the same statuses; list and ask as
  above. A card that also has other teams: fix only this team's part (its `### <Team>` section) and say so.
- **Card given**: use it. Not To do / In progress → say where it is and ask before going on.
- **Blocked** (`blockedBy` on the card): skip it while its blocker is not Fixed, and say so.

## 2. Plan, then wait for Go

For each card, in order:

1. `board_get` (every comment, the user's answers), `board_evidence` (the call, SQL, logs in one call),
   `board_move` IN_PROGRESS, `board_status` step "fixing #<n> · reading the evidence".
2. Find the code: `exception_source` / `locate_source` from the stack trace or the endpoint, then read the code.
3. Post the plan as a state comment (`board_comment`): did (what you read), found (the root cause), next (the change:
   files, what changes, the tests you will run, the impact on other flows), `waitingOn` USER. Name the team whose
   part this is; when the root cause belongs to another team than the card says, `board_assign` with the reason first. Show it in chat and ask
   **"Go?"**. Stop until the user answers.
   - Flagged AFFECTS_PROJECT, or the change touches code other flows use: say so plainly in the plan.
   - Unclear behaviour or the spec is silent: `board_ask` the question instead of a plan, and stop.

`--dry`: post nothing; show the plans and stop.

**Record code already written** - the card has `/alfred-verify`'s question "The code for this looks written … Record it
as fixed?" answered **Record as fixed** (or the user says "record it"): no investigation and no new code. Instead of
steps 2-3: read the code verify named (file, line, commit) on the task branch and check it does what the card asks;
post it as the plan (did: the code read; found: what it does against the card and its Acceptance item; next: record
it with board_fix, the tests you will run, the re-test plan), `waitingOn` USER, and ask **"Go?"**. After Go: run the
tests as in 3.2, then `board_fix` as in 3.3 with the commit verify found (it already exists - do not commit), the
files and lines, the re-test plan from the linked Acceptance item and the card's evidence, and the root cause "built
on <branch> in <commit>, not recorded on the board". The code does not do what the card asks → say so in the plan,
`board_reply` under the question, and fix it the normal way (steps 2-3) only after the user's Go.

## 3. Fix (after Go)

1. The smallest change that fixes the root cause; add or update a test that fails without it.
2. Run the project's tests (`board_status` step "fixing #<n> · running tests"). Failing → fix or report; never record
   a fix whose tests fail.
3. `board_fix`: summary, root cause, files with lines, commit only if the user asked you to commit, tests and their
   result, how to verify (which step of the flow, what to look for), impact, and always the re-test plan:
   - `expect` - what "fixed" means, checked by Alfred on every call after the fix: an N+1 → `SQL_COUNT` {table, max};
     a 5xx / hidden error → `STATUS` {range "!5xx" or "!405"} + `NO_LOG` {level ERROR}; slow → `DURATION` {max ms};
     the data must not change → `SAME_RESPONSE` {path}. Use the numbers the evidence gave (257 queries → max 3).
   - `steps` - what the user does in the app to make that call ("Open the flight search page"), with the endpoint when
     it is another call than the card's own.
   It moves the card to Fixed and it waits on a re-test.
4. When the fix is about handling a failure (a supplier error, a timeout, a missing field), propose the rule that
   reproduces it (rules "Interception rules") and add to the "how to verify" text: "switch on <rule>, run the step,
   switch it off".
5. Next card - its plan, its Go.

## 4. Finish

`board_status` STOPPED. Summary: fixed, still in progress (why), skipped (blocked). `board_session_log` on the cycle
when the cards belong to one. Next: "Use the app as the steps say (no recording needed) - the cards turn green on the
board - then `/alfred-verify` (or `/alfred-verify <n>` for one card)".

## Team tracker (specs/028)

Read the card's work items first - `team_card_items` (state, the tracker's comments, closed there?) and `team_item` for
the acceptance in the tracker's words. A card whose item is closed in the tracker: ask the user before fixing it.
Record the fix on the card as usual; telling the tracker happens on Verified / Done (the user approves that bundle).
