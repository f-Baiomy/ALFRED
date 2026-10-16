# Contract: Team REST (`/teamboards/**`, teamboards-core)

New route prefix: add `teamboards` to the `gateway/nginx.conf` API regex and to `SpaPageFilter`'s prefix list (`SpaPageFilterTest` checks both). The SPA page is `/team`, which is not a backend prefix.

Every request MAY carry the header `X-Alfred-Team-Token`. The header is never logged or stored. Responses never echo it.

| Method | Path | Notes |
|---|---|---|
| GET | `/teamboards/connectors` | installed kinds + capabilities, e.g. `[{kind:"azure", capabilities:[...]}]`; Jira/ClickUp listed with `installed:false` |
| GET | `/teamboards/connections` | `[{id, kind, name, baseUrl, scope, fetchedAt, fetchedBy, capabilities, newChanges}]` |
| POST / PATCH / DELETE | `/teamboards/connections[/{id}]` | settings edit rule; `@Valid` (https URL, scope limits) |
| POST | `/teamboards/connections/{id}/refresh` | token required → `200 {changed, fetchedAt}`; `401 TOKEN_MISSING`; `403 TOKEN_REJECTED`; `429 PROVIDER_BUSY {retryAfter}`; fetches only changes since `fetchedAt` |
| GET | `/teamboards/connections/{id}/items?q=&type=&squad=&state=&assignee=&sprint=&offset=&limit=` | summaries only (no fields, no native_json); `limit` ≤ 200; `{items, total}` |
| GET | `/teamboards/items/{conn}/{extId}` | all fields with `mappedTo`, links, `board` (Alfred board id or null), `startState` |
| GET | `/teamboards/items/{conn}/{extId}/revisions` | from cache; with a token and none cached (or `?fetch=1`), fetched first |
| POST | `/teamboards/items/{conn}/{extId}/start` | `{target?: {project, boardId?, remember: bool}}` → `202 {state: WAITING, boardId}` / `409 NEEDS_TARGET {suggested}` / `409 ALREADY_STARTED {boardId}` |
| DELETE | `/teamboards/items/{conn}/{extId}/start` | cancel a waiting start |
| POST | `/teamboards/links/{alfredBoard}/attachments/fetch` | token required; downloads the linked item's attachments into the board as spec files (the board's "Fetch attachments") |

Start with a token also downloads the item's attachments into `pending_attachments`; `PUT /teamboards/links/{board}` moves them into the board.
| GET | `/teamboards/connections/{id}/boards`, `/sprints`, `/squads`, `/people` | gated by capability (`404 NOT_SUPPORTED` otherwise) |
| PATCH | `/teamboards/squads/{conn}/{extId}` | `{alfredProject, alfredTeam}` |
| GET | `/teamboards/connections/{id}/changes?squad=&person=&after=&limit=` | feed, newest first, `new` flag from `seen_at` |
| POST | `/teamboards/connections/{id}/seen` | marks all seen for everyone |
| GET / PUT / DELETE | `/teamboards/connections/{id}/mappings[/{mid}]` | sprint/squad/area/project → Alfred project + board |
| GET / PUT / DELETE | `/teamboards/connections/{id}/field-maps[/{type}/{field}]` | target PURPOSE / STEPS / ACCEPTANCE / CONTEXT |
| GET | `/teamboards/links/{alfredBoard}` | `{conn, extId, snapshot, changedSinceSetup: [{field, from, to, by, at}]}`; read by board through the bridge |
| PUT | `/teamboards/links/{alfredBoard}` | `{conn, extId}`; set by /alfred-setup; snapshot taken from the cache |
| POST | `/teamboards/links/{alfredBoard}/seen` | after the user saves or dismisses "Azure changed" |

WebSocket: `/ws/teamboards` signals `{conn, what: items|changes|start}` after Refresh, Start or seen. Lists refetch on the signal; nothing polls.
