# 032 - A board header that says one thing at a time

Status: planned 2026-10-18. Nothing built yet. Mocks: [mock.html](mock.html) (static, before/after) and
[prototype.html](prototype.html) (clickable, with tour and "What just happened" log; run `specs-mocks` from
`.claude/launch.json`, then open `http://localhost:4310/032-board-header/prototype.html`). Tasks: [tasks.md](tasks.md).

## Why

The board page today stacks up to nine rows above the cards: header, cycle chips, board actions, stage strip, "Not
defined yet" banner, task card, code ladder and up to three idle status rows. Each row comes from its own component,
and each one wants to guide the user. The user cannot tell what to do next, and the session button speaks in internal
words. Measured on AB#59851 (2026-10-18):

| Problem | Where it comes from today |
|---|---|
| Three "Next" hints that disagree (`/alfred-setup` twice, `/alfred-spec` once) | `stage-strip` (from `BoardStage.of`), the stage strip's "Not defined yet" box, and `task-view`'s `nextStepOf()` - a second, client-side rule. CLAUDE.md forbids a second rule. |
| A fourth hint inside the cards view | `next-steps-bar` in `board-view` (To do → /alfred-fix, Fixed → /alfred-verify, Inbox → /alfred-triage, /alfred-status) |
| Two steppers at once | 7 stages (`stage-strip`) and Coded → Done (`task-view` `PHASES`/`phaseOf`), even before anything is defined |
| The long board name three times | board picker, two cycle chips (`related-strip`), task card title |
| Board state buttons always visible | Open / Done / Archive / Delete… in `related-strip` |
| Idle status rows | `live-strip`: "Answering you…", "No chat handles this cycle", "Claude stopped · checked 0 calls" |
| Session button in internal words, 14 flat menu items | `board-session-button`: "▶ alfred-live", "Live · session 2723f394", "Stop answering (keep session)", "Sync", "Release", "Board audit" |
| Stop / Release seem to do nothing | see "Stop and Release today" below |

## What the user gets (the prototype is the spec)

1. **One header row**: Boards ▾ · `AB#59851` chip · plain title (full name on hover, ellipsis) · project ▾ · `Open ▾` ·
   💬 Chat · **Claude button**.
2. **One facts line**: work item type and state, card count (and "⚑ n wait on you"), `Azure ▾` on the right.
3. **One stage line**: the 7 stages from `GET /board/boards/{id}/stage`, done ✓ green, current filled, rest faint;
   the Coded → Done ladder on the right only from Code on.
4. **One Next card**: icon, "NEXT STEP", a plain title, one or two plain sentences, ONE primary button that does the step
   (starts or resumes Claude first when needed), "⧉ Copy for terminal", "Other steps ▾".
5. **One recording line**: `● Record` with one sentence; the cycle list and "relate" live on the Cycles tab.
6. **Status rows only while something runs**: one live row (what Claude is doing, Open in Desktop, Stop).
7. **The Claude button** with six states and **the Claude panel** grouped by intent, with Pause and Hand back at the top.
8. **Pause and Hand back that visibly work**: Pausing… → Paused banner; a Hand back dialog with an optional note; red
   banners with the reason when anything fails.

## Design decisions

- **D1 - One rule for the next step.** `BoardStage` gains a structured `step` (kind, title, detail, command, action),
  built in `BoardStage.of` next to the existing `next` string (kept for `task_context` and older MCP servers). The
  Next card, `/alfred-guide` and `task_context` all read it. `task-view`'s `nextStepOf()` stops driving any "Next" UI;
  the Task tab keeps its own needs list (`needItems`), which is about requirements, not the next step.
  - `kind`: `CLAUDE` (a skill run - one button sends it to the board session), `RECORD` (press Record, then listen),
    `USER` (something only the user does: answer questions, write the code).
  - New Java enum `StepKind` is a NEW type (no new values on existing enums), and frontend models treat an unknown kind as
    `USER` (old frontend + new backend, new frontend + old backend both work: missing `step` → build it from `stage` with
    the copy table in `stage-copy.ts`).
- **D2 - Plain copy lives in one frontend table** (`shared/utils/stage-copy.ts`): per stage and per kind, the icon, the
  title template ("Sort the {inbox} new cards") and the sentence the prototype shows. Backend sends the numbers; the
  frontend words them. Tested against every `BoardStage.of` branch.
- **D3 - The ladder (Coded → Done) shows from Code on.** `phaseOf` stays; the ladder moves from `task-view`'s header
  onto the stage line (right side) and hides for DEFINE and TRIAGE.
- **D4 - One Claude control.** `board-session-button` becomes the Claude button + Claude panel. Modes: `start`,
  `resume` (a current session in STOPPED/IDLE), `busy` (Starting… / Resuming… / Pausing… / Handing back… / Waiting for
  your PC…), `on` (ANSWERING), `failed` (the last START/RESUME for this board FAILED and nothing started since), `held`
  (someone else), `elsewhere` (yours, on another PC). GONE sessions are ignored (already true since 601a3346's follow-up).
- **D5 - Pause = STOP; Hand back = one new helper command `RELEASE`.** Hand back must stop Claude too (today
  `HoldersService.release` only removes the holder; the runner keeps answering). `RELEASE {note: true|false}`: the
  helper writes the handover note when asked and the session is not open elsewhere (same prompt and NOTE card as the
  existing `HANDOVER`), stops the runner, reports STOPPED, then `POST /board/holders/release`. When the helper is
  offline, the browser releases the holder directly (no note) and says so - releasing must never depend on the PC.
  The note is the existing "Handover note" NOTE card (not the brief) - the prototype's wording is updated to match.
- **D6 - Every action shows that it landed and how it ended.** Pending command → button `busy` label at once; DONE →
  success banner; FAILED or HTTP error → red banner with the server's message and the next possible action. No
  `error: () => undefined`, no notice that vanishes.
- **D7 - Menus close on outside click and Escape**, never on `mouseleave` (today's menu closes when the pointer
  drifts off it on the way to Stop or Release).
- **D8 - Resume catches up by itself.** `RESUME` runs the existing catch-up (`SYNC`) right after resuming when chat
  messages arrived after the session's `lastChatSeq`; the panel shows the count ("Resume and catch up on 3 messages").
  The separate "Sync with the board chat" item goes.
- **D9 - Progress and failure reasons come from data that exists.** Starting step: the helper reports
  `progress` text with `state: STARTING` (new nullable `progress` column on `board_sessions`; old helpers send none →
  the button shows "Starting Claude…"). Failure reason: the latest FAILED START/RESUME command's `result` for the
  board, shortened by `failureLine()` (known patterns: not signed in, weekly/usage limit with reset time, NO_FOLDER,
  NOT_HERE, helper offline; else the first line).
- **D10 - Tokens meter**: `tokensToday` of the user's sessions today against My settings `budget.dailyTokens`; no
  budget set → "208k tokens today" without a bar.
- **D11 - Nothing in the header that a tab already has.** Cycle chips, relate cycle/board and shared-cycle badges move
  to the Cycles tab (`board-cycles`); `related-strip` is removed from the board page. Fetch attachments and Refresh from
  Azure move into `Azure ▾`.
- **D12 - No polling.** Every state change arrives on the existing `/ws/sessions`, `/ws/board` signals; the only timers
  are single deadlines (runner expiry, already in `live-strip`).

## Stop and Release today (found 2026-10-18, fixed by D5-D7)

1. `BoardSessionButtonComponent.releaseBoard()` subscribes with `error: () => undefined` - a 404/409 shows nothing.
2. `cmd('STOP')` closes the menu at once; only a send failure sets a short notice; nothing says "Pausing…".
3. STOP is a helper command: with the PC offline it waits QUEUED and nothing visible changes.
4. The menu closes on `(mouseleave)`.
5. Release frees the holder but does not stop Claude.

## Out of scope

- Moving a transcript between PCs, per-board budgets (031's "not built" list).
- The Task tab's own layout (only its header's Next/ladder move out).
- Any change to what a skill does.

## Risks

- `BoardStage` JSON gains a field: MCP `task_context` and older frontends ignore unknown fields (Jackson/TS) - covered
  by a test that parses the old shape.
- `RELEASE` is a new helper command kind: an old helper answers "Unknown command" → FAILED; the browser then releases
  directly (D5 fallback), so nobody is stuck. The helper self-updates within a heartbeat anyway.
- Removing `related-strip` from the page: its "shared with" verdicts dialog must stay reachable from the Cycles tab.
