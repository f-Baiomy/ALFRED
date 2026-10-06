# Tasks: Log lines caught by the agent

**Input**: `specs/009-agent-log-capture/` - plan.md, spec.md, research.md (R1-R8), data-model.md, contracts/, quickstart.md
**Tests**: included - the constitution (VI) requires tests per layer; agent ITs run on JDK 8 and 21.

Path shorthands: `AGENT` = `db-agent/src/main/java/com/fathy/alfred/dbagent`, `AGENT_T` = `db-agent/src/test/java`,
`DBC` = `backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture`,
`DBC_T` = `backend/backend-db-capture/src/test/java/com/fathy/alfred/backend/dbcapture`,
`BRIDGE` = `backend/backend-app/src/main/java/com/fathy/alfred/backend/calllogsbridge`, `FE` = `frontend/src/app`.

## Phase 1: Setup

- [X] T001 Add logback-classic and log4j-core/log4j-api as **test**-scope dependencies (pinned) in `db-agent/pom.xml`; confirm the shaded jar contains neither (`unzip -l target/alfred-db-agent.jar`)
- [ ] T002 [P] Mock and screenshots before code (user rule): `specs/009-agent-log-capture/mock.html` - Logs view with logger, thread, exception block and "caught" pill; Together in seq order; "N lines not kept"; ▤ tooltip "caught by the agent"; "outside any call" with lines per thread; screenshots in `specs/009-agent-log-capture/screenshots/`; wait for "start"

## Phase 2: Foundational (blocks every story)

- [X] T003 `CallContext` gains `capture`, `logs`, log counters (`logLines`, `logBytes`, `logDropped`) and `closedAtNanos`; `fromHeader` opens a context for `log=1` even with `db=0` (`capture=false`) in `AGENT/capture/CallContext.java` (R3)
- [X] T004 Every statement-path check in `AGENT/capture/CaptureDispatcher.java` (and `Recorder`) uses `current() != null && current().capture` instead of `current() != null`; the outbound HTTP path keeps `current() != null`, so a logs-only call's supplier calls still get `X-Alfred-Parent` and an HTTP_OUT marker (research R3) - covered by an `OutboundHeaderIT` case for `db=0; log=1`; CALL_OPEN carries `logs` - add `logs` to `AGENT/transport/MarkerRecord.java` and `BatchWriter`
- [X] T005 Agent IT proving no statement is recorded for a `db=0; log=1` call and capture is unchanged for `db=1` in `AGENT_T/com/fathy/alfred/dbagent/JdbcCaptureIT.java` (JDK 8 and 21)
- [X] T006 [P] `LogRecord` (callId, seq, at with fixed 3-digit fraction, level, logger, thread, message, exception {type,message,stack}, cut) in `AGENT/transport/LogRecord.java`; `logs` + `droppedLogs` in the batch JSON in `AGENT/transport/BatchWriter.java`; `StatementSink.log(LogRecord)` and the bounded queue/drop counting in `AGENT/transport/BatchSender.java` (R5); `BatchWriterTest`
- [X] T007 [P] Backend: `call_log_lines` table + indexes `(call_id, seq)` and `(project, thread, at_ms) WHERE call_id IS NULL`, `call_db_summary` columns `log_lines/log_errors/log_warnings/log_dropped`, `call_markers.logs` in `DBC/adapter/out/sqlite/SqliteDbCaptureRepository.java` (idempotent ALTERs like 008's `thread`)
- [X] T008 Domain `CaughtLogLine` in `DBC/domain/model/CaughtLogLine.java`; store port methods `saveLogLines`, `logLines(callId, afterSeq, limit)`, `outsideLogLines(project, thread, afterId, limit)`, `addDroppedLogs`, and summary counts in `DBC/application/port/out/DbCaptureStorePort.java` + SQLite implementation; retention: lines deleted with their call's statements by the size cap, outside rows capped at 20,000 per project oldest-first
- [X] T009 Batch DTO accepts `logs`/`droppedLogs` with `@Valid` limits (≤5,000 records, message ≤32 KB, logger/thread ≤512) in `DBC/adapter/in/web/DbCaptureAgentController.java`; ingest service stores them and refreshes summary counts; `logs-appended` on `/ws/db-capture`; tests in `DBC_T/adapter/out/sqlite/SqliteDbCaptureRepositoryTest.java` and the controller test

## Phase 3: User Story 1 - Every line a call logged, with no log-file setup (P1)

**Goal**: a recorded call shows every line the application logged for it, caught in the JVM.
**Independent test**: no log source loaded, ▤ on, one request → its Logs view lists the lines of every logger on that thread (quickstart 2-4).

- [X] T010 [US1] `LogCatcher` in `AGENT/capture/LogCatcher.java`: per-class reflective readers (level, logger, thread, formatted message, throwable, time) for jboss-logmanager `ExtLogRecord`, JUL `LogRecord`, logback `ILoggingEvent`, log4j 2 `LogEvent`, log4j 1 `LoggingEvent`; re-entrancy flag (R2); runs under the agent-work guard; caps per context before formatting (R6: 5,000 lines, 2 MB, 32 KB/line with `cut`); 5 s late-line grace; failures once per kind via `AgentLog`
- [X] T011 [US1] `LogInstrumentation` in `AGENT/LogInstrumentation.java` + `AGENT/advice/LogEventAdvice.java`: hooks `org.jboss.logmanager.Logger.logRaw`, `java.util.logging.Logger.log(LogRecord)` (only when loggable), `ch.qos.logback.classic.Logger.callAppenders`, `org.apache.logging.log4j.core.config.LoggerConfig.log(LogEvent)`, `org.apache.log4j.Category.callAppenders`; registered from `AGENT/Instrumenter.java`; event → `CaptureDispatcher.logEvent(Object)` → `LogCatcher`
- [X] T012 [US1] Agent ITs in `AGENT_T/com/fathy/alfred/dbagent/LogCaptureIT.java` (fake logmanager class under `AGENT_T/org/jboss/logmanager/` like `org.example.jta`): each framework caught once inside a `log=1` call with level/logger/thread/message/exception; below-level lines not caught; slf4j→logback and JUL→logmanager bridges caught once; nothing caught without `log=1`; seq interleaves with statements; pooled-thread hand-off attached; caps and late lines counted; 100 concurrent calls on a thread pool, each logging its own marker lines - every line on its own call, none lost (SC-002); JDK 8 and 21
- [X] T013 [US1] `CallLogLinesUseCase` (`caughtFor(callId)`, `lines(callId, afterSeq, limit)`, `counts(callIds)`) in `DBC/application/port/in/CallLogLinesUseCase.java`, implemented in `DBC/application/service/DbCaptureQueryService.java`; tests
- [X] T014 [US1] Caught lines first in `BRIDGE/CallLogsService.java`: a call whose CALL_OPEN says `logs=1` is served from `CallLogLinesUseCase` (`matchedBy=CAUGHT`, `sourceId=agent`, `lineId=c:<id>`, `raw` = line as JSON, `exception`, `offsetMs`, `dropped`); counts from the summary; otherwise the 008 file join unchanged; tests in `backend/backend-app/src/test/java/com/fathy/alfred/backend/calllogsbridge/CallLogsServiceTest.java`
- [X] T015 [P] [US1] `LinkedLogLine` gains `exception`; `LogMatch` gains `CAUGHT`; `CallLogsPage.dropped` in `FE/core/models/call-logs.model.ts` and `BRIDGE/CallLogsModels.java`
- [X] T016 [US1] `FE/components/db-capture/db-log-lines.component.ts`: logger column, exception block (type, message, stack, folded), "caught" pill, "N lines not kept" note; Together orders caught lines by seq among statements in `FE/shared/utils/call-log-rows.ts`; the database window refetches its call's lines on `/ws/db-capture` `logs-appended` for that call (no polling) in `FE/components/db-capture/db-window.component.ts`, and `FE/core/state/call-log-counts.service.ts` refetches the shown cards' counts on the same signal; specs
- [ ] T017 [US1] Live check quickstart 1-4 and 8 (rebuild agent, restart WildFly once); measure the time from a request ending to its lines in the open window (SC-004, < 2 s); record SC-001/SC-002/SC-004 in `specs/009-agent-log-capture/quickstart.md`; commit

## Phase 4: User Story 2 - The ▤ switch decides, the agent wins (P2)

**Goal**: ▤ with the agent attached = caught lines; without an agent = 008 files; no line twice.
**Independent test**: quickstart 2, 5 and the "agent detached" case.

- [X] T018 [US2] ▤ tooltip and settings text say where lines come from ("caught by the agent" / "from log files") from `ProjectCaptureStatus.attached` in `FE/core/state/db-capture-state.service.ts` (`logsTitle`) and `FE/components/db-capture/project-logs-settings.component.ts` (file-source fields shown only without an agent); spec
- [X] T019 [US2] Logs-only window for `db=0; log=1` calls works from caught lines (statements empty, Logs view) in `FE/components/db-capture/db-window.component.*`; spec
- [X] T020 [US2] Bridge test: a caught call never runs the file join (no `QueryLogsUseCase` call) and a pre-switch call keeps file lines, in `CallLogsServiceTest`
- [ ] T021 [US2] Live check quickstart 5 (◆ off, ▤ on); commit

## Phase 5: User Story 3 - Caught lines everywhere the call goes (P3)

**Goal**: cycles, exports, import, Claude.
**Independent test**: quickstart 10.

- [X] T022 [US3] Retention: caught lines of calls a session cycle holds survive the size cap (`RetainedCallIdsPort` path) in `SqliteDbCaptureRepository`/`DbCaptureRetention`; test
- [X] T023 [US3] Export round trip with `CAUGHT` lines (exception included) in `FE/shared/utils/log-export-section.spec.ts` (.md/.html show logger and exception; .json v3 keeps them); import restores them through `/call-logs/import`; masking of message and exception like bodies in `FE/shared/utils/redact.ts` (exception text included)
- [X] T024 [P] [US3] MCP `call_logs` shows `logger` and `exception` and accepts `CAUGHT` in `mcp-server/src/tools/logs.ts`; test in `mcp-server/test/logs.test.ts`
- [ ] T025 [US3] Live check quickstart 10; commit

## Phase 6: User Story 4 - Outside any call (P4)

**Goal**: lines of threads working for no call, by thread, under their own bound.
**Independent test**: quickstart 6.

- [X] T026 [US4] Agent catches outside-call lines while the heartbeat answer's `logsOn` is true (project setting already in the heartbeat answer - add `logsOn` in `DBC` heartbeat response and `AGENT/transport/AgentSettings.java`); `LogCatcher` records them with `callId=null`; IT in `LogCaptureIT`
- [X] T027 [US4] `GET /db-capture/outside/logs?project=&thread=&after=&limit=` (≤500) in `DBC/adapter/in/web/DbCaptureController.java` via `CallLogLinesUseCase.outside(...)`; 20,000-row bound test
- [X] T028 [US4] "Outside any call" view shows each thread's lines between its statements (seq-less: by time) in `FE/components/db-capture/db-window.component.*` + `FE/core/services/db-capture-api.service.ts`; refetch on `logs-appended`; spec
- [ ] T029 [US4] Live check quickstart 6; commit

## Phase 7: Polish

- [X] T030 [P] `OverheadMeasurementIT` log case (100 lines per call through JUL, logback, log4j 2; catching on vs off; non-recorded call) in `AGENT_T/com/fathy/alfred/dbagent/OverheadMeasurementIT.java`; record SC-003 in `docs/db-capture.md`
- [X] T031 [P] Docs: `docs/db-capture.md` (log catching, hooks, caps, outside lines), `docs/logs.md` ("Linked to calls": caught lines win), CLAUDE.md note, `specs/009-agent-log-capture/quickstart.md` results
- [X] T032 Full suites once: backend `mvn test` (Docker JDK 21), agent `mvn test` on JDK 8 and 21 (never `verify` while WildFly uses the jar), frontend `ng test` + production build, mcp-server, proxy; fix failures
- [X] T033 Mark tasks done; final commit

## Dependencies

- Phase 1 → Phase 2 → stories. US1 needs T003-T009. US2 needs US1's bridge (T014). US3 needs T014/T015. US4 needs T006-T009 and T010-T011.
- T005 must pass before any US task (capture unchanged for `db=1`).

## Parallel opportunities

- Phase 2: T006 (agent transport) and T007 (backend table) together.
- US1: T015 (models) beside T010-T012; US3: T024 (MCP) beside T022-T023.

## Implementation strategy

MVP = Phases 1-3 (US1): complete per-call logs on WildFly with no files. Then US2 (switch clarity), US3 (cycles,
exports, Claude), US4 (outside lines). Commit after each phase; live checks need one WildFly restart with the new agent.
