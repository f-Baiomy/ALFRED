# Tasks: Board Chat (specs/022)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/rest-api.md](contracts/rest-api.md), [contracts/mcp-tools.md](contracts/mcp-tools.md), [quickstart.md](quickstart.md),
[mock.html](mock.html) (the UI to match, detail for detail), [explain-session-context.html](explain-session-context.html).

**Tests**: required - the constitution (VI) and plan.md "Test strategy" ask for tests per layer; a bug fix always gets a
failing-first test.

**Review gate (user request)**: every delivery phase ends with a **Deep review & fix gate** - a full review of that phase's
diff for bugs, security, performance, architecture and mock fidelity, every finding fixed with a test, all suites green,
deployed and checked in the browser - before the next phase starts. Nothing is committed until its gate passes; each
phase is one commit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1…US8 from spec.md; setup, foundation, gates and polish carry none

## Path conventions

- Backend slice: `backend/backend-board/src/main/java/com/fathy/alfred/backend/board/` (written below as `backend/backend-board/…/board/`), tests under `backend/backend-board/src/test/java/com/fathy/alfred/backend/board/`
- Bridge: `backend/backend-app/src/main/java/com/fathy/alfred/backend/boardbridge/`
- Frontend: `frontend/src/app/`
- MCP: `mcp-server/src/`, tests `mcp-server/test/`
- Runner: `skills/alfred-live/alfred-live.mjs` (tests in `mcp-server/test/live-runner.test.ts`)

## Delivery map (spec phases → stories)

| Delivery | Stories | Requirements |
|---|---|---|
| **D1 - chat (MVP)** | US1, US2, US3, US4 | FR-001…019, 036…042, 048…060 |
| **D2 - context** | US5, US6 | FR-020…025, 043…045 |
| **D3 - actions** | US7 | FR-026…029, 046 |
| **D4 - rich** | US8 | FR-030…035, 047 |

---

## Phase 1: Setup

- [X] T001 Read docs/architecture.md, docs/frontend-architecture.md, docs/board.md and docs/mcp.md sections named in plan.md; note in specs/022-board-chat/research.md any fact that contradicts research R1-R20 before coding
- [X] T002 [P] Confirm `/board/chats/…` needs no gateway or SPA change: check the `board` prefix in gateway/nginx.conf and backend-app's SpaPageFilter (research R16); record the result in specs/022-board-chat/research.md
- [X] T003 [P] Confirm the route `/chat` (separate window) does not collide with a backend prefix in gateway/nginx.conf `$spa_page` map and frontend/src/app/app.routes.ts; record in specs/022-board-chat/research.md

---

## Phase 2: Foundational (blocks every story)

### Domain and storage

- [X] T004 [P] Create records ChatKey, ChatMessage (author USER/CLAUDE/ALFRED, kind TEXT/SUMMARY/DIGEST/SYSTEM/TASK, state WAITING/TAKEN/ANSWERED/STOPPED/CANCELLED/DONE, urgent, decision, origin, context, quote, extra JSON, reactions, coversTo, replyTo, bridgeFrom, superseded, times) with compact-constructor validation (text ≤ 64 KB) in backend/backend-board/…/board/domain/model/ChatMessage.java and ChatKey.java
- [X] T005 [P] Create records ChatSettings, ChatSession, ChatRecord, TerminalItem, ChatWatch, ChatSummary (bar row incl. needsYou, typing, terminal block) in backend/backend-board/…/board/domain/model/ (one file each)
- [X] T006 Create port ChatStorePort (append, page by `before`, search LIKE ≤ 200, summaries, settings, sessions, records, terminal items, watches, deleteCycle) in backend/backend-board/…/board/application/port/out/ChatStorePort.java
- [X] T007 Implement SqliteChatRepository with the six tables and indexes from data-model.md (`CREATE TABLE IF NOT EXISTS`, `(project, cycle_id, id)` index, partial WAITING index) in backend/backend-board/…/board/adapter/out/sqlite/SqliteChatRepository.java
- [X] T008 [P] Test SqliteChatRepository with @TempDir: paging, search limit, summaries never selecting folded bodies, settings defaults, cycle deletion in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/adapter/out/sqlite/SqliteChatRepositoryTest.java
- [X] T009 Delete a cycle's chat rows (messages, records, terminal items, watches, sessions, settings) in the existing cycleRemoved path of backend/backend-board/…/board/adapter/out/sqlite/SqliteBoardRepository.java, calling the chat repository; a card made from a removed message keeps its card and its `@[chat:…]` chip renders "message removed" (edge case) - tested in SqliteChatRepositoryTest

### Shared board changes

- [X] T010 Add `MentionOwner.CHAT` and `MentionType.CHAT`; index chat text mentions with owner CHAT in backend/backend-board/…/board/domain/model/MentionOwner.java, MentionType.java and the mention indexing in SqliteBoardRepository.java
- [X] T011 Make imported links and text indexing skip unknown mention types instead of throwing (ImportBoardService ~line 469, SqliteBoardRepository `MentionType.valueOf` readers) with a failing-first test in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ImportBoardServiceTest.java (research R14)
- [X] T012 Add `chats` and `fromChat` lists to backend/backend-board/…/board/domain/model/BoardChanges.java and fill them in the changes service used by `GET /board/changes` and `/board/changes/wait` (BoardInsightsService) - wake on the same BoardChangeFeed signal
- [X] T013 Add nullable `chatMessageId` to LiveWork and LiveWorkUseCase.Report, and `terminalAt` to chatBeat (written through to `chat_sessions.terminal_at`, the single source), in backend/backend-board/…/board/domain/model/LiveWork.java, application/port/in/LiveWorkUseCase.java, application/service/LiveWorkService.java
- [X] T014 Add the `chat-changed` socket event (project, scope, id; throttled like other board events) to BoardNotificationPort and the websocket adapter in backend/backend-board/…/board/application/port/out/BoardNotificationPort.java and adapter/out/websocket/
- [X] T015 Keep calls mentioned in chat out of storage limits: verify ListMentionedCallIdsUseCase reads all owners; extend backend/backend-app/src/test/java/com/fathy/alfred/backend/storage/CommentedCallsKeptTest.java with a chat-mentioned call (FR-013) - done as SqliteChatRepositoryTest `aLiveCallMentionedInAChat…`: CommentedCallsKeptTest mocks the board, the real `mentionedLiveCallIds` query is what needed proving

### Frontend and MCP foundations

- [X] T016 [P] Create frontend/src/app/core/models/chat.models.ts (ChatMessage, ChatSummary, ChatRecord, TerminalItem, ChatSettings, ChatSession, view types) mirroring the REST contract
- [X] T017 [P] Create frontend/src/app/core/services/chat-api.service.ts for every route in contracts/rest-api.md (pattern of core/services/board-api.service.ts)
- [X] T018 Create frontend/src/app/core/state/chat-state.service.ts (signals: summaries, open chat, pages, live work by chatMessageId; refetch on `chat-changed` from the existing board socket - no timers)
- [X] T019 [P] Create mcp-server/src/tools/chat.ts registering chat_take, chat_reply, chat_read, chat_summary, chat_watch (contracts/mcp-tools.md) with ReadableWriter conversion on every write; register it beside tools/board.ts
- [X] T020 [P] Extend mcp-server/test/fake-alfred.ts with the /board/chats routes and write mcp-server/test/chat.test.ts (take refused when another chat holds the cycle, reply with records/toTerminal/updateId, chat_read part)

**Checkpoint**: storage, signals, models and tools exist; nothing visible yet.

---

## Phase 3: User Story 1 - Talk to the cycle's Claude (P1) 🎯 MVP

**Goal**: a message in the cycle chat is answered by the cycle chat's own Claude session (fork of the terminal session), with live steps, ticks, the line, urgent, waiting/start steps.
**Independent test**: with `/alfred-live "<cycle>"` running, send from the panel → "✓✓ Claude has it", live steps, answer that refers to the terminal's earlier work; with no runner → "✓ sent · waiting for Claude" + start steps, answered when it starts.

### Tests

- [X] T021 [P] [US1] ChatServiceTest: post → WAITING; take by holder → TAKEN, by another chat → refused; reply → ANSWERED with replyTo; edit/cancel only while WAITING and only by the user; urgent sorts first; queue position counts a busy card run in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatServiceTest.java
- [X] T022 [P] [US1] ChatControllerTest (@WebMvcTest): limit clamped 1..100, 64 KB text refused, Claude header without take refused, tunnel write refused through BoardEditAccessInterceptor in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/adapter/in/web/ChatControllerTest.java
- [X] T023 [P] [US1] Runner tests: fork argv (`--resume <terminal> --fork-session`), continue argv (`--resume <fork>`), session id read from the stream-json init event, chats handled in time order with card entries and urgent first, waiting messages taken in one run in mcp-server/test/live-runner.test.ts
- [X] T024 [P] [US1] Pure tests for queue position, ticks text, unread and needs-you in frontend/src/app/shared/utils/chat-queue.spec.ts

### Implementation

- [X] T025 [US1] Create use cases PostChatMessageUseCase, EditChatMessageUseCase, TakeChatMessageUseCase, ReplyInChatUseCase, ReadChatUseCase, ChatSessionUseCase in backend/backend-board/…/board/application/port/in/
- [X] T026 [US1] Implement ChatService (states, urgent, take ownership via LiveWorkUseCase.cycleChat, reply, notify BoardChangeFeed + chat-changed, mention indexing) in backend/backend-board/…/board/application/service/ChatService.java
- [X] T027 [US1] Implement ChatController routes for read, post, edit, cancel, urgent, take, reply, session in backend/backend-board/…/board/adapter/in/web/ChatController.java with @Valid DTOs in adapter/in/web/dto/
- [X] T028 [US1] Runner: read `chats` from changes/wait, take, keep one session per chat; prompt order rules → Alfred context → summary → delta → message so the cached prefix is reused (FR-055e); start no run when nothing is new (FR-055h); (fork once / continue; project chat and no-terminal cycles start from Alfred's context), store ids via PUT session, report live steps with chatMessageId, answer waiting messages together in one run in skills/alfred-live/alfred-live.mjs
- [X] T029 [US1] Runner machine handling: fork only when the terminal transcript exists on this machine, else own session + note; host reported in chatBeat (FR-057, FR-058) in skills/alfred-live/alfred-live.mjs
- [X] T030 [P] [US1] Pure helpers queue position / ticks / nth in frontend/src/app/shared/utils/chat-queue.ts
- [X] T031 [US1] Chat panel shell (head with scope, runner line "Claude chat on this cycle · host", waiting count, counter n/100, icons; banners: start steps with Copy, tunnel view-only) in frontend/src/app/components/chat/chat-panel/chat-panel.component.ts reusing live-strip / board styles
- [X] T032 [US1] Chat message component (who line, ticks, "Nth in line", ⚡ answer first, Edit/Cancel while waiting, markdown-view body, app-live-work-box while answering, Stop) in frontend/src/app/components/chat/chat-message/chat-message.component.ts
- [X] T033 [US1] Wire the panel into the app shell: dock left of the page on every tab in frontend/src/app/app.component.ts; styles in frontend/src/styles.scss (tokens only, Slate theme, classes as in mock.html)
- [X] T034 [US1] Header memory line + token meter (FR-056, FR-059): two pills (Claude session / Alfred), ↻ 📤 ⇱ icons, memory dialog, one-line meter from reply `usage` in frontend/src/app/components/chat/chat-panel/chat-memory.component.ts
- [X] T035 [US1] "Continue in terminal" dialog naming the host and `claude --resume <chat session>` in frontend/src/app/components/chat/chat-panel/chat-panel.component.ts

**Checkpoint**: US1 works end to end on a throwaway cycle.

---

## Phase 4: User Story 2 - Talk to the project's Claude (P1)

**Goal**: the project chat is answered by the project live runner's session; it waits for that runner only.
**Independent test**: project runner on → answer covering several cycles; off with a cycle chat alive → waits + project start steps.

- [X] T036 [P] [US2] ChatServiceTest cases: project chat take requires the project live runner; a cycle chat never takes a project message in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatServiceTest.java
- [X] T037 [US2] Project scope in ChatService take rules and in the runner's project-chat session in backend/backend-board/…/board/application/service/ChatService.java and skills/alfred-live/alfred-live.mjs
- [X] T038 [US2] Panel follows the scope in view (cycle open → cycle chat, else project) and shows the project start steps in frontend/src/app/components/chat/chat-panel/chat-panel.component.ts

---

## Phase 5: User Story 3 - Keep the conversation across sessions (P1)

**Goal**: compact (manual + auto at 100), handover, catch-up by delta, two memories, records, mirroring, card comments on the chat's session.
**Independent test**: chat, close the terminal, open a new one → "what did we decide?" answered; terminal edits a file → next message shows "↻ caught up … (+N new entries)"; every exchange appears as one 💬 line in the terminal's chat log.

### Tests

- [X] T039 [P] [US3] CompactChatServiceTest: auto task at autoN, 0 = off, summary coversTo, nothing deleted, never folds an in-flight message, compact with no Claude on stays "compact waiting", compact pointer queued for the terminal in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/CompactChatServiceTest.java
- [X] T040 [P] [US3] ChatRecordServiceTest: DECISION/CARD/ITEM/FIX/NEXT applied as Claude within its limits, undo restores, "✓ recorded …" lines in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatRecordServiceTest.java
- [X] T041 [P] [US3] ChatTerminalServiceTest: one mirror item per exchange, urgent kinds, held while no terminal, no echo of the terminal's own items, undo only while unread, and **masking**: an answer quoting a bearer token, a cookie and a password field is stored and mirrored masked, a call body appears only as a reference (failing first - Principle I) in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatTerminalServiceTest.java
- [X] T042 [P] [US3] Runner tests: transcript changes noticed through `fs.watch` events only (assert no setInterval/setTimeout loop in the chat path), significant-work detection and delta extraction from a sample transcript, masking applied before a chat-log line is written, re-fork only after a terminal compact or an oversized delta, carry-over of only the messages the copy lacks, mirror written at the terminal's next turn (⚡ at once), coalescing, "already in your session" note, card comment answered with the cycle chat session in mcp-server/test/live-runner.test.ts

### Implementation

- [X] T043 [US3] CompactChatUseCase + service (auto count, TASK message, SUMMARY with coversTo) in backend/backend-board/…/board/application/port/in/CompactChatUseCase.java and application/service/ChatService.java
- [X] T044 [US3] ChatRecordService applying records through BoardService / CycleBriefService / RetestService / RequirementService as Claude, storing undo data, plus undo route in backend/backend-board/…/board/application/service/ChatRecordService.java and ChatController.java
- [X] T045 [US3] ChatTerminalService (mirror item per exchange built by Alfred and passed through the existing session masking before storage, urgent items from the reply, held/sent/delivered/read/undone, compact pointer) and `/terminal` routes in backend/backend-board/…/board/application/service/ChatTerminalService.java
- [X] T046 [US3] Handover context route (`GET /board/chats/{scope}/context`) and task_context additions (summary, later messages, decisions, unread/held items) in ChatController.java and mcp-server/src/tools/board.ts (task_context)
- [X] T047 [US3] Runner: `fs.watch` on the terminal transcript (event-driven, re-armed on rotation) as the only trigger for turns and new entries; masking before every chat-log write; "already in your session" note (FR-055g); delta catch-up before answering, warm-cache catch-up after a significant terminal turn, `terminalAt` in chatBeat, mirror lines (💬 per exchange, ⚡ act-on) written to the chat log at the terminal's next turn, delivered/read reports in skills/alfred-live/alfred-live.mjs
- [X] T048 [US3] Summary-first tool results for chat runs (FR-055f): the tools a chat run uses return summaries with the full body one call away through the existing paging - never trimmed; test in mcp-server/test/chat.test.ts, change in mcp-server/src/tools/chat.ts prompt guidance and the runner's tool allow-list in skills/alfred-live/alfred-live.mjs
- [X] T049 [US3] Card comments on a cycle's cards answered with the cycle chat session (project cards: project chat session), posted with board_reply, live box on the card, "↳ answered your comment on #N" system line; plain changes stay noted (FR-060, R20) in skills/alfred-live/alfred-live.mjs and ChatService.java (system line)
- [X] T050 [US3] Skill text: what to record and what not, urgent rules, ⚡/💬 line kinds in skills/_shared/rules.md and skills/alfred-live/SKILL.md; keep tests/python/test_alfred_skill.py green
- [X] T051 [US3] Panel: summary fold (open/close, "nothing deleted"), ⇊ compact, settings popover (auto-compact count/off, digest gap, notifications), record lines with Undo, mirrored lines with state, 📤 dialog with the terminal preview, "↻ caught up / re-copied" system lines in frontend/src/app/components/chat/chat-message/ and chat-panel/
- [X] T052 [US3] Board export/import `chats` section (messages, settings, records, terminal items; no sessions) with a round-trip test, an older-export fixture without `chats`, and an import whose cycle does not exist landing under the project chat marked with the missing cycle's name (edge case) in backend/backend-board/…/board/application/service/ImportBoardService.java and its test

---

## Phase 6: User Story 4 - Compose like a card comment (P1)

**Goal**: composer, threads, search, make card, chat mention, chats bar, views, unread, drafts, mute, Ctrl+K.
**Independent test**: mention + image message, thread reply, make card linking back, chat mention opening the message; bar shows unread/typing/needs-you; views dock/expand/full/window.

- [X] T053 [P] [US4] Pure tests for unread line, drafts, needs-you, shared extraction in frontend/src/app/shared/utils/chat-bar.spec.ts
- [X] T054 [P] [US4] Component test for the narrow layout found in the mock review: no chip under Accept/Decline, Send inside the panel, hover bar inside the message, at 466 px in frontend/src/app/components/chat/chat-panel/chat-panel.component.spec.ts (failing first)
- [X] T055 [US4] Composer = existing mention-editor + mention-picker + images + snippets + quote + "looking at" placeholder hook in frontend/src/app/components/chat/chat-composer/chat-composer.component.ts
- [X] T056 [US4] Threads (reply box, "N replies", Claude answers in thread) and hover actions (Reply, Quote, ＋ Card, ★, → Card comment placeholder for D3, 👍 ❓ ↻ placeholders for D2, 🔗) in frontend/src/app/components/chat/chat-message/chat-message.component.ts
- [X] T057 [US4] Search (input, filters, folded matches) via `/search` in chat-panel.component.ts and ChatStorePort search
- [X] T058 [US4] Make card from a message (add-card form prefilled, link back) and `@[chat:…]` chips opening the chat at the message with flash, reusing mention-chip and BoardMentionsService.open in frontend/src/app/components/board/mention-chip/ and core/services/board-mentions.service.ts
- [X] T059 [US4] Chats bar (Messenger-style): sections Needs you / Project / Cycles, avatars with Claude-on dot, preview, time, typing, waiting, unread count, drafts, mute icon, search, narrow mode, tooltips in frontend/src/app/components/chat/chat-bar/chat-bar.component.ts
- [X] T060 [US4] Views: ▥ ▾ menu (dock left resizable, expanded, full screen with Esc/Ctrl+Shift+F, separate window), route `/chat` window page, per-viewer view/width/narrow in localStorage (try/catch) in frontend/src/app/pages/chat-window/chat-window.component.ts and app.routes.ts
- [X] T061 [US4] Unread line "— N new —", ↓ Latest, drafts per chat, mute levels, Ctrl+K quick switcher, unread badge on Board tab, optional browser notification in chat-state.service.ts, chat-bar and chat-panel components

---

## Phase 7: 🔍 D1 Deep review & fix gate (before D2)

- [X] T062 Review the whole D1 diff against spec FR-001…019, 036…042, 048…060 and mock.html detail by detail; list every gap in specs/022-board-chat/review-d1.md
- [X] T063 Hunt bugs: state races (two takes, edit during take, runner gone mid-answer → back to WAITING), ordering with card comments, urgent, auto-compact during an answer (never folds in-flight), undo of records, mirror echo, delta vs re-fork, handover, cycle removal, import/export; record each in specs/022-board-chat/review-d1.md
- [X] T064 Security/performance pass: input clamps, 64 KB cap, tunnel read-only on every write route, no transcript ever sent to Alfred, no bodies in bar/list SQL, no timers/polling in the frontend (grep `setInterval|interval(|timer(`), Monitor events ≤ 1 per exchange; findings into specs/022-board-chat/review-d1.md
- [X] T065 Fix every finding with a failing-first test in the matching test file; re-run until review-d1.md has no open item
- [X] T066 Run all suites: backend (Docker JDK 21: `mvn -B -pl backend-board,backend-app,backend-architecture-test -am test`), `npx ng test --watch=false --browsers=ChromeHeadless`, `npx ng build`, `npx tsx --test test/*.test.ts` in mcp-server, `pytest tests/python/test_alfred_skill.py`
- [X] T067 Measure SC-001 on the deployed build (send → first live step ≤ 5 s, 10 tries, record in review-d1.md); then deploy (`docker compose up -d --build backend frontend && docker compose restart app-gateway`, `python alfred_skill.py install`) and browser-check quickstart.md P1 steps on a throwaway project/cycle (never the user's cards); screenshots of bar, panel views, records, mirror, memory dialog, meter; delete the throwaway data
- [X] T068 Update docs: docs/board.md "Chat", docs/mcp.md chat tools + mirroring, CLAUDE.md one bullet; then commit D1

---

## Phase 8: User Story 5 - Ask about what I am looking at (P2)

**Goal**: "looking at" chip and Ask Claude from calls, statements, log lines.
**Independent test**: right-click a call in a recording cycle → cycle chat opens with the call chip; not in a cycle → project chat.

- [X] T069 [P] [US5] Pure test for routing (in a cycle → cycle chat, else project) and context-chip building in frontend/src/app/shared/utils/chat-context.spec.ts
- [X] T070 [US5] chat-context util (from open card drawer, selected call, spec item, DB statement) in frontend/src/app/shared/utils/chat-context.ts and the composer's removable chips
- [X] T071 [US5] "Ask Claude" on Live Calls rows, session-cycle calls, DB window statements and log lines (row menus + hover button) opening the panel in place in the existing row/menu components under frontend/src/app/components/ and pages/

## Phase 9: User Story 6 - Commands, digest, decisions, questions, shared, reactions, ask again (P2)

**Goal**: FR-022…025, 043…045.
**Independent test**: "/" lists 13 skills; returning after ≥ 30 min shows a digest; ★ decision reaches a new session; questions answered in one batch; 🗂 Shared lists mentions; ❓ explains in a thread; ↻ asks again.

- [X] T072 [P] [US6] ChatDigestServiceTest (no model, ≥ gap, nothing → 204) and decision hand-over test in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatDigestServiceTest.java
- [X] T073 [US6] ChatDigestService + `/digest` route built from BoardChanges, verdict changes and failed calls via the existing ports in backend/backend-board/…/board/application/service/ChatDigestService.java
- [X] T074 [US6] Slash picker listing shipped skills except alfred-live/alfred-listen (list shared with alfred_skill.py's install set) and runner handling `skill:` origin in frontend/src/app/components/chat/chat-composer/ and skills/alfred-live/alfred-live.mjs
- [X] T075 [US6] Decisions (★ creates the same DECISION record as FR-048 via ChatRecordService - brief + undo - and sets the message flag as its link), questions blocks via the existing quick-answer, reactions route + ❓ explain-more task, ↻ ask again dialog + route, 🗂 Shared view via `/shared` in ChatController.java, ChatService.java and chat-message/chat-panel components

## Phase 10: 🔍 D2 Deep review & fix gate (before D3)

- [X] T076 Review D2 against FR-020…025, 043…045 and the mock; bug hunt (digest double-show, routing of Ask Claude, slash list drift, reactions toggling, ask-again supersede); write specs/022-board-chat/review-d2.md
- [X] T077 Fix every finding with a failing-first test; all suites green (T066 commands); deploy and browser-check; update docs; commit D2

---

## Phase 11: User Story 7 - Act from the chat, with my approval (P3)

**Goal**: proposals + bulk with re-check and undo, reply → card comment, resend/rule via consent, fix report + re-test.
**Independent test**: accept 2 of 5 bulk proposals → only 2 applied; a stale one reads "outdated"; Undo within 60 s restores; resend sends nothing until consent.

- [X] T078 [P] [US7] ChatProposalServiceTest: re-check at accept, stale → outdated never applied, bulk partial, undo accepted within 60 s and refused after (toast ≥ 6 s in the UI) in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatProposalServiceTest.java
- [X] T079 [US7] ChatProposalUseCase + ChatProposalService + `/proposals` and `/undo/{token}` routes in backend/backend-board/…/board/application/service/ChatProposalService.java and ChatController.java
- [X] T080 [US7] Proposal rows (Accept/Decline, bulk ticks, Accept all, outdated state, Undo toast reusing undo-toast) in frontend/src/app/components/chat/chat-message/chat-proposals.component.ts
- [X] T081 [US7] Resend and interception rule payloads shown through BoardActionsService's consent dialog; on confirm call the existing /resend and /interception endpoints from the frontend in frontend/src/app/components/chat/chat-message/chat-consent.component.ts
- [X] T082 [US7] Post a reply (or part) to a card as a Did/Found/Next comment with a back-link; fix report block + re-test plan through the FIX record in chat-message component and ChatRecordService.java

## Phase 12: 🔍 D3 Deep review & fix gate (before D4)

- [X] T083 Review D3 against FR-026…029, 046; bug hunt (double accept, accept during card move, undo after window, consent bypass, tunnel accepts); write specs/022-board-chat/review-d3.md
- [X] T084 Fix every finding with a failing-first test; suites green; deploy and browser-check; docs; commit D3

---

## Phase 13: User Story 8 - Watch, notify, show (P4)

**Goal**: watch while I test, tell-me-when, visuals + pin, diff, compare, report, bridge, split view.
**Independent test**: watch on → one message per settled batch; "tell me when AC8 passes" fires once; project chat `@cycle` question shows in both chats; ◫ opens a second chat.

- [X] T085 [P] [US8] ChatWatchServiceTest (item passes, 5xx, fires once, ends on cycle stop) in backend/backend-board/src/test/java/com/fathy/alfred/backend/board/application/service/ChatWatchServiceTest.java
- [X] T086 [US8] ChatWatchService + routes; RequirementService publishes verdict changes in-slice; backend/backend-app/src/main/java/com/fathy/alfred/backend/boardbridge/BoardRetestWatchAdapter.java also calls ChatWatchUseCase.callCompleted
- [X] T087 [US8] Runner watch mode in the chat session (batches via chat_reply updateId, listen-runner findings marked) in skills/alfred-live/alfred-live.mjs; watch chips and ◉ toggle in the panel
- [X] T088 [US8] Visual (locked snippet runner, 📌 pin via board_widget_put), call diff and cycle compare blocks, report page link in chat-message component
- [X] T089 [US8] Project ↔ cycle bridge (bridge_from, one record in both chats) in ChatService.java + SqliteChatRepository.java and the `@cycle` composer hint
- [X] T090 [US8] ◫ split view (second chat column, its own send box, ⇆ make main) in frontend/src/app/components/chat/chat-panel/chat-split.component.ts

## Phase 14: 🔍 D4 Deep review & fix gate

- [X] T091 Review D4 against FR-030…035, 047; bug hunt (watch after cycle stop, duplicate fire, bridge echo, split sending to the wrong chat, snippet sandbox intact - snippet-security.spec.ts green); write specs/022-board-chat/review-d4.md
- [X] T092 Fix every finding with a failing-first test; suites green; deploy and browser-check; docs; commit D4

---

## Phase 15: Polish & cross-cutting

- [X] T093 [P] Final whole-feature review across D1-D4 with fresh eyes (one pass per constitution principle, in order: security, performance, architecture, style, cleanliness, tests); write specs/022-board-chat/review-final.md and fix findings
- [X] T094 [P] Measure and record in docs/board.md: SC-001 first live step, chat page latency at 5,000 messages, Monitor events per exchange, tokens per exchange with and without the savings (meter numbers)
- [X] T095 Walk the mock's "Spec coverage" list FR-001…060 against the live build; any gap → task + fix before closing the feature

---

## Dependencies & execution order

- Setup (T001-T003) → Foundational (T004-T020) → D1 stories US1 → US2 → US3 → US4 (US2-US4 depend on US1's service/controller/panel) → **D1 gate (T062-T068)** → D2 (US5, US6 independent of each other) → **D2 gate** → D3 (US7) → **D3 gate** → D4 (US8) → **D4 gate** → Polish.
- No delivery phase starts before the previous gate is fully closed (review file has no open item, suites green, deployed, checked, committed).
- Within a story: tests first (failing) → domain/ports → services → web → runner/MCP → UI.

## Parallel opportunities

- Foundational: T004, T005, T016, T017, T019, T020 together; T008 after T007.
- US1: T021, T022, T023, T024 together; T030 alongside backend work.
- US3: T039-T042 together.
- US5 and US6 can be built side by side.
- Per the project's token budget (CLAUDE.md), work runs in the main session; at most one subagent for a large, fully specified chunk, never a fan-out.

## Implementation strategy

- **MVP = D1 (US1-US4)**: the chat itself with its memory model - usable alone.
- Then D2, D3, D4, each behind its own review & fix gate and its own commit.
- Every phase: build → tests → deep review → fixes with tests → green → deploy → browser check on throwaway data → docs → commit.
