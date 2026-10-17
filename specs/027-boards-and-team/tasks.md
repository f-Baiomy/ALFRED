# Tasks: Boards rework and Team tab

**Input**: Design documents from `specs/027-boards-and-team/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, mock.html)
**Tests**: included. Constitution VI requires tests per layer, and plan.md names them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1…US9 from spec.md

## Path Conventions

Aliases used in task paths (all relative to the repo root):

- `BOARD` = `backend/backend-board/src/main/java/com/fathy/alfred/backend/board`
- `BOARD_T` = `backend/backend-board/src/test/java/com/fathy/alfred/backend/board`
- `CYC` = `backend/backend-session-cycles/src/main/java/com/fathy/alfred/backend/sessioncycles`
- `APP` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `APP_T` = `backend/backend-app/src/test/java/com/fathy/alfred/backend`
- `TB` = `backend/backend-teamboards`
- `SPI` = `backend/backend-teamboards/teamboards-spi/src/main/java/com/fathy/alfred/backend/teamboards/spi`
- `CORE` = `backend/backend-teamboards/teamboards-core/src/main/java/com/fathy/alfred/backend/teamboards`
- `CORE_T` = `backend/backend-teamboards/teamboards-core/src/test/java/com/fathy/alfred/backend/teamboards`
- `AZ` = `backend/backend-teamboards/teamboards-azure/src/main/java/com/fathy/alfred/backend/teamboards/azure`
- `AZ_T` = `backend/backend-teamboards/teamboards-azure/src/test/java/com/fathy/alfred/backend/teamboards/azure`
- `ARCH` = `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture`
- `FE` = `frontend/src/app`
- `MCP` = `mcp-server/src/tools`

---

## Phase 1: Setup

- [X] T001 Create the Maven parent `TB/pom.xml` (packaging pom) with modules `teamboards-spi`, `teamboards-core`, `teamboards-azure`, each with its own `pom.xml` (spi: Jackson only; core: spi + Spring web/jdbc + sqlite like `backend-logs`; azure: spi only), and add `backend-teamboards` to `backend/pom.xml` `<modules>`
- [X] T002 Add `teamboards-core` and `teamboards-azure` dependencies to `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`
- [X] T003 [P] Add `teamboards` to the API prefix regex in `gateway/nginx.conf` and to the prefix list in `APP/web/SpaPageFilter.java`; extend `SpaPageFilterTest` expectations (confirm its path with `codegraph explore "SpaPageFilterTest"` first)
- [X] T004 [P] Add `frontend/scripts/check-team-boundaries.mjs` (fails if a file outside `FE/components/team/connectors/` imports from it, and if `interval(`, `setInterval(` or a periodic `timer(` appears under `FE/components/team/`, `FE/pages/team/` or the new board components: SC-009) and chain it into `pretest` in `frontend/package.json`

---

## Phase 2: Foundational (blocks every story)

- [X] T005 Add `Board`, `BoardState`, `BoardActivity`, `BoardRelations` records in `BOARD/domain/model/` per data-model.md
- [X] T006 Add the new tables (`boards`, `board_cycles`, `board_boards`, `card_cycles`, `board_activity`, `cards.board_id` + index) to the schema init in `BOARD/adapter/out/sqlite/SqliteBoardRepository.java`
- [X] T007 Create `BOARD/adapter/out/sqlite/BoardModelMigration.java`. Steps:
  - guard on `board_meta.boards_v1`;
  - rename `cycle_id` → `board_id` in the task and chat tables listed in data-model.md (check `PRAGMA table_info` first);
  - create one `default:<project>` board per project;
  - set `cards.board_id`;
  - rewrite project chat keys `''` → `default:<project>`;
  - run everything in one transaction.
- [X] T008 (amended, research.md R1: the task key keeps the name `cycle_id`/`cycleId` and holds the board id) Re-key every SQL string from `cycle_id` to `board_id` for the renamed tables in `SqliteBoardRepository.java`, `SqliteChatRepository.java`, `SqliteRequirementRepository.java`, `SqliteBriefCommentRepository.java` and `SqliteSnippetRepository.java` (leave `mentions.cycle_id` and `cards.cycle_id` as origin)
- [X] T009 (amended, R1: `ChatKey.cycleId` is the board id; `default:<project>` maps to the project chat `''`) Change `ChatKey` in `BOARD/domain/model/ChatKey.java` to `(project, boardId)` with `PROJECT_SCOPE` resolving to `default:<project>`; update callers found by `codegraph explore "ChatKey"`
- [X] T010 Add out-ports `BOARD/application/port/out/CycleControlPort.java` (create, start, pause, status, names) and `BOARD/application/port/out/LinkedWorkItemPort.java` (Optional linked item + changes since setup); add no-op defaults so the board slice runs without the bridge
- [X] T011 Implement `CycleControlPort` in `APP/boardbridge/BoardCycleControlAdapter.java` over the session-cycles use cases
- [X] T012 [P] Test the migration in `BOARD_T/adapter/out/sqlite/BoardModelMigrationTest.java`. The old-schema fixture is built with the pre-change DDL copied verbatim into the test. Assert: columns renamed, default boards created, card homes set, project chat re-keyed, second run is a no-op.

**Checkpoint**: the app starts on an old database and everything shows on default boards.

---

## Phase 3: US1: A board is the task, cycles only hold calls (P1) 🎯 MVP

**Goal**: named boards holding brief, specs, requirements and chat; cycles related many-to-many.
**Independent test**: create a board, relate two cycles; the Task tab judges on both; Session Cycles shows no brief or chat.

- [X] T013 [P] [US1] Create use cases `ManageBoardsUseCase.java` and `RelateCycleUseCase.java` in `BOARD/application/port/in/`, with outcome enum `BoardOutcome` (OK, NOT_FOUND, DEFAULT_PROTECTED, REFUSED_FOR_CLAUDE) in `BOARD/domain/model/BoardOutcome.java`
- [X] T014 [US1] Implement `BOARD/application/service/BoardsService.java`:
  - create, rename, state, delete (cards to default, cascade task rows by `board_id`), list;
  - relate/unrelate a cycle or a board;
  - write `board_activity` rows, with Undo JSON for Claude's actions;
  - enforce Claude's limits (FR-001b; FR-013: Inbox-only new cards, allowed moves and own-Inbox edits apply per board);
  - check `askedIn` for Claude's create: a user chat message on a board chat under 30 min old, or `"terminal"` recorded in activity; else `403 NOT_ASKED` (FR-040, R13a).
- [X] T015 [US1] Add repository methods for boards, relations and activity in `SqliteBoardRepository.java` (indexed, `LIMIT`, summary columns); cap `board_activity` at `alfred.board.activity-max-rows` per board, trimming ≤ 200 oldest rows per insert
- [X] T016 [US1] Add `BOARD/adapter/in/web/BoardsController.java` for the boards and relations routes in contracts/board-rest.md, with `@Valid` DTOs and clamped limits, behind `BoardEditAccess`
- [X] T017 [US1] Move the task routes to `/board/boards/{id}/…` in `CycleBriefController.java`, `RequirementController.java` and `BoardInsightsController.java`, and keep `/board/cycles/{id}/…` as aliases (resolve cycle → board, or `409 {boards}`)
- [X] T018 [US1] Re-key `RequirementService.java` to judge per board: boards related to the call's cycle, plus every OPEN board of the project for live calls; skip DONE/ARCHIVED (FR-005, R4)
- [X] T019 [P] [US1] Test `BOARD_T/application/service/BoardsServiceTest.java` (create, default protected, delete moves cards, Undo, activity cap; Claude: `NOT_ASKED` without `askedIn`, refused for a stale or non-user message, accepted with "terminal" and recorded, Claude limits per board)
- [X] T020 [P] [US1] Test `BOARD_T/adapter/in/web/BoardsControllerTest.java` (`@WebMvcTest`: validation, clamps, tunnel refused, aliases)
- [X] T021 [P] [US1] Extend `BOARD_T/application/service/RequirementServiceTest.java`: per-board verdicts kept apart; archived board not judged; live call judged by every open board of the project
- [X] T022 [P] [US1] Add `Board` models and boards/relations calls to `FE/core/models/board.models.ts` and `FE/core/services/board-api.service.ts`
- [X] T023 [US1] Create `FE/components/board/board-picker/` (grouped default/task, Show archived, New board dialog) and `FE/components/board/related-strip/` (cycles + boards chips, relate dialog, unrelate), and use them in `FE/components/board/board-view/` per mock.html §Board
- [X] T024 [US1] Re-key `FE/components/board/task-view/` and `FE/components/board/cycle-brief/` to `boardId`; add the Cycles pane (REC/paused badge, shared-with, Unrelate) and the board state menu (Open/Done/Archive)
- [X] T025 [US1] Group `FE/pages/session-cycles-list/` by board (a cycle under each of its boards, "Also on", "Not on any board", Group by None, Record for it) per mock.html
- [X] T026 [P] [US1] Add the Board activity tab component `FE/components/board/board-activity/` with Undo

**Checkpoint**: US1 works alone on migrated data.

---

## Phase 4: US5: Existing data moves to the new model (P1)

**Goal**: briefed cycles become boards; nothing lost; re-run safe.
**Independent test**: start on a copy of real data and compare counts (quickstart §2).

- [X] T027 [US5] Extend `BoardModelMigration.java` for briefed cycles:
  - each id in `cycle_briefs` ∪ `spec_files` ∪ keyed chats ∪ `item_evidence` becomes a board with the same id;
  - its name and `migrated_from` come from `CycleControlPort.names`;
  - add `board_cycles(id, id)`;
  - move cards with that origin home;
  - relate unbriefed cycles to the default board;
  - write MIGRATED activity.
- [X] T028 [P] [US5] Extend `BoardModelMigrationTest.java` with SC-001 counts on a fixture with briefed and unbriefed cycles, chats and cards
- [X] T029 [US5] Show the "Migrated from cycle …" banner in `FE/components/board/board-view/` from `Board.migratedFrom`

---

## Phase 5: US2: Cards have one home (P1)

**Goal**: home board, origin cycle, related cycles, own/related view, move home.
**Independent test**: a card from a shared cycle shows dashed on the other board with one status; Own only hides it.

- [X] T030 [P] [US2] Create the use case `BOARD/application/port/in/MoveCardHomeUseCase.java`, and add related-cycle methods to `LinkCardUseCase.java`
- [X] T031 [US2] Implement move home (activity on both boards, Undo for Claude) and relate/unrelate a card's cycle in `BOARD/application/service/BoardService.java`
- [X] T032 [US2] Implement the own + related visibility query from data-model.md in `SqliteBoardRepository.java` and the `GET /board/cards?board=&scope=` param (old `project/cycleId` params still accepted) in the card controller
- [X] T033 [P] [US2] (in `BoardsServiceTest.java`) Test `BOARD_T/application/service/CardHomeTest.java` (number unchanged, both activities, visibility own/all, related board's cards)
- [X] T034 [P] [US2] Add the pure util `FE/shared/utils/board-cards-visibility.ts` (+ `.spec.ts`) for the dashed "home X" marking
- [X] T035 [US2] Update `FE/components/board/board-card/` (home label, origin chip, origin deleted) and `FE/components/board/card-drawer/` (home select, origin, related cycles add/remove), and the Own+related / Own only switch in `board-view`

---

## Phase 6: US3: One cycle shared by several boards (P1)

**Goal**: per-board verdicts, "for this board" filter, one listen with smart homes, record join-or-new.
**Independent test**: quickstart §3 steps 2–4.

- [X] T036 [P] [US3] Create the use case `BOARD/application/port/in/CycleVerdictsUseCase.java` and implement `GET /board/cycles/{cycleId}/verdicts` (per call: each related board's item verdicts, cards with homes; `board` filter = items name or cards mention) in `BOARD/application/service/CycleVerdictsService.java` + controller route
- [X] T037 [US3] Create `BOARD/application/service/ListenHomeResolver.java`:
  - a signature match across the cycle's boards adds evidence;
  - else home = the one board whose items name the endpoint;
  - else post a `board_ask` with one option per board to the starting board's chat;
  - with no board naming it, home = the starting board, else the cycle's only board, else its default board (R5).
- [X] T038 [US3] Add out-port `CYC/application/port/out/RecordingGuardPort.java` (no-op default), call it from start/resume in `CYC/application/service/SessionCyclesService.java` with `onRunning=ASK|PAUSE_OTHER` (`409 RECORDING_CONFLICT`), and implement it in `APP/boardbridge/BoardRecordingGuardAdapter.java` (RECORDING cycles sharing a project through their boards; a board-less cycle is never blocked) (FR-008, R3). Add `RecordForBoardUseCase` + `POST /board/boards/{id}/record`. With `ASK`, return 409 + the running cycle when a RECORDING cycle is related to a board of the same project; `JOIN` relates it; `NEW` pauses it and creates and starts a new one through `CycleControlPort`.
- [X] T039 [P] [US3] Test `BOARD_T/application/service/ListenHomeResolverTest.java` (evidence not duplicate; single home; ask on several; archived boards ignored)
- [X] T040 [P] [US3] Test `BOARD_T/application/service/RecordForBoardTest.java` (ask/join/new, pause) and `APP_T/boardbridge/BoardRecordingGuardAdapterTest.java` (Session Cycles start and MCP `start_recording` blocked or pause-other; board-less cycle free)
- [X] T041 [P] [US3] Add the pure util `FE/shared/utils/cycle-verdicts.ts` (+ spec) for column and filter logic
- [X] T042 [US3] Create `FE/components/board/cycle-verdicts-dialog/` (All / for-board filter, per-board verdict columns, cards with home, ▶ /alfred-listen) and open it from the task-view Cycles pane and session-cycles-list
- [X] T043 [US3] Create `FE/components/board/record-dialog/` (from a board: join running vs new + pause; from Session Cycles start/resume: pause the other or cancel), used by task-view and session-cycles-list; update MCP `start_recording` in `MCP/cycles.ts` to pass `onRunning` and report the conflict
- [X] T044 [US3] Update the MCP tools: `MCP/check.ts` (`check_calls` / `wait_for_calls` per cycle, related boards in result, homes via the new endpoint), `MCP/board.ts` (`board` param on all tools, `board_add` home resolution, new `board_boards`, `board_relate`, `board_move_home`, `board_record`, `board_open` with `askedIn`), `MCP/task.ts` (`task_context` by board), `MCP/cycles.ts` (`create_cycle` with `board`)

---

## Phase 7: US4: Chat lives on boards (P2)

**Goal**: one chat per board, answered by the board's terminal, else the project runner, else it waits.
**Independent test**: quickstart §3 step 6.

- [X] T045 [US4] Re-key the live runner and chat binding in `BOARD/application/service/ChatService.java`, `SkillRunsService.java` and the `LiveWorkController` (`PUT /board/live-runner` takes `boardId`, `cycleId` alias; `GET /board/cycle-chat` → board chat). Keep the fork path with `// REMOVE-LATER(027)`.
- [X] T046 [P] [US4] Extend `BOARD_T/application/service/ChatServiceTest.java`: terminal answers its board; project runner fallback; waits when none; project scope → default board
- [X] T047 [US4] Update `FE/pages/chat-window/` and the board chat panel to key by board, and show the runner header states and cancel on WAITING
- [X] T048 [US4] Update `skills/alfred-live/SKILL.md` and `skills/alfred-live/chat.mjs` to bind `/alfred-live <board>` (heartbeat `boardId`)

---

## Phase 8: US6: Deleting a cycle keeps what boards mention (P2)

**Goal**: rescue mentioned data into "kept from" cycles per board; delete the rest.
**Independent test**: quickstart §3 step 5.

- [X] T049 [P] [US6] Create the use case `BOARD/application/port/in/CycleDeletePlanUseCase.java` + `GET /board/cycles/{cycleId}/delete-plan` (per board: mentioned call ids, statements, log lines, cards; deleteCalls; originCards) in `BoardRelationsService.java`
- [X] T050 [US6] (amended, research.md R7: the cycle is kept as "kept from <name>" with only the mentioned calls - no copy, no rewrite) Implement the rescue in `APP/boardbridge/BoardCycleRemovedAdapter.java` + new `APP/boardbridge/BoardCycleDeletePlanAdapter.java`:
  - before the session-cycles delete, copy each board's mentioned calls into a new cycle "kept from <name>" via `copyInto` / `CopyInternalCallsToCycleUseCase`;
  - relate it to the board;
  - rewrite the board's `mentions.cycle_id`;
  - then let the delete proceed and mark origin cards `cycle_deleted`;
  - extend `CommentedCallsKept.BoardMentions` (in `APP`) to return the live inbound call ids of mentioned captured calls, so rescued calls keep their statements, Redis commands and log lines under storage limits (FR-017, R7).
- [X] T051 [P] [US6] (as `CycleDeletePlanTest` + `SessionCyclesServiceTest`) Test `APP_T/boardbridge/CycleDeleteRescueTest.java` with real `@TempDir` SQLite stores: kept per board, rest deleted, statements still reachable from a copied call, and storage-limit eviction skips the live call while a card mentions the kept copy (R7)
- [X] T052 [US6] Update the delete dialog in `FE/pages/session-cycles-list/` and `FE/pages/session-cycle-detail/` to show the plan (kept per board vs deleted) before confirm

---

## Phase 9: US7: The Team tab shows the team's work (P2)

**Goal**: connections, cache, Azure connector, the four views, settings, token in the browser.
**Independent test**: quickstart §4 steps 1–3, 7, 8.

- [ ] T053 [P] [US7] Create the SPI in `SPI/`: `Connector`, `BoardsReader`, `SprintsReader`, `SquadsReader`, `RevisionsReader`, `AttachmentsReader`, `SeedContributor`, `ProviderException`, `ProviderWords`, and `model/*` records incl. `Token` with a masked `toString()` (contracts/connector-spi.md)
- [ ] T054 [US7] Create the core domain and ports in `CORE/domain/` and `CORE/application/port/{in,out}/`: `TeamRefreshUseCase`, `ListItemsUseCase`, `GetItemUseCase`, `RevisionsUseCase`, `ManageConnectionsUseCase`, `SquadsUseCase`, `ChangesUseCase`, `MappingsUseCase`, `FieldMapsUseCase`, `LinksUseCase`; `TeamCachePort`; `TeamChangeSignalPort`; outcome enum `RefreshOutcome`
- [ ] T055 [US7] Create `CORE/adapter/out/sqlite/SqliteTeamCacheRepository.java` with the `teamboards.db` schema from data-model.md (FTS5, indexes, summary list queries without `native_json`, page-wise upsert), eviction per data-model "Retention" (old `changes` by age/rows, then revisions oldest first, then unlinked items; linked items never), `@PostConstruct` writability check
- [ ] T056 [US7] Create `CORE/application/service/TeamService.java`:
  - capabilities from `instanceof`;
  - incremental refresh (`changedSince = fetchedAt`), streaming pages into the cache;
  - records `fetched_by`;
  - writes `changes` rows;
  - signals `/ws/teamboards`;
  - TOKEN_MISSING / TOKEN_REJECTED / PROVIDER_BUSY outcomes.
- [ ] T057 [US7] Create `CORE/adapter/in/web/TeamboardsController.java` for the connectors (installed kinds + capabilities; Jira/ClickUp `installed:false`), read, refresh, connections, squads, changes, seen, mappings and field-maps routes in contracts/teamboards-rest.md (`@Valid`, clamped limits, settings edit rule, `404 NOT_SUPPORTED` by capability), plus `/ws/teamboards` change signal
- [ ] T058 [US7] Create `APP/teamboardsbridge/TeamTokenLogFilter.java` (strips `X-Alfred-Team-Token` from request logs) and the storage-budget share registration in `APP/storage/` for `teamboards.db`
- [ ] T059 [US7] Implement the Azure connector in `AZ/AzureDevOpsConnector.java`, `AZ/AzureClient.java` (JDK HttpClient, basic auth with the PAT, timeouts 5 s/30 s, one `Retry-After` retry, 401/403 → TOKEN_REJECTED, never logs bodies) and `AZ/AzureMapper.java`:
  - changed items: WIQL `System.ChangedDate`, then `workitemsbatch` 200 at a time with relations;
  - revisions, teams + members, iterations, boards, work item types (custom too);
  - `AttachmentsReader`: list an item's attachments and download one (≤ 10 MB each, ≤ 50 MB per item; larger listed by name and link).
- [ ] T060 [P] [US7] Test `AZ_T/AzureDevOpsConnectorTest.java` against recorded JSON fixtures in `TB/teamboards-azure/src/test/resources/azure/` (paging, custom types, relations, revisions, attachments and size caps, 401, 429). Fixtures are scrubbed: fake org, fake token, no real names or emails
- [ ] T061 [P] [US7] Test `CORE_T/application/service/TeamServiceTest.java` with a fake connector (incremental refresh, capability gating, outcomes, changes feed, seen shared)
- [ ] T062 [P] [US7] Test `CORE_T/adapter/out/sqlite/SqliteTeamCacheRepositoryTest.java` (20,000-item list/search < 1 s, eviction order incl. `changes` by age/rows, linked items kept, no `native_json` in list SQL)
- [ ] T063 [P] [US7] Test `APP_T/teamboardsbridge/TeamTokenNeverStoredTest.java`: a sample token sent on refresh never appears in `teamboards.db`, `board.db`, logs or an export (SC-007)
- [ ] T064 [US7] Add ArchUnit rules in `ARCH/HexagonalArchitectureTest.java`: teamboards depends on no other slice; `..teamboards.azure..` never imports `..teamboards.core..` and vice versa; spi has no Spring; spi connector interfaces declare no write methods (no `create*`/`update*`/`delete*`, FR-026) (SC-008)
- [ ] T065 [P] [US7] Create `FE/core/team/connector-ui.ts` (`ConnectorUi`, `TEAM_CONNECTORS`), `FE/core/team/team.models.ts`, `FE/core/team/team-api.service.ts` (adds the token header on `/teamboards/**` only) and `FE/core/team/team-token.store.ts` (localStorage per connection, try/catch)
- [ ] T066 [P] [US7] Create the Azure UI connector in `FE/components/team/connectors/azure/` (`index.ts` provider, settings component, field renderer for HTML fields through the sanitising markdown view, provider words)
- [ ] T067 [US7] Create `FE/pages/team/team-page.component.ts` and the views in `FE/components/team/`:
  - `connection-switcher` with capabilities and the fetched label;
  - `items-table` with filters and paging;
  - `item-drawer` with fields, mapped targets, links and history on open;
  - `boards-sprints`;
  - `squads` with the map-to-team select;
  - `changes-feed` with filters and shared "mark seen";
  - no-token and expired banners, capability gating.

  Follow mock.html §Team, add the route `/team`, and add the nav tab.
- [ ] T068 [US7] Create `FE/components/team/connection-settings/` and add it to `FE/pages/settings/`: add connection (installed kinds; Jira/ClickUp "not installed"), PAT save/clear, scope toggles, read-only through the tunnel
- [ ] T069 [P] [US7] Add `MCP/team.ts` with `team_items`, `team_item`, `team_changes`, `team_squads` (read cache only)

---

## Phase 10: US8: Open a board from a work item (P2)

**Goal**: Start / chat / Claude-suggested, mapping, seed, Open task menu.
**Independent test**: quickstart §4 steps 4–5.

- [ ] T070 [US8] Add `StartFromItemUseCase` + `StartOutcome` in `CORE/application/port/in/`. Implement start/cancel in `CORE/application/service/StartService.java`:
  - mapping lookup in order SPRINT → SQUAD → AREA → PROJECT;
  - `NEEDS_TARGET` + remember;
  - `ALREADY_STARTED`;
  - `start_requests` state;
  - when the request carries a token, download the item's attachments into `pending_attachments` (size caps, 24 h cleanup) (FR-037a).
- [ ] T071 [US8] Implement `APP/teamboardsbridge/TeamStartToChatAdapter.java` (posts a WAITING `/alfred-setup <conn>/<id>` message to the target board's chat through `ChatUseCase`) and `APP/teamboardsbridge/LinkedWorkItemAdapter.java` (implements `LinkedWorkItemPort` from `board_links`); on board delete (a new `BoardDeletedPort` called by `BoardsService`), remove that board's `board_links` row so the item shows Start again (spec Edge Cases); on `team_link`, move the item's `pending_attachments` into the board as spec files; add `POST /teamboards/links/{board}/attachments/fetch` and a "Fetch attachments" button in `FE/components/board/task-view/` shown when the board lists attachments it does not hold yet (FR-037a)
- [ ] T072 [US8] Implement the seed builder in `CORE/application/service/SeedBuilder.java`:
  - neutral fields;
  - field maps → Purpose / Steps / Acceptance / Context;
  - the parent's acceptance criteria;
  - children as steps for Feature/Epic;
  - attachments list;
  - `SeedContributor` hook.

  Add `team_item` seed output, plus `team_link` and `team_start` (user-asked only) in `MCP/team.ts`.
- [ ] T073 [P] [US8] Test `CORE_T/application/service/StartServiceTest.java` and `SeedBuilderTest.java` (mapping order, unmapped, already started, Feature children, custom field maps, attachments pending with a token and listed without one)
- [ ] T074 [US8] Update `skills/alfred-setup/SKILL.md`:
  - accept `AB#id` / `<conn>/<id>`;
  - read `team_item`;
  - create the board with `board_open` (askedIn) and the first recording with `board_record`;
  - relate the mapped board;
  - write brief and spec;
  - never fetch attachments (no token): list any not yet on the board by name and link;
  - call `team_link`.
- [ ] T075 [US8] Create `FE/components/team/start-button/` (Start → waiting/cancel → running → Open task ▾ with Open board / New re-test cycle / /alfred-resume) and the unmapped-target dialog
- [ ] T076 [US8] Handle "open a board for AB#id" / "open a new board <name>" in board chats in the chat answering rules: `skills/_shared/rules.md` and `skills/alfred-live/SKILL.md` (new board relates back to the chat's board; refuses a second board for one item; when the item is not in the cache, replies "AB#id is not in the cache yet: Refresh the Team tab first" and opens nothing)
- [ ] T077 [US8] Post the Claude suggestion on Refresh: when Refresh brings new items and the mapped board has a runner, post a chat message with Yes/No options through the bridge (`APP/teamboardsbridge/TeamSuggestAdapter.java`); render Yes/No in the board chat panel; Yes calls start

---

## Phase 11: US9: A board notices when its work item changed (P3)

**Goal**: "Azure changed" badge, before/after review, save or dismiss.
**Independent test**: quickstart §4 step 6.

- [ ] T078 [US9] Compute `changedSinceSetup` from revisions after `seen_rev` in `CORE/application/service/LinksService.java`; `POST /teamboards/links/{board}/seen`
- [ ] T079 [US9] Show the "<provider> changed" banner (label from `ConnectorUi.label`, e.g. "Azure changed") in `FE/components/board/task-view/` via `LinkedWorkItemPort` data; Review opens a before/after; Save goes through the brief/spec save path, then marks seen; Dismiss marks seen
- [ ] T080 [P] [US9] Test `CORE_T/application/service/LinksServiceTest.java` (changes after seen_rev only; seen resets)

---

## Phase 12: Polish and cross-cutting

- [ ] T081 Add the board export records (`board`, `board-cycle`, `board-board`, `workitem-snapshot`; cards `boardId`, `relatedCycles`) in `FE/shared/utils/board-json.ts` and import in `BOARD/application/service/ImportBoardService.java` (no board records → default board; unknown types skipped), with tests in `board-json.spec.ts` and `ImportBoardServiceTest.java`
- [ ] T082 [P] Add work-item mention `@[workitem:<conn>/<id>|title]` to the mention parser/index in `BOARD` and render it through the existing `FE/components/board/mention-chip/` with the snapshot popup
- [ ] T083 [P] Update the remaining skills for boards: `skills/alfred-{listen,review,resume,status,report,verify,guide}/SKILL.md` and `skills/_shared/rules.md`; run `python -m pytest tests/python/test_alfred_skill.py`
- [ ] T084 [P] Update the docs:
  - `docs/board.md`: boards, relations, chat key, migration, aliases and fork path "remove later";
  - new `docs/team.md`;
  - `docs/architecture.md`: the teamboards family and its ArchUnit rules;
  - `docs/mcp.md`: the new tools;
  - `CLAUDE.md` and `AGENTS.md`: the new slice and its rules.
- [ ] T085 Run the full suites once: `cd backend && mvn test` (Docker JDK 21), `cd frontend && npm test && npm run build`, and the skills test; fix failures
- [ ] T086 Walk through quickstart.md §2–§5 on a scratch install with a copy of real data and a read-only Azure PAT; record measurements for SC-002, SC-005, SC-006, SC-006a and the plan's card-list target (< 300 ms for one board at 5,000 cards, own + related)

---

## Dependencies and order

- Setup (T001–T004) → Foundational (T005–T012) → stories.
- **US1** first. Then **US5** (needs US1's boards). **US2** and **US3** need US1. US3's MCP task (T044) needs US2's home move.
- **US4** needs Foundational only (chat key) and can run beside US2/US3.
- **US6** needs US2 (mentions/origin) and US1.
- **US7** needs Setup only. It can be built in parallel with US1–US6 by a second person, since it touches no board files.
- **US8** needs US1 + US3 (`board_open`, `board_record`) + US7.
- **US9** needs US8.
- Polish last.

## Parallel examples

- After T012: T019, T020, T021, T022 together (different files).
- US7: T053, T060, T062, T065, T066 in parallel once T054–T055 define the shapes.
- Polish: T082, T083, T084 together.

## Implementation strategy

1. **MVP** = Phases 1–4 (boards + migration): ship-ready on its own, with no Team tab.
2. Add US2 + US3 (shared cycles) → PR 1 with US4, US6 and the export/skills parts of Polish.
3. US7 → US8 → US9 → PR 2 (Team tab).
4. Per the token budget rule: work in the main session, at most one subagent at a time, for a fully specified chunk such as T059 + T060.
