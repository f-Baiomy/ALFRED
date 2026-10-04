# Research: Database Capture

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-04

Every decision below resolves an unknown from the plan's Technical Context. Each lists what was chosen, why,
and what was rejected. Decisions marked **(Relive-ready)** exist to satisfy FR-040..043 - Relive replay itself is
a later feature and is not built here.

---

## D1. How statements are observed: an in-process Java agent

**Decision**: A new Java agent jar (`db-agent/`, built to Java 8 bytecode) instruments the JDBC interfaces
inside the application's JVM with ByteBuddy `Advice`: `java.sql.Connection` (prepare*, commit, rollback,
setSavepoint, rollback(Savepoint), setAutoCommit, close), `Statement`/`PreparedStatement`/`CallableStatement`
(set*, addBatch, execute*, executeBatch, getGeneratedKeys, register/get OUT params) and `ResultSet` (next, get*,
close). Matching is by interface (`isSubTypeOf(java.sql.Statement)` etc., excluding JDK and the agent's own
classes), so it works for every driver and for pool wrappers (WildFly IronJacamar `WrappedConnection`), and it
attaches either at startup (`-javaagent:`) or live through the Attach API with `RETRANSFORMATION`.

**Rationale**: Settled with the owner in the design review: one implementation covers Oracle, PostgreSQL,
MySQL/MariaDB and SQL Server (Oracle's wire protocol is closed), and being in-process gives exact per-request
attribution under concurrency (D3). Advice is inlined into existing methods - no wrapper objects are handed to
the application, so `unwrap()`/`instanceof` on vendor types keep working.

**Alternatives rejected**: a network DB proxy (no Oracle; time-based attribution only); p6spy (needs JDBC URL
change, logging only, no answering path for later Relive); wrapping the `DataSource` with
`java.lang.reflect.Proxy` (breaks vendor `unwrap`, needs app-server config change).

## D2. Instrumentation library: ByteBuddy, shaded and relocated

**Decision**: `net.bytebuddy:byte-buddy` (pinned, latest 1.x that still supports Java 8 targets) shaded into the
agent jar and relocated to `com.fathy.alfred.dbagent.shaded.bytebuddy`. No other runtime dependency: the agent
writes its own JSON (small `JsonWriter`, tested) and uses `HttpURLConnection` for transport, so nothing it loads
can clash with libraries the application already has.

**Rationale**: Constitution I requires dependencies to be justified - writing a bytecode weaver by hand (ASM
visitors for retransformation, stack maps, Java 8-21 class files) is far more code and risk than one
well-maintained, widely-used library. Relocation keeps it invisible to the application's classloaders.

**Alternatives rejected**: raw ASM (much more code), Javassist (weaker retransformation support), Jackson in the
agent (classpath clashes with the app's own Jackson).

## D3. Attributing a statement to its inbound call - exact, by thread

**Decision**: The reverse proxy adds one header to every inbound request it forwards for a project with
**inbound logging on**: `X-Alfred-Call: id=<callId>; db=<0|1>[; run=<runId>/<stepKey>]` (contract:
[contracts/proxy-headers.md](contracts/proxy-headers.md)). The agent instruments the servlet entry point
(`javax.servlet.http.HttpServlet.service` and `jakarta.servlet.http.HttpServlet.service`, which every
WildFly/Undertow request passes through) and, when the header is present and `db=1`, opens a `CallContext`
(call id, run tag, a per-call sequence counter) in a `ThreadLocal`, cleared in a `finally` when `service` returns.
Every statement on that thread is tagged with the context.

Work handed to other threads keeps the context: the agent wraps `Runnable`/`Callable` at submission in
`ThreadPoolExecutor.execute`, `ScheduledThreadPoolExecutor.schedule*`, `ForkJoinPool.execute/submit` and
`CompletableFuture.*Async` (EE managed executors delegate to these), restoring the captured context around
`run()`/`call()`. Statements with no context go to the "outside any call" bucket keyed by thread name
(FR-007), captured only when the project's outside-call capture is on (heartbeat config, D6).

**Rationale**: The servlet thread is the request's thread in WildFly, so a `ThreadLocal` gives exact
attribution with no clock involved (SC-001). The header carries `db=1` so the per-project switch is enforced
at the proxy (D5) without the agent needing live state. Inbound logging off ⇒ no call id ⇒ no header ⇒ no
capture, which is FR-013 by construction.

**Alternatives rejected**: reusing `X-Request-Id` (already meaningful to clients, absent when the proxy
generated the id); time-window matching (ambiguous under concurrency - the reason this feature exists).

## D4. Exact order of statements and supplier calls

**Decision**: The `CallContext` holds one `AtomicInteger` sequence shared by statements and outbound HTTP. The
agent instruments `HttpURLConnection` (set the request property before `connect`) and Apache HttpClient 4/5
(`execute` - add the header to the request) to send `X-Alfred-Parent: <callId>; seq=<n>`. The forward proxy
(`proxy/log_and_route.py`) pops that header before forwarding (suppliers never see it) and records
`parent_call_id` and `parent_seq` on the outbound call. Statements carry their own `seq`. The database window
merges both by `seq`; the Nested/Waterfall trees prefer the explicit parent when present and fall back to
today's time containment when absent (marked "approximate order", spec Assumptions).

**Rationale**: FR-003 asks for order independent of clocks; the proxy (container clock) and the agent (host
JVM clock) disagree by milliseconds. A shared counter is exact. As a side effect outbound attribution becomes
exact too.

**Alternatives rejected**: sorting by timestamp (clock skew swaps neighbours); forwarding `X-Operation-Id`
(requires app changes).

## D5. Per-project on/off: a flag file read by the reverse proxy

**Decision**: New flag file `proxy/db-capture-enabled.flag`, same `name=on|off` line format as
`reverse-proxy-enabled.flag`, **default off** for a name with no line. Bind-mounted into `reverse-proxy` (read,
mtime-cached exactly like `_ToggleState`) and `backend` (read/write through the new slice's
`FileDbCaptureToggleAdapter`, re-read on every call like `FileLoggingToggleAdapter`). The proxy sets `db=1` in
`X-Alfred-Call` only when both inbound logging and DB capture are on for that project.

**Rationale**: Reuses an existing, proven mechanism; switching takes effect on the next request with no agent
round trip; the UI's three switches all call one endpoint and broadcast one WebSocket message (FR-012, SC-009).

**Alternatives rejected**: agent fetching the switch per request (adds a backend round trip to the app's
request path - Constitution II); storing it in SQLite (the proxy cannot read it).

## D6. Agent → backend transport, and agent status

**Decision**:
- Statements are queued in-process on a bounded queue (`maxQueuedStatements` 20,000 and `maxQueuedBytes`
  64 MB). A single daemon sender thread posts batches (every 250 ms or 500 statements, gzip JSON) to
  `POST /db-capture/agent/batch` with `X-Webhook-Secret`. When the queue is full, new statements are dropped
  and counted; the count is sent with the next batch and shown on the affected calls ("N statements dropped").
  The application thread never waits on I/O (FR-005).
- A heartbeat every 10 s, `POST /db-capture/agent/heartbeat` (agent version, JVM, project, app server, dropped
  counters), returns the project's capture config (row limit, before-image tables, ignore patterns, outside-call
  capture on/off). The backend records "last seen" for FR-014.
- Backend unreachable: batches are dropped after one retry with back-off; the agent logs one WARN per minute at
  most (never statement data).
- Target URL: `http://localhost:3000` (the gateway) by default, overridable by agent argument.

**Rationale**: The agent runs on the host, outside Docker; the gateway is the one published port. Batching keeps
overhead low (SC-002). The heartbeat is the only periodic traffic and exists because "is the agent attached" is
a requirement; it is agent→backend, not a UI refresh, so the no-polling rule (which governs UI lists) is not
broken - recorded in Complexity Tracking anyway.

**Alternatives rejected**: one POST per statement (thousands of requests per busy call); a socket from backend to
agent (backend in Docker cannot reach the host JVM reliably on all platforms).

## D7. Capturing results without changing behaviour

**Decision**: Rows are recorded **as the application reads them** (`ResultSet.next` + `get*` advice records the
values the code actually fetched, per column, typed). On `close` (or statement close), if the app stopped before
the end, the result is marked `partial` with `rowsRead`; the agent never reads ahead. Rows past the per-result
limit (default 50,000, from heartbeat config) are counted, not stored. Columns the app never fetched are
recorded as "not read" only if the app read other columns of that row - metadata (names, types) is taken from
`ResultSetMetaData`, which drivers already hold.

**Rationale**: Reading ahead would change fetch behaviour, latency and cursor state - a capture tool must not do
that (FR-005, SC-002). What the code read is also exactly what a later Relive replay has to give back
(Relive-ready).

**Alternatives rejected**: caching wrapper that prefetches the whole result (behaviour change, memory risk).

## D8. Values: types, vendor types, large values

**Decision**: A `ValueCodec` chain in the agent converts each value to a typed JSON value
`{t: <jdbcTypeName>, v: <text>}`:
standard JDBC types first (numbers as exact decimal strings, dates/timestamps ISO-8601 with zone where present,
booleans, bytes as base64), then per-vendor codecs loaded **by reflection** (no compile-time driver
dependency): Oracle (`oracle.sql.TIMESTAMPTZ/TIMESTAMPLTZ`, `oracle.jdbc.OracleStruct`, `oracle.sql.ARRAY`,
`REF CURSOR` OUT params recorded as a nested result), PostgreSQL (`PGobject` type+value, `java.sql.Array`,
`PGInterval`), MySQL/MariaDB (unsigned, `JSON`, `BIT`), SQL Server (`DateTimeOffset`, `UNIQUEIDENTIFIER`,
`sql_variant`). Unknown types: class name + `toString()`, flagged `opaque`.
LOBs and streams: values the app passed as `byte[]`/`String` are stored in full; `InputStream`/`Reader`
parameters are wrapped in a tee that copies what the driver consumes (up to 16 MB, then `truncatedAt` marker
stored and shown - the export never shortens what was stored). LOB columns the app reads are recorded as it reads
them.
Error codes: `SQLException.getSQLState()`, `getErrorCode()`, message and chained exceptions.

**Rationale**: Clarification Q2 put all four vendors in scope from the start; SC-010 requires no unreadable value
on their reference recordings.

## D9. Storage: new leaf slice `backend-db-capture` with its own SQLite file

**Decision**: New Maven module `backend/backend-db-capture`, hexagonal like the others, persisting to its own
`db-capture.db` (env `DB_CAPTURE_DB_FILE`, compose: a `db-capture-db` named volume, as `logs.db` does for
Windows bind-mount performance). Schema in [data-model.md](data-model.md): statements (summary columns +
params/outcome JSON), result rows in their own table paged by index, transactions, per-call summary with flags,
agents (last seen), settings (per-project config). Retention:
- statements of a call are deleted with the call (user delete/clear) through a `backend-app` bridge;
- total size capped by `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` (default 4 GiB): when exceeded, the oldest calls'
  statements are removed first, **except** calls a session cycle or a Relive cycle/run holds (asked through
  `RetainedCallIdsPort`, implemented in `backend-app` over session-cycles' and relive's existing use cases) -
  FR-038, FR-039;
- outside-call statements: capped at 7 days or 20 % of the size cap, oldest first.

**Rationale**: Hundreds of statements × up to 50,000 rows per call needs indexed, windowed storage - a flat file
has no equivalent (the same reason `backend-logs` has no file adapter). A separate file keeps capture volume from
slowing `alfred.db`.

**Alternatives rejected**: storing statements inside the inbound call record (internal-calls is a flat-file ring
buffer, the wrong place for this volume); storing rows as one JSON blob per statement (cannot page a 50,000-row
result without loading it whole - Constitution II).

## D10. Querying recorded data (search, sort, SQL) - sandboxed in the backend

**Decision**: One endpoint per data set (a statement's rows; a call's statement list). The backend opens a fresh
**in-memory** SQLite connection, creates one table (`result` or `statements`) holding only that data, loads it,
sets `PRAGMA query_only = ON`, rejects input that is not a single `SELECT`/`WITH` statement, runs it with an
`org.sqlite.ProgressHandler` that aborts after 3 s, and returns at most 50,000 rows paged 100 at a time. Quick
search and column sort are the same endpoint with a generated query. The connection is discarded afterwards.

**Rationale**: Rows load on demand (100 at a time), so the browser never has the whole result to query; real SQL
(joins with itself, `GROUP BY`, functions) comes for free; the sandbox holds only data the user is already
allowed to see, cannot write, cannot reach `db-capture.db`, and cannot run long (Constitution I/II).
Never touches the application's database (FR-027).

**Alternatives rejected**: the mock's in-browser mini engine (needs every row client-side); running user SQL
against `db-capture.db` directly (can read other calls, risk of locking the store).

## D11. Flags: computed once, at ingest

**Decision**: A pure domain class `StatementFlags` computes the call's flags (FR-023) when its batch is stored and
again when the call completes, using the call's stored `HTTP_OUT` markers for supplier-call positions (so the
"lock held during a supplier call" flag is right before anyone opens the call); results are stored in `call_db_summary` (counts + flags JSON). Thresholds come from
the per-project settings (slow 20 ms, huge 1,000 rows, N+1 from 5 repeats, large delete 100 rows - spec mock
values); "expected" statements (by normalised text) never raise a flag.

**Rationale**: The chip on every call card needs counts and the flag total without opening the call - one summary
read per visible card, batched (`GET /db-capture/summaries?callIds=`). One implementation, tested directly
(Constitution V/VI).

## D12. Deleted rows, before-image, cascades

**Decision**:
- **Earlier read**: at ingest, `DeletedRowsResolver` (domain) links a `DELETE`/`UPDATE` to the latest earlier
  `SELECT` in the same call on the same table whose normalised `WHERE` text and bound values match; the link is
  stored (`before_source = EARLIER_READ`, statement seq).
- **Before-image** (opt-in per table, heartbeat config): for single-table `UPDATE t SET … WHERE …` and
  `DELETE FROM t WHERE …`, the agent runs `SELECT * FROM t WHERE <same where>` with the same bound values on the
  **same connection** (so the same transaction) just before executing; rows stored as the before-image, its
  duration recorded. Statements it cannot rewrite safely (joins, subqueries in `FROM`, vendor syntax) are
  marked `beforeImageSkipped: "statement too complex"`. Never runs for tables not opted in.
- **Cascades**: per table, once, the agent reads `DatabaseMetaData.getExportedKeys` and records child tables with
  `importedKeyCascade` delete rules; deletes on such tables carry `cascadesTo`.

**Rationale**: Matches the agreed design (mock "Deleted rows" cases) and FR-021/022, with the only extra database
read being the one the user turned on.

## D13. Live updates

**Decision**: New WebSocket `/ws/db-capture` (same `reconnectingSocket` pattern) broadcasting
`{type: "statements-appended", callId, count, summaryChanged}` and `{type: "capture-settings-changed"}`. The chip
re-fetches its summary; an open window fetches statements after its last `seq` (FR-020, SC-009). No timers.

## D14. Frontend: the mock is the visual specification

**Decision**: [mock.html](mock.html) (v5, agreed) is the UI contract ([contracts/ui.md](contracts/ui.md) maps each
mock element to a component). Its CSS was already copied from Alfred's `styles.scss` tokens; the new rules move
into `frontend/src/styles/_db-capture.scss`, reusing existing classes (`.call`, `.badge`, `.action-btn`,
`.block-chip`, `.dialog-backdrop`, `.dialog-card`, `.source-pill-*`, `.cw-*`) rather than copies. Rendering uses
Angular templates and bindings only - never `innerHTML` - so captured values stay escaped (Constitution I);
the mock's string-built HTML is not reused.

## D15. Exports and re-import

**Decision**: `bulk-json-builder.ts` adds `dbCapture: { statements, transactions, rows }` to each inbound call
event that has captured statements (all stored rows, never cut); `import-parser.ts` reads it back (exact inverse,
fixtures built with `buildBulkExportPayload`); `markdown-builder.ts`/`html-builder.ts` add a "Database" section per
call (statements in run order with values, results as tables); `export-narrative.ts` mentions database capture
when present. Discord/cURL/Postman unchanged. Imported statements are stored through the same ingest port.

## D16. Attaching the agent

**Decision**: `wildfly-proxy-toggle/WildFlyProxyController` gains a generic `load-agent <jar> <args>` mode
(existing WildFly detection reused). New wrappers `db-capture-on.(sh|bat)` build the agent jar if missing (Maven in
Docker, like the backend) and load it with `alfredUrl`, `project` and the webhook secret read from `.env`
(never printed). `start.py`/`restart.py` get `--db-capture on`. The agent also supports `-javaagent:` at startup
(documented). Detaching: capture stops by switching the project off; the code stays loaded until the JVM
restarts (Java agents cannot be unloaded - documented, same as the proxy toggle's known limitation).

## D18. Redaction stays export-only

**Decision**: Database values are never masked inside ALFRED. `redact.ts` gains a `db-column` kind applied to
`dbCapture` blocks in every export; `backend-redactions` accepts the new kind; the rows table and Params tab offer
"Hide in exports" for a column.

**Rationale**: Existing redaction is deliberately export-only ("Never applied to the live UI - the value stays
readable in Alfred, because you need it to debug; it is the shared artifact that leaks", `redaction.model.ts`),
and the owner chose to see every value (clarify Q4). Masking the window would contradict both.

## D17. Relive-ready, unused now (FR-040..043)

**Decision**: The agent's JDBC advice goes through one `StatementInterceptor` interface with a single
implementation, `CaptureOnlyInterceptor`, whose `before()` returns `Proceed`. A later Relive version adds an
implementation that may return `AnswerWith(result)`, `Fail(sqlException)` or `Await(decision)`. Statements store
placeholder text, typed params per batch set, full outcome and a `fingerprint` (hash of normalised text + param
types) plus `seq`; the run tag from `X-Alfred-Call` is stored on statements. No replay UI, endpoint or flag is
built now.

**Rationale**: The owner asked for capture now and Relive later "without rework". This is the minimum shape that
keeps that true without building speculative features (Constitution V, YAGNI).
