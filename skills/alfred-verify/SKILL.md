---
name: alfred-verify
description: Verify fixes against an Alfred re-test cycle - check every Fixed card's endpoint in the new calls (status, logs, SQL), propose Verified or comment "still failing" with the evidence, check regressions of Done cards, and suggest checklist marks for the spec. Use when the user recorded a re-test and says "verify", "check the fixes", or "/alfred-verify".
argument-hint: "<re-test cycle> [project] [--dry]"
---

# Alfred verify

Read `rules.md` in this skill's folder first and follow it. Verified and Done are the user's: you propose.

## 1. Context

The re-test cycle (`list_cycles` by name). Not given, or only a placeholder such as `<re-test cycle>`: list the
project's cycles recorded after the Fixed cards were fixed and ask which one - never start without the answer. Catch up first: `board_changes` cursor `claude`
(state comments for what the user did). `get_brief` and `read_spec` of the re-test cycle (or of the original cycle
when the re-test has no spec of its own - say which you used). `board_status` step "verifying <cycle>".

## 2. Fixed cards

1. `board_verify` with the project and the re-test cycle (`apply: false`): LOOKS_FIXED / STILL_FAILING /
   NOT_EXERCISED per Fixed card.
2. Check each LOOKS_FIXED card by its own evidence, not only the status: the new calls' ERROR / WARN log lines, the SQL
   the card was about (`db_statements`), the value the spec names.
   - Really fixed → `board_propose` VERIFIED with the new calls as evidence, state comment, `waitingOn` USER.
   - Still wrong → state comment "still failing" with the new evidence, `board_move` IN_PROGRESS, `waitingOn`
     CLAUDE, next `/alfred-fix <n>`.
3. NOT_EXERCISED → state comment "not covered by <cycle> - re-test step <n>", `waitingOn` RETEST.

## 3. Regressions and the spec

- `board_regressions` for the project, and the re-test cycle's calls to Done / Verified cards' endpoints:
  failing again → `board_propose` REOPEN with the calls.
- `board_mark_step` the re-test cycle's steps; `board_suggest_mark` each Acceptance item with clear evidence (PASS /
  FAIL with mentions; CANT_TELL when not covered).

`--dry`: show the verdicts and what you would propose / comment, and stop.

## 4. Finish

`board_status` STOPPED. `board_session_log` on the re-test cycle. Summary: proposed Verified (waiting for Accept),
still failing, not covered, reopened, marks suggested. Next: accept the proposals on the board; `/alfred-fix` for
what still fails; `/alfred-report` when done.
