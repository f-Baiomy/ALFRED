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
| GET | `/teamboards/items/{conn}/{extId}/revisions` | the cached history only (a GET never reaches the provider, so it stays read-only through the tunnel) |
| POST | `/teamboards/items/{conn}/{extId}/revisions/fetch` | token required (`401 TOKEN_MISSING`); reads the history from the provider into the cache |
| GET | `/teamboards/items/{conn}/{extId}/seed` | the board seed: `{item, provider, purpose, steps, acceptance, context, parentAcceptance, children, attachments, links, board}` - values whole |
| GET | `/teamboards/items/{conn}/{extId}/target` | the mapped `{project, boardId}` (sprint → squad → area → project, then a squad mapped in Squads); `204` when none |
| POST | `/teamboards/items/{conn}/{extId}/start` | `{target?: {project, boardId?, remember: bool}, askedIn?}` → `202 {state: WAITING, project, boardId, messageId, attachmentsFetched}` / `409 NEEDS_TARGET` / `409 ALREADY_STARTED {boardId}`; as Claude (`X-Alfred-Actor: claude`) `askedIn` is required, else `403 USER_ONLY`. Posts `/alfred-setup <conn>/<extId>` as the user to the target board's chat (the project chat for no board) |
| DELETE | `/teamboards/items/{conn}/{extId}/start` | cancel a waiting start |
| POST | `/teamboards/links/{alfredBoard}/attachments/fetch` | token required; downloads the linked item's attachments the board does not hold onto it as board files (≤ 10 MB each, ≤ 50 MB per item; larger ones listed by name) → `{attached, notAttached}` |

Start with a token also downloads the item's attachments into `pending_attachments`; `PUT /teamboards/links/{board}` moves them into the board.
| GET | `/teamboards/connections/{id}/boards`, `/sprints`, `/squads`, `/people` | gated by capability (`404 NOT_SUPPORTED` otherwise) |
| PATCH | `/teamboards/squads/{conn}/{extId}` | `{alfredProject, alfredTeam}` |
| GET | `/teamboards/connections/{id}/changes?squad=&person=&after=&limit=` | feed, newest first, `new` flag from `seen_at` |
| POST | `/teamboards/connections/{id}/seen` | marks all seen for everyone |
| GET / PUT / DELETE | `/teamboards/connections/{id}/mappings[/{mid}]` | sprint/squad/area/project → Alfred project + board |
| GET / PUT / DELETE | `/teamboards/connections/{id}/field-maps[/{type}/{field}]` | target PURPOSE / STEPS / ACCEPTANCE / CONTEXT |
| GET | `/teamboards/links/{alfredBoard}` | `{board, conn, extId, provider, snapshot, changedSinceSetup: [{field, from, to, by, at}], attachments: [{name, size, url, held}]}`; `204` when none; read by the board through the bridge too |
| PUT | `/teamboards/links/{alfredBoard}` | `{conn, extId}`; set by /alfred-setup (`team_link`); snapshot taken from the cache; moves the start's pending attachments onto the board → `{attached, notAttached}`; `409 ALREADY_LINKED` |
| DELETE | `/teamboards/links/{alfredBoard}` | removes the link (also done when the board is deleted), so the item offers Start again |
| POST | `/teamboards/links/{alfredBoard}/seen` | after the user saves or dismisses "Azure changed" |

WebSocket: `/ws/teamboards` signals `{conn, what: items|changes|start|connections|squads|mappings}` after Refresh, Start or seen. Lists refetch on the signal; nothing polls.
