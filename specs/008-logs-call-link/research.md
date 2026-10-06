# Research: Logs linked to calls

All Technical Context unknowns are resolved below. Facts were read from the code on branch `008-logs-call-link`.

## R1 - Where the call identity comes from

- **Decision**: reuse the `X-Alfred-Call` header the reverse proxy already adds to every logged inbound call
  (`id=<callId>; db=0|1[; run=…]`, `proxy/log_and_route_reverse.py` `alfred_call_header`), adding `log=1` when the
  project's **▤ switch** is on. The switch is a flag file exactly like ◆'s (`proxy/log-link-enabled.flag`,
  one `project=on|off` line each, written by a `FileLogLinkToggleAdapter` beside `FileDbCaptureToggleAdapter`,
  read mtime-cached by the proxy - `_ToggleState('LOG_LINK_TOGGLE_FILE', default=False)`). Live, no agent restart.
- **Rationale**: the proxy already sends it for every logged inbound call, `db=0` included; only the agent's
  `CallContext.fromHeader` ignores `db=0` today.
- **Alternatives**: a second header for logging (pointless - same id); a servlet filter in odeysys (an app code change, rejected by the owner).

## R2 - How the agent tags log lines (exact linking)

- **Decision**: in `CaptureDispatcher.servletEnter`, when the header says `log=1`, parse the
  header's `id` whatever `db` says and put `alfred.call=<id>` into every logging MDC visible to the request
  thread's context class loader, restoring the previous value in `servletExit` (finally). Candidates, each probed
  once per class loader and cached (`ClassValue`/weak map, the same reason `OriginTracker` caches per class -
  odeysys runs two deployments): `org.jboss.logmanager.MDC` (what WildFly's JSON formatter reads),
  `org.slf4j.MDC`, `org.apache.logging.log4j.ThreadContext`, `org.apache.log4j.MDC`, `org.jboss.logging.MDC`.
  Statement capture still needs `db=1`; the MDC tag is independent of it.
- **Executor hand-off**: `ContextPropagation`/`wrapRunnable` already carries the call to pooled threads; the
  wrapper sets and clears the same MDC key around the task, so async work is tagged too (better than the spec's
  minimum).
- **Rationale**: MDC is read by every Java logging stack at write time; WildFly's JSON formatter writes the MDC
  map by default (`"mdc": {"alfred.call": "…"}`). Reflection keeps the agent free of logging dependencies
  (Java 8, no new jars). Cost: two map puts per request (measured target < 1 ms, SC-004; expected µs).
- **Alternatives**: rewriting log records in a logging handler (changes app logging config - rejected);
  instrumenting `Logger.log` (heavier, per line not per request).

## R3 - The request thread and window for thread-and-time matching

- **Decision**: the agent adds the request thread name to the `CALL_OPEN` marker it already sends at
  `servletEnter` (`MarkerRecord`); `backend-db-capture` stores it as `call_db_summary.request_thread` (new
  column, `addColumnIfMissing`) with an index on `(request_thread, first_seen)`. Old captures fall back to the
  thread of the call's first statement. The window is the call's own `timestamp` + `duration_ms` from the calls
  slices, widened by the project's allowed clock difference (default 200 ms).
- **Overlap rule (FR-004)**: neighbouring calls on the same thread are found from `call_db_summary`
  (`request_thread`, `first_seen` within the widened window); a line falling in two windows goes to the call
  whose window middle is nearer.
- **Calls without capture**: no thread → exact only (spec Edge Cases).

## R4 - Querying the log lines

- **Decision**: through `backend-logs`' existing `QueryLogsUseCase.lines(sourceId, LogQuery)` (paged `LogPage`,
  `contracts/log-query.md`): `idField = <callId>` for exact; `threadField = <thread>` AND time between
  `[start-skew, end+skew]` for the time match. The project's thread and id fields are switched to the Exact
  search mode (B-tree indexed) when the project's log settings are saved, through
  `ManageLogSourcesUseCase`' structure update - one indexed lookup per call, no scan.
- **Rationale**: one query implementation (`SqliteLogQueryTranslator`), already audited; no new SQL in logs.

- **Time zones**: compare typed instants (`t<N>` of the TIME-role field, already UTC-normalised by the source's time
  zone setting) with the call's UTC timestamp; never compare raw text.

## R5 - Where the joining lives (architecture)

- **Decision**: a composition-root bridge `backend-app/…/calllogsbridge` (like `triagebridge`,
  `relivebridge`): `CallLogsService` + `CallLogsController` under a new prefix `/call-logs`, using only use-case
  ports of `backend-internal-calls` (the call and its window), `backend-db-capture` (request thread, neighbours,
  the ▤ flag), `backend-logs` (project log settings, line queries, kept lines) and `backend-session-cycles`
  (is the call in a cycle). `backend-logs` stays a leaf slice; no new slice-to-slice edge.
- **Gateway**: add `call-logs` to `gateway/nginx.conf`'s API prefix regex.
- **Alternatives**: joining in the frontend (first idea) - rejected after clarification: kept lines (FR-005a),
  exports, import and Claude's tool all need the same join; one server-side implementation instead of three.

## R6 - Kept lines for session-cycle calls (FR-005a)

- **Wiring**: the decorator is `@Primary` and injects the session-cycles adapter by its qualified name
  (`@Qualifier("webSocketSessionCycleNotificationAdapter")`), so session-cycles keeps calling its port and only
  backend-app knows there are two beans.
- **Decision**: `backend-logs` gains a `kept_lines` table (call id, source id, line id, the raw line, how matched,
  kept at). The bridge keeps a cycle call's lines (a) when a cycle's contents change - a `backend-app` decorator of
  `SessionCycleNotificationPort.notifyCycleContentChanged` hands the cycle's calls to an async keep job - and
  (b) whenever a cycle call's lines are read (opened, exported, Claude), upserting. When the bridge reads a cycle
  call, live lines and kept lines are merged by line id. Kept lines are removed when the call is in no cycle any
  more (same decorator, on removal/clear/delete).
- **Rationale**: no polling, no cross-slice storage; logs keeps its own retention, kept lines are outside it.
- **Alternatives**: pinning lines against the logs retention (couples retention to cycles); copying into
  `session-cycles.db` (would need session-cycles→logs edge).

## R7 - Exports, import, redaction, Claude

- **Decision**: the export dialog fetches `GET /call-logs/{callId}` for each exported inbound call (as it fetches
  the database capture) and attaches `logLines` to the call; `.md`/`.html`/`.json` (v3, `json-export-v2.ts`) write
  them whole; `import-parser.ts` reads them back and the import posts them to `POST /call-logs/import`, stored
  as kept lines. `redact.ts` treats each line's raw JSON like a body (same rules; FR-017a). The MCP server gets a
  `call_logs` tool using its existing session masking.
- **Rationale**: same shape as `dbCapture` - one choke point for redaction, exports never truncate.

## R9 - The ▤ switch gates reading too

- **Decision**: the bridge checks the project's ▤ flag (and that its call logging is on) before any log query;
  off → `setup: "LINKING_OFF"`, no counts, no markers. Kept lines (cycle calls, imports) are still served - they
  are ALFRED's own copies, not a read of the logs.
- **UI**: `sources-bar.component.html` gets a third `source-pill-switch log-sw` after `db-sw`, with the same
  `blocked`/title/error handling as ◆ through a small `LogLinkStateService` mirroring `DbCaptureStateService`'s
  switch API; the ▾ popover gains the Logs section (R8).

## R8 - Settings UI and storage

- **Decision**: `backend-logs` stores project log settings (`project_logs`: project, source ids, thread field,
  time field, id field, clock difference ms) with a "lines carrying the id field" count from a cached field-values
  query; there is no `logTagging` setting - tagging follows the ▤ switch per request (R1, R9). The UI shows the mapping in a
  Logs section of the ◆ popover / Settings → Database capture → project.
