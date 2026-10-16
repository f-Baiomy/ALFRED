# Contract: board REST changes (backend-board)

All write routes follow `BoardEditAccess`: allowed where board writes are allowed, refused through the tunnel. `X-Alfred-Actor: claude` applies Claude's limits.

## Boards

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/board/boards?project=&state=OPEN,DONE&q=&limit=` | `limit` clamped (200) | `[{id, project, name, isDefault, state, cards, cycles, linkedItem?}]` |
| POST | `/board/boards` | `{project, name, cycleIds?: [], relateTo?: boardId, startRecording?: bool, askedIn?: string}` `@Valid` (name 1..120) | `201 Board`. Claude must send `askedIn`: a user chat message id under 30 min old on a board chat (checked), or `"terminal"` (accepted, recorded in activity); otherwise `403 NOT_ASKED` (FR-040, research R13a) |
| GET | `/board/boards/{id}` | | `Board` + relations + counts |
| PATCH | `/board/boards/{id}` | `{name?, state?}` | `200`; `409 DEFAULT_PROTECTED` for state≠OPEN on a default board; Claude may not set state |
| DELETE | `/board/boards/{id}` | | `204`; `409 DEFAULT_PROTECTED`; Claude refused |
| GET | `/board/boards/{id}/activity?after=&limit=` | | `[BoardActivity]` |
| POST | `/board/boards/{id}/activity/{aid}/undo` | | `200`; only rows with `undo_json` |

## Relations

| Method | Path | Body | Result |
|---|---|---|---|
| PUT | `/board/boards/{id}/cycles/{cycleId}` | | relate (idempotent) |
| DELETE | `/board/boards/{id}/cycles/{cycleId}` | | unrelate; the cycle is untouched |
| PUT / DELETE | `/board/boards/{id}/boards/{otherId}` | | relate / unrelate boards |
| GET | `/board/cycles/{cycleId}/boards` | | boards related to a cycle |
| POST | `/board/boards/{id}/record` | `{kind: REC|RETEST, onRunning: ASK|JOIN|NEW}` | `200 {cycleId}` or `409 {running: {cycleId, name, boards}}` when `ASK` and one records for the project |

The session-cycles start/resume (`POST /session-cycles/{id}/start` and MCP `start_recording`) takes `onRunning=ASK|PAUSE_OTHER`. The default `ASK` answers `409 RECORDING_CONFLICT {running}` when the guard finds a RECORDING cycle sharing a project (research R3).

## Cards

- Card JSON gains `boardId` (home) and `relatedCycles: []`. `cycleId` stays as the origin.
- `GET /board/cards?board=&scope=own|all&…` replaces `?project=&cycleId=`. The old query params keep working: `cycleId` resolves to the board with that id, else to the boards related to the cycle.
- `PUT /board/cards/{id}/home` `{boardId}`: number unchanged; activity on both boards.
- `PUT|DELETE /board/cards/{id}/cycles/{cycleId}`: relate or unrelate a cycle.

## Task routes

`/board/cycles/{id}/brief|specs|steps|log|evidence|requirements` become `/board/boards/{id}/…`. The old `/board/cycles/{id}/…` paths stay as aliases: a migrated board's id equals the old cycle id. For a cycle without such a board they answer `409 {boards: [...]}` so a caller picks one. Remove the aliases after the skills move (noted in docs).

## Shared cycle view

`GET /board/cycles/{cycleId}/verdicts?board=&limit=` returns `[{callId, endpoint, status, ms, boards: [{boardId, items: [{key, verdict}]}], cards: [{number, home}]}]`. With `board`, only the calls that board's items name or its cards mention.

## Cycle delete plan

`GET /board/cycles/{cycleId}/delete-plan` returns `{keep: [{boardId, callIds, statements, logLines, cards}], deleteCalls, originCards}`. The session-cycles delete calls the same plan through the bridge before deleting (research R7).

## Chat

The chat key becomes `(project, boardId)`. The `scope=project` query param keeps working and resolves to `default:<project>`. `PUT /board/live-runner` takes `boardId`; `cycleId` stays as an alias.
