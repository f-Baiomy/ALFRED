# Contract: Server settings HTTP API (`backend-server`)

New route prefix `server`. Add it to `gateway/nginx.conf`'s API regex and to the native
`SpaPageFilter` prefix list (a test enforces that both match). All bodies are JSON. Errors go through
`GlobalExceptionHandler`. Writes are guarded by `EditAccessFilter` (research R9): a refused write gets
`403 {"reason": "TUNNEL" | "NOT_LISTED" | "DOCKER_MODE", "howToEdit": "..."}`.

## Read (any client that can open the UI)

### `GET /server/access`
`200 {allowed, reason, clientAddress, howToEdit}`

### `GET /server/status`
`200 ServerStatus` (see data-model). The WebSocket `/ws/server` sends `{"type":"server-status-changed"}`
when a proxy changes state, a restart starts or ends, or `.env` changes on disk. The UI then re-fetches.
No polling.

In Docker mode (FR-054) every read below works. Settings carry `source: PROCESS_ENV` and the effective
container value, `GET /server/access` returns `{allowed: false, reason: DOCKER_MODE, howToEdit: "edit .env
in the Alfred folder, then run python3 restart.py"}`, and every write returns `403 DOCKER_MODE`.

### `GET /server/settings`
```json
{
  "envHash": "sha256…",
  "settings": [
    {"key": "INTERNAL_CALLS_RETENTION_ROWS", "group": "PROJECTS", "kind": "INTEGER",
     "label": "Inbound calls kept", "help": "…", "applies": "LIVE",
     "value": "5000", "default": "1500", "source": "ENV_FILE", "differsFromDefault": true,
     "pending": null}
  ],
  "missingFromEnv": ["ALFRED_UI_PORT", "ALFRED_MEMORY", "ALFRED_SETTINGS_EDIT_FROM"],
  "unknownLines": [{"line": 14, "text": "ALFRED_CALLS_MAX_SIZE=2GB"}],
  "pendingRestart": [{"key": "ALFRED_MEMORY", "before": "2g", "after": "3g"}]
}
```
`SECRET` values are returned as `"value": null, "isSet": true`.

### `POST /server/settings/check`
Request `{"edits": [{"key": "...", "value": "..."}], "all": false}`, at most 64 edits. With `all: true` it checks every
current value (the "Check everything" button).
Response `{"results": [{"key", "level": "ERROR"|"WARNING"|"OK", "message", "detail": {...}}]}`.
`detail` carries probe data for the UI: `{usedBytes, freeDiskBytes}`, `{retentionHours, memoryBytes}`,
`{fileCount, newestModified}`, `{process: "java (pid 3120)"}`, per-project `{health, statusCode,
latencyMs}`. The request returns within 5 s; a probe that times out reports `WARNING "check timed
out"`.

### `POST /server/settings/preview`
Request `{"baseHash", "edits": [...]}`. Response `{"diff": [{"key", "before": "line"|null, "after":
"line"|null}], "effects": [{"key", "applies"}], "errors": [...]}`. Writes nothing; feeds the review
dialog.

### `GET /server/settings/history?limit=50`
`limit` clamped to 1..50. `200 [{id, at, source, sourceDetail, changes: [{key, before, after}]}]`.

### `GET /server/settings/env-file`
Downloads `.env` (`Content-Disposition: attachment; filename=alfred-<host>.env`), with secret values
replaced by `<set on server>`. Allowed only when `GET /server/access` is `allowed`, since the file
shows paths.

## Write (guarded)

### `PUT /server/settings`
Request (`@Valid`): `{"baseHash": "…", "edits": [{"key": "…", "value": "…"} | {"key": "…", "reset": true}]}`,
at most 64 edits.
- `409 {"conflict": {"changedKeys": [...], "currentHash": "…"}}` when `baseHash` ≠ the file's current hash.
- `422 {"results": [...ERROR...]}` when validation fails. Nothing is written.
- `200 {"envHash", "applied": [{"key", "applies", "outcome": "APPLIED"|"PROXIES_RESTARTED"|"PENDING_RESTART", "tookMs"}], "historyId"}`.

### `POST /server/settings/add-missing`
Adds every `missingFromEnv` key with its default. `200` same shape as PUT.

### `POST /server/settings/history/{id}/revert`
Returns the edits that would restore the state before entry `id`, as `{"edits": [...]}`. It does
**not** write: the UI puts them in the form, and the CLI asks the user, then sends PUT (FR-035).

### `POST /server/settings/import`
Multipart `.env` upload, at most 64 KB. Returns
`{"values": [{"key", "value", "current", "valid": bool, "message"}]}`. Writes nothing; the UI places
the selected values in the form (FR-028). Unknown keys are listed and ignored. Secret keys are
excluded.

### `POST /server/restart` with `{"what": "BACKEND" | "PROXIES"}`
`202 {"accepted": true}`. The supervisor does the work. Progress arrives on `/ws/server`, and a backend
restart drops the socket, which `reconnectingSocket` re-opens. In Docker mode: `409 {"reason":
"DOCKER_MODE"}`.

## Supervisor → backend

### `POST /server/supervisor-events`
Header `X-Webhook-Secret` (same check as other webhooks). Body `{"name": "OUTBOUND"|"REVERSE"|"MCP"|"LOG_AGENT",
"state": "...", "pid", "startedAt", "restarts", "listeners", "detail", "at"}` - the child's `/status` entry.
The backend re-broadcasts it as `server-status-changed`.
