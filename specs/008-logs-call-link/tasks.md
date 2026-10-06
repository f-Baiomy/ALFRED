# Tasks: Logs linked to calls

**Input**: Design documents from `specs/008-logs-call-link/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, walkthrough-mock.html)
**Tests**: included - the constitution (VI) requires tests per layer; agent ITs run on JDK 8 and 21.
**Commits**: one commit per finished phase, explicit paths, never push (owner's standing instruction).

Paths: `DBC` = `backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture`,
`LOGS` = `backend/backend-logs/src/main/java/com/fathy/alfred/backend/logs`,
`BRIDGE` = `backend/backend-app/src/main/java/com/fathy/alfred/backend/calllogsbridge`,
`AGENT` = `db-agent/src/main/java/com/fathy/alfred/dbagent`, `FE` = `frontend/src/app`.

## Phase 1: Setup

- [X] T001 Add the `call-logs` prefix to the API regex in `gateway/nginx.conf` and to the prefix list in `CLAUDE.md`/`AGENTS.md`
- [X] T002 [P] Add the ▤ flag file like ◆'s: `proxy/log-link-enabled.flag` (empty, gitignored like `db-capture-enabled.flag`), its bind mounts and `LOG_LINK_TOGGLE_FILE` env for `reverse-proxy` and `backend` in `docker-compose.yml`, and its creation in `start.py` (`LOG_LINK_FLAG_FILE`, next to `DB_CAPTURE_FLAG_FILE`)
- [X] T003 Commit Phase 1

## Phase 2: Foundational (blocks every story)

**▤ switch, end to end (contracts/call-logs-api.md "The ▤ switch", research R1/R9)**

- [X] T004 [P] Add `LogLinkTogglePort` in `DBC/application/port/out/LogLinkTogglePort.java` and `FileLogLinkToggleAdapter` in `DBC/adapter/out/filestore/FileLogLinkToggleAdapter.java`, mirroring `DbCaptureTogglePort`/`FileDbCaptureToggleAdapter` (atomic write, mtime cache, `project=on|off`, missing = off, writability checked at `@PostConstruct`), with `FileLogLinkToggleAdapterTest` (`@TempDir`) beside `FileDbCaptureToggleAdapterTest`
- [X] T005 Extend the projects use case/service (`DBC/application/service/DbCaptureProjectsService.java`) and `DbCaptureProjectsController` with `logsOn` on `GET /db-capture/projects` and `PUT /db-capture/projects/{project}/logs` `{on}` (409 while the project's call logging is off, same outcome enum as `…/enabled`); notify the existing projects socket; `@WebMvcTest` cases in `backend/backend-db-capture/src/test/.../DbCaptureProjectsControllerTest.java`
- [X] T006 [P] Reverse proxy: `_log_link = _ToggleState('LOG_LINK_TOGGLE_FILE', default=False)` and `alfred_call_header(call_id, db_on, log_on, relive_info)` adding `; log=1` in `proxy/log_and_route_reverse.py`; tests in `proxy/test_db_capture_headers.py` (header with/without `log=1`, flag missing = off, logging off = no header)
- [X] T007 [P] Frontend switch state (done in `FE/core/state/db-capture-state.service.ts` - ▤ rides in the same project list as ◆, so no second service): mirroring `db-capture-state.service.ts`'s `isOn`/`toggle`/`switchTitle`/`switchError` for `logsOn`, API calls in `FE/core/services/db-capture-api.service.ts`
- [X] T008 Sources bar: a third `source-pill-switch log-sw` (▤) after `db-sw` in `FE/components/sources-bar/sources-bar.component.html/.ts`, `blocked` while logging is off, titles "Logs are linked for X - click to stop" / "turn logging on first"; styles beside `.db-sw`; spec covering on/off/blocked

**Request thread (research R3)**

- [X] T009 [P] Agent: `MarkerRecord` gains `thread`; `CaptureDispatcher.servletEnter` sends the request thread's name on `CALL_OPEN` (`AGENT/transport/MarkerRecord.java`, `AGENT/capture/CaptureDispatcher.java`, `BatchWriter` field); assert it in `db-agent/src/test/java/com/fathy/alfred/dbagent/OutboundHeaderIT.java` or a new `CallOpenThreadIT.java`
- [X] T010 Backend db-capture: accept `thread` on the marker (ingest DTO + `CallMarker`), store the thread on the CALL_OPEN `call_markers` row (`addColumnIfMissing` + index `(thread, at) WHERE seq = 0`) in `DBC/adapter/out/sqlite/SqliteDbCaptureRepository.java`; new in-port `CallThreadsUseCase` (`requestThread(callId)` falling back to the first statement's thread; `callsOnThread(thread, from, to)` for neighbours and line→call) implemented in `DbCaptureQueryService`; tests in `SqliteDbCaptureRepositoryTest`/service test

**Project log settings + kept lines storage (data-model.md)**

- [X] T011 [P] `LOGS/domain/model/ProjectLogSettings.java`, `KeptLogLine.java` (records with validation: clock difference 0..5000, default 200; default id field `mdc.alfred.call`)
- [X] T012 `LOGS` ports/use cases: `ManageProjectLogsUseCase` (get/save, switching the thread and id fields to Exact search through the existing structure update - FR-009 - and `callIdFoundLines` counted whether ▤ is on or off - FR-010), `KeptLogLinesUseCase` (keep with `origin` CYCLE|IMPORT, list by call, `removeForCalls`); store ports and the `project_logs`/`kept_lines` tables in `LOGS/adapter/out/sqlite/SqliteLogsRepository.java` + a `SqliteProjectLogsAdapter`/`SqliteKeptLinesAdapter`; service + adapter tests
- [X] T013 Bridge skeleton: `BRIDGE/CallLogsService.java`, `BRIDGE/CallLogsController.java` with `GET/PUT /call-logs/settings/{project}` (`@Valid` DTO; unknown source ids/fields → 400); ArchUnit rule for `calllogsbridge` in `backend/backend-app/src/test/.../calllogsbridge/CallLogsBridgeArchitectureTest.java` (the architecture-test module cannot see backend-app classes)
- [X] T014 [P] Frontend models + API: `FE/core/models/call-logs.model.ts` (`LinkedLogLine`, `CallLogsPage`, `LogCounts`, `ProjectLogSettings`), `FE/core/services/call-logs-api.service.ts` (+ spec)
- [X] T015 Logs section in the ◆ popover / settings (one shared `FE/components/db-capture/project-logs-settings.component.ts`): source multi-select, thread field, time field, call id field with "found in N lines", clock difference, and the note "thread and call id fields become exact-searchable in the Logs tab"; `FE/components/db-capture/db-capture-popover.component.ts` and `db-capture-settings.component.ts` (+ spec)
- [X] T016 Commit Phase 2

**Checkpoint**: ▤ toggles live in the Sources bar and adds `log=1`; settings save; request thread stored.

## Phase 3: User Story 1 - See what the application logged during a call (P1) 🎯 MVP

**Goal**: a captured call shows its log lines (thread + time) in the database window, Together view, Logs lane and card marker.
**Independent test**: ▤ on for odeysys, `wildfly` source linked, open call `500d0cdc` → its `default task-4` lines in its window, marker on its card (quickstart steps 1-3).

- [X] T017 [US1] Join by thread and time in `BRIDGE/CallLogsService.java`: window = call timestamp + duration ± clock difference, compared as typed UTC instants (the TIME-role field's typed value, honouring the source's time zone - never raw text); lines carrying any call id are excluded from time matching (FR-004); every line carries its source id/name (FR-011a); the service logs ids, counts and timings only (FR-018a); one `QueryLogsUseCase.lines` per linked source (`threadField = T` AND time range), merged and sorted; overlap rule (neighbours from `callsOnThread`, nearest window middle wins); paging cursor (`after`, `limit` 1..500); `setup` = `LINKING_OFF` (▤ or call logging off → no query) / `NO_SOURCE` / `NO_THREAD` / `OK`; never reads logs while ▤ is off
- [X] T018 [US1] Unit tests for T017 in `backend/backend-app/src/test/java/com/fathy/alfred/backend/calllogsbridge/CallLogsServiceTest.java`: in-window, skew edges, neighbour overlap, a source whose time zone is not UTC, a line tagged for another call is not time-matched, two sources (source shown), paging, ▤ off reads nothing (verify no query), no source, no thread
- [X] T019 [US1] `GET /call-logs/{callId}` and `GET /call-logs/counts?callIds=` (≤100, clamped) in `BRIDGE/CallLogsController.java` + `@WebMvcTest`
- [X] T020 [P] [US1] `FE/components/db-capture/db-log-lines.component.ts` (+ spec): offset, level badge, message, source name when the project has several; opens a line to all its fields (raw JSON) with "Open in Logs ↗" linking to `/logs/<sourceId>?line=<lineId>`; how matched pill
- [X] T021 [US1] Logs explorer deep link: `FE/pages/logs/logs-explorer.component.ts` reads `?line=<lineId>`, loads the line with its neighbours (existing `QueryLogsUseCase.context` / `GET …/lines/{lineId}` context endpoint), scrolls to and highlights it; spec
- [X] T022 [US1] Database window: Logs and Together views (statements, supplier calls and log lines in one time-ordered list) and the "Logs from … · matched by … · open in Logs ↗" bar text in `FE/components/db-capture/db-window.component.html/.ts`; refetch on `/ws/logs` `lines-added` for the call's project sources (no polling); empty states per `setup`; spec
- [X] T023 [P] [US1] Logs lane (one tick per line coloured by level, hover card) in `FE/components/db-capture/db-timeline.component.ts`; strip and detailed modes; spec
- [X] T024 [US1] Call card marker `▤ Logs N · errors · warn` beside ◆ in a new `FE/components/db-capture/log-chip.component.ts` used by `FE/components/call-card/call-card.component.html` (counts fetched only for open/expanded cards, batched; refetched on the existing calls and `/ws/logs` signals - FR-018); click opens the window on the Logs view; spec
- [ ] T025 [US1] Live check (quickstart 1-3) on call `500d0cdc`: time from opening the call to lines shown (SC-001, < 2 s); compare linked lines with a hand count of the `default task-4` lines in the call's window (SC-003, ≥95% linked, <1% from another call), record both in `specs/008-logs-call-link/quickstart.md`; deploy backend/frontend/proxy; commit Phase 3

## Phase 4: User Story 2 - The ▤ switch and exact linking (P2)

**Goal**: with ▤ on, the agent tags every recorded request's log lines; exact lines win; calls without capture get logs.
**Independent test**: ▤ on → a request's lines carry `mdc.alfred.call` and show `exact`; ▤ off → the next request's lines carry nothing and no odeysys call shows logs.

- [ ] T026 [P] [US2] `AGENT/capture/LogTagger.java`: probe `org.jboss.logmanager.MDC`, `org.slf4j.MDC`, `org.apache.logging.log4j.ThreadContext`, `org.apache.log4j.MDC`, `org.jboss.logging.MDC` through the context class loader, cached per class loader (`ClassValue`/weak map); `tag(id)` returns a restore token; failures once per kind via `AgentLog` (contracts/agent-log-tagging.md)
- [ ] T027 [US2] `CallContext.fromHeader` parses `log=1` and the id for `db=0` (capture still needs `db=1`); `CaptureDispatcher.servletEnter/Exit` tag/restore in `finally`; `ContextPropagation`/`wrapRunnable` set/restore around tasks (`AGENT/capture/CallContext.java`, `CaptureDispatcher.java`, `ContextPropagation.java`)
- [ ] T028 [US2] Agent ITs `db-agent/src/test/java/com/fathy/alfred/dbagent/LogTaggingIT.java` with fake MDC classes outside the agent package (`org.example.mdc.*`, like `org.example.jta`): tagged with `log=1` (db=0 and db=1), untouched without it, previous value restored, pooled-thread hand-off tagged, overhead within `OverheadMeasurementIT` budget; run on JDK 8 and 21
- [ ] T029 [US2] Exact first in `BRIDGE/CallLogsService.java`: query `callIdField = <callId>` per source; when any exact line exists, use exact only for that call; calls without capture use exact only; a line carrying another call's id never joins this call; tests in `CallLogsServiceTest` (mixed tagged/untagged neighbours recorded before and after ▤ was turned on)
- [ ] T030 [US2] Logs-only window for calls without database capture (same `DbWindowComponent`, Logs view only, opened from the card marker) and the ▤-off empty state with "Turn ▤ on" in `FE/components/db-capture/db-window.*`; spec
- [ ] T031 [US2] Rebuild the agent jar, live check (quickstart 4; restart WildFly once), commit Phase 4

## Phase 5: User Story 3 - From a log line back to its call (P3)

**Goal**: a Logs tab line shows the call it was written during.
**Independent test**: open an odeysys line inside a recorded call → "During call ↗ …" opens it.

- [ ] T032 [US3] `GET /call-logs/for-line?sourceId=&lineId=` in `BRIDGE/CallLogsService.java`/`CallLogsController.java`: exact id field → that call; else the line's thread + time → `callsOnThread` → window check (same overlap rule); only for projects with ▤ on; 204 when none; tests
- [ ] T033 [US3] "During call" block (method, path, status, duration, how matched, links to the call and its database window) in `FE/components/logs/log-line-data.component.html/.ts`; spec
- [ ] T034 [US3] Live check (quickstart 5), commit Phase 5

## Phase 6: User Story 4 - Logs in exports and for Claude (P4)

**Goal**: exports carry every linked line; cycle calls keep their lines; import restores them; Claude reads them.
**Independent test**: export/import round trip keeps every line; a cycle call still shows lines after the source is deleted; `call_logs` returns them.

- [ ] T035 [US4] Kept lines for cycle calls: `BRIDGE/CycleContentKeepDecorator.java` (a `@Primary` `SessionCycleNotificationPort` delegating to `WebSocketSessionCycleNotificationAdapter` injected by `@Qualifier` - not by type, scheduling an async keep of the cycle's inbound calls' lines and removing kept lines of calls in no cycle) + upsert on every read of a cycle call in `CallLogsService`; merge live + kept by line id; tests
- [ ] T036 [US4] `POST /call-logs/import` (≤20,000 lines/request, `@Valid`) storing kept lines with origin IMPORT; when imported calls are deleted (inbound delete paths reached through the bridge, like `RelatedCallsDeletionAdapter`) their kept lines are removed (FR-016); tests
- [ ] T037 [P] [US4] `CallRecord.logLines` in `FE/core/models/call.model.ts`; export dialog and per-call downloads fetch `/call-logs/{id}` for exported inbound calls (all pages) in `FE/components/export-dialog/export-dialog.component.ts` and `FE/components/call-actions/call-actions.component.ts`; `FE/shared/utils/redact.ts` applies body rules to each line's raw JSON (FR-017a); specs
- [ ] T038 [US4] `.json` v3 `logLines` section + index `logs` counts + guide/layout text in `FE/shared/utils/json-export-v2.ts`; `FE/shared/utils/import-parser.ts` reads it; import posts lines to `/call-logs/import`; round-trip spec built with `buildBulkExportPayload` (contracts/export-format.md)
- [ ] T039 [US4] `.md`/`.html` "📜 Logs" section per call in `FE/shared/utils/db-export-section.ts` (or a sibling `log-export-section.ts`) wired from `markdown-builder.ts`/`html-builder.ts`; one sentence in `export-narrative.ts`; no-truncation guard test extended to log lines
- [ ] T040 [P] [US4] MCP `call_logs` tool in `mcp-server/src/tools/` (paged; applies the project's redaction rules to each line exactly as the server does for bodies, then the session masking - FR-017a) + tests in `mcp-server/test/` with `fake-alfred.ts` (a rule masking a field inside a line)
- [ ] T041 [US4] Live check (quickstart 6-7), commit Phase 6

## Phase 7: Polish

- [ ] T042 Terminology pass: the terms of spec.md "Terms" (▤ switch, tagging, exact / same thread and time, linking, kept lines) used consistently in UI text (`sources-bar`, settings, db-window, log-chip) and docs
- [ ] T043 [P] Docs: `docs/logs.md` (linking, kept lines), `docs/db-capture.md` (▤ flag, `log=1`, MDC tagging, request thread), `docs/mcp.md` (`call_logs`), `docs/frontend-architecture.md` (Logs/Together views), CLAUDE.md note on `/call-logs` and the ▤ flag
- [ ] T044 Full suites once: backend `mvn test` (Docker JDK 21), agent on JDK 8 and 21, frontend `ng test` + `ng build --configuration production`, mcp-server tests; fix failures
- [ ] T045 Measure SC-004 (▤ on vs off request time) with `OverheadMeasurementIT` and record it in `docs/db-capture.md`; mark tasks done here; final commit

## Dependencies

- Phase 1 → Phase 2 → stories. US1 needs T004-T016. US2 needs US1's join (T017) for "exact first" but its agent part (T026-T028) can start right after Phase 2. US3 needs T010 (`callsOnThread`) and T017's overlap rule. US4 needs T017/T019 (lines endpoint) and T012 (kept lines store).
- Within a story: backend before frontend; tests beside each change.

## Parallel examples

- Phase 2: T004, T006, T007, T009, T011, T014 touch different modules.
- US1: T020 and T023 (frontend components) while T019 is finished.
- US2: T026 (agent) in parallel with T029 (bridge).
- US4: T037 and T040 in parallel after T036.

## Implementation strategy

MVP = Phases 1-3 (thread-and-time linking behind the ▤ switch, works on today's log files). Then US2 (exact,
agent), US3 (reverse link), US4 (exports, kept lines, Claude), each a deployable increment with its own live check.
Subagents: none by default (CLAUDE.md token budget); at most one for a fully specified chunk (e.g. T038-T039).
