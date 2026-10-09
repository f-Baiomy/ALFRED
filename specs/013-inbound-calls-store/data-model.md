# Data Model: Inbound calls that survive a busy backend

## Inbound call (unchanged domain record)

`backend-internal-calls/domain/model/CallRecord` stays exactly as it is - the store changes, not the shape. Fields:
`id`, `originalUrl`, `url`, `method`, `request` (headers, body), `timestamp`, `durationMs`, `response` (status,
headers, body), `error`, `state` (`IN_PROGRESS` | `COMPLETED` | `ERROR`), `sessionId`, `operationId`, `serviceName`,
`interception`, `resendOf`, `resendEdits`, `relive`, `reachedUpstream`. WebSocket messages stay a separate list per
call (`WsMessage`, capped by `alfred.internal-calls.ws-max-messages`).

**Identity**: `id` - the proxy's id (client `X-Request-Id` or a UUID). Unique in the store.

**Lifecycle**:

```text
            prepare (request side)              complete (outcome side)
 (absent) ------------------------> IN_PROGRESS -------------------------> COMPLETED | ERROR
    |                                                                        ^
    +---------------- complete first (prepare late or lost) -----------------+
                         row has outcome + identity, request null;
                         a late prepare fills request headers/body in place
```

Both transitions are idempotent upserts by `id` (research R5): repeating either, or applying them in either order,
gives the same row.

## SQLite schema (`internal-calls.db`)

Modelled on `calls.db` (outbound), trimmed to the inbound port's needs.

### `internal_call_metadata` - one row per call, no bodies (list queries read only this)

| column | type | notes |
|---|---|---|
| `rowid` | INTEGER PK | insertion order; retention deletes oldest rowids |
| `id` | TEXT UNIQUE NOT NULL | call id |
| `original_url`, `url`, `method` | TEXT | null only for a completion that arrived with no identity (pre-326ac85b proxy) |
| `timestamp` | TEXT | ISO-8601 as received |
| `timestamp_millis` | INTEGER | parsed; indexed - time ranges, sort |
| `duration_ms` | REAL | indexed - "slowest" sort |
| `status` | INTEGER | response status, null while in progress |
| `status_rank` | INTEGER | same ordering key outbound uses; indexed |
| `status_state` | TEXT NOT NULL | `IN_PROGRESS`/`COMPLETED`/`ERROR`; indexed |
| `error` | TEXT | |
| `session_id`, `operation_id` | TEXT | substring filters |
| `service_name` | TEXT | project; indexed (project filter) |
| `interception` | TEXT (JSON) | null when no rule touched the call |
| `resend_of`, `resend_edits` | TEXT | |
| `relive_json` | TEXT (JSON) | expression index on `$.runId` |
| `reached_upstream` | INTEGER | 0/1/null |
| `ws_message_count`, `ws_dropped` | INTEGER | |
| `haystack` | TEXT | method, both URLs, status, error, headers and bodies - exactly the fields `CallListSupport.matchesSearch` searches today |

### `internal_call_request` / `internal_call_response` - bodies, 1:1 by `call_rowid`, `ON DELETE CASCADE`

`headers` TEXT (JSON), `body` TEXT. Read only by detail/export paths, never by list queries.

### `internal_call_ws_message` - `call_rowid`, `seq`, message JSON; `ON DELETE CASCADE`

### `internal_calls_fts` - FTS5 `tokenize='trigram'` over `haystack`, kept in sync by triggers; LIKE fallback when unavailable

### `internal_store_meta` - key/value: schema version

## Retention

| limit | property / env | default | applies |
|---|---|---|---|
| count | `alfred.internal-calls.retention-rows` / `INTERNAL_CALLS_RETENTION_ROWS` | 1500 (7000 on this install via `.env`) | both stores; live-changeable (`RetentionPort`) |
| size | `alfred.storage.internal-calls.max-size-bytes` / `INTERNAL_CALLS_MAX_SIZE_BYTES` | 10737418240 (10 GB) | SQLite store |

Oldest calls (lowest `rowid`) are removed when either limit is exceeded, at most 200 per pass, on the writer thread.

## Port methods and how the SQLite adapter answers them

| `CallLogPort` method | SQLite answer |
|---|---|
| `prepare` / `prepareOrMerge` | upsert request side; returns true when the row was already completed |
| `complete` (6 and 7 args) | upsert outcome side; `known` fills identity columns that are still null; returns true when a prepared row existed |
| `query` (both overloads) | windowed SQL on metadata + FTS, summaries only, `LIMIT/OFFSET`, total via `COUNT(*)` |
| `findById` | metadata + request + response join for one id |
| `findByReliveRunId` | indexed `json_extract` lookup |
| `findResolvedInRange` | windowed metadata query by `timestamp_millis` (override of the `readAll()` default); returns records with request/response **bodies null** - its callers (call-overlap bars, triage backfill) read metadata only and fetch bodies per call through detail |
| `recentRequestHeaders` | newest-first request headers for a host, `LIMIT` (override of the default) |
| `baselineFor` | percentiles over metadata `duration_ms` for the URL, windowed |
| `statusBreakdown` | `GROUP BY status_rank` |
| `storageSizeBytes` | page_count x page_size |
| `deleteAll` | `DELETE` + vacuum |
| `deleteByReliveRunIds` | `DELETE` by run id (cascade) |
| `appendWsMessages` / `wsMessages` | per-call table, cap as today |
| `readAll` | kept for the port contract; no request-path caller may use it on SQLite. Today's callers are only the three port defaults above (`CallLogPort` lines 96, 112, 162), all overridden; T026a re-checks and a test guards it |

## Proxy report (wire) - see contracts/webhooks.md
