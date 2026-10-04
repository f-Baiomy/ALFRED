# Implementation Plan: Database Capture

**Branch**: `006-db-capture` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/006-db-capture/spec.md`
**Design**: [mock.html](mock.html) (v5, agreed) - the UI is built to match it; see [contracts/ui.md](contracts/ui.md)

## Summary

Record every database statement a Java application runs, tied exactly to the inbound call that caused it and
ordered exactly against that call's supplier calls, then show it in ALFRED as one `◆ DB` chip per call that opens
a database window - the window, its tree, flags, time strip, value tracing, Tables view, row and statement queries,
delete/update details and the three capture switches all exactly as in the agreed mock.

Technical approach (research D1-D17): a new **Java 8 agent** (`db-agent/`, ByteBuddy shaded) attached live or at
startup instruments JDBC and the servlet entry point; the **reverse proxy** stamps each logged inbound request with
`X-Alfred-Call` (call id, per-project `db` switch from a new flag file, Relive run tag); the agent tags outbound HTTP
with `X-Alfred-Parent`, which the **forward proxy** pops and records; statements flow in batches to a new leaf slice
**`backend-db-capture`** with its own SQLite file, which computes summaries and flags at ingest, pages rows, runs
sandboxed queries over recorded data, and pushes changes over `/ws/db-capture`. The **frontend** adds the chip,
the window and its parts, the switches in the Sources bar / cycle widget / Settings, and the export sections.

Scope: spec Stories 1-4 only. Relive integration (Stories 5-7) is a later feature; FR-040..043 are built now so it
can be added without re-capturing (one `StatementInterceptor` seam, full stored outcome, fingerprint + seq, run
tag). Mock elements that belong to Relive are listed as deferred in [contracts/ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: Java 21 (backend), **Java 8 bytecode** for `db-agent` (runs on Java 8-21+), TypeScript /
Angular (frontend, standalone + signals), Python 3 (mitmproxy addons)
**Primary Dependencies**: Spring Boot (existing), xerial sqlite-jdbc + HikariCP (existing), mitmproxy (existing),
Angular (existing); **new**: `net.bytebuddy:byte-buddy` (agent only, shaded + relocated, pinned)
**Storage**: new `db-capture.db` (SQLite) on a `db-capture-db` named volume; new flag file
`proxy/db-capture-enabled.flag`; schema in [data-model.md](data-model.md)
**Testing**: JUnit 5 + Mockito + AssertJ + ArchUnit (backend); JUnit 5 + H2 + Testcontainers-free in-process JDBC
for the agent, plus a Java 8 runtime self-test in `eclipse-temurin:8`; pytest (proxies); Karma/Jasmine (frontend)
**Target Platform**: Docker Compose stack (Linux containers) + the user's host JVM running WildFly (Windows/Linux)
**Project Type**: web application (multi-module backend + Angular frontend) plus an in-process agent
**Performance Goals**: ≤ 5 % added response time for a ~50-statement call (SC-002); window usable < 1 s at 500
statements (SC-005); 50,000 stored rows scroll end to end without freezing; ingest keeps up with 50 concurrent calls
**Constraints**: the app thread never waits on ALFRED (FR-005); no polling in the UI; list queries never read
bodies/rows; every store capped; nothing hidden by default except user redaction rules; 50,000 rows per result
**Scale/Scope**: hundreds of statements per call, up to 50,000 stored rows per result, four database vendors,
one agent per application JVM; 4 user stories, ~20 new frontend components, 1 new backend slice, 1 new agent module

No NEEDS CLARIFICATION remains - every unknown is resolved in [research.md](research.md).

## Constitution Check

*Gate before Phase 0 and re-checked after Phase 1 design. Result: **PASS** (deliberate exceptions in Complexity
Tracking).*

- [x] **I. Security**
  - Agent endpoints require `X-Webhook-Secret` (same secret as the proxies); the agent reads it from `.env` via
    `secretFile`, never logs it or puts it on a command line.
  - All DTOs `@Valid`; batch size/bytes, paging limits, query length and query time clamped server-side
    (data-model "Validation rules").
  - User SQL runs only in a throwaway in-memory SQLite holding the one result the user is already viewing,
    `PRAGMA query_only`, single `SELECT`/`WITH`, 3 s budget (research D10) - it can reach neither `db-capture.db`
    nor the application's database.
  - Captured values are untrusted: rendered only through Angular bindings (no `innerHTML`; SQL colouring via
    tokens), escaped in .md/.html exports.
  - Logs carry ids and sizes only - never SQL values, rows or the secret (backend and agent).
  - `X-Alfred-Call` from a client is stripped before the proxy adds its own (no call impersonation).
  - Data sensitivity: everything is captured and shown by owner decision (clarify Q4); exports are masked through
    the single `redact.ts` choke point with a new `db-column` kind (research D18).
  - New dependency ByteBuddy: justified in research D2, pinned, shaded, relocated.
- [x] **II. Performance**
  - Proxy path: header stamping/popping is in-memory string work in existing `async def` hooks; the flag file is
    mtime-cached like `_ToggleState`. No backend call added to the request path.
  - App path: the agent only enqueues (bounded queue, drop + count when full); I/O on one daemon thread; before-image
    reads happen only for tables the user opted into.
  - No UI polling: `/ws/db-capture` signals, fetch on demand. The agent's 10 s heartbeat is agent→backend status,
    not a UI refresh (Complexity Tracking).
  - Summaries for lists (chip reads `call_db_summary` only); statement lists name columns; rows paged by
    `(statement_id, part, row_index)`; every query has a `LIMIT`.
  - Retention: size cap with eviction by age skipping calls held by session cycles and Relive cycles/runs; deletion with the call; outside-call
    bucket capped (research D9).
  - Measurements recorded in `docs/db-capture.md` (SC-002 overhead, ingest throughput, window open time).
- [x] **III. Architecture**
  - New leaf slice `backend-db-capture` (hexagonal: `domain.model`, `application.port.in|out`,
    `application.service`, `adapter.in.web`, `adapter.out.sqlite|filestore|websocket`), added to the aggregator,
    `backend-app` and `backend-architecture-test` with an isolation rule.
  - **No new slice→slice edge.** Cooperation happens in `backend-app`: a `RetainedCallIdsPort` implementation over
    session-cycles' use cases, and a deletion bridge calling `DeleteCallStatementsUseCase` when calls are deleted
    or cleared (same pattern as `relivebridge/RelatedCallsDeletionAdapter`).
  - `backend-calls` gets two nullable fields (`parentCallId`, `parentSeq`) - inside its own slice.
  - SQLite only, no flat-file adapter - same justified exception as `backend-logs` (Complexity Tracking).
  - Frontend: standalone components + signals; `app-call-card`, `app-sources-bar`, `app-cycle-widget` and the
    Settings page are extended, not forked; pure logic in `shared/utils`.
  - Proxies persist nothing; backend is the system of record.
- [x] **IV. Style**: `*UseCase` per operation (`IngestStatementsUseCase`, `GetCallStatementsUseCase`,
  `GetStatementRowsUseCase`, `QueryRecordedDataUseCase`, `TraceValueUseCase`, `GetCallDbSummariesUseCase`,
  `ManageDbCaptureUseCase`, `RecordAgentHeartbeatUseCase`, `DeleteCallStatementsUseCase`), `*Port`,
  `DbCaptureService`/`DbCaptureQueryService`, `SqliteDbCaptureRepository`, `FileDbCaptureToggleAdapter`,
  `*RequestDto`; records; constructor injection; strict TS. Python follows `log_and_route*.py`. The agent mirrors
  `wildfly-proxy-toggle`'s documentation density.
- [x] **V. Clean code - reuse named**: `FileLoggingToggleAdapter` (pattern for the flag file), `_ToggleState`
  (proxy flag reading), `reconnectingSocket`, `WildFlyProxyController` detection (new `load-agent` mode instead of a
  second detector), `.dialog-*`/`.block-*`/`.source-pill-*`/`.cw-*` styles, `buildCallTree` (extended with explicit
  parents, not replaced), existing export builders and `export-narrative.ts`, existing redaction rules, `RelatedCallsDeletionAdapter`
  pattern. YAGNI: no Relive endpoints, overrides or UI now; `StatementInterceptor` has one implementation.
- [x] **VI. Verification**: tests per layer listed under Project Structure; realistic fixtures (reference
  recordings with 500 statements and a 100,000-row result; export fixtures via `buildBulkExportPayload`); agent
  tested on Java 8 and 21 runtimes; `mvn test`, `npm test`, `npm run build`, pytest all pass.
- [x] **Invariants**: exports untruncated (stored rows written in full; the only cap is the documented per-result
  storage limit, shown to the user); interception untouched; `db-capture` added to the gateway regex; docs updated
  (`docs/db-capture.md` new; `CLAUDE.md`, `AGENTS.md`, `docs/architecture.md`, `docs/supplier-integrations.md`,
  `docs/frontend-architecture.md`, `wildfly-proxy-toggle/README.md`).

**Post-design re-check (after Phase 1)**: PASS - the data model keeps rows out of list reads, the contracts add no
backend call to any proxy path, and the UI contract forbids `innerHTML`.

## Project Structure

### Documentation (this feature)

```text
specs/006-db-capture/
├── spec.md              # feature spec (clarified)
├── mock.html            # agreed UI design (v5) - the visual specification
├── plan.md              # this file
├── research.md          # D1-D17
├── data-model.md        # records, SQLite schema, validation, state transitions
├── quickstart.md        # build, attach, verify
├── contracts/
│   ├── proxy-headers.md # X-Alfred-Call, X-Alfred-Parent, db-capture-enabled.flag
│   ├── agent-ingest.md  # agent args, heartbeat, batch
│   ├── rest-api.md      # /db-capture endpoints + changes to existing ones
│   ├── websocket.md     # /ws/db-capture
│   ├── export-format.md # .json/.md/.html additions
│   └── ui.md            # mock element → component map; deferred Relive elements
├── checklists/requirements.md
└── tasks.md             # /speckit.tasks (not created here)
```

### Source Code

```text
db-agent/                                   # NEW - Maven project, Java 8 target, shaded jar
├── pom.xml
└── src/
    ├── main/java/com/fathy/alfred/dbagent/
    │   ├── AlfredDbAgent.java              # premain/agentmain, args, installs transformers
    │   ├── context/CallContext.java        # ThreadLocal call id, run tag, seq counter
    │   ├── context/ContextPropagation.java # executor/ForkJoin/CompletableFuture wrapping
    │   ├── servlet/ServletEntryAdvice.java # javax + jakarta HttpServlet.service, reads X-Alfred-Call
    │   ├── jdbc/                           # Connection/Statement/ResultSet advice, StatementRecorder
    │   ├── jdbc/StatementInterceptor.java  # FR-042 seam; CaptureOnlyInterceptor = only impl
    │   ├── jdbc/BeforeImageReader.java     # opt-in pre-read (D12), CascadeInspector
    │   ├── http/OutboundHeaderAdvice.java  # X-Alfred-Parent on HttpURLConnection + Apache HttpClient 4/5
    │   ├── values/ValueCodec*.java         # standard + Oracle/PostgreSQL/MySQL/SQL Server by reflection
    │   ├── transport/BatchSender.java      # bounded queue, daemon sender, heartbeat, JsonWriter
    │   └── sql/SqlShape.java               # kind, table, where-clause split, fingerprint
    └── test/java/...                       # H2-backed JDBC tests, concurrency, overhead, codecs, transport

proxy/
├── log_and_route_reverse.py               # + strip client X-Alfred-Call, stamp id/db/run; read db flag
├── log_and_route.py                       # + pop X-Alfred-Parent, log parent_call_id/parent_seq
├── db-capture-enabled.flag                # NEW (created by start.py; gitignored like the other flag)
└── test_db_capture_headers.py             # NEW

backend/
├── pom.xml                                # + <module>backend-db-capture</module>
├── backend-db-capture/                    # NEW leaf slice
│   └── src/main/java/com/fathy/alfred/backend/dbcapture/
│       ├── domain/model/                   # CapturedStatement, TypedValue, StatementOutcome, ResultRow,
│       │                                   # BeforeImage, StatementTransaction, CallDbSummary, DbFlag,
│       │                                   # DbCaptureSettings, AgentStatus, StatementKind ...
│       ├── domain/StatementFlags.java      # flag rules (D11), pure
│       ├── domain/DeletedRowsResolver.java # earlier-read linking (D12), pure
│       ├── application/port/in/            # the *UseCase interfaces listed in the Constitution Check
│       ├── application/port/out/           # DbCaptureStorePort, RecordedDataQueryPort, DbCaptureTogglePort,
│       │                                   # DbCaptureNotificationPort, RetainedCallIdsPort
│       ├── application/service/            # DbCaptureService, DbCaptureQueryService, DbCaptureRetention
│       ├── adapter/in/web/                 # DbCaptureAgentController (secret), DbCaptureController, dto/
│       └── adapter/out/                    # sqlite/SqliteDbCaptureRepository, sqlite/InMemoryQuerySandbox,
│                                           # filestore/FileDbCaptureToggleAdapter, websocket/...
├── backend-calls/                          # + parentCallId/parentSeq on the outbound record + SQLite columns
├── backend-app/                            # + dbcapturebridge/: RetainedCallIdsAdapter, CallStatementsDeletionAdapter
└── backend-architecture-test/              # + backend-db-capture isolation rule

frontend/src/
├── app/core/models/db-capture.model.ts
├── app/core/services/db-capture-api.service.ts
├── app/core/state/db-capture-state.service.ts
├── app/components/db-capture/              # db-chip, db-window, db-flags, db-time-strip, db-statement-tools,
│                                           # db-statement-row, db-statement-group, db-supplier-marker,
│                                           # db-statement-detail, db-rows-table, db-deleted-rows, db-trace-bar,
│                                           # db-tables-view, db-statement-query-result, db-capture-popover,
│                                           # db-capture-settings, db-outside-window
├── app/components/call-card/               # + <app-db-chip>
├── app/components/sources-bar/             # + ◆ switch and ▾ popover per project
├── app/components/cycle-widget/            # + "Log DB" column
├── app/pages/settings/                     # + Database capture section
├── app/shared/utils/                       # sql-render, db-statement-tree, db-flags, db-time-strip, db-trace,
│                                           # db-row-query-examples (+ specs); call-tree.ts explicit parents;
│                                           # bulk-json-builder, import-parser, markdown-builder, html-builder,
│                                           # export-narrative (+ specs)
└── styles/_db-capture.scss                 # new rules from the mock only (contracts/ui.md)

wildfly-proxy-toggle/                       # + load-agent mode in WildFlyProxyController; db-capture-on/off scripts
gateway/nginx.conf                          # + db-capture in the backend prefix regex
docker-compose.yml                          # + db-capture-db volume, flag-file mounts, DB_CAPTURE_* env
start.py / restart.py                       # + flag file creation, --db-capture on|off
docs/db-capture.md                          # NEW; CLAUDE.md, AGENTS.md and the docs listed above updated
```

**Structure Decision**: Web application with a multi-module backend and Angular frontend, as today, plus one new
top-level `db-agent/` Maven project (it ships into the user's JVM, so it must not be part of the Spring reactor or
share its Java 21 target). Backend work lives in the new leaf slice; cross-slice cooperation in `backend-app`.

## Delivery phases (input to /speckit.tasks)

**Phase A - Stories 1 + 2 (capture, attribution, window, switches)**
1. Proxies: `X-Alfred-Call` stamping + client-header strip, db flag reading; `X-Alfred-Parent` pop + logging; tests.
2. `backend-calls`: `parentCallId`/`parentSeq` end to end; frontend `call-tree.ts` prefers explicit parents.
3. `db-agent`: context + servlet entry + propagation; JDBC capture (all kinds, batches, OUT params, LOBs, errors,
   transactions); value codecs for the four vendors; outbound header; transport + heartbeat; `StatementInterceptor`
   seam; tests incl. concurrency, overhead, Java 8 runtime.
4. `backend-db-capture`: domain, ingest (idempotent), store, summaries, statements/rows paging, projects/switch/
   settings/agent status, outside bucket, WebSocket, retention + `backend-app` bridges, ArchUnit, gateway, compose.
5. Frontend: models/api/state + socket; `app-db-chip`; `app-db-window` with tools (Search mode), rows, groups,
   supplier markers, details (Error, Statement, Params, Rows, Generated keys, Where in code), fixed-height rows
   table; switches in Sources bar (+ popover), cycle widget, Settings; other states; exports + import.
6. Attach tooling: `load-agent` mode, `db-capture-on/off`, `start.py --db-capture`.

**Phase B - Stories 3 + 4 (investigation, deletes and updates)**
7. Backend: `StatementFlags`, tables summary, trace, sandboxed queries (rows and statements), expected/ignore
   patterns; `DeletedRowsResolver`, before-image + cascade ingest.
8. Agent: before-image reads, cascade inspection, ignore patterns.
9. Frontend: flags row, time strip, Tables view, value tracing, SQL mode for statements and rows with "Try:" chips,
   Deleted rows tab, Before → after, before-image switch boxes, expected/ignore in Settings.
10. Docs and measurements (`docs/db-capture.md`), full suites.

**Later feature (not in tasks)**: Relive Stories 5-7 on top of FR-040..043.

## Complexity Tracking

| Exception | Why needed | Simpler alternative rejected because |
|---|---|---|
| New dependency ByteBuddy (agent only) | Retransforming JDBC/servlet/HTTP classes in a live JVM on Java 8-21 | Hand-written ASM is far more code and risk; Javassist has weaker retransformation; a `DataSource` proxy needs app-server config and breaks vendor `unwrap` (research D1/D2) |
| Agent heartbeat every 10 s | FR-014 "is the agent attached / last seen" and delivering settings to the agent | Backend cannot open a connection to the host JVM reliably; status piggy-backed on batches would show "detached" whenever the app is idle. It is agent→backend status, not UI polling |
| No flat-file adapter for `backend-db-capture` | Paged rows, per-call indexes and size-based eviction over millions of rows | A flat file would have to be read whole per request (Constitution II) - same reason `backend-logs` has none |
| User-written SQL executed by the backend | FR-027 asks for SQL over recorded data; rows are paged so the browser never holds a whole result | In-browser engine needs all 50,000 rows client-side; running it against `db-capture.db` could read other calls or lock the store - hence the per-request in-memory sandbox (research D10) |
| New top-level `db-agent/` build outside the backend reactor | It runs inside the user's JVM on Java 8 | Putting it in the Spring reactor would force Java 21 and Spring's dependency graph onto it |
