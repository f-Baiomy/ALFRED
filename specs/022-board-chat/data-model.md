# Data Model: Board Chat (specs/022)

All tables live in `board.db` (backend-board, `SqliteBoardRepository`/`SqliteChatRepository`, created with
`CREATE TABLE IF NOT EXISTS`, like the slice's other tables). Times are epoch millis.

## Chat key

A chat is identified by `(project, cycle_id)`; `cycle_id = ''` is the project chat. Exposed on the wire as
`scope = "project"` or the cycle id.

## chat_messages

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | also the order |
| project | TEXT NOT NULL | |
| cycle_id | TEXT NOT NULL | `''` = project chat |
| parent_id | INTEGER NULL | thread reply → parent message (FR-008) |
| author | TEXT NOT NULL | `USER`, `CLAUDE`, `ALFRED` (digest, watch fired, system lines). Not the `Actor` enum - kept out of card fields (older Alfreds throw on unknown enum values) |
| kind | TEXT NOT NULL | `TEXT`, `SUMMARY`, `DIGEST`, `SYSTEM`, `TASK` (compact / watch toggle for the runner) |
| text | TEXT NOT NULL | ≤ 64 KB, mentions as `@[type:ref|label]` |
| state | TEXT NOT NULL | user: `WAITING` → `TAKEN` → `ANSWERED` / `STOPPED` / `CANCELLED`; Claude/Alfred: `DONE` |
| urgent | INTEGER 0/1 | FR-038 |
| decision | INTEGER 0/1 | FR-024: set when ★ created a DECISION record (`chat_records`) - the record is the decision, this is its link |
| origin | TEXT NULL | `typed`, `ask-item`, `skill:/alfred-x`, `digest`, `watch`, `bridge`, `listen`, `asked-again` |
| context_json | TEXT NULL | "looking at" refs (FR-020) |
| quote_text | TEXT NULL | quoted part (FR-006) |
| extra_json | TEXT NULL | proposals, questions block, consent payload (resend/rule), fix report, visual, diff, compare, report |
| reactions_json | TEXT NULL | `{"👍":1,"❓":1}` |
| covers_to | INTEGER NULL | SUMMARY: last message id it covers |
| reply_to | INTEGER NULL | Claude's answer → the user message it answers |
| bridge_from | TEXT NULL | `project` when asked from the project chat (one record, two views) |
| superseded | INTEGER 0/1 | answer asked again (FR-045) |
| edited_at, created_at | INTEGER | |

Indexes: `(project, cycle_id, id)`, `(parent_id)`, `(state)` partial for `WAITING`.

**Validation**: text non-blank unless images; ≤ 64 KB; `parent_id` in the same chat; edits/cancels only while `WAITING`
and only by the user; Claude may post only `TEXT`/`SUMMARY` and only after a take on that chat.

**State transitions** (user message): `WAITING` --take--> `TAKEN` --reply--> `ANSWERED`; `TAKEN` --stop / runner gone-->
`STOPPED` (back to `WAITING` when the runner went away, FR edge case); `WAITING` --cancel--> `CANCELLED`.

## chat_settings

`(project, cycle_id) PK`, `auto_n INTEGER` (default 100, 0 = off), `digest_gap_min INTEGER` (30), `watching INTEGER 0/1`.

## chat_sessions (R3)

`(project, cycle_id) PK`, `chat_session_id TEXT` (the fork the runner continues), `forked_from TEXT NULL` (terminal
session id), `forked_at INTEGER`, `seen_up_to INTEGER` (terminal work the fork knows), `terminal_at INTEGER NULL` (latest
significant terminal work the runner saw - "terminal moved on" when > seen_up_to).

## chat_records (R5)

| Column | Notes |
|---|---|
| id PK | |
| message_id | the Claude message that made it |
| kind | `DECISION`, `CARD`, `ITEM`, `FIX`, `NEXT` |
| target | brief section / card id / spec file+item / card id |
| line | what the chat shows ("recorded the decision … in the brief") |
| undo_json | before-state needed to reverse it |
| undone_at | NULL until undone |

## chat_terminal_items (R6)

`id PK`, `project`, `cycle_id`, `message_id NULL` (null for a batched summary), `urgent 0/1`, `text`, `reason`
(`exchange` - the mirrored question and answer, `contradicts`, `changed-files`, `addressed`, `compact` - a pointer), `state` (`WAITING` (no terminal), `QUEUED` (terminal busy - coalesced), `SENT`,
`DELIVERED`, `READ`, `UNDONE`), `created_at`, `delivered_at`, `read_at`. Undo only while not `READ`.

## chat_watches (R13)

`id PK`, `project`, `cycle_id`, `kind` (`ITEM_PASSES`, `STATUS`, `ERROR_LOG`), `target` (item key / status class / endpoint),
`label`, `message_id` (who set it), `created_at`. Deleted when fired, cancelled, or the cycle stops recording / is removed.

## Changes to existing models

- `BoardChanges`: + `chats: List<ChatChange>` (`scope`, `messageId`, `what` = posted/edited/cancelled/task/watch, `urgent`,
  `at`) and + `fromChat: List<TerminalItem>` (for a terminal session's reads). Records are additive; older readers ignore them.
- `LiveWorkUseCase.Report` / `LiveWork`: + `chatMessageId` (nullable, in memory only).
- `LiveWorkUseCase.chatBeat`: + `terminalAt` (R4) - the beat **writes** `chat_sessions.terminal_at`; the table is the one source the panel reads.
- `MentionOwner` + `CHAT`; `MentionType` + `CHAT` (R14 risk + tolerant importer).
- Board export: + `chats` (messages, settings, records, terminal items; no sessions - machine-local).

## Retention

Messages: unbounded per chat by design (human-rate, compacted, never deleted); removed with their cycle (`cycleRemoved`),
or by an import that replaces the board. Records, terminal items, watches: removed with their messages / cycle. Images:
the existing `board_images` budget.
