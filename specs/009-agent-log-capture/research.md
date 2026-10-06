# Research: Log lines caught by the agent (009)

## R1 - Where to catch a log event

**Decision**: one ByteBuddy advice per framework at the point where an event has already passed the logger's level and
filter checks and is about to go to its handlers/appenders:

| Framework | Hook | Event read through |
|---|---|---|
| jboss-logmanager (WildFly - also receives JUL, slf4j, jboss-logging, log4j via WildFly's bridges) | `org.jboss.logmanager.Logger.logRaw(ExtLogRecord)` | `getLevel`, `getLoggerName`, `getThreadName`, `getFormattedMessage`, `getThrown`, `getMillis`/`getInstant` |
| java.util.logging (plain JVM) | `java.util.logging.Logger.log(LogRecord)` - entry, only if `isLoggable(level)` and the filter passes | `SimpleFormatter.formatMessage` |
| logback | `ch.qos.logback.classic.Logger.callAppenders(ILoggingEvent)` | `getFormattedMessage`, `getThrowableProxy` |
| log4j 2 | `org.apache.logging.log4j.core.config.LoggerConfig.log(LogEvent)` (the non-deprecated overload every path reaches) | `getMessage().getFormattedMessage()`, `getThrown()` |
| log4j 1 | `org.apache.log4j.Category.callAppenders(LoggingEvent)` | `getRenderedMessage`, `getThrowableInformation` |

The advice code takes `Object` and reads the event reflectively through a per-class method cache (the agent has no
compile dependency on any logging framework - same as the MDC tagging of 008).

**Rationale**: these points see each event once, after the application's own level/filter decision (FR-003: never log
more), whatever handler/appender/file/format follows (FR-001). On WildFly every API funnels into logmanager, so one
hook covers all.

**Alternatives**: adding our own Handler/Appender to each framework's root logger - rejected: it changes the
application's logging configuration (FR-003) and is lost on a reconfigure (WildFly CLI, log4j reload). Hooking the
API methods (`Logger.info(...)`) - rejected: dozens of overloads per framework and it fires before the level check.

## R2 - One event caught once

**Decision**: a per-thread re-entrancy flag (`catching`) set while an event is being recorded; a hook that fires while
it is set (slf4j → logback → JUL bridge, JUL → logmanager) records nothing. The agent's own work (sending, formatting)
runs under the dispatcher's existing agent-work guard, so its own logging (or a driver's) is never caught.

**Rationale**: bridges call one framework from another on the same thread, inside the outer hook.

## R3 - Which call a line belongs to; calls without database capture

**Decision**: `CallContext` (008's per-thread call, carried to pool threads) gains two flags: `capture` (db=1) and
`logs` (log=1). The reverse proxy already sends `log=1` while ▤ is on; a request with `log=1` and `db=0` now opens a
context with `capture=false`, so it gets a CALL_OPEN marker (with its thread) and a seq counter but records no
statements. Every statement-path check moves from `current() != null` to `current() != null && current().capture`.
A caught line takes the context's `nextSeq()` - its exact order among the call's statements and supplier calls
(FR-004). On a thread with no context: an outside-call line (FR-002, FR-015).

**Alternatives**: a second ThreadLocal just for logs - rejected: two notions of "the current call" would drift, and
lines could not share the statements' seq.

## R4 - The switch: ▤ means the agent when attached

**Decision**: no new switch. The agent catches while the request carries `log=1` (per call) and, for outside-call
lines, while its heartbeat answer says the project's `logsOn` is true (the heartbeat already returns the project's
settings every 10 s). The backend decides the source per call: a call whose CALL_OPEN marker says `logs=1` (the agent
caught for it) shows caught lines; any other call falls back to 008's file linking. So calls recorded before keep
what they had (FR-006) and a project without an agent keeps file linking (FR-005).

## R5 - Transport and storage

**Decision**: caught lines travel in the agent's existing batch (`POST /db-capture/agent/batch`) as a new `logs`
array, through the same bounded queue (FR-008: dropped and counted when full, `droppedLogs` on the summary). They are
stored by `backend-db-capture` in `db-capture.db`, table `call_log_lines`, and evicted by the same size cap and
retained-calls rule as statements (FR-010, clarification). Outside-call lines go to the same table with
`call_id = NULL` and their own row bound (20,000 rows, oldest first - FR-015).

**Rationale**: the agent already batches, retries and bounds; the store already has a size cap and keeps session-cycle
calls (`RetainedCallIdsPort`). A second channel would duplicate all of that.

**Alternatives**: storing in `backend-logs` (the Logs tab's store) - rejected by the spec's assumption: caught lines
are per-call data like statements, and logs.db's sources are files.

## R6 - Caps

**Decision** (FR-007): per call 5,000 lines and 2 MB of line text; per line 32 KB (message + stack trace, cut with a
`cut` flag); enforced in the agent per `CallContext` (counters), so nothing beyond the cap is formatted or sent;
counts reported on the call's summary (`logLines`, `logDropped`). Late lines (FR-013): a closed context stays
attachable for 5 s (`closedAtNanos`); later lines are dropped and counted.

## R7 - Reading them back

**Decision**: `backend-db-capture` gets a use case `CallLogLinesUseCase` (`lines(callId, after, limit)`,
`counts(callIds)`, `outside(thread?, after, limit)`, `caughtFor(callId)`); `backend-app/calllogsbridge/CallLogsService`
asks it first - caught lines win for a call caught by the agent - and otherwise runs 008's file join unchanged. The
`LinkedLogLine` shape gains `logger`, `exception` (already has thread/level/message) and `matchedBy = CAUGHT`. The
frontend, exports and MCP read `/call-logs/...` as today: no second API.

## R8 - Measuring the cost

**Decision**: extend `OverheadMeasurementIT` with a call writing 100 log lines through each framework present on the
test class path (JUL always; logback and log4j 2 as test dependencies), catching on vs off (SC-003 < 5 %), and a
non-recorded call (nothing measurable).
