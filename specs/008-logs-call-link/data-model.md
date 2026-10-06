# Data model: Logs linked to calls

## ProjectLogSettings (`backend-logs`, table `project_logs`)

| Field | Type | Rules |
|---|---|---|
| project | string | PK; a project name from `internal_call_services` |
| sourceIds | list of string | existing log source ids; unknown ids rejected (400) |
| threadField | string? | a label of every listed source's structure; switched to Exact search on save |
| timeField | string? | defaults to each source's TIME-role field |
| callIdField | string? | default `mdc.alfred.call`; switched to Exact search on save |
| clockSkewMs | int | 0..5000, default 200 |

Derived (not stored): `callIdFoundLines` per source - lines carrying `callIdField` (FR-010), counted whether ▤ is
on or off.

## ▤ switch (`proxy/log-link-enabled.flag`, `backend-db-capture` toggle adapter)

One `project=on|off` line per project, missing = off, written atomically like `db-capture-enabled.flag`; the reverse
proxy adds `log=1` to `X-Alfred-Call` while on. Exposed through the same projects endpoint as ◆
(`GET /db-capture/projects` gains `logsOn`; `PUT /db-capture/projects/{project}/logs` `{on}`). The MDC key is the
constant `alfred.call`.

## call_db_summary.request_thread (`backend-db-capture`)

`TEXT NULL`, from the `CALL_OPEN` marker's new `thread`; index `(request_thread, first_seen)`. Null for captures
made before - read falls back to the first statement's thread.

## LinkedLogLine (wire, `GET /call-logs/{callId}`)

| Field | Type | Notes |
|---|---|---|
| sourceId, sourceName | string | |
| lineId | string | `<inputId>:<offset>` (logs line identity) |
| at | ISO instant | the line's time field |
| offsetMs | number | from the call's start |
| level | string? | normalised (ERROR/WARN/INFO/DEBUG/TRACE) |
| thread | string? | |
| logger | string? | |
| message | string | the MESSAGE-role value, whole |
| matchedBy | `EXACT` \| `THREAD_TIME` \| `KEPT` | KEPT = served from kept lines only |
| raw | string | the whole original line (detail view, exports) |

A line belongs to at most one call (FR-004).

## KeptLogLine (`backend-logs`, table `kept_lines`)

`(call_id, source_id, line_id)` PK, `source_name`, `at`, `level`, `thread`, `matched_by`, `raw`, `kept_at`.
Created for calls held by a session cycle and for imported calls (`origin` = `CYCLE` | `IMPORT`); deleted when a
cycle call is in no cycle any more, and when an imported call is deleted (the calls/cycle deletion paths call
`KeptLogLinesUseCase.removeForCalls`). Outside the logs retention; bounded by cycle contents
(session-cycle capture is deliberately unbounded - same reason).

## LogCounts (wire, `GET /call-logs/counts?callIds=`)

`{ callId: { lines, errors, warnings, matchedBy } }` - at most 100 ids per request (clamped).

## State

```
▤ switch:  off ──(click ▤)──▶ on (next request tagged + logs read) ──(click ▤ / logging turned off)──▶ off (nothing read)
call ↔ kept lines: none ──(call joins a cycle / its lines read while in a cycle)──▶ kept ──(call leaves every cycle)──▶ none
```
