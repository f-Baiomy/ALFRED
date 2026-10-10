---
description: "Task list for 014-task-board"
---

# Tasks: Task Board

**Input**: Design documents from `specs/014-task-board/` - [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), mocks [mock.html](mock.html) / [mock-v2.html](mock-v2.html)

**Tests**: included - the constitution (VI. Verified Changes) requires tests per layer; the plan's Constitution Check names them.

**Organization**: grouped by user story (US1-US9 from spec.md) so each can be built and checked on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1-US9

## Path conventions

- `{B}` = `backend/backend-board/src/main/java/com/fathy/alfred/backend/board`
- `{BT}` = `backend/backend-board/src/test/java/com/fathy/alfred/backend/board`
- `{APP}` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `{APPT}` = `backend/backend-app/src/test/java/com/fathy/alfred/backend`
- `{FE}` = `frontend/src/app`
- `{MCP}` = `mcp-server/src`
- Backend tests run in Docker JDK 21 (CLAUDE.md "Single tests"); bare `mvn` may be JDK 8.
- Do not read whole large files (`styles.scss`, `proxy/interception.py`); use `codegraph explore` / Grep.

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: the new module exists, is wired into the build, routing and storage listings, and the shared parser vectors exist.

- [X] T001 Create module `backend/backend-board/pom.xml` copying `backend/backend-triage/pom.xml` dependencies (web, websocket, jdbc, sqlite-jdbc, test), artifactId `backend-board`; add `<module>backend-board</module>` to `backend/pom.xml`
- [X] T002 Add `backend-board` dependency to `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`
- [X] T003 [P] Add test-only `{BT}/TestApplication.java` (`@SpringBootApplication`, as `backend/backend-triage/src/test/java/com/fathy/alfred/backend/triage/TestApplication.java`)
- [X] T004 [P] Add isolation rule `boardSliceMustNotDependOnOtherSlices` to `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java` (pattern of `triageSliceMustNotDependOnOtherSlices`), and add `"..backend.board.."` to the slice list near line 271
- [X] T005 [P] Add `BOARD_DB_FILE=/appdata/board.db` to `docker-compose.yml` (backend env, next to `TRIAGE_DB_FILE`), `"BOARD_DB_FILE": "board.db"` to the db map in `packaging/launcher/supervisor.py` line ~80, `"BOARD_DB_FILE"` to the env list in `{APPT}/BackendContextStartsTest.java`, and `@Value("${BOARD_DB_FILE:/appdata/board.db}")` board entry in `{APP}/storage/StorageFiles.java` so Settings → Storage lists it
- [X] T006 [P] Add `board` to the API prefix regex and `"~^/board/?\|.*text/html" 1;` to the `$spa_page` map in `gateway/nginx.conf`; add the same prefix and SPA page to `{APP}/web/SpaPageFilter.java`; run `SpaPageFilterTest`
- [X] T007 [P] Create parser vectors `specs/014-task-board/vectors/mentions.json` (every type in contracts/mention-syntax.md, escapes, malformed, lone `@`, mention at start/end), `vectors/quick-add.json` (prefixes `bug!`/`task!`/`note!`/`?`, `#urgent #risk #blocker #impact #decision`, no prefix → TASK, unknown `#tag` stays in title), `vectors/acceptance-items.json` (numbered and bulleted lists under "Acceptance"/"## Acceptance criteria", none, nested, whitespace-only changes keep the key)

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: card domain, store, change signal, actor and access handling, frontend plumbing. No story can start before this.

- [X] T008 [P] Create enums in `{B}/domain/model/`: `CardKind`, `CardStatus`, `Resolution`, `Flag`, `Scope`, `Actor`, `MentionType`, `ActivityKind`, `Mark` (values per data-model.md)
- [X] T009 [P] Create records in `{B}/domain/model/`: `Card`, `CardSummary`, `CardDetail`, `ActivityEntry`, `MentionRef`, `MentionChip`, `CardQuery` (with clamping factory: limit 1-500, offset ≥ 0), `CardChange` (outcome enum OK / NOT_FOUND / REFUSED_FOR_CLAUDE / ILLEGAL_TRANSITION / DUPLICATE_OF_CLOSED + card)
- [X] T010 Create `{B}/domain/Transitions.java`: allowed open-status moves, CLOSED requires resolution, Reopen → INBOX clears resolution/reason, NOT_IN_FLOW sets OUT_OF_SCOPE (data-model.md "State transitions")
- [X] T011 [P] Test `{BT}/domain/TransitionsTest.java` for every allowed and refused transition
- [X] T012 Create `{B}/application/port/out/BoardStorePort.java` (cards CRUD, next number per project, summary query, activity append/page, mentions replace/query, briefs, spec files, checklist marks) and `{B}/application/port/out/BoardNotificationPort.java` (`changed(project, cycleId, cardId, what)`, `agentStatus(AgentStatus)`)
- [X] T013 Create `{B}/adapter/out/sqlite/SqliteBoardRepository.java`: `@ConditionalOnProperty(prefix="alfred.storage.board", name="type", havingValue="sqlite", matchIfMissing=true)`, `@Value("${BOARD_DB_FILE:/appdata/board.db}")`, `@PostConstruct` schema from data-model.md, WAL, `foreign_keys=ON`, writability check with loud WARN/ERROR; summary query never selects `description`, always `LIMIT`
- [X] T014 Test `{BT}/adapter/out/sqlite/SqliteBoardRepositoryTest.java` with `@TempDir`: schema creation, numbering unique per project and never reused after delete, activity AND mentions cascade on card delete (a deleted card's calls leave `ListMentionedCallIdsUseCase`), summary query column list excludes description, mentions replace per owner
- [X] T015 [P] Create WebSocket adapter `{B}/adapter/out/websocket/BoardWebSocketConfig.java`, `BoardEventsWebSocketHandler.java`, `WebSocketBoardNotificationAdapter.java` on `/ws/board`, message shapes per contracts/websocket.md (copy the triage websocket trio's structure)
- [X] T016 Create `{B}/adapter/in/web/ActorResolver.java` reading `X-Alfred-Actor` (`claude` → CLAUDE, else USER) and `{B}/adapter/in/web/BoardExceptionHandler.java` (400 validation, 404, 409 with `{error, message}`)
- [X] T017 Create `{APP}/boardbridge/BoardEditAccessInterceptor.java` + `{APP}/boardbridge/BoardWebConfig.java`: non-GET `/board/**` asks `EditAccessUseCase.access(peer, headerNames)`; allow when allowed or reason `DOCKER_MODE`; else 403 (research R10)
- [X] T018 [P] Test `{APPT}/boardbridge/BoardEditAccessInterceptorTest.java`: GET always passes, local write passes, Docker mode passes, tunnel write refused
- [X] T019 [P] Create `{FE}/core/models/board.models.ts` (types per contracts/rest-api.md "Shapes" and data-model.md enums)
- [X] T020 [P] Create `{FE}/core/services/board-api.service.ts` (HTTP for every endpoint in contracts/rest-api.md, `AppConfigService.backendUrl`)
- [X] T021 [P] Create `{FE}/core/services/board-socket.service.ts` on `/ws/board` via `reconnectingSocket` (as `{FE}/core/services/server-socket.service.ts`)
- [X] T022 Create `{FE}/core/state/board-state.service.ts`: signals for project, cycleId, filters, view (board/list), cards, selection, keyboard index; re-fetch on socket `board-changed` for the shown project/cycle and on reconnect; no timers
- [X] T023 Add route `{ path: 'board', loadComponent: ... BoardPageComponent }` to `{FE}/app.routes.ts` and a "Board" tab to `{FE}/layout/main-layout/main-layout.component.html`

**Checkpoint**: module builds, ArchUnit passes, `/board` page loads (empty), `/ws/board` connects.

---

## Phase 3: User Story 1 - Track work on a board (P1) 🎯 MVP

**Goal**: cards per project and per cycle in status columns, quick add, flags, drag/menu/keyboard moves, filters, list view, progress, stale marker, delete.

**Independent Test**: spec US1 - create cards of each kind, flag them, move through every column, switch Project/Cycle board, reload, second tab updates live.

### Tests for US1

- [X] T024 [P] [US1] `{BT}/domain/ParserVectorsTest.java` (quick-add part; one class runs all three vector files) running `specs/014-task-board/vectors/quick-add.json`
- [X] T025 [P] [US1] `{BT}/application/service/BoardServiceCardsTest.java` with fake ports: create (number assigned, CREATED activity), update fields (PATCH carries only changed fields; two updates of different fields both apply, the later update of the same field wins; one activity entry per changed field), move (STATUS activity, illegal → ILLEGAL_TRANSITION), delete, query passes clamped limits, notification sent per change
- [X] T026 [P] [US1] `{BT}/adapter/in/web/BoardControllerTest.java` (`@WebMvcTest`): validation (title 1-300, description ≤ 256 KB, enums), limit clamping, 404, 409 body
- [X] T027 [P] [US1] `{FE}/shared/utils/quick-add-parser.spec.ts` running the same `vectors/quick-add.json`

### Implementation for US1

- [X] T028 [US1] Create `{B}/domain/QuickAddParser.java` per vectors
- [X] T029 [US1] Create use cases in `{B}/application/port/in/`: `CreateCardUseCase`, `QuickAddCardUseCase`, `UpdateCardUseCase`, `MoveCardUseCase`, `DeleteCardUseCase`, `QueryCardsUseCase`, `GetCardUseCase`
- [X] T030 [US1] Create `{B}/application/service/BoardService.java` implementing T029 (constructor injection; every change appends activity and calls `BoardNotificationPort`); counts for progress (open = INBOX..IN_PROGRESS, fixed = FIXED/VERIFIED, done = DONE/CLOSED)
- [X] T031 [US1] Create `{B}/adapter/in/web/BoardController.java` + `dto/CreateCardRequestDto`, `QuickAddRequestDto`, `UpdateCardRequestDto`, `MoveCardRequestDto` (`@Valid`) for `GET/POST /board/cards`, `POST /board/cards/quick`, `GET/PATCH/DELETE /board/cards/{id}`, `POST /board/cards/{id}/move`
- [X] T032 [P] [US1] Create `{FE}/shared/utils/quick-add-parser.ts` (same rules as Java; used for the live preview under the quick-add bar)
- [X] T033 [US1] Create `{FE}/pages/board/board-page.component.{ts,html}`: project select (projects from the existing projects endpoint, plus "No project"), Project/Cycle board switch with cycle select, quick add, filters, Board/List toggle, Export button placeholder (wired in US8)
- [X] T034 [P] [US1] Create `{FE}/components/board/board-card/board-card.component.ts` (kind, flags, title, first 3 mention chips as plain labels until US3, number, author badge, cycle chip on Project board, comment count, scope chip, age with stale ⏳ when > 5 days open)
- [X] T035 [US1] Create `{FE}/components/board/board-columns/board-columns.component.ts` with `@angular/cdk/drag-drop` `cdkDropListGroup`; drop calls move; empty-column states ("Inbox clear ✓", "Drop cards here")
- [X] T036 [P] [US1] Create `{FE}/components/board/quick-add/quick-add.component.ts` (Enter submits, `/` focuses)
- [X] T037 [P] [US1] Create `{FE}/components/board/board-list-view/board-list-view.component.ts` (table: #, kind, title, flags, status/resolution, cycle, author, age)
- [X] T038 [P] [US1] Create `{FE}/components/board/board-progress/board-progress.component.ts` (bar + counts per project or cycle)
- [X] T039 [US1] Keyboard in `{FE}/pages/board/board-page.component.ts`: J/K select, Enter open, 1-6 move, U urgent, L board/list, Esc, `?` help overlay `{FE}/components/board/board-help/board-help.component.ts`; delete with confirm dialog
- [X] T040 [US1] Read-only mode (FR-049): `{FE}/core/state/board-state.service.ts` loads `GET /board/access` (`{APP}/boardbridge/BoardWebConfig.java`, the same decision as T017 - Docker editable, tunnel never) on open and on socket reconnect; when not editable hide quick add, drag handles, Inbox actions, bulk bar, editors and composer on the board page, drawer and cycle page, show a "View only" chip; export stays available
- [X] T041 [US1] Add board styles to `frontend/src/styles.scss` (append a `// Board` section; reuse existing tokens `--card`, `--border`, `--purple`…; do not read the whole file - Grep for the token block)
- [X] T042 [US1] Component test `{FE}/components/board/board-columns/board-columns.component.spec.ts`: dropping a card in another column calls move with the new status

**Checkpoint**: US1 independently usable - the MVP.

---

## Phase 4: User Story 2 - Sort the Inbox quickly (P1)

**Goal**: Fine / Not in this flow / To do on Inbox cards, Undo + Add reason, Triage mode, bulk actions, Reopen, "looks like a closed card" hint.

**Independent Test**: spec US2 - five Inbox cards sorted by every path, one undo, one reopen, hint shown for a matching closed card.

### Tests for US2

- [X] T043 [P] [US2] `{BT}/application/service/BoardServiceTriageTest.java`: close with each resolution (activity RESOLUTION + REASON), NOT_IN_FLOW sets OUT_OF_SCOPE, set reason later, undo restores the status/resolution/reason/scope recorded in that close's RESOLUTION activity entry, only within 60 s of the close and only if nothing changed since (else 409), reopen clears, bulk ≤ 200 (more → 400) applies all and sends one notification, similarClosed filled when signatures match a CLOSED card
- [X] T044 [P] [US2] `{APPT}/boardbridge/BoardCallSignatureAdapterTest.java`: signature from a resolved inbound/outbound call = `<signal>|<METHOD> <pattern>` using triage normalization; unknown call → none

### Implementation for US2

- [X] T045 [US2] Create use cases `CloseCardUseCase`, `ReopenCardUseCase`, `SetReasonUseCase`, `UndoCloseUseCase`, `BulkCardsUseCase` in `{B}/application/port/in/` and implement in `{B}/application/service/BoardService.java`
- [X] T046 [US2] Add endpoints `POST /board/cards/{id}/close|reopen`, `PUT /board/cards/{id}/reason`, `POST /board/cards/bulk`, `POST /board/cards/{id}/undo-close` to `{B}/adapter/in/web/BoardController.java` with `CloseCardRequestDto`, `BulkRequestDto`
- [X] T047 [US2] Add `{B}/application/port/out/CallSignaturePort.java` (`Optional<String> signatureOf(direction, callId, cycleId)`); BoardService sets `signature` when a card's first call mention is saved (no-op until US3 adds mentions; also accepted from `links` on create)
- [X] T048 [US2] Add `NormalizeEndpointUseCase` in `backend/backend-triage/src/main/java/com/fathy/alfred/backend/triage/application/port/in/` implemented by `TriageService` (delegates to `domain/EndpointPattern`), with a unit test in `backend/backend-triage/src/test/java/com/fathy/alfred/backend/triage/application/service/TriageServiceTest.java`
- [X] T049 [US2] Create `{APP}/boardbridge/BoardCallSignatureAdapter.java` implementing `CallSignaturePort` via `{APP}/callrefbridge/CallRefResolver.java` + `NormalizeEndpointUseCase` (signal: status ≥ 500 → `5xx`, 4xx → `4xx`, error → `error`, else `ok`)
- [X] T050 [US2] Inbox actions row (✓ Fine, ⊘ Not in flow, → To do), resolution chip + reason on Closed cards, ↺ Reopen, similar-closed hint in `{FE}/components/board/board-card/board-card.component.ts`; F/N/T keys in `{FE}/pages/board/board-page.component.ts`
- [X] T051 [P] [US2] Create `{FE}/components/board/undo-toast/undo-toast.component.ts` (≥ 6 s, "Add reason" prompt, "Undo" calls `POST /board/cards/{id}/undo-close` (the server restores from the close's activity entry))
- [X] T052 [P] [US2] Create `{FE}/components/board/triage-dialog/triage-dialog.component.ts` (one card at a time, progress bar, reason field, F/N/T/S keys, "Inbox clear ✓" end)
- [X] T053 [P] [US2] Create `{FE}/components/board/bulk-bar/bulk-bar.component.ts` (tick or Shift+click/X select; Fine, Not in flow, To do, Mark urgent, clear)
- [X] T054 [US2] Component test `{FE}/components/board/triage-dialog/triage-dialog.component.spec.ts`: F, N, T, S keys call close/close/move/skip in order and end on "Inbox clear"

**Checkpoint**: US1 + US2 = complete P1 board.

---

## Phase 5: User Story 3 - Mention evidence in text (P2)

**Goal**: `@` picker with tabs per type, chips with hover preview and click-to-open, Linked list from mentions + direct links, mentioned live calls kept from retention, removed mentions shown with their label.

**Independent Test**: spec US3 - one description mentioning a call, statement, log line, spec section and card; each previews and opens; all in Linked.

### Tests for US3

- [X] T055 [P] [US3] `{BT}/domain/ParserVectorsTest.java` (mentions part) running `specs/014-task-board/vectors/mentions.json`
- [X] T056 [P] [US3] `{FE}/shared/utils/mention-syntax.spec.ts` running the same vectors (parse and serialize round-trip)
- [X] T057 [P] [US3] `{FE}/shared/utils/markdown-blocks.spec.ts`: headings, lists, ordered lists, code blocks, inline code, bold/italic, tables, `http(s)` links only (`javascript:` stays text), mentions inside paragraphs and lists, `<script>` stays literal text
- [X] T058 [P] [US3] `{BT}/application/service/BoardServiceMentionsTest.java`: saving a description/comment replaces that owner's mentions; direct links add/remove; Linked list = union; `ListMentionedCallIdsUseCase` returns distinct live call ids only (not cycle calls)
- [X] T059 [P] [US3] `{APPT}/storage/CommentedCallsKeptTest.java`: add a case - a call mentioned by a card is in `kept()` immediately after the mention is saved (no 5-minute wait); with the keep rule off it is not

### Implementation for US3

- [X] T060 [US3] Create `{B}/domain/MentionParser.java` (grammar in contracts/mention-syntax.md) and call it from `BoardService` on every description/comment save to refresh `mentions`
- [X] T061 [US3] Create `LinkCardUseCase` and `ListMentionedCallIdsUseCase` in `{B}/application/port/in/`; endpoints `POST/DELETE /board/cards/{id}/links` in `{B}/adapter/in/web/BoardController.java`
- [X] T062 [US3] Extend `{APP}/storage/CommentedCallsKept.java` `readReferenced()` with the board's `ListMentionedCallIdsUseCase` (via `ObjectProvider`, as relive/answers are), so mentioned live calls survive the limits (research R3); add `CommentedCallsKept.BoardMentions` (nested component in `{APP}/storage/`, beside the class's Inbound/Outbound ports - it needs package access) implementing a new board outbound port `MentionedCallsChangedPort` (in `{B}/application/port/out/`, called by `BoardService` when the set of mentioned live call ids changes) that resets only the 30 s kept-calls cache (`boardChanged()`), not the 5-minute Relive walk
- [X] T063 [P] [US3] Create `{FE}/shared/utils/mention-syntax.ts` (parse text → segments, serialize MentionRef → `@[type:ref|label]`, section slug)
- [X] T064 [P] [US3] Create `{FE}/shared/utils/markdown-blocks.ts` (typed block/inline tree, mentions as inline nodes) and `{FE}/components/board/markdown-view/markdown-view.component.ts` rendering it with bindings only (no `innerHTML`)
- [X] T065 [US3] Create `{FE}/components/board/mention-chip/mention-chip.component.ts`: colour per type, hover preview (calls: method/path/status/duration/direction/time via existing call summary endpoints; statement: SQL with binds via `/db-capture`; log line via `/call-logs`; spec: first lines of the section), click opens the item (call detail view, cycle page, spec viewer, card drawer), removed state with label when the lookup returns 404
- [X] T066 [US3] Create `{FE}/components/board/mention-picker/mention-picker.component.ts`: tabs Calls · Statements · Logs · Redis · Spec files · Code · Cycles/spacers/cards/rules; search; ↑↓ Enter Tab Esc; the Calls tab embeds `app-call-finder` (`{FE}/components/call-finder/call-finder.component.ts`) as is, with its `initialDirection` input, and turns its chosen call into a call mention (its search/paging logic is private to the component, so it is reused whole, not extracted); scoped to the card's cycle when it has one
- [X] T067 [US3] Create `{FE}/components/board/mention-editor/mention-editor.component.ts` (textarea; typing `@` opens the picker at the caret; inserts `@[…]`; Ctrl+Enter submits)
- [X] T068 [US3] Show mention chips (instead of plain labels) on `{FE}/components/board/board-card/board-card.component.ts`
- [X] T069 [US3] Component test `{FE}/components/board/mention-editor/mention-editor.component.spec.ts`: `@` opens picker, Tab switches type, Enter inserts the serialized mention at the caret

---

## Phase 6: User Story 4 - Know what happened to a card (P2)

**Goal**: card drawer with description, Linked list, full activity (comments + automatic entries), Claude comments shown as Did / Found / Next / Impact.

**Independent Test**: spec US4 - changes and comments show in order with author and time after a fresh session; 50 entries all shown.

### Tests for US4

- [X] T070 [P] [US4] `{BT}/application/service/BoardServiceActivityTest.java`: comment ≤ 256 KB; structured Claude comment `{did, found, next, impact?}` stored as fixed-heading Markdown; a Claude comment without did+found+next is refused (REFUSED_FOR_CLAUDE); activity page oldest first, limit 1-1000; every change kind from T025/T043 produces exactly one entry with old → new
- [X] T071 [P] [US4] `{BT}/adapter/in/web/BoardControllerTest.java` (activity and comment cases): `GET /board/cards/{id}/activity` paging/clamping, `POST /board/cards/{id}/comments` validation (either text or did+found+next)

### Implementation for US4

- [X] T072 [US4] Create `CommentOnCardUseCase`, `ListActivityUseCase` in `{B}/application/port/in/`; implement in `BoardService`; endpoints in `{B}/adapter/in/web/BoardController.java` with `CommentRequestDto`
- [X] T073 [US4] Create `{FE}/components/board/card-drawer/card-drawer.component.{ts,html}`: header (kind badge, author, cycle, number), title inline edit, Status/Kind/Scope selects, flag toggles, description (markdown-view + Edit with mention-editor), Linked list (+ link via picker), activity timeline, comment composer (mention-editor)
- [X] T074 [P] [US4] Create `{FE}/components/board/activity-timeline/activity-timeline.component.ts`: user/Claude/system entries; Claude comments split into labelled DID / FOUND / NEXT / IMPACT parts; change entries as "You moved Inbox → In progress"
- [X] T075 [US4] Open the drawer from card click/Enter in `{FE}/pages/board/board-page.component.ts` and from the list view; drawer re-fetches on `board-changed` for its card

---

## Phase 7: User Story 5 - Describe a cycle and attach its specs (P2)

**Goal**: per-cycle brief with mentions, spec files by upload or paste, Markdown viewer, overwrite on same name, spec mentions; cycle deletion cleans up.

**Independent Test**: spec US5 - brief written, .md + .txt uploaded, one pasted, all viewed, one replaced (cards mentioning it get SPEC_REPLACED), a section mentioned from a card, a .pdf refused.

### Tests for US5

- [X] T076 [P] [US5] `{BT}/application/service/CycleBriefServiceTest.java`: brief ≤ 256 KB with mentions indexed; spec name rules (`.md`/`.txt`, ≤ 200 chars, no `/` `\` `..`), ≤ 5 MB, ≤ 50 per cycle, replace returns `replaced=true` and writes SPEC_REPLACED on every card mentioning the file; `cycleRemoved` deletes brief/specs/marks and sets `cycle_deleted` on its cards
- [X] T077 [P] [US5] `{BT}/adapter/in/web/CycleBriefControllerTest.java`: raw-text and multipart PUT, wrong type → 400 with accepted types in the message, GET content type `text/plain; charset=utf-8`
- [X] T078 [P] [US5] `{APPT}/boardbridge/BoardCycleRemovedAdapterTest.java`: deleting a cycle through session-cycles calls the board's `CycleRemovedUseCase`

### Implementation for US5

- [X] T079 [US5] Create records `CycleBrief`, `SpecFile` in `{B}/domain/model/`; use cases `ManageBriefUseCase`, `ManageSpecFilesUseCase`, `CycleRemovedUseCase` in `{B}/application/port/in/`; `{B}/application/service/CycleBriefService.java`
- [X] T080 [US5] Create `{B}/adapter/in/web/CycleBriefController.java` for `/board/cycles/{cycleId}/brief` and `/specs[/{name}]` per contracts/rest-api.md (multipart size limit 5 MB in config)
- [X] T081 [US5] Add `CycleRemovedPort` to `backend/backend-session-cycles/src/main/java/com/fathy/alfred/backend/sessioncycles/application/port/out/` taken as an optional observer list (`setRemovedObservers`, `@Autowired(required = false)` - the slice's existing `setCopiedObservers` pattern, so no placeholder bean), called by the `DeleteSessionCycleUseCase` implementation in `SessionCyclesService` after a successful delete; test in `backend/backend-session-cycles/src/test/java/.../application/service/SessionCyclesServiceTest.java`
- [X] T082 [US5] Create `{APP}/boardbridge/BoardCycleRemovedAdapter.java` implementing `CycleRemovedPort` → `CycleRemovedUseCase`
- [X] T083 [P] [US5] Create `{FE}/components/board/cycle-brief/cycle-brief.component.ts` (markdown-view + Edit with mention-editor, "edited N ago")
- [X] T084 [P] [US5] Create `{FE}/components/board/spec-files/spec-files.component.ts` (list with size/time, drop zone, file input, "paste text" with name, refusal message for other types)
- [X] T085 [P] [US5] Create `{FE}/components/board/spec-viewer/spec-viewer.component.ts` (modal; markdown-view for .md, pre-wrapped text for .txt; opens at a `#section` slug; Replace, Download; large files rendered progressively so 5 MB does not freeze)
- [X] T086 [US5] Show brief + spec files above the Cycle board in `{FE}/pages/board/board-page.component.html`; "cycle deleted" chip on such cards in `board-card.component.ts`

---

## Phase 8: User Story 6 - See the board inside the session cycle (P2)

**Goal**: Calls | Board | Brief & specs tabs on the cycle page, card badges on calls, open-cards side panel, "Add to board" from a call's menu (cycle page and Live Calls).

**Independent Test**: spec US6 - badges on mentioned calls open their cards; "Add to board" makes a linked Inbox card visible on both views; a change on the top-level tab shows on the cycle page live.

### Tests for US6

- [X] T087 [P] [US6] `{BT}/application/service/CallBadgesTest.java`: badges per cycle from `mentions(cycle_id, call_id)`; `call-badges?callIds=` ≤ 100 (more → 400); deleted cards drop out

### Implementation for US6

- [X] T088 [US6] Create `CallBadgesUseCase` in `{B}/application/port/in/`, implement in `BoardService`, endpoints `GET /board/cycles/{cycleId}/call-badges` and `GET /board/call-badges` in `{B}/adapter/in/web/BoardController.java`
- [X] T089 [US6] Add tabs Calls / Board / Brief & specs to `{FE}/pages/session-cycle-detail/session-cycle-detail.component.{ts,html}` (Board tab hosts `board-columns` filtered to the cycle; Brief tab hosts cycle-brief + spec-files); tab badge "N open"
- [X] T090 [P] [US6] Create `{FE}/components/board/call-board-badge/call-board-badge.component.ts` (#n + kind, coloured by status/resolution; click opens the drawer) and render it on cycle call rows via the existing call-row slot/component used by session-cycle-detail
- [X] T091 [P] [US6] Open-card count on the cycle page's Board tab label (the side panel `cycle-open-cards` was built, then removed at the user's request - it narrowed the call list)
- [X] T092 [US6] Add "Add to board" (＋ Board) and the call's card badges to `{FE}/components/call-actions/call-actions.component.{ts,html}` - every call card has it (cycle page and Live Calls): creates an Inbox card linked to the call (cycle card when on a cycle page; project defaulted per research R16) and opens it
- [X] T093 [US6] Show call badges on Live Calls rows using `GET /board/call-badges`: `{FE}/core/state/board-badges-state.service.ts` batches every card's ask per 100 ids (the CommentCountsState shape), re-asked on `board-changed`

---

## Phase 9: User Story 7 - Claude works on the board (P3)

**Goal**: MCP tools, Claude limits enforced, closed reasons read before reporting, live strip with Pause/Stop.

**Independent Test**: spec US7 - Claude reviews a cycle; cards land in Inbox with ✦; Did/Found/Next comments; a reason-closed issue is not raised again; close/scope requests refused.

### Tests for US7

- [X] T094 [P] [US7] `{BT}/domain/ClaudeRulesTest.java` + cases in `{BT}/application/service/BoardServiceCardsTest.java`: Claude create → INBOX whatever status asked; move only TO_DO/IN_PROGRESS/FIXED; scope, close, reopen, delete, bulk, reason, undo, checklist mark → REFUSED_FOR_CLAUDE with message "Only the user decides this - propose it in a comment"; Claude create whose call links give a signature equal to a card closed as FINE or NOT_IN_FLOW → DUPLICATE_OF_CLOSED (409) naming that card's number, resolution and reason; same signature closed as WONT_FIX or no signature → created
- [X] T095 [P] [US7] `{BT}/application/service/AgentStatusServiceTest.java`: update, pause/resume/stop, expiry after 10 min → STOPPED, notification on each change
- [X] T096 [P] [US7] `mcp-server/test/board.test.ts` with `mcp-server/test/fake-alfred.ts`: each tool's request path/body, `X-Alfred-Actor: claude` sent, `board_add` passes call links through and relays the backend's 409 messages (paused, duplicate of a closed card) word for word

### Implementation for US7

- [X] T097 [US7] Create `{B}/domain/ClaudeRules.java` and apply it in every `BoardService` / `CycleBriefService` write when actor = CLAUDE, including: refuse create while the project's agent status is PAUSED, and the duplicate-of-closed check (signature from `CallSignaturePort` over the create request's call links, before insert)
- [X] T098 [US7] Create `ListClosedReasonsUseCase` + `GET /board/closed-reasons` in `{B}/adapter/in/web/BoardController.java`
- [X] T099 [US7] Create `AgentStatus` record, `AgentStatusUseCase`, `{B}/application/service/AgentStatusService.java` (in memory, per project; STOPPED is computed on read when `updatedAt` is older than 10 min - no scheduler) and endpoints `GET/PUT /board/agent-status`, `POST /board/agent-status/pause|resume|stop`
- [X] T100 [US7] Create `{MCP}/tools/board.ts` with `board_list`, `board_get`, `board_add`, `board_comment`, `board_move`, `board_flag`, `board_closed_reasons`, `get_brief`, `read_spec`, `board_status` per contracts/mcp-tools.md (masking via `{MCP}/masking.ts` where call data is quoted); register in `{MCP}/server.ts`; send `X-Alfred-Actor: claude` from `{MCP}/alfred-client.ts` for these calls
- [X] T101 [US7] Add the board paragraph to the server instructions in `{MCP}/server.ts` (where the instructions live; `prompts.ts` holds the debug prompts) (add findings with board_add, record progress with board_comment, read board_closed_reasons first, never ask to close or set scope)
- [X] T102 [P] [US7] Create `{FE}/components/board/live-strip/live-strip.component.ts` (WATCHING pulse / PAUSED / "Claude stopped" with last check; Pause/Resume/Stop) on the board page and the cycle page, fed by `agent-status` socket messages and one GET on open; a single one-shot timer to `updatedAt + 10 min` flips the strip to "Claude stopped" (re-armed on each message; not a repeating refresh)

---

## Phase 10: User Story 8 - Export the board (P3)

**Goal**: board / selected cards / cycle export as .md, .html, .json (re-importable), nothing shortened; cycle export checkboxes off by default with unchanged output.

**Independent Test**: spec US8 - each format compared to the board; JSON imported into another project equals the original; cycle export with boxes off is byte-identical to before.

### Tests for US8

- [X] T103 [P] [US8] `{FE}/shared/utils/board-json.spec.ts`: export → import round-trip of cards with every kind/flag/resolution/reason, 200-entry histories, 1 MB descriptions and a 5 MB spec file - nothing shortened; renumbering of clashing numbers rewrites `@[card:…]` mentions; fixtures built by the exporter only
- [X] T104 [P] [US8] `{FE}/shared/utils/board-md-builder.spec.ts` (both builders): every field and history entry present; HTML escapes `<script>` in titles, descriptions, comments and spec text; mentions rendered as readable labels with refs
- [X] T105 [P] [US8] Add to the existing cycle export spec (`{FE}/shared/utils/export-build.spec.ts`): with both new options off the output is identical to the current output; with them on, brief, full spec files and cards appear
- [X] T106 [P] [US8] `{BT}/application/service/ImportBoardServiceTest.java`: import streams lines, renumbers clashes, keeps activity actors and times, ≤ 200 MB

### Implementation for US8

- [X] T107 [P] [US8] Create `{FE}/shared/utils/board-json.ts` (`alfred-board/1`, one record per line: header, cards, activity, briefs, spec files, marks; lines → Blob via `{FE}/shared/utils/export-file-io.ts`; streaming reader for import)
- [X] T108 [P] [US8] Create `{FE}/shared/utils/board-md-builder.ts` and `{FE}/shared/utils/board-html-builder.ts` (reuse `{FE}/shared/utils/html-builder.ts` escaping helpers)
- [X] T109 [US8] Create `ImportBoardUseCase` + `{B}/adapter/in/web/BoardImportController.java` (`POST /board/import`, streamed, size-capped)
- [X] T110 [US8] Export menu on `{FE}/pages/board/board-page.component.ts` (Board → .md/.html/.json, Selected cards…, Import .json) and on the cycle page
- [X] T111 [US8] Add "Include brief & specs" and "Include board cards" checkboxes (off by default) to the existing cycle export dialog and pass them to `{FE}/shared/utils/export-build.ts`, which appends the board sections from T108 only when set

---

## Phase 11: User Story 9 - Acceptance checklist from the spec (P4)

**Goal**: acceptance items of a spec file shown as a checklist; the user marks pass / fail / can't tell with evidence; marks survive a replace when the item text is unchanged.

**Independent Test**: spec US9 - four items marked, one changed, reload keeps marks and history; replacing the file clears only the changed item's mark.

### Tests for US9

- [X] T112 [P] [US9] `{BT}/domain/AcceptanceItemsTest.java` and `{FE}/shared/utils/acceptance-items.spec.ts`, both running `specs/014-task-board/vectors/acceptance-items.json`
- [X] T113 [P] [US9] `{BT}/application/service/ChecklistTest.java`: mark with evidence ≤ 8 KB, history appended per change, actor USER, Claude refused (T094), unchanged item keeps its mark after replace, changed/new item unmarked

### Implementation for US9

- [X] T114 [US9] Create `{B}/domain/AcceptanceItems.java` (items under the first heading containing "acceptance"; key = SHA-256 of whitespace-normalized text) and `{FE}/shared/utils/acceptance-items.ts` (same rules)
- [X] T115 [US9] Create `ChecklistItem`, `ChecklistMark` records, `MarkChecklistUseCase` (in `CycleBriefService`; evidence mentions indexed with owner type `CHECKLIST` so evidence calls are kept too), endpoints `GET /board/cycles/{cycleId}/checklist` and `PUT /board/cycles/{cycleId}/checklist/{fileName}/{itemKey}` in `{B}/adapter/in/web/CycleBriefController.java`
- [X] T116 [US9] Create `{FE}/components/board/acceptance-checklist/acceptance-checklist.component.ts` (rows with ✓ / ✗ / ? toggles, evidence mention chips + add via picker, "marked by you · time") in the cycle brief area

---

## Phase 12: Polish & cross-cutting

- [X] T117 [P] Performance check: `{BT}/adapter/out/sqlite/SqliteBoardRepositoryPerfTest.java` seeds 2,000 cards with histories and asserts list + filter < 1 s; record the measured numbers in `docs/board.md`
- [X] T118 [P] Write `docs/board.md` (model, statuses, resolution names - button label "Not in flow", full name "Not in this flow" in chips and exports -, mentions, kept calls, Claude limits, exports, limits/seatbelts, measurements)
- [X] T119 [P] Update `CLAUDE.md` (add `board` to the API prefix list and the SPA-page sentence; one "Board" paragraph under Non-obvious rules) and `AGENTS.md` (project map)
- [X] T120 [P] Update `docs/architecture.md` (backend-board slice, boardbridge, `CycleRemovedPort`, `NormalizeEndpointUseCase`, kept calls include board mentions), `docs/frontend-architecture.md` (board state, mention editor/picker, markdown-view), `docs/mcp.md` (board tools)
- [X] T121 Run full suites: backend `mvn test` (Docker JDK 21, whole reactor incl. ArchUnit and `SpaPageFilterTest`), `cd frontend && npm test && npm run build`, `cd mcp-server && npm test`; fix failures
- [X] T122 Walk through `specs/014-task-board/quickstart.md` on a rebuilt Docker stack and in the native staged build (memory: native-install-e2e-check); verify page reload of `/board` serves the SPA in both; with two tabs open, time a card move until it shows in the other tab (SC-004: < 2 s) and record it in `docs/board.md`

---

## Dependencies & execution order

### Phases

- Phase 1 Setup → Phase 2 Foundational → user stories → Phase 12 Polish.
- **US1** (P1) needs only Phase 2. **MVP = Phase 1 + 2 + 3.**
- **US2** (P1) needs US1 (cards and board page).
- **US3** needs US1 (descriptions on cards). US2's similar-hint uses US3 mentions for signatures; until US3, signatures come only from `links` on create.
- **US4** needs US1; renders mentions best after US3 (works without: plain Markdown).
- **US5** needs Phase 2; spec mentions need US3.
- **US6** needs US1 (+ US3 for badges from mentions; "Add to board" uses direct links from T061).
- **US7** needs US1, US2 (closed reasons), US4 (comments), US5 (brief/specs reads).
- **US8** needs US1, US4, US5 (and US9 marks if present - exporter includes marks when the table has rows).
- **US9** needs US5.

### Within each story

Tests first (must fail) → domain → ports/service → controller → frontend → component test.

### Parallel opportunities

- Phase 1: T003-T007 in parallel after T001-T002.
- Phase 2: T008/T009 together; T015, T018-T021 in parallel once T012 exists.
- Each story's `[P]` tests together; frontend `[P]` components together once the API exists.
- US5 and US3 can proceed in parallel after US1 (different files), as can US6's backend (T087-T088) with US5.
- Project rule: one session does the work; at most ONE subagent at a time, never a fan-out (CLAUDE.md "Subagents: token budget"). Parallel markers show independence, not a request to fan out.

### Parallel example: US1

```text
T024 QuickAddParserTest   |  T025 BoardServiceCardsTest  |  T026 BoardControllerCardsTest  |  T027 quick-add-parser.spec.ts
then T034 board-card  |  T036 quick-add  |  T037 board-list-view  |  T038 board-progress
```

## Implementation strategy

1. **MVP**: Phases 1-3 (US1). Stop, run quickstart steps 2-4, demo.
2. **P1 complete**: + Phase 4 (US2) - the Inbox becomes usable for real findings.
3. **P2**: US3 → US4 → US5 → US6 (evidence, history, brief/specs, cycle page).
4. **P3**: US7 (Claude) → US8 (export/import).
5. **P4**: US9 checklist.
6. Polish (Phase 12) once, at the end; full suites run once there, targeted tests per task before that.
