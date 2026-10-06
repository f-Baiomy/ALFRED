# Feature Specification: Log lines caught by the agent

**Feature Branch**: `009-agent-log-capture`
**Created**: 2026-10-06
**Status**: Draft
**Input**: User description: "The db-agent catches the application's log events directly inside the JVM (every logger - jboss-logmanager, log4j, logback, java.util.logging - whatever file or format they are written to) and links each to the inbound call it was written during, without depending on log files or the Logs tab's watched folders. Per-project switch like ◆ and ▤. Each call's lines kept with size caps, shown in the database window's Logs and Together views, the card chip, exports and Claude's call_logs - replacing file-based linking for projects where it is on."

## Context

Feature 008 links an application's log lines to its calls by reading log **files** the user has loaded in the Logs tab: the agent tags each request's log lines with the call id, the application writes them to its files, and ALFRED reads the files back and matches them. In practice that only covers what the files hold, in a form ALFRED can read: for odeysys only `detail.log` is JSON, so the lines in `main.log` and `server.log` (plain text) - most of what the application logs, Hibernate and the application's own classes - never reach a call. It also needs the files to be reachable (a watched folder on the same machine) and the formatter to write the tag.

This feature removes the files from the path: the agent, already inside the application's JVM for database capture, receives every log event the application emits while handling a recorded call - whichever logger wrote it, whatever file, console or format it goes to - and sends it to ALFRED with the call it belongs to. The call's Logs view, its card marker, its exports and Claude's tools then show those lines exactly as they do today, but complete and without any log-file setup.

## Terms

- **Caught lines**: log events the agent receives inside the application and sends to ALFRED, already attached to their call.
- **File lines**: lines read from log files in the Logs tab and matched to calls (feature 008).
- **Log source of a project**: where its calls' lines come from - the agent (caught lines) or its log files (file lines).

## Clarifications

### Session 2026-10-06

- Q: How is log catching switched on per project? → A: The existing ▤ switch: while the agent is attached to the project, ▤ on means caught lines; log files are used only for a project with no agent loaded. No separate switch, no source choice.
- Q: Are lines written outside any recorded call (startup, scheduled jobs, message listeners) caught? → A: Yes - shown like the database window's "outside any call" view, grouped by thread.
- Q: Which log levels are caught? → A: Exactly what the application's own logging configuration lets through; catching never makes it log more.
- Q: How long are caught lines kept? → A: With the database statements: the same store and size cap, and as long as a session cycle holds the call.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every line a call logged, with no log-file setup (Priority: P1)

A developer debugging a slow odeysys search turns on log catching for odeysys, makes the request and opens the call. Its Logs view lists every log line the application wrote while handling it - the application's own loggers, Hibernate, the container - in order, each with its level, logger, thread and message, and any exception with its stack trace. No log file was loaded, no folder watched, no formatter changed.

**Why this priority**: It is the feature: complete logs per call, exact, with nothing to set up but a switch. It fixes today's gap where only one JSON file links and most lines never reach a call.

**Independent Test**: With no log source loaded in the Logs tab, turn catching on for odeysys, make one request, open the call: its Logs view shows the lines the application wrote for that request (compare with the application's own log files for that thread and time: every line is there).

**Acceptance Scenarios**:

1. **Given** catching is on for a project and the agent is loaded, **When** a recorded inbound call runs, **Then** every log event the application emits on that call's request thread - and on threads the call hands work to - between the call's start and end is caught and attached to the call.
2. **Given** such a call, **When** the user opens its database window, **Then** the Logs view lists its caught lines oldest first, each with time offset, level, logger, thread and message; a line with an exception shows the exception and its stack trace.
3. **Given** the same call, **When** the user chooses "Together", **Then** its statements, supplier calls and caught lines appear in one list by time, in the exact order they happened in the application.
4. **Given** a call with caught lines, **When** it is shown in the calls list, **Then** its card shows the "▤ Logs" marker with the number of lines, errors and warnings.
5. **Given** a recorded call of a project with catching on but no database capture, **When** the user clicks its Logs marker, **Then** the logs-only window opens with its caught lines.
6. **Given** a log event the application's own logging configuration would not emit (below its configured level), **When** the call runs, **Then** it is not caught - catching never makes the application log more than it already does.

---

### User Story 2 - The ▤ switch decides, the agent wins (Priority: P2)

The existing ▤ switch (Sources bar of Live calls and Session cycles, and the project's settings) turns logs on and off per project, live. While the agent is attached to the project, ▤ on means the agent catches the lines; the project's log files are used only when no agent is loaded (feature 008 as today). There is no second switch and nothing to choose.

**Why this priority**: Without the switch nothing is caught; the rule that the agent wins keeps a call from showing the same line twice.

**Independent Test**: With the agent attached, turn ▤ on, make a request: caught lines. Turn ▤ off: the next request gets none. Stop the agent's application and use a project with only a log file linked: file lines, as in 008.

**Acceptance Scenarios**:

1. **Given** the agent is attached and ▤ is off, **When** the user turns ▤ on, **Then** calls recorded from then on get caught lines; calls recorded before keep whatever they had.
2. **Given** the agent is attached and ▤ is on, **When** a call is opened, **Then** it shows only its caught lines - the project's log files are not matched to it, so no line appears twice.
3. **Given** no agent is loaded for the project and ▤ is on, **When** a call is opened, **Then** its lines come from the project's log files, as in feature 008.
4. **Given** the project's call logging is off, **When** the user looks at ▤, **Then** it is blocked with the same explanation as ◆.
5. **Given** ▤ is on, **When** the user hovers it, **Then** it says where the lines come from ("caught by the agent" or "from log files").

---

### User Story 3 - Caught lines everywhere the call goes (Priority: P3)

Caught lines travel with their call: in session cycles (kept as long as the cycle holds the call), in .md / .html / .json exports and back in through import, and in Claude's `call_logs` tool - masked like bodies, never cut.

**Why this priority**: Needed so the feature is not a viewer-only addition, but it reuses what feature 008 already built for file lines.

**Independent Test**: Record a call with caught lines into a cycle, export the cycle as .json, import it elsewhere: the call shows the same lines; ask Claude's `call_logs` for it: the same lines, masked by the project's redaction rules.

**Acceptance Scenarios**:

1. **Given** a call with caught lines in a session cycle, **When** the live list or the size cap drops the call, **Then** the cycle still shows its lines.
2. **Given** an export of calls with caught lines, **When** it is written, **Then** every line is in it whole (.md table and raw lines, .html block, .json records) and re-imports to the same lines.
3. **Given** a redaction rule for a body key, **When** a caught line's message or fields hold that key, **Then** exports and Claude's tools show it masked, as for bodies.

---

### User Story 4 - What the application logged outside any call (Priority: P4)

Startup, scheduled jobs and message listeners log too. With ▤ on, those lines are caught as well and shown in the database window's "outside any call" view, grouped by thread, next to the statements that ran there.

**Why this priority**: Useful for jobs that change data or fail between requests, but the per-call view is the main value.

**Independent Test**: With ▤ on, let a scheduled job run (or restart a deployment): its lines appear under "outside any call", grouped by its thread.

**Acceptance Scenarios**:

1. **Given** ▤ on with the agent attached, **When** a thread working for no recorded call logs, **Then** the line is caught and shown in "outside any call", under its thread, in time order with that thread's statements.
2. **Given** a background job logging heavily, **When** the outside-call lines exceed their bound, **Then** the oldest are dropped and counted - per-call lines are never displaced by them.


### Edge Cases

- A call that logs enormously (a loop logging per row): lines over the per-call cap are not kept; the call says how many were dropped, like statements' "not kept".
- A single huge line (a full response body logged): kept up to a per-line size cap, marked as cut in the stored line - the application's own output is never touched.
- Work handed to another thread (an executor, an async task) logs after the request ended: lines are attached to the call while it is still open; lines arriving after it closed are attached for 5 seconds (FR-013), then dropped with a count.
- The same JVM logs through two frameworks (slf4j over jboss-logmanager, plus java.util.logging): each event is caught once.
- The application logs while ALFRED's backend is unreachable: lines queue in the agent up to a bound, then are dropped and counted - the application is never slowed or blocked.
- A burst of outside-call logging (a job logging per row, a startup storm): bounded separately from call lines; overflow is dropped and counted.
- A log event whose message formatting throws (a broken toString in a parameter): the line is kept with what could be formatted; the application's own logging is unaffected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent MUST catch log events emitted inside the application through any of jboss-logmanager, java.util.logging, log4j 1, log4j 2 and logback (and slf4j / jboss-logging over them), without reading any log file.
- **FR-002**: A caught event MUST be attached to the recorded inbound call whose request thread emitted it, or to the call that handed work to the emitting thread; an event on a thread working for no recorded call MUST be kept as an outside-call line under its thread.
- **FR-003**: Only events the application's own logging configuration lets through (its effective level for that logger) MUST be caught; catching MUST NOT change what the application logs, where, or how.
- **FR-004**: Each caught line MUST carry its time, level, logger, thread, formatted message, and the exception with its stack trace when present, plus its order within the call relative to the call's statements and supplier calls.
- **FR-005**: The existing ▤ switch MUST turn catching on and off per project, live: while the agent is attached to the project, ▤ on means caught lines; with no agent loaded, ▤ keeps feature 008's file linking. No separate switch; ▤ stays blocked while the project's call logging is off, and its tooltip says where the lines come from.
- **FR-006**: While the agent is attached and ▤ is on, the project's calls MUST show caught lines only; file lines MUST NOT be matched to those calls. Calls recorded while it was off keep what they had.
- **FR-007**: Per call, at most 5,000 lines and 2 MB of line text MUST be kept, and each line at most 32 KB; anything beyond MUST be dropped or cut and counted, and the count shown with the call.
- **FR-008**: The agent MUST never block or slow the application waiting for ALFRED: caught lines are queued with a bound and dropped (counted) when the queue is full or ALFRED is unreachable.
- **FR-009**: Caught lines MUST appear in the database window's Logs and Together views, the timeline's Logs lane, the card's "▤ Logs" marker and the logs-only window, exactly as file lines do today, marked as caught.
- **FR-010**: Caught lines MUST be kept as long as their call's database statements are (the same size cap), and for as long as a session cycle holds the call.
- **FR-011**: Caught lines MUST be included whole in .md, .html and .json exports and restored by import, and returned by Claude's `call_logs` tool.
- **FR-012**: Caught lines MUST be masked like request/response bodies (the project's redaction rules, and Claude's session masking) wherever they leave ALFRED's own views.
- **FR-013**: Lines handed to ALFRED after their call ended (late work on another thread) MUST be attached for up to 5 seconds after the call's end, then dropped and counted.
- **FR-014**: The agent MUST log its own failures to catch (an unknown framework version, a formatting error) at most once per kind, never into the application's log output as an error the application did not cause.
- **FR-015**: Outside-call lines MUST be shown in the database window's "outside any call" view grouped by thread, ordered by time with that thread's statements, kept within their own bound (separate from the per-call caps) inside the same store and size cap as statements, with overflow dropped oldest-first and counted.

### Key Entities

- **Caught line**: one log event of a call - call, order in the call, time, level, logger, thread, message, exception (type, message, stack), cut flag.
- **Call log summary**: per call - lines kept, lines dropped, bytes, errors, warnings.
- **Outside-call line**: a caught line on a thread working for no recorded call - thread, time, level, logger, message, exception.
- **▤ switch**: per project, on/off; with the agent attached it means caught lines, otherwise file lines (feature 008).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a recorded odeysys call, at least 99% of the lines the application wrote for that request (as found in its own log files for that thread and time) appear in the call's Logs view, with no log file loaded in ALFRED.
- **SC-002**: No caught line is attached to the wrong call (0 in a run of 100 concurrent recorded calls).
- **SC-003**: Catching adds less than 5% to a recorded call's duration for a call writing 100 lines, and nothing measurable to calls that are not recorded.
- **SC-004**: A call's Logs view shows its lines within 2 seconds of the call ending.
- **SC-005**: Turning catching on or off takes effect on the next request, with no application restart once the agent is loaded.

## Assumptions

- The db-agent (feature 006) is the carrier: catching works wherever database capture can be loaded (the same JVMs, Java 8+, WildFly/JBoss modules) and needs its first load or a restart only once.
- The application's effective log level is respected as-is; raising it (e.g. to DEBUG) is done in the application's own configuration, not by ALFRED.
- Caught lines are stored by ALFRED like database statements (same store and cap), not in the Logs tab's sources; the Logs tab stays a tool for log files.
- Feature 008's file linking stays for projects or deployments without the agent and for log files from other systems.
- Masking defaults to none (verbatim), as for bodies, unless redaction rules are set.
