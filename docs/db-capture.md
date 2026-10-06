# Database Capture

Records every database statement a Java application runs, tied exactly to the inbound call that caused it and
ordered exactly against that call's supplier calls, and shows it per call in ALFRED (the `◆ DB` chip and the
database window). Spec, plan and the agreed UI mock: `specs/006-db-capture/`.

Relive replay of statements is a **later feature**. The agent and the stored format are already shaped for it
(see "Relive-ready seams" below) - nothing replays today.

## How it works

```
caller ──► reverse-proxy ──X-Alfred-Call: id=…; db=1──► app (WildFly) ──JDBC──► database
                                                          │  db-agent (in the app's JVM)
                                                          │   - servlet entry opens a call context
                                                          │   - JDBC advice records each statement
                                                          │   - outbound HTTP gets X-Alfred-Parent ──► proxy (popped)
                                                          └── batches ──► backend-db-capture (/db-capture/agent/batch)
```

- **Switch**: `proxy/db-capture-enabled.flag` (`name=on|off`, a missing line is **off**). The reverse proxy reads it
  and sets `db=1` in `X-Alfred-Call` only when the project's inbound logging AND database capture are on.
- **Agent**: `db-agent/` (Java 8 bytecode, ByteBuddy shaded). Never blocks the application: it only enqueues;
  one daemon thread sends batches; when the queue is full statements are dropped and counted.
- **Backend**: `backend-db-capture` slice, own SQLite file `db-capture.db`. A failed statement is marked in its own
  `failed` column at insert, with a partial index (`ix_statements_failed`, failed rows only): a call's failed
  statements, and "which of these calls had one", are one indexed read - `GET /db-capture/failures?callIds=…` (≤ 500
  ids; per call `failedCount`, `swallowedCount` and up to 50 statements). The summary's `failed_count` is counted from
  that column. After each batch that adds a failed statement, and when the call completes, the counts go out through
  `StatementFailuresObserverPort` to triage's saved mark of the call (docs/mcp.md, "Triage").
- **Frontend**: a failed statement turns the call's chip red (`✖ DB 41 · 1 failed · swallowed`, the statements named on
  hover) - on a call that answered 200 most of all; the stats bar's "✖ DB failures" pill and the Filters menu's
  "Has DB failures" narrow the list to those calls; the waterfall marks the row `✖ DB n`.
- **Frontend**: `components/db-capture/*`, the `◆` switch in the Sources bar, "Log DB" in the cycle widget,
  Settings → Database capture.

## Switching it on

1. Inbound logging must be on for the project (statements are attached to inbound calls).
2. Load the agent into the application's JVM, either
   - live, into a running WildFly: `python3 start.py --db-capture on <project>` (or `restart.py`, or
     `wildfly-proxy-toggle/db-capture-on.sh|.bat <project>` directly) - finds WildFly through the Attach API like
     the outbound proxy toggle, builds the agent jar on first use, passes `secretFile=<repo>/.env` so the webhook
     secret never appears on a command line; or
   - at JVM start: `-javaagent:/path/alfred-db-agent.jar=alfredUrl=http://localhost:3000;project=<project>;secretFile=/path/.env`.
3. Switch capture on: the `◆` next to the project's inbound-logging dot in Live Calls' Sources bar, the **Log DB**
   column in the cycle widget's Sources popover, or Settings → Database capture. One setting, three places; every
   change is broadcast on `/ws/db-capture`, so all three (and every other open tab) follow it.

`--db-capture off` / `db-capture-off` / the switch only stop capture: **an agent cannot be unloaded from a running
JVM**, so it stays loaded and records nothing until the JVM restarts. Loading it twice is harmless. With
`restart.py`, name services before the flag (`restart.py backend --db-capture on wallet-app`) - a word after
`on|off` is taken as the project.

The agent reports in every 10 s (`/db-capture/agent/heartbeat`); a project counts as "agent attached" while it was
heard from in the last 30 s. Its answer carries the project's settings and switch, so a settings change reaches the
agent within one heartbeat. JBoss Modules: the agent puts its bridge on the boot class path and opens it to every
module; if a deployment still cannot see it, add `-Djboss.modules.system.pkgs=com.fathy.alfred.dbagent.bootstrap`.

## Settings and environment

| Variable | Default | Meaning |
|---|---|---|
| `DB_CAPTURE_DB_FILE` | `/dbcapturedb/db-capture.db` (named volume `db-capture-db`) | the store |
| `DB_CAPTURE_TOGGLE_FILE` | `/appdata/db-capture-enabled.flag` (backend), `/home/mitmproxy/db-capture-enabled.flag` (reverse-proxy) | the per-project switch |
| `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` | `4294967296` (4 GiB) | size cap; oldest calls' statements evicted first, never those held by a session cycle or Relive cycle |

## Relive-ready seams

- `StatementInterceptor` in the agent - the one place a later version can answer a statement instead of the database.
- Statements store placeholder SQL, typed parameters, the full outcome, a fingerprint and their order number.
- The Relive run tag from `X-Alfred-Call` is stored on statements.

## Settings per project (Settings → Database capture)

| Setting | Default | Meaning |
|---|---|---|
| Rows kept per result | 50,000 | rows past this are counted, not stored - the window says so ("120,480 rows returned - 50,000 stored") |
| Before-image tables | none | for these tables the agent reads the affected rows just before each UPDATE/DELETE (one extra read, same transaction) |
| Flags | slow 20 ms, huge 1,000 rows, N+1 from 5 repeats, large delete 100 rows | when the window's flags fire; DELETE/UPDATE without WHERE always flags |
| Expected | none | statement fingerprints marked expected never raise a flag |
| Ignore | `SELECT 1` | statements never recorded (`%` wildcard, or a table name) |
| Outside calls | on | also record statements no inbound call caused (scheduled jobs, listeners, startup), in their own window |

Redaction: values are never hidden in Alfred itself. A `db-column` redaction (⊘ on a column in the database window,
listed under Settings → Database capture) masks that column in exported result rows, before-images and the
parameters bound to it (`sql-param-columns.ts`: INSERT column lists, `SET col = ?`, `WHERE col = ?`).

## Where a statement came from (HQL, native SQL, JDBC)

Design: `specs/006-db-capture/hql-mock.html`. When the application uses Hibernate (4, 5 or 6, directly or through
JPA), the agent also records the query **as the code wrote it** and tags every SQL statement executed while it runs
with that `origin`:

- **Queries** - `list / getResultList / uniqueResult / getSingleResult / executeUpdate / scroll / stream / iterate` on
  Hibernate's and JPA's query types: kind `HQL`, `NATIVE` (createNativeQuery/createSQLQuery, stored procedures) or
  `CRITERIA`, the text (`getQueryString`), the named-query name (from `createNamedQuery/getNamedQuery`), the bound
  parameters by name or position (from the `setParameter*` / typed setters), `setFirstResult/setMaxResults`, and the
  method the code called. Getters are reached by reflection and class NAME - no Hibernate version is a dependency.
- **Events** - Hibernate making SQL with no query of the code's: `LAZY_LOAD` (DefaultInitializeCollectionEventListener:
  role + owner id), `LOAD` (DefaultLoadEventListener: entity + id), `FLUSH` (the flush listeners, and each
  `EntityAction`/`CollectionAction.execute()` with INSERT/UPDATE/DELETE and, for an UPDATE, the changed properties).
  An event that runs inside a query names it in `parentId` - "Group by query" folds it under that query.
- **`HIBERNATE`** - SQL with Hibernate frames on the stack but no tracked query or event (a sequence's next value).
- **No origin** - plain JDBC (JdbcTemplate, MyBatis, `session.doWork`): written as SQL and sent as written. The
  window labels it `JDBC` only in a call where an ORM made other statements.

Frames are a per-thread stack; the innermost wins. A nested execution of the same query (getResultList → list, a JPA
wrapper → Hibernate's query) is folded into the outer frame. Parameter values are rendered without calling an
application object's `toString` (an entity's could load lazily): JDK values print as they are, anything else as
`<ClassName>`. Stored in `statements.origin_json`; exported in `.json` and re-imported; `db-column` redactions mask
the named parameters too (by name, or by a value the SQL parameters had masked).

The window: an `HQL`/`NATIVE`/`CRITERIA`/`LAZY LOAD`/`LOAD`/`FLUSH`/`JDBC` badge per row, "Show rows as HQL | SQL
sent", "Group by query", and in the Statement tab the code's query on top, the SQL sent below and a line saying what
Hibernate changed (a native query whose only change was `:name → ?` is one card). The .md/.html export shows the HQL
block above the SQL; Export .sql keeps SQL only, with the HQL as a comment above each statement.

Verified by `db-agent`'s `HibernateOriginIT` (Hibernate 5.6 + H2, Java 8 and 21).

## From "found the problem" to "know what to fix"

Built from a review of real OdeySys exports by an AI agent (mock: `specs/006-db-capture/enhancements-mock.html`):

- **Where the time went** (`shared/utils/db-analysis.ts`, one implementation for the window, the .json and the .md/.html):
  database, supplier calls (their union - parallel calls are not double counted), the time BETWEEN statements (count,
  median, largest - each named by the statement after it and the code that ran it), before/after, and the connection
  and transaction overhead the agent timed. "App time dominant" when more than half the call is neither DB nor
  supplier calls. The export dialog fetches each call's supplier calls by their parent link so their time counts.
- **Top queries**: one row per statement shape, costliest first - runs, distinct parameters, exact duplicates, total,
  rows, where it ran from. A window tab and `analysis.queries` in every export.
- **Flags**: `DUPLICATE` (same SQL and same parameters anywhere in the call - a per-request cache fixes it, unlike an
  N+1; statements already in a "cacheable" back-to-back run are left out), `TX_PER_STATEMENT` (10+ transactions, about
  one per statement), and `SLOW` now counts only the time beyond the call's database round trip
  (`RoundTrip.java`: the 10th percentile of the call's successful SELECTs, 5 or more - a remote database 55 ms away no
  longer makes every lookup slow). No query is run for it.
- **Call chain** (`callers`): the agent's single stack walk now collects up to N application frames (default 5,
  Settings → Database capture → Where in code) past the project's pass-through classes (a generic DAO every query goes
  through). `codeLocation` stays the first application frame; Hibernate's own SQL is recognised only by Hibernate frames
  below the issuing code (a `session.doWork` lambda is still plain JDBC). ~23-25 µs per statement measured.
- **Connection and transaction lifecycle**: the agent times `DataSource.getConnection` (the first statement on a fresh
  connection carries `outcome.acquireMicros`), `setAutoCommit(false)`, commit/rollback and `Connection.close`, and hooks
  JTA commit/rollback (javax and jakarta `Transaction`, `TransactionManager`, `UserTransaction`): a container-managed
  transaction never calls `Connection.commit`, which is why every WildFly transaction used to stay OPEN with 0 ms held.
  A JTA end closes every transaction the thread has open, "via JTA"; the per-thread list is cleared at the end of each
  call. Stored per transaction as `transactions.lifecycle_json`.
- **Index check** (opt-in per project): the first statement of each table in a call carries the table's indexes from
  `DatabaseMetaData.getIndexInfo(..., approximate = true)` - `false` makes Oracle's driver run ANALYZE, and the agent
  never changes the database. Cached per data source for 10 minutes. EXPLAIN is never run. The window says "no index
  starts with X" for a column the statement filters by (a hint; only the planner knows).
- **`QUERY_FAN_OUT`**: one query whose returned rows each triggered more queries - Hibernate loading a collection per
  row, an N+1 inside ONE execution, which `REPEATED_QUERY` cannot see because the follow-ups are different queries.
  Found by the HQL origin (every SQL of one execution shares `origin.id`; a LAZY_LOAD/LOAD names it as `parentId`), 3+
  statements with 2+ distinct follow-up parameter sets; without an origin, by the pattern "a SELECT returning R rows,
  then R cycles of the same 1-5 other queries, each cycle bound to different values, and the run stops there". Its
  statements are not also reported as `SLOW`. `SLOW` defaults to 100 ms beyond the round trip (a stored 20, the old
  default, is read as 100).
- **Flags are versioned** (`StatementFlags.VERSION`, `call_db_summary.flags_version`): a call flagged by older rules is
  flagged again from its stored statements the first time its summary is read, so old captures get new rules.
- **Summary line, timeline and findings** (`shared/utils/db-findings.ts`, mock `specs/006-db-capture/timeline-mock.html`):
  the window opens with ONE closed line ("20.0 s · 56% inside the app - 2 idle stretches, the longest 2.5 s before
  #28", error and to-fix counts); open (remembered per browser) it shows three timeline lanes - Database, Supplier calls
  (overlapping calls on rows of their own), Idle (≥ 1 s with nothing running) - coloured by what each item is, and the
  findings: one closed line each (title, short why, count, impact), opened the why, the fix and the statements as chips.
  Findings are built from the backend flags plus what only the client sees (idle stretches, supplier errors and time,
  the round trip), errors first, then warnings by what they cost, then notes. The same summary and findings
  (`analysis.summary`/`analysis.findings`, without chips) open the .md/.html Database section and the .json `dbCalls`
  line, the .json index carries each call's `findings` (severity, title, impactMs, seqs), and highlights come from them.
- **Window layout** (mock `specs/006-db-capture/split-mock.html`): the timeline sits above a split - findings | drag bar |
  statements - side by side by default from a 1100 px browser window, stacked below that (the statements keep 330 px);
  the summary line (top) opens the timeline (top), as does the timeline's own bar; the findings pane folds from its own
  "Findings" header - to a thin rail with the error/to-fix counts beside the statements, or its header line above them; the bar under the timeline drags its height (double-click: full height). Layout, sizes, the timeline's
  open state and full window (⛶ or F; the first Esc leaves it) are remembered per browser
  (`alfred.dbCapture.*`). Supplier calls stack at most 4 rows ("+N parallel" lists and expands the rest); several notes
  share one line. Compact by default (`specs/006-db-capture/compact-window-mock.html`): a two-line header, the
  timeline as a "Strip" (thin lanes, every supplier call as slivers in one lane - "Detailed" restores labelled rows),
  and the statements toolbar in one row with the display choices under "View ▾" - in a 730 px window the statement
  list went from ~2 visible rows to 14.

## Log tagging (the ▤ switch, specs/008-logs-call-link)

While a project's ▤ switch is on (`proxy/log-link-enabled.flag`, one `project=on|off` line per project, written by
the backend, read live by the reverse proxy), `X-Alfred-Call` also says `log=1`. The agent then puts the call id
under `alfred.call` in every logging MDC the request thread can see - `org.jboss.logmanager.MDC`, `org.slf4j.MDC`,
log4j 2's `ThreadContext`, log4j 1's `MDC`, `org.jboss.logging.MDC` (found through the context class loader, probed
once per class loader; missing ones skipped) - restores the previous value when the request ends, and carries it
into work handed to pool threads. Calls with `db=0` are tagged too (no capture is opened for them). WildFly's JSON
formatter writes the MDC by default, so the Logs tab sees the field `mdc.alfred.call`. The CALL_OPEN marker also
records the request thread's name (`call_markers.thread`), which thread-and-time matching uses. Cost: 1.5 us
(Java 8) to 6.4 us (Java 21) per request (`LogTaggingIT`) - far under SC-004's 1 ms.

## Log lines caught by the agent (specs/009-agent-log-capture)

With ▤ on and the agent attached, the agent catches every log event the application emits while handling a recorded
call - whichever logger wrote it and wherever it goes (file, console, any format) - and sends it with the call, so no
log file is needed. One hook per framework, where the event has passed the application's own level check and is about
to reach its handlers/appenders: `org.jboss.logmanager.Logger.logRaw` (WildFly - JUL, slf4j, jboss-logging and log4j
all end there), `java.util.logging.Logger.log(LogRecord)` (only when JUL itself would publish it),
`ch.qos.logback.classic.Logger.callAppenders`, `org.apache.logging.log4j.core.config.LoggerConfig.log(LogEvent)` and
`org.apache.log4j.Category.callAppenders`. Events are read reflectively (no logging dependency); only the outermost
hook on a thread records, so a line passing through a bridge is caught once; the agent's own work is never caught.

- `log=1` alone (◆ off) opens a logs-only call: a CALL_OPEN with `logs=true`, no statements, and its supplier calls still
  get `X-Alfred-Parent`. Each caught line takes the call's next `seq`, so Together shows statements, supplier calls and
  lines in their exact order.
- Caps per call: 5,000 lines, 2 MB of text, 32 KB per line (cut and marked); lines written more than 5 s after the call
  ended are dropped; everything not kept is counted ("N lines not kept"). Lines outside any call are caught while ▤ is
  on (the heartbeat's `logsOn`), at most 2,000 a minute per JVM, kept up to 20,000 per project.
- Lines travel in the same bounded batch as statements (`logs`, `droppedLogs`) and are stored in `db-capture.db`
  (`call_log_lines`, counts in `call_log_summary`), deleted with the call's statements - so the size cap and "session
  cycles keep their calls" apply to them unchanged. `/call-logs` serves a caught call from them (`matchedBy: CAUGHT`)
  and never reads a log file for it; calls without the agent keep 008's file linking.

## Exports

`.md` and `.html` get a "Database" section per captured call (every statement with its values, transactions,
supplier calls where they ran, every stored row); `.json` carries `dbCapture` on the event that completes the call
and re-imports it (`POST /db-capture/import`); Export .sql in the window writes a runnable script. Nothing is cut.

## Measurements

All measured on the development machine (Windows, Docker Desktop), 2026-10-05.

| What | Result |
|---|---|
| Agent cost per statement (`OverheadMeasurementIT`, 50-statement call, H2 in memory, 1,000 iterations) | ~17-21 us added per statement, Java 8 (1.8.0_504) and Java 21 alike (varies with machine load) |
| Same call against PostgreSQL 16 in a container on the same host (a statement takes ~0.4 ms there) | +5 % to +8 % of the call - the worst case, a call that is nothing but back-to-back statements; a typical call (application and supplier time too, or a database on another machine) stays under the 5 % of SC-002 |
| Ingest (`DbCaptureThroughputTest`): 1,000 calls x 20 statements arriving 50 at a time | ~3,900 statements/s into `db-capture.db` |
| `db-capture.db` growth | ~19 MB per 1,000 calls of 20 statements with 5 rows each (~1 KB per statement incl. rows) |
| Window: first page of a 500-statement call | ~20 ms server time |
| Scrolling all 50,000 stored rows of one result, 100 at a time | ~3 ms per page server time |
| Log catching with ▤ on vs off (`OverheadMeasurementIT`, a call writing 100 lines through logback, 1,000 iterations, 2026-10-06) | +2.8 us per line on Java 8, +2.4 us on Java 21 - about 0.25 ms for 100 lines (SC-003: < 5 % of a request) |
| Log tagging with ▤ on vs off (`LogTaggingIT`, 2,000 requests, 2026-10-06) | +1.5 us per request on Java 8, +6.4 us on Java 21 (SC-004: < 1 ms) |

What made the agent cheap: the regex passes over the SQL (kind, table, fingerprint, ignore patterns) are cached per
SQL text; "where in code" walks the stack lazily (`StackWalker` on 9+, per-frame access on 8) and caches each class's
"application frame or not". A static-initialisation-order slip in that cache once silently fell back to full
`Throwable` stack traces and quadrupled the cost - `OverheadMeasurementIT` is what showed it.

## Vendor verification (SC-010)

`VendorCaptureIT` (`-Pvendors`, Java 8 agent, real drivers) against PostgreSQL 16.15, MySQL 8.4.11, SQL Server 2022
(16.0.4295) and Oracle Free 23.26: every column below is captured as readable text - nothing opaque - and parameters,
rows, an UPDATE, a DELETE and a failure (with SQLState and vendor code) are all recorded.

| Column | PostgreSQL | MySQL | SQL Server | Oracle |
|---|---|---|---|---|
| id | int8 `1042` | BIGINT `1042` | bigint `1042` | NUMBER `1042` |
| amount | numeric `120.50` | DECIMAL `120.50` | decimal `120.50` | NUMBER `120.5` |
| name | varchar `O'Brien` | VARCHAR `O'Brien` | nvarchar `O'Brien` | VARCHAR2 `O'Brien` |
| note | text | TEXT | nvarchar(max) | CLOB (read in full) |
| created | timestamp `2026-10-04 18:02:43.456` | DATETIME (same form) | datetime2 (same form) | TIMESTAMP (same form) |
| day | date `2026-10-04` | DATE | date | DATE `2026-10-04 00:00:00.0` (Oracle DATE has a time) |
| active | bool `true` | BIT `true` | bit `true` | NUMBER `1` |
| data | bytea (base64) | BLOB (base64) | varbinary (base64) | BLOB (base64, read in full) |
| ref_id | uuid | CHAR(36) | uniqueidentifier (upper-case) | RAW (base64) |
| doc | jsonb `{"chargeId": "CHG-88213"}` | JSON | nvarchar | CLOB |
| failure | 23505 duplicate key | 23000 / 1062 | 23000 / 2627 | 23000 / ORA-00001 |

Found and fixed by this run: pgjdbc answers result-set metadata (`getColumnTypeName`) with a JDBC query of its own,
which the agent captured and then read the metadata of - recursing into a StackOverflowError. Every agent-internal
driver call now runs under the dispatcher's agent-work guard. CLOB/BLOB values were recorded as opaque placeholders;
they are now read in full up to 16 MB (`truncatedAt` says when a longer one was cut). MySQL returns `DATETIME` as
`LocalDateTime`; it is now written in the same form as every other timestamp.

To repeat: start the four containers on one Docker network (`postgres:16-alpine`, `mysql:8.4`,
`mcr.microsoft.com/mssql/server:2022-latest`, `gvenzl/oracle-free:23-slim-faststart`) and run, in `db-agent/`,
`mvn -Pvendors test -Dtest=VendorCaptureIT` with `VENDOR_PG_URL`, `VENDOR_MYSQL_URL`, `VENDOR_MSSQL_URL`,
`VENDOR_ORACLE_URL` (and `_USER`/`_PASSWORD`) set.
