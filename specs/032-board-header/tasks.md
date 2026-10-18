# 032 - Tasks: a board header that says one thing at a time

Read [plan.md](plan.md) first (decisions D1-D12). The clickable [prototype.html](prototype.html) is the behaviour spec;
[mock.html](mock.html) is the visual spec. Mark `[X]` done, `[~]` partly, `[ ]` open. Every task names its test.
Tests: backend in Docker JDK 21 (`-pl backend-board` / `-pl backend-sessions`), frontend `ng test --include=…`,
helper `node --test helper/test`, MCP `cd mcp-server && npx tsx --test test/<file>`.

## Phase 0 - Ground rules

- [ ] T001 Commit the open work first (helper 1.6.x start/resume fixes, runner self-stop, live-strip expiry,
  GONE sessions) so 032 starts from a clean tree.
- [ ] T002 Add `specs-mocks` to `.claude/launch.json` (done on 2026-10-18; check it is committed) - the prototype is
  reviewed through it.

## Phase 1 - Backend: one next step, progress, hand back

- [ ] T010 [D1] `backend-board/.../domain/model/BoardStage.java`: add `Step step` - record `Step(StepKind kind, String
  skill, String command, int count)`. New enum `StepKind { CLAUDE, RECORD, USER }` (new type, no new values on old
  enums). Fill it in every branch of `BoardStage.of`, keeping `next` exactly as today:
  DEFINE no brief → `CLAUDE alfred-setup`; DEFINE no items → `CLAUDE alfred-spec`; TRIAGE inbox → `CLAUDE alfred-triage
  count=inbox`; TRIAGE waiting → `USER count=waitingOnUser`; CODE → `CLAUDE alfred-fix count=toDo+inProgress`; VERIFY
  fixed → `CLAUDE alfred-verify count=fixed`; TEST → `RECORD alfred-listen count=untested|failing`; VERIFY unmarked →
  `CLAUDE alfred-verify count=unmarked`; CLOSE → `CLAUDE alfred-report`. `command` = `/<skill> <ref>`.
  Test: `BoardStageTest` - one assertion per branch (kind, skill, command, count) and `next` unchanged.
- [ ] T011 [D1] `BoardStageController` JSON carries `step`; a test parses the response with and without `step`
  (older backend) - `BoardStageControllerTest`.
- [ ] T012 [D1] MCP `mcp-server/src/tools/task.ts`: `task_context` keeps printing `NEXT:` from `next`; add
  `STEP: <kind> <command>` when `step` is present (agents get the exact command). Test in `mcp-server/test/task.test.ts`.
- [ ] T013 [D9] `backend-sessions`: nullable `progress TEXT` on `board_sessions` (ALTER when missing, like `os_user`),
  `BoardSession.progress`, `PUT /board/sessions` accepts it, cleared when state leaves STARTING. Test:
  `SessionsServiceTest.progressIsKeptOnlyWhileStarting`.
- [ ] T014 [D5] `HelperCommand.Kind` gains `RELEASE`; frontend `CommandKind` too. `SessionsService.queue` accepts it
  only from the board's holder (same check as STOP). Test: `SessionsServiceTest.onlyTheHolderMayQueueRelease`.
- [ ] T015 [D5] `HoldersService.release` unchanged in rules, but its refusals carry codes the UI maps
  (`NOT_FOUND` "Nobody holds this board - someone may have taken it", `HELD` "Only X can hand it back"). Test:
  `HoldersServiceTest` messages.
- [ ] T016 [D8] `GET /board/sessions` adds `unread` per session: board chat messages with `seq > lastChatSeq` (0 for
  the project chat when none). Test: `SessionsServiceTest.unreadCountsChatSinceTheSessionLastRead` (uses the chat
  port through `boardbridge`; no `backend-board` import from `backend-sessions` - ArchUnit).

## Phase 2 - Helper

- [ ] T020 [D9] `helper/alfred-helper.mjs` `start()`: report `progress` at each step - "Making the worktree",
  "Reading the task", "Opening in Claude Desktop" - with `state: 'STARTING'`. Test: START reports progress in order
  (`helper/test/alfred-helper.test.mjs`).
- [ ] T021 [D5] New command `RELEASE {note, boardRef}`: if `note` and the session is not open in Desktop/terminal, the
  same handover prompt as `HANDOVER` (one "Handover note" NOTE card); then `stopRunner`, `report STOPPED`,
  `POST /board/holders/release`. Result text: "Handed back - handover note written" / "- no note (open in Desktop)".
  Test: RELEASE with and without note; release is called after STOP.
- [ ] T022 [D8] `resume()`: after the resume turn, when `args.unread > 0`, run the existing SYNC catch-up turn in the
  same command. Test: RESUME with unread runs one catch-up turn; without, none.
- [ ] T023 Bump `VERSION`, run `node --test helper/test`, check the helper self-updates on the Docker stack.

## Phase 3 - Frontend building blocks

- [ ] T030 [D1] `core/models/board.models.ts`: `BoardStage.step?: { kind: 'CLAUDE'|'RECORD'|'USER'|string; skill:
  string|null; command: string|null; count: number }`; unknown kind → treated as `USER`.
- [ ] T031 [D2] `shared/utils/stage-copy.ts` + spec: `stepCopy(stage, step, ctx)` → `{ icon, title, detail, verb }`
  with the prototype's words for every `BoardStage.of` branch (Define the task / Write the requirements / Sort the N new
  cards / Answer the N questions waiting on you / Fix the N To do cards / Check the N fixed cards / Test it in the app /
  Mark the N remaining items / Close the task) and the button verb ("define it", "triage with me", "fix them",
  "verify", "watch while I test", "write the close-out"). Fallback when `step` is missing: derive from `stage` + `next`.
  The spec walks every branch and checks no command text leaks into `title`/`detail`.
- [ ] T032 [D9] `shared/utils/failure-line.ts` + spec: `failureLine(result)` → one plain sentence + action for: not
  signed in, weekly/usage limit (with reset time copied), `NO_FOLDER`, `NOT_HERE`, helper offline, "Input must be
  provided"; else the first line. Fixtures from the real results of 2026-10-18.
- [ ] T033 [D7] `shared/directives/close-on-outside.directive.ts` + spec: emits on a click outside the host and on
  Escape; used by every new menu and panel. No `mouseleave` closing anywhere in the header.
- [ ] T034 [D6] `shared/components/banner.component.ts` + spec: `kind: ok|bad|wait`, text, up to two actions, ✕;
  one banner slot on the board page, last one wins.

## Phase 4 - The header (board page)

- [ ] T040 Header row in `pages/board/board-page.component.ts`: remove the `<h1>Board</h1>` (the nav says Board).
  `app-board-picker` collapses to "▦ Boards ▾"; then the `AB#59851` chip (`board-ref` style: main item id, else the
  board's short name), the plain title (`h2`, flex 1, ellipsis, full name in `title`); the project select; `Open ▾`;
  💬 Chat; the Claude button. One row at ≥1150 px; under it the title wraps to its own line (prototype media query).
  The Boards ▾ menu lists each board as "<ref> · <plain title>" with "<project> · <stage> · <holder or free>" under it,
  then "＋ New board". The project's default board (`default:<project>`, no stage) shows the project name as title, no
  ref chip, no facts/stage line and no Next card - only the Claude button and the cards. Tabs show plain counts
  ("Calls 2", not "2 cycles"). Test: `board-page.component.spec.ts` - one row, title tooltip = full name, `<h1>` gone,
  default board has no stage line or Next card, Boards ▾ items show the stage.
- [ ] T041 Title rule: strip a leading `#<id>_<code>_` / `#<id>_` prefix and the `AB#id` from the board name for the
  plain title (`shared/utils/board-title.ts` + spec with "#59851_Q4-INTE-CORE-015 Baggage Bundle…" →
  "Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"").
- [ ] T042 `Open ▾` (new `board-state-menu` component): shows the state (● Open / Done / Archived), menu items with
  one-line explanations - ✓ Mark done, ⌂ Archive, ↺ Reopen (when not Open), ✕ Delete board… (red, existing delete
  confirm). Moves these actions out of `related-strip`. Test: menu items per state; delete still confirms.
- [ ] T043 Facts line: "Work item <type> · <state>" (from `work-item-strip`'s data), "· N cards" ("no cards yet"),
  "· ⚑ N wait on you" (from next-steps' `waitingOnUser`, clickable → opens the first), the stage's own count in amber
  when it has one ("2 Fixed waiting" in Verify, "2 To do" in Code, from `BoardStage.counts`), and `Azure ▾` on the right with
  ↻ Refresh from Azure (result line goes to the banner, T034), ⇩ Fetch attachments ("Enter a token on the Team tab"
  as a banner when no token), ↗ Open AB#… in Azure. Hidden parts when the board has no main item. Test: facts for a
  board with and without a main item.
- [ ] T044 [D1, D3] Stage line: rewrite `stage-strip` to circles + lines (done ✓ green, current filled blue with its
  number, rest faint), tooltips = `STAGES[].hint`; the Coded → Done ladder (`PHASES`, `phaseOf`) on the right only for
  CODE, VERIFY, TEST, CLOSE. Remove from `stage-strip`: the "Next: …" text, Copy, "Not defined yet" box, Ask Claude in
  chat, Refresh from Azure (moved to T043/T045). Test: `stage-strip.component.spec.ts` per stage; ladder hidden in
  DEFINE/TRIAGE.
- [ ] T045 [D1, D2] New `next-step-card` component: icon, "NEXT STEP", title, detail (from T031), actions:
  - primary: `CLAUDE` → "▶ Ask Claude to <verb>" when Claude is on (queues the skill run on the board session -
    existing `/board/skill-runs`), "▶ Resume Claude and <verb>" when paused (RESUME then the run),
    "▶ Start Claude and <verb>" when there is none (START with `thenRun`, existing), disabled "Claude is getting
    ready…" while busy; `RECORD` → "● Record and <verb>" (starts recording; with Claude on it also starts listen);
    `USER` → "Open them" (opens the waiting cards / To do column).
  - "⧉ Copy for terminal" copies `step.command`.
  - "Other steps ▾": every skill with its plain name and command (Define or re-define, Write or change the spec, Triage
    the Inbox, Fix, Verify, Listen while you test, Report) + "Continue on another machine" (copies `/alfred-resume
    <ref>`). Replaces `task-view`'s Run ▾ menu.
  - first start on a PC with no folder → opens the Claude panel's start view (T052) instead of failing.
  - no PC connected (no paired helper) → the primary opens the existing Connect this PC dialog; "Copy for terminal"
    still works for people who run Claude themselves.
  - the board answered by a terminal `/alfred-live` (no helper session, a live runner or cycle chat on the board) →
    Claude counts as on: the primary posts the command to the board chat (today's "Ask Claude in chat"), labelled
    "▶ Ask Claude to <verb>".
  Test: `next-step-card.component.spec.ts` - each kind × Claude state picks the right button and command.
- [ ] T046 Recording line: "● Record" (red outline) + "Record the calls while you test this task." + faint "Recordings
  and related boards are on the Cycles tab."; while recording "● Recording · N calls" (filled) + "Stop when you finish
  testing."; uses `related-strip`'s existing `record('REC')` call. Test: both states.
- [ ] T047 [D11] Remove `app-related-strip` from the board page; in `board-cycles` (Cycles tab) add what it had: the
  cycle chips with REC and "shared · N" badges (verdicts dialog), ✕ unrelate, "＋ relate cycle or board", related
  boards. Test: `board-cycles.component.spec.ts` covers relate/unrelate and the verdicts dialog.
- [ ] T048 [D1, D3] `task-view` header: remove "▶ Next" + `nextStepOf` UI, the Run ▾ menu (moved to T045) and the
  stepper/verdict row (moved to T044); keep tickets/branch chips, `app-work-item-strip`'s Fetch attachments only when
  the Task tab is open. `nextStepOf` stays only if the Task tab still needs it - else delete it with its spec. Test:
  `task-view.component.spec.ts` updated.
- [ ] T049 [D1] `next-steps-bar` (cards view): drop it from `board-view` when the board has a stage (the Next card
  owns guidance); keep it for the project's default board, where there is no stage. Its "⚑ waits on you" moves to the
  facts line (T043). Test: `board-view` spec - no bar on a task board, bar on `default:<project>`.
- [ ] T050 [D12] `live-strip`: never render idle rows - "○ No chat handles this cycle" and "✦ Claude stopped · checked
  0 calls" go; the answerer row merges into one live row: "● Claude on <PC> · <what it does now> · N waiting" with
  Open in Desktop and Stop, shown only while a run is RUNNING, listen is on, or the agent is WATCHING. Test:
  `live-strip.component.spec.ts` - idle renders nothing; running renders one row.

## Phase 5 - The Claude button and panel (`board-session-button`)

- [ ] T051 [D4] Button modes and words: `▶ Start Claude` (blue), `▶ Resume Claude` (outline), `◌ Starting Claude…` /
  `Resuming…` / `Pausing…` / `Handing back…` / `Waiting for your PC…` (amber spinner, tooltip = `progress`, T020),
  `● Claude on` (green), `⚠ Claude didn't start` (red, from the latest FAILED START/RESUME, T032), `🔒 <name>'s Claude`
  (held), `Claude on <PC>` (elsewhere), `● Claude on · terminal` (a terminal `/alfred-live` answers the board, no helper
  session - its panel offers only "How to stop it": the `/alfred-live stop` command to copy, and Start Claude here,
  which takes the board over through the newest-wins rule). Split button: main action + ▾ opens the panel. Test: one
  spec case per mode.
- [ ] T052 Panel - start view (no session; replaces the `folder` dialog when the PC has no folder): "▶ Start Claude for
  this board", one sentence (runs on your PC, your account, your copy; Alfred passes messages), "Where is <project>'s
  code on <PC>?" with the folder field + Browse… (existing PICK_FOLDER), the worktree sentence, "Show the conversation
  in" pills (Claude Desktop / Terminal / Both / Nowhere - board only → `openIn`), the line "Asked once and kept in My
  settings. Each board gets its own worktree there, so boards never mix their changes.", Start / Cancel. A known folder →
  just "▶ Start Claude" + "Change the folder in My settings". Not paired / helper offline → the existing `pair` /
  `helper` dialogs, unchanged. Test: start view with and without a folder.
- [ ] T053 Panel - on view: header "● Claude is answering this board", "On <PC> as <account> · since <time>", tokens
  meter (D10). Quick bar (sticky, top): `⏸ Pause Claude` | `↩ Hand the board back`. Groups: SEE THE CONVERSATION (🖥
  Open in Claude Desktop - "the board waits while it is open"; ⌨ Open in a terminal - `claude --resume <id8>`; hint
  "Not in Desktop's list? … Restart Desktop" with the existing confirm); WHILE YOU TEST (👂 Watch a recording / Stop
  watching - existing LISTEN/STOP_LISTEN and the `listen` dialog); THIS SESSION (＋ Start fresh; ⇄ Earlier sessions -
  N on this board → existing `sessions` dialog). Footer: ☰ Who did what (audit), ⧉ Copy session id, ⚙ My settings.
  Panel `max-height: calc(100vh - 150px)`, scrolls inside. Test: items present; Sync item gone.
- [ ] T054 Panel - paused view: "Claude is paused", "Last answered <ago> on <PC> · <unread> new chat messages since"
  (T016), primary "▶ Resume and catch up on N messages" (RESUME with `unread`, T022) + "↩ Hand back"; Or: Start fresh,
  Read it in Claude Desktop (OPEN_DESKTOP without resuming), Earlier sessions; footer Who did what, My settings. Test.
- [ ] T055 Panel - failed view: "⚠ Claude didn't start", the `failureLine` sentence, "↻ Try again" (same command) and
  Close. Test with the weekly-limit fixture.
- [ ] T056 [D5, D6] Pause flow: Pause → button `Pausing…` at once → when the STOP command is TAKEN and the PC is slow,
  banner `wait` "Waiting for your PC to pause Claude - it finishes the answer it is writing first" → on DONE the
  session is STOPPED: banner `ok` "Claude is paused. Messages you send now wait. ▶ Resume continues the same
  conversation." with Resume now. Helper offline (no heartbeat 2 min) or FAILED → button back to `Claude on`, banner
  `bad` "Couldn't pause Claude. Your PC (<PC>) is not connected… it pauses as soon as the PC reconnects." with ↻ Try
  again / Hand back instead. All driven by `/ws/sessions` command signals. Test: each transition with fake signals.
- [ ] T057 [D5, D6] Hand back flow: dialog "Hand <ref> back?" - "Use this when you are done for now, or someone else
  should continue." - three bullets (Claude stops answering on <PC>; your session is kept; anyone may take the board),
  checkbox "Leave a note for whoever continues" (default on; "Claude writes where things stand and the next step as a
  Handover note card before it stops"), Cancel / ↩ Hand back. Hand back → `RELEASE` command (T021); helper offline →
  `POST /board/holders/release` directly + banner "Handed back without a note - your PC is offline". Success banner
  `ok` "You handed the board back. Claude stopped answering; your session is kept (and it left a Handover note).
  Anyone may take the board now." with "Take it again" (existing take). Errors → banner `bad` with T015's message.
  Replaces `releaseBoard()` and its silent `error: () => undefined`. Test: dialog, both paths, error banner.
- [ ] T058 [D7] Every menu and the panel close on outside click / Escape (T033); remove `(mouseleave)="menu.set(false)"`.
  Test: pointer leaving the menu keeps it open; outside click closes it.
- [ ] T059 Held and elsewhere: `🔒 <name>'s Claude` → existing `held`/`request` dialogs ("ask them to hand it over");
  elsewhere → existing `notHere` dialog with plain words ("Claude for this board runs on <PC>"). Words only; logic
  unchanged. Test: labels.
- [ ] T060 Word sweep (exact replacements): ▶ alfred-live → ▶ Start Claude; Live · session x → Claude on; Answer the
  board again → Resume Claude; Stop answering (keep session) → Pause Claude; New session for this board → Start fresh;
  Switch session… → Earlier sessions; Sync with the board chat → (removed, D8); Listen to a cycle (background lane) →
  Watch a recording; Release the board → Hand the board back; Board audit → Who did what; Restart Claude Desktop to show
  it → hint under Open in Desktop. Includes `connect-pc` and `me-page` mentions. Test: a spec greps the templates for
  the old words.

## Phase 6 - Docs, skills, mock

- [ ] T070 `docs/board.md`: "Board sessions", "The task's stages" and the board page section rewritten for the new
  header, the Claude button states, Pause/Hand back, and the one-rule Next card (`BoardStage.step`).
- [ ] T071 `docs/server.md`: the helper's RELEASE command and `progress`; `CLAUDE.md` 031 line: "Release" → "Hand
  back (RELEASE: note, stop, release)", and the 030 line: "the stage strip" → "the stage line and the Next card".
- [ ] T072 `skills/alfred-live/SKILL.md`, `skills/alfred-guide/SKILL.md`: UI names (▶ Start Claude, Claude on, Pause,
  Hand back, Next card). `pytest tests/python/test_alfred_skill.py` stays green.
- [ ] T073 Prototype/mock wording: the handover note is a "Handover note" card, not "in the brief" (D5) - update
  `prototype.html` and `mock.html`.

## Phase 7 - Verify

- [ ] T080 Full suites once: backend (Docker JDK 21), frontend `npm test` + `npm run build`, helper, MCP, Python skill
  tests; `docker compose build backend frontend`.
- [ ] T081 Live walk-through on AB#59851 in Docker, following the prototype tour step by step (screenshots in
  `specs/032-board-header/shots/`): header in one row; stage line + ladder rules; Next card at Define with Claude off →
  first start panel → Starting… with progress → Claude on → the run goes to the session; Pause → Pausing… → Paused banner
  → chat message → Resume and catch up on 1 message; Hand back with note → note card on the board, session STOPPED,
  holder gone, Take it again; PC offline (stop the helper) → Pause shows the red banner, Hand back releases without a
  note; idle board shows no status rows; Today vs new compared side by side.
- [ ] T082 Narrow window (1000 px) and the browser pane: header wraps as designed, panel fits the screen.

## Not built (prototype only)

- The guide column, its tour, "What just happened" log, the New design / Today switch, "Simulate: my PC is offline" and
  clicking a stage to jump - they explain the idea and are not part of the app.
- The demo cards in the columns.

## Coverage - every mock/prototype element → task

| Mock / prototype element | Task |
|---|---|
| Boards ▾ (with stage per board, New board), AB# chip, plain title with tooltip, no "Board" h1 | T040, T041 |
| Default project board without stage/Next card; plain tab counts | T040 |
| Board answered by a terminal /alfred-live; no PC connected | T045, T051 |
| project select, 💬 Chat | T040 |
| Open ▾ with Mark done / Archive / Reopen / Delete… | T042 |
| Facts line: work item, state, cards, ⚑ waits on you | T043, T049 |
| Azure ▾: Refresh, Fetch attachments, Open in Azure | T043 |
| Stage line circles, tooltips | T044 |
| Ladder from Code on | T044, T048 |
| Next card: icon, title, detail per stage | T010, T031, T045 |
| Primary button per Claude state, getting-ready state | T045, T051 |
| Copy for terminal, Other steps ▾, Continue on another machine | T045 |
| ● Record / Recording · N calls line | T046 |
| Cycle chips, relate, shared badges → Cycles tab | T047 |
| Task card's Next/Run/stepper removed | T048 |
| next-steps-bar merged | T049 |
| No idle rows; one live row with Open in Desktop / Stop | T050 |
| Claude button: 6 states + Pausing / Handing back | T051, T020, T032 |
| Start panel: folder, Browse, Show the conversation in | T052 |
| On panel: header, meter, Pause / Hand back bar, groups, footer, scrolls | T053, T016 |
| Paused panel: unread, Resume and catch up, Read in Desktop | T054, T016, T022 |
| Failed panel: reason, Try again | T055, T032 |
| Pause flow incl. waiting and offline banners | T056 |
| Hand back dialog, note, offline fallback, Take it again, errors | T057, T021, T015 |
| Menus close on outside click / Escape | T033, T058 |
| Held / elsewhere | T059 |
| Words old → new | T060, T072 |
| Narrow layout | T040, T082 |
| Simulated offline (prototype only) | T081 (done for real by stopping the helper) |

## Dependencies

- T010 → T011, T012, T031 → T045. T013 → T020 → T051. T014 → T021 → T057. T016 → T022 → T054.
- T033, T034 before Phase 4/5 UI tasks. T047 before removing `related-strip` from the page (T040 lands last in Phase 4).
- Phase 6 after Phase 5. Phase 7 last.
