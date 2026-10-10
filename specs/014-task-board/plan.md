# Implementation Plan: Task Board

**Branch**: `014-task-board` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/014-task-board/spec.md`; mocks [mock.html](mock.html), [mock-v2.html](mock-v2.html)

## Summary

A board of cards (Bug, Task, Note, Question) per project and per session cycle, with flags, statuses, an Inbox the user sorts in seconds (Fine / Not in this flow / To do, Triage mode, bulk, Undo), Markdown descriptions and comments with `@` mentions of calls, statements, log lines, Redis commands, spec files, code, cycles, spacers, cards and rules, a full activity history, a per-cycle brief with uploaded spec files and a hand-marked acceptance checklist, the board inside the session-cycle page, exports (.md/.html/.json, re-importable) and Claude access through new MCP tools with hard limits (Inbox only for new cards; moves only to To do / In progress / Fixed).

Technical approach: a new leaf slice `backend-board` (SQLite `board.db`, REST `/board`, WebSocket `/ws/board`), a bridge package `backend-app/boardbridge` for everything that touches other slices (kept calls, cycle deletion, call signatures, edit access), new Angular page + components using signals and `@angular/cdk/drag-drop`, client-side export builders following the existing export rules, and `mcp-server/src/tools/board.ts`.

## Technical Context

**Language/Version**: Java 21 (backend, Spring Boot 3), TypeScript 5.5 / Angular 18 (frontend, standalone + signals), TypeScript (Node) for `mcp-server/`
**Primary Dependencies**: Spring Web, Spring WebSocket, Spring JDBC, sqlite-jdbc (all already used); `@angular/cdk` drag-drop (already a dependency); `@modelcontextprotocol` SDK (already used). No new dependencies.
**Storage**: SQLite `board.db` (`BOARD_DB_FILE`, default `/appdata/board.db`; native install: data folder like other dbs)
**Testing**: JUnit 5 / Mockito / AssertJ, `@WebMvcTest`, ArchUnit (`backend-architecture-test`); Karma/Jasmine for pure utils and the few DOM-only behaviours; mcp-server test runner; shared vectors file for the mention and acceptance-item parsers
**Target Platform**: Docker install (gateway) and native install (Windows/Linux, `SpaPageFilter`)
**Project Type**: web application (backend reactor + Angular SPA + MCP server)
**Performance Goals**: board of 2,000 cards opens and filters < 1 s (SC-005); change visible in other tabs < 2 s (SC-004)
**Constraints**: no polling; list queries return summaries only; no `innerHTML` for user/Claude/call text; exports never truncated and never one string; every limit clamped server-side
**Scale/Scope**: thousands of cards per project, histories of tens to hundreds of entries, spec files ≤ 5 MB, ≤ 50 per cycle

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design (below).*

- [x] **I. Security**: request DTOs `@Valid` (title 1-300, texts ≤ 256 KB, spec ≤ 5 MB, names without path separators, enums); list `limit` 1-500, bulk ≤ 200, activity page ≤ 1000, badges ≤ 100 ids - all clamped. Writes go through the existing edit-access rule (R10; tunnel read-only). No secrets involved. Markdown and mentions render through a typed tree, never `innerHTML` (R7); links only `http(s):`. HTML export escapes every field via `html-builder.ts` helpers. Logs print card ids and sizes, never descriptions or spec text. Claude limits enforced in the service (R11).
- [x] **II. Performance**: nothing on the proxy path. `/ws/board` signal + fetch-on-demand, no timers (R9). `GET /board/cards` selects summary columns only, indexed `(project,status)`, `(cycle_id)`, `(signature)`, with `LIMIT`. Activity paged. Badges by indexed `mentions(cycle_id, call_id)`. Retention: kept until deleted, with per-item seatbelts (R17) - manual data, KB-sized. Kept-calls set read through the existing 5-minute `CommentedCallsKept.referenced()` cache, one indexed `SELECT DISTINCT call_id`. SC-005 measured with a seeded 2,000-card test.
- [x] **III. Architecture**: new leaf slice `backend-board` (domain.model / application.port.in|out / application.service / adapter.in.web / adapter.out.sqlite / adapter.out.websocket). No new cross-slice edge: board depends on no slice; `backend-app/boardbridge` wires it to session-cycles (new outbound `CycleRemovedPort` in session-cycles, R4), storage kept calls (R3), `CallRefResolver` + triage `EndpointPattern` (R12, via a small use case in backend-triage), and `EditAccessUseCase` (R10). SQLite only, justified in R2 (no legacy file to migrate; triage precedent). ArchUnit gets an isolation rule for `backend-board`. Frontend standalone + signals; Calls tab of the picker reuses `call-finder` logic; the cycle-detail page gains tabs rather than a forked page.
- [x] **IV. Style**: `*UseCase` per operation, `BoardService` implements them, `SqliteBoardRepository`, `BoardController`, `CycleBriefController`, `*RequestDto` records, constructor injection, outcome enums for refused operations (`CardChange.Outcome`: OK / NOT_FOUND / REFUSED_FOR_CLAUDE / ILLEGAL_TRANSITION / DUPLICATE_OF_CLOSED). TS strict, `inject()`, files in `components/`, `pages/`, `core/{models,services,state}`, `shared/utils`.
- [x] **V. Clean code**: reuse named - `CommentedCallsKept` (kept calls), `CallRefResolver` (call summaries), triage `EndpointPattern` (signatures), `reconnectingSocket`, `call-finder` query logic, `export-file-io.ts`, `html-builder.ts` escaping, `EditAccessUseCase`, action-menu for "Add to board". One mention parser per language, tested on one vectors file. No speculative options (no assignees, no card versions, no rich editor).
- [x] **VI. Verification**: service tests with fake ports (transitions, Claude limits, numbering, undo, signatures, checklist key stability); `SqliteBoardRepository` against `@TempDir` db (schema, cascade delete, summary query never selects description, 2,000-card timing); `@WebMvcTest` for both controllers (validation, clamping, 403/409); bridge tests (kept calls include board mentions; cycle delete cascade; access interceptor allows Docker mode, refuses tunnel); ArchUnit rule. Frontend: pure utils (`mention-syntax`, `quick-add-parser`, `markdown-blocks`, `acceptance-items`, `board-md-builder`, `board-html-builder`, `board-json` round-trip with large bodies, cycle export unchanged when boxes off) plus component tests only for picker keyboard flow and drag-drop status change. mcp-server tests for each tool's request and Claude-limit messages.
- [x] **Invariants**: exports untruncated, import fixtures built by the exporter; interception untouched; `/board` added to the gateway regex, `SpaPageFilter` prefixes and the `$spa_page` map (and `SpaPageFilterTest` passes); docs updated: CLAUDE.md (prefix list, board paragraph), AGENTS.md, docs/architecture.md (slice + edges), docs/frontend-architecture.md, docs/mcp.md (board tools), new docs/board.md.

**Post-design re-check (after Phase 1)**: still passes. Design added one outbound port to `backend-session-cycles` (`CycleRemovedPort`) and one small inbound use case to `backend-triage` (`NormalizeEndpointUseCase` exposing `EndpointPattern`) - both consumed only from `backend-app`, so no slice-to-slice edge. Spec FR-025 / SC-006 were aligned to R3 (kept calls instead of copies).

## Project Structure

### Documentation (this feature)

```text
specs/014-task-board/
├── spec.md, mock.html, mock-v2.html
├── plan.md              # this file
├── research.md          # R1-R18 decisions
├── data-model.md        # entities, transitions, schema
├── quickstart.md        # end-to-end check
├── contracts/
│   ├── rest-api.md
│   ├── websocket.md
│   ├── mcp-tools.md
│   └── mention-syntax.md
├── vectors/             # mentions.json, acceptance-items.json, quick-add.json (created in tasks)
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
backend/
├── pom.xml                                   # + <module>backend-board</module>
├── backend-board/                            # NEW leaf slice
│   └── src/main/java/com/fathy/alfred/backend/board/
│       ├── domain/model/                     # Card, CardSummary, CardDetail, ActivityEntry, Mention, MentionRef,
│       │                                     # CycleBrief, SpecFile, ChecklistItem, ChecklistMark, AgentStatus, enums,
│       │                                     # CardQuery, CardChange (outcome; per-field updates, no version)
│       ├── domain/                           # MentionParser, QuickAddParser, AcceptanceItems, Transitions, ClaudeRules
│       ├── application/port/in/              # CreateCard, QuickAddCard, UpdateCard, MoveCard, CloseCard, ReopenCard,
│       │                                     # SetReason, UndoClose, LinkCard, CommentOnCard, DeleteCard, BulkCards,
│       │                                     # QueryCards, GetCard, ListActivity, ListClosedReasons, ManageBrief,
│       │                                     # ManageSpecFiles, MarkChecklist, CallBadges, AgentStatus,
│       │                                     # ListMentionedCallIds, CycleRemoved, ImportBoard  (*UseCase)
│       ├── application/port/out/             # BoardStorePort, BoardNotificationPort, CallSignaturePort, MentionedCallsChangedPort
│       ├── application/service/              # BoardService, CycleBriefService, AgentStatusService
│       ├── adapter/in/web/                   # BoardController, CycleBriefController, BoardImportController, dto/*RequestDto
│       ├── adapter/out/sqlite/               # SqliteBoardRepository
│       └── adapter/out/websocket/            # BoardWebSocketConfig, BoardEventsWebSocketHandler, WebSocketBoardNotificationAdapter
├── backend-session-cycles/                   # + application/port/out/CycleRemovedPort (no-op default bean), called on delete
├── backend-triage/                           # + application/port/in/NormalizeEndpointUseCase (wraps EndpointPattern)
├── backend-app/src/main/java/.../boardbridge/   # NEW: BoardCycleRemovedAdapter, BoardCallSignatureAdapter, BoardMentionsKeptRefresher,
│                                             # BoardEditAccessInterceptor (+ WebMvc config)
├── backend-app/.../storage/CommentedCallsKept.java   # referenced() += board ListMentionedCallIdsUseCase
├── backend-app/.../web/SpaPageFilter.java    # + "board" prefix and /board SPA page
└── backend-architecture-test/                # + backend-board dep and isolation rule

gateway/nginx.conf                            # + board in prefix regex and $spa_page map

frontend/src/app/
├── app.routes.ts                             # + { path: 'board', ... }   (+ tab in the nav)
├── core/models/board.models.ts
├── core/services/board-api.service.ts, board-socket.service.ts
├── core/state/board-state.service.ts         # signals: cards, filters, view, selection, undo
├── pages/board/board-page.component.*        # top-level tab: project/cycle switch, quick add, filters, progress, live strip
├── components/board/
│   ├── board-columns, board-card, board-list-view, quick-add, bulk-bar, triage-dialog, live-strip, board-progress
│   ├── card-drawer (status/kind/scope/flags, description, linked, activity, composer)
│   ├── mention-editor (textarea + @ → mention-picker), mention-picker, mention-text (chips + hover preview)
│   ├── cycle-brief, spec-files, spec-viewer, acceptance-checklist
│   └── call-board-badge
├── pages/session-cycle-detail/               # + Calls | Board | Brief & specs tabs, badges, open-card count
├── components/action-menu (call menu)        # + "Add to board" (cycle page and Live Calls)
└── shared/utils/
    ├── mention-syntax.ts, quick-add-parser.ts, markdown-blocks.ts, acceptance-items.ts
    ├── board-md-builder.ts, board-html-builder.ts, board-json.ts (export + import)
    └── existing cycle export builders: + optional brief/specs and cards sections

mcp-server/src/tools/board.ts                 # board_* tools, get_brief, read_spec  (+ registration, prompts.ts paragraph)

docs/board.md (new), CLAUDE.md, AGENTS.md, docs/architecture.md, docs/frontend-architecture.md, docs/mcp.md
```

**Structure Decision**: web application layout already in the repo (backend reactor + `frontend/` + `mcp-server/`). One new backend module, one new bridge package, two small additions to existing slices (ports only), new frontend page/components/utils, one new MCP tools file.

## Build order (for /speckit-tasks)

1. Backend slice: domain + parsers (vectors) → store → services (transitions, Claude rules, undo, bulk, numbering) → controllers → WebSocket → ArchUnit rule.
2. Bridge: edit access, kept calls, cycle removed, call signatures; gateway + `SpaPageFilter`.
3. Frontend P1: models/api/socket/state → board page (columns, cards, drag, quick add, filters, list view, progress, stale) → Inbox actions, Undo toast, Triage dialog, bulk bar, keyboard.
4. Frontend P2: mention editor/picker/chips + markdown blocks → card drawer + activity → cycle brief, spec files, viewer, checklist → cycle page tabs, badges, open-card count, "Add to board".
5. MCP tools + live strip.
6. Exports + import + cycle export checkboxes.
7. Docs, full suites (`mvn test`, `npm test`, `npm run build`, mcp-server tests), quickstart walk-through.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| No file-store fallback for `backend-board` | New slice with no legacy flat file | A JSON file adapter would need whole-file rewrites per edit (constitution II) and serves no existing install |
| Two small additions to other slices (`CycleRemovedPort` in session-cycles, `NormalizeEndpointUseCase` in triage) | Board must react to cycle deletion and reuse the one endpoint normalizer | Lazy existence checks leave orphan spec files; a second normalizer would duplicate `EndpointPattern` |
