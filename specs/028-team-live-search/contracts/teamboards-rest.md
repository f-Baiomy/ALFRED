# REST: /teamboards (028)

All routes are under the existing `teamboards` gateway prefix. Writes follow the board edit rule (027); the tunnel forwards only `POST /teamboards/hooks/azure`. As Claude (`X-Alfred-Actor: claude`), every route that writes to Azure only creates or extends a consent bundle; `approve` is refused (403 USER_ONLY). Errors: `{error, message}`; `401 TOKEN_MISSING`, `403 TOKEN_REJECTED`, `429 PROVIDER_BUSY {retryAfter}`, `502 UNREACHABLE`, `400 BAD_RESPONSE` (message names the call and Azure's reason).

## Token

| Method | Path | Contract |
|---|---|---|
| PUT | `/connections/{id}/token` | body `{token}` → `200 {owner:{id,name,uniqueName}, expiresAt}`; the token is never echoed or logged |
| DELETE | `/connections/{id}/token` | forget → 204 |
| GET | `/connections/{id}/token` | `{live, owner?, expiresAt?}` |

## Search and items (live, nothing stored)

| Method | Path | Contract |
|---|---|---|
| POST | `/connections/{id}/search` | `{text?, types?, states?, openOnly=true, areas?, teams?, iterations? (incl "@current"), assigned? (incl "me"), createdBy?, changedWithinDays?, tags?, parent?, mine?:[ASSIGNED,CREATED,CHANGED,MENTIONED,FOLLOWED], sort, page, pageSize≤50}` → `{total, page, fullText:bool, items:[{id,type,title,state,stateCategory,assigned:Person,iteration,area,changedAt,rev, boards:[{boardId,name,main:bool,copyRev?}]}]}` |
| POST | `/connections/{id}/query` | `{wiql}` SELECT only (else 400) → same item rows (≤ 200) |
| GET | `/connections/{id}/items/{item}?include=fields,comments,history,relations,attachments` | live item; when a copy exists also `{copy:{rev,savedAt}, diff}` |
| POST | `/connections/{id}/items` | `{ids:[≤200], include}` → live items |
| GET | `/connections/{id}/items/{item}/attachments/{name}` | live content, ≤ 10 MB |
| PATCH | `/connections/{id}/items/{item}` | the USER's direct state/comment from the Team tab: `{state?, comment?}` → executes now, recorded as a DONE bundle; as Claude → creates a WAITING bundle |
| GET | `/connections/{id}/lists` | cached filter lists: types+states, areas, teams+members (people), iterations, people |
| GET | `/connections/{id}/people/{person}` | pill card: person + teams + projects + assignedOpen (live count) + cards owned/mentioned + boards (bridge) |
| GET / PUT / DELETE | `/connections/{id}/me` | `{person, source: TOKEN_OWNER|OVERRIDE}`; PUT sets the override, DELETE clears it |
| GET | `/connections/{id}/mine` | eight counts + the first page of each |

## Board items

| Method | Path | Contract |
|---|---|---|
| GET | `/boards/{board}/items?view=tree|type` | `{main, items:[board_items row + hasCopy + changed]}` |
| POST | `/boards/{board}/items` | `{conn, item | url, asMain?}` → adds (REF unless first/main); first item becomes MAIN; as Claude: needs `askedIn` or creates a bundle step LINK_ALFRED |
| PUT | `/boards/{board}/main` | `{conn,item}` → re-roots; `{reseedOffer:true}` |
| DELETE | `/boards/{board}/items/{conn}/{item}` | unlink (refused for MAIN unless another main is named) |
| POST | `/boards/{board}/sync` | `{force?}` → 202; result on `/ws/teamboards {what:"sync", board, changed}`; ≤ 1/min unless force |
| POST | `/boards/{board}/items/{conn}/{item}/keep` | keep Azure's version (copy moves to the new rev) |
| GET | `/boards/{board}/items/{conn}/{item}/syncs` | sync history with diffs |

## Cards

| Method | Path | Contract |
|---|---|---|
| GET | `/cards/{card}/items` | `[{conn,item,type,title,state,changedBy,copyRev,changed,closedInAzure?}]` + Azure comments for the activity |
| POST | `/cards/{card}/items` | `{conn,item}` link existing → link in Alfred now (USER) + bundle with HYPERLINK/COMMENT/TAG; as Claude → bundle only |
| POST | `/cards/{card}/create` | `{type,title,area,iteration,assignee,description}` → bundle with CREATE (+ markers) |
| DELETE | `/cards/{card}/items/{conn}/{item}` | unlink in Alfred + cleanup bundle (UNHYPERLINK, UNTAG if no other card, optional COMMENT) |
| PUT | `/cards/{card}/owner` | `{person|null}` (board slice; Claude only on its Inbox cards) |

## Incoming

| Method | Path | Contract |
|---|---|---|
| GET | `/boards/{board}/incoming` | WAITING entries with match and proposal |
| POST | `/boards/{board}/incoming/{conn}/{item}/card` | New card (USER, or accepting a proposal) → `{cardId}` |
| POST | `/boards/{board}/incoming/{conn}/{item}/link` | `{cardId}` |
| POST | `/boards/{board}/incoming/{conn}/{item}/ignore` | |
| POST | `/boards/{board}/incoming/{conn}/{item}/proposal` | Claude: `{action: NEW|LINK, cardId?, reason}` |
| POST | `/boards/{board}/incoming` | by hand / MCP: `{conn,item}` |

## Watch rules and hook

| Method | Path | Contract |
|---|---|---|
| GET / POST / PUT / DELETE | `/boards/{board}/watch-rules[/{id}]` | `{name, conn, query}` (the search body) |
| POST | `/boards/{board}/watch-rules/run` | runs all → `{new}` |
| POST | `/hooks/azure` | basic auth (any user, password = secret); Azure service-hook JSON; reads `eventType`, `resource.workItemId|id` only → 202; bad secret 401; 60/min |
| GET / PUT | `/connections/{id}/hook` | `{url, lastPing, waiting, publicAddress, badPings}`; PUT `{publicAddress}` |
| POST | `/connections/{id}/hook/secret` | rotate → `{secret}` shown once |
| GET / PUT | `/connections/{id}/type-kinds` | the type → card kind map |

## Consent bundles (Azure writes)

| Method | Path | Contract |
|---|---|---|
| POST | `/writes` | `{board, card?, conn, item, title, steps:[…], askedIn?}` → `{id}`; Claude may also `{extend: id}` |
| GET | `/writes?board=&state=WAITING` | list |
| PUT | `/writes/{id}` | edit steps (text, ticks, unmasked) - USER only |
| POST | `/writes/{id}/files` | multipart, a built export for an ATTACH step (≤ 60 MB) |
| POST | `/writes/{id}/approve` | USER only → 202; per-step results on `/ws/teamboards {what:"write", id}` |
| POST | `/writes/{id}/reject` | |

## Signals (`/ws/teamboards`)

`{type, conn?, board?, what: "token"|"sync"|"incoming"|"write"|"hook"|"lists"}` - fetch on demand, no polling.

## Removed

`POST /connections/{id}/refresh`, `GET /items` (cache list), `/changes`, `/changes/seen`, `/links/*` (027 single link), `X-Alfred-Team-Token` header.
