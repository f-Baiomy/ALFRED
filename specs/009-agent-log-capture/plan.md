# Implementation Plan: Log lines caught by the agent

**Branch**: `009-agent-log-capture` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/009-agent-log-capture/spec.md`

## Summary

The db-agent catches every log event the application emits - at one hook per logging framework, after the
application's own level check (jboss-logmanager, which WildFly funnels everything into; plus JUL, logback, log4j 2,
log4j 1 for other JVMs) - and sends it, already attached to its call and ordered by the call's shared `seq`, in its
existing batch. `backend-db-capture` stores the lines next to the call's statements (same db, same size cap, same
"cycles keep their calls" rule) and the 008 bridge serves them from `/call-logs` for any call the agent caught, so the
database window's Logs/Together views, the card chip, exports, import and Claude's `call_logs` show them with no change
of shape. The ▤ switch stays the only switch: with the agent attached it means caught lines (`log=1` now also opens a
light, no-capture call context); without an agent, 008's file linking. Lines on threads working for no call go to
"outside any call", grouped by thread, under their own bound.

## Technical Context

**Language/Version**: Java 8 (db-agent), Java 21 (backend), TypeScript/Angular 20 (frontend), TypeScript/Node (mcp-server - no change expected)
**Primary Dependencies**: ByteBuddy (agent, existing); logging frameworks read reflectively - none added at runtime; logback and log4j 2 as agent **test** dependencies only
**Storage**: SQLite `db-capture.db` - new table `call_log_lines`, `call_db_summary` + 4 count columns, CALL_OPEN marker + `logs` flag
**Testing**: agent ITs on JDK 8 and 21 (`LogCaptureIT` per framework, concurrency, caps, outside lines, `OverheadMeasurementIT` log case); JUnit5/Mockito/AssertJ + ArchUnit; Karma/Jasmine
**Target Platform**: odeysys WildFly (Java 8, JBoss Modules) + Docker (backend/frontend)
**Project Type**: web application (multi-module backend + Angular frontend) + Java agent
**Performance Goals**: < 5 % on a 100-line call (SC-003); lines visible < 2 s after the call (SC-004)
**Constraints**: never change what/where/how the app logs (FR-003); never block the app (FR-008); exports never truncate; no polling
**Scale/Scope**: up to 5,000 lines / 2 MB per call; outside lines 20,000 rows per project

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* - **PASS (both checks)**

- [x] **I. Security**: batch endpoint keeps `X-Webhook-Secret`; batch DTO `@Valid` with sizes clamped (records,
  message, logger, thread); outside-lines endpoint clamps `limit`; log lines are call data - escaped in UI/exports,
  masked like bodies (FR-012, reusing 008's path); backend logs counts only, never line text.
- [x] **II. Performance**: hooks do a ThreadLocal read and return when the thread has no catching context; formatting
  happens only for kept lines; caps enforced in the agent before formatting; bounded queue drops, never blocks;
  `call_log_lines` indexed by `(call_id, seq)`; counts from `call_db_summary` (no line reads for chips); retention =
  statements' size cap + outside bound; no polling (`logs-appended` on the existing socket).
- [x] **III. Hexagonal slices**: storage and use cases in `backend-db-capture` (its own slice); the per-call source
  choice in the existing `backend-app/calllogsbridge` (composition root, use-case ports only - ArchUnit rule kept);
  no slice reads another's adapters.
- [x] **IV. Style**: agent hooks follow `Instrumenter`/advice + `CaptureDispatcher` + `AgentLog`; reflective event
  readers like 008's `LogTagger`; frontend reuses `db-log-lines`, `log-chip`, exports untouched in shape.
- [x] **V. Clean code**: reuses `CallContext`, the batch, the summary, the size cap, `/call-logs`, `LinkedLogLine`;
  no second "current call", no second transport, no second API.
- [x] **VI. Verification**: per-framework agent ITs (real logback/log4j 2 test deps, JUL, a fake logmanager class
  like `org.example.jta`), concurrency IT for SC-002, repository + bridge tests, frontend specs; full suites once.
- [x] **Invariants**: exports untruncated (caught lines are `LinkedLogLine`s); interception untouched; no new gateway
  prefix (`/db-capture`, `/call-logs` exist); docs updated (db-capture.md, logs.md, CLAUDE.md note).

## Project Structure

### Documentation (this feature)

```text
specs/009-agent-log-capture/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/agent-log-capture.md  contracts/call-logs-api.md
└── tasks.md   (next: /speckit-tasks)
```

### Source Code (repository root)

```text
db-agent/src/main/java/com/fathy/alfred/dbagent/
├── LogInstrumentation.java              # NEW: hooks per framework (R1)
├── advice/LogEventAdvice.java           # NEW: Object-typed advice → dispatcher
├── capture/LogCatcher.java              # NEW: reflective readers, re-entrancy, caps, formatting (R2, R6)
├── capture/CallContext.java             # capture/logs flags, log counters, closedAt (R3)
├── capture/CaptureDispatcher.java       # log=1 opens a no-capture context; capture checks use .capture
└── transport/LogRecord.java, BatchWriter.java, BatchSender.java   # logs + droppedLogs in the batch (R5)

backend/backend-db-capture/              # storage + use case (R5, R7)
├── domain/model/CaughtLogLine.java      # NEW
├── application/port/in/CallLogLinesUseCase.java      # NEW
├── application/port/out/DbCaptureStorePort.java      # + log line methods
├── adapter/out/sqlite/SqliteDbCaptureRepository.java # call_log_lines, summary counts, retention
└── adapter/in/web/DbCaptureAgentController.java, DbCaptureController.java  # batch logs, outside logs route

backend/backend-app/.../calllogsbridge/CallLogsService.java   # caught lines first, else 008 file join

frontend/src/app/
├── components/db-capture/db-log-lines.component.ts   # logger, exception block, "caught" pill
├── components/db-capture/db-window.component.*        # outside-call lines per thread
└── core/models/call-logs.model.ts                     # matchedBy CAUGHT, exception
```

**Structure Decision**: extend the existing agent, `backend-db-capture` slice and 008 bridge; no new module or route
prefix.

## Complexity Tracking

None - no constitution violations.
