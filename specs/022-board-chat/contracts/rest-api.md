# REST contract: /board/chats (backend-board, ChatController)

All routes are under `/board/` - the gateway regex, `SpaPageFilter` and `BoardEditAccessInterceptor` (tunnel read-only,
`ALFRED_SETTINGS_EDIT_FROM`) already cover them. `scope` = `project` or a cycle id. Writes by Claude carry
`X-Alfred-Actor: claude` and are held to the board's Claude limits. Errors use the board's existing refusal shape
(`BoardWeb.refused`: `{outcome, message}` with 400/403/404/409).

## Read

| Method · path | Query / body | Returns |
|---|---|---|
| `GET /board/chats?project=` | | `ChatSummary[]`: `scope`, `name`, `kind`, `lastId`, `lastAt`, `lastPreview` (≤ 140 chars, plain), `lastAuthor`, `waiting`, `typing`, `needsYou` (`{questions, proposals, confirms}`), `claudeOn`, `terminal` (`{open, forkAt, seenUpTo, terminalAt}` for cycles) |
| `GET /board/chats/{scope}/messages?project=&before=&limit=` | `limit` clamped 1..100 (default 50) | `{messages: ChatMessage[], more}` newest page, oldest first; folded messages included (the client folds by `coversTo`) |
| `GET /board/chats/{scope}/search?project=&q=&filter=` | `q` ≤ 200 chars; `filter` = all, mine, claude, decisions, calls, questions, summaries | `{hits: {id, parentId, folded}[]}` (≤ 200) |
| `GET /board/chats/{scope}/shared?project=` | | `{groups: {type, refs: {mention, messageId, at}[]}[]}` (FR-043) |
| `GET /board/chats/{scope}/digest?project=&since=` | `since` epoch ms | `{changes: …}` built without a model (FR-023) or 204 when nothing changed |
| `GET /board/chats/{scope}/context?project=` | | for `task_context` / handover: latest summary, messages after it, decisions, unread terminal items |
| `GET /board/chats/{scope}/terminal?project=` | | `TerminalItem[]` (FR-051) |
| `GET /board/chats/{scope}/settings?project=` | | `ChatSettings` (defaults when never stored) |
| `GET /board/chats/messages/{id}` | | one message (MCP `chat_reply` reads the question it answers) |
| `GET /board/chats/messages/{id}/answer` | | Claude's current (not superseded) answer to it, 404 when none - what a mirrored reference points to |

## Write (user)

| Method · path | Body | Effect |
|---|---|---|
| `POST /board/chats/{scope}/messages?project=` | `{text, parentId?, context?: MentionRef[], quote?, urgent?, origin?, imageIds?: string[]}` | new `WAITING` message; mentions indexed; `chat-changed` signal; auto-compact task when the count reaches `autoN` |
| `PATCH /board/chats/messages/{id}` | `{text}` | only while `WAITING`, only the user's own |
| `POST /board/chats/messages/{id}/cancel` | | `WAITING` → `CANCELLED` |
| `POST /board/chats/messages/{id}/urgent` | | marks answer-first (FR-038) |
| `POST /board/chats/messages/{id}/decision` | `{on}` | FR-024 |
| `POST /board/chats/messages/{id}/react` | `{emoji}` | toggle; ❓ also queues an "explain more" task |
| `POST /board/chats/messages/{id}/again` | `{logs, sql, items, text?}` | new user message `origin=asked-again`; marks the answer `superseded` |
| `POST /board/chats/messages/{id}/proposals` | `{accept: string[], decline: string[]}` | re-checks each now; applies accepted as the user; returns per-id `applied` / `outdated: <why>` / `declined` and an `undoToken` (60 s) |
| `POST /board/chats/undo/{undoToken}` | | reverts that accept |
| `POST /board/chats/records/{id}/undo` | | reverses an automatic record (FR-049) |
| `POST /board/chats/terminal/{id}/undo` | | takes back an unread terminal item |
| `POST /board/chats/{scope}/compact?project=` | | queues a compact task now |
| `PUT /board/chats/{scope}/settings?project=` | `{autoN (0 or 20..1000), digestGapMin (5..600), watching}` | |
| `DELETE /board/chats/watches/{id}` | | cancels a tell-me-when |
| `POST /board/chats/{scope}/refresh?project=` | | asks the runner to re-fork at the next message (manual "Refresh from session") |

## Write (Claude, through MCP / the runner)

| Method · path | Body | Effect |
|---|---|---|
| `POST /board/chats/messages/{id}/take` | `{chatId}` | `WAITING` → `TAKEN`; 409 when another chat holds the cycle or it was taken/cancelled |
| `POST /board/chats/messages/{id}/reply` | `{text, records?: Record[], toTerminal?: {text, urgent, reason}[], extra?, updateId?}` | Claude message (`replyTo=id`), records applied as Claude (limits), terminal items stored (plus the mirror item for the exchange, built by Alfred); `updateId` edits an earlier Claude message in place (watch batches) |
| `POST /board/chats/{scope}/summary?project=` | `{text, coversTo}` | `SUMMARY` message; queues the compact pointer for the terminal |
| `POST /board/chats/{scope}/watches?project=` | `{kind, target, label, messageId}` | tell-me-when (FR-031) |
| `PUT /board/chats/{scope}/session?project=` | `{chatSessionId, forkedFrom?, forkedAt, seenUpTo}` | the runner's fork bookkeeping (R3) |
| `POST /board/chats/terminal/delivered` | `{ids: number[]}` | runner wrote them to the chat log |
| `POST /board/chats/{scope}/terminal?project=` | `{items: {text, urgent, reason, mirror}[]}` | runner-made items (a compact pointer); text already masked by the MCP server (`chat_mirror`) |

`extra` (stored as given): `questions[]` (`{id, text, options?, answer?}` - open while no `answer`), `proposals[]` (`{id, text, kind?, state?}` - open while no `state`), `consent` (`{kind, summary, payload, decided?}` - open while no `decided`), `visual`, … The open counts feed the bar's Needs you.

`Record` = `{kind: DECISION|CARD|ITEM|FIX|NEXT, text, card?: {kind, title, description}, item?: {file, text, evidence}, fix?: {card, report, plan}}`.

## Signals

`/ws/board` gains `{type: 'chat-changed', project, scope, id}` (throttled like the board's other events); the panel and
bar refetch on it - no polling. `changes/wait` wakes on the same `BoardChangeFeed` signal and returns `chats` / `fromChat`. The cursor gains a third part, `activityId.cycleMillis.chatMessageId`; a two-part cursor from an older client reads every waiting message.
