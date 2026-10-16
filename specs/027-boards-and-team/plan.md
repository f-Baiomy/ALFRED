# Implementation Plan: Boards rework and Team tab

**Branch**: `027-boards-and-team` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md) | **Mock**: [mock.html](mock.html)
**Input**: Feature specification from `specs/027-boards-and-team/spec.md`

## Summary

Make the **board the task** and the **cycle a store of calls**, many-to-many across projects. Then add a **Team tab** that reads the team's tracker (Azure DevOps first) through a provider-neutral connector contract, and opens Alfred boards from work items.

Approach:

- **Boards rework**: stays inside `backend-board`. New `boards` / `board_cycles` / `board_boards` / `card_cycles` / `board_activity` tables. The ~20 task tables keyed by `cycle_id` are only renamed to `board_id`, because a migrated board keeps its old cycle's id (research R1). Cycles stay project-less in `backend-session-cycles`; the board side applies the one-recording-per-project rule through a new bridge port.
- **Team**: a new Maven parent `backend-teamboards` with `teamboards-spi`, `teamboards-core` (own `teamboards.db`) and `teamboards-azure`.
  - **Bridge**: `backend-app/teamboardsbridge` wires Start → board chat and links → board.
  - **Frontend**: Team UI core in `components/team`, with each connector in `components/team/connectors/<kind>`, registered through a `TEAM_CONNECTORS` DI token.

## Technical Context

**Language/Version**:
- Java 21 (backend, Spring Boot multi-module Maven).
- TypeScript strict, Angular standalone + signals (frontend).
- TypeScript (mcp-server).
- Markdown skills.

**Primary Dependencies**: existing only. JDK `java.net.http.HttpClient` for Azure DevOps REST 7.1, no new library.
**Storage**:
- SQLite `board.db` (schema migration).
- New SQLite `teamboards.db`.
- `session-cycles.db` unchanged in schema.
- Browser `localStorage` for the PAT only.

**Testing**:
- Backend: JUnit 5 / Mockito / AssertJ + ArchUnit.
- Frontend: Karma/Jasmine.
- Python: `pytest` for the skills test.
- Azure: recorded JSON fixtures for the connector.

**Target Platform**: Docker install and native install (Windows/Linux).
**Project Type**: web app (backend + frontend + MCP server + skills).
**Performance Goals**:
- Card list for one board, own + related: < 300 ms at 5,000 cards.
- Judging: one indexed lookup per Open board per call.
- Team list/search: < 1 s at 20,000 items.
- Refresh of 50 changes: < 10 s.
- Item history: < 3 s at 100 revisions.

**Constraints**:
- No polling (WebSocket signals).
- The PAT is never persisted.
- Exports never truncate.
- Older Alfreds still read exports.
- Leaf-slice isolation.

**Scale/Scope**:
- Tens of boards per project.
- Hundreds of cycles.
- 20,000 cached items per connection.
- ~10 skills and ~15 MCP tools touched.

## Constitution Check

*Gate before research: passed with the violations recorded below. Re-checked after design: passed.*

- [x] **I. Security**:
  - New DTOs are `@Valid`: board name 1..120, connection URL https or localhost, scope ≤ 50 projects and 200 teams, field-map lengths.
  - Every list `limit` is clamped (`alfred.board.max-limit`, `alfred.teamboards.max-limit` = 200).
  - Claude can open a board only by naming the user's asking message, which the backend checks, or "terminal", which is recorded (R13a).
  - The PAT lives in the browser and travels as a header (justified in Complexity Tracking). A servlet filter keeps it out of every log, `Token.toString()` is masked, and it is never stored (test `TeamTokenNeverStoredTest`, SC-007).
  - Work-item fields are third-party HTML and render as text or through the existing sanitising markdown view, never through `bypassSecurityTrust`.
  - Exports escape as today.
  - `ProviderException` messages never carry bodies or tokens.

- [x] **II. Performance**:
  - **Proxy path**: untouched.
  - **No polling**: `/ws/board` and `/ws/teamboards` change signals only. The Team fetch is on demand.
  - **Summary lists**: cards are fetched without descriptions; items without fields or `native_json`.
  - **Indexed, windowed SQL** (data-model: `idx_boards_project_state`, `idx_board_cycles_cycle`, `idx_card_cycles_cycle`, `idx_items_list`, FTS5) with `LIMIT`.
  - **Streaming**: the Azure first fetch streams page by page into SQLite and never builds the whole set in memory.
  - **Retention** (data-model.md "Retention"):
    - `teamboards.db` takes a storage-budget share. Eviction removes old `changes` rows (90 days / 50,000 rows), then revisions oldest first, then unlinked items; linked items are kept.
    - `board_activity` is capped per board (2,000 rows).
    - The other new board tables are bounded by boards and cards, which the user deletes. Same as today's cards, documented.
    - Rescued (kept-cycle) calls stay out of the storage limits while mentioned (R7).

- [x] **III. Architecture**:
  - **Boards** stay in `backend-board`.
  - **Team** is a new slice family `backend-teamboards`, depending on no other slice.
  - **Bridges** in `backend-app`:
    - `boardbridge` gets `CycleControlPort`, `CycleDeletePlanPort` and `BoardCycleCallsAdapter` per board;
    - `teamboardsbridge` covers Start → `ChatUseCase`, `LinkedWorkItemPort` and storage share.
  - **No new cross-slice edge.**
  - **Connectors**: the spi → core → azure edges are **inside one slice family**, enforced by ArchUnit (connector ↛ core, core ↛ connector, teamboards ↛ any other slice).
  - **Storage**: SQLite is the default; no file fallback for `teamboards.db` (see Complexity Tracking).
  - **Frontend**: standalone + signals. The Board tab extends `board-view`, `task-view`, `session-cycles-list` and `chat-window`; connectors arrive through the `TEAM_CONNECTORS` multi-provider token.

- [x] **IV. Style**:
  - **Use cases**: one per operation (`ManageBoardsUseCase`, `RelateCycleUseCase`, `MoveCardHomeUseCase`, `RecordForBoardUseCase`, `TeamRefreshUseCase`, `StartFromItemUseCase`, …).
  - **Adapters**: `Sqlite*Repository`; records; outcome enums (`BoardOutcome`, `StartOutcome`, `RefreshOutcome`).
  - **Wiring**: constructor injection.
  - **Frontend**: `inject()`, signals, existing folders.

- [x] **V. Clean code**: existing logic is reused, by name:
  - **Card signatures and dedupe**: `cards.signature` / `board_similar` (finding homes).
  - **Chat**: the WAITING → TAKEN chat (Start).
  - **Copy and delete**: `copyInto` / `CopyInternalCallsToCycleUseCase` and `CallDeletionCascade` (rescue on delete).
  - **Judging**: `RequirementService` (per-board judging).
  - **Edit access**: `BoardEditAccess` (access).
  - **Frontend components**: `MentionChip` (work-item chip), the call popup and spec viewer (memory "reuse existing components"), `layoutSpacers`.
  - **Scope**: no write-back or webhooks (YAGNI).

- [x] **VI. Verification**:
  - **Services**: tested against fake ports.
  - **SQLite**: on `@TempDir`.
  - **Controllers**: thin `@WebMvcTest`.
  - **Migration**: tested on a fixture written by the current repository code.
  - **Azure connector**: tested on recorded responses.
  - **Architecture**: the ArchUnit isolation rules pass.
  - **Frontend**: pure utils (`board-cards-visibility.ts`, `cycle-verdicts.ts`, `seed-from-item.ts`) are tested directly.
  - **Skills**: the skills test passes.
  - **Full suites**: run once at the end.

- [x] **Invariants**:
  - Exports stay untruncated, with new records added.
  - Interception is untouched.
  - The gateway regex and `SpaPageFilter` get `teamboards`; the `/team` SPA page does not collide with any prefix.
  - Docs are updated: `docs/board.md` (boards, chat key, migration, fork-path removal note), new `docs/team.md`, `docs/architecture.md` (teamboards family), `docs/mcp.md`, CLAUDE.md and AGENTS.md entries.

## Project Structure

### Documentation (this feature)

```text
specs/027-boards-and-team/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  mock.html
├── contracts/ board-rest.md  teamboards-rest.md  connector-spi.md  mcp-and-export.md
├── checklists/requirements.md
└── tasks.md            # /speckit.tasks
```

### Source Code

```text
backend/
├── backend-board/                                   # boards rework (existing slice)
│   └── src/main/java/.../board/
│       ├── domain/model/{Board,BoardState,BoardActivity,BoardRelations}.java      (new)
│       ├── application/port/in/{ManageBoardsUseCase,RelateCycleUseCase,MoveCardHomeUseCase,
│       │                        RecordForBoardUseCase,CycleVerdictsUseCase,CycleDeletePlanUseCase}.java   (new)
│       ├── application/port/out/{CycleControlPort,LinkedWorkItemPort,BoardDeletedPort}.java (new)
│       ├── application/service/{BoardsService,BoardRelationsService,ListenHomeResolver}.java (new)
│       ├── application/service/{RequirementService,ChatService,BoardService,CycleBriefService,…} (key cycle→board)
│       ├── adapter/in/web/BoardsController.java                                   (new) + existing controllers re-keyed, old paths aliased
│       └── adapter/out/sqlite/{SqliteBoardRepository,…}.java + BoardModelMigration.java (new)
├── backend-session-cycles/                          # unchanged schema; delete asks the board for a plan first;
│                                                    #   new out-port application/port/out/RecordingGuardPort.java (no-op default)
├── backend-teamboards/                              # NEW parent (pom)
│   ├── teamboards-spi/      .../teamboards/spi/{Connector,*Reader,SeedContributor,ProviderException,model/*}.java
│   ├── teamboards-core/     .../teamboards/{domain,application/port/{in,out},application/service,
│   │                         adapter/in/web,adapter/out/sqlite}/…   (teamboards.db, /teamboards/**, /ws/teamboards)
│   └── teamboards-azure/    .../teamboards/azure/{AzureDevOpsConnector,AzureClient,AzureMapper}.java
├── backend-app/
│   ├── boardbridge/{BoardCycleControlAdapter,BoardCycleDeletePlanAdapter,BoardRecordingGuardAdapter,…}.java
│   ├── teamboardsbridge/{TeamStartToChatAdapter,LinkedWorkItemAdapter,TeamTokenLogFilter}.java (new)
│   └── web/SpaPageFilter.java (+ teamboards prefix)
└── backend-architecture-test/  HexagonalArchitectureTest (+ teamboards rules)

frontend/src/app/
├── components/board/{board-picker,related-strip,cycle-verdicts-dialog,record-dialog,…}/  (new, used by board-view/task-view)
├── components/team/{team-tab,items-table,item-drawer,boards-sprints,squads,changes-feed,start-button,connection-settings}/
├── components/team/connectors/azure/{index.ts,azure-settings.component.ts,azure-field-renderer.component.ts}
├── core/team/{connector-ui.ts,team-api.service.ts,team-token.store.ts,team.models.ts}
├── core/models/board.models.ts (+ Board, relations), core/services/board-api.service.ts (+ boards routes)
├── pages/team/team-page.component.ts, pages/session-cycles-list (grouped by board)
└── shared/utils/{board-cards-visibility,cycle-verdicts,seed-from-item}.ts (+ specs)
frontend/scripts/check-team-boundaries.mjs (pretest)

mcp-server/src/tools/{board.ts,task.ts,check.ts,cycles.ts,team.ts (new)}
skills/alfred-{setup,live,listen,review,resume,status,report,verify,guide}/SKILL.md, skills/_shared/rules.md
gateway/nginx.conf (+ teamboards)
docs/{board.md,team.md (new),architecture.md,mcp.md}, CLAUDE.md, AGENTS.md
```

**Structure Decision**: The existing web-app layout (backend reactor + Angular + mcp-server + skills). One new backend parent module with three submodules for the connector family. Everything else extends existing modules and folders.

## Delivery phases (for /speckit.tasks)

1. **Boards foundation (US1, US5)**: schema, migration, `Board` domain, `BoardsService`, re-keying of task tables, aliases, picker and related strip, Session Cycles grouped by board.
2. **Cards and shared cycles (US2, US3)**:
   - home and related cycles, visibility query;
   - per-board judging;
   - verdicts view;
   - record join-or-new;
   - listen homes (MCP `check_calls`, `board_add`).
3. **Board chat (US4)**: chat key → board, live runner binding, Undo on board activity, fork path kept with a note.
4. **Cycle delete rescue (US6)**: delete plan, copy into kept cycles, dialog.
5. **Exports, MCP and skills**: new records, optional `board` param, new tools, every skill updated, skills test.
6. **Team core (US7)**:
   - SPI;
   - core with cache, REST and WebSocket;
   - Azure connector;
   - token handling;
   - gateway;
   - Team tab views and settings;
   - storage share.
7. **Open from work item (US8, US9)**: Start → chat, mappings and the unmapped dialog, seed through `team_item`, `team_link`, Open task menu, chat "open a board for", Claude suggestion on Refresh, "Azure changed" review.
8. **Docs and full suites.**

Phases 1–5 ship together as the boards rework; phases 6–7 can follow in a second PR. The mock covers both.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| First slice with submodules (`backend-teamboards` parent + 3 modules) | The user requires one module per provider under one shared contract, for backend and frontend alike (FR-022, SC-008) | One flat slice with connector packages: boundaries would rely on ArchUnit alone, and adding Jira would touch the core module |
| No file-store fallback for `teamboards.db` | It is a cache of a remote source; losing it costs one Refresh. The file opt-out exists for system-of-record stores | Writing a JSON-file adapter for a disposable cache doubles the storage work with no user benefit |
| Old `/board/cycles/{id}/…` routes kept as aliases | Installed skills and MCP clients call them; the migrated board id equals the cycle id, so the aliases are near-free | Breaking them would strand every installed skill until `alfred skill install` runs. The aliases are removed in a later release (noted in docs) |
| Team PAT comes from the user's browser, not from env/config (Principle I) | Each person reads the tracker with their own rights (FR-027); Alfred has no user identity to keep per-user secrets server-side | One shared PAT in `.env`: rejected by the user in the grilling session (everyone would see through one person's rights). Mitigations: never stored or logged, masked `Token`, `TeamTokenNeverStoredTest`, fixtures carry fake tokens |
| Old chat fork path kept | User decision (FR-016): older runners keep working | Removing now would break older runners without notice |
