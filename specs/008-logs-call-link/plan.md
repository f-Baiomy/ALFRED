# Implementation Plan: Logs linked to calls

**Branch**: `008-logs-call-link` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md) | **Mock**: [mock.html](mock.html)
**Input**: Feature specification from `specs/008-logs-call-link/spec.md`

## Summary

Join the application's log lines (loaded in the Logs tab) to the inbound calls they were written during - shown
in the database window (Logs / Together views, a Logs lane), on call cards, in the Logs tab (line → call), in
exports and to Claude. Two ways to link: **same thread and time** (request thread recorded by the db-agent, call
window from the calls slices, ± a clock difference) for logs that exist today, and **exact** - the db-agent puts
the call id into the application's logging MDC (`alfred.call`) for every recorded inbound call when the project
turns it on. The join lives in one composition-root bridge (`backend-app/calllogsbridge`, new `/call-logs`
routes); `backend-logs` gains project log settings and kept lines for session-cycle calls; `backend-db-capture`
gains the request thread and the `logTagging` agent setting.

## Technical Context

**Language/Version**: Java 21 (backend), Java 8 (db-agent), TypeScript/Angular 20 (frontend), TypeScript/Node (mcp-server)
**Primary Dependencies**: Spring Boot 3, ByteBuddy (agent, existing), Angular standalone + signals; no new dependencies
**Storage**: SQLite - `logs.db` (new tables `project_logs`, `kept_lines`), `db-capture.db` (new column `call_db_summary.request_thread` + index)
**Testing**: JUnit5/Mockito/AssertJ + ArchUnit; agent ITs on JDK 8 and 21 (fake MDC classes outside the agent package, like `org.example.jta`); Karma/Jasmine; mcp-server vitest
**Target Platform**: Docker (backend, frontend, gateway); the db-agent inside odeysys WildFly
**Project Type**: web application (multi-module backend + Angular frontend) + Java agent
**Performance Goals**: a call's lines shown < 2 s (SC-001); agent tagging < 1 ms/request (SC-004); one indexed query per call per source
**Constraints**: no polling; exports never truncate; agent never changes app behaviour; limits clamped (≤500 lines/page, ≤100 ids/count request)
**Scale/Scope**: log sources up to millions of lines; calls with thousands of lines (paged); WildFly log ~5–20 lines per request typical

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* - **PASS (both checks)**

- [x] **I. Security**: `@Valid` DTOs on `/call-logs/settings` and `/call-logs/import`; page sizes, id lists and
  import sizes clamped; no secrets; log lines are call data → escaped in the UI (Angular bindings, no `innerHTML`)
  and exports (`escapeHtml`, `mdCell`); redaction rules applied like bodies (FR-017a); backend logs ids/counts only.
- [x] **II. Performance**: agent work is two MDC puts per request, nothing on the proxy path changes; no polling
  (existing sockets drive refetch); lists return line summaries, raw lines only for detail/export; one indexed
  query per source (thread/id fields switched to Exact-indexed); `request_thread` indexed; kept lines bounded by
  cycle contents (documented like session-cycle capture), live links not stored.
- [x] **III. Architecture**: the join is a composition-root bridge in `backend-app` (allowed for cross-slice
  logic); it uses use-case ports only. `backend-logs` stays a leaf; no new slice→slice edge; ArchUnit rules
  unchanged except the bridge package's own rule (as `triagebridge`). SQLite default; the two new logs tables have no
  file adapter because `backend-logs` is SQLite-only today. Frontend: the database window gains views (no fork);
  a call without capture opens the same window in logs-only mode.
- [x] **IV. Style**: `*UseCase`/`*Port`/`Sqlite*Repository`, records, constructor injection, strict TS.
- [x] **V. Clean code**: reuses `QueryLogsUseCase.lines`/`LogQuery`, `ContextPropagation`/`wrapRunnable`,
  `redact.ts`, the dbCapture export path (`json-export-v2.ts`, `import-parser.ts`), the db-window views; one join implementation.
- [x] **VI. Verification**: per-layer tests listed in tasks; agent ITs with fake MDCs (JDK 8+21); matching rules
  (overlap, skew, exact-over-thread) unit-tested on the bridge service; export/import round trip built with
  `buildBulkExportPayload`; live check on call `500d0cdc`.
- [x] **Invariants**: exports untruncated (guard test extended), gateway regex gets `call-logs`, docs updated
  (`docs/logs.md`, `docs/db-capture.md`, `docs/mcp.md`, CLAUDE.md prefix list).

## Project Structure

### Documentation (this feature)

```text
specs/008-logs-call-link/
├── spec.md, mock.html, checklists/requirements.md
├── plan.md              # this file
├── research.md          # R1-R8 decisions
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── call-logs-api.md
│   ├── agent-log-tagging.md
│   └── export-format.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
db-agent/src/main/java/com/fathy/alfred/dbagent/
├── capture/CaptureDispatcher.java      # servletEnter/Exit: tag + restore; CALL_OPEN thread
├── capture/LogTagger.java              # NEW: MDC probing per class loader, put/restore
├── capture/CallContext.java            # parse id for db=0 too
├── transport/AgentSettings.java        # logTagging, logTagKey
└── transport/MarkerRecord.java         # + thread

backend/backend-db-capture/             # logTagging in DbCaptureSettings/AgentSettingsResponse; request_thread column,
                                         # CallThreadUseCase (thread + neighbours) port
backend/backend-logs/                   # ProjectLogSettings + KeptLogLine domain, ports, SqliteLogsRepository tables,
                                         # use cases ManageProjectLogsUseCase, KeptLinesUseCase
backend/backend-app/src/main/java/com/fathy/alfred/backend/calllogsbridge/
├── CallLogsController.java             # /call-logs/*
├── CallLogsService.java                # the join (exact, thread+time, overlap, kept merge)
└── CycleContentKeepDecorator.java      # keeps lines when cycle contents change
backend/backend-architecture-test/      # bridge rule
gateway/nginx.conf                      # + call-logs prefix

frontend/src/app/
├── core/services/call-logs-api.service.ts         # NEW
├── core/models/call-logs.model.ts                 # NEW
├── components/db-capture/db-window.*              # Logs + Together views, logs-only mode
├── components/db-capture/db-timeline.component.ts # Logs lane
├── components/db-capture/db-log-lines.component.ts# NEW list (shared by window, Together)
├── components/db-capture/db-capture-settings.*    # Logs block
├── components/call-card/…                         # ▤ Logs marker (open/expanded cards only)
├── pages/logs/…                                   # "During call" on a line
└── shared/utils/{json-export-v2,import-parser,redact,db-export-section,export-narrative}.ts

mcp-server/src/tools/                    # call_logs tool
```

**Structure Decision**: web application layout above; the cross-slice join in `backend-app` per Constitution III.

## Phases (for /speckit-tasks)

1. **Foundation**: agent `request thread` on CALL_OPEN + `request_thread` column; logs `project_logs` + Exact
   switching; `/call-logs/settings`; gateway prefix; settings UI block.
2. **US1 (P1)**: bridge thread+time join (overlap, skew, paging, `setup` states), counts, db-window Logs/Together/lane, card marker, logs-only window.
3. **US2 (P2)**: `logTagging` setting → agent `LogTagger` (+ `wrapRunnable`), id parse for `db=0`; exact-first join; "found in N lines".
4. **US3 (P3)**: `/call-logs/for-line` + Logs tab "During call".
5. **US4 (P4)**: kept lines + cycle decorator; exports (.md/.html/.json), import; redaction; MCP `call_logs`.
6. **Polish**: docs, full suites (backend, agent 8/21, frontend, mcp), prod build, live check (quickstart), commit per phase.

## Complexity Tracking

None - no constitution violations.
