# Contract: `/call-logs` (backend-app `calllogsbridge`)

New gateway prefix `call-logs` (add to `gateway/nginx.conf`'s API regex). All limits clamped server-side.

## GET /call-logs/{callId}?cycleId=&after=&limit=

The call's linked log lines, oldest first. `limit` 1..500 (default 200), `after` = cursor from the previous page.
`cycleId` set → the cycle's copy of the call (its kept lines merged in).

```json
{ "callId": "500d0cdc-…", "matchedBy": "THREAD_TIME", "thread": "default task-4", "windowMs": [0, 20035],
  "clockSkewMs": 200, "lines": [ /* LinkedLogLine */ ], "next": "c:…" | null,
  "setup": "OK" | "NO_SOURCE" | "NO_THREAD" }
```
`setup` drives the empty states: `NO_SOURCE` (project has no log source - FR-019), `NO_THREAD` (no capture and
exact linking off - edge case).

## GET /call-logs/counts?callIds=a,b,…

`{ "a": { "lines": 14, "errors": 1, "warnings": 2, "matchedBy": "EXACT" } }`; ≤100 ids. Only for calls the UI has
open or expanded (FR-013).

## GET /call-logs/for-line?sourceId=&lineId=

The call a log line was written during: `{ "call": { "id", "method", "url", "status", "durationMs", "service" },
"matchedBy": "EXACT" | "THREAD_TIME" } ` or `204` when none (FR-014).

## GET /call-logs/settings/{project} · PUT /call-logs/settings/{project}

`ProjectLogSettings` + `logTagging` (read/written through to `DbCaptureSettings`) + derived
`callIdFoundLines: { sourceId: n }`. `@Valid` DTO; unknown source ids / fields → 400.

## POST /call-logs/import

`{ "callId", "lines": [ LinkedLogLine ] }` - stores kept lines for an imported call (FR-016). ≤ 20,000 lines per
request; larger imports send several.

## WebSocket

No new socket. Pages refetch on the existing `/ws/logs` `lines-added` (for the call's project sources) and the
calls sockets - no polling (FR-018).
