# Data Model: Log lines in Claude's investigation tools

## db-capture.db

### `call_log_lines` (existing, 009) - changed

| Column | Change | Notes |
|---|---|---|
| `fingerprint` | **new** TEXT | 16 hex chars, R4; set at ingest, backfilled on start |

New index: `ix_log_lines_fp ON call_log_lines(fingerprint, at_ms) WHERE level IN ('ERROR','SEVERE','FATAL','WARN','WARNING')`.

### `call_log_text` (new, FTS5 external content)

```sql
CREATE VIRTUAL TABLE call_log_text USING fts5(message, logger, thread, exception,
  content='call_log_lines', content_rowid='id', tokenize='trigram');
-- AFTER INSERT / AFTER DELETE triggers keep it in step; exception = type || ' ' || message from exception_json
```

Retention: rows leave with their lines (DELETE trigger). Rebuilt once on start if the table is new (`INSERT INTO
call_log_text(call_log_text) VALUES('rebuild')`).

### `call_markers` (existing) - changed

| Column | Change | Notes |
|---|---|---|
| `log_level` | **new** TEXT | the Log level the agent applied when the call opened (`ERROR`…`TRACE`, `APP`); sent on the CALL_OPEN marker by the agent (`MarkerRecord.logLevel`); null for calls caught before this feature |

## triage.db

### `call_attention` (existing) - changed

| Column | Change | Notes |
|---|---|---|
| `log_errors` | **new** INTEGER NOT NULL DEFAULT 0 | ERROR/SEVERE/FATAL lines caught |
| `log_warnings` | **new** INTEGER NOT NULL DEFAULT 0 | WARN/WARNING lines |
| `log_exceptions` | **new** INTEGER NOT NULL DEFAULT 0 | lines carrying an exception |
| `log_status` | **new** TEXT | `CAUGHT`, `OFF`, `NO_AGENT`, null (unknown) - why lines may be missing |
| `log_level` | **new** TEXT | the Log level the call was caught at (from `call_markers.log_level`) |
| `db_flags` | **new** TEXT | comma list of flag names, e.g. `SLOW,REPEATED_QUERY` |
| `signal_rank` | **new** INTEGER NOT NULL DEFAULT 0 | 2 error (status/error/failed stmt/log error/exception/failing child), 1 warning (db flag/log warning), 0 none |

New index: `ix_attention_signals ON call_attention(signal_rank, started_at) WHERE signal_rank > 0`.

## Retention notes

- Triage marks of calls held by a session cycle survive `call_attention`'s row cap (existing `RetainedCallIdsPort`), so cycle scopes keep old calls.
- Imported calls get marks and signals at import (FR-018).

## Domain records

- **CallSignals** (triage): `logErrors, logWarnings, logExceptions, logStatus, logLevel, dbFlags`; `rank()` per the table above.
- **Signal** (MCP + bridge vocabulary): `HTTP_ERROR, NO_ANSWER, DB_FAILED, DB_WARNING, LOG_ERROR, LOG_WARNING, LOG_EXCEPTION, SUPPLIER_FAILED`; severity error except `DB_WARNING`, `LOG_WARNING`.
- **ProblemFilter**: `all: Signal[]`, `any: Signal[]`, `none: Signal[]`, `dbFlags?: string[]`, `minStatus?`, `project?`, `from?`, `to?`.
- **LogSearchQuery**: `text?` (literal), `pattern?` (regex, ≤ 200), `minLevel?`, `logger?`, `exceptionType?`, `from?`, `to?`, `after?` (cursor `lineId`), `limit` (≤ 200).
- **LogSearchHit**: line (009 `LinkedLogLine` fields) + `callId`, `method`, `path`, `status`, `callAt`, `heldIn`.
- **LogProblem**: `fingerprint, level, logger, exceptionType, sampleMessage, lines, calls, firstAt, lastAt, endpoints (top 5 + count), example {callId, lineId}, isNew`.
- **EndpointHealth**: `method, pattern, calls, httpErrors, dbFailed, dbWarnings, logErrors, logWarnings, medianMs, maxMs`.
- **SignalBucket**: `minute, counts per Signal`.
- **InvestigationScope**: `kind, cycleIds, includeLive` → resolved `{ ids, heldIn: Map<id, labels>, unavailable: [{project, why}] }`.

## Validation

- `limit` clamped (search 200, problems 100, problem calls 200, endpoints 200, timeline 1,440 buckets).
- `cycleIds` ≤ 50, each must exist (404 names the missing one).
- `text` ≤ 500 chars; `pattern` ≤ 200 chars and must compile; a pattern search stops after 2 s total or 200,000 candidate lines (whichever first) and answers `cutShort: { scannedLines, reason }`. Matching runs on a `CharSequence` wrapper that checks the deadline on every `charAt`, so one catastrophic pattern cannot hold a thread.
- `from`/`to` ISO-8601; `to - from` ≤ 31 days for timelines.
