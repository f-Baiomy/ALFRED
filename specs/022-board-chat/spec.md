# Feature Specification: Board Chat

**Feature Branch**: `022-board-chat` (built on master, like specs/014-021)
**Created**: 2026-10-15
**Status**: Planned (spec, plan, tasks analysed 2026-10-15)
**Input**: User description: "a chat across the session-cycle board and the whole project board ... the session cycle board context will be the context of the Claude session related to it and the Alfred session context" - refined in a grilling session (decisions recorded below).

## Overview

Every session cycle and every project gets one chat with Claude. A cycle's chat is answered by its own Claude
conversation, made as a copy (fork) of the Claude Code session working that cycle in the user's terminal: it starts
with everything that session knows, then continues as one conversation, plus everything Alfred holds for the cycle
(brief, acceptance items, cards, calls, statements, log lines). The terminal session itself is never written to.
Because the fork is one-way, Alfred is the shared memory between the two: the chat's Claude records what another
session needs (decisions, cards, acceptance items, fixes, open questions) and sends the terminal session what affects
its work; the chat refreshes its copy when the terminal has done significant work. The project's chat is
answered by the project's live Claude runner with the whole project in view. The chat opens in a panel docked at the
side of any tab and follows what the user is looking at.

The work is delivered in four phases inside this one specification: P1 the chat itself, P2 context, P3 actions,
P4 rich answers. Each phase is built, tested and committed on its own.

## Clarifications

### Session 2026-10-15

- Q: Project chat with no project live runner but cycle chats alive - what happens to a message? → A: It waits and the panel shows the start steps for the project runner; cycle chats never answer the project chat on their own (only through the explicit bridge).
- Q: When does the since-you-left digest appear? → A: When the user's last look at the chat is at least 30 minutes old and something changed since; one digest per return, folded once read; the gap is editable per chat.
- Q: What does Accept do on a proposal that no longer fits the board? → A: Every proposal is re-checked against the board when shown and on Accept; an outdated one reads "already done" or "outdated: <why>" and cannot be accepted.
- Q: How are watch messages kept readable? → A: One message per batch of calls, posted once the calls settle and updated in place while the batch grows; a clean batch posts nothing; "tell me when" posts once; these messages count toward auto-compact.
- Q: How does the cycle chat get the context of the Claude session related to it (writing into the open terminal session is unsafe: two writers, and the terminal would not see the turns)? → A: Fork once, continue the fork - the first chat message forks the terminal session (`--resume <id> --fork-session`), every later message continues that fork. Alfred is the shared memory between chat and terminal (FR-048..FR-053). See explain-session-context.html.
- Q: What does the chat's Claude record without being asked? → A: Only what another session needs to continue correctly: a decision → the cycle brief's Decisions; a new problem → Inbox card; a new acceptance condition → proposed item; a code change → fix report + re-test plan; a question left open → the brief's Next. Plain explanation stays in the chat. Each record shows as a line in the chat with Undo.
- Q: What reaches the terminal session? → A: Everything, in full but cheaper: one item per exchange with the whole answer's prose, bulky parts (SQL, diffs, call bodies, visuals) as references opened on demand, coalesced while the terminal is busy, never echoing what the terminal wrote, a compact sent as a pointer. Urgent (act on it first): a decision contradicting its work, a chat change to files it works on, @terminal. Delivered through the runner's chat log the terminal already follows (like card answers today) and as "From the board chat" in board_changes / board_wait / task_context; held for the next session when the terminal is closed.
- Q: How is usage kept low without losing context, with nothing for the user to configure? → A: Eight automatic measures (FR-055): delta catch-up instead of re-fork, mirror rides the terminal's next turn (only urgent wakes it), one run for messages waiting together, catch-up while the cache is warm, stable prompt prefix, summary-first tool results, no re-fetching what the session holds, no run when nothing is new; a token meter shows what was used and saved (FR-056).
- Q: Can Alfred on another host (192.168.1.83) reach the local session? → A: It never needs to: the runner on the user's machine does everything that touches the session; Alfred stores text only. Five machine cases are handled (FR-058).
- Q: What happens to card comments? → A: They use the same memory as the chat: a comment on a cycle's card is answered by that cycle chat's Claude session (posted on the card), a project card's by the project chat's session; mirrored and recorded like chat; investigations go to the chat session instead of the terminal; plain moves/closes stay noted (FR-060).
- Q: Is any answer written twice? → A: Stored once in Alfred and written once by the chat's Claude; the terminal reads it once more as input - that read is the mirroring cost. A refresh of the chat's copy MUST NOT pass again the chat history the terminal copy already holds (only messages after the last mirrored one).
- Q: Where can the chat sit? → A: A Messenger-style chats bar always docked on the left lists every chat; the open conversation is docked beside it, expanded, full screen, or in a separate window (added after the first mock).
- Q: A /alfred-listen runner already checks the cycle when the user turns Watch on - who watches? → A: Watch still runs in the cycle chat's own session; the listen runner keeps its job and its findings are also posted into the chat, marked "listen runner"; the panel shows both are watching.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Talk to the cycle's Claude (Priority: P1)

While testing a session cycle, the user opens the chat panel, types "why did the branch search return all branches?",
and the cycle chat's own Claude session - a copy of the terminal session working this cycle, so it knows that work -
answers in the panel, with the calls, statements and items it means drawn as clickable chips. While Claude works, the panel shows its live steps and a Stop button.

**Why this priority**: it is the feature. Everything else builds on a message reaching the right Claude and an answer
coming back.

**Independent Test**: with a Claude chat holding a cycle, send a message from the panel; the answer appears in the
panel, written by the chat's copy of the terminal session (it refers to work the terminal did earlier).

**Acceptance Scenarios**:

1. **Given** a Claude chat holds the cycle, **When** the user sends a message, **Then** the cycle chat's own Claude session (forked once from that chat's terminal session, never writing into it) answers, and the reply appears in the cycle's chat panel.
2. **Given** Claude is answering, **When** the user looks at the panel, **Then** they see the live steps of the work and can press Stop.
3. **Given** a card comment was sent before the chat message, **When** Claude picks up work, **Then** it answers them in the order they arrived.
4. **Given** no Claude chat holds the cycle, **When** the user sends a message, **Then** it is kept as "waiting", the panel shows the steps to start Claude on this cycle, and the message is answered once Claude starts.
5. **Given** the user's message is still waiting, **When** they edit or cancel it, **Then** Claude receives the edited text or nothing.

---

### User Story 2 - Talk to the project's Claude (Priority: P1)

On the whole project board, the user asks "which cycles still have failing acceptance items?" and the project's live
runner answers with the project in view (all cycles' briefs, open cards, recent problems).

**Why this priority**: the second half of the request; same mechanics as story 1 with a wider scope.

**Independent Test**: with the project runner on, send a message from the project board's chat; the answer covers
more than one cycle.

**Acceptance Scenarios**:

1. **Given** the project's live runner is on, **When** the user sends a message in the project chat, **Then** the runner answers it there.
2. **Given** the panel is open on the Live Calls tab with no cycle selected, **When** the user types, **Then** the message goes to the project chat of the project in view.

---

### User Story 3 - Keep the conversation across sessions (Priority: P1)

The chat history survives restarts and a change of Claude conversation. When a long chat grows, it is compacted: Claude
writes a summary, older messages fold under it and stay readable and searchable. A new Claude conversation that takes
over the cycle starts from that summary and the messages after it.

**Why this priority**: without it, closing the Claude conversation loses the thread of the work - the user's main fear
("so I don't lose context").

**Independent Test**: chat, close the Claude conversation, start a new one on the cycle, ask "what did we decide?" -
the new conversation answers from the earlier chat.

**Acceptance Scenarios**:

1. **Given** 100 messages since the last summary (the default), **When** the next one arrives, **Then** a compact task is queued, and Claude writes a summary message covering everything before it.
2. **Given** a compacted chat, **When** the user expands the fold, searches, or exports the board, **Then** every original message is there in full.
3. **Given** the user presses Compact, **When** Claude is on, **Then** a summary is written at once regardless of the count.
4. **Given** a new Claude conversation takes over the cycle, **When** it starts, **Then** it receives the latest summary and every message after it, and the panel marks the switch.
5. **Given** the user changes the auto-compact count or turns it off for this chat, **Then** the new setting is used from the next message.

---

### User Story 4 - Compose like a card comment (Priority: P1)

Messages are written in the same editor as card comments: mentions of calls, statements, acceptance items, cards and
log lines; images; snippets. The user can quote a message, reply in a thread under it, search the history, turn any
message into a card, and mention a chat message from a card.

**Independent Test**: write a message with a call mention and an image, reply to it in a thread, make a card from it,
and open the card's link back to the message.

**Acceptance Scenarios**:

1. **Given** the composer, **When** the user types "@", **Then** the same mention picker as card comments opens.
2. **Given** a message, **When** the user replies to it, **Then** the reply sits in a collapsed thread under it ("3 replies") and Claude answers with that thread as focus.
3. **Given** a message, **When** the user chooses "Make card", **Then** the add-card form opens prefilled with its text and mentions, linked back to the message.
4. **Given** a reply from Claude arrives while the panel is closed, **Then** an unread badge shows, and a browser notification is shown if the user turned them on.

---

### User Story 5 - Ask about what I am looking at (Priority: P2)

The user right-clicks a call in Live Calls (or a session-cycle call, a database statement, a log line) and picks "Ask
Claude". The panel opens over the current tab with that item attached as context. Each message also carries what the
user has open - card, selected call, spec item, statement - as a removable chip.

**Acceptance Scenarios**:

1. **Given** an item captured in a recording cycle, **When** the user picks "Ask Claude", **Then** the cycle's chat opens with the item attached; otherwise the project chat does.
2. **Given** the user has card #49 open, **When** they send "is this fixed?", **Then** the message carries #49 as context and Claude answers about it; removing the chip before sending removes the context.

### User Story 6 - Commands, digest, decisions, questions (Priority: P2)

Typing "/" lists the shipped Alfred skills (except the two that run the chat itself); picking one makes the cycle's
Claude run that skill in its own session and post the result. Opening the board after time away shows a digest of what
changed. Any message can be marked a Decision, which every later Claude session follows. Claude can ask grouped
questions with options and the user answers them in one batch.

**Acceptance Scenarios**:

1. **Given** the composer, **When** the user types "/", **Then** the skills are listed with a one-line hint each, and the runner skills are not.
2. **Given** the user returns after a gap with changes on the board, **Then** the top of the chat shows a digest built by Alfred (new cards, verdict changes, failed calls) - even with no Claude on - and Claude adds its own reading when it is on.
3. **Given** a message marked Decision, **When** any later Claude session starts on the cycle, **Then** the decision is in what it is handed.

### User Story 7 - Act from the chat, with my approval (Priority: P3)

Claude's reply can carry proposals the user accepts with one click: mark Verified, close as Fine, move, a checklist mark
with a call as evidence, a new acceptance item, or a list of them at once (bulk). The user can post a reply to a card as
a comment. Claude can prepare a resend of a call or an interception rule; each goes through the existing consent dialog
before anything happens. When Claude fixes code in its session, the chat gets a fix report (changed files, short diff)
and the card's re-test plan is set.

**Acceptance Scenarios**:

1. **Given** a reply with a proposal, **When** the user accepts it, **Then** it is applied as the user's own action; declining leaves the board unchanged.
2. **Given** a bulk proposal of five items, **When** the user accepts two and declines three, **Then** only the two are applied.
3. **Given** Claude prepared a resend, **When** the user has not confirmed in the consent dialog, **Then** nothing is sent.
4. **Given** any action Claude takes from the chat, **Then** it stays within Claude's board limits (Inbox-only new cards, never close, delete, scope or mark by itself).

### User Story 8 - Watch, notify, show (Priority: P4)

The user turns on "Watch while I test": the same Claude session checks calls as they arrive and posts findings live.
"Tell me when AC8 passes" or "when any 500 happens" sets a watch that posts once and ends. Replies can hold live charts
and tables (pinnable to the board as widgets), a side-by-side diff of two calls, a comparison with another cycle, or a
written report page. The project chat can ask a cycle's Claude a question; the exchange shows in both chats.

**Acceptance Scenarios**:

1. **Given** watch is on, **When** a batch of new calls completes and settles, **Then** one message with that batch's findings appears, linked to its calls and items (none if the batch is clean); turning watch off or stopping the recording ends it.
2. **Given** "tell me when AC8 passes", **When** AC8's verdict becomes passing, **Then** one message is posted and the watch disappears from the panel's watch chips.
3. **Given** the project chat asks a cycle's Claude, **Then** the question appears in the cycle's chat marked "from project chat" and the answer appears in both.

### Edge Cases

- Claude conversation closed while answering: the message returns to "waiting" and the partial live steps stay visible as stopped.
- Two Claude conversations try to hold one cycle: the existing one-chat-per-cycle rule stands; the second is refused and the chat keeps one owner.
- Cycle deleted: its chat goes with it; cards made from its messages stay, their back-link shows "message removed".
- Viewer reaches Alfred through the Cloudflare tunnel: sees the chat and live steps, cannot send, edit, compact, accept or start watches.
- Compact requested with no Claude on: queued, shown as "compact waiting".
- A message mentions a call later removed by the storage limit: the call is kept, like a call mentioned on a card.
- Board export from an older Alfred with no chats imports fine; an import with chats into a cycle that does not exist is kept under the project chat, marked with the missing cycle's name.
- Very long message or image-heavy message: same size limits as card comments.

## Requirements *(mandatory)*

### Functional Requirements

**P1 - chat**

- **FR-001**: The system MUST give each session cycle one chat and each project one chat.
- **FR-002**: A cycle chat's messages MUST be answered by the chat's own Claude conversation, forked once from the Claude Code session holding that cycle and continued for every later message; the terminal session MUST never be written to. A cycle with no terminal session, and the project chat, start their own conversation from Alfred's context and continue it. A project chat's messages go to the project's live runner.
- **FR-003**: Chat messages and card comments for the same Claude MUST be handed over in the order they arrived.
- **FR-004**: With no Claude to receive them, messages MUST be kept as "waiting" and the panel MUST show the steps to start Claude for that scope. A project-chat message waits for the project's live runner even when cycle chats of the project are alive; a cycle chat answers the project chat only through the bridge (FR-035).
- **FR-005**: While Claude works on a message, the panel MUST show live steps and a Stop control, reusing the live-answer display used for cards.
- **FR-006**: Users MUST be able to edit or cancel their own message while it is waiting, and quote any message.
- **FR-007**: Messages MUST support everything card comments support (mentions, readable references, images, snippets), drawn with the same chips and viewers.
- **FR-008**: Users MUST be able to reply to a message in a thread shown collapsed under it.
- **FR-009**: Users MUST be able to search a chat's whole history, including folded messages.
- **FR-010**: Users MUST be able to make a card from a message, and a card MUST be able to mention a chat message.
- **FR-011**: The system MUST show an unread count when a reply or question arrives while the panel is closed, and MAY show a browser notification when the user enabled it.
- **FR-012**: Chat history MUST persist across restarts, be included in board export/import, and be removed when its cycle is removed.
- **FR-013**: A call mentioned in a chat message MUST be kept out of storage-limit removal, as a call mentioned on a card is.
- **FR-014**: Compact MUST produce a Claude-written summary message covering everything before it; older messages MUST remain stored in full, readable under a fold, searchable and exported - never deleted or truncated.
- **FR-015**: Auto-compact MUST queue a compact after a configurable number of messages since the last summary (default 100, per chat, can be turned off); the user MUST be able to compact at any time.
- **FR-016**: A Claude conversation that takes over a cycle without the chat's session (a new terminal session, a runner on another machine) MUST be handed the latest summary and every message after it; the panel MUST mark the change of conversation. A catch-up or re-copy of the chat's own session follows FR-052.
- **FR-017**: The panel MUST be openable over any tab and follow the scope in view (a cycle when one is open, else the project). A chats bar MUST stay docked on the left of every tab, Messenger-style: the project chat and every cycle chat with its picture, whether a Claude is on it, its last message and time, "Claude is typing…" while Claude works, the waiting count and an unread count; it can be searched and narrowed to pictures only, and picking a chat opens it beside the bar. The conversation MUST offer four views: docked on the left beside the bar (resizable), expanded (wide, the page still beside it), full screen (the page hidden, Esc returns to the previous view) and a separate browser window (the chat alone, for a second screen; both windows show the same chat live, and closing the window docks the chat again). In full screen and the separate window the chat MUST carry its own project/cycle switch. The view, side and width are remembered per viewer.
- **FR-018**: Through the Cloudflare tunnel the chat MUST be read-only: history and live steps visible, every write control disabled.
- **FR-019**: Everything Claude does from the chat MUST stay within Claude's existing board limits.

**P2 - context**

- **FR-020**: Each message MUST carry what the user has open (card, selected call, spec item, statement) as a context chip the user can remove before sending.
- **FR-021**: "Ask Claude" MUST be available on calls in Live Calls and session cycles, database statements and log lines, opening the panel in place with the item attached, to the cycle chat when the item is in a cycle, else the project chat.
- **FR-022**: "/" in the composer MUST list every shipped Alfred skill except the two that run the chat; a picked skill MUST be run by the receiving Claude in its own session with the result posted in the chat.
- **FR-023**: When the user's last look at a chat is at least 30 minutes old (editable per chat) and the board changed since, the chat MUST show one digest of those changes, built without a model, folded once read; Claude MAY add its reading when on.
- **FR-024**: Users MUST be able to mark a message as a Decision (★); marking it MUST create the same DECISION record as FR-048 (written to the cycle brief's Decisions, undoable), so decisions are handed to every later Claude session for that scope.
- **FR-025**: Claude MUST be able to ask grouped questions with options in the chat, answered in one batch, as on cards.

**P3 - actions**

- **FR-026**: Claude's replies MUST be able to carry proposals (verify, close as Fine, move, checklist mark with call evidence, new acceptance item) that the user accepts or declines one by one or in bulk; an accepted proposal is applied as the user's action. Each proposal MUST be re-checked against the current board when shown and again on Accept; one that no longer applies MUST read "already done" or "outdated: <why>" and MUST NOT be acceptable.
- **FR-027**: Users MUST be able to post a reply (or a selected part) to a card as a comment, linked back to the chat.
- **FR-028**: Claude MUST be able to prepare a resend of a recorded call and an interception rule from the chat; neither MUST take effect until the user confirms in the consent dialog.
- **FR-029**: When Claude fixes code during the chat, it MUST post a fix report (changed files as code mentions, short diff) and set the card's re-test plan.

**P4 - rich**

- **FR-030**: "Watch while I test" MUST make the same Claude session check calls as they arrive and post findings as one message per batch of calls, posted once the calls settle and updated in place while the batch grows; a batch with no findings MUST post nothing. It MUST end when turned off or when the cycle stops recording. Watch messages count toward auto-compact. A /alfred-listen runner already checking the cycle keeps its job; its findings MUST also be posted into the chat marked "listen runner", and the panel MUST show that both are watching.
- **FR-031**: "Tell me when ..." watches MUST post once when their condition is met and then end; they MUST be driven by events, never periodic checks, and be listed with a remove control.
- **FR-032**: Replies MUST be able to hold live visuals run under the board's existing locked snippet rules, and the user MUST be able to pin one to the board as a widget.
- **FR-033**: Replies MUST be able to show a side-by-side difference of two calls and a comparison of two cycles.
- **FR-034**: Claude MUST be able to write a report page linked from the chat.
- **FR-035**: The project chat MUST be able to ask a cycle's Claude; the exchange MUST appear in both chats as one record.

**Enhancements from the mock review**

- **FR-036** (P1): Each of the user's messages MUST show its delivery state: sent, picked up by Claude, answered (or stopped/cancelled).
- **FR-037** (P1): A waiting message MUST show its place in line for that Claude ("2nd in line"), counting card comments ahead of it, and the chat header MUST say when Claude is busy on a card.
- **FR-038** (P1): Users MUST be able to mark a waiting message "answer first"; it goes ahead of everything waiting for that Claude, after the step Claude is on.
- **FR-039** (P1): The chats bar MUST show a "Needs you" section on top: chats with Claude's open questions, proposals or confirmations, with what waits.
- **FR-040** (P1): Returning to a chat MUST show a "N new" line where the user left off and a "Latest" button when scrolled up; an unsent draft MUST be kept per chat and shown in the bar.
- **FR-041** (P1): Ctrl+K MUST open a switcher to go to any chat by name.
- **FR-042** (P1): Each chat MUST have its own notification level: every reply, only questions and failures, or muted (no unread count, no pop-up).
- **FR-043** (P2): Each chat MUST have a "Shared" view listing everything it mentions (calls, statements, log lines, cards, items, code, pages, visuals, images), folded messages included, each linked to its message.
- **FR-044** (P2): Users MUST be able to react to a message, reusing the board's reactions; ❓ on a Claude message makes Claude explain more in a thread.
- **FR-045** (P2): Users MUST be able to ask Claude again with more context (log lines, SQL, acceptance items, free text); the first answer stays, marked "asked again".
- **FR-046** (P3): Accepting a proposal or a bulk set MUST offer Undo in a toast shown at least 6 seconds (the board's close-undo pattern); the server MUST accept the undo for 60 seconds, restoring the board and reopening the proposals.
- **FR-047** (P4): Users MUST be able to open a second chat beside the first, send to it, and swap which one is main.

**The chat and the terminal session (fork model)**

- **FR-048**: The chat's Claude MUST record, without being asked, what another session needs to continue the work correctly: a decision agreed in chat as a Decision in the cycle brief; a new bug or problem as an Inbox card; a new acceptance condition as a proposed acceptance item (accepted by the user); a code change as a fix report on its card with a re-test plan; a question left open as "Next" in the brief. Plain explanation and Q&A MUST NOT be recorded.
- **FR-049**: Each automatic record MUST appear in the chat as one line naming what was recorded and where ("✓ recorded the UTC decision in the brief") with Undo; Undo removes the record and says so in the chat.
- **FR-050**: Every chat exchange MUST be mirrored into the terminal session in full prose, so the terminal misses nothing: one item per exchange (the question and the whole answer, sent when the answer is done - never per step or draft). Bulky parts (SQL, diff tables, call bodies, visuals) MUST be sent as references the terminal can open (`chat_read <id>`, mention chips), not copied. Items MUST be marked urgent ("act on it before your next step") when a decision contradicts what the terminal is doing or did, when the chat changed files the terminal is working on, or when the user addressed it ("@terminal …"). A compact MUST send the summary as a pointer, not the text again. Nothing the terminal itself wrote (bridge questions, its own items) MUST be sent back to it. Before any item is written to the chat log, the session masking (the same rules as Alfred's MCP output: tokens, passwords, cookies, auth headers, configured secrets) MUST be applied, and call bodies and headers MUST only ever be references - the chat log never holds them in clear text.
- **FR-051**: Items MUST reach the terminal session through the runner's chat log the terminal already follows (the same channel card answers use today), with the delivery timing of FR-055(b), and also appear as "From the board chat" in board_changes, board_wait and task_context; when no terminal session is open they MUST wait and be handed to the next session that opens on the cycle. The chat MUST show each item's state (sent, read) and offer Undo while unread.
- **FR-052**: When the terminal session did significant work since the chat's copy (edited files or recorded a decision), the chat MUST catch up before answering its next message by adding only the terminal's new transcript entries since its copy (messages, tool calls, edits) - never dropping any. A full re-fork MUST happen only when the terminal compacted itself or the new part is larger than what the copy holds; it carries over only the chat messages the new copy lacks. The chat MUST show "↻ caught up with terminal session · <time>" (or "↻ re-copied … " for a full re-fork); a manual "Refresh from session" MUST stay available, and the header MUST show when the terminal has newer work.
- **FR-053**: "Continue in terminal" MUST show a ready-to-copy `claude --resume <chat session>` command so the user can carry the whole conversation (the terminal's memory plus the chat) into a terminal.
- **FR-054**: Everything the chat does automatically (records, items sent to the terminal, refreshes) MUST be visible in the chat and undoable where it changed something.

**Usage savings - automatic, nothing configured, nothing dropped**

- **FR-055**: The chat MUST save usage automatically without losing any context: (a) catch-up by delta (FR-052); (b) mirror items ride the terminal session's next turn instead of waking it (several items arrive as one block) - only urgent items wake it; the runner learns of new turns and transcript entries from file-change events on the transcript, never from a recurring check; (c) messages that wait together are answered in one run, each with its own reply; (d) when the terminal just did significant work and the chat was used within the hour, the catch-up runs at once while the prompt cache is warm; (e) every run puts its fixed rules and Alfred context first and the changing part last, so the cached prefix is reused; (f) tool results come as a summary with the full body one call away (paged, never trimmed); (g) each run is told what its session already holds so it does not fetch it again; (h) no run starts when there is nothing new (clean watch batch, empty digest, terminal change with no new entries).
- **FR-056**: The chat header MUST show a token meter: what the last message and the mirror used, and what the automatic savings avoided ("saved 84k · delta catch-up"), from the usage the runs report.

**Machines - Alfred on another host (e.g. 192.168.1.83)**

- **FR-057**: Everything that touches a Claude Code session (fork, resume, reading the session file, the chat log) MUST run on the machine of that session through its runner; Alfred MUST store only the chat's text and the fork's session id and MUST never read or receive a session transcript.
- **FR-058**: The chat MUST say which machine answers ("answered from DESKTOP-FB") and handle: the board opened from another machine (works, answers come from the runner's machine); the runner's machine off or its runner stopped (messages wait, start steps shown); a runner on a machine without the cycle's terminal session (starts its own session from Alfred's context and says the terminal's memory is on the other machine); another machine taking over (starts from Alfred's summary and recent messages, like a handover); "Continue in terminal" naming the machine that holds the fork.

- **FR-059**: The chat MUST show where its memory lives: the Claude session memory (the chat's copy of the terminal session on the runner's machine - the terminal's work up to the copy, every chat turn, what it read and why) and Alfred memory (shared and durable - chat messages and summary, decisions, records, terminal items), and how they stay in step (terminal → chat catch-up, chat → terminal mirror, chat → Alfred records, Alfred → any new session handover). Either memory alone is enough to continue: a lost or unreachable session is rebuilt from Alfred's.

**Card comments share the chat's memory**

- **FR-060**: A comment on a cycle's card that needs an answer MUST be answered by that cycle chat's Claude session (the same copy of the terminal session, same memory), and the answer posted in the card's thread with its live steps on the card as today. A comment on a card with no cycle MUST be answered by the project chat's session. The exchange MUST be mirrored to the terminal session and recorded in Alfred by the same rules as a chat exchange (FR-048…FR-051), and the chat MUST show a one-line link to it ("↳ answered your comment on #49"). Comments that need an investigation go to the chat's session too, not into the terminal. Moves, closes, flags and other plain changes stay noted without a run. Chat messages and card comments of one cycle stay in one line in arrival order (FR-003), and comments waiting together are answered in one run (FR-055c).

### Key Entities

- **Chat**: one per cycle or per project; scope, auto-compact count, last-read position.
- **Chat message**: author (user or Claude), text with mentions, time, state (waiting, answering, answered, cancelled, stopped), optional thread parent, optional context items, optional decision mark, edited flag, origin (typed, ask-from-item, slash command, digest, watch, bridge).
- **Summary**: a Claude message that covers every message before it; the fold boundary.
- **Proposal**: an action carried by a Claude reply, with its state (open, accepted, declined).
- **Chat session**: the chat's own Claude conversation - the terminal session it was forked from, when, and the terminal work it has seen; replaced on a refresh.
- **Record**: something the chat's Claude wrote to the board automatically (decision, card, proposed item, fix report, Next), linked to the message it came from, undoable.
- **Terminal item**: something sent from the chat to the terminal session - urgent or batched, its state (waiting, delivered, read, undone).
- **Watch**: a "tell me when" condition or a live "watch while I test", with its scope and end condition.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With Claude on, a sent message shows Claude's first live step within 5 seconds.
- **SC-002**: A new Claude conversation that takes over a cycle answers a question about an earlier decision correctly without the user restating it.
- **SC-003**: After compaction, 100% of original messages are found by search and present in the export.
- **SC-004**: No message is lost: every message sent while Claude is off is answered once Claude starts, in order.
- **SC-005**: Zero board changes or resends happen from the chat without the user's accept or consent click.
- **SC-006**: A tunnel viewer cannot change anything through the chat (every write is refused).
- **SC-007**: The user reaches "Ask Claude" about any call, statement or log line in one click from where it is shown.

## Assumptions

- The existing one-Claude-chat-per-cycle ownership, the project live runner and the live-answer display are reused, not replaced.
- Alfred cannot compact the Claude conversation's own memory; that conversation compacts itself, and the chat summary is what keeps continuity.
- Alfred is used by one person (plus read-only tunnel viewers); no multi-user presence or permissions beyond the existing edit rule.
- Size limits for messages match card comments.
- Phases are built in order P1-P4, each committed separately; P1 alone is a usable feature.
- Work happens on master like the recent specs; no feature branch was created (specs/021 is uncommitted in the tree).
