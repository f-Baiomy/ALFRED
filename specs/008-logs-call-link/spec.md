# Feature Specification: Logs linked to calls

**Feature Branch**: `008-logs-call-link`
**Created**: 2026-10-06
**Status**: Draft
**Input**: User description: "specify the logging logs task" - relate the application's log lines to the calls they were written during, the way database statements are already related to calls (agreed design: `specs/008-logs-call-link/mock.html`).

## Context

ALFRED already records, for every inbound call into a project such as odeysys, the HTTP request and response, the supplier calls it made and the database statements it ran. The same application also writes a log (for odeysys: a WildFly JSON log - one JSON object per line with a time, a level, the thread name, the logger and the message), and ALFRED's Logs tab can already load and search such a file. Today the two are separate: to see what the application logged during a slow or failing call, the user has to note the call's time and thread and search the Logs tab by hand. The log lines carry no call identifier (their correlation field is almost always empty).

This feature joins them: each call shows the log lines written while it ran, next to its statements and supplier calls in time order, and each log line points back to its call.

## Clarifications

### Session 2026-10-06

- Q: Which recorded calls get exact log linking? → A: Every recorded inbound call of the project, with or without database capture; calls without capture show their log lines in a Logs view opened from the call card.
- Q: How are linked log lines treated in exports and Claude's tools, given they can hold secrets? → A: The same as request/response bodies - the project's redaction rules apply (none by default, so verbatim unless rules are set).
- Q: Is exact linking on or off for a project by default? → A: Off until the user turns it on for the project (then one application restart); thread-and-time matching works without it.
- Q: Does a call keep its linked log lines when the Logs tab later drops them? → A: Yes for calls in a session cycle - their linked lines are kept with the cycle; other calls link live only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what the application logged during a call (Priority: P1)

A developer debugging a slow flight search opens the call in ALFRED and, beside its database statements and supplier calls, sees the log lines the application wrote while handling it: "search started", the warnings about slow suppliers, the swallowed error. They read the call's story in one place, in time order, without switching to the Logs tab and searching by time.

**Why this priority**: It is the whole point of the feature and works on log files the user already has - no change to the application, no restart.

**Independent Test**: Load an odeysys log file covering a recorded call into the Logs tab, link that log source to the project, open the call: its log lines appear, each with its level and message, and the count matches the lines of that call's thread within the call's time window.

**Acceptance Scenarios**:

1. **Given** a recorded inbound call with database capture and a loaded log source linked to its project, **When** the user opens the call's database window, **Then** a Logs view lists every log line of the call's request thread written between the call's start and end (within the allowed clock difference), oldest first, each showing time offset, level and message.
2. **Given** the same call, **When** the user chooses "Together", **Then** statements, supplier calls and log lines appear in one list ordered by time.
3. **Given** the call's timeline, **When** the window is open, **Then** a Logs lane shows one mark per log line, coloured by level, and hovering a mark shows the line.
4. **Given** a log line in the list, **When** the user opens it, **Then** every field of that line is shown, with a link that opens it in the Logs tab among its neighbouring lines.
5. **Given** a call card in the calls list, **When** the call has matched log lines, **Then** it shows a "Logs" marker with the number of lines and of errors and warnings; a call with no matched lines shows none.
6. **Given** a call whose project has no log source linked, **When** the user opens it, **Then** the Logs view says no log source is set up and how to set one up, instead of showing an empty list.
7. **Given** a recorded inbound call without database capture that has exactly-linked lines, **When** the user clicks its "Logs" marker on the call card, **Then** a Logs view of that call opens on its own (the same list, without statements).

---

### User Story 2 - Exact linking, even across threads (Priority: P2)

The application tags every log line it writes while handling a call with that call's identity, so ALFRED links lines exactly - including lines written by other classes and helper code, and without depending on clocks agreeing. The user turns this on once for the project; after the application is restarted, new calls are linked exactly.

**Why this priority**: Matching by thread and time (Story 1) is good but can miss lines or include a neighbour's when clocks drift; exact tagging removes the guesswork. It needs one application restart, so it comes second.

**Independent Test**: Turn exact linking on for odeysys, restart it, make a request; every log line written during that request carries the call's identity, and the call's Logs view marks its lines "exact".

**Acceptance Scenarios**:

1. **Given** exact linking is on for a project and the application has been restarted, **When** any recorded inbound call of that project runs - with or without database capture - **Then** every log line it writes while handling that call carries the call's identity, and nothing else in the line changes.
2. **Given** a call with exactly-linked lines, **When** the user opens its Logs view, **Then** those lines are shown with an "exact" marker and the thread-and-time match is not used for that call.
3. **Given** exact linking is on but the application's log format does not write the identity, **When** the user opens the project's log settings, **Then** ALFRED says the identity was found in 0 lines and explains what the log format must include.
4. **Given** a request that ALFRED is not recording, **When** the application handles it, **Then** its log lines carry no identity and the application behaves exactly as without ALFRED.

---

### User Story 3 - From a log line back to its call (Priority: P3)

A developer reading the Logs tab finds an error line and wants to know which request caused it. The line shows the call it was written during - method, path, status, duration - with links to open that call and its database statements.

**Why this priority**: The reverse direction completes the link but most investigations start from a call.

**Independent Test**: Open a log line that falls inside a recorded call in the Logs tab: it shows that call and the link opens it.

**Acceptance Scenarios**:

1. **Given** a log line written during a recorded call, **When** the user opens it in the Logs tab, **Then** it shows "During call" with the call's method, path, status and duration, how it was matched (exact or same thread and time), and links to the call and to its database statements.
2. **Given** a log line written outside any recorded call, **When** the user opens it, **Then** no call is shown.

---

### User Story 4 - Logs in exports and for Claude (Priority: P4)

When a call or cycle is exported (.md, .html, .json), each call carries its matched log lines in time order alongside its statements, so a reader who was not there sees what the application logged. Claude, working through ALFRED's tools, can read a call's log lines the same way.

**Why this priority**: Valuable for sharing and AI-assisted debugging, but builds on Stories 1-3.

**Independent Test**: Export a call with matched log lines in each format: every matched line is present, whole, in time order, and a .json export re-imports with the lines intact.

**Acceptance Scenarios**:

1. **Given** a call with matched log lines, **When** it is exported as .md, .html or .json, **Then** all its matched lines appear in full with their time, level, thread and message, and how they were matched.
2. **Given** a .json export with log lines, **When** it is imported, **Then** the imported call shows the same log lines.
3. **Given** Claude is connected to ALFRED, **When** it asks for a call's log lines, **Then** it receives them in time order with level and message, and can page through a call with many lines.

### Edge Cases

- The log's clock and ALFRED's differ by more than the allowed difference: thread-and-time matching misses lines; the settings show the allowed difference and the user can raise it. Exact linking is unaffected.
- A call hands work to another thread (asynchronous work): with thread-and-time matching those lines are not linked; with exact linking they are linked only if the application passes the identity on (stated in the help text).
- Two calls run on the same thread back to back with less than the allowed difference between them: a line in the overlap is linked to the call whose window contains it; if both do, the nearer one wins and the line is shown once.
- The log file was loaded before the call was recorded, or after: linking works either way, whenever both exist.
- The log lines of a call were removed by the Logs tab's retention while the call remains: a call in a session cycle still shows its kept lines; any other call shows none. The other way round (the call is gone, the line remains): the line shows no call. Nothing fails.
- A call has thousands of log lines: the Logs view and exports page through them; nothing is cut from exports.
- Several log sources are linked to one project (e.g. two server logs): lines from all of them are shown, each marked with its source.
- The project's log uses a different field name for the thread or time: the user picks the fields in the project's log settings.
- A call without database capture has no recorded request thread: only exact linking can link it; with exact linking off, its Logs view says why there are none and that turning exact linking on would link it.

## Requirements *(mandatory)*

### Functional Requirements

**Matching**

- **FR-001**: The system MUST link a log line to an inbound call when the line carries that call's identity (exact).
- **FR-002**: When a call has no exactly-linked lines, the system MUST link the lines of the call's request thread whose time falls within the call's start and end, widened by an allowed clock difference (default 200 ms), and mark them as matched by "same thread and time".
- **FR-003**: The system MUST show, for every linked line, how it was matched.
- **FR-004**: A line MUST be linked to at most one call; when two calls' windows on the same thread both contain it, the call whose window it is nearer the middle of wins.
- **FR-005**: Linking MUST work on log lines already loaded and on lines loaded later, without reloading anything.
- **FR-005a**: For a call held by a session cycle, its linked log lines MUST be kept with the cycle, so the cycle's views and exports still show them after the Logs tab's retention removes them from the log source; lines linked to a call after it joined the cycle are kept too. Calls in no cycle link live only.

**Exact linking**

- **FR-006**: Exact linking MUST be off for every project until the user turns it on; users MUST be able to turn it on and off per project, and it takes effect for requests handled after the application's next restart. Thread-and-time matching works whether it is on or off.
- **FR-007**: While handling any recorded inbound call of a project with exact linking on (whether or not database capture is on for it), the application side MUST make the call's identity available to the application's logging, so each line written during that call carries it; it MUST be removed when the call ends, so later work on the same thread is not tagged.
- **FR-008**: Exact linking MUST NOT change anything the application does or logs other than adding the identity, and MUST tag nothing for requests ALFRED is not recording.

**Setup**

- **FR-009**: Users MUST be able to choose, per project: which loaded log sources belong to it, which field holds the thread, which holds the time (defaulting to the source's time field), which holds the call identity, and the allowed clock difference.
- **FR-010**: The settings MUST show, for the chosen identity field, how many loaded lines carry it, so the user can tell whether exact linking is working.

**Viewing**

- **FR-011**: The call's database window MUST offer a Logs view (the call's lines, oldest first) and a Together view (statements, supplier calls and log lines in one time-ordered list), plus a Logs lane on its timeline with one mark per line coloured by level. A call without database capture MUST offer the same Logs view on its own, opened from its call card.
- **FR-012**: Each log line MUST open to all its fields, with a link that shows it in the Logs tab among its neighbouring lines.
- **FR-013**: The calls list MUST show, on a call with linked lines, the number of lines and of error and warning lines; it MUST fetch these only for calls the user has open or expanded, not for every listed call.
- **FR-014**: A log line in the Logs tab MUST show the call it was written during (method, path, status, duration, how matched) with links to the call and its database statements.

**Exports and tools**

- **FR-015**: The .md, .html and .json exports MUST include every linked log line of each exported call, whole, in time order, with time, level, thread, message and how it was matched; exports MUST NOT cut or summarise them.
- **FR-016**: Importing a .json export MUST restore the calls' log lines.
- **FR-017**: ALFRED's Claude tools MUST be able to list a call's log lines, in time order and paged.
- **FR-017a**: Exports and Claude's tools MUST apply the project's redaction rules to log lines exactly as they apply them to request and response bodies (no rules = verbatim); the live views show lines unmasked, as they show bodies today.

**General**

- **FR-018**: Lists of log lines MUST update when new lines or calls arrive without polling, the same way the rest of ALFRED updates.
- **FR-019**: When a project has no log source set up, every place that would show log lines MUST say so and point to the setup instead of showing an empty list.

### Key Entities

- **Log line link**: a log line (source, line identity) related to one inbound call, with how it was matched (exact, same thread and time) and, for the time match, the clock difference allowed.
- **Kept log lines**: the linked log lines of a call held by a session cycle, copied whole with how they were matched, so they outlive the log source; removed when the call leaves every cycle.
- **Project log settings**: per project - the log sources that belong to it, the thread field, the time field, the call-identity field, the allowed clock difference, and whether exact linking is on.
- **Call's request thread and window**: the thread that handled an inbound call and the call's start and end times - what the time-and-thread match uses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a recorded odeysys flight search with its WildFly log loaded, the user sees the call's log lines next to its statements within 2 seconds of opening the call, with no manual searching.
- **SC-002**: With exact linking on, 100% of log lines the application writes on the request thread during a recorded call are linked to that call, and none from other calls.
- **SC-003**: With thread-and-time matching and clocks within the allowed difference, at least 95% of a call's request-thread lines are linked to it and fewer than 1% of linked lines belong to another call.
- **SC-004**: With exact linking on, a request's response time changes by less than 1 ms on average compared with exact linking off.
- **SC-005**: Every exported call contains all of its linked log lines (verified line for line against the source), and a re-imported export shows the same lines.
- **SC-006**: A developer can go from a log error line to the call that caused it in one click.

## Assumptions

- The application's log is loaded into ALFRED's Logs tab (uploaded, read from the server's logs folder, or followed as it grows); this feature does not add new ways to load logs.
- Log lines record their time to at least the millisecond and the thread that wrote them (odeysys's WildFly JSON log does: `timestamp`, `process.thread.name`).
- Database capture records the thread that handled each inbound call; calls without database capture can only be linked exactly.
- The application's log format can include the logging context (MDC) - WildFly's JSON formatter does by default; if odeysys's format leaves it out, exact linking needs that format setting changed, which ALFRED reports but does not change.
- Exact linking is done by ALFRED's existing database agent inside the application (it already knows each recorded call); the reverse proxy needs no change.
- Linking reads both stores on demand; the calls and the logs keep their own retention and storage as today, except that calls in session cycles keep a copy of their linked lines (FR-005a).
- Outbound (supplier) calls are not linked directly; their log lines appear under the inbound call that made them.
- Out of scope: linking logs of applications ALFRED does not record calls for, log formats other than one JSON object per line, and changing what or how the application logs beyond adding the call identity.
