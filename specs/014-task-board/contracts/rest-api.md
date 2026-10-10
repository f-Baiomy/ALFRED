# REST API: /board (014)

Base prefix `/board` (new; add to `gateway/nginx.conf` regex, `SpaPageFilter` prefixes, and the `$spa_page` map so a page load of `/board` serves the SPA). JSON in and out. Errors via the slice's exception handler: `400` validation, `403` edit not allowed (R10), `404` unknown, `409` refused rule (Claude limits, illegal transition, number clash) with `{error, message}`.

Header `X-Alfred-Actor: claude` marks Claude's requests (R11). Absent = USER.

All limits below are clamped server-side.

## Cards

| Method | Path | Body / query | Returns |
|--------|------|--------------|---------|
| GET | `/board/cards` | `project`, `cycleId?`, `kind*`, `status*`, `flag*`, `author?`, `scopeNotDecided?`, `q?`, `offset=0`, `limit=200 (1-500)` | `{cards: CardSummary[], total, counts: {open, fixed, done}}` |
| GET | `/board/cards/{id}` | | `CardDetail` (card + links + similarClosed) |
| GET | `/board/cards/by-number/{number}` | `project` | `CardDetail` - how the MCP tools and card mentions find a card |
| GET | `/board/access` | | `{editable, reason, howToEdit}` - the edit rule's decision for this viewer (served by `backend-app/boardbridge`) |
| GET | `/board/cards/{id}/activity` | `offset`, `limit (1-1000)` | `{entries: ActivityEntry[], total}` |
| POST | `/board/cards` | `{project, kind, title, description?, flags?, cycleId?, status?, links?: MentionRef[]}` | `201 CardDetail` (Claude: status forced INBOX; `409 {error:"duplicate-of-closed", number, resolution, reason}` when the call links' signature equals a card closed as FINE or NOT_IN_FLOW; `409 {error:"paused"}` while the live strip is paused) |
| POST | `/board/cards/quick` | `{project, cycleId?, text}` - quick-add line parsed server-side with the same rules as `quick-add-parser.ts` | `201 CardDetail` |
| PATCH | `/board/cards/{id}` | only the changed fields among `{title, description, kind, flags, scope, cycleId, project}`; per-field last write wins, no version | `CardDetail` |
| POST | `/board/cards/{id}/move` | `{status}` (open statuses only) | `CardDetail` |
| POST | `/board/cards/{id}/close` | `{resolution, reason?}` | `CardDetail` (user only) |
| POST | `/board/cards/{id}/reopen` | | `CardDetail` (user only) |
| PUT | `/board/cards/{id}/reason` | `{reason}` | `CardDetail` (user only; for "Add reason" after a close) |
| POST | `/board/cards/{id}/links` | `{mention: MentionRef}` | `CardDetail` |
| DELETE | `/board/cards/{id}/links` | `{ref}` | `CardDetail` |
| POST | `/board/cards/{id}/comments` | user `{text}`; Claude must send `{did, found, next, impact?}` (free text from Claude → 409) | `201 ActivityEntry` |
| DELETE | `/board/cards/{id}` | | `204` (user only) |
| POST | `/board/cards/bulk` | `{ids (1-200), action: FINE\|NOT_IN_FLOW\|TO_DO\|MARK_URGENT, reason?}` | `{updated: n}` (user only) |
| POST | `/board/cards/{id}/undo-close` | | `CardDetail` (user only; restores the state recorded in the card's last RESOLUTION activity entry; `409` after 60 s or when the card changed since the close) |

## Similar / Claude context

| Method | Path | Returns |
|--------|------|---------|
| GET | `/board/closed-reasons` | `project`, `limit (1-500)` → `[{number, title, signature, resolution, reason}]` (FR-043) |

## Cycle brief, spec files, checklist

| Method | Path | Body / query | Returns |
|--------|------|--------------|---------|
| GET | `/board/cycles/{cycleId}/brief` | | `{text, updatedAt}` (empty text when none) |
| PUT | `/board/cycles/{cycleId}/brief` | `{text}` | same |
| GET | `/board/cycles/{cycleId}/specs` | | `[{name, size, uploadedAt}]` |
| GET | `/board/cycles/{cycleId}/specs/{name}` | | `text/plain; charset=utf-8` content |
| PUT | `/board/cycles/{cycleId}/specs/{name}` | raw text body (≤ 5 MB) or multipart file | `{name, size, uploadedAt, replaced: bool}` |
| DELETE | `/board/cycles/{cycleId}/specs/{name}` | | `204` |
| GET | `/board/cycles/{cycleId}/checklist` | | `[{fileName, items: [{key, text, mark?, actor?, evidence, history}]}]` |
| PUT | `/board/cycles/{cycleId}/checklist/{fileName}/{itemKey}` | `{mark, evidence?}` | item (user only) |

## Badges, mentions

| Method | Path | Returns |
|--------|------|---------|
| GET | `/board/cycles/{cycleId}/call-badges` | `{callId: [{number, kind, status, resolution?}]}` |
| GET | `/board/call-badges` | `callIds=a,b,…` (≤ 100) → same shape (Live Calls rows) |
| GET | `/board/mentioned-call-ids` | internal use by the bridge only; not exposed through the gateway (bound to the use case, not a controller) |

## Agent status (live strip)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/board/agent-status` | `project` | `AgentStatus` or `204` |
| PUT | `/board/agent-status` | `{project, cycleId?, state, callsChecked, cardsAdded}` | `AgentStatus` |
| POST | `/board/agent-status/pause` / `resume` / `stop` | `{project}` | `AgentStatus` |

## Import

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/board/import` | `alfred-board/1` lines (streamed, ≤ 200 MB) + `project` target | `{cards, renumbered: [{from, to}]}` |

## Shapes

```ts
interface CardSummary { id; project; number; kind; title; status; resolution?; reason?; flags: Flag[]; scope; author;
  cycleId?; cycleDeleted; createdAt; updatedAt; commentCount; mentionChips: MentionChip[]  /* first 3 */;
  similarClosed?: { number; resolution; reason? } }
interface CardDetail extends CardSummary { description; links: MentionChip[]; updatedBy }
interface MentionRef { type: MentionType; ref: string; label: string }
interface MentionChip extends MentionRef { removed: boolean }
interface ActivityEntry { id; actor; kind; text?; oldValue?; newValue?; at }
```
