# Data Model: Database Capture

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Owned by the new slice `backend-db-capture`, stored in its own SQLite file `db-capture.db` (research D9).
Domain types are Java `record`s in `com.fathy.alfred.backend.dbcapture.domain.model`; the frontend mirrors them in
`core/models/db-capture.model.ts`.

## Domain records

### CapturedStatement
One database operation within a call (or within the outside-call bucket).

| Field | Type | Notes |
|---|---|---|
| `id` | long | store id |
| `callId` | String? | inbound call id from `X-Alfred-Call`; null for outside-call statements |
| `threadName` | String | always set; groups outside-call statements |
| `seq` | int | order within the call, shared with supplier calls (research D4). Unique per `callId` |
| `kind` | enum `StatementKind` | `SELECT, INSERT, UPDATE, DELETE, MERGE, CALL, DDL, OTHER, COMMIT, ROLLBACK, SAVEPOINT, ROLLBACK_TO_SAVEPOINT` |
| `sql` | String | as the app sent it, placeholders kept (Relive-ready FR-040) |
| `fingerprint` | String | hash of normalised SQL + parameter types (FR-041) |
| `tableName` | String? | first table for SELECT/INSERT/UPDATE/DELETE, procedure name for CALL |
| `params` | List<List<TypedValue>> | one list per batch set; a non-batch statement has exactly one set |
| `outcome` | `StatementOutcome` | see below |
| `startedAt` | Instant | agent clock |
| `durationMicros` | long | |
| `offsetMicros` | long | from the call's first event, for the time strip |
| `transactionId` | String? | `tx-<n>` within the call, null for autocommit |
| `connectionId` | String | pool connection identity (`pool-3`) |
| `codeLocation` | String? | first non-framework stack frame `Class.method(File.java:line)` |
| `runTag` | String? | `<runId>/<stepKey>` when the inbound call was a Relive step (FR-043); stored, not used yet |
| `dataSource` | String | product name + version from `DatabaseMetaData` (selects vendor rendering) |
| `beforeImage` | `BeforeImage`? | see below |
| `cascadesTo` | List<String> | child tables with ON DELETE CASCADE (D12) |
| `undone` | boolean | set when its transaction rolled back |
| `expected` | boolean | matches a pattern the user marked expected (no flags) |

### TypedValue
`{ type: String (JDBC type name or vendor type), value: String?, opaque: boolean, truncatedAt: Long? }` - text form
of the value exactly as research D8 describes; `null` value means SQL NULL. `OUT` procedure params carry
`direction: IN|OUT|INOUT`.

### StatementOutcome (sealed, one of)
- `Rows { columns: List<Column>, storedRows: int, rowsRead: long, partial: boolean, overLimit: boolean }` - rows
  themselves are in `ResultRow` (paged). `Column { name, type }`.
- `Updated { affected: long, perSet: List<Long>?, generatedKeys: List<List<TypedValue>>? }` - batches give `perSet`.
- `ProcedureResult { outParams: List<TypedValue>, resultSets: List<Rows>? }` - REF CURSORs become nested `Rows`.
- `Failed { sqlState, vendorCode: int, message, chain: List<String>, swallowed: boolean? }` - `swallowed` is
  decided when the call completes (call returned < 500 although a statement failed).
- `TransactionEnd { outcome: COMMITTED|ROLLED_BACK, heldMicros }` - for COMMIT/ROLLBACK/SAVEPOINT kinds.

### ResultRow
`{ statementId, rowIndex: int, values: List<TypedValue> }` - one row of a result or a before-image; stored up to
the per-result limit (default 50,000).

### BeforeImage
`{ source: EARLIER_READ | AGENT_READ | NONE, earlierSeq: Integer?, extraReadMicros: Long?, skippedReason: String?, rowCount: int }`.
`EARLIER_READ` rows are read from the linked statement; `AGENT_READ` rows are `ResultRow`s owned by this statement
with `kind = BEFORE_IMAGE`.

### StatementTransaction
`{ callId, transactionId, connectionId, firstSeq, lastSeq, outcome: COMMITTED|ROLLED_BACK|OPEN, heldMicros, statementCount, writeCount }`.

### CallMarker
Non-statement events the agent records in a call's sequence (research D4, D11).
`{ callId, seq, type: CALL_OPEN | HTTP_OUT, at: Instant, method: String?, url: String? }`.
- `CALL_OPEN` (seq 0) is sent the moment the agent starts tracking a call, so a call that ran no statements still
  has a summary with zero counts ("◆ DB 0") - distinct from a call that was never captured (no summary).
- `HTTP_OUT` is sent for each outbound HTTP request the agent tagged, with the same `seq` it put in
  `X-Alfred-Parent`. The backend knows where supplier calls sit without reading another slice; the frontend matches
  a marker to the outbound call record by `parentCallId` + `parentSeq`.

### CallDbSummary
One per call the agent tracked (created by `CALL_OPEN`) - what the ◆ DB chip reads.
`{ callId, statementCount, writeCount, deleteCount, failedCount, transactionCount, rolledBackCount, dbMicros,
droppedCount, flags: List<DbFlag>, lastSeq, complete: boolean }`.

### DbFlag
`{ type: DbFlagType, severity: BAD|WARN, seqs: List<Integer>, group: String?, detail: Map<String,String> }`.
`DbFlagType`: `FAILED_SWALLOWED, FAILED, ROLLED_BACK, NO_WHERE, LARGE_DELETE, REPEATED_QUERY, SLOW, HUGE_RESULT,
LOCK_DURING_SUPPLIER_CALL, CASCADE, BEFORE_NOT_CAPTURED`.

### DbCaptureSettings (per project)
`{ project, rowsPerResult: int (default 50,000, clamp 1..1,000,000), beforeImageTables: Set<String>,
outsideCallCapture: boolean (default true), thresholds: { slowMs 20, hugeRows 1000, repeatCount 5,
largeDeleteRows 100 }, expectedPatterns: List<String>, ignorePatterns: List<String> (default ["SELECT 1"]) }`.
The on/off switch itself is **not** here - it is the flag file (research D5) so the proxy can read it.

### AgentStatus
`{ project, agentId, agentVersion, jvm, appServer, lastSeen: Instant, droppedSinceStart: long }` - "attached" means
`lastSeen` within 30 s (three heartbeats).

## Relationships

- Inbound call (owned by `backend-internal-calls`) 1 → * `CapturedStatement` by `callId` (no foreign key across
  stores; joined by id).
- `CapturedStatement` * → 0..1 `StatementTransaction` by (`callId`, `transactionId`).
- `CapturedStatement` 1 → * `ResultRow` (result rows, before-image rows).
- Outbound call (owned by `backend-calls`) gains `parentCallId` + `parentSeq` (research D4) - nullable fields on the
  existing record, not a reference into this slice.
- Session cycles (`backend-session-cycles`) and Relive cycles/runs (`backend-relive`) retain call ids; this slice
  asks through `RetainedCallIdsPort` before evicting (D9).

## SQLite schema (`db-capture.db`)

```sql
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  call_id TEXT, thread_name TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, sql TEXT NOT NULL, fingerprint TEXT NOT NULL, table_name TEXT,
  params_json TEXT NOT NULL,            -- List<List<TypedValue>>
  outcome_json TEXT NOT NULL,           -- StatementOutcome without rows
  started_at TEXT NOT NULL, duration_us INTEGER NOT NULL, offset_us INTEGER NOT NULL,
  tx_id TEXT, connection_id TEXT NOT NULL, code_location TEXT, run_tag TEXT, data_source TEXT NOT NULL,
  before_json TEXT, cascades_json TEXT, undone INTEGER NOT NULL DEFAULT 0, expected INTEGER NOT NULL DEFAULT 0,
  approx_bytes INTEGER NOT NULL          -- for the size cap
);
CREATE UNIQUE INDEX ux_statements_call_seq ON statements(call_id, seq) WHERE call_id IS NOT NULL;
CREATE INDEX ix_statements_outside ON statements(thread_name, started_at) WHERE call_id IS NULL;
CREATE INDEX ix_statements_started ON statements(started_at);

CREATE TABLE result_rows (
  statement_id INTEGER NOT NULL, part TEXT NOT NULL,   -- 'RESULT' | 'BEFORE_IMAGE' | 'CURSOR:<n>'
  row_index INTEGER NOT NULL, values_json TEXT NOT NULL,
  PRIMARY KEY (statement_id, part, row_index)
) WITHOUT ROWID;

CREATE TABLE transactions (
  call_id TEXT NOT NULL, tx_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, outcome TEXT NOT NULL, held_us INTEGER NOT NULL,
  statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL,
  PRIMARY KEY (call_id, tx_id)
);

CREATE TABLE call_db_summary (
  call_id TEXT PRIMARY KEY, statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL,
  delete_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, tx_count INTEGER NOT NULL,
  rolled_back_count INTEGER NOT NULL, db_us INTEGER NOT NULL, dropped_count INTEGER NOT NULL,
  flags_json TEXT NOT NULL, last_seq INTEGER NOT NULL, complete INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL, first_seen TEXT NOT NULL
);
CREATE INDEX ix_summary_first_seen ON call_db_summary(first_seen);   -- eviction order

CREATE TABLE call_markers (
  call_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, method TEXT, url TEXT,
  PRIMARY KEY (call_id, seq)
) WITHOUT ROWID;

CREATE TABLE capture_settings (project TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
CREATE TABLE agents (agent_id TEXT PRIMARY KEY, project TEXT NOT NULL, status_json TEXT NOT NULL, last_seen TEXT NOT NULL);
```

List and range reads name columns and never select `params_json`/`outcome_json`/`values_json` unless a single
statement or a row page is requested (Constitution II). Every query has a `LIMIT`.

## Validation rules

- Batch ingest: `X-Webhook-Secret` required; batch ≤ 2,000 statements and ≤ 32 MB decompressed; each statement's
  `seq` ≥ 1; `kind` from the enum; `sql` ≤ 1 MB; rows beyond the project's `rowsPerResult` rejected (the agent
  never sends them); unknown fields ignored (forward compatibility with newer agents).
- A `(callId, seq)` already stored is ignored (retried batch) - ingest is idempotent.
- Paging: `offset ≥ 0`, `limit` clamped to 1..500 (statements) and 1..1,000 (rows).
- Query endpoint: text ≤ 20,000 chars, single statement, `SELECT`/`WITH` only, 3 s budget, ≤ 50,000 result rows.
- Settings: `rowsPerResult` 1..1,000,000; thresholds positive; table names `[A-Za-z0-9_.$"]{1,128}`; patterns ≤ 200
  entries.

## State transitions

- **Transaction**: `OPEN` (first statement with autocommit off) → `COMMITTED` | `ROLLED_BACK` (on commit/rollback or
  connection close without commit = rolled back, as JDBC defines). On `ROLLED_BACK`, every statement in it gets
  `undone = true`.
- **CallDbSummary.complete**: false while batches arrive; set true when the inbound call's completion is observed
  (`NewInternalCallObserverPort`). Async work that finishes later still appends; no timer is involved. If the agent
  reports its context closed abnormally, `endedEarly` is set and shown.
- **Statement eviction**: kept → evicted (size cap, oldest `first_seen` first, skipping `RetainedCallIdsPort`
  ids) or deleted (call deleted/cleared by the user).
