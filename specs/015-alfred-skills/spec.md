# 015 - Alfred skills: the QA loop as eleven Claude Code skills, and the board helpers they need

**Branch**: `015-alfred-skills` · **Builds on**: specs/014-task-board · **Mocks**: `specs/014-task-board/mock-skills-ui.html`,
`mock-skills-ui-2.html`, `mock-replies.html`

## Why

`/alfred-qa` was one skill with four modes. The owner wants the loop as separate skills with one shared set of rules,
every card carrying a running state ("who are we waiting on, what happened, what next"), Claude never starting work the
user did not choose, and a board that shows at a glance what waits on the user.

## Decisions (2026-10-11)

- Twelve skills, one shared rules file copied into each (no drift): `alfred-guide`, `alfred-connect` (add any Alfred
  instance - localhost, another port, LAN, tunnel - as its own MCP server; native over HTTP `/mcp`, Docker through a
  local `mcp-server` with `ALFRED_URL`), `alfred-setup`, `alfred-spec`,
  `alfred-listen`, `alfred-review`, `alfred-triage`, `alfred-sync`, `alfred-fix`, `alfred-verify`, `alfred-status`,
  `alfred-report`. The old `alfred-qa` is removed on install.
- State comments reuse Did / Found / Next (no new comment kind); a comment may set the card's **waiting on**.
- Claude may write the cycle brief and spec files (A): the author is recorded, the previous version is kept, the UI
  offers **Restore previous**. Skills always ask in chat before saving.
- Waiting on (`USER` / `CLAUDE` / `RETEST` / `NONE`) is set automatically by Alfred on events and explicitly by Claude.
- `/alfred-fix` never starts without the user naming the cards and saying Go.
- Notifications: tab title + unread dot, and a desktop notification (permission asked once).

## Requirements

### Phase 1 - core loop
- FR-1 Card `waitingOn` + `since`. Auto rules: Claude's new card → USER; Claude's question → USER; the user's answer to
  the last open question → CLAUDE; the user moves to To do / In progress → CLAUDE; Fixed → RETEST; Verified / Done /
  closed → NONE; Claude's proposal → USER; reopen → USER. Claude may set it in a comment (`waitingOn`).
- FR-2 Board filter by waiting on; chip with time in state on cards and in the drawer.
- FR-3 Next-step summary (`GET /board/next-steps`): questions/proposals waiting on the user (oldest first), To do,
  Fixed waiting for a re-test, Inbox - shown as a bar with copy-command buttons.
- FR-4 Copy-command buttons: on a card the skill for its state; on a cycle `/alfred-review`, `/alfred-spec`.
- FR-5 Answer from the board: an open question's card has Answer (and the A key) with the question, an answer box,
  Clear Needs decision, Next question.
- FR-6 Claude writes the brief / spec files; author + one previous version kept; Restore previous (user).
- FR-7 MCP: `waitingOn` on board_comment / board_reply / board_ask; `board_set_brief`, `board_put_spec`,
  `board_edit_spec`, `board_restore` not for Claude; `board_next_steps`.
- FR-8 The eleven skills + `skills/_shared/rules.md`; `alfred skill install` installs all and removes `alfred-qa`;
  release zip carries all; the tool-name test covers all.

### Phase 2 - awareness
- FR-9 Unread: a card Claude changed after the viewer last opened it shows a dot; the tab title counts them
  (per-browser, localStorage - a viewer convenience).
- FR-10 Desktop notification for a new Claude question or proposal while an Alfred tab is open; permission asked from a
  button, never on load.
- FR-11 Live step: board_status carries a `step` line shown on the strip.
- FR-12 Session log: one Did / Found / Next entry per skill run on the cycle (`board_session_log`), shown in the cycle's
  Board tab.

### Phase 3 - spec coverage
- FR-13 Card ↔ Acceptance item links (`specItems` on board_add / board_link_spec); checklist shows "N cards", the card
  shows the item it breaks.
- FR-14 Test steps: the numbered list under a brief heading containing "test steps"; Claude marks each step SEEN /
  FAILED (with a card) / untested (`board_mark_step`); shown ticked in the brief panel.

### Phase 4 - card management
- FR-15 Merge proposal (Claude) → the user accepts: history, mentions and links move to the target, the source closes as
  DUPLICATE with "merged into #n".
- FR-16 Blocked by: a card can be blocked by another; shown locked; listed in board_get / board_search.
- FR-17 Regression watch: `GET /board/regressions` - Done / Verified cards whose endpoint failed the same way in recent
  live calls; Claude proposes Reopen (user accepts: Done/Verified → To do, closed → reopen).
- FR-18 Copy as issue: Markdown for Jira / GitHub from the card, its evidence and the user's decisions.

## Out of scope
Starting Claude from the browser; multi-user unread state; notifications with no Alfred tab open.
