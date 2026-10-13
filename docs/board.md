# Task board

The board (specs/014-task-board) tracks bugs, tasks, notes and questions next to the traffic they are about. There is one board per project, and each session cycle has a view of its own cards. Claude adds findings to it through the MCP tools. The user sorts them, and the history of every card records what was done.

## Where it lives

- **Backend**: the leaf slice `backend-board`, with its own `board.db` (`BOARD_DB_FILE`, default `/appdata/board.db`; `board.db` in the native data folder). It exposes REST under `/board` and the `/ws/board` signal. SQLite only: the slice is new, so there is no flat file to migrate (the same reasoning as `backend-triage`).
- **Bridge**: `backend-app/boardbridge` holds everything that touches other slices:
  - `BoardEditAccess` and its interceptor apply the edit rule.
  - `BoardCallSignatureAdapter` builds signatures from `CallRefResolver` and triage's `NormalizeEndpointUseCase`.
  - `BoardCycleRemovedAdapter` implements session-cycles' `CycleRemovedPort`.
  - Kept calls go through `storage/CommentedCallsKept`: its `BoardMentions` component implements the board's `MentionedCallsChangedPort`.
- **Frontend**:
  - The Board tab (`/board?project=&cycle=&card=`) and the session cycle page's Calls / Board / Task tabs both use one `BoardViewComponent`. Each view gets its own `BoardStateService`.
  - Every call card (`call-actions`) shows the cards that mention the call and a **＋ Board** button.
  - There is one `SpecViewerComponent` in the main layout.
- **MCP**: `mcp-server/src/tools/board.ts` provides `board_list`, `board_get`, `board_add`, `board_comment`, `board_move`, `board_flag`, `board_closed_reasons`, `get_brief`, `read_spec` and `board_status`.

## Cards

- **Kind**: Bug, Task, Note, Question.
- **Flags**: Urgent, Risk, Blocker, Affects project, Needs decision.
- **Scope**: Not decided, In scope, Out of scope. Only the user sets scope.
- **Status columns**: Inbox, To do, In progress, Fixed, Verified, Done, Closed.
  - Closed always carries a resolution:
    - **Fine - not an issue**
    - **Not in this flow** (this also sets Out of scope)
    - **Won't fix**
  - Buttons show the short labels ("✓ Fine", "⊘ Not in flow"); chips and exports show the full names.
- **Numbers** are unique per project and never reused. `card_numbers` remembers the highest number ever given, so a deleted card's number stays retired.
- **Concurrent edits**: a PATCH carries only the fields it changes, and each changed field writes one activity entry. Two tabs editing different fields both win; for the same field, the later edit wins. There is no version check.
- **Done and Closed cards are kept forever.** Only the user deletes a card, after a confirmation. A deleted card takes its history and mention rows with it.
- **Undo** (`POST /board/cards/{id}/undo-close`): the toast offers it for 7 s, and the server allows it for 60 s. It restores the state recorded in the close's own RESOLUTION entry, and only while nothing but a reason was added after the close.

## Teams

Every card can be assigned to one or more **teams** (Settings → Teams, stored in board.db's `teams` table; a card keeps
its team ids in `cards.teams`, a comma list like its flags). A problem that needs several teams is one card with all of
them, and its description has a short `### <Team>` section per team. Alfred starts with six teams - Frontend, Backend,
Database, Integrations, DevOps, QA - added once (`board_meta.teams_seeded`), so deleting them all does not bring them
back. Each team has:

- **Owns**: what it is responsible for, in plain words. Claude reads it (`board_teams`) to pick a card's teams.
- **Hints**: short texts (`.java:`, `/Booking2/`, `com.x.supplier`, `galileo`, `@[stmt:`). A card created without teams
  gets every team whose hint appears in its title or description (case ignored, `/` and `.` the same), recorded as
  "From the teams' hints: ...". `TeamHints` in backend-board.

A team's id is made from its name once and never changes, so renaming keeps every card's teams; deleting a team takes it
off every card. Teams change through `PUT /board/cards/{id}/teams` (`{teams, reason}`) - from the drawer's Teams
control or Claude's `board_assign`. Claude may assign or reassign **any** card at any time but must give a reason; the
user can change them too. Every change is one `TEAMS` history entry with the old teams, the new ones and the reason.
The board filters by team (`team=<id>`, `-` for cards with no team), and exports, "Copy as issue" and import carry the
teams (an import keeps only the teams this Alfred has).

## Mentions

`@[type:ref|label]` inside Markdown text. The grammar is in `specs/014-task-board/contracts/mention-syntax.md`; the vectors in `specs/014-task-board/vectors/mentions.json` are run by both `MentionParser.java` and `mention-syntax.ts`.

Types: `call` (`in:<id>` / `out:<id>`, plus `@<cycleId>` for a captured call), `stmt` (`<callId>/<seq>`), `log` (`<callId>/<lineId>`), `redis` (`<callId>/<seq>`), `spec` (`<cycleId>/<file>#<section-slug>`), `code` (`path:line`), `cycle`, `spacer` (`<cycleId>/<spacerId>`), `card` (`<project>#<n>`), `rule`.

- **The text is the source of truth.** On every save, the backend re-extracts the mentions of that owner (card description, comment, brief, or checklist evidence) into the `mentions` index. That index feeds the Linked list, the card badges on calls, and kept calls. Links added with "+ link" are stored as owner `DIRECT`.
- **Kept calls**: a live call that any card mentions is kept out of the storage limits' deletions, like a call with a comment. This is governed by the same Settings → Storage rule. The board reports changes, so a newly mentioned call is kept at once rather than after the 30 s cache expires. Captured cycle calls are already kept with their cycle.
- **Removed items**: a mention whose item is gone shows struck through with its saved label. The text around it is untouched.
- **Rendering**: `markdown-blocks.ts` builds a typed tree that `MarkdownViewComponent` renders with bindings, never `innerHTML`. Links are kept only for `http(s)` URLs.

## Inbox sorting

- Each Inbox card has one-click **Fine / Not in flow / To do**, also on the F, N and T keys.
- **Triage mode** shows the Inbox one card at a time, with a reason box and F / N / T / S.
- **Bulk actions** apply to the selected cards (X or Shift+click), up to 200 per request.
- **Reopen** sends a closed card back to the Inbox.
- **"Looks like a closed card"**: when the first call a card mentions gives a signature (`<5xx|4xx|error|ok>|<METHOD> <endpoint pattern>`, using triage's endpoint grouping) that matches a closed card in the same project, the Inbox card shows that card and its reason.

## Cycle brief, spec files, checklist

- **Brief**: Markdown with mentions, up to 256 KB.
- **Spec files**: `.md` / `.txt` only, by upload, drop or paste. Up to 5 MB each and 50 per cycle. A file with the same name replaces the old one; there are no versions. Every card that mentions a replaced file gets a "spec replaced" entry.
- **Acceptance checklist**: the list items under a spec file's first heading that contains "acceptance". The user marks each one pass, fail or can't tell, with evidence. A mark is keyed by the SHA-256 of the item's normalized text, so it survives a replace that leaves the item unchanged. Claude never marks an item; it **suggests** a mark with evidence (`checklist_suggestions`, `PUT .../checklist/{file}/{item}/suggestion`). The suggestion shows grey under the item with Accept and dismiss. Accepting writes the user's own mark with Claude's evidence. Any mark the user sets clears the suggestion.
- **Deleting a cycle** removes its brief, spec files and marks. Its cards stay on the project board, marked "cycle deleted".

## The Task tab

A session cycle is a task (skills/_shared/rules.md §0). The cycle page's **Task** tab and the Board's cycle view show it
with `TaskViewComponent`. Everything comes from what `/board` already serves (brief, checklist, cards, steps, session
log) and is derived in `shared/utils/task-view.ts`; there is no backend model of its own. It re-fetches on each
`/ws/board` signal and never polls.

- **The brief, by section**: the one-line goal, `## Task` (ticket ids and the branch), `## Description` (the ticket as
  written), `## Scope`, `## Out of scope`, `## Decisions`. `## Test steps` and `## Data` show under "How to test it".
  Other headings show as written, and a brief with no headings shows whole. Edit opens the template on an empty brief.
- **Requirements** are the Acceptance items, labelled R1, R2 … across the spec files. Each one's state is taken from
  the user's mark first (Pass = met), then the cards linked to the item (an open BUG = bug, an open TASK = missing,
  FIXED = waiting on a re-test), then Claude's suggestion. An item with none of these shows "not checked". Problems
  come first and met items fold away. Pass / Fail / Can't tell and Accept ✦ write the same marks as the checklist.
- **The verdict** answers "does the code match the task?". Its tiles count each state, notes and "not in task"; a tile
  filters the view. **The phase** reads Coded → Verifying → Fixed → Re-tested → Done from the same data. Done means every
  requirement is marked Pass by the user and no bug or task card is open or Fixed.
- **Claude's notes**: open NOTE cards not linked to a requirement, plus TASK cards no requirement names. A NOTE titled
  `Not in the task: …` goes under **Changed, but not in the task** instead. It is code the branch changes that the task
  never asked for.
- **Needs you**: open cards with a question, a proposal, or waiting on the user. **Done when** is the hand-over rule,
  checked live.
- **Continue anywhere**: the `/mcp__alfred__resume <task>` command. The MCP's `task_context` derives requirement states
  the same way (`requirementState`), so the user and every Claude session see one picture.
- The spec files and the full acceptance checklist stay beside it, unchanged.

## Live answers

`/alfred-live` shows its work on the card while it happens (docs/mcp.md "Live answers"): `PUT /board/live-work` (the
runner's report of one run: heading, steps, draft, state), `GET /board/live-work?project=` (running and recently
ended runs) and `POST /board/live-work/{id}/stop` (the user's Stop). `LiveWorkService` keeps them in memory only - a
run is work in progress, never a record; the reply itself is the card's ordinary comment - and signals each as a
`live-work` message on `/ws/board`. The frontend's `LiveWorkStateService` holds them for the column card (spinner and
current step), the drawer (`app-live-work-box`) and the live strip.

## Claude's limits

These are enforced in `BoardService` and `CycleBriefService` whenever `X-Alfred-Actor: claude` is sent. The MCP tools send it on every board request.

- New cards always land in the Inbox.
- Claude may move cards only to To do, In progress or Fixed, and never out of Verified, Done or Closed.
- Claude may not set scope, close, reopen, delete, bulk-edit, undo, set a reason, mark the checklist, or write briefs and spec files.
- A Claude comment must give Did, Found and Next; Impact is optional. The two other kinds are a **reply** (`**Reply** ...`, an answer to the user) and a **question** (`**Question** ...`). A question also flags the card Needs decision. Other free text is refused.
- Claude may rewrite the title, description, kind, cycle or project only of **its own** cards, and only while they are in the Inbox. It may set flags on any card.
- Verified, Done and closing stay the user's. Claude **proposes** them instead (`proposals` table, one open per card, `PUT /board/cards/{id}/proposal`). Allowed proposals: Verified for a Fixed card, Done for a Fixed or Verified card, and a close with its resolution for an open card. The card and the drawer show "✦ Claude proposes ..." with Accept and Dismiss. Accepting takes the step as the user's own move or close. If the card changed so the step no longer fits, accepting drops the proposal instead. The history records PROPOSED, PROPOSAL_ACCEPTED and PROPOSAL_DISMISSED.
- While the live strip is **paused**, Claude's new cards are refused. A card whose call links match a card closed as Fine or Not in this flow is refused with that card's number and reason; Won't fix does not block.
- These are guardrails against an agent overreaching, not a security boundary: anyone with edit access can do what the UI does.

The live strip status is held in memory per project. It reads as STOPPED when it has not been updated for 10 minutes. The backend computes that on read; the frontend arms a single timer to the deadline, which the no-polling rule allows.

## Replies and answers

Every comment in a card's history has **↩ Reply**: the reply is stored with `reply_to` (the comment it answers) and
shown indented under it. Threads are one level - a reply to a reply points at the thread's first comment - and must
stay on the same card. Claude's question (a comment starting `**Question**`, from `board_ask`) shows **waiting for
you** until the user replies to it, then **✓ answered**; its button reads **Answer**, with "Clear Needs decision"
ticked: the flag comes off only when no other question on the card is still unanswered (`BoardService.unansweredQuestions`).
The answered state is worked out from the replies, never stored. Exports note "↳ reply to ..." on each reply, and the
.json export carries each entry's `id` and `replyTo`, which an import maps to the new ids. Claude sees the threads in
`board_get` ("↳ reply to [i]", `openQuestions`), answers one exact comment with `board_reply`/`board_comment`
`replyTo` (a history index), and `board_changes`/`board_wait` say "ANSWERS your question" for the user's answer.

## Claude working from anywhere

Read-only endpoints in `BoardInsightsService` / `BoardInsightsController` let a new session pick the work up without the user repeating it:

- `GET /board/search`: cards on every board when `project` is omitted, filtered by status, kind, flag, author, text, `since` and `claudeTouched`. Each card comes with its latest comment, in full.
- `GET /board/similar`: cards in any status with the same signature as a call, or with at least two title words in common. Claude reads these before adding a card.
- `GET /board/changes?cursor=`: every history entry after the cursor with its card, plus the briefs, spec files, marks and suggestions written in cycles. The cursor is `<activityId>.<millis>`. Two special cursors exist: `now`, and `claude`, which means just after Claude's own last entry. `actor=USER` keeps only what the user did.
- `GET /board/changes/wait`: the same answer as soon as anything changes, or an empty one after `timeoutSeconds` (at most 50, under the gateway's 60 s read timeout). It is a `DeferredResult` woken by `BoardChangeFeed`, which fires with every /ws/board signal. There is no polling. The waiter subscribes before it reads, so a change in between is not missed.
- `GET /board/verify?project=&cycleId=`: each Fixed card's signature compared with the calls a re-test cycle captured to the same endpoint. The calls are signed by `boardbridge/BoardCycleCallsAdapter` the same way as a card's call. The verdict is LOOKS_FIXED (every call is ok now), STILL_FAILING or NOT_EXERCISED.
- Call badges now carry the card title, so `board_for_call` can say which card a call is on.

The MCP tools built on these are listed in docs/mcp.md: `board_search`, `board_changes`, `board_wait`, `board_get`, `board_evidence`, `board_for_call`, `board_similar`, `board_verify`, `board_retest`, `board_retest_plan`, `board_reply`, `board_ask`, `board_fix`, `board_edit`, `board_link`, `board_add_many`, `board_propose` and `board_suggest_mark`. `board_get` returns every comment in full. A comment over 6000 characters is read in parts with `entry`, and the history is paged with `historyOffset`. Nothing is cut silently.

## Waiting on, hand-off and the skills' helpers (specs/015)

- **Waiting on** (`card_waiting`: USER / CLAUDE / RETEST / NONE, since, set by): Alfred sets it on events in
  `BoardService` - Claude's new card or question or proposal → USER, the user's answer to the last open question →
  CLAUDE, To do / In progress → CLAUDE, Fixed → RETEST, Verified / Done / closed → NONE, reopen or back to the Inbox →
  USER - and Claude sets it explicitly with `waitingOn` on a comment. The "since" time stays while it does not change.
  Cards show "waiting on you · 2 d"; the board filters Waiting on me / on Claude / Needs re-test.
- **Next-step bar** (`GET /board/next-steps`): what waits on the user oldest first (why: question, proposal, inbox),
  To do, Fixed needing a re-test, Inbox - with copy buttons for the `/alfred-*` command to paste into Claude Code.
  Every card has a copy button for its next skill; the cycle's Brief panel for `/alfred-review`, `/alfred-listen`,
  `/alfred-spec`.
- **Answer from the board**: a card with an open question has Answer (and the **A** key) - the questions one at a
  time, Clear Needs decision taking effect with the last answer.
- **Claude-written briefs and spec files**: allowed (the skills ask first); `updated_by` / `uploaded_by` record the
  author and the replaced version is kept once (`prev_*` columns) - **Restore previous** swaps them, so a second click
  undoes the first. Restoring and deleting stay the user's.
- **Unread** (a dot on a card Claude changed since this browser last opened it, "(n)" in the tab title) is kept in
  localStorage per browser; **desktop notifications** for Claude's new questions and proposals are opt-in (🔔), woken by
  /ws/board and read from `/board/changes` (actor CLAUDE) - never polled.
- **Live step**: `board_status` `step` - what Claude is doing now, on the strip.
- **Session log** (`cycle_log`): one Did / Found / Next entry per skill run, in the cycle's Brief panel.
- **Spec coverage**: `card_spec_items` links a card to the Acceptance items it breaks (the checklist shows the cards
  per item); **test steps** are the numbered list under the brief's "Test steps" heading, ticked SEEN / FAILED by
  listen and review (`cycle_steps`).
- **Card management**: **blocked by** (`card_blocks`, same project, no cycles of two); **merge** and **reopen**
  proposals (`proposals.kind`): accepting a merge moves the source's history, mentions, links, spec items and blocks
  to the target and closes the source as DUPLICATE "merged into #n"; accepting a reopen sends a Done / Verified card
  back to To do (a closed one is reopened to To do). **Regression watch** (`GET /board/regressions`): Done / Verified
  cards whose endpoint failed again the same way in the newest live inbound calls after the card was finished
  (`boardbridge/BoardCycleCallsAdapter` signs them like a card's call). **Copy as issue** builds Markdown for Jira /
  GitHub in the browser (`shared/utils/board-skills.ts`).

## Re-test without a cycle (specs/016)

A Fixed card is re-tested by the **live calls to its endpoint made after the fix** - the user just uses the app. A
re-test cycle is optional: given, only its calls count.

- **Plan** (`retest_plans`, `PUT /board/cards/{id}/retest-plan`): what "fixed" means as **expectations** - SQL_COUNT
  (at most `max` statements on `table`, from database capture's Tables view), STATUS (`2xx`, `200`, `!405`, `!5xx`),
  NO_LOG (no caught ERROR, or WARN and ERROR), DURATION (at most `max` ms, judged after `minCalls`, default 3) and
  SAME_RESPONSE (the JSON `path` value equals the original call's) - and **steps** (what to do in the app, with the
  endpoint whose call shows it was done). Claude writes it with `board_fix`; the user edits it in the drawer, with
  suggestions by card type. Claude may not change a Done or closed card's plan.
- **Check** (`RetestService`, `GET /board/retest?project=&numbers=&cycleId=`): the newest 2000 live inbound calls (or
  the cycle's), the card's endpoint, after the last status change; at most 10 calls per card, newest first. Each
  expectation is judged per call with the original call's value beside it (before → after), facts read by
  `boardbridge/BoardCallFactsAdapter`; what was not captured (◆ off, ▤ off) is UNKNOWN, never a pass. Verdict: PASSES,
  PARTIAL (a step not seen, a duration waiting for calls, something unknown), FLAKY, FAILS, NO_CALLS, NOT_CHECKABLE (no
  call on the card). Without expectations only the status is compared (`statusOnly`), against the class the card's
  signature failed with.
- **Watch**: `boardbridge/BoardRetestWatchAdapter` offers every completed inbound call to the board; a Fixed card (or
  a Verified / Done card with expectations) watching its endpoint gets a `retest` signal on /ws/board, and again 20 s
  later when the agent's statements and log lines have arrived. The page re-reads its chips on the signal - no timer.
- **Guards** (`GET /board/retest/guards`): Verified / Done cards keep their expectations; a later failing call shows
  "guard failed" and `board_regressions` lists it for Claude to propose Reopen.
- **New build**: a new agent process (`AgentStartedObserverPort` in db-capture, a new agent id) records the project's
  app start (`app_starts`); a Fixed card fixed before it with no call since shows "new build - ready to re-test", the
  board shows a banner, and the open tab notifies when desktop notifications are on.
- **Run and history** (`POST /board/retest/run`): the check plus one `retest_runs` row per card (when, who, live or
  cycle, verdict, calls, summary) and the report as Markdown. The drawer's Re-test section shows the history.
- **▶ Re-test** (one card, the selected Fixed cards, all of them, or the new build): creates a cycle "Re-test #18 #19",
  starts recording, and shows the merged steps ticking as their calls arrive; **Stop and check** runs it against the
  cycle and opens the report. **Replay original call** resends the card's first inbound call (asks first for a write).

Verified stays the user's: the card offers **✓ Verified** when every call passes; Claude proposes it.

## Cleaning up after a cycle

Deleting a session cycle always removes its board brief, spec files, checklist marks and suggestions, session log and
test-step marks (`cycleRemoved`). Its **cards** are the user's choice in the delete dialog (`CycleDeleteService`):
**delete them too** (the default; `DELETE /board/cycles/{cycleId}/cards`, before the cycle) or keep them on the project
board, marked "◷ cycle deleted". Kept cards are found later with the **◷ Cycle deleted** filter (`cycleDeleted=true`)
and removed with the bulk **🗑 Delete…** (`BulkAction.DELETE`, with a confirm naming the cards). Claude can do neither.

SQLite keeps the pages deleted rows freed and reuses them, but the file does not shrink. **Settings → Storage → Board**
(`GET /board/storage`) shows board.db on disk, what the data uses and the free space inside; **Compact**
(`POST /board/storage/compact`, user only) checkpoints the WAL and runs `VACUUM`.

## Edit access

Board writes follow the server-settings rule (`EditAccessUseCase`), with one exception: Docker, which refuses every settings write, lets board edits through, because cards are data, not settings. The Cloudflare tunnel is always view-only. `GET /board/access` returns the same decision to the page, which then hides its edit controls and shows "View only". Export stays available.

## Export and import

- **Board export**: Board → .md, .html or .json, either the whole board or the selected cards.
- **`alfred-board/1`** (`board-json.ts`): a header line, then one record per line: card (fields plus direct links), activity (by card number), brief, spec (in full) and mark. Nothing is shortened. `POST /board/import?project=` streams it in. A clashing number gets the next free one, and `@[card:...]` mentions of moved cards are rewritten to match.
- **The HTML export** escapes every value.
- **Cycle export**: "Include brief & specs" and "Include board cards" are both off by default, and with both off the output is identical to before (guarded in `export-build.spec.ts`). When ticked, they append the board to the .md / .html report. With .json, the calls file stays the calls re-import format, and the board is written beside it as its own alfred-board file.

## Limits and measurements

**Seatbelts** (clamped server-side):

| Item | Limit |
|---|---|
| Title | 300 chars |
| Description, comment, brief | 256 KB each |
| Reason | 2,000 chars |
| Evidence | 8 KB |
| Bulk request | 200 cards |
| List page | 500 cards |
| Activity page | 1,000 entries |
| Badge request | 100 call ids |
| Import file | 200 MB |

**Retention**: kept until the user deletes it. A board is manual data, measured in KB.

**Measured performance** (`SqliteBoardRepositoryPerfTest`, Docker JDK 21, a temp folder): 2,000 cards, each with a 4 KB description, 5 history entries and 2 mentions.

- Opening the board (first 500 rows, with comment counts, chips, total and progress): **43 ms**.
- A filtered list (kind + flag + search): **4 ms**.

This is SC-005's "open and filter in under a second" with plenty of room. The list query never selects descriptions.

On the running Docker stack (2026-10-10 quickstart walk-through), a change made in one tab reached another tab's `/ws/board` listener in **22 ms**, and its re-fetch of the board took **6 ms** (SC-004: under 2 s).
