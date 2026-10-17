# Research: Boards rework and Team tab

Facts below were read from the code on 2026-10-17 (branch `027-boards-and-team`). Each decision lists what was chosen, why, and what was rejected.

## Findings from the current code

- `backend-board` keeps everything in `board.db`. About 20 tables are keyed by `cycle_id`: `cycle_briefs`, `spec_files`, `checklist_marks`, `checklist_suggestions`, `card_spec_items`, `cycle_log`, `cycle_steps`, `item_evidence`, `item_call_results`, `item_cards`, `brief_comments`, `skill_runs`, `board_images`, `board_files`, `snippets`, `asks`, and the chat tables `chat_messages`, `chat_settings`, `chat_sessions`, `chat_terminal_items`, `chat_watches`.
- The project chat is the chat whose `cycle_id` is `''` (`ChatKey.PROJECT_SCOPE = "project"` maps to `""`).
- `cards` has `project`, `number` (unique per project), `cycle_id` (0..1) and `cycle_deleted`. `mentions.cycle_id` names the cycle of a mentioned captured call. That one is about calls, not tasks, and stays.
- `backend-session-cycles` stores `session_cycles(id, name, created_at, assigned_to, status)` with `status` RECORDING or PAUSED. **A cycle has no project.** Every RECORDING cycle receives a copy of every new call (the recording fan-out), so several cycles can record at once today.
- Cycle deletion reaches the board through `backend-app/boardbridge/BoardCycleRemovedAdapter` → `CycleRemovedUseCase`. Captured calls can be copied between cycles with `copyInto` / `CopyInternalCallsToCycleUseCase`.
- `boardbridge` already holds `BoardCycleCallsAdapter`, `BoardCycleNamesAdapter`, `BoardEditAccess` (+ interceptor) and `BoardRetestWatchAdapter`.
- MCP tools are TypeScript in `mcp-server/src/tools/` (`board.ts`, `task.ts`, `chat.ts`, `cycles.ts`, `requirements.ts`, …). Skills live in `skills/alfred-*/SKILL.md`, and `tests/python/test_alfred_skill.py` checks that every tool they name exists.
- Frontend board code lives in `components/board/*` and `pages/board`, `pages/session-cycles-list`, `pages/session-cycle-detail` and `pages/chat-window`. `npm test` has a `pretest` node script hook.
- `backend/` is a flat reactor: every slice is one module at the top level. No slice has submodules yet.

## Decisions

### R1. The migrated board keeps the cycle's id

- **Decision**: A cycle that had a brief becomes a board whose id **equals the old cycle id**. Each project's default board gets the id `default:<project>`. New boards get a UUID.
- **Rationale**: Every task table is keyed by `cycle_id`. If the board id equals the cycle id, none of those rows move: the key column is only renamed to `board_id` (SQLite `ALTER TABLE … RENAME COLUMN`, available since 3.25). The project chat (`cycle_id = ''`) and cards without a briefed cycle are the only rows rewritten, to `default:<project>`. Migration becomes a few `UPDATE`s, not a data copy, and is safe to re-run.
- **Alternatives rejected**: New UUIDs plus a copy of every row: a slow, error-prone copy of chat and requirement history. Keeping the column named `cycle_id`: it would lie about its meaning forever.

**Implementation amendment (2026-10-17, start of implementation)**: a count showed about 2,600 `cycleId` / `cycle_id` references in the task code paths:

| Where | References |
|---|---|
| Board slice SQL | 204 |
| Board slice Java | 1,006 |
| backend-app | 87 |
| Frontend | 1,275 |
| mcp-server | 312 |

Renaming them all would be a large, risky change that adds no behaviour. So the task tables and the existing task APIs **keep the name `cycleId` for the task key, and its value is the board id**. For migrated boards that value is unchanged (R1). The project chat keeps its key `''`, which now means "the project's default board" (`ChatKey` maps `default:<project>` ⇄ `''`). New code (boards, relations, card homes) says `boardId`. The places that used the task key **as a cycle** (to read its calls through `CycleCallsPort`) now read the calls of every cycle related to the board (`BoardCycles`). `cards.cycle_id` keeps meaning the origin cycle, and a new `cards.board_id` holds the home. The full rename stays possible later, one layer at a time.

### R2. Where boards and relations live

- **Decision**: `boards`, `board_cycles` and `board_boards` tables in `board.db`, owned by `backend-board`. Cycles stay in `backend-session-cycles`, unchanged except as listed in R3.
- **Rationale**: The board slice already owns everything a task holds. `backend-board` must not depend on `backend-session-cycles` (leaf slice rule), so it stores cycle ids as plain strings, as it does today, and reads cycle names, status and calls through the existing `boardbridge` ports.
- **Alternatives rejected**: A relation table in `session-cycles.db`: board logic would leak into the cycle slice, and a cycle would need to know about boards.

### R3. "One recording per project" without giving cycles a project

- **Decision**: Cycles stay project-less. A cycle's projects are the projects of its related boards. The rule is checked on **every** start or resume, wherever it comes from:
  - a board's Record;
  - the Session Cycles tab;
  - MCP `start_recording`.

  `backend-session-cycles` gets an out-port, `RecordingGuardPort` (no-op default). `boardbridge` implements it: before a start or resume, it finds RECORDING cycles that share a project with this cycle. The start then returns `409 RECORDING_CONFLICT {running}` unless the request says `onRunning=JOIN|PAUSE_OTHER`. From a board, the user chooses to join or start a new one; from the Session Cycles tab, to pause the other. A cycle related to no board has no project and is never blocked. A new port, `CycleControlPort` (start, pause, create, names), is implemented in `boardbridge` against the session-cycles use cases.
- **Rationale**: The recording fan-out stores every call in every RECORDING cycle. Adding a project to cycles would change capture, Relive and export for no gain: verdicts already filter calls by the board's endpoints.
- **Alternatives rejected**: A `project` column on `session_cycles`: touches capture and the export format, and a recording legitimately catches calls of several projects.

### R4. Judging calls per board

- **Decision**: `RequirementService` judges each captured or live call for **every Open board** whose Acceptance items name its endpoint: boards related to the call's cycle, plus every Open board of the call's project for live calls. Verdicts go into `item_call_results` keyed by `board_id`. Archived and Done boards are skipped.
- **Rationale**: This is today's per-cycle judging with the key renamed, and it answers clarification Q3. Lookup goes through an index on `(project, state)` of `boards` plus the existing item index, so a call costs one indexed read per board.
- **Alternatives rejected**: Judging only inside recording cycles: rejected by the user.

### R5. One listen per cycle, smart home

- **Decision**: `check_calls` / `/alfred-listen` take a cycle and judge it once. For each finding:
  1. The existing `board_similar` / signature match across **all boards related to the cycle** runs first. A match adds evidence to that card.
  2. Otherwise the home is the one board whose items name the finding's endpoint.
  3. With several such boards, the listen posts a `board_ask` with one option per board to the chat of the board it was started for, and waits.
  4. With none, the home is the board the listen was started for. A listen started from Session Cycles has no such board, so the cycle's only related board is used, else the first default board among its boards.
- **Rationale**: Reuses the signature dedupe (`cards.signature`), `board_ask` and the chat. Nothing new decides where a card goes.
- **Alternatives rejected**: One listen per board: two Claude runs reading the same calls, and duplicates.

### R6. Board chat runner

- **Decision**: Chat keys become `(project, board_id)`. The terminal binding that today follows a cycle (`chat_sessions`, the `/alfred-live` heartbeat `cycleId`) follows a board id. The old fork path stays and carries a `// REMOVE-LATER(027)` comment plus a line in docs/board.md.
- **Rationale**: Same mechanism, new key (FR-015, FR-016).

### R7. Cycle delete with rescue

- **Decision**: `BoardCycleRemovedAdapter` grows a *before delete* step. The session-cycles delete asks the board slice (through a new `CycleDeletePlanPort`) which call ids each board's cards mention. It copies those calls into one new cycle per board with `copyInto` / `CopyInternalCallsToCycleUseCase`, relates each to its board, rewrites the board mentions to the new cycle, and then deletes the old cycle. Statements, Redis commands and log lines are keyed by the live inbound call id, so the copies keep reaching them. Only a call that **no cycle and no live store** still holds loses them, through the existing `CallDeletionCascade`.
- **Keeping the data alive**: a live call that a card mentions is already kept out of the storage limits (`CommentedCallsKept.BoardMentions`). The rewritten mentions point at the kept cycle's copy, so the protection must also follow the copy back to its live inbound call id. `BoardMentions` is extended to return the live call ids of mentioned captured calls. That keeps the live call, its statements, Redis commands and log lines for as long as any card mentions the copy (FR-017).
- **Rationale**: Reuses the copy, cascade and kept-calls paths that exist. The dialog's numbers come from the same plan call (dry run).
- **To verify in tasks**: with a real `db-capture.db`, statements are reached after a copy, and storage-limit eviction skips the live call while a card mentions the kept copy.

### R8. Team connector module shape

- **Decision**: `backend/backend-teamboards/` is a Maven parent (packaging `pom`) with three modules:
  - `teamboards-spi`: the neutral model records and connector interfaces. No Spring. Jackson annotations are allowed.
  - `teamboards-core`: services, ports, REST `/teamboards/**`, SQLite `teamboards.db`. Depends on `-spi`.
  - `teamboards-azure`: the Azure DevOps connector. Depends on `-spi` only, and is a Spring `@Component` picked up by `backend-app`.

  Core finds connectors as a `List<Connector>` bean. ArchUnit checks that core never imports `..teamboards.azure..` and that connectors never import `..teamboards.core..`.
- **Rationale**: This is what the user asked for: one module per provider under a common contract. Adding `teamboards-jira` later means one new module and one dependency line in `backend-app`.
- **Alternatives rejected**: One flat slice with connector packages: the boundary would rest on ArchUnit alone, and the user explicitly asked for modules. Runtime plugin jars (ServiceLoader): no need to add connectors without rebuilding.

### R9. Capabilities

- **Decision**: Base `Connector` interface: `kind()`, `capabilities()`, `items(changedSince)`, `item(id)`, `types()`, `people()`. Optional interfaces a connector may also implement: `BoardsReader`, `SprintsReader`, `SquadsReader`, `RevisionsReader`, `AttachmentsReader` and `SeedContributor`. Core derives `capabilities()` from `instanceof` checks, so a declared capability can never lie. The REST API returns the list for the UI to gate views.
- **Rationale**: Illegal states (a capability declared without its method) become unrepresentable.

### R10. Azure DevOps REST calls

- **Decision**: Use JDK `java.net.http.HttpClient`, with no new dependency, against REST API version 7.1:
  - **Changed items**: WIQL query `System.ChangedDate > @last` per chosen project and team, then `workitemsbatch` (200 ids per call, `$expand=relations`).
  - **Revisions on open**: `wit/workItems/{id}/revisions`.
  - **Teams and members**: `projects/{p}/teams`, `teams/{t}/members`.
  - **Sprints**: `work/teamsettings/iterations`.
  - **Boards**: `work/boards`.
  - **Types**: `wit/workitemtypes` (custom types included).

  Basic auth uses an empty user with the PAT. A 429 or `Retry-After` header is honoured once, then reported. A 401 or 403 becomes `TOKEN_REJECTED`.
- **Rationale**: Incremental fetch meets the clarified scale (20,000 items, Refresh of 50 changes under 10 s).

### R11. The personal token

- **Decision**: The frontend keeps the PAT per connection in `localStorage` (try/catch) and sends it as the header `X-Alfred-Team-Token` only on `/teamboards/**` requests. Core passes it to the connector as a method argument and never stores it in a field. A servlet filter strips the header from every request log, and a test asserts that no file, row or log line contains a sample token (SC-007). Requests without a token are served from the cache; Refresh without one returns `TOKEN_MISSING`.
- **Rationale**: FR-027 / clarification. The tunnel is HTTPS, so the header is safe in transit.
- **Constitution**: Principle I says secrets come from environment/config, never from source, logs, commits or fixtures. A per-user token typed into the browser is none of those, but it is not from env/config either. It is recorded in plan.md's Complexity Tracking. Test fixtures for the Azure connector carry a fake token and a fake org.
- **Alternatives rejected**: Storing the token encrypted in Alfred: it would need a key and identity Alfred does not have.

### R12. Team cache storage

- **Decision**: New `teamboards.db` (SQLite only; the file fallback is not built: see Complexity Tracking).
  - **Items**: list columns sit beside `native_json`. Lists never select `native_json` or field values.
  - **Search**: FTS5 over title and id.
  - **Retention**: a share of the storage budget, through the same `backend-app/storage` ratio as other stores. Revisions are evicted oldest first; items in `board_links` are kept.
- **Rationale**: Principle II (summaries, windowed SQL, retention defined).

### R13. Opening a board from a work item

- **Decision**: `POST /teamboards/items/{conn}/{id}/start` resolves the mapping and posts a WAITING chat message `/alfred-setup <conn>/<id>` to the target board's chat, through a `teamboardsbridge` in `backend-app` that calls the board slice's `ChatUseCase`. `/alfred-setup` reads the item's seed through a new MCP tool, `team_item`, with fields already mapped. It creates the board, the cycle and the relations with the new board MCP tools, then records the link with `team_link`. The board's linked item and the "Azure changed" state are read by `backend-board` through a new out-port `LinkedWorkItemPort`, implemented in the bridge.
- **Rationale**: Keeps both slices leaves. The chat runner path already exists.

### R13a. Checking that the user asked before Claude opens a board

- **Decision**: `POST /board/boards` from `X-Alfred-Actor: claude` requires `askedIn`. It is either:
  - a chat message id: the backend checks that it exists, its author is the user, it is on a board chat, and it is under 30 minutes old;
  - `"terminal"`: accepted but recorded in `board_activity` as "opened at your request in the terminal", so the user sees and can delete it.

  Anything else gives `403 NOT_ASKED`.
- **Rationale**: A header Claude sets itself proves nothing. A real message id can be checked, and the terminal case cannot be checked, so it is made visible instead.
- **Alternatives rejected**: A one-time consent token from the UI: the terminal path has no UI.

### R14. Frontend layout

- **Decision**:
  - **Core UI**: components in `frontend/src/app/components/team/`.
  - **Pages**: `pages/team/`.
  - **Models, services and the `TEAM_CONNECTORS` multi-provider token**: `core/team/`.
  - **Each connector**: its own folder, `components/team/connectors/azure/`, with an `index.ts` that exports its `ConnectorUi` provider.

  A `pretest` script, `scripts/check-team-boundaries.mjs`, fails if any file outside `connectors/` imports from it. The board picker, related strip and shared-cycle calls view extend the existing `board-view`, `task-view` and `session-cycles-list`, never fork them.
- **Rationale**: Follows the existing `components/pages/core/shared` layout (Principle IV) while giving each connector its own module, as asked.

### R15. Exports and compatibility

- **Decision**: Board JSON export (`board-json.ts` / `ImportBoardService`) adds record types `board`, `board-cycle`, `board-board` and `workitem-snapshot`. An import with no `board` record maps every card to `default:<project>`. No enum gains a value; card state and status are unchanged. Older importers skip unknown record types; test that.

### R16. Board state

- **Decision**: `boards.state` is OPEN, DONE or ARCHIVED, a new enum in a new table that older Alfreds never read. Archived and Done boards are skipped by judging and by finding homes; Archived boards are hidden from the picker unless "Show archived" is on.
