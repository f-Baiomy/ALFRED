# Implementation Plan: Board Chat

**Branch**: `022-board-chat` (built on master, like specs/014-021) | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/022-board-chat/spec.md` · Mock: [mock.html](mock.html) ·
Session model explained: [explain-session-context.html](explain-session-context.html)

## Summary

A chat per session cycle and per project, opened from a Messenger-style chats bar docked on the left of every tab. A
cycle chat is answered by its own Claude Code session - a fork of the terminal session working that cycle, continued for
every message and re-forked automatically when the terminal does significant work. Alfred is the shared memory: the
chat's Claude records what another session needs (decisions, cards, acceptance items, fixes, open questions) and every
exchange is mirrored into the terminal session in full prose (bulky parts as references) through the runner's chat log
the terminal already follows. The chat reuses the board's pieces end to end - mention editor and chips, markdown view,
live-work box, questions, proposals, consent dialog, retest, snippets - and rides the existing change feed
(`BoardChangeFeed`, `/board/changes/wait`). Delivered in four phases (P1 chat, P2 context, P3 actions, P4 rich), each
built, tested and committed on its own.

## Technical Context

**Language/Version**: Java 21 (backend), TypeScript 5 / Angular (standalone + signals), Node 18+ (MCP server, runner `alfred-live.mjs`), Python 3 (skills installer tests)
**Primary Dependencies**: Spring Boot (existing), SQLite via JdbcTemplate (existing `board.db`), Angular CDK (existing); no new dependency
**Storage**: `board.db` new tables `chat_messages`, `chat_settings`, `chat_sessions`, `chat_records`, `chat_terminal_items`, `chat_watches` (data-model.md); per-viewer state in `localStorage`
**Testing**: JUnit 5 / Mockito / AssertJ + ArchUnit (`backend-board`, `backend-architecture-test`), Karma/Jasmine (frontend), `node --test` via tsx (MCP), node tests for the runner, pytest (`tests/python/test_alfred_skill.py`)
**Target Platform**: Docker install and native install (Windows/Linux); browser (desktop + narrow)
**Project Type**: web application (backend + frontend) + MCP server + Claude Code skills/runner
**Performance Goals**: first live step within 5 s of sending (SC-001); chat page of 50 messages < 100 ms server-side; bar summaries one indexed query
**Constraints**: no polling (WebSocket "something changed" + `changes/wait` DeferredResult); terminal session never written to; one Monitor event per mirrored exchange; tunnel read-only
**Scale/Scope**: tens of chats per project, thousands of messages per chat over weeks (human-rate), 47+ FRs over 4 phases

## Constitution Check

*Pre-research gate and post-design re-check - both pass; no violation to track.*

- [x] **I. Security**: mirror lines and stored mirror items pass the session masking and carry bodies/headers only as
  references - the runner's chat log is a log file (analysis C1); chat endpoints validate DTOs (`@Valid`), clamp `limit`/`before` (page ≤ 100), cap text at 64 KB
  like comments; tunnel stays read-only through the existing `BoardEditAccessInterceptor` (all routes under `/board/`);
  Claude's writes go through the slice's actor limits (`X-Alfred-Actor: claude`); resend/rule payloads only run after the
  user's consent in the existing dialog; chat text rendered by `markdown-view` (no `bypassSecurityTrust*`), visuals in
  the locked snippet iframe (specs/017); the runner reads the terminal transcript only on its own machine and never sends
  it to Alfred - only the fork's answers are stored; no secrets in logs (log message ids and sizes only).
- [x] **II. Performance**: nothing on the proxy path; the runner learns of terminal turns from `fs.watch` events, never a
  recurring check (analysis U1); no polling - the panel fetches on `/ws/board` signals, the runner
  waits on `changes/wait`; bar summaries and chat pages are windowed indexed queries (`(project, cycle_id, id)`), never
  selecting folded bodies for the bar; search is `LIKE` with `LIMIT 200` per chat; one Monitor event per exchange,
  coalesced while the terminal is busy; retention defined (data-model.md "Retention").
- [x] **III. Architecture**: owned by `backend-board` (R1) in its hexagonal packages; no new cross-slice edge - resend and
  interception are called by the frontend after consent (R12), completed-call events come through the existing
  `backend-app/boardbridge/BoardRetestWatchAdapter` (R13); SQLite only, like the rest of `board.db` (the board slice has
  no file store); frontend standalone + signals, the chat bar and panel are new components composed of existing ones.
- [x] **IV. Style**: `*UseCase` per operation (`PostChatMessageUseCase`, `TakeChatMessageUseCase`, …), `ChatService`,
  `SqliteChatRepository`, `ChatController`; records for domain/DTOs; constructor injection; strict TS, `inject()`.
- [x] **V. Clean code**: reuse map in research R17 - nothing forked; no speculative options (the only setting additions are
  the spec's: auto-compact count, digest gap, watching, mirror level is fixed "full, cheaper").
- [x] **VI. Verification**: per-layer tests listed under "Test strategy"; the narrow-width layout test from the mock review
  (chip over button, Send outside the panel) is a failing-first test.
- [x] **Invariants**: exports never truncated - board export gains `chats` in full; no interception change; no new route
  prefix (`/board/chats/…`); docs updated: `docs/board.md` (Chat), `docs/mcp.md` (chat tools, mirroring),
  `skills/_shared/rules.md`, `skills/alfred-live/SKILL.md`, CLAUDE.md one bullet.

## Design

### Backend - `backend-board`

| Piece | Responsibility |
|---|---|
| `domain.model`: `ChatMessage`, `ChatKey`, `ChatSettings`, `ChatSession`, `ChatRecord`, `TerminalItem`, `ChatWatch`, `ChatSummary` (bar row) | records, validated in compact constructors |
| `port.in`: `PostChatMessageUseCase`, `EditChatMessageUseCase`, `ReadChatUseCase` (page, search, shared, bar summaries), `TakeChatMessageUseCase`, `ReplyInChatUseCase` (text + records + terminal items + updateId), `ChatSettingsUseCase`, `CompactChatUseCase`, `ChatProposalUseCase` (accept/decline/undo with re-check), `ChatRecordUndoUseCase`, `ChatTerminalUseCase` (items: list, mark delivered/read, undo), `ChatSessionUseCase` (fork ids, terminalAt), `ChatWatchUseCase` (+ `callCompleted`), `ChatDigestUseCase` | one operation each |
| `application.service`: `ChatService`, `ChatProposalService`, `ChatRecordService`, `ChatTerminalService`, `ChatWatchService`, `ChatDigestService` | apply records through existing `BoardService` / `CycleBriefService` / `RetestService` / `RequirementService` use cases; notify `BoardChangeFeed` |
| `port.out`: `ChatStorePort` | implemented by `adapter.out.sqlite.SqliteChatRepository` (same `board.db`, `CREATE TABLE IF NOT EXISTS`) |
| `adapter.in.web`: `ChatController` | `/board/chats/…` (contracts/rest-api.md) |
| changes | `BoardChanges` + `chats`, `fromChat`; `LiveWork` + `chatMessageId`; `chatBeat` + `terminalAt`; `MentionOwner.CHAT`, `MentionType.CHAT` + tolerant import; `ImportBoardService`/export + `chats`; `cycleRemoved` deletes chat rows |
| `backend-app/boardbridge/BoardRetestWatchAdapter` | also calls `ChatWatchUseCase.callCompleted` |

### Runner - `skills/alfred-live/alfred-live.mjs`

- Handles `chats` from `changes/wait` in time order with card entries, urgent first; `take` before work.
- Chat sessions (R3): fork once (`--resume <terminal> --fork-session`), continue (`--resume <fork>`), stored in Alfred;
  project chat / no terminal: fresh session from Alfred's context, then continued.
- Catch-up (R4): reads the terminal transcript for significant work after the copy's last seen entry; adds only the
  new entries to the chat's session (re-fork only after a terminal compact or a delta bigger than the copy); beats `terminalAt`.
- Card comments (R20, FR-060): comments on a cycle's cards answered by the cycle chat's session (project cards: project
  chat's session), posted on the card with live steps there; investigations stay in the chat session; plain changes noted.
- Usage savings (R18, FR-055): mirror rides the terminal's next turn (⚡ wakes it), one run for waiting messages, warm-cache
  catch-up, stable prompt prefix, "already in your session" note, no run when nothing is new; reports `usage` for the meter.
- Machines (R19, FR-057/058): all session work stays on the runner's machine; Alfred gets text only; host shown.
- Live steps: reuses its stream reader → `PUT /board/live-work` with `chatMessageId`.
- Mirroring (R6): writes one chat-log event per exchange (prose in full, bulky parts as references), coalesced while the
  terminal is in a turn; ⚡ act-on lines for urgent items; marks items delivered.

### MCP - `mcp-server`

New tools (contracts/mcp-tools.md): `chat_take`, `chat_reply` (text, `records`, `toTerminal`, `updateId`), `chat_read`,
`chat_summary` (compact), `chat_watch` (tell-me-when). `board_changes`/`board_wait`/`task_context` show `chats` and
"From the board chat". All writes pass through `ReadableWriter` (specs/021) so shorthand becomes chips.

### Frontend - Angular

| New | Built from |
|---|---|
| `components/chat/chat-bar` (left, Messenger-style, Needs you, search, narrow) | `team-chips`/avatar styles, `BoardMentionsService` labels |
| `components/chat/chat-panel` (head, session line, banners, stream, composer; views dock/expanded/full/window; split) | `live-strip`, `live-work-box`, `markdown-view`, `mention-editor`, `mention-picker`, `quick-answer`, `undo-toast`, `BoardActionsService` |
| `components/chat/chat-message` (ticks, line, reactions, records, mirrored lines, hover actions, threads) | `activity-timeline` entry/reply styles, reactions |
| `components/chat/chat-shared`, `chat-quick-switch`, `chat-settings` | existing dialog/picker styles |
| `core/services/chat-api.service.ts`, `core/state/chat-state.service.ts` (signals; refetch on `/ws/board` `chat-changed`) | `board-api.service.ts`, `board-state.service.ts` patterns |
| `pages/chat-window` (route `/chat`, the separate window) | the panel in full mode |
| `shared/utils/chat-*.ts` (queue position, unread, needs-you, shared extraction, mirror text) | pure, tested directly |
| "Ask Claude" menu items on calls, statements, log lines | existing row menus |

### Skills / docs

`skills/_shared/rules.md`: what to record and what not (the user's rule), urgent rules, `@terminal`; `alfred-live/SKILL.md`:
the third act-on line kind (⚡ from the board chat) and the 💬 chat mirror lines (context, write nothing unless ⚡);
`tests/python/test_alfred_skill.py` keeps tool names in sync.

## Phases (each: build → tests → deploy → browser check → commit)

1. **P1 chat** - FR-001…019, 036…042, 048…054: store, take/reply, bar + panel + views, composer,
   live steps, ticks/line/urgent, unread/drafts/mute/Ctrl+K, compact + auto, handover, fork + auto-refresh, records +
   undo, mirroring, Continue in terminal, tunnel read-only, narrow layout test.
   P1 also carries FR-055…060 (savings, token meter, machines, two memories, card comments on the chat's session).
2. **P2 context** - FR-020…025, 043…045: looking-at, Ask Claude, slash skills, digest, decisions, questions, shared tab,
   reactions, ask again.
3. **P3 actions** - FR-026…029, 046: proposals + bulk + re-check + undo, reply → card comment, resend/rule via consent,
   fix report + re-test.
4. **P4 rich** - FR-030…035, 047: watch + listen runner, tell-me-when, visuals + pin, diff, compare, report, bridge, split.

## Test strategy

- **Backend**: `ChatServiceTest` (post/take/reply/cancel/edit states, urgent order, Claude refused without a take or on a
  chat it does not hold, tunnel refusal via interceptor test), `ChatRecordServiceTest` (each record kind applied as Claude,
  undo restores), `ChatProposalServiceTest` (re-check stale, bulk, undo window), `ChatTerminalServiceTest` (mirror item per
  exchange, urgent, held while closed, no echo, compact pointer), `ChatWatchServiceTest` (fires once, ends on cycle stop),
  `SqliteChatRepositoryTest` (`@TempDir`, paging, cycle removal), `ChatControllerTest` (`@WebMvcTest`, clamps),
  export/import round trip incl. an older-Alfred fixture without `chats`, `CommentedCallsKeptTest` (chat mention keeps a call),
  ArchUnit unchanged and green.
- **Frontend**: pure utils (queue position, unread line, needs-you, shared extraction, mirror text sizing), components only
  where behavior is DOM-only (bar unread/needs-you rendering, panel views, narrow layout: no chip under a button, Send inside).
- **MCP**: `chat.test.ts` against `fake-alfred.ts` (take/reply/records/toTerminal/updateId, ReadableWriter conversions).
- **Runner**: node tests for fork/continue argument building, significant-work detection from a sample transcript,
  coalescing and one-event-per-exchange output.
- **Skills**: `test_alfred_skill.py` (tool names exist).
- **Live**: deploy, then browser check of each phase's flows on a throwaway project (never the user's cards).

## Complexity Tracking

No constitution violation. Two judgment calls recorded for review:

| Decision | Why | Simpler alternative rejected because |
|---|---|---|
| New enum values `MentionOwner.CHAT`, `MentionType.CHAT` | chat mentions must keep calls and be openable | reusing `CARD` would mis-route chips; older-Alfred risk handled by text-only links + tolerant importer (R14) |
| Runner reads the terminal transcript file | only way to know the terminal moved on (R4) and to avoid echoes | asking the terminal to report its own work would cost it a turn per step |
