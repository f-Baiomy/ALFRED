---
description: "Task list for Database Capture (006-db-capture)"
---

# Tasks: Database Capture

**Input**: Design documents from `specs/006-db-capture/` - [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), and the agreed design
[mock.html](mock.html).

**Scope**: Stories 1-4 only. Relive (Stories 5-7) is a later feature - build FR-040..043 hooks, nothing else
(see memory note and [contracts/ui.md](contracts/ui.md) "deferred").

**Tests**: Included. The constitution (VI) requires tests per layer, and the spec's success criteria need them.

**Design rule for every UI task**: match [mock.html](mock.html) exactly - layout, wording, colours, badges,
interactions - following the element → component map in [contracts/ui.md](contracts/ui.md). Reuse existing Alfred
classes; put only new rules in `frontend/src/styles/_db-capture.scss`. Never render call data with `innerHTML`.

**Commits**: the last task of every phase commits that phase (owner's instruction). A phase is committed only when
its tests pass. Commit messages follow the repo style (`feat(db-capture): …`) and end with the attribution line.
Never push unless asked.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1-US4 = spec User Stories 1-4

## Path Conventions

- Agent: `db-agent/src/main/java/com/fathy/alfred/dbagent/…`, tests in `db-agent/src/test/java/…`
- Backend slice: `backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture/…` (shortened below to `dbcapture/…`)
- Frontend: `frontend/src/app/…`, styles `frontend/src/styles/…`
- Build/test: backend and agent via the Docker Maven command in `CLAUDE.md` (bare `mvn` may be JDK 8 here); frontend
  `npx ng test --watch=false --browsers=ChromeHeadless --include=<spec>` for single specs

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: create the new modules and wire them into the build, compose and gateway.

- [X] T001 Create `db-agent/pom.xml`: groupId `com.fathy.alfred`, artifact `alfred-db-agent`, `maven.compiler.release=8`, dependency `net.bytebuddy:byte-buddy` (pinned latest 1.x supporting Java 8 targets), JUnit 5 + AssertJ + H2 (test scope), maven-shade-plugin relocating `net.bytebuddy` → `com.fathy.alfred.dbagent.shaded.bytebuddy`, manifest `Premain-Class`/`Agent-Class: com.fathy.alfred.dbagent.AlfredDbAgent`, `Can-Retransform-Classes: true`, final name `alfred-db-agent`; add `db-agent/target/` to `.gitignore`
- [X] T002 Create module `backend/backend-db-capture/pom.xml` mirroring `backend/backend-logs/pom.xml` (sqlite-jdbc, HikariCP, spring-web, websocket, validation); add `<module>backend-db-capture</module>` to `backend/pom.xml`; add the dependency to `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`
- [X] T003 [P] Create package skeleton `dbcapture/{domain/model,application/port/in,application/port/out,application/service,adapter/in/web/dto,adapter/out/sqlite,adapter/out/filestore,adapter/out/websocket}` with `package-info.java` only where the other slices have one
- [X] T004 [P] Add `db-capture` to the backend prefix regex in `gateway/nginx.conf` (line with `calls|internal-calls|…|logs`)
- [X] T005 [P] In `docker-compose.yml`: named volume `db-capture-db` mounted at `/dbcapturedb` in `backend` with `DB_CAPTURE_DB_FILE=/dbcapturedb/db-capture.db`; bind-mount `./proxy/db-capture-enabled.flag` to `/appdata/db-capture-enabled.flag` (backend) and `/home/mitmproxy/db-capture-enabled.flag` (reverse-proxy) with `DB_CAPTURE_TOGGLE_FILE` env in both; add `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` (default 4294967296)
- [X] T006 [P] In `start.py` and `restart.py`: create `proxy/db-capture-enabled.flag` (empty) if missing, next to the existing `reverse-proxy-enabled.flag` creation; add it to `.gitignore` like the existing flag
- [X] T007 [P] Create `frontend/src/styles/_db-capture.scss` (empty section headers mirroring [contracts/ui.md](contracts/ui.md)) and `@use` it from `frontend/src/styles.scss` where `_logs.scss` is included
- [X] T008 [P] Create `docs/db-capture.md` skeleton (overview, how it works, settings, env table, measurements placeholder) and link it from `CLAUDE.md` "Detailed docs" and `AGENTS.md`
- [X] T009 Verify the empty build: backend reactor compiles (Docker Maven), `db-agent` packages an empty shaded jar, `npm run build` passes
- [X] T010 Commit Phase 1: `chore(db-capture): add db-agent and backend-db-capture modules, compose, gateway and flag file wiring` (include `specs/006-db-capture/`)

**Checkpoint**: modules build; nothing functional yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the end-to-end backbone every story needs - headers through the proxies, the stored format, the ingest
path, the agent's context/transport, and the frontend plumbing.

**⚠️ No user story work starts before this phase is committed.**

### Proxies (contracts/proxy-headers.md)

- [X] T011 [P] Write `proxy/test_db_capture_headers.py`: reverse proxy strips a client-sent `X-Alfred-Call`; stamps `id=<callId>; db=0|1` only when inbound logging is on; `db=1` only when the flag file says `<project>=on` (missing line = off); adds `; run=<runId>/<stepKey>` for Relive flows; forward proxy pops `X-Alfred-Parent` and logs `parent_call_id`/`parent_seq`; malformed header ignored
- [X] T012 In `proxy/log_and_route_reverse.py`: add `DB_CAPTURE_TOGGLE_FILE` + a `_DbCaptureState` reader reusing `_ToggleState`'s mtime cache (default **off**); in `request`, pop any client `X-Alfred-Call` first, then after `call_id` is set add `X-Alfred-Call` to the forwarded request (include `run` from `relive_info`)
- [X] T013 In `proxy/log_and_route.py`: in `request`, pop `X-Alfred-Parent` before interception/forwarding, parse `<callId>; seq=<n>`, add `parent_call_id`/`parent_seq` to the call log posted to the backend
- [X] T014 Run `python -m pytest proxy/test_db_capture_headers.py proxy/test_interception.py proxy/test_relive.py` - all green

### Outbound parent link (backend-calls + call tree)

- [X] T015 [P] Add nullable `parentCallId` (String) and `parentSeq` (Integer) to the outbound call record and its webhook DTO in `backend/backend-calls/…/domain/model/` and `adapter/in/web/dto/`; map `parent_call_id`/`parent_seq` from the forward proxy payload
- [X] T016 Persist them in `backend-calls`' SQLite adapter (new nullable columns via the adapter's existing schema-migration pattern) and the file adapter; include them in summaries and detail
- [X] T017 [P] Tests: `CallsServiceTest` + SQLite adapter test round-trip the two fields; webhook controller test accepts payloads with and without them
- [X] T018 [P] Add `parentCallId?`/`parentSeq?` to `CallRecord` in `frontend/src/app/core/models/call.model.ts` and the mapping in `calls-api.service.ts`
- [X] T019 In `frontend/src/app/shared/utils/call-tree.ts`: when a call has `parentCallId` and that call is in the list, use it as the parent (no ambiguity) and order siblings by `parentSeq`; otherwise keep today's time containment; extend `call-tree.spec.ts` (explicit parent wins over containment; missing parent falls back; concurrency case that was ambiguous is now resolved); `buildCallTree` has ~36 callers, so also run the specs of `call-waterfall`, `call-diagnostics`, `mini-waterfall`, `relive-freeze`, `relive-call-source`, `export-narrative` and `call-tree-node`

### Backend slice backbone (data-model.md, contracts/agent-ingest.md)

- [X] T020 [P] Domain records in `dbcapture/domain/model/`: `StatementKind`, `TypedValue` (+`direction`), `Column`, sealed `StatementOutcome` (`Rows`, `Updated`, `ProcedureResult`, `Failed`, `TransactionEnd`), `CapturedStatement`, `ResultRow`, `BeforeImage`, `StatementTransaction`, `CallDbSummary`, `DbFlag`/`DbFlagType`, `CallMarker` (`CALL_OPEN`/`HTTP_OUT`), `DbCaptureSettings` (+defaults: rows 50,000, thresholds 20 ms/1,000/5/100, ignore `["SELECT 1"]`), `AgentStatus`
- [X] T021 [P] Ports in `dbcapture/application/port/out/`: `DbCaptureStorePort` (save batch idempotently, summaries, statements page, statement, rows page, delete by call ids, evict, settings, agents), `DbCaptureTogglePort`, `DbCaptureNotificationPort`, `RetainedCallIdsPort`
- [X] T022 `SqliteDbCaptureRepository` in `dbcapture/adapter/out/sqlite/`: HikariCP on `DB_CAPTURE_DB_FILE`, schema exactly as data-model.md (tables incl. `call_markers`, `WITHOUT ROWID`, indexes), WAL, writability check at `@PostConstruct`, named-column queries with `LIMIT`; `INSERT … ON CONFLICT(call_id, seq) DO NOTHING` for idempotent ingest; rows written in their own table
- [X] T023 [P] `FileDbCaptureToggleAdapter` in `dbcapture/adapter/out/filestore/` - same line format and re-read-on-call behaviour as `backend-internal-calls`' `FileLoggingToggleAdapter`, but a missing line means **off**
- [X] T024 [P] WebSocket: `DbCaptureWebSocketConfig`, `DbCaptureEventsWebSocketHandler`, `WebSocketDbCaptureNotificationAdapter` in `dbcapture/adapter/out/websocket/` at `/ws/db-capture`, messages as contracts/websocket.md (copy the `backend-logs` websocket trio's shape)
- [X] T025 Use cases + `DbCaptureService`: `IngestStatementsUseCase` (validate, store statements and markers - `CALL_OPEN` creates a zero-count summary so "◆ DB 0" is distinguishable from "not captured" - recompute `call_db_summary` counts, mark transactions/`undone` on rollback, broadcast `statements-appended`), `RecordAgentHeartbeatUseCase` (store `AgentStatus`, return settings, broadcast `agent-status-changed` on attach/detach)
- [X] T026 `DbCaptureAgentController` in `dbcapture/adapter/in/web/`: `POST /db-capture/agent/batch` and `/heartbeat`, `X-Webhook-Secret` check exactly like `InternalCallsWebhookController`, gzip accepted, `@Valid` DTOs with the limits in data-model.md (≤ 2,000 statements, ≤ 32 MB, sql ≤ 1 MB)
- [X] T027 [P] Tests: `DbCaptureServiceTest` (fake ports: idempotent ingest, summary counts, rollback marks `undone`, broadcast), `SqliteDbCaptureRepositoryTest` (`@TempDir` file: schema, idempotency, paging limits, delete by call ids), `DbCaptureAgentControllerTest` (`@WebMvcTest`: 401 without secret, 400 on oversize/invalid, 202 on valid)
- [X] T028 ArchUnit: add the `backend-db-capture` isolation rule in `backend/backend-architecture-test` (no dependency on any other slice) and run the suite

### Agent backbone (research D3, D6, D17)

- [X] T029 [P] `AlfredDbAgent` (`premain` + `agentmain`): parse args `alfredUrl`, `project`, `secretFile` (read `WEBHOOK_SECRET=` once) or `secret`; never log the secret; install ByteBuddy `AgentBuilder` with `RETRANSFORMATION`, ignoring JDK internals, the agent's own and shaded packages
- [X] T030 [P] `context/CallContext` (ThreadLocal: callId, runTag, `AtomicInteger seq`, `db` flag) and `servlet/ServletEntryAdvice` on `javax.servlet.http.HttpServlet.service` and `jakarta.servlet.http.HttpServlet.service`: parse `X-Alfred-Call` (unknown parts ignored), open context only when `db=1` and enqueue a `CALL_OPEN` marker (seq 0), always clear in `finally` (abnormal exit marks the context `endedEarly`)
- [X] T031 `context/ContextPropagation`: wrap `Runnable`/`Callable` at `ThreadPoolExecutor.execute`, `ScheduledThreadPoolExecutor.schedule*`, `ForkJoinPool.execute/submit`, `CompletableFuture.*Async`; restore/clear around run
- [X] T032 [P] `transport/JsonWriter` (minimal, escaping, no dependency) and `transport/BatchSender`: bounded queue (20,000 statements / 64 MB), daemon thread, batch every 250 ms or 500 statements, gzip POST with `X-Webhook-Secret`, one retry with back-off then drop, dropped counters, ≤ 1 WARN/minute, heartbeat every 10 s storing the returned settings in a volatile `AgentSettings`
- [X] T033 [P] `jdbc/StatementInterceptor` interface + `CaptureOnlyInterceptor` (`before()` → `Proceed` always) - the FR-042 seam; javadoc explains the later Relive implementations (`AnswerWith`, `Fail`, `Await`) without adding them
- [X] T034 [P] Agent tests: `CallContextTest` (header parsing, `db=0` → no context, cleanup after exception), `ContextPropagationTest` (executor, ForkJoin, CompletableFuture keep the call id), `JsonWriterTest` (escaping, unicode, nulls), `BatchSenderTest` (local `com.sun.net.httpserver` stub: batching, gzip, secret header, queue-full drop count, backend down → app thread never blocks, heartbeat applies settings)

### Frontend plumbing

- [X] T035 [P] `frontend/src/app/core/models/db-capture.model.ts` mirroring data-model.md (statements list item, statement detail, rows page, summary, flags, settings, project status, query request/response, WS messages)
- [X] T036 [P] `frontend/src/app/core/services/db-capture-api.service.ts` - every endpoint in contracts/rest-api.md
- [X] T037 `frontend/src/app/core/state/db-capture-state.service.ts`: one `reconnectingSocket` to `/ws/db-capture`, projects + agent status signal, summaries cache keyed by call id with a batched `summaries` fetch (coalesced per animation frame), re-fetch on reconnect; no timers
- [X] T038 Commit Phase 2: `feat(db-capture): call/parent headers in the proxies, exact outbound parent link, statement store and ingest, agent context and transport`

**Checkpoint**: a request through the reverse proxy carries `X-Alfred-Call`; an agent batch POST is stored; outbound calls carry their parent.

---

## Phase 3: User Story 1 - See what the code did in its database for a call (Priority: P1) 🎯 MVP

**Goal**: every statement of a call captured, linked exactly, shown through the ◆ DB chip and the database window
as in the mock (without the Phase 5/6 extras).

**Independent Test**: attach the agent to an app, make one inbound call that reads, writes and calls a supplier;
the chip shows the counts and the window lists every statement in run order with the supplier call between the
right statements; 50 concurrent calls are each attributed correctly.

### Agent capture (research D1, D7, D8)

- [X] T039 [P] [US1] `sql/SqlShape`: statement kind, first table / procedure name, fingerprint (normalised SQL + param types, FR-041); tests in `SqlShapeTest` (all kinds, comments, quoted identifiers, `{call …}`, MERGE, CTEs)
- [X] T040 [US1] `jdbc/ConnectionAdvice`: prepare*/createStatement/prepareCall bind SQL to the statement; commit/rollback/setSavepoint/rollback(Savepoint)/setAutoCommit/close drive transaction ids (`tx-<n>` per call), held time, connection id; JDBC rule: close without commit = rolled back
- [X] T041 [US1] `jdbc/StatementAdvice`: set*/setObject/setNull capture typed params; addBatch builds param sets; execute/executeQuery/executeUpdate/executeLargeUpdate/executeBatch record kind, duration, offset, affected counts (per set for batches), generated keys, `SQLException` (state, vendor code, message, chain); OUT params for `CallableStatement`; code location = first frame outside JDBC/pool/framework packages; calls `StatementInterceptor.before()` first; tags `seq`, `runTag`, thread
- [X] T042 [US1] `jdbc/ResultSetAdvice`: record rows as the app reads them (D7) up to `AgentSettings.rowsPerResult`, metadata from `ResultSetMetaData`, `partial`/`rowsRead` on close, never read ahead; long results stream to the sender in 500-row continuation chunks
- [X] T043 [P] [US1] `values/` codecs: `StandardValueCodec` (exact decimals, ISO dates with zone, base64 bytes, booleans), `OracleValueCodec`, `PostgresValueCodec`, `MySqlValueCodec`, `SqlServerValueCodec` - vendor classes by reflection only; LOB/stream tee up to 16 MB with `truncatedAt`; unknown → `opaque`
- [X] T044 [P] [US1] `http/OutboundHeaderAdvice`: add `X-Alfred-Parent: <callId>; seq=<n>` (next seq from the context) on `HttpURLConnection` before connect and on Apache HttpClient 4 (`HttpClient.execute`) and 5 (`CloseableHttpClient.execute`) requests, and enqueue an `HTTP_OUT` marker with the same seq, method and URL without query string
- [X] T045 [US1] Outside-call statements: no context → thread-name bucket, captured only when `AgentSettings.outsideCallCapture`; ignore patterns from settings skip statements entirely (settings UI for them: T096)
- [X] T046 [P] [US1] Agent tests with H2: `JdbcCaptureIT` (select/insert/update/delete/batch/procedure-style call, generated keys, failure with SQLState, commit/rollback marks, savepoint, autocommit), `ResultSetCaptureIT` (partial read recorded as partial, 50,000 limit, no read-ahead), `ConcurrentAttributionIT` (50 threads × distinct call ids, 100 % correct - SC-001), `OutboundHeaderIT` (local HTTP stub sees `X-Alfred-Parent` with correct seq), `ValueCodecTest` per vendor with fake vendor classes on a test classpath
- [ ] T047 [US1] `OverheadMeasurementTest` (50-statement call, capture off vs on, 1,000 iterations, H2) - asserts ≤ 5 % and prints numbers for `docs/db-capture.md` (SC-002); Java 8 runtime self-test jar executed in `eclipse-temurin:8` (quickstart §5)

### Backend (contracts/rest-api.md)

- [ ] T048 [US1] Use cases + `DbCaptureQueryService`: `GetCallDbSummariesUseCase` (≤ 500 ids), `GetCallStatementsUseCase` (`afterSeq`, limit clamp 1..500, includes transactions and the call's stored `HTTP_OUT` markers as `supplierMarkers`; the frontend matches them to outbound calls by `parentCallId` + `parentSeq`), `GetStatementUseCase`, `GetStatementRowsUseCase` (part, offset, limit clamp 1..1,000), outside-bucket listing
- [ ] T049 [US1] `DbCaptureController`: `GET /db-capture/summaries`, `/calls/{id}/statements`, `/statements/{id}`, `/statements/{id}/rows`, `/outside`; `DELETE /db-capture/calls/{id}`; errors through `GlobalExceptionHandler`
- [ ] T050 [US1] Call completion: mark `swallowed` on failed statements when the inbound call completed with status < 500, set `CallDbSummary.complete`, broadcast - driven by a `backend-app` adapter implementing `backend-internal-calls`' existing `NewInternalCallObserverPort` that forwards inbound completion (id + status) to a `CompleteCallCaptureUseCase` (no slice edge, no timer)
- [ ] T051 [US1] Retention `DbCaptureRetention`: size cap `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES`, evict oldest `first_seen` calls first skipping `RetainedCallIdsPort` ids; outside bucket capped at 7 days / 20 % (research D9); runs after ingest when the cap is crossed (no timer)
- [ ] T052 [US1] `backend-app` bridges in `backend/backend-app/src/main/java/com/fathy/alfred/backend/dbcapturebridge/`: `RetainedCallIdsAdapter` (call ids held by session cycles and by Relive cycles/runs, via their existing use cases) and `CallStatementsDeletionAdapter` (on call delete/clear in `backend-calls`, `backend-internal-calls` and `DatabaseStatsController.clearCalls`, call `DeleteCallStatementsUseCase`) - follow `relivebridge/RelatedCallsDeletionAdapter`
- [ ] T053 [P] [US1] Tests: `DbCaptureQueryServiceTest` (paging, clamps, afterSeq), `DbCaptureRetentionTest` (cap, retained ids skipped), `DbCaptureControllerTest` (`@WebMvcTest`), bridge tests in `backend-app`, ArchUnit re-run

### Frontend - chip and window (mock: card chip, database window, statement rows, tree, details)

- [ ] T054 [P] [US1] `shared/utils/sql-render.ts` + spec: SQL → tokens (keyword, text, value, placeholder, redacted, blob, out) with filled/placeholder modes and literal formatting per type (quotes escaped, `TIMESTAMP '…'`, NULL); pretty mode breaks before FROM/WHERE/SET/VALUES/ORDER BY
- [ ] T055 [P] [US1] `shared/utils/db-statement-tree.ts` + spec: statements + supplier markers merged by `seq`; transactions and runs of the same fingerprint (≥ threshold) become groups; rolled-back groups flagged; repeated groups start folded
- [ ] T056 [P] [US1] `components/db-capture/db-chip` (mock: `◆ DB n · w writes · f failed · k flags`; dimmed `◆ DB 0` when a summary exists with zero statements; pulsing `live` while the call is in progress; no chip when there is no summary and the project was not being captured; "capture ended early" when `endedEarly`) inserted in `components/call-card/call-card.component.html` after the source badge in both the sandwich request band and the flat card
- [ ] T057 [US1] `components/db-capture/db-window`: `.dialog-backdrop` + `.dialog-card.db-window` exactly as the mock - title with method + URL, sub-line, stats pills, ▴/▾ compact summary, ✕/Esc/backdrop close, Statements tab (Tables tab added in US3), footer (`Showing n of N statements`, hint, Copy all SQL, Export .sql); fetches statements, appends on `statements-appended`
- [ ] T058 [P] [US1] `components/db-capture/db-statement-tools`: Search box, All/Reads/Writes/Deletes/Failed, Supplier calls, Fill in values, Expand/Collapse all (the Search/SQL toggle's SQL side comes in US3)
- [ ] T059 [P] [US1] `components/db-capture/db-statement-row` (chevron, `#n`, verb badge colours `v-read/v-write/v-del/v-call/v-tx/v-fail`, SQL tokens, result, ms, +offset; `marks` input renders `BATCH ×n`; failed/undone styles) and `db-statement-group` (tree node row, branch lines, fold, TX label/meta/warning)
- [ ] T060 [P] [US1] `components/db-capture/db-supplier-marker` (cyan dashed line, method badge, URL, status, ms, "show call ↗" closes the window and flashes the existing card)
- [ ] T061 [US1] `components/db-capture/db-statement-detail`: tab list from one array (so Relive tabs slot in later) - Error, Statement (filled/placeholder + batch note), Params (incl. batch sets, OUT, redacted, blob with Open), Rows, Generated keys, Where in code (thread, location, IntelliJ/VS Code links); actions Copy SQL
- [ ] T062 [US1] `components/db-capture/db-rows-table`: fixed 320 px box, sticky header, first 100 rows then 100 more on scroll via `rows?offset=`, count line ("N rows · n loaded · all rows are stored…"), small results without the box (search/SQL bar comes in US3)
- [ ] T063 [US1] Other states from the mock: `db-outside-window` (outside-call bucket by thread), "too many rows to keep" notice, "not captured" vs `DB 0`
- [ ] T064 [US1] Move the mock's new CSS for the above into `frontend/src/styles/_db-capture.scss` (only rules that do not already exist in `styles.scss`), check light and dark themes
- [ ] T065 [P] [US1] Component tests only where behaviour is DOM-only: `db-rows-table` (loads next page on scroll), `db-window` (appends on WS message, Esc closes)

### Exports (contracts/export-format.md)

- [ ] T066 [US1] `shared/utils/bulk-json-builder.ts` adds `dbCapture` on the complete event; `import-parser.ts` reads it back; import stores it via `POST /db-capture/import` (contracts/rest-api.md)
- [ ] T067 [P] [US1] `markdown-builder.ts`, `html-builder.ts`: "Database" section per call (flags, transactions, statements with values, rows/before-images as tables, escaped); `export-narrative.ts` one sentence when present
- [ ] T068 [P] [US1] Specs: round-trip with fixtures built by `buildBulkExportPayload` (large result, batch, OUT params, failure), no-truncation guard extended to statement rows, md/html escaping of a hostile captured value
- [ ] T069 [P] [US1] `shared/utils/sql-param-columns.ts` + spec: map parameter positions to column names for INSERT column lists, `SET col = ?` and `WHERE col = ?` (else unknown); add `db-column` to `RedactionKind` in `frontend/src/app/core/models/redaction.model.ts` and extend `shared/utils/redact.ts` to mask `dbCapture` result/before-image columns and mapped params with that name, counting them in `redactedValueCount`; extend `redact.spec.ts` (window data untouched, every export format masked)
- [ ] T070 [US1] `backend-redactions`: accept the `db-column` kind (enum/validation in its domain model and DTO) + controller/service tests
- [ ] T071 [US1] "Hide in exports" action on a column header in `db-rows-table` and on a Params row in `db-statement-detail` (creates a `db-column` redaction via `RedactionsApiService`, shows "hidden in exports" on that column); Settings → Database capture Redaction row lists `db-column` rules
- [ ] T072 [P] [US1] `shared/utils/sql-export-builder.ts` + spec: a call's statements as a runnable `.sql` script (values filled in, transactions as comments, failures as comments, every statement - no truncation, redaction applied through `redact.ts`); wire "Export .sql" and "Copy all SQL" in `db-window`
- [ ] T073 [US1] Run backend tests (Docker Maven), `db-agent` verify, pytest, `npm test`, `npm run build`; manual check per quickstart §3 against a real WildFly app
- [ ] T074 [US1] Commit Phase 3: `feat(db-capture): capture statements per inbound call and show them in the database window`

**Checkpoint**: MVP - statements visible per call, exactly linked and ordered, exportable.

---

## Phase 4: User Story 2 - Switch capture on and off per project (Priority: P1)

**Goal**: the ◆ switch in the Sources bar (+ ▾ popover), the cycle widget's **Log DB** column and Settings →
Database capture, all one setting, plus agent status and attach tooling.

**Independent Test**: toggle in one place, the other two update within 2 s (SC-009); calls made while off are not
captured; the switch is unavailable while inbound logging is off; an unattached project says so.

- [ ] T075 [US2] `ManageDbCaptureUseCase` + endpoints `GET /db-capture/projects`, `PUT /db-capture/projects/{p}/enabled` (409 when inbound logging is off - read through a `backend-app` adapter over `LoggingToggleUseCase`, no slice edge), `GET|PUT /db-capture/projects/{p}/settings` (validation per data-model), broadcast `capture-settings-changed`; tests in `DbCaptureServiceTest` / `DbCaptureControllerTest`
- [ ] T076 [P] [US2] `components/db-capture/db-capture-popover` (mock ▾ panel: switch, agent ● attached / not attached + How to attach, before-image chips, rows per result, "Show the ◆ DB chip on calls", "All database settings →") anchored under the pill
- [ ] T077 [US2] `components/sources-bar/sources-bar.component.html|ts`: add `◆` switch (`db-sw`, glows teal when on, blocked with tooltip when inbound off) and `▾` after each project's inbound dot, exactly as the mock; wire to `DbCaptureStateService`
- [ ] T078 [US2] `components/cycle-widget/cycle-widget.component.html|ts`: "Log DB" column in the Sources popover (`cw-switch db`, teal), `-` for External, "· agent not attached" warning, footer "Logging and DB switches apply to every cycle and user"; chip row shows the project as captured when on
- [ ] T079 [US2] `pages/settings`: new `app-db-capture-settings` section (Capture checkboxes = same switch + agent status, Rows kept per result; before-image/thresholds/expected/ignore rows render here and become editable in US3/US4)
- [ ] T080 [P] [US2] Frontend tests: switch disabled when inbound off; one WS `capture-settings-changed` updates all three (state service spec)
- [ ] T081 [P] [US2] `wildfly-proxy-toggle/WildFlyProxyController.java`: generic `load-agent <jar> <args>` mode reusing WildFly detection; `db-capture-on.sh|.bat` / `db-capture-off.sh|.bat` (on: build jar via Docker Maven if missing, load with `alfredUrl`, `project`, `secretFile`; off: switch the project off through the API); update `wildfly-proxy-toggle/README.md` (incl. "agents cannot be unloaded")
- [ ] T082 [US2] `start.py`/`restart.py`: `--db-capture on|off` (mirrors `--wildfly-proxy`); docs in `docs/db-capture.md`
- [ ] T083 [US2] Run suites; manual SC-009 check with three tabs open
- [ ] T084 [US2] Commit Phase 4: `feat(db-capture): per-project capture switch in Sources bar, cycle widget and Settings, plus agent attach`

**Checkpoint**: Stories 1-2 complete - the first shippable increment.

---

## Phase 5: User Story 3 - Find the problem quickly in a busy call (Priority: P2)

**Goal**: flags, time strip, Tables view, value tracing, Search/SQL over statements and rows - as in the mock.

**Independent Test**: a call with a swallowed failure, a 12× repeated query and a 2,000-row result raises each
flag; each flag opens the right statement; a SQL query over statements returns the expected subset; tracing a
value finds it in params, rows and supplier bodies.

- [ ] T085 [P] [US3] `dbcapture/domain/StatementFlags.java` (all `DbFlagType`s except before-image ones which come in US4; thresholds from settings; expected fingerprints suppressed) + `StatementFlagsTest` over reference recordings (SC-007: present → raised, absent → not)
- [ ] T086 [US3] Compute flags in ingest/completion into `call_db_summary.flags_json`; `POST /db-capture/projects/{p}/expected`; `LOCK_DURING_SUPPLIER_CALL` uses the call's stored `HTTP_OUT` markers (seq inside an open transaction) - no cross-slice read, correct before the call is opened
- [ ] T087 [US3] `adapter/out/sqlite/InMemoryQuerySandbox` + `QueryRecordedDataUseCase`: fresh in-memory SQLite per request, one table (`result` or `statements` with columns `n, verb, table, sql, ms, rows, tx, write, failed, offset, code`), `PRAGMA query_only=ON`, single `SELECT`/`WITH` only, `ProgressHandler` 3 s, ≤ 50,000 rows paged, friendly errors (unknown column lists columns); search/sort generate the query
- [ ] T088 [US3] Endpoints `POST /db-capture/statements/{id}/rows/query`, `POST /db-capture/calls/{id}/statements/query` (returns `statementSeqs` when `n` selected), `GET /db-capture/calls/{id}/trace`, `GET /db-capture/calls/{id}/tables`
- [ ] T089 [P] [US3] Tests: `InMemoryQuerySandboxTest` (GROUP BY/ORDER BY/LIMIT, rejects INSERT/ATTACH/PRAGMA/multiple statements, timeout, cannot see `db-capture.db`), trace + tables service tests, controller tests
- [ ] T090 [P] [US3] `components/db-capture/db-flags` + `shared/utils/db-flags.ts` (labels/order/severity as the mock; click → jump: open groups, expand, choose tab, scroll, flash)
- [ ] T091 [P] [US3] `components/db-capture/db-time-strip` + `shared/utils/db-time-strip.ts` (DB/supplier/failed segments to scale, legend with DB/Suppliers/App ms, click → jump)
- [ ] T092 [P] [US3] `components/db-capture/db-tables-view` (Table, Reads, Inserts, Updates, Deleted, Failed, Rows read, Time; click → table filter chip in tools)
- [ ] T093 [US3] `components/db-capture/db-trace-bar` + `shared/utils/db-trace.ts` (+spec): click any value → backend hits + hits in the call's supplier request/response bodies (already loadable) → ordered locations, highlight, jump, ✕ Stop tracing
- [ ] T094 [US3] Search/SQL toggle in `db-statement-tools` (textarea, ▶ Run, Ctrl+Enter, Clear, column list, "Try:" chips incl. slowest / writes to wallet-style examples / time per table / failed or rolled back / deletes / inside tx / from code) and `db-statement-query-result` (filter tree; flatten on ORDER BY; summary table; Back to all statements; footer "Summary of N statements")
- [ ] T095 [US3] Search/SQL bar in `db-rows-table` (Search + click-to-sort ▲▼; SQL textarea + "Try:" chips from `shared/utils/db-row-query-examples.ts` built from the result's columns; results in the same fixed box with load-on-scroll; count line "N match · M rows recorded"; errors shown)
- [ ] T096 [US3] Settings: thresholds, expected and ignore rows editable in `app-db-capture-settings`; agent picks up ignore patterns from heartbeat
- [ ] T097 [US3] Move the new CSS (flags, strip, trace, rq-*, sq-note, toggle) from the mock into `_db-capture.scss`
- [ ] T098 [US3] Run suites; manual check against the reference call (SC-006: find the swallowed failure among 200 in < 30 s)
- [ ] T099 [US3] Commit Phase 5: `feat(db-capture): flags, time strip, value tracing, tables view and SQL over statements and rows`

**Checkpoint**: investigation at real volume.

---

## Phase 6: User Story 4 - Know what a delete or update removed or changed (Priority: P2)

**Goal**: Deleted rows tab, Before → after, before-image opt-in, no-WHERE / large delete / cascade warnings,
rolled-back deletes - all five mock cases.

**Independent Test**: a delete preceded by a read of the same rows, a delete on a before-image table and a delete
on a table without it; the first two show rows with their source, the third says "not captured" and offers the
switch; a no-WHERE delete is flagged red and can be marked expected.

- [ ] T100 [P] [US4] `sql/SqlShape`: split single-table `UPDATE … SET … WHERE …` / `DELETE FROM … WHERE …` into table + where text + where-param indexes; mark anything else "too complex"; tests
- [ ] T101 [US4] `jdbc/BeforeImageReader`: for tables in `AgentSettings.beforeImageTables`, before executing, run `SELECT * FROM t WHERE <where>` with the same bound values on the same connection; store as `BEFORE_IMAGE` rows with its duration; skipped reason otherwise; never for other tables
- [ ] T102 [P] [US4] `jdbc/CascadeInspector`: once per table, `DatabaseMetaData.getExportedKeys` → child tables with `importedKeyCascade`; attach `cascadesTo` to deletes
- [ ] T103 [P] [US4] Agent tests (H2): before-image rows equal the deleted rows, same transaction, skipped for joins, not run for non-opted tables, cascade detection
- [ ] T104 [US4] `dbcapture/domain/DeletedRowsResolver.java` (+test): link DELETE/UPDATE to the latest earlier SELECT in the same call on the same table with matching normalised WHERE and values; set `BeforeImage.source`
- [ ] T105 [US4] Flags `NO_WHERE`, `LARGE_DELETE`, `CASCADE`, `BEFORE_NOT_CAPTURED` in `StatementFlags` (+tests); `undone` deletes in rolled-back transactions
- [ ] T106 [US4] `components/db-capture/db-deleted-rows`: no-WHERE box with "Mark as expected for <table>", rolled-back note, cascade warning, rows from earlier read (link jumps to it) or before-image (with extra read time), else "N rows deleted - contents not captured" + `infobox` "Turn on for <table>" / "Turn off"
- [ ] T107 [US4] Before → after tab: values from the earlier read or before-image vs the written params; "not captured" column + the same before-image box when unknown
- [ ] T108 [US4] Settings and ▾ popover: before-image table chips editable (add/remove), saved via settings endpoint, delivered to the agent on the next heartbeat
- [ ] T109 [P] [US4] Frontend specs for deleted-rows source selection and before/after mapping (pure utils extracted to `shared/utils/db-before-after.ts`)
- [ ] T110 [US4] Run suites; manual check of the five delete cases from the mock
- [ ] T111 [US4] Commit Phase 6: `feat(db-capture): deleted rows, before-image, before/after values and delete warnings`

**Checkpoint**: Stories 1-4 complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T112 [P] Vendor verification (SC-010): run the app or a JDBC harness against Oracle Free, PostgreSQL, MySQL and SQL Server containers; fix any value shown as opaque/unreadable; record results in `docs/db-capture.md`
- [ ] T113 [P] Measurements in `docs/db-capture.md`: overhead (SC-002) against H2 **and** one real database container (PostgreSQL) so the ratio reflects real statement latency, ingest throughput at 50 concurrent calls, window open time at 500 statements and end-to-end scroll of 50,000 stored rows (SC-005), `db-capture.db` growth per 1,000 calls
- [ ] T114 [P] Docs: finish `docs/db-capture.md`; update `CLAUDE.md` (what-this-is paragraph, gateway prefixes, non-obvious rules: agent + headers + flag default off + Relive-later seams), `AGENTS.md`, `docs/architecture.md` (new slice, bridges), `docs/supplier-integrations.md` (headers, flag file), `docs/frontend-architecture.md` (db-capture state/socket, call-tree explicit parents), `docs/testing.md` (agent tests, Java 8 run)
- [ ] T115 Security pass: grep agent and backend logs for SQL values/secret; confirm `X-Alfred-Call` spoofing is stripped; confirm no `innerHTML` in new components; confirm sandbox rejects write/attach statements
- [ ] T116 Full suites: backend `mvn test` (Docker), `db-agent` verify + Java 8 self-test, `python -m pytest proxy`, `npm test`, `npm run build`; walk through quickstart.md end to end
- [ ] T117 Commit Phase 7: `docs(db-capture): measurements, vendor verification and docs`

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → Phase 3 (US1)** strictly in order.
- **US2 (Phase 4)** needs Phase 2 (toggle port, flag file) and the chip from US1; it can start in parallel with the
  US1 frontend once T037 exists, but is committed after Phase 3.
- **US3 (Phase 5)** needs US1 (window, rows table, statements). **US4 (Phase 6)** needs US1; its UI uses the flags
  row from US3 for its flags, so run US3 before US4.
- **Polish** after US4.
- Within a phase: tests next to their code; models → ports → adapters/services → endpoints → UI.

### Story completion order

```
Setup ─► Foundational ─► US1 (MVP) ─► US2 ─► US3 ─► US4 ─► Polish
                              └─ (US2 frontend can overlap US1 frontend)
```

## Parallel Opportunities

- Phase 2: proxies (T011-T014), backend-calls parent link (T015-T019), slice backbone (T020-T028), agent backbone
  (T029-T034) and frontend plumbing (T035-T037) touch different trees and can proceed side by side.
- US1: agent capture (T039-T047), backend queries (T048-T053) and frontend utils/components marked [P]
  (T054-T060) in parallel; exports, export redaction and .sql (T066-T072) once the models exist.
- US3: backend flags/sandbox (T085-T089) alongside frontend flags/strip/tables (T090-T092).
- Per the token-budget rule in `CLAUDE.md`, parallel here means *independent*, not "fan out subagents": the main
  session does the work; at most one subagent at a time for a large, fully specified chunk, and never for
  wire-format work (agent JSON, ingest DTOs, export format).

### Parallel example (US1)

```text
T043 values/ codecs            (db-agent)
T048 DbCaptureQueryService     (backend-db-capture)
T054 sql-render.ts + spec      (frontend utils)
T055 db-statement-tree.ts      (frontend utils)
```

## Implementation Strategy

1. **MVP = Phases 1-3** (US1): commit, then try it on a real call before continuing.
2. **First release = + Phase 4** (US2): switches and attach tooling make it usable day to day.
3. **Phases 5-6** (US3, US4): investigation and deletes, each committed and usable on its own.
4. **Phase 7**: measurements, vendor verification, docs.
5. **Later feature**: Relive Stories 5-7 on the FR-040..043 seams - not in this task list.
