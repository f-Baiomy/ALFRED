# Feature Specification: Alfred for Claude (MCP server)

**Feature Branch**: `007-alfred-mcp-server`
**Created**: 2026-10-05
**Status**: Draft
**Input**: User description: "Build an MCP server for Alfred so that Claude Code, opened in the odeysys project (a Java/WildFly app whose traffic and database statements Alfred records), can fetch Alfred's recorded data - session cycles, calls (inbound to odeysys and its outbound supplier calls), bodies, database capture (statements, findings, call chains) - and also write: add comments on calls, create session cycles, copy calls into cycles, add spacers. Typical use: 'debug the cycle \"booking fails at payment\"' - Claude reads the cycle story from Alfred, opens the odeysys source files named in the statements' call chains, proposes the fix, and records what it found as a comment on the call in Alfred."

## Clarifications

### Session 2026-10-05

- Q: What may Claude edit on cycle calls? → A: The cycle's structure only: rename, copy calls in (from live calls), remove calls, add/edit/move/delete spacers, and comments. Recorded call content stays read-only.
- Q: How does "rearrange calls" work, given cycle calls are always in recorded-time order? → A: By moving spacers between calls; calls keep time order (no manual call order in v1).
- Q: How does Claude read "selected data" from a call? → A: Both: a list of named fields (e.g. method, url) plus optional free paths into the call's data.
- Q: What can be exported? → A: All: a whole cycle, a chosen list of call ids (live or cycle), or the result of a live-call search.
- Q: Where does an export go? → A: The user defines it: the export is written to the path the user names; with no path, the tool refuses and asks the user where to save.
- Q: Are secrets hidden in tool replies? → A: The user decides. Masking (Alfred's Redactions) can be switched on or off for the session, and per request; exports are always masked as in the UI.
- Q: Where do relative export paths go? → A: With no path, Claude asks each time. If the user names a default save folder for the session, exports with no path or a relative path go there until the session ends or the user changes it.
- (From the clarify request) Added scope: start and stop recording a session cycle, create a session cycle from live calls, comments anchored to a request/response part (headers or body), export as .md/.json/.html.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Debug a recorded session cycle from the application's own project (Priority: P1)

The owner works on odeysys in Claude. They name a session cycle recorded in Alfred, for example "booking fails at payment". Claude reads the cycle as a story: every call in run order with its direction, status and time, the owner's spacers and comments, and for each call that has database capture a one-line summary plus the findings worth acting on (fan-outs, swallowed failures, slow statements). Claude then opens the odeysys source files named in the statements' call chains and explains the cause.

**Why this priority**: This is the reason the feature exists. Without it, the owner copies calls, bodies and SQL out of the Alfred UI by hand into the conversation.

**Independent Test**: With Alfred running and a cycle recorded, ask Claude in the odeysys project to "debug the cycle X". Claude lists the cycle's calls in order, names the failing call, quotes its findings, and cites at least one `File.java:line` from a statement's call chain - with no copy-paste from the owner.

**Acceptance Scenarios**:

1. **Given** a session cycle with inbound and outbound calls, **When** Claude asks for the cycle by name, **Then** Claude receives the calls in run order, each with direction, method, URL, status, duration, any comments, and the spacers in their places.
2. **Given** a cycle call that has database capture, **When** Claude reads the cycle, **Then** that call shows the same summary line and the same findings (excluding pure notes) that the Alfred UI shows for it.
3. **Given** two cycles whose names both contain the text Claude used, **When** Claude asks for the cycle, **Then** Claude is shown both candidates with their ids and asked to choose, instead of silently picking one.

---

### User Story 2 - Drill into one call and its database statements (Priority: P1)

From a cycle or a search, Claude opens one call in full: request and response headers, bodies, timing, and the outbound supplier calls it caused. For a captured call it pages through the statements (filtered, for example only failed or only slow), opens one statement with its parameters, result rows, call chain and originating query-language text, runs the same SQL search the database window offers, and traces where a value first appeared.

**Why this priority**: The cycle story says *where* the problem is; this says *why*. Both are needed for a real fix.

**Independent Test**: Ask Claude about call 500d0cdc-ed5b-459e-9afa-ef7c2996949f (odeysys flight search). Claude reports its overview, identifies the query fan-out at statements #19-#25 and the swallowed failure at #42, and opens statement #42 with its call chain.

**Acceptance Scenarios**:

1. **Given** a call with a body larger than one page of output, **When** Claude reads the call, **Then** Claude sees the body's full size and the first part, and can request the following parts until the end - nothing is silently cut off.
2. **Given** an inbound call that caused outbound supplier calls, **When** Claude reads it, **Then** the supplier calls are listed with ids Claude can open next.
3. **Given** a captured call with hundreds of statements, **When** Claude lists statements filtered to failures, **Then** only failed statements are returned, in pages, each with its sequence number.
4. **Given** a statement, **When** Claude opens it, **Then** it shows parameters, rows, the application call chain (class, method, file and line) and the originating query text when one exists.

---

### User Story 3 - Record findings back into Alfred (Priority: P2)

Having found the cause, Claude writes a comment on the call in Alfred, visibly marked as written by Claude, so the owner and colleagues see it in the Alfred UI next to the call. The comment is attached to the exact part it is about - request headers, request body, response headers or response body - and to a line in that part, as a comment written in the UI is. Claude can delete a comment it wrote by mistake.

**Why this priority**: Turns a conversation into a durable note on the evidence. Valuable, but debugging works without it.

**Independent Test**: Ask Claude to "note on that call that the fan-out comes from SystemSettingService.java:75". The comment appears in the Alfred UI on that call, marked as Claude's.

**Acceptance Scenarios**:

1. **Given** a call, **When** Claude adds a comment, **Then** the comment appears on that call in the Alfred UI without a page reload, and is clearly distinguishable from a human comment.
2. **Given** a call's response body, **When** Claude adds a comment on line 12 of the response body, **Then** the UI shows the comment on that line of the response body, not on the request.
3. **Given** a comment Claude added, **When** Claude deletes it by id, **Then** it disappears from the call.

---

### User Story 4 - Organise evidence into session cycles (Priority: P2)

Claude creates a session cycle - empty, or directly from chosen live calls - renames it, copies chosen calls (inbound or outbound) into it, removes calls from it, and adds, relabels, moves and deletes spacers to split the story into steps - for example to prepare a clean reproduction of a bug for a colleague. Calls always stay in recorded-time order; "rearranging" the story means moving spacers between calls.

**Why this priority**: Useful for preparing hand-offs; the owner can also do it in the UI.

**Independent Test**: Ask Claude to "put the flight search call into a new cycle called 'fan-out repro' with a spacer 'search' above it". The cycle appears in the Session Cycles tab with that call and spacer.

**Acceptance Scenarios**:

1. **Given** no cycle named X, **When** Claude creates cycle X, **Then** it appears in the Session Cycles tab.
2. **Given** a cycle and an inbound and an outbound call, **When** Claude copies both into the cycle, **Then** both appear in it in time order, and the originals stay in the live log.
3. **Given** a cycle with calls, **When** Claude adds a spacer after a call, **Then** the spacer is shown after that call in every Alfred view of the cycle.
4. **Given** a cycle, **When** Claude removes a call from it, **Then** only that copy is removed from the cycle.
5. **Given** three live call ids, **When** Claude creates cycle "repro" from them, **Then** one new cycle exists containing exactly those three calls.
6. **Given** a cycle with a spacer, **When** Claude moves the spacer below a later call or changes its label, **Then** every Alfred view shows the spacer in its new place with the new label; deleting it removes it from every view.

---

### User Story 6 - Record a session cycle while reproducing (Priority: P2)

The owner says "record a cycle 'payment retry' while I click through the booking". Claude creates the cycle (or picks an existing one), starts recording, and the owner reproduces the problem in odeysys. When the owner says "stop", Claude stops recording and reads the recorded cycle.

**Why this priority**: Recording from the conversation removes the trip to the Alfred UI at the start and the end of every reproduction.

**Independent Test**: Ask Claude to start recording a new cycle, send two requests through odeysys, ask Claude to stop. The cycle contains those calls, and calls made after "stop" are not in it.

**Acceptance Scenarios**:

1. **Given** a cycle that is not recording, **When** Claude starts recording, **Then** the Alfred UI shows the cycle as recording and new calls are captured into it.
2. **Given** a recording cycle, **When** Claude stops recording, **Then** no further calls are captured into it and the calls already captured stay.
3. **Given** Claude asks for a cycle's state, **Then** it is told whether the cycle is recording.

---

### User Story 7 - Export calls as files (Priority: P3)

Claude exports a whole cycle, a chosen list of calls, or the result of a live-call search as .md, .json or .html - the same files the Alfred UI exports - to a path the owner names, for example to attach to a ticket.

**Why this priority**: Hand-off convenience; the UI already exports.

**Independent Test**: Ask Claude to "export the cycle 'fan-out repro' as html to C:/tmp/repro.html". The file exists, opens in a browser, and matches the UI's export of the same cycle.

**Acceptance Scenarios**:

1. **Given** a cycle, **When** Claude exports it as .md, .json or .html to a named path, **Then** the file is written there, complete, with the same content the UI's export of that cycle produces, and Claude reports the path and size.
2. **Given** an export request with no path and no session default folder, **When** Claude calls the export, **Then** nothing is written and Claude asks the owner where to save.
3. **Given** the owner said "save exports to C:/tmp/alfred this session", **When** Claude exports without a path or with a relative path, **Then** the file is written under C:/tmp/alfred without asking.
4. **Given** a .json export, **When** it is imported into Alfred, **Then** it imports like a UI export.

---

### User Story 5 - Find calls without a cycle (Priority: P3)

When the owner has not recorded a cycle, Claude searches the live log: by project or service (for example odeysys), direction, URL text, status, time range, or only slow or failed calls, and gets short rows with ids to open.

**Why this priority**: Covers ad-hoc questions ("what failed in the last ten minutes?"). Cycles remain the main path.

**Independent Test**: Ask Claude "which odeysys calls failed in the last 15 minutes?" and get a short list with ids, statuses and times.

**Acceptance Scenarios**:

1. **Given** recorded inbound and outbound calls, **When** Claude searches for failed odeysys calls in a time range, **Then** only matching calls are returned, newest first, paged.
2. **Given** a search with more results than one page, **When** Claude asks for the next page, **Then** it gets the next results without repeats.
3. **Given** a search or a single call, **When** Claude asks only for chosen fields (e.g. method and URL), **Then** only those fields are returned for each call.

---

### Edge Cases

- Alfred is not running or not reachable: every tool returns a short, clear message naming the address it tried and how to start Alfred; Claude is never left waiting.
- An id that does not exist (call, cycle, statement, comment): a clear "not found" naming the id, never an empty success.
- A call with no database capture: database tools say so plainly instead of returning an empty overview.
- Inbound logging for a project switched off, or the inbound ring buffer already dropped an old call: the tool says the call is no longer in the live log; if the call is in a cycle, the cycle copy is still readable.
- Binary or compressed bodies: reported with type and size, not dumped as garbage text.
- Very large cycles (hundreds of calls) or captures (thousands of statements): results are paged; each page states the total and how to get the next.
- Recorded data contains real credentials, tokens and personal data (kept verbatim by design in Alfred): the server sends them only to the local Claude session, never anywhere else; the user decides whether replies are masked (FR-017f). With masking off, the data reaches the model provider through the Claude session - the docs say so.
- A write that partly fails (for example copying three calls where one id is wrong): the result says which items succeeded and which failed.
- Start recording on a cycle that is already recording, or stop one that is not: the tool reports the current state and changes nothing.
- Starting recording while another cycle is already recording: the tool follows Alfred's existing rule for that and reports which cycle is recording afterwards.
- Export path that is not writable or already exists: the tool reports the error; an existing file is not overwritten unless the user asked for overwrite.
- Selected field name that does not exist, or a free path that matches nothing: the tool says so for that field instead of failing the whole read.
- Moving a spacer to after a call that is not in the cycle: rejected with a clear message.

## Requirements *(mandatory)*

### Functional Requirements

**Reading**

- **FR-001**: Claude MUST be able to list session cycles with id, name, call count and creation time, and find a cycle by id or by name text.
- **FR-002**: Claude MUST be able to read one cycle as an ordered story: its calls in run order (inbound and outbound together) with direction, method, URL, status, duration and time; the spacers in their positions with labels; and the comments on each call.
- **FR-003**: For each cycle call with database capture, the cycle story MUST include the capture's one-line summary and its findings except pure notes, identical in content to what the Alfred UI shows for the same call.
- **FR-004**: Claude MUST be able to search recorded calls by project/service, direction (inbound, outbound, both), URL text, status or status class, time range, and "only failed" / "only slow", returning short rows (id, direction, method, URL, status, duration, time) newest first, paged.
- **FR-005**: Claude MUST be able to read one call in full: request and response headers, bodies with their full sizes, timing, and the outbound supplier calls linked to it as children, each with an id.
- **FR-006**: Bodies longer than one output page MUST be pageable by offset so Claude can read the whole body; no tool may truncate data without stating the full size and how to read the rest.
- **FR-007**: Claude MUST be able to read a call's database overview: the summary line, time breakdown, query totals and findings, consistent with the Alfred UI.
- **FR-008**: Claude MUST be able to list a call's database statements filtered (for example by failure, slowness, table or text) and paged, each row with its sequence number, kind, duration and a short SQL preview.
- **FR-009**: Claude MUST be able to open one statement with its full SQL, parameters, result rows (paged when large), application call chain (class, method, file, line) and originating query-language text when captured.
- **FR-010**: Claude MUST be able to run the database window's SQL search over one call's statements and get the same results the UI gets.
- **FR-011**: Claude MUST be able to trace a value through a call's capture (where it first appeared and where it was used), as the UI's trace feature does.
- **FR-012**: Claude MUST be able to list the comments on a call, each with the part (request/response headers/body) and line it is attached to.
- **FR-012a**: Every call read (single call, cycle story, search) MUST accept a selection of what to return: a list of named fields (at least id, direction, method, url, status, duration, time, requestHeaders, requestBody, responseHeaders, responseBody, timing, children, comments, db) and, optionally, free paths into the call's data. With no selection, a sensible default is returned (short rows for lists, the full call for a single call).
- **FR-012b**: Claude MUST be able to read whether a cycle is currently recording.

**Writing**

- **FR-013**: Claude MUST be able to add a comment to a call (inbound or outbound), attached to a chosen part - request headers, request body, response headers or response body - and a line in that part, exactly as UI comments are anchored; every comment Claude writes MUST be visibly marked as written by Claude in the Alfred UI.
- **FR-014**: Claude MUST be able to delete a comment by id.
- **FR-015**: Claude MUST be able to create a session cycle with a name - empty, or in one step from a list of live call ids (inbound and/or outbound) - and rename an existing cycle.
- **FR-016**: Claude MUST be able to copy inbound and outbound calls into a cycle and remove calls from a cycle, with a per-item success/failure result.
- **FR-017**: Claude MUST be able to add a labelled spacer after a given call in a cycle, change a spacer's label, move a spacer to after another call, and delete a spacer; spacers MUST follow Alfred's existing spacer placement rules so every Alfred view shows them in the same place.
- **FR-017a**: Calls in a cycle MUST stay in recorded-time order; rearranging a cycle's story is done only by moving spacers. Recorded call content (method, URL, headers, bodies, status) is read-only.
- **FR-017b**: Claude MUST be able to start recording a cycle and stop (pause) recording it, with the same effect as the UI's record and pause controls.
- **FR-017c**: Claude MUST be able to export a whole cycle, a list of call ids (live or cycle), or the result of a live-call search as .md, .json or .html. The file MUST have the same content as the UI's export of the same calls (including never truncating, the "About This Document" section in .md/.html/.json, and .json being importable into Alfred).
- **FR-017d**: An export MUST be written only to a path the user names, or into the session's default save folder when the user has set one; when neither is given (or a relative path is given with no default folder), the tool MUST write nothing and ask for a location. The result reports the absolute path and file size; the file content is not echoed into the conversation.
- **FR-017e**: The user MUST be able to set, change and clear a default save folder for the current session; it lasts until the session ends and is never stored on disk.
- **FR-017f**: The user MUST be able to switch masking of secrets in tool replies on or off for the current session (initial value configurable at registration, default off), and to override it for a single request. Masking uses Alfred's existing Redactions, the same rules the exports use. Every reply states whether it was masked and how many values were hidden.
- **FR-018**: Changes Claude makes MUST appear in an open Alfred UI the same way changes made in the UI do (live, without reload).

**Boundaries and safety**

- **FR-019**: The first version MUST NOT offer: deleting or clearing a whole cycle, editing recorded call content, reordering calls, resending calls, editing interception rules, switching proxy logging or database capture on/off, or running Relive cycles - anything that changes live traffic or destroys recorded evidence in bulk. (Starting/stopping a cycle's recording is allowed: it only decides which calls are copied into the cycle.)
- **FR-020**: The server MUST only be reachable by the local Claude session that started it; it MUST NOT open any network listener of its own.
- **FR-021**: The server MUST only talk to the Alfred address it is configured with (default: the local Alfred gateway) and MUST NOT send recorded data to any other destination.
- **FR-022**: The server MUST NOT require any change to Alfred's backend, proxies, containers or deployment; it uses only what the Alfred UI already uses.
- **FR-023**: Every tool MUST return a clear error (unreachable, not found, invalid input) instead of an empty or misleading success.
- **FR-024**: Tools MUST fetch on demand only; nothing polls Alfred in the background.

**Setup and documentation**

- **FR-025**: The owner MUST be able to register the server once so it is available in any project on the machine (including odeysys), with a per-project alternative documented.
- **FR-026**: Alfred's documentation MUST include a page "Using Alfred from Claude (MCP)" covering setup, the tool list, typical prompts, and the data-sensitivity warning, linked from the project guidance file.

### Key Entities

- **Call**: one recorded HTTP exchange, either inbound (into a project Alfred fronts, e.g. odeysys) or outbound (from the app to a supplier). Has id, direction, method, URL, status, timing, headers, bodies, optional parent call (outbound children of an inbound call), optional database capture, comments.
- **Session cycle**: a named, recorded or assembled set of copied calls, plus spacers. Has a recording state (recording / not recording). Calls are ordered by recorded time. Copies survive after the live log drops the originals.
- **Spacer**: a labelled separator in a cycle, anchored to the call above it; can be relabelled, moved or deleted.
- **Comment**: free text attached to a call at a part (request headers, request body, response headers, response body) and a line in that part; Claude-authored comments are marked as such.
- **Export**: a .md, .json or .html file of a set of calls (a cycle, chosen ids, or a search result), identical to the UI's export, written to a user-named path.
- **Database capture**: the statements one inbound call executed, with an overview (summary line, time breakdown, totals) and findings (fan-out, swallowed failure, slow statement, notes).
- **Statement**: one database statement with sequence number, SQL, parameters, rows, duration, outcome, application call chain and optional originating query text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the odeysys project, "debug the cycle X" produces a reply that names the failing call, its findings and at least one source location from a call chain, with zero manual copy-paste from the Alfred UI.
- **SC-002**: For call 500d0cdc-ed5b-459e-9afa-ef7c2996949f, Claude's overview reports the query fan-out at statements #19-#25 and the swallowed failure at #42 - the same findings the Alfred UI shows.
- **SC-003**: For every captured call tested, the summary line and non-note findings Claude receives match the Alfred UI exactly (100% agreement).
- **SC-004**: A comment, cycle, copied call and spacer created by Claude appear in an already-open Alfred UI within 2 seconds without reload, and the test comment and cycle can be removed afterwards leaving no trace.
- **SC-005**: Any single tool reply fits comfortably in one conversation turn (default page well under 20,000 characters), while every body and statement remains fully readable through paging.
- **SC-006**: With Alfred stopped, every tool answers within 5 seconds with a message that says Alfred is unreachable and how to start it.
- **SC-007**: One-time setup takes the owner under 5 minutes following the documentation page.
- **SC-008**: For the same cycle, the .md, .json and .html files Claude exports are identical to the UI's exports apart from generation timestamps, and the .json re-imports into Alfred with the same calls.
- **SC-009**: A cycle Claude starts and stops recording contains every call made between the two commands and none made after stop.
- **SC-010**: Reading only "method, url" for 100 calls returns a reply at least 10 times smaller than reading them in full.

## Assumptions

- Single user on a single machine: the owner's Claude session and Alfred run on the same computer (or Alfred is reachable at a configured address); Alfred has no authentication today, so the server adds none.
- "Project/service" for search means the named projects Alfred's reverse proxy fronts (e.g. odeysys) for inbound calls and the target host for outbound calls.
- "Slow" uses the same threshold the Alfred UI uses; if the UI has none for calls, a sensible default (e.g. 1 second) is configurable per search.
- Claude-authored comments are marked with a visible prefix (e.g. 🤖) unless the comments feature already supports an author field, in which case that field is used.
- Paging defaults (rows per page, body characters per page) are chosen so a reply stays well under the size in SC-005; Claude can ask for larger or next pages.
- Decided design constraints (agreed with the owner, not to be reopened): a local process started by Claude Code over standard input/output, no container, no new docker-compose service, no new backend endpoints; it calls the existing Alfred HTTP API through the gateway at a configurable address (default `http://localhost:3000`); it lives in `mcp-server/` in the Alfred repo, written in TypeScript; the database summary and findings logic is reused directly from the frontend's existing pure functions (`db-findings.ts`, `db-analysis.ts`) rather than re-implemented, so Claude and the UI never disagree. The same applies to exports: the frontend's existing export builders are reused, not re-implemented; if a builder cannot run outside the browser, planning must resolve that without forking the format.
- Live verification uses the running Alfred instance and the existing recorded call 500d0cdc-ed5b-459e-9afa-ef7c2996949f; test comment and test cycle are deleted afterwards (cleanup of the test cycle may be done by the test harness through the existing API even though cycle deletion is not offered as a Claude tool).
- Depends on: existing Alfred features - calls (outbound), internal calls (inbound), comments, session cycles with spacers, database capture - and their current HTTP API as used by the frontend.
