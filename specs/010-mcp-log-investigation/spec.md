# Feature Specification: Log lines in Claude's investigation tools

**Feature Branch**: `010-mcp-log-investigation`
**Created**: 2026-10-06
**Status**: Clarified
**Input**: User description: "i want to add the logs to the mcp so the mcp can help agents to identify bugs and problems and investigate faster and find the causes .. suggest mcp functionalities"

## Context

Alfred already gives an AI agent (Claude, through Alfred's MCP tools) every recorded call, its supplier calls and the
database statements it ran, and a `triage` that says what needs attention first. Since specs/009 the application's log
lines are caught inside the application and attached to the call that wrote them, in the call's own order. Today the
agent can only read them one call at a time (`call_logs`) and only when it already suspects that call.

This feature makes the log lines a first-class part of the agent's investigation: they raise attention in triage, they
can be searched across all calls, repeated errors are grouped, a call's story reads statements, supplier calls and log
lines in one order, and a logged exception leads straight to the project's source line. The aim is that an agent goes
from "something is wrong" to "this line of code, for this reason" in a few tool calls instead of reading calls one by
one.

## Clarifications

### Session 2026-10-06

- Analysis remediation (2026-10-06): merged the duplicate DB-warning requirement into FR-022 (flags follow current thresholds); imported calls fully investigable (FR-018); per-call Log level recorded (FR-016); pills equality defined for a fully loaded scope; pattern searches time-bounded; "log problem" vs "problem call" terms.
- Owner input: "add more and more to help the MCP; enable it to search logs and identify calls with errors or warnings, whether DB or logs" → added User Story 0 (find problem calls by any signal), stories 9-14 and FR-019..FR-030.
- Q: What scope do problem calls, search and grouped errors cover in one request? → A: All of them - the agent chooses per request: the live calls, one cycle, a named set of cycles (optionally with live), or everything (live and every cycle); a call held in several places counts once.
- Q: Which database signals are warnings (failed statements are errors)? → A: Every flag the database window raises (slow, repeated/N+1, huge result, no WHERE, large delete, transaction per statement, rolled back, lock during supplier call, fan-out).
- Q: How much ships in this feature? → A: All stories, delivered in priority order - P1 first, then P2, then P3.
- Q: May the agent change capture settings (Log level, ▤ and ◆ switches) itself? → A: Yes, freely - it changes them as it sees fit and reports each change in its answer.

## User Scenarios & Testing *(mandatory)*

### User Story 0 - Find every call with an error or a warning, DB or logs (Priority: P1)

The agent asks "which calls have problems?" and gets them in one request, from every source of trouble Alfred knows:
HTTP status (4xx/5xx, no answer), failed database statements, database warnings (slow, N+1, huge result, no WHERE,
large delete, rolled back, lock held during a supplier call), log ERROR lines, log WARN lines, logged exceptions, and
failing supplier calls. It can ask for any combination ("calls with DB warnings but no log errors", "200s that logged
an exception"), for any scope (the live calls, a cycle, several cycles, or everything), and it gets a count per signal before the list - the same numbers the
call list's pills show.

**Why this priority**: This is the question an agent asks first and most often. Today it needs triage plus a call per
suspect; one filterable answer across DB and logs is the fastest route to the calls worth reading.

**Independent Test**: In a cycle with known calls - one 500, one 200 with a failed statement, one with an N+1 flag, one
with an ERROR line, one with WARN lines only, one clean - each filter returns exactly the expected calls and the counts
per signal match the call list's pills.

**Acceptance Scenarios**:

1. **Given** a cycle with calls of every signal, **When** the agent asks for problem calls with no filter, **Then** it gets counts per signal and the calls ordered by severity (errors before warnings), each listing all its signals.
2. **Given** a filter "log errors AND status 200", **When** it runs, **Then** only successful calls that logged an ERROR are returned.
3. **Given** a filter "DB warnings only", **When** it runs, **Then** calls whose only signal is a database flag are returned, each with the flag names.
4. **Given** the live list with every call of the scope loaded, **When** the agent asks, **Then** the counts equal the stats pills the user sees; when the list shows only a page, the agent's counts are the scope's full totals.
5. **Given** a call whose database or log data is unavailable (capture off, agent not attached), **When** it is listed, **Then** that is stated rather than shown as clean.

---

### User Story 1 - Triage counts log errors as evidence (Priority: P1)

A developer asks the agent "what went wrong in this cycle?". The agent runs triage. A call that answered 200 but logged
an ERROR line with an exception (a swallowed failure) is raised into an attention group, with the logged error shown as
its evidence: level, logger, message and exception type, next to its failed statements and failing supplier calls.

**Why this priority**: Triage is the agent's first step in every investigation. A 200 that logged an exception is the
most common bug Alfred cannot see today without opening each call - it is invisible to status-based triage.

**Independent Test**: Record a cycle where one call returns 200 but logs an ERROR with an exception; run triage; the call
appears in an attention group with the error line as evidence, and calls with only INFO lines do not move.

**Acceptance Scenarios**:

1. **Given** a call with status 200 and one ERROR log line carrying an exception, **When** the agent runs triage, **Then** the call is in an attention group (not "the rest") and its evidence shows the line's level, logger, message (masked like bodies) and exception type.
2. **Given** a call with WARN lines only, **When** triage runs, **Then** the warnings are listed as weaker evidence and do not outrank a call with errors.
3. **Given** a call that already failed (5xx) and also logged errors, **When** triage runs, **Then** the call stays in its group once, with the log errors added to its evidence (never listed twice).
4. **Given** a project whose log catching is off, **When** triage runs, **Then** triage says that log lines were not available for that project's calls, instead of implying they had none.

---

### User Story 2 - Search log lines across calls (Priority: P1)

The agent knows a symptom ("NullPointerException", "No enum constant", a booking reference, a supplier name) and asks
which calls logged it. It searches the log lines of the live calls or of one cycle by text, level, logger, exception
type and time range, and gets back the matching lines with the call each belongs to (method, path, status, time), so it
can open the right call directly.

**Why this priority**: Searching is how an agent narrows hundreds of calls to the few that matter; without it the agent
must open every call's lines.

**Independent Test**: With several calls whose lines contain a known text, a search for that text returns exactly those
lines, each with its call, and a search scoped to a cycle returns only that cycle's calls.

**Acceptance Scenarios**:

1. **Given** 200 recorded calls of which 3 logged "No enum constant", **When** the agent searches for that text, **Then** it gets the 3 calls' matching lines, each with its call id, method, path, status and the line's offset in the call.
2. **Given** a search by exception type and level ERROR, **When** results exceed one page, **Then** the agent gets the first page, the total count, and a way to read the next page.
3. **Given** a search scoped to a session cycle, **When** it runs, **Then** only lines of that cycle's calls are returned, including calls the live list no longer holds.
4. **Given** lines that contain secrets covered by the user's masking rules, **When** they are returned, **Then** they are masked exactly as call bodies are.

---

### User Story 3 - Repeated errors grouped into log problems (Priority: P2)

The agent asks "what errors keep happening?". Alfred groups ERROR (and optionally WARN) lines across calls by what they
mean - same logger, same exception type, same message once the varying parts (ids, numbers, timestamps) are set aside -
and returns one entry per problem: how many lines and calls, the first and last time it was seen, the endpoints it
happened on, and one example line with its call.

**Why this priority**: A noisy application logs the same error hundreds of times; an agent reading lines one by one
wastes its budget and misses the rare new error. Grouping turns noise into a short ranked list.

**Independent Test**: Record 50 calls where 40 log the same error with different ids and 2 log a different error; the
grouping returns two problems with counts 40 and 2 and correct first/last seen and endpoints.

**Acceptance Scenarios**:

1. **Given** the same error logged with different ids in many calls, **When** the agent asks for grouped problems, **Then** they form one problem with the total count, number of calls and endpoints.
2. **Given** a problem seen only in the most recent calls, **When** problems are listed, **Then** it is marked as new compared with the earlier calls of the same scope.
3. **Given** grouped problems, **When** the agent picks one, **Then** it can list the calls that had it.

---

### User Story 4 - One call's story in order (Priority: P2)

The agent investigates one call and asks for its story: the inbound request, then every database statement, supplier
call and log line in the exact order they happened, with their offsets from the call's start - the same order the
database window's Together view shows - with long parts shortened and the full item one request away.

**Why this priority**: The cause of a bug is usually the step just before the first error line ("the supplier answered
X, the statement read nothing, then the service logged an error"). Reading three separate lists and lining them up by
time is slow and error-prone for an agent.

**Independent Test**: For a call with statements, one supplier call and log lines, the story lists all of them in the
call's own sequence, and the position of each log line relative to the statements matches the database window's
Together view.

**Acceptance Scenarios**:

1. **Given** a call whose log line was written between two statements, **When** the agent reads the story, **Then** the line appears between those two statements.
2. **Given** a call with thousands of items, **When** the story is requested, **Then** it is returned in pages, and the agent can ask to start at the first error.
3. **Given** a call with no caught lines, **When** the story is read, **Then** it says why (log catching off, agent not attached, or none written at the chosen level).

---

### User Story 5 - From a logged exception to the source line (Priority: P2)

A logged exception carries a stack trace. The agent asks where it came from: the stack's frames that belong to the
application are resolved to files and lines of the project the agent is working in, skipping framework and library
frames, the way statement call chains already are.

**Why this priority**: This is the step that turns an observed error into a code change. The capability already exists
for statements; extending it to exceptions closes the loop for the most common bug evidence.

**Independent Test**: For a logged exception whose stack includes an application class, the agent gets that frame
resolved to the project file and line; library frames are listed as skipped.

**Acceptance Scenarios**:

1. **Given** a logged exception thrown inside an application service, **When** the agent asks for its source, **Then** the first application frame is resolved to the project file and line.
2. **Given** a stack with only framework frames, **When** source is requested, **Then** the agent is told no application frame was found, with the frames shown.

---

### User Story 6 - Compare the logs of a failing and a passing call (Priority: P3)

The agent compares two calls of the same endpoint - one that failed, one that worked - and gets the log lines that only
one of them wrote, aligned where the two runs went separate ways, alongside the existing body and statement comparison.

**Why this priority**: "What did the failing run do differently?" is a fast route to a cause, but it builds on stories 2
and 4.

**Independent Test**: Two calls of one endpoint differing by one extra ERROR line produce a comparison that shows only
that line as different.

**Acceptance Scenarios**:

1. **Given** two calls of the same endpoint, **When** the agent compares them, **Then** the result lists lines only in the first, only in the second, and the first point where they differ, with varying ids and numbers ignored.

---

### User Story 7 - Background work and the moments around a failure (Priority: P3)

Some failures come from work no inbound call caused: scheduled jobs, message listeners, startup. The agent asks what was
logged outside any call around a time (for example, the 2 minutes before a failing call), by thread, filtered by level.

**Why this priority**: Rarer than call-scoped bugs, but otherwise invisible to the agent.

**Independent Test**: With an error logged by a scheduled job one minute before a failing call, a request for
outside-call lines around that call's time returns the job's error with its thread.

**Acceptance Scenarios**:

1. **Given** outside-call lines exist for a project, **When** the agent asks for those around a call's time, **Then** it gets them grouped by thread with their times, levels and messages.

---

### User Story 8 - Waiting for the next error, and the level of detail (Priority: P3)

While a developer reproduces a bug, the agent waits for the next call that logs an error and reads it as soon as it
arrives. When the lines caught are not detailed enough, the agent changes the project's Log level itself (or turns ▤ or
◆ on) and says so, so the next reproduction is captured in more detail.

**Why this priority**: Shortens the reproduce-and-look loop; depends on the earlier stories.

**Independent Test**: Start waiting, trigger a call that logs an error; the wait returns that call with its error line.
Changing the level through the agent changes it in Alfred's settings as if the developer had picked it.

**Acceptance Scenarios**:

1. **Given** the agent is waiting for calls with log errors, **When** a call logs an ERROR line, **Then** the wait returns that call with the line.
2. **Given** a project's Log level is ERROR, **When** the agent sets it to DEBUG, **Then** the next calls are caught at DEBUG, the change shows in Alfred's settings as if the developer had made it, and the agent's answer reports the change and that earlier calls keep what they had.

---

### User Story 9 - The lines around an error (Priority: P2)

The agent found an ERROR line and asks for its context: the lines just before and after it in the same call (or the
same thread outside a call), together with the statements and supplier calls in between - so the step that led to the
error is visible without reading the whole call.

**Why this priority**: The cause is usually in the few items before the error; this is the cheapest way to show them.

**Independent Test**: For an error line with 10 items before it, asking for 3 before and 2 after returns exactly those
items in order.

**Acceptance Scenarios**:

1. **Given** an error line inside a call, **When** the agent asks for its context with a window, **Then** it gets the requested number of items before and after, in the call's order, of every kind.

---

### User Story 10 - Endpoint health (Priority: P2)

The agent asks "which endpoints are unhealthy?" and gets, per endpoint (method + path pattern), the number of calls and
how many had HTTP errors, failed statements, database warnings, log errors and log warnings, with the slowest and median
duration - for any scope.

**Why this priority**: Points the agent at the part of the application that misbehaves before it looks at any single
call.

**Independent Test**: With 20 calls on 3 endpoints and known problems, the summary's counts per endpoint match.

**Acceptance Scenarios**:

1. **Given** calls on several endpoints, **When** the agent asks for endpoint health, **Then** each endpoint shows its call count and per-signal counts, worst first.
2. **Given** paths with ids in them (`/booking/123`), **When** grouped, **Then** they form one endpoint (`/booking/{id}`).

---

### User Story 11 - When problems started (Priority: P3)

The agent asks how errors spread over time: per-minute counts of each signal (HTTP errors, DB failures and warnings,
log errors and warnings) over any scope, with the first minute a problem appeared - to tell a
deployment or data change from a constant bug.

**Why this priority**: Useful for "it worked this morning" bugs; needs the earlier signals.

**Independent Test**: With errors starting at a known minute, the timeline shows zero before and the counts after.

**Acceptance Scenarios**:

1. **Given** errors that began at a known time, **When** the agent asks for the timeline, **Then** the first bucket with errors is that minute.

---

### User Story 12 - Compare two cycles (Priority: P3)

The agent compares two session cycles (before and after a fix, or yesterday and today) and gets the problems that are
new, gone and still present - log problems, failed statements, database warnings and HTTP errors - with counts.

**Why this priority**: Confirms a fix and catches regressions; builds on grouped problems.

**Independent Test**: Two cycles where one error disappears and one appears produce exactly one "gone" and one "new".

**Acceptance Scenarios**:

1. **Given** two cycles, **When** compared, **Then** problems are listed as new, gone or still present, each with counts in both.

---

### User Story 13 - Trace a value through log lines (Priority: P3)

The existing "where does this value appear" for a call (bodies, headers, statements, rows) also looks in its log lines,
so an id that reaches a log message but never the database is still found.

**Why this priority**: Small extension of an existing tool with high payoff for data bugs.

**Independent Test**: A booking reference present only in a log line is found there, with the line's position.

**Acceptance Scenarios**:

1. **Given** a value that appears in a call's log line, **When** the agent traces it, **Then** the line is listed with its level, logger and position in the call.

---

### User Story 14 - A ready-made investigation report (Priority: P3)

The agent asks for an investigation of one call: in one response it gets the call's status and timing, its signals,
the first error (log or database) with the items just before it, the resolved source line of any exception, the
failing supplier calls and the most similar call that succeeded - a starting point it can drill into.

**Why this priority**: Saves several round trips for the commonest case; composed from the other stories.

**Independent Test**: For a call with a logged exception after a failed supplier call, the report names the supplier
call, the error line, and the source line.

**Acceptance Scenarios**:

1. **Given** a failing call, **When** the agent asks to investigate it, **Then** the report contains its signals, first error with context, source line of the exception if any, failing supplier calls and a similar successful call if one exists.

---

### Edge Cases

- A call caught thousands of lines: every tool pages, counts what it did not return, and never silently truncates.
- Lines over the per-line cap were cut when caught: tools say "cut" rather than presenting a partial line as whole.
- Log catching off, agent not attached, or a call recorded before catching started: tools say which, never "no errors".
- A Log level above the problem's level (WARN problems with ERROR level): tools state the level the lines were caught at, so absence is not taken as proof.
- Messages whose varying parts are not recognised (free text with ids inside words): grouping errs toward splitting into separate problems rather than merging different errors.
- A cycle copy and its live call: both resolve to the same lines; a search never lists the same line twice.
- Imported calls (from an export) carry their lines: they are searchable and appear in triage like recorded ones.
- Masking rules change between two requests: each response is masked with the rules current at that moment.
- A call with several signals (5xx, failed statement, ERROR line) appears once in "problem calls", with all its signals.
- Endpoint grouping of paths with ids: unknown shapes stay separate rather than merged.
- Very large scopes (thousands of calls): counts are exact; lists are paged.
- A search pattern that would take very long to match: it is stopped within a fixed time budget and the agent is told the search was cut short and how far it got - it never stalls Alfred.
- A cycle's calls older than the live retention: they stay in every cycle-scoped answer (problem calls, triage, endpoints, timeline).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Triage MUST treat a call's ERROR log lines (and lines carrying an exception) as attention evidence, raising a call that otherwise looks successful into an attention group.
- **FR-002**: Triage evidence for log lines MUST show level, logger, message and exception type of up to a fixed number of lines per call, with a count of the rest.
- **FR-003**: WARN lines MUST count as weaker evidence than ERROR lines and MUST NOT outrank a call with errors, failed statements or failed supplier calls.
- **FR-004**: The agent MUST be able to search log lines within any scope (FR-031) by text, level (at or above), logger, exception type and time range, in pages with a total count.
- **FR-005**: Each search result MUST identify its call (id, method, path, status, time) and the line's offset within the call.
- **FR-006**: The agent MUST be able to list repeated problems: ERROR (optionally WARN) lines grouped by logger, exception type and message with varying parts set aside, each with line count, call count, first and last seen, endpoints and one example.
- **FR-007**: Problems MUST be markable as new when they appear only in the later part of the chosen scope.
- **FR-008**: The agent MUST be able to list the calls that had a given problem.
- **FR-009**: The agent MUST be able to read one call's story: request, database statements, supplier calls and log lines in the call's own order with offsets, paged, optionally starting at the first error.
- **FR-010**: The agent MUST be able to resolve a logged exception's application frames to files and lines of the project it works in, as statement call chains are resolved.
- **FR-011**: The call comparison MUST include log lines: lines only in one call and the first point of difference, ignoring varying ids and numbers.
- **FR-012**: The agent MUST be able to read outside-call lines of a project around a moment, grouped by thread, filtered by level.
- **FR-013**: Waiting for calls MUST support "the next call that logs an error" (and "a warning").
- **FR-014**: The agent MUST be able to read and change a project's Log level and its ▤ (log catching) and ◆ (database capture) switches without asking first, and MUST report every change it made, with the old and new value, in the same answer.
- **FR-015**: Every tool returning log text MUST apply the user's masking rules exactly as for call bodies.
- **FR-016**: Every tool MUST say why lines are missing (catching off, agent not attached, recorded before catching, below the Log level) rather than reporting "none". The Log level a call was caught at MUST be recorded with the call, so "below the level" names the level that applied to that call, not today's setting.
- **FR-017**: No tool may silently truncate: limits are stated, remaining counts given, and a way to read the rest provided.
- **FR-018**: Log lines MUST be part of the existing exports already offered to the agent (unchanged behaviour). Imported calls MUST be investigable exactly like recorded ones: their lines searchable and grouped, and their signals (log and database) present in triage, problem calls, endpoint health and the timeline.
- **FR-019**: The agent MUST be able to list problem calls within any scope (FR-031) by any combination of signals: HTTP error, no answer, failed statement, database warning (named flags), log ERROR, log WARN, logged exception, failing supplier call - with AND/OR/NOT between signals.
- **FR-020**: The problem-calls answer MUST start with the count of calls per signal over the whole scope; for the same set of calls they MUST equal the call list's pills (same signal definitions).
- **FR-021**: Problem calls MUST be ordered by severity (errors before warnings, then most signals first, then newest) and each MUST list all its signals with short evidence.
- **FR-022**: Database warnings MUST be every flag the database window raises (slow, repeated/N+1, huge result, no WHERE, large delete, transaction per statement, rolled back, lock during supplier call, fan-out), named individually; none is left out or treated as a mere note. Stored flags MUST follow the project's current thresholds and expected statements: changing them refreshes the flags of that project's calls.
- **FR-023**: The agent MUST be able to read the context of a log line: a requested number of items before and after it (lines, statements, supplier calls) in the call's order, or in the thread for outside-call lines.
- **FR-024**: The agent MUST be able to get endpoint health within any scope (FR-031): per endpoint, call count, per-signal counts, slowest and median duration, worst first; paths with ids grouped into one endpoint.
- **FR-025**: The agent MUST be able to get per-minute counts of each signal over a scope, with the first minute each problem appeared.
- **FR-026**: The agent MUST be able to compare two cycles' problems: new, gone, still present, with counts in both.
- **FR-027**: Tracing a value in a call MUST also search its log lines.
- **FR-028**: The agent MUST be able to request a one-call investigation report combining signals, first error with context, exception source line, failing supplier calls and the most similar successful call.
- **FR-029**: Log-line search MUST support plain text and patterns, case-insensitive by default, over message, logger, thread and exception text.
- **FR-030**: Every list returned to the agent MUST state its scope (live, cycle names, or everything), the time range covered and whether log or database data was unavailable for any project in it.
- **FR-031**: Every cross-call capability (problem calls, triage, log search, grouped problems, endpoint health, timeline) MUST accept a scope chosen per request: the live calls (default), one cycle, a named set of cycles optionally with the live calls, or everything (the live calls and every cycle). A call held in several places (live and a cycle's copy, or two cycles) MUST count once, and each result MUST say where it is held.

### Key Entities

- **Caught log line**: one line the application wrote during a call (or outside any call): time, offset in the call, position in the call's sequence, level, logger, thread, message, optional exception (type, message, stack), cut flag.
- **Log problem**: a group of ERROR/WARN lines that mean the same thing across calls (distinct from a "problem call", which is any call with a signal): logger, exception type, normalised message, counts, first/last seen, endpoints, example line.
- **Call story**: the ordered items of one call - statements, supplier calls, log lines - with offsets.
- **Log level setting**: per project, the lowest level caught (ERROR by default, or the application's own).
- **Signal**: one kind of trouble on a call - HTTP error, no answer, failed statement, database warning (with its flag), log error, log warning, logged exception, failing supplier call - with severity error or warning.
- **Endpoint**: method and path pattern grouping calls, with its per-signal counts and durations.
- **Scope**: what a cross-call request looks at - the live calls, one cycle, a named set of cycles (with or without live), or everything; calls held in several places count once.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a cycle of 200 calls with one 200-status call that logged an exception, the agent identifies that call as needing attention in one triage request.
- **SC-002**: An agent locates every call that logged a given error text among 1,000 recorded calls with one search request and at most one page turn per 50 results.
- **SC-003**: 1,000 occurrences of the same error with varying ids are reported as one problem; two different errors are never merged in the reference test set.
- **SC-004**: For a logged exception thrown in application code, the agent reaches the project's source file and line in at most two tool calls from triage.
- **SC-005**: A call's story places every log line in the same position as the database window's Together view in 100% of the reference calls.
- **SC-006**: No tool response leaves out data without stating how much and how to get it (verified by tests on oversized calls).
- **SC-007**: Masked values never appear unmasked in any log-returning tool (verified with the same test vectors as bodies).
- **SC-010**: A problem-calls request over everything (live and all cycles) lists each call once, however many places hold it.
- **SC-008**: The agent lists every call with a DB or log error or warning in a 500-call cycle in one request, and, with the cycle fully loaded in the call list, the per-signal counts match its pills exactly.
- **SC-009**: For the reference failing calls, the agent names the cause (first error and the item before it) using at most three tool calls.

## Assumptions

- Log lines come only from the agent's in-JVM catching (specs/009); log files and the Logs tab are not used for calls.
- "Live calls" means the inbound calls Alfred currently holds; older calls are reachable through the session cycle that kept them or through an import.
- Grouping uses the same masking and ignores obvious varying parts (numbers, UUIDs, hex ids, timestamps, quoted values); it is deliberately conservative.
- The agent may change the Log level and the ▤/◆ switches without asking (owner's decision); it always reports what it changed. This deliberately differs from the earlier ask-first habit for switches.
- The existing `call_logs` tool remains and keeps working; new capabilities extend the toolset rather than replacing it.
- Response sizes follow the existing tool budget (a response stays readable in one turn; the rest is paged).
