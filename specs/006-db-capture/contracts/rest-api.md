# Contract: backend REST API (frontend ↔ backend)

Prefix `/db-capture` (added to `gateway/nginx.conf`'s backend regex). No `$spa_page` entry is needed - there is no
SPA page named `db-capture`. All limits clamped server-side.

| Method & path | Purpose | Response |
|---|---|---|
| `GET /db-capture/summaries?callIds=a,b,c` | chips for the visible cards (≤ 500 ids) | `{ [callId]: CallDbSummary }` - ids with nothing captured are absent |
| `GET /db-capture/calls/{callId}/statements?afterSeq=0&limit=500` | the window's statement list (summary columns: seq, kind, sql, table, params, result summary, duration, offset, tx, flags refs, undone, expected) | `{ statements: [...], transactions: [...], supplierMarkers: [{seq, method, url, at}], hasMore }` - the frontend matches each marker to its outbound call by `parentCallId` + `parentSeq` |
| `GET /db-capture/statements/{id}` | one statement in full (outcome without rows, before-image meta, cascades, code location) | `CapturedStatement` |
| `GET /db-capture/statements/{id}/rows?part=RESULT&offset=0&limit=100` | a page of rows (`part` = `RESULT`, `BEFORE_IMAGE`, `CURSOR:n`) | `{ columns, rows, total, stored, partial }` |
| `POST /db-capture/statements/{id}/rows/query` | search / sort / SQL over one result (research D10) | body `{ mode: "search"|"sql", text, sortColumn?, sortDir?, offset, limit }` → `{ columns, rows, total, error? }` |
| `POST /db-capture/calls/{callId}/statements/query` | search / SQL over the call's statements table (columns `n, verb, table, sql, ms, rows, tx, write, failed, offset, code`) | `{ columns, rows, total, statementSeqs?, error? }` - `statementSeqs` present when the result includes `n`, so the UI can filter the tree |
| `GET /db-capture/calls/{callId}/trace?value=…` | every statement param / stored row / before-image containing the exact value | `{ hits: [{ seq, where: "PARAM"|"ROW"|"BEFORE_IMAGE"|"KEY", index, column? }] }` |
| `GET /db-capture/calls/{callId}/tables` | per-table summary for the Tables view | `[{ table, reads, inserts, updates, deletedRows, failed, rowsRead, micros }]` |
| `GET /db-capture/outside?thread=&offset=&limit=` | outside-any-call bucket | same shape as the statements list |
| `GET /db-capture/projects` | per project: capture on/off, agent status | `[{ project, enabled, inboundLogging, agent: AgentStatus? }]` |
| `PUT /db-capture/projects/{project}/enabled` | the switch (Sources bar, cycle widget, Settings) | body `{ enabled }` → the updated list; `409` if inbound logging is off |
| `GET /db-capture/projects/{project}/settings` / `PUT …` | `DbCaptureSettings` | settings |
| `POST /db-capture/projects/{project}/expected` | "Mark as expected" from a flag | body `{ fingerprint }` |
| `DELETE /db-capture/calls/{callId}` | used by the call-deletion bridge | `204` / `404` |
| `POST /db-capture/import` | re-import from a .json export (`dbCapture` blocks) | body `{ calls: [{ callId, dbCapture }] }` → `{ imported }`; same validation limits as the agent batch; no secret, like the existing `/rules/import` and global-variables `/import` (user action, same origin) |

Query endpoint errors are `200` with `error` set (the user's query was wrong, not the request) - e.g.
`"No column \"price\". Columns: id, amount, kind, created_at"`, `"Only SELECT queries are allowed"`,
`"Query took longer than 3 s and was stopped"`.

Deferred (Relive, later feature): no replay, override or compare endpoints are added now.

## Changes to existing endpoints

- `backend-calls` outbound call record: optional `parentCallId`, `parentSeq` (from the forward proxy webhook,
  `parent_call_id`/`parent_seq`), returned in summaries and detail.
- Call deletion / clear (`backend-calls`, `backend-internal-calls`, `DatabaseStatsController.clearCalls`): a
  `backend-app` bridge also deletes the calls' statements through `DeleteCallStatementsUseCase`.
