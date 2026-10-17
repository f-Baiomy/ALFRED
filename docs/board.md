# Task board

The board (specs/014-task-board) tracks bugs, tasks, notes and questions next to the traffic they are about. There is one board per project, and each session cycle has a view of its own cards. Claude adds findings to it through the MCP tools. The user sorts them, and the history of every card records what was done.

## Boards (specs/027)

A **board is a task**: its brief, spec files, requirements, chat and cards. Its **session cycles only hold calls** - the
recordings and re-tests of that task. Each project has a **default board** (`default:<project>`) for cards that belong to
no task; it is never written until something writes to it (reads use `readDefault`, writes `writable()`).

- **Ids**: a board's id is the task key the slice already used, stored in the old `cycleId` / `cycle_id` columns
  (research R1 amendment) - so briefs, specs, requirements, chats and card links needed no rename. `ChatKey` maps the
  default board's id to `''`, the old project chat. A cycle that had a brief became a board with that cycle's id on the
  first start after the update (`BoardModelMigration`, logged once as MIGRATED).
- **Relations**: `board_cycles` (a cycle on many boards), `board_boards` (related boards), `cards.board_id` (a card's
  home) and `card_cycles` (cycles a card is related to beyond its home). A board shows its own cards and, with
  **Own + related**, the cards of related boards dashed with their home named.
- **Opening a board is the user's**: from the board picker, from a board chat ("open a board for AB#1234", "open a new
  board <name>") or from Start on a work item. As Claude, `POST /board/boards` needs `askedIn` - a USER chat message
  (recent, unless it is a Team Start message, origin `team-start`) or `"terminal"` (`ManageBoardsUseCase.askedBy`).
- **One recording per project**: `POST /session-cycles/{id}/record?onRunning=ASK|PAUSE_OTHER` answers
  `409 RECORDING_CONFLICT {running}`; `POST /board/boards/{id}/record {kind: REC|RETEST, onRunning: ASK|JOIN|NEW}` joins
  the running cycle or pauses it and starts a new one (`RecordingGuardPort`, `BoardRecordingGuardAdapter`).
- **A shared cycle is judged by every board on it**: `GET /board/cycles/{id}/verdicts` gives each call against each
  board's requirements; `GET /board/cycles/{id}/home` says where a finding goes (the board whose requirement the call
  shows, else the only open board, else ask) - `FindingHomeUseCase` / `ListenHomeResolver`.
- **Board activity** keeps 2000 rows per board, each of Claude's changes with Undo (claimed once, `markUndone`).
- **Board chats**: a board's chat is answered by the terminal holding that board, else the project's live runner, else
  it waits (R6). Remove later: the `/board/cycle-chat` alias of `/board/board-chat`, `cycleId` on `/board/live-runner`
  (now `boardId`), and the runner's `REMOVE-LATER(027)` fork path in `chat.mjs`.
- **Deleting a cycle** keeps the calls board texts mention: the cycle is kept, renamed "kept from <name>", trimmed to
  the mentioned calls and paused (`DeleteOutcome.KEPT`, `200 {kept: true}`; research R7 amendment). Its cards stay.
- **A board opened from a work item** shows it on the Task tab (`WorkItemStripComponent`): the item chip, "<tracker>
  changed" when it changed after setup (Review shows before/after; Save to brief, or Dismiss - both mark it seen), and
  "Fetch attachments" for the item's files the board does not hold. Deleting the board removes its link
  (`LinkedWorkItemPort.boardDeleted`). See [team.md](team.md).
- **Work item mentions**: `@[workitem:<conn>/<id>|AB#<id> <title>]` - the chip previews the item from the Team cache and
  opens it on the Team tab.

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

### The card drawer (specs/023)

`card-drawer.component.ts`, frontend only. Mocks and plan: `specs/023-card-redesign/`.

- **Header**:
  - One bar holds:
    - `#N` (click copies it), the kind, ✦ Claude, the cycle by name (looked up once, the id on hover);
    - waiting and ❓ N;
    - ▶ run;
    - ⋯: Copy as issue, Copy cycle id, Expand/Fold all, Compact spacing, Keyboard shortcuts, Delete card…;
    - ‹ › (the previous/next card in the same column, `siblings` from `board-view`), the view icons and ✕.
  - Below the bar: the title, "Mentioned as", and one line of chips (Status, Kind, Scope, the flags that are on + "⚑ +", teams + "+ team").
  - The **journey**: Inbox › … › Done, built from STATUS entries, with ✓ only on steps the card really went through. Click a step to move the card (the same path as the Status picker).
  - Once the body scrolls, the header shrinks to one line. The full header stays rendered (hidden), so ▶ and R keep working.
  - The shrunk header opens in place: its title, ▾ or the ⚠ pill shows the whole header and "Needs you" above the activity without scrolling it. ▴, or scrolling on by more than 80 px, shrinks it again.
- **Needs you** comes first, and only when something waits on the user: a proposal, open questions, a blocker, a failing re-test.
  - Context-only notes ("looks like #N", the reason) fold inside it. Alone, they show as a closed "Notes" line.
  - Folding it is remembered per card, so a new proposal on another card is never hidden.
- **Side view tabs**: Activity · Details · Links · Re-test, with counts and state (● new, 🔒 blocked, the re-test verdict).
  - Activity opens by default when the card has comments; otherwise Details.
  - `app-card-retest` stays rendered off its tab, because its verdict fills the tab label and the "needs you" row.
  - Full screen and the window use the same tabs as the side view, across their whole width.
- **Sections** fold by what the card holds:
  - Description is open, folded to its first lines only when long.
  - Attached is open. Runs is closed.
  - The user's own choice is kept in this browser (`alfred.card.sections`, try/catch).
- **Activity** (`activity-timeline`, `shared/utils/timeline-view.ts`):
  - Day dividers. Each comment and its replies form one thread; runs of changes collapse into one dim line.
  - It opens like a chat: at the first comment that is new since the user looked (`BoardSeenService.seenAt`, read
    before the card is marked seen; times compared as instants), else at the latest; it stays at the latest as answers
    arrive unless the user scrolled away ("↓ Latest" brings them back). Claude's live work sits at the bottom.
  - Only the last five threads are drawn at first; the older history comes in above, 15 threads at a time, when the
    user scrolls up to it (or clicks "Show N earlier"), with the thread in view kept in place. An open question or
    anything new is never left out of the first part. The timeline is OnPush (all signals), so scrolling, typing and
    hovering in the drawer never re-check a long history.
  - Replies are a tree: each one sits one step (1 rem) right of the comment it answers - avatar and text together. Like
    the call waterfall's rails, every level of replies has a coloured line down its left (the `depth-tint` ramp);
    clicking the line folds that level. Replies start folded, level 1 too, behind "▸ N replies · K new"; one click
    opens one level. A new reply is never folded away: opening a card opens the branches with replies new since you
    looked, and Claude's latest answer in the newest thread; a reply that arrives while the card is open opens its
    branch; a reply you send keeps its branch open. ⊞ / ⊟ in the filter bar open or fold every reply; Find opens them
    all.
  - Claude's Did / Found / Next (and Impact, Question…) show as blocks with a small heading line - Found with an amber
    edge, Next in a box; a part that only says Reply has no heading. A long comment is cut with "▾ Show all".
  - A comment's actions (react, reply, copy, ⋯ direction/wrap/edit/history) show on hover.
  - Filter (All · Comments · Changes), ⇅ newest first, 🔍 find - the bar stays in view (under the tabs) while scrolling.
  - A reference to a comment shows the earlier history and opens the replies on the way to it before scrolling to it.
- **Comment box**: the compact editor (one line, the formatting behind "Aa"), with "✓ draft saved" shown while a draft is kept.
  - Quick replies appear while Claude waits on the user:
    - ✅ Go ahead - a ✅ on Claude's latest comment, offered only while the user's ✅ is not on it yet;
    - Answer the questions;
    - Explain more / Not now - replies to Claude's latest comment.
- **Keys** while a card is open (none clashes with the board's card keys):
  - Shift+1–4: the tabs.
  - `[` `]`: the previous/next card.
  - `/`: the comment box.
  - `E`: edit the description.
  - `?`: this list.
  - R / C / ⇧R: run, copy the prompt, edit the prompt (as before).

  `board-view` leaves `?`, `/`, `[` and `]` to the drawer while a card is open.

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

### Readable references (specs/021)

Every reference reads its meaning where it stands, meaning first and the code in parentheses: "one-branch search (AC8)",
"All Agencies untested (#47)", "POST refunded-requests/search · 200 (call 75)", "your answer · 4:38 PM". No new chip and
no new popup: each is one of the mention types above, drawn by `MentionChipComponent` and opened as that type opens.

- **One finder** - `shared/utils/readable-refs.ts` finds the shorthand (`AC8`, `#47`, `call(s) #75, #81`, `[6]`, a call
  id) outside code, links and mentions. The MCP server (`mcp-server/src/readable.ts`) uses it on every board write and
  saves each code as its mention, looked up; the reply lists what it converted and `notFound` for what it could not.
  The board uses it on display for older text and for titles (`RefTextComponent`): nothing is rewritten.
- **New refs**: an Acceptance item is a spec mention at `#ac<n>` (`<cycle>/<file>#ac8`; `*` as the file when only the
  number is known), its n-th item across the cycle's spec files as `board_requirements` numbers them. A cycle's call by
  its number is `call:n:<n>@<cycle>` until it is looked up (no preflights, both directions, oldest first - the numbers
  `get_cycle`/`check_calls` give). A history entry is a card mention with `/e<entryId>` (or `/i<index>`, board_get's
  `[index]`) - an older Alfred opens the card.
- **Live labels**: `BoardMentionsService.live(ref)` looks a chip's reference up once (cards by number, a cycle's
  requirements, its numbered calls) and the chip reads the current short name or title cut short, with a dot for the
  state: a card's status, an item's verdict or your mark, a call's error status (from its label - no fetch). A board
  change to a card or the requirements makes the chips look again (at most every 3 s).
- **Short names** (`short_names` table): a few words per card (`PUT /board/cards/{id}/short-name`) and per Acceptance
  item (`PUT /board/cycles/{id}/requirements/short-name`), shown on `CardSummary`/`CardDetail` and `Requirement` as
  `shortName`. Claude may give one only where there is none (`board_add shortName`, `board_short_name`); the user edits
  it under the drawer title or in the spec viewer. Without one, the first four words of the title or text, without
  "Not exercised:" and "(AC8)".
- **Popups**: a stmt / log / Redis chip opens its call popup and the database window at that statement, the Logs view, or
  that Redis command (`DbWindowService.openCall(…, focusSeq)`). An Acceptance item opens the spec viewer at its line with
  a strip: its verdict, your mark (Pass / Fail / Can't tell), its short name, and the calls judged for it
  (`GET /board/cycles/{id}/requirements/calls` - the calls its verdict counts, since the app start or the fix), each a call chip. A history reference opens the drawer and flashes that
  entry. Three or more call chips in a row (", " / " and ") read as one "⇄ 4 calls" chip that unfolds on a click.
- **Picker**: the Spec files tab lists the Acceptance items first ("… (AC8)"); the Cards tab lists cards by short name
  ("… (#47)") and the cycle's calls by number ("… (call 75)").

## Inbox sorting

- Each Inbox card has one-click **Fine / Not in flow / To do**, also on the F, N and T keys.
- **Triage mode** shows the Inbox one card at a time, with a reason box and F / N / T / M (merge - the advised one, or
  a number you type) / S. When Claude triaged first it goes worst first and shows Claude's advice, its confidence,
  what it checked and the card's root-cause group, with the advised key outlined and **Accept all High**.
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
with `TaskViewComponent` (redesigned in specs/024). Everything comes from what `/board` already serves (brief, brief
comments, checklist, requirement verdicts, cards, steps, session log) and is derived in `shared/utils/task-view.ts`.
It re-fetches on each `/ws/board` signal and never polls.

- **The header, always shown**: the ticket and branch chips, the title (the brief's goal line), **▶ Next** - the one
  step that fits where the task stands, in plain words with its run button (`nextStepOf`: no requirements → Write the
  requirements, a bug or missing item → Fix the bug, a fix in → Re-test the fix, Claude suggestions → open them, all
  done → Hand-over report, else Check while I test) - and **Run ▾** with every skill in plain words plus **Continue
  anywhere** (`/alfred-resume <task>`). Below them the phase stepper (Coded → Verifying → Fixed → Re-tested →
  Done, each with its meaning on hover) and the verdict ("does the code match the task?") with a bar coloured by group.
- **Needs you**: one strip of everything waiting on the user, each item leading where it is dealt with - Claude's
  suggestions to accept, failed requirements, fixes to re-test, requirements not checked, Claude's questions on the
  brief, cards with a question / proposal / waiting on the user, test steps not done (`needItems`).
- **Tabs**: Requirements (default) · Test plan · Brief · Claude's runs · Spec & files, each with its count. The tab is
  remembered per cycle in this browser. Each tab opens with **ⓘ How this works** - what the section is and how to
  decide in it (`TAB_GUIDES`); hidden once, it stays hidden for that tab.
- **Requirements** (`TaskRequirementsComponent`): the Acceptance items, R1, R2 … across the spec files, one list - the
  separate Acceptance checklist is folded into it. Each item's state comes from the user's mark first (Pass = met), then
  the cards linked to it (an open BUG = bug, an open TASK = missing, FIXED = re-test), then Claude's suggestion. Rows are
  grouped by what they need: **Decide** (Claude suggests a mark - whatever its state), Bug, Missing, Re-test, Can't tell
  yet, Not checked, **Met** (folded), and **Also found** (Claude's notes and "Not in the task: …" changes). Filter chips
  show one group, the open ones or all. A row shows its state, its cards, a short pill for what the calls say (specs/018
  verdict: `0 rows`, `no call yet`, `checked by hand`, `calls: wrong` … with the reason on hover) and one Pass / Fail /
  Can't tell control. Opened, it shows Claude's suggestion (Accept / Dismiss), the user's evidence, the calls' verdict and
  reason, the spec file and AC number, and **✎ your evidence**, **⚙ how the calls show it** (the checks editor) and
  **💬 ask Claude**.
- **Test plan**: the brief's `## Test steps` with what listen / review saw (✓ and its calls, ✗ and its card), the
  `## Data`, and **Done when** - the hand-over rule checked live; a ✗ leads to what is left - with the report button.
- **Brief**: the brief by section (goal, description beside in / out of scope, dated decisions, other headings as
  written), pinned items and pages, Edit / Restore previous, and its **comments** in the margin (below).
- **Claude's runs**: the session log, newest open, Did / Found / Next.
- **Spec & files**: the spec files (upload, drop, paste, restore) and the files attached to the cycle.
- The MCP's `task_context` derives requirement states the same way (`requirementState`), so the user and every Claude
  session see one picture.

## Brief comments (specs/024)

- **Where**: the Brief tab's margin. Select a passage of the brief and **💬 Comment** appears under it; "+ On the whole
  brief" comments on all of it. A comment keeps the passage it is about (`quote`) as it read then.
- **Highlights** use the CSS Custom Highlight API (`shared/utils/brief-highlights.ts`): ranges over the rendered text,
  never a change to the DOM Angular owns (wrapping text in `<mark>` breaks its bindings on the next update). Hovering a
  passage lights its thread and the other way round; clicking a passage brings its thread into view. A quote the brief
  no longer has as written shows "passage changed" and stays readable. A browser without the API shows no highlight.
- **Threads**: a reply joins the thread of the comment it answers (`replyTo` is always the first comment); a reply to
  a resolved thread reopens it. **Resolve / Reopen** are the user's; resolved threads fold under "N resolved".
- **Claude** reads open threads in `task_context` (BRIEF COMMENTS) and `get_brief` (`comments`), and writes with
  `board_brief_comment`: comment, reply, **ask** (`asks: true` - shown as "❓ asks you" and in Needs you until the
  user answers) and **suggest a rewording** (`suggestFrom` - the words exactly as the brief holds them - and
  `suggestTo`). The brief changes only when the user clicks **Apply**, through the brief's own save, so Restore previous
  undoes it; the thread's quote follows the new words. A passage that changed since is refused ("edit the brief
  yourself"). Claude never resolves, applies or dismisses.
- **Storage**: `brief_comments` in board.db (`SqliteBriefCommentRepository`), deleted with the cycle's brief, REST under
  `/board/cycles/{id}/brief/comments` (list, add, `{id}/resolve|reopen|apply|dismiss`), the `/ws/board` signal
  `brief-comments`. Exported in the board .json as `briefComment` records and imported back (a repeated import does not
  repeat them).

## Live answers

`/alfred-live` shows its work on the card while it happens (docs/mcp.md "Live answers"): `PUT /board/live-work` (the
runner's report of one run: heading, steps, draft, state), `GET /board/live-work?project=` (running and recently
ended runs) and `POST /board/live-work/{id}/stop` (the user's Stop). `LiveWorkService` keeps them in memory only - a
run is work in progress, never a record; the reply itself is the card's ordinary comment - and signals each as a
`live-work` message on `/ws/board`. The frontend's `LiveWorkStateService` holds them for the column card (spinner and
current step), the drawer (`app-live-work-box`) and the live strip.

The runner runs on the user's machine, which need not be Alfred's: its heartbeat `PUT /board/live-runner` (project,
host, model, `kind` - `live` for `/alfred-live`, `listen` for the listen runner's own answering lane, which stands
down while a `live` runner holds the board; `stopped` ends it) and `GET /board/live-runner?project=` (204 when none;
a runner for every board answers any project) let listen in any session know it is answering. A live-work report
refreshes the heartbeat too, so a long answer never reads as a dead runner. Held in memory for 2 minutes after the last beat; a
`live-runner` message on `/ws/board` when one starts or stops. Both writes go through the board's edit access, so the
runner's machine must be one allowed to edit the board.

## Run from the board

Every `/alfred-*` command the board suggests (each card's next step, the next-step bar, the Task tab) is a **run
button with a copy button beside it** (`app-run-skill`). ⧉ always copies the full prompt - the command, then the Alfred
address, project, cycle, card, who it waits on and the user's last word (`shared/utils/skill-prompt.ts`) - so a session
on any machine, or another agent, starts on the right thing.

**A cycle belongs to one chat.** The Claude Code chat that runs `/alfred-live` and/or `/alfred-listen` for a cycle
handles it: its runner starts from that chat's Bash, reads the chat's id and process (`CLAUDE_CODE_SESSION_ID`,
`CLAUDE_PID`) and sends them with each heartbeat (`PUT /board/live-runner` with `cycleId`, `chatId`, `cwd`,
`chatAlive`). Alfred keeps one chat per cycle (`LiveWorkService.chatBeat`): a second chat starting on that cycle is
refused with 409 "This cycle already runs in a chat on HOST … - one chat per cycle: stop it there first". The cycle is
freed when the chat's runners stop (or stop beating for 2 minutes). `GET /board/cycle-chat?cycleId=&project=` answers
the chat (host, kinds, since, `chatAlive`) and the repo folder the project's last chat ran in; `/ws/board` signals
`cycle-chat` on each change. Nobody's account or model is borrowed: every ▶ runs in the chat that owns the cycle, with
that chat's own context, model and usage.

- `POST /board/skill-runs` queues a run for the cycle's chat (`skill_runs` in board.db: command, prompt, note, state,
  outcome, failure, result, `chat_id`). Refused with 400 without a cycle (project-wide commands and the project board
  copy only), 404 when no chat handles the cycle (the button shows how to start one), 409 when the card - or, for a
  card-less command, the same command - already has a run waiting or running, 403 through the board's edit access (the
  tunnel only copies).
- **Background skills never queue**: `/alfred-listen` and `/alfred-live` run as the chat's own background processes, not
  in its turns. ▶ for one the cycle's chat already runs is refused with "Already listening to this cycle on HOST in the
  background" (409), and a run of one left waiting from before it started is cancelled saying so - queued, it would wait
  for the chat's turn behind every other run for nothing.
- The chat's runner waits on `POST /board/skill-runs/claim` with its `chatId` (`waitSeconds` up to 50, woken by the
  request - no polling), takes the runs of the cycles its chat handles (state SENT) and writes one line into its chat
  log, which the chat watches: `▶ from the board: /alfred-fix 35 · note: … · run <id> - board_run_take <id>, run it in
  this chat, then board_run_end`. When its turn is free, the chat calls `board_run_take` (RUNNING; it returns the full
  prompt and the note, or `cancelled`), runs the command itself, and ends with `board_run_end` (DONE or FAILED, one →
  line, `result` "#N" of what it wrote). Nothing runs in the runner. A run the chat has not taken yet waits for it
  however long the chat is busy, and a run left waiting when the chat stops goes to the next chat started for the
  cycle.
- **Comments are mixed**: the runner answers small ones itself in seconds (the live answers below); a comment that
  needs an investigation (why, fix, check, investigate, explain, debug, trace, …) is handed to the chat as one line
  (`💬 #35 "…" · you commented: "…"`) and the card shows "sent to the chat"; the chat answers on the card.
- **Cancel** (`POST /board/skill-runs/{id}/stop`) cancels a run the chat has not taken yet; one the chat runs is the
  chat's. **Cancel all waiting** (`/stop-all`) does every waiting run of the board. A run still open 2 minutes after its
  cycle lost its chat reads as failed "lost".
- `GET /board/skill-runs?project=&cardNumber=` lists the waiting and running runs, then the latest ones, with
  `usualMs` - the median of each skill's last 20 finished runs, shown as "usually ~1 min". `/ws/board` carries a
  `skill-run` signal per change (never the prompt); `SkillRunsStateService` re-reads on it.

The button: ▶ → sending → sent to the chat → "waiting - the chat is busy · 2nd" (taken when its turn ends) or "waiting
- the chat seems closed" (its process is gone; it waits, with how to start a new one) → running in the chat (its time)
→ done (the chat's → line and "open #N" for 30 s) or failed (why, copy the prompt, retry). ✕ cancels while it waits.
With no chat on the cycle, ▶ opens the start steps: `cd "<repo>"`, `/alfred-live <cycle>`, `/alfred-listen <cycle>`
(optional, same chat), each with a copy button, then "press ▶ again". ▾ edits the prompt or adds a note (Shift+click
too), toggles a notice when a run ends while the tab is in the background (a "(✓1)" title badge always; a desktop
notification when allowed), and copies the command alone or as a `claude -p "…"` line. The drawer shows the card's
**runs from the board** (each with the user's note) and takes **R** (run), **C** (copy), **Shift+R** (edit, then run);
the next-step bar sends `/alfred-verify` for each of the cycle's Fixed cards into the chat, which runs them one after
another; the live strip shows the cycle's chat ("▶ runs in: chat on HOST · /alfred-live + /alfred-listen") with what
waits and runs, and ✕ Cancel all waiting. A card waiting on Claude suggests `/alfred-sync N` - except in To do / In progress, where it is `/alfred-fix N` (which catches up on your answers first; sorting a card there is what makes it wait on Claude). On the project board, for
commands without a cycle and the brief's "Continue anywhere" resume command, the button copies only.

## Text direction

Comments, replies, descriptions, briefs and spec files (`app-markdown-view`) read in their own direction by default:
each paragraph, list item, heading, quote and table cell gets `dir` from its words (`shared/utils/text-direction.ts`) -
right-to-left when most words are Arabic / Hebrew (a word counts by its first letter, so `الـsearch` is Arabic), left-to-
right when most are Latin, by the first letter on a tie. Code and mentions do not count and are isolated, so an English
term, a path or a call keeps its order inside an Arabic sentence; code blocks always read left-to-right. Unlike the
browser's `dir="auto"` (first letter only), an Arabic sentence that starts with `POST …` still reads right-to-left.
The ⇄ switch on each comment picks Auto → RTL → LTR for that comment, kept in this browser only
(`TextDirectionStateService`, never part of the comment). The comment box follows what is typed the same way; its ⇄
button or Ctrl+Shift+X forces a direction while writing.

## Rich text

Every text field of the board - description, comment, reply, answer, brief, spec file, checklist evidence - is one
editor (`app-mention-editor`) and one reader (`app-markdown-view`), so a feature added once works everywhere.

- **Storage**: one string, as before. Plain words with mentions stay plain text (exactly what the old editor wrote);
  anything formatted is saved as HTML from the editor's block tree (`blocksToHtml` in `shared/utils/rich-html.ts`).
  Claude writes Markdown with a few extensions (below); old Markdown reads unchanged and opens formatted in the editor.
  A text is HTML when it starts with a block tag (`RichText.isHtml` / `isHtml`, the same regex on both sides).
- **Cleaning**: the backend cleans every HTML text on every write and on import (`domain/RichText.clean`, jsoup with an
  allowlist: headings, lists and checklists, tables, code with `data-lang`, quotes, callouts `aside[data-callout]`,
  folds `details`, `mark`, colours `span[data-color]`, pills `span[data-pill]`, links http/https/mailto, pictures only
  from `/board/images/<id>`, `dir`). The page never uses `innerHTML`: the reader parses with an inert `DOMParser` into
  the typed block tree and renders that, so a pasted page cannot run anything.
- **Mentions and variables** keep their text form inside the HTML (`@[type:ref|label]` in a `data-mention` chip,
  `{{name}}` in a `data-var` pill), so the mention index (`MentionParser` reads `RichText.plain`), kept calls and the
  acceptance checklist (`RichText.markdownLines`) work as before.
- **Direction**: every block - paragraph, heading, list item, table cell, callout, fold, quote - takes its own `dir`
  from its words (see Text direction); code is always left-to-right. Mixed Arabic and English reads as before.
- **Editor**: toolbar (style, bold/italic/underline/strike, code, highlight, colour, lists, checklist, callout, table,
  fold, pill, divider, link, picture, templates) and `<>` to edit the HTML source; `/` opens a block menu, `{{` a
  variable menu (global variables of the active environment); Markdown shortcuts (`## `, `- `, `1. `, `[] `, `> `,
  three backticks, `---`, `**x**`, `==x==`, `~~x~~`); smart paste (pictures upload, formatted HTML keeps its blocks,
  JSON/SQL/XML/logs become a code block, a URL a link); drafts per field kept in this browser until sent.
- **Claude's Markdown**: `> [!NOTE|INFO|TIP|WARNING|BUG|DANGER|FIXED|OK|NEXT] title` callouts, `+++ Summary` … `+++`
  folds, `- [ ]`/`- [x]`, `==mark==`, `~~strike~~`, `[ok]` `[fail]` `[wait]` `[info]` (or `[fail: text]`) pills,
  `{{name}}`, fenced languages json/sql/java/js/xml/shell/diff/log, and a call mention alone on its line shown as a
  call card. The writing guide is in `skills/_shared/rules.md` ("Writing on the board"). The MCP server converts every
  HTML text of a `/board/` answer to this Markdown before Claude reads it (`alfred-client.ts` `readable`).
- **Pictures** (`board_images` in board.db, `POST /board/images`, `GET /board/images/<id>`): PNG, JPEG, GIF or WebP up
  to 5 MB, checked by their first bytes, served with `nosniff` and a `default-src 'none'` CSP. A picture belongs to the
  card or cycle whose text first shows it and is deleted with that card; one no saved text shows is removed a day
  later, swept when the next picture arrives (no timer). ✎ Mark draws boxes, arrows, labels, blur and a crop on a
  copy. Claude opens one with `board_image`.
- **Wrap or scroll**: each comment has `⇥ Scroll` (the default: table rows and code lines stay whole and scroll sideways inside their block) or `⤶ Wrap`, kept in this browser like ⇄; a code block's own switch overrides it. A board text never makes its box wider. A mention in a table cell keeps its label, written with `|` or `\|`.
- **Reading**: code blocks with their language, line numbers, wrap and copy; an outline for texts with three or more
  headings (spec headings copy as a spec mention); long comments fold behind "Show all"; ⧉ Copy gives a comment as
  formatted text (mail, Word, Teams), Markdown or plain text (variables as their value, a secret never).
- **Reactions** (`POST /board/cards/<id>/comments/<entry>/reactions`, the user only: 👍 ✅ 🤔 👀 🎉 ❌, a toggle). ✅ on a
  Claude comment is **Go**: the card's turn passes to Claude and `board_changes` says `= GO`.
- **Edits**: the user edits their own comments (`PUT /board/cards/<id>/comments/<entry>`); the earlier text is kept in
  `text_versions` and shown under "edited · history", like the description's earlier texts. Claude never edits a
  comment - it writes a new one.

## Claude's limits

These are enforced in `BoardService` and `CycleBriefService` whenever `X-Alfred-Actor: claude` is sent. The MCP tools send it on every board request.

- New cards always land in the Inbox.
- Claude may move cards only to To do, In progress or Fixed, and never out of Verified, Done or Closed.
- Claude may not set scope, close, reopen, delete, bulk-edit, undo, set a reason, mark the checklist, or write briefs and spec files.
- A Claude comment must give Did, Found and Next; Impact is optional. The two other kinds are a **reply** (`**Reply** ...`, an answer to the user) and a **question** (`**Question** ...`). A question also flags the card Needs decision. Other free text is refused.
- Claude may rewrite the title, description, kind, cycle or project only of **its own** cards, and only while they are in the Inbox. It may set flags on any card.
- Verified, Done and closing stay the user's. Claude **proposes** them instead (`proposals` table, one open per card, `PUT /board/cards/{id}/proposal`). Allowed proposals: Verified for a Fixed card, Done for a Fixed or Verified card, and a close with its resolution for an open card. The card and the drawer show "✦ Claude proposes ..." with Accept and Dismiss. Accepting takes the step as the user's own move or close. If the card changed so the step no longer fits, accepting drops the proposal instead. The history records PROPOSED, PROPOSAL_ACCEPTED and PROPOSAL_DISMISSED.
- While the live strip is **paused**, Claude's new cards are refused. A card whose signature matches a card closed as Fine or Not in this flow is refused with that card's number and reason only when it is the same problem: they share a call id and are the same kind (one call can show several problems - 61813's #39, a NOTE closed as Fine over slow searches, refused the TASK saying those searches lack a feature), or their titles share two words beyond the endpoint's own words (every finding on `POST /flight/search` says "flight search"; counting those, one card closed as Fine refused every later finding on that endpoint) - a signature alone (outcome class and endpoint) is not enough, since a slow, a swallowed error and an N+1 on one endpoint all share it; otherwise the card is created with `similarClosed` as a hint. Won't fix does not block. A new card whose signature matches an OPEN card gets `similarOpen` ({number, title, status}) on its detail, so the MCP tools say "same signature as open #N - link or board_propose MERGE".
- These are guardrails against an agent overreaching, not a security boundary: anyone with edit access can do what the UI does.

The live strip status is held in memory per project. It reads as STOPPED when it has not been updated for 10 minutes. The backend computes that on read; the frontend arms a single timer to the deadline, which the no-polling rule allows.

## Replies and answers

Every comment in a card's history has **↩ Reply**: the reply is stored with `reply_to` (the comment it answers) and
shown under it. `reply_to` is always the thread's first comment (a reply to a reply points at it, so everything
that reads threads by it - questions answered, reactions, Claude's tools - stays one level); since specs/023 a reply to a
reply also keeps `answers`, the reply it was written to, and the timeline draws the tree from it (older replies have
none and hang under the first comment). Replies must stay on the same card; the board .json carries `answers` too. Claude's question (a comment starting `**Question**`, from `board_ask`) shows **waiting for
you** until the user replies to it, then **✓ answered**; its button reads **Answer**, with "Clear Needs decision"
ticked: the flag comes off only when no other question on the card is still unanswered (`BoardService.unansweredQuestions`).
The answered state is worked out from the replies, never stored. Exports note "↳ reply to ..." on each reply, and the
.json export carries each entry's `id` and `replyTo`, which an import maps to the new ids. Claude sees the threads in
`board_get` ("↳ reply to [i]", `openQuestions`), answers one exact comment with `board_reply`/`board_comment`
`replyTo` (a history index), and `board_changes`/`board_wait` say "ANSWERS your question" for the user's answer.

## Questions

Claude asks the way it does in chat (specs/019): `board_ask` takes 1-4 `questions`, each with a header, the question,
why, single or multi select and 2-4 options (label, description, `then` - what Claude does if it is picked -,
`recommended`, a `preview` shown on hover, and a `followUp` asked at once when it is picked). The comment is
`**Question** <first question>` plus a ```` ```questions ```` JSON block; a plain `question` still works and is one
question with no options.

- **Every question has a state**, indexed in `card_questions` (board.db) from the text: OPEN, PENDING (a follow-up
  waiting on its option), LATER (put off until a time, open again after it), ANSWERED, WITHDRAWN (Claude, with a
  reason), DROPPED (a follow-up whose option was not picked). Comments written before the table are indexed on first
  read. **Needs decision follows the open questions**: on while any is open, off when none is; Claude cannot take it
  off while one is open - it withdraws the question (`board_withdraw_question`, reason required, follow-ups go too).
- **The tile only counts**: ❓ N open questions, on the tile, in the drawer header and the board's toolbar (the total),
  whatever the card's status or what else it waits on. Click it (or **A**) for the **questions dialog**: a tab per
  open question and Review, options with "Then I will" and Recommended, the preview on hover, Something else, a note
  per question, ⏰ Decide later (tomorrow), 1-4 and ← → keys. Answer all or some and **Send N of M answers**:
  `POST /board/cards/{id}/answers` validates the whole batch first, then writes one `**Answers** …` comment (with an
  ```` ```answers ```` block) per question comment as a reply to it. A follow-up shows while its option is picked and
  is sent with it; questions Claude asks because of the answers arrive in the open dialog (the board signal) marked
  ✦ New.
- **The thread** shows a question comment as its questions with the picked options, ✓ / ❓ / ⏰ / ⊘ per question, read
  from the replies' text alone; an Answers comment shows its summary line.
- **No duplicates**: the same question already open on the card is not asked again (the MCP reply says which one is),
  and a second Claude reply to the same user comment is refused - one answer per message, whichever runner sent it.
- **Sorting answers the question** (specs/020): a question whose options include the sort the user makes with the
  card's own buttons (To do, Fine, Not in this flow) is answered with it ("sorted on the board"), so Claude hears the
  decision and no question stays open on a sorted card. The tile shows the option Claude recommends ("✦ advises: To
  do", `CardSummary.advice`) and outlines that button. `/alfred-triage` started from the board asks this way - one
  Triage question per Inbox card - and ends without waiting.
- **Triage facts** (skills/alfred-triage): a Triage question also carries, in its ```` ```questions ```` block,
  `confidence` (`high` / `medium` / `low`, on the recommended option only), `checked` (what Claude looked at before
  advising: earlier cards, the call, code, database, schema, spec, git), `severity` (`{rank, of, note}`, 1 = worst)
  and `group` (Inbox cards of the same root cause to merge into this one). The text stays the source of truth -
  `card_questions.advice_meta` only indexes it, read leniently (an unknown value is left out, never an error, so an
  older Alfred importing it does not throw) - and `CardSummary.adviceDetail` serves it. The tile shows the confidence
  label beside "✦ advises" and a ▲ rank badge; the questions dialog shows the label beside Recommended with the
  Checked line; the Inbox is **worst first** when Claude ranked it.
- **Merging** is the user's too: `POST /board/cards/{id}/merge` (`intoNumber`, `reason`) moves the card's history and
  links into the other card and closes it as Duplicate, answering its Triage question ("Merge into #n"); Claude only
  proposes a merge. The tile shows the advised merge as **⇢ Merge into #n** or, on a group's card, **⇢ Merge #14 #17
  here** (each one merged in turn).
- **Accept all High**: the Inbox header and Triage mode take every advice Claude gave with High confidence at once,
  after one confirm that lists them - each as if its button were pressed (so each answers its question). Medium and
  Low advice is never taken this way.
- Claude reads the answers whole: `board_get`/`board_changes`/`board_wait`/`board_live` show the ```` ```answers ````
  block on one line and each question's state; it acts only on the answered ones.

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
  To do, Fixed needing a re-test, Inbox - each with its `/alfred-*` command as a run button with copy beside it (see
  "Run from the board"). Every card has one for its next skill; the Task tab for `/alfred-review`, `/alfred-listen`,
  `/alfred-spec`, `/alfred-report`.
- **Answer from the board**: a card with open questions shows ❓ N open questions (and the **A** key) - the questions
  dialog, see "Questions".
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

## Implemented and worked (specs/026)

A Fixed card is judged twice before Verified, and the two are different questions:

- **Implemented** - is the fix in the code that runs: its commit on the task branch, in the running build (the app
  started after it), every layer the card's teams own changed, nothing reverted it, its tests (when run). Only Claude
  can read the code and git, so `/alfred-verify` records it: `PUT /board/cards/{id}/code-check` (`board_verify`'s
  `implemented`) with a verdict - IMPLEMENTED, NOT_ON_BRANCH, NOT_IN_BUILD, LAYER_MISSING, REVERTED, TESTS_FAIL or
  UNKNOWN (plain text, read leniently) - the commit, the branch, each layer `{team, where, ok}`, the tests and a note.
  Kept in `code_checks` (board.db, the last 20 per card); a check made before the card's fix says nothing about it.
- **Worked** - the re-test of the calls since the fix (below).

Every re-test check carries the latest code check as `code`. A Fixed tile shows both as two chips (`✓ Implemented ·
✓ Worked`, `✗ Not in build · – 3 calls ran the old code`, `? Code not checked · ✓ Worked`); the drawer's re-test shows
both with their evidence and "ready for Verified" when both hold. Claude proposes Verified only on implemented ✓ +
worked ✓ (or worked ✓ with the code out of reach, saying so); a card that worked on the API but misses a layer goes back
to In progress. Moving a card to Verified with either check short asks first (Ask Claude to verify it / Verify anyway /
Keep in Fixed) - Verified stays the user's.

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

What a re-test counts (specs/020 - from cycle 61813, where old calls and empty answers read as a re-test):

- **Only the fix build**: calls made before the app start that carries the fix ran the old code. That start is the
  first one after the card was fixed (or the last one before, when the app was restarted before the card was marked
  Fixed), read from `app_start_history` (the last 50 starts per project). Earlier calls - live or in a re-test cycle -
  are counted apart (`beforeBuild`, "N calls before the fix build not counted") and never judged; none after it is
  "not re-tested", not PARTIAL.
- **A step checks the request, not just the path**: a step may carry `request` conditions (`{path: "$.branchIds",
  shape: "has:-11"}` - none / one / list / list>=2 / present / has:<value>, the REQUEST_WHEN shapes); it ticks only on
  a call that sent that, and says why it did not ("1 call to the endpoint, none sent what the step asks: branchIds has
  -11 - … sent branchId: 948"). Saving a step whose endpoint no recorded call ever hit returns `warnings` with the
  closest recorded endpoint (same method, longest shared tail of path segments) - saved as written.
- **Empty answers prove nothing**: `emptyAnswers` counts the judged calls whose answer was an empty list
  (`{"payload":[],"total":0}`); when it is all of them the summary says "every answer was empty … not seen working on
  data". Moving such a card to Verified (drag, ✓ Verified, the drawer, Accept Verified) asks first
  (`VerifyGuardService`): **Keep in Fixed**, **Ask Claude for a re-test with data** (a comment to Claude), or **Verify
  anyway** - then the re-test is recorded first and the card's guard shows "⚠ verified on empty answers only" for as
  long as it stands (read back from that run).

## Requirements by the calls (specs/018)

Every Acceptance item can carry **evidence** - the endpoint whose calls show it and the checks each such call must
pass - and Alfred judges **every** call a cycle captures to that endpoint in code, once, as it arrives: flagged or
clean, with no model and nobody in the way. A feature the calls show is not built is a card from the first call.

- **Evidence** (`item_evidence`, `PUT /board/cycles/{id}/evidence`, `GET …/evidence`, `DELETE …/evidence?fileName=&itemKey=`):
  `endpoint` (`METHOD /path` - ids as they are or `{x}`; segments that are ids on either side match any - or `UI`)
  and up to 10 checks, applied in this order:
  `REQUEST_SHAPE` {path, shape: list | scalar | present} - what the request must be able to carry whatever the user
  chose (a failure: the call CONTRADICTS the item); `REQUEST_WHEN` {path, shape: none | one | list | list>=2 | present}
  - which calls exercise the item (others are about another choice: not counted); `STATUS` {range} and
  `ROWS_MATCH_FILTER` {rows, field, path} - every row's field among the request filter's values (WRONG otherwise);
  `ROWS_PRESENT` {rows, min} - without rows nothing is proven (NO_DATA). A path's last key may end in `*`
  (`$.branch*`): it must match exactly one key, else the call is UNKNOWN - never MISSING. `none` is absent, null,
  empty, `"all"`, `*` or `-1`. Claude drafts it (`board_evidence_put`, saved at once, no approval); the user's version
  wins - Claude is refused on evidence the user wrote. New checks forget what calls showed under the old ones.
- **Judging** (`RequirementService`, `domain/RequirementJudge`): `BoardRetestWatchAdapter` offers each completed
  inbound call (project + endpoint); on its own single-thread executor, an in-memory list of watched endpoints is the
  only cost of a call nothing watches. A watched one: the cycle's calls not judged yet are read (bodies once, ≤ 8 MB,
  nothing kept) and one `item_call_results` row per item and call is written; again 20 s later for a call that was not
  in the cycle yet. Calls arriving together cost one pass per cycle (500 ms window, plus one late pass), however many
  there are; a pass reads up to 20,000 of the cycle's calls. `GET /board/cycles/{id}/requirements` judges what is new first, so a recording made before its
  evidence is judged on read.
- **Verdict per item**: the worst result among its calls since the newest of the project's last app start (when the
  cycle has calls after it - a new build makes the old code's calls history) and the last status change of a Fixed card
  about the item: MISSING > WRONG > MET > NO_DATA > UNKNOWN > NOT_EXERCISED; `UI` → MANUAL; no evidence → NO_EVIDENCE.
- **Cards** (opened as Claude, so every Claude limit applies; `item_cards` remembers them): the items MISSING / WRONG
  on the same failing check of the same call share one TASK `Missing feature: …` (BUG `Wrong result: …`), teams
  Backend + Frontend (Backend), with the items linked, the deciding call linked first and each later call of the same
  verdict linked (≤ 10 per run), and a first comment that says no model opened it. The card is created with no call in
  its text, so a closed card that only shares a call is no reason to refuse it; instead an item whose card the user
  closed as Fine / Not in this flow is never carded again, and another open card about the item means no new one.
  When a card's items become MET it gets one comment, or - when every item of it is met and it is Fixed / Verified -
  a proposal (Verified / Done) the user accepts. Nothing is closed, marked or moved in code. At most 10 such cards per
  cycle per hour; over that one NOTE says the check paused (usually wrong evidence).
- **Task tab**: each requirement row shows its verdict as a short pill (reason on hover), and the opened row the reason
  (the failing check and the value seen); **⚙ how the calls show it** opens the evidence as lines (`shape $.branch* list`,
  `when $.branch* list>=2`, `match $.payload branch* in $.branch*`, `rows $.payload`, `status 2xx`). The `/ws/board`
  signal `requirements` reloads it - no timer.
- Versions: the tables are new; verdicts and results are read tolerantly (a later value reads as UNKNOWN), and no
  `Flag`, `Actor` or card field was added, so a board exported from this version imports into an older Alfred.

## Cleaning up after a cycle

Deleting a session cycle always removes its board brief, spec files, checklist marks and suggestions, session log and
test-step marks (`cycleRemoved`). Since specs/027 a cycle holds only calls: the delete dialog shows the plan
(`GET /board/cycles/{id}/delete-plan` - which boards it is on, which mentioned calls are kept) and cards are never
deleted with it; a cycle whose calls board texts mention is kept, trimmed to them (see "Boards"). Cards of a task
board stay on it; older cards whose cycle went are marked "◷ cycle deleted". Kept cards are found later with the **◷ Cycle deleted** filter (`cycleDeleted=true`)
and removed with the bulk **🗑 Delete…** (`BulkAction.DELETE`, with a confirm naming the cards). Claude can do neither.

SQLite keeps the pages deleted rows freed and reuses them, but the file does not shrink. **Settings → Storage → Board**
(`GET /board/storage`) shows board.db on disk, what the data uses and the free space inside; **Compact**
(`POST /board/storage/compact`, user only) checkpoints the WAL and runs `VACUUM`.

## Edit access

Board writes follow the server-settings rule (`EditAccessUseCase`), with one exception: Docker, which refuses every settings write, lets board edits through, because cards are data, not settings. The Cloudflare tunnel is always view-only. `GET /board/access` returns the same decision to the page, which then hides its edit controls and shows "View only". Export stays available.

## Visuals and snippets (specs/017)

Every board text can show a picture of its evidence. The words still come first; a visual backs them up.

- **Markdown and HTML together**: raw HTML inside Markdown is never drawn as markup (a text cannot inject a page) -
  it shows as its text. Claude may still write either or both: its MCP tools (`mcp-server/src/board-text.ts`) turn HTML
  the board draws itself into board Markdown and HTML with a script, style sheet, SVG or canvas into an
  ```` ```html live ```` snippet before saving. In the editor, pasted HTML is read the same way.
- **Fixed blocks** (drawn by the board, no code): ```` ```stats ```` (label | value | colour | note), ```` ```chart ````
  (bar, hbar, line, area, pie, from a number grid), ```` ```timeline ```` (label | start | length ms), ```` ```mermaid ````
  diagrams, `[progress: 3/9 …]`, `:::tabs` with `## Title` per tab, and colour `{red|text}`. ⬇ PNG on each chart and
  diagram. The editor's Visual menu opens a block editor with a live preview.
- **Live data blocks** read Alfred as calls arrive (no polling - each re-reads on the `/ws` "calls changed" and
  `/ws/board` signals): ```` ```calls ```` (`endpoint`, `since: fix|24h|<iso>|cycle:<id>|call:<id>`, `until`,
  `show: table(...)|chart(field)`, from `GET /board/data/calls`, `boardbridge/BoardDataController`), ```` ```sql ````
  (a statement's rows), ```` ```logs ```` (a call's lines), ```` ```compare ```` (two calls side by side) and
  `!@[call:in:…]` alone on a line (the expanded call view). The editor's `/call /calls /sql /logs /compare` commands pick
  the real data.
- **Snippets** (```` ```html live ```` in any text, or a **page**): HTML, CSS and JavaScript in a locked frame -
  `iframe sandbox="allow-scripts"` (never `allow-same-origin`), a Content-Security-Policy first in the document that
  allows no network at all (`connect-src 'none'`; scripts only inline or from Alfred's `/lib/`; pictures only data:,
  blob:, `/lib/` and `/board/images/`). The frame talks only to the board, through `postMessage`, and the board checks
  the sender is that frame, the message's shape, 50 messages a second and 5 MB per answer (`snippet-bridge.ts`).
  `window.alfred` inside: `data(src, args)` / `watch(...)` (the allowlist: calls, call, statements, rows, logs, redis,
  cards, card, cycles, rules - GET only), `state.get/set/all` (saved, shared, live), `action(kind, args)`,
  `ask(question, data)`, `files(name?)`, `file(name)`/`url(name)` (a multi-file snippet's own files), `lib(id)`.
  `<script type="alfred/data" name src live>{args}</script>` declares data up front. Bar: ⤢ full screen, `</>` source,
  ⬇ PNG, ⬇ .html (a file that opens anywhere, libraries inside), copy, console (last 200 lines), ▶ click-to-run (per
  browser; snippets run on open by default). A frame off screen is paused.
- **Multi-file snippets**: `--- chart.js`, `--- look.css`, `--- rows.csv` on a line of their own start files after the
  page. `import "./chart.js"` works between them (an import map of blob URLs), `./look.css` is applied, a classic
  `<script src="./x.js">` runs in place, and data files are read with `alfred.file(name)`.
- **Python** (```` ```python live ````): Python 3.12 (Pyodide, with numpy, pandas, matplotlib) in the same locked frame.
  `await alfred.calls(since="fix")` is a pandas DataFrame, `await alfred.data(...)` any allowed source; `print()` goes
  to the console, the last line is shown (a DataFrame as its table), each matplotlib figure is drawn. Its frame may read
  only `/lib/pyodide/<major>/` (nothing else). Pyodide is on the shelf only when Alfred was built with it:
  `frontend/scripts/fetch-pyodide.mjs` runs before every `ng build` (and in `build_dist.py`) - core from the pinned
  `pyodide` npm package, packages from the Pyodide release, each checked against the sha256 of the pinned lock file.
  Without a network the build still succeeds and Python snippets say Python is not on the shelf.
- **The library shelf** (`/lib/<id>/<major>/…`, listed at `/lib/index.json` by `scripts/lib_index.py`): Chart.js,
  ECharts, D3, Plotly, Mermaid, Three.js, Preact + htm, Alpine.js, Tailwind, Marked, highlight.js, PapaParse, dayjs,
  lodash, Observable Plot (loads D3 with it), ApexCharts, Lucide icons, Grid.js (+ its theme), Cytoscape, anime.js -
  copied from npm by `angular.json`, served with `Access-Control-Allow-Origin: *` (the frame's origin is
  opaque) by the frontend's nginx and natively by `SpaPageFilter`. When a browser keeps the frame from reading `/lib/`
  the board passes the libraries in (`SnippetShelfService`); Python cannot travel that way.
- **The frame's design kit** (`snippet-frame.ts`): plain markup already looks like Alfred, and classes give a dashboard
  with no CSS of its own - `.grid`, `.row`, `.stack`, `.card`, `.kpi` (`.label .value .note`), `.badge.ok|warn|err|info`,
  `.bar` (`style="--v:.42"`), `.chart` (height `--h`), `.table-wrap`, `td.num`; every rule is in `:where()` so the
  snippet's own styles win. ECharts, Chart.js, ApexCharts, Plotly, Observable Plot and Mermaid get the dark theme and one
  palette by default (`alfred.palette`, `alfred.colors`); an ECharts chart follows its box's size. `alfred.calls(args)`
  reads the calls of the cycle the snippet is shown for (a cycle's brief or chat; a card's snippet reads live calls) and
  `alfred.fmt` formats ms, numbers, percentages, times, bytes and paths. A classic `<script>` declaring a window global
  (`const top`, `var name`…) is put in a block of its own - in a page it would be a SyntaxError or a string.
- **Chat answers** are snippets like any text: each live block of an answer is `inline:chat:<message>:a:<n>`, its
  picture and console kept as the chat shows it, so `board_snippet_view` works on it; `chat_reply` turns HTML into board
  text first and lists those ids. The chat Claude is taught the forms in its rules (`CHAT_RULES`, VISUALS).
- **Pages** (`snippets` + `snippet_versions` in board.db, `GET/POST /board/pages?owner=card:|cycle:|project:`,
  `GET/PUT/DELETE /board/snippets/<id>`): named snippets, diagrams, Python or fixed blocks (kind BLOCK) on a card, a
  cycle's brief or the project (◈ Pages on the board), shown as tabs. Every save is a version (⟲ Versions: line diff,
  both drawn side by side, restore); a save based on an older version is a conflict (409). ⧉ Pop out opens
  `/board/page/<id>` alone. Claude creates pages and changes only its own.
- **Saved values** (`snippet_state` + history, `/board/snippets/<id>/state/<key>`): JSON up to 64 KB per key, 200 keys,
  per snippet - a page's id or an inline block's `inline:card:<cardId>:<desc|entryId[pN]>:<n>` /
  `inline:cycle:<cycleId>:<goal|desc|oN>:<n>`. Every change signals `state:<id>` so every open view updates.
- **Pictures for Claude** (`snippet_shots`): after a version is first drawn, the board keeps a PNG of the frame (an SVG
  foreignObject snapshot made inside the frame, canvases copied) with its console. `board_snippet_view` gives Claude
  that picture and the console, so it can check a snippet before saying it is ready.
- **Actions, choices and forms**: `[action: move FIXED | Mark fixed]`, `[choose: A | B]`, ```` ```form ```` and a
  snippet's `alfred.action(...)` act only on a card being read (never in a preview). Each shows the consent dialog with
  the exact change first and runs only on the user's click, as the user: reply, answer (`**Answer** choice: B` /
  `field=value; …`, clears Needs decision), run-skill, retest, move, flag, propose, rule (opens the rule editor),
  open-call. Anything else is refused before a dialog.
- **Ask Claude**: a snippet's `alfred.ask(...)` (consent the first time per snippet) or the editor's ✦ menu over the
  selected text (make a chart, shorten, translate to Arabic, as a table, as a snippet, or your own question) sends
  `/alfred-ask <id>` to the cycle's chat (`asks` table, `POST /board/asks`); Claude answers with `board_ask_answer` and
  the snippet, or the editor's Replace / Insert below, gets it on the `ask:<id>` signal.
- **Pinned**: 📌 on any block or snippet of a card's text (or a brief) makes it a pinned page - shown open at the top of
  the card or brief, its dashboard. Unpin sends it to the Pages tabs. Claude pins its own pages with `board_pin`.
- **Widgets** (`widgets` table, `/board/widgets/<name>?project=`): ★ on a block or page saves it as a named project
  widget; `{{widget:name | key=value}}` alone on a line shows it in any text of the project, `{{key}}` in the widget
  filled with the value (an HTML widget also gets them as `alfred.context.params`). A widget using itself stops three
  deep. Claude lists them with `board_widgets` and saves its own with `board_widget_put`.
- **Files** (`board_files`, `POST /board/files?card=|cycle=&project=&name=`): 📎 on a card or brief (or in the editor,
  which puts `[📎 name](/board/files/<id>)` in the text): csv, json, txt, log, har, xml, sql, md, pdf, png, jpg - at
  most 10 MB, 50 per place; the bytes must match the name (a PNG starts as one, text is UTF-8 without NUL bytes). A file
  is always served as a download in a sandbox (`Content-Disposition: attachment`, `nosniff`, `CSP: sandbox`), never as a
  page; `?inline=true` gives a text file as plain text to a snippet. Deleted with its card or cycle. Claude reads one
  with `board_file` and attaches its own with `board_attach`; the backend's cleaner keeps no relative link but
  `/board/files/<id>`.

## Board chat (specs/022)

Every project has one chat and every session cycle has one, opened from a pill floating bottom-right on every tab (the
unread count and the three chats that changed last; an amber ring when one needs you). A click opens the list above it
(a "Needs you" section on top, then the project chat, then the cycle chats newest first; Ctrl+K finds one by name); the
page keeps its full width. A chat opens as a window above the pill: one header row (who answers and what it is doing,
⌕ search, ⋯ for everything else, – to fold it to a tab beside the pill, ✕), a context line only when something is worth
knowing (the terminal moved on, a watch), and a composer that is one box (@, /, Aa for formatting, ⚡ answer first,
send). Dragged across the middle, the pill moves to the other side. Views: the window (resizable from its inner edge),
expanded, full screen (Esc / Ctrl+Shift+F) and a separate window (`/chat?project=&scope=`); the view, width and side
are this browser's own (localStorage, try/catch). On a cycle's page the chats follow that cycle's project.

- **Who answers.** A cycle chat - and every comment on a card of that cycle - is answered by the terminal session that
  ran `/alfred-live` for it: that session itself, never a fork or a copy (specs/022 plan-terminal-answers.md). The
  runner (`skills/alfred-live/chat.mjs`) takes the message for that session's id and writes one `✉ board chat #N` line
  (a card: `✉ #N`) into the session's own chat log (`<board>.<session>.chat.log`), which the session follows with the
  Monitor tool; the session answers with `chat_reply` / `board_reply` when its turn is free. Alfred stores only the
  user's messages, the final answers, what needs the user (questions, proposals, confirmations) and records - never the
  steps between. A decision needed mid-task is an ordinary reply that asks it; the job waits for the answer. The
  session marker (`chatSessionId` = `forkedFrom` = the terminal's id) says so: the header shows "Answered by your
  terminal", there is nothing to catch up and nothing is mirrored back. A busy terminal: messages wait. A closed one:
  "Terminal offline - messages wait" - Alfred never starts or resumes a session itself. The newest `/alfred-live` for a
  cycle takes it over: the old session gets `↪ handed over` in its log and stops listening, the messages it held are
  queued again for the new one, which starts from the chat's summary and the brief. Cards of other cycles and the
  project chat stay with the project's live runner, answered as before (a fork, below, still applies to an older runner).
- **States.** A user's message is WAITING -> TAKEN (compare-and-swap, `taken_by`) -> ANSWERED / STOPPED / CANCELLED. It
  can be edited or cancelled only while waiting; "⚡ answer first" puts it ahead of everything waiting, after the step
  Claude is on. A waiting message shows its place in line, counting a card Claude is answering ("busy on #N"). A runner
  that went away gives its taken messages back to the queue (new `wait_seq`); a run that failed or was stopped stops the
  message with a system line.
- **Changes.** `board_changes` / `board_wait` carry the chats as a third cursor part (`activity.cycle.chatSeq`; a
  two-part cursor still works) - messages to take, urgent first, and what the chat sent the terminal.
- **Records** (FR-048): an answer records, unasked, what another session needs - DECISION / NEXT appended to the cycle
  brief, CARD an Inbox card as Claude, ITEM a proposal on the spec file, FIX a fix report moving the card to Fixed. Each
  shows as one "✓ recorded ..." line with Undo (the user's; refused when the brief changed since). Claude's board limits
  apply to every record.
- **Mirror to the terminal** (FR-050/051): each exchange is one item, masked like the MCP output, with bulky parts as
  references (`chat_read`). It is written to the runner's chat log at the terminal's next turn (`💬 board chat ...`);
  urgent items (`⚡ board chat: ...` - a decision that contradicts the terminal's step, files the chat changed,
  `@terminal`) at once. An item is held while no session holds the cycle and handed to the next one; Undo while unread.
- **Catch-up** (FR-052/055): the runner learns of the terminal's turns from `fs.watch` events on its transcript, never a
  timer; before answering it adds only the terminal's new transcript entries (delta), and re-forks after a compact there.
- **Compact** (FR-014/015): ⇊ or auto after 100 messages since the last summary (per chat, 20-1000, 0 = off) queues a
  task; Claude writes a SUMMARY covering everything before the first message still in flight. Nothing is deleted: older
  messages fold under it, stay searchable and are exported.
- **Memory and meter** (FR-056/059): two pills - the Claude session (the chat's copy, on the runner's machine) and Alfred
  (summary, decisions, records); the meter shows the last run's tokens. "Continue in terminal" gives
  `claude --resume <chat session>` and names the machine. A new conversation taking over (another machine, another
  terminal session) is marked with a system line (FR-016).
- **Card comments** on a cycle's cards that need an investigation are answered by that cycle chat's session, on the card
  (FR-060); the chat shows "↳ answered your comment on #N".
- **Unread and notifications**: an unread line "- N new -", ↓ Latest, drafts per chat, the Board tab's 💬 count, and per
  chat: every reply / only questions and failures / muted (no count, no pop-up).
- **Mentions**: `@[chat:<project>/<scope>#<id>|...]` opens the chat at the message; a call mentioned in a chat is kept out
  of the storage limits like a commented call. ＋ Card makes a card from a message.
- **Looking at** (FR-020/021): 💬 Ask on a call (Live Calls, session cycles), a DB statement, a call's log line and
  `ask` on an Acceptance item open the item's cycle chat (else the project chat) with the item as a removable chip; the
  card open in a drawer is offered too. Chips travel as the message's `context` (`shared/utils/chat-context.ts`).
- **"/" skills** (FR-022): the composer's "/" menu lists the shipped /alfred-* skills except alfred-live and
  alfred-listen (`chat-skills.ts`, checked against `alfred_skill.SKILLS` by `test_alfred_skill.py`); the chat's Claude
  loads the picked one with the Skill tool and runs it as far as its tools allow (the chat never edits code).
- **While you were away** (FR-023): opening a chat after its digest gap (default 30 min, per chat) shows one folded
  digest of the board's history since the last look - no model (`ChatDigest`, `GET /{scope}/digest`, 204 when nothing).
- **★ decisions, questions, reactions, ask again, Shared** (FR-024/025/043-045): ★ records the same DECISION as an
  answer does (brief + Undo); Claude's `extra.questions` are answered all or some and sent back once as one message in
  the thread; reactions are the board's plus ❓ ("explain more" in the answer's thread); ↻ keeps the answer, marked asked
  again, and asks once more with what to read; 🗂 lists everything the chat mentions.
- **Proposals and consent** (FR-026..028, FR-046): Claude's `extra.proposals` (verify, close as Fine, move, a checklist
  mark, a new acceptance item) are checked against the board when shown and again on Accept, applied as the user, one by
  one or in bulk, with Undo for 60 s (`ChatProposalService`, tokens in memory); an applied one keeps its own Undo after that (`undoOne`, from the status or mark it kept), refused when the board changed since. A resend or rule (`extra.consent`) runs
  only through the consent dialog, into the existing resend dialog or rule editor. → Card posts a message (or the
  selected part) to a card as a comment linked back.
- **Watches** (FR-030/031): ◉ "watch while I test" keeps one waiting check task per cycle chat while its Claude is on;
  calls join it until it is taken; a clean batch posts nothing (`{quiet: true}`); /alfred-listen's findings also appear
  as "👂 listen runner". "Tell me when" (`chat_watch` STATUS / ERROR_LOG / ITEM_PASSES) posts one 🔔 line and ends -
  driven by completed calls and the board's requirements signal, never a timer (`ChatWatchService`).
- **Bridge and split** (FR-035/047): the project chat can ask the Claude of a cycle - the exchange lives in the cycle's
  chat and shows in both; ⋯ → "Open another chat beside" opens a second window, ⇆ swaps them.
- Through the tunnel the chat is read-only. Removing a cycle removes its chat.
- **Retention**: chat messages are kept until their cycle is removed - deliberately unbounded like session-cycle capture
  (people type them; a compact folds, never deletes). Every read is paged (50 per page, 200 per export page, search ≤ 200
  hits), the bar reads one row per chat, and the Shared view walks the chat 500 messages at a time.

## Export and import

- **Board export**: Board → .md, .html or .json, either the whole board or the selected cards.
- **`alfred-board/1`** (`board-json.ts`): a header line, then one record per line: card (fields plus direct links), activity (by card number), brief, briefComment, spec (in full) and mark. Nothing is shortened. `POST /board/import?project=` streams it in. A clashing number gets the next free one, and `@[card:...]` mentions of moved cards are rewritten to match.
- **The HTML export** escapes every value; a rich text is written as the board's own clean HTML rebuilt from its blocks. The .md export converts rich text to Markdown; the .json keeps every text as stored and adds an `image` record (base64) per picture the texts show, so an import elsewhere shows them too (checked like an upload; an id already there is kept).
- **Visuals in the exports** (specs/017 R43): the .json adds a `page` record per page with every version, `state`,
  `shot` (PNG, base64), `file` (base64) and `widget` records - an inline block's id is written with its card's number
  (`inline:card:#7:desc:0`) and a page's state as `page:<id>`, which the importer maps to the new ids; a file keeps its id
  (texts link to it) unless that id is already here, and a widget whose name the project has already is kept as it is.
  The .md writes each page's source whole with its picture embedded as a PNG, the inline snippets' pictures, the files
  and the widgets. The .html runs every snippet in the same locked frame, offline: its libraries inside, its saved values,
  files and declared `alfred/data` answered from what was read at export time; Python shows its picture.
- **Board chats in the .json** (specs/022): a whole-board export adds every chat of the project, a cycle's export its
  chat - `chatSettings`, `chat` (one per message), `chatRecord`, `chatTerminal`, written by the backend
  (`GET /board/chats/export`, paged, `ChatTransfer`) and read back by the importer. Sessions never travel. Threads,
  answers and summaries are remapped; a message still waiting comes back STOPPED, a record keeps its line but cannot be
  undone here, terminal items come back read; a cycle chat whose cycle is not here lands in the project chat marked
  `[from cycle <name>]`.
- **Boards in the .json** (specs/027): right after the cards come `board` (id, name, isDefault, state), `board-cycle`,
  `board-board` (one per pair), `card-cycle` (by card number) and `workitem-snapshot` records; a card carries `boardId`.
  The import recreates the boards in the target project (a default board is the target's default; an id another
  project holds here gets a new id and its briefs, specs and marks follow it), relates their cycles and boards, and sends
  each card home. A file with no board records puts every card on the default board. Snapshots are for reference: the
  link to the tracker is not recreated.
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

**Board chat** (specs/022, running Docker stack, 2026-10-16, throwaway project/cycle):

- With 5,000 messages in one chat: a page of 50 **5-9 ms**, the bar **9 ms**, search **~80 ms**, the Shared view
  **~75 ms**, `task_context`'s chat section **~12 ms**, an export page of 200 **~18 ms**.
- SC-001 (send to Claude's first live step, Claude on), 10 tries over a project chat and a cycle chat: **0.27, 4.56, 3.99,
  0.28, 0.30, 0.28, 0.28, 0.28, 4.03, 4.86 s** - under 5 s each time. About 0.3 s when the runner is idle; about 4-5 s
  when the message arrives while the runner is still finishing the previous answer (its mirror and session update). A
  message sent before the runner started is taken within 3 s of the start. A short answer lands in 5-9 s.
- Tokens per exchange (the meter): about 57k prompt tokens per model turn, two turns for a trivial question. After the
  first exchange almost all of it is cache reads (114-118k read, about 2k written), about $0.46-0.55 per exchange.
- Monitor events per exchange: one 💬 line in the runner's chat log per exchange, plus one ⚡ line when the user wrote
  "@terminal" (6 exchanges gave 6 💬 and 1 ⚡); a compact sends one pointer line.
