# 016 - Re-test without the hassle: live-call verify, expectations, watch, one-click re-test

**Builds on**: specs/014-task-board, specs/015-alfred-skills · **Mock**: `mock-retest.html`

## Why

Verifying a fix needed a recorded re-test cycle, and `board_verify` only compared HTTP status - an N+1 or a slow call
already answered 200, so "looks fixed" meant nothing. The owner wants re-testing to follow normal use of the app, for one
card, some cards or all of them, with a real check of what the fix was about.

## Decisions (2026-10-11)

All of: live-call verify, fix expectations, auto-watch chip, re-test button + steps; and before/after, replay the
original call, re-test on deploy, expectation templates, guards, enough calls / flaky, re-test report, re-test history.

## Requirements

- FR-1 Live-call verify: a Fixed card is checked against the live calls to its endpoint made after its fix time; a cycle
  is optional (`/board/verify?project=&cards=&cycleId=`). Scope: one card, a list, or every Fixed card.
- FR-2 Expectations per card (`board_fix` `expect`, editable by the user): SQL_COUNT (table, max), STATUS (range or
  "not N"), NO_LOG (level), DURATION (max ms, min calls), SAME_RESPONSE (JSON path). A card without expectations falls
  back to the status check, and says so.
- FR-3 Watch: each new call matching a Fixed card's endpoint is checked as it arrives (no polling); the card shows
  passes / partial / fails / no calls since fix; Accept Verified is the user's.
- FR-4 Re-test steps per card (`board_fix` `steps`); a re-test merges the steps of its cards; a step ticks when a
  matching call arrives.
- FR-5 Re-test button: one card (card, drawer), the selected cards, all Fixed (column, next-step bar); starts a recording
  cycle named "Re-test #a #b", shows the steps on the live strip; Stop and check runs FR-1 on it.
- FR-6 Before → after per expectation: the card's original evidence call against the latest calls.
- FR-7 Replay the original call (Resend); a write method (POST/PUT/PATCH/DELETE) asks first.
- FR-8 Re-test on deploy: the app restarting (agent re-attach) marks Fixed cards "new build - ready to re-test" and
  notifies the open tab.
- FR-9 Expectation templates suggested by the card (N+1 → SQL count, slow → duration, 5xx → status + no ERROR).
- FR-10 Guards: a Verified / Done card keeps its expectations; a later failing call shows a guard chip and feeds the
  regression watch (Claude proposes Reopen).
- FR-11 Enough calls / flaky: DURATION needs its min calls (default 3), others 1; mixed results show flaky.
- FR-12 Re-test history per card (each run: when, source, calls, result) and a re-test report (copy, attach to cycle).
- FR-13 MCP: `board_fix` `expect`/`steps`; `board_verify` by cards and/or cycle or live (`record` returns the report);
  `board_retest` (one card) and `board_retest_plan`; `board_regressions` lists failed guards.
  Skills: `/alfred-fix` always writes expectations and steps; `/alfred-verify [cards] [cycle]` defaults to live calls.

## Out of scope

Claude moving a card to Verified (still a proposal); replaying a call without the user's yes for write methods.
