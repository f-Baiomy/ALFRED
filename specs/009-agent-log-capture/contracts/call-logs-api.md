# Contract: `/call-logs` with caught lines (009)

No new routes for calls - the 008 routes answer from caught lines when the call was caught by the agent:

- `GET /call-logs/{callId}` - `setup: OK`, `matchedBy: "CAUGHT"`, lines in `seq` order (their exact place among the
  call's statements); each line `sourceId: "agent"`, `sourceName: "caught by the agent"`, `lineId: "c:<id>"`,
  `logger`, `thread`, `level`, `message`, optional `exception` {type, message, stack}, `raw` = the line as JSON,
  `offsetMs` from the call's start. Also `dropped` (lines not kept: caps or late).
- `GET /call-logs/counts` - from `call_db_summary.log_*` for caught calls (no line read).
- `GET /call-logs/for-line` - unchanged (file lines only; a caught line already knows its call).
- Kept lines, import, exports, MCP `call_logs`: unchanged shape; `matchedBy` may be `CAUGHT`.

New, for outside-call lines (US4):

- `GET /db-capture/outside/logs?project=&thread=&after=&limit=` (≤ 500) - outside-call lines, newest last, grouped
  by the client per thread; shown in the database window's "outside any call" view with that thread's statements.
- `/ws/db-capture` gains `logs-appended {callId|null, project}` (only "something changed") so an open window refetches.
