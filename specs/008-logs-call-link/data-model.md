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

Derived (not stored): `callIdFoundLines` per source - lines carrying `callIdField` (FR-010).

## DbCaptureSettings.logTagging (`backend-db-capture`)

`boolean`, default `false` (clarified: off until turned on). Sent to the agent in `AgentSettingsResponse`
(`logTagging`, `logTagKey` = `alfred.call`). Older agents ignore it.

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
Created for calls held by a session cycle and for imported calls; deleted when the call is in no cycle (imported
calls: when the import's cycle/calls are deleted). Outside the logs retention; bounded by cycle contents
(session-cycle capture is deliberately unbounded - same reason).

## LogCounts (wire, `GET /call-logs/counts?callIds=`)

`{ callId: { lines, errors, warnings, matchedBy } }` - at most 100 ids per request (clamped).

## State

```
exact linking:  off ──(user turns on)──▶ on, pending restart ──(first tagged line seen)──▶ on, working
call ↔ kept lines: none ──(call joins a cycle / its lines read while in a cycle)──▶ kept ──(call leaves every cycle)──▶ none
```
