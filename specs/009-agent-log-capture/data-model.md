# Data model: Log lines caught by the agent (009)

## Agent (in memory)

**CallContext** (existing) gains:
- `capture: boolean` - db=1: statements are recorded. `logs: boolean` - log=1: log lines are caught.
- `logLines`, `logBytes`, `logDropped` counters (caps, R6); `closedAtNanos` (late lines, 5 s grace).

**LogRecord** (transport, new): `callId` (null = outside), `seq` (0 for outside), `at` (ISO instant), `level`,
`logger`, `thread`, `message` (≤ 32 KB with exception), `exception` {type, message, stack} or null, `cut`.

**Batch** (existing `POST /db-capture/agent/batch`) gains `logs: LogRecord[]` and `droppedLogs: {callId → n}`.

## Backend (`db-capture.db`)

**call_log_lines** (new table)
| column | type | note |
|---|---|---|
| id | INTEGER PK | |
| call_id | TEXT NULL | NULL = outside any call |
| seq | INTEGER | shared with statements/markers of the call; 0 outside |
| at | TEXT | ISO instant, written with a fixed 3-digit fraction (008's text-order lesson) |
| at_ms | INTEGER | epoch ms, for ordering and windows |
| level, logger, thread | TEXT | |
| message | TEXT | ≤ 32 KB |
| exception | TEXT NULL | JSON {type, message, stack} |
| cut | INTEGER | 0/1 |
| project | TEXT | for outside lines and the outside bound |

Indexes: `(call_id, seq)`; `(project, thread, at_ms) WHERE call_id IS NULL`.
Retention: rows of evicted calls deleted with their statements (size cap, retained-calls rule); outside rows capped at
20,000 per project, oldest deleted first.

**call_db_summary** (existing) gains `log_lines`, `log_errors`, `log_warnings`, `log_dropped` (counts for the card
chip without reading lines).

**call_markers** CALL_OPEN (existing) gains `logs` (0/1): the agent caught for this call → the bridge serves caught lines.

## Shared shape

**LinkedLogLine** (existing, `/call-logs`) gains optional `exception` and `matchedBy: 'CAUGHT'`; `sourceId`/`sourceName`
are `agent` / `caught by the agent`; `lineId` = `c:<id>`; `raw` = the line as JSON (time, level, logger, thread,
message, exception) so exports, masking and Claude's tools work unchanged.

## State

▤ off → no `log=1` → nothing caught. ▤ on + agent attached → each recorded call caught (CALL_OPEN `logs=1`); outside
lines caught while the heartbeat says `logsOn`. Agent detached → calls fall back to 008 file linking.
