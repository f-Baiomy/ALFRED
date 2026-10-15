# Research: Board Chat (specs/022)

Each entry: **Decision**, **Rationale**, **Alternatives considered**. Facts were read from the code on 2026-10-15.

## R1. Where the chat lives in the backend

- **Decision**: inside `backend-board` - new classes in the slice's existing packages (`ChatMessage`, `ChatService`,
  `ChatController`, `SqliteChatRepository` …), its tables in `board.db`.
- **Rationale**: everything the chat touches is already in this slice - mentions and their re-indexing, Claude's actor
  limits (`X-Alfred-Actor: claude`), `BoardChangeFeed` (the /ws/board signal and `board_wait`), `LiveWorkService`
  (live steps, `CycleChat`), the brief, proposals, spec files, retest plans, export/import, `cycleRemoved`. A new slice
  would need edges to all of them.
- **Alternatives**: a `backend-chat` slice - rejected, it would need a board edge for every record and every mention.

## R2. Who answers, and how a message reaches it

Fact: `/alfred-live` answers **each change with a fresh `claude -p` run** from a warm pool (`alfred-live.mjs`, ClaudePool);
nothing is typed into the user's terminal session. It reads changes from `GET /board/changes/wait` (a `DeferredResult`
woken by `BoardChangeFeed`, never a poll).

- **Decision**: chat messages ride the same feed. `BoardChanges` gains a `chats` list (new messages, edits, cancels,
  compact tasks, watch toggles) next to `entries` and `cycles`; the runner handles them in time order with card comments
  (FR-003), urgent first (FR-038). A cycle chat is answered by the runner of the chat that holds the cycle (`CycleChat`);
  the project chat by the project's live runner (`LiveRunner`). A message is **taken** (`POST /board/chats/messages/{id}/take`,
  refused when another runner holds the cycle) before work starts - the "✓✓ Claude has it" tick.
- **Rationale**: one wait loop, one ordering, no second channel; the runner already holds the chat id and the cycle.
- **Alternatives**: a second long-poll for chats - rejected, two loops would race on ordering.

## R3. The chat's Claude session - fork once, continue the fork (user decision, explain-session-context.html)

- **Decision**: the runner keeps one Claude Code session per chat:
  - first message of a cycle chat: `claude -p --resume <terminal session id> --fork-session` (the terminal session id
    is the `CycleChat.chatId` the runner already beats with); the new session id is read from the stream-json `init`
    event and stored in Alfred (`chat_sessions`), so a runner restart continues the same fork;
  - every later message: `claude -p --resume <chat session id>`;
  - project chat and a cycle with no terminal session: a fresh session started with Alfred's context, then resumed.
  - The terminal session is never resumed without `--fork-session` and never written to.
- **Rationale**: real memory of the terminal session plus one growing chat conversation, low cost per message after the
  first (prompt cache). Writing into the open session is unsafe: two writers on one session file, and the open terminal
  keeps its conversation in memory so it would not see the turns.
- **Alternatives**: fresh run + transcript digest (memory is a summary, misses reasoning); fork per message (re-reads the
  whole session every message, piles up sessions). Both shown in explain-session-context.html; user chose A.

## R4. Catching up with the terminal (FR-052) - delta first, re-fork rarely

- **Decision**: before running a chat message the runner checks the terminal session's transcript
  (`~/.claude/projects/<cwd slug>/<id>.jsonl`, on the runner's own machine) for significant work after the chat copy's
  last seen entry: an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool use, or a decision the terminal recorded in Alfred.
  If found, it **adds the new entries** (user/assistant text, tool calls with their inputs, edited file names and diffs as
  references) to the chat's own session as one turn - the copy's cached context stays, only the delta is new. A full
  re-fork (`--resume <terminal> --fork-session`) happens only when the transcript shows the terminal compacted itself
  (its earlier context was rewritten) or the delta is larger than what the copy holds; then only the chat messages the new
  copy lacks are passed. The header's "terminal moved on" comes from the runner's heartbeat (`chatBeat` + `terminalAt`).
- **Rationale**: a re-fork re-reads the whole session (~120k for a morning); a delta is usually 2-10k and drops nothing.
- **Alternatives**: always re-fork (simple, ~10x cost per catch-up); re-fork on every new line (expensive, reads and
  questions would force it).

## R5. What the chat records in Alfred without being asked (FR-048, FR-049)

- **Decision**: Claude decides what to record (skill rules: "record it if another session needs it to continue the work
  correctly; plain explanation stays in the chat"); Alfred applies it. The chat reply tool takes `records`:
  `DECISION` (append to the brief's Decisions), `CARD` (Inbox card, existing duplicate checks), `ITEM` (a spec-item
  proposal the user accepts), `FIX` (fix report comment + re-test plan via the existing retest service), `NEXT` (append to
  the brief's Next). `ChatService` applies each through the slice's existing use cases **as Claude** (same limits), stores
  what it did (`chat_records`, with the before-state needed to undo), and returns the lines the chat shows. Undo reverses
  it as the user and posts "↩ undone: …".
- **Rationale**: one place enforces limits and keeps undo data; the model only chooses.
- **Alternatives**: let Claude call `board_set_brief` / `board_add` directly - rejected, Alfred could not link the record
  to the message or undo it.

## R6. Mirroring the chat into the terminal session (FR-050, FR-051)

Fact (skills/alfred-live/SKILL.md "While it runs"): the terminal session already follows the runner's **chat log** with the
Monitor tool. Card answers arrive there as one line each (context, "write nothing"), and two kinds of line are acted on
(`▶ from the board …`, `💬 #35 … needs an investigation`). That is the existing channel into a running session.

- **Decision**: mirror the chat through that same chat log - no new hooks, no settings change:
  - one log event per exchange, written when the answer is done: the question and the whole answer's prose;
  - bulky parts replaced by references (`@[stmt:…]`, `chat_read 912#diff`) - prose is small, payloads are big;
  - coalesced: events that pile up while the terminal is in a turn are written as one block when it is free (the runner
    sees the terminal's turn state in the transcript);
  - urgent lines are a third act-on kind (`⚡ from the board chat: …`): a contradicting decision, a chat change to files the
    terminal edited (the runner compares the chat run's edited files with the transcript's), `@terminal`;
  - no echoes (the terminal's own bridge questions and items are not mirrored back); a compact sends a pointer;
  - **masking first** (Principle I): every line passes the session masking (the MCP server's masking rules: tokens, passwords,
    cookies, auth headers, configured secrets) before it is written; call bodies and headers are references only - the
    chat log is a log file and never holds them in clear text;
  - every item is stored (`chat_terminal_items`) so board_changes / board_wait / task_context show it as "From the board
    chat" and a closed terminal gets held items at its next session.
- **Cost**: Claude writes each answer once and Alfred stores it once; the terminal reads it once as input (appended at the
  end of its context, so its earlier context stays cached) and pays one short Monitor turn per exchange.
- **Refresh without doubling**: a re-fork passes only the chat messages after the last one mirrored into the terminal (the
  copy already holds the rest).
- **Alternatives**: Claude Code hooks injecting `additionalContext` - rejected now that the Monitor channel exists (it would
  change the user's settings for no gain); summary-only mirroring - rejected by the user ("nothing missed").

## R7. Live steps

- **Decision**: reuse `LiveWork`: `Report` gains an optional `chatMessageId` (in memory only, never exported), card number 0.
  The panel reuses `app-live-work-box` (steps, draft, Stop).
- **Alternatives**: a chat-only live type - rejected, duplicate of an existing behavior (Principle V).

## R8. Storage and retention

- **Decision**: `board.db` tables (data-model.md). Text messages are unbounded per chat by design - bounded by human typing
  and Claude replies (~1-5 KB each), compacted, never deleted except with their cycle or by an import that replaces the
  board; images use the existing `board_images` store and its budget; one message capped like a comment (64 KB text).
  List reads are windowed (last 50, `before=` cursor) and never select folded bodies for the bar summaries.
- **Rationale**: Principle II needs an explicit retention; the user asked never to lose context (compact, not delete).

## R9. Compaction (FR-014, FR-015)

- **Decision**: a summary is a message of kind `SUMMARY` with `covers_to` (the last message id it covers). Older messages
  stay rows; the client folds everything up to `covers_to` of the newest summary. Auto-compact: after each post Alfred
  counts messages since the last summary; at the chat's `auto_n` (default 100, `0` = off) it posts one `COMPACT` task
  (kind `TASK`) the runner answers with a summary. Every compact of a cycle chat also queues the batched terminal item (R6).
- **Alternatives**: delete or archive old rows - rejected by the user.

## R10. Per-viewer state

- **Decision**: read marks, drafts, mute level, chats-bar width/narrow, view (dock/expanded/full/window) live in the browser
  (`localStorage`, try/catch, safe to lose). Unread counts are computed client-side from the bar summaries' newest id vs
  the stored read mark.
- **Rationale**: Alfred has no user accounts; these are per-viewer conveniences (Principle II: no server state for them).

## R11. Proposals, bulk, undo (FR-026, FR-046) - toast ≥ 6 s, server window 60 s (the board's close-undo pattern)

- **Decision**: proposals live in the message's `extra` JSON (`kind`: move, verify, close, mark, specItem, link,
  duplicate, with the target and Claude's reason). Accept = `POST /board/chats/messages/{id}/proposals/accept` with the
  proposal ids; `ChatProposalService` re-checks each against the board **at that moment** (FR-026) and applies through the
  existing use cases as the user, storing before-state; Undo within 60 s (the board's existing close-undo window) restores.
  Stale ones come back as `outdated: <why>`, never applied.

## R12. Resend and interception rules (FR-028)

- **Decision**: Claude stores the prepared payload in the message (`extra.type = resend | rule`). The frontend's existing
  consent dialog (`BoardActionsService`) shows it; on confirm the frontend calls the existing `/resend` and
  `/interception` endpoints. `backend-board` never calls those slices - no new cross-slice edge.

## R13. Tell-me-when and watch (FR-030, FR-031)

- **Decision**: `chat_watches` rows. Two event sources, no timers: (a) `RequirementService` after judging an item publishes
  the verdict change in-slice → `ChatWatchService`; (b) completed calls - `backend-app/boardbridge/BoardRetestWatchAdapter`
  already hears every completed call for re-tests; it also calls `ChatWatchUseCase.callCompleted(facts)`. A fired watch
  posts one Alfred message and ends. "Watch while I test" is a chat setting delivered to the runner, which does listen
  work in the chat's session and posts batches via the reply tool's `updateId` (edit in place).

## R14. Mentions and export compatibility

- **Decision**: chat text is indexed like comments with `MentionOwner.CHAT` (so `CommentedCallsKept.BoardMentions` keeps the
  calls, FR-013). A chat message is mentioned as `@[chat:<scope>/<id>|label]` with new `MentionType.CHAT`.
- **Risk**: older Alfreds call `MentionType.valueOf` on imported links (`ImportBoardService` line ~469) and would throw on
  `CHAT`. Mitigation: chat mentions are never written to a card's link list (text only); the text indexer and the
  importer skip unknown types (fix + test in this feature). Board export gains a `chats` section; an older Alfred ignores
  it (Jackson ignores unknown properties there - verify with a test fixture from `buildBulkExportPayload`'s board twin).

## R15. Project ↔ cycle bridge (FR-035)

- **Decision**: one record: the message is stored in the cycle chat with `bridge_from = 'project'`; the project chat's
  list query includes messages with `bridge_from = 'project'` for its cycles, and Claude's answer gets the same flag.

## R16. Separate window and routing

- **Decision**: an Angular route `/chat` (SPA page, no backend prefix) renders the bar + conversation only; both windows
  open their own /ws/board socket, so they stay live with no extra sync. Backend routes are under `/board/chats/…`, so the
  gateway regex and `SpaPageFilter` need no change.

## R18. Automatic usage savings (FR-055, FR-056)

All decided by the runner and Alfred, none configured, none dropping context:

| Measure | Where | Lossless because |
|---|---|---|
| Delta catch-up (R4) | runner | every new transcript entry is passed |
| Mirror rides the terminal's next turn | runner: the chat-log event is written only when the terminal starts a turn - learned from `fs.watch` change events on the transcript file (event-driven, no recurring check; a re-arm on rename/rotation) - ⚡ urgent items are written at once | the terminal cannot act without a turn, and gets every item before acting |
| One run for waiting messages | runner: `take` of all waiting messages of a chat in one run, `chat_reply` once per message | each message keeps its own reply and tick |
| Catch-up while the cache is warm | runner: on a terminal turn end with significant work, if the chat was used in the last hour, apply the delta now | same delta, cheaper read |
| Stable prompt prefix | runner prompt order: rules → Alfred context → chat summary → delta → message | ordering only |
| Summary-first tool results | MCP tools used by chat runs return summaries with the body one call away (existing paging) | bodies fetched on demand, never cut |
| "Already in your session" note | runner lists calls/files/statements the session already read (from its transcript) | the data is in context already |
| No run when nothing is new | runner + Alfred: clean batch, empty digest, terminal change without new entries start nothing | nothing to say |

The token meter reads `usage` (input, cache read, cache write, output) from each run's stream-json result and the runner
reports it with the reply (`chat_reply.usage`) and per mirror; "saved" is the estimate of the avoided alternative (full
re-fork size, extra wake turn, extra context read).

## R19. Alfred on another host (FR-057, FR-058)

- **Decision**: unchanged split - Alfred (any host) stores messages, records, items and the fork's session id as text; the
  runner on the user's machine forks, resumes, reads the transcript and writes the chat log. `CycleChat.host` names the
  machine; the panel shows "answered from <host>". A runner on a machine that cannot see the cycle's terminal session
  (no transcript file for that chat id) starts its own session from Alfred's context and says so; a takeover by another
  machine is a handover (summary + recent messages); "Continue in terminal" shows the host that holds the fork.
- **Requirement**: the runner's machine has board edit access on Alfred (`ALFRED_SETTINGS_EDIT_FROM`), as for card answers.

## R20. Card comments answered by the chat's session (FR-060)

Fact: today each card comment is a fresh `claude -p` run from the warm pool that sees only the comment and the card's recent
thread; up to 3 cards in parallel; comments needing an investigation are sent into the terminal session (`💬 #35 …` act-on
line); plain changes are noted without a run.

- **Decision**: for a card in a cycle, the runner answers the comment with the **cycle chat's session** (`--resume <fork>`),
  with the same prompt shape as today (the card, its recent thread, what the user did) plus the reply tool `board_reply`;
  the live box stays on the card (`LiveWork.cardNumber`). Cards without a cycle use the project chat's session. Waiting
  comments and chat messages of one chat are taken together in one run (R18), so the 3-way parallelism becomes batching
  per chat; different cycles still run in parallel. Investigations stay in the chat session; the terminal gets the
  mirror (⚡ only by the urgent rules). Plain changes (moves, closes, flags, teams) stay noted, no run. The chat shows
  "↳ answered your comment on #49" linking to the card entry.
- **Rationale**: one memory for everything said about a cycle; the cost per comment stays about the same (~12k cached read
  vs a 10-20k fresh run) but now remembers.
- **Alternatives**: keep fresh runs (no memory - the gap the user pointed at); keep investigations in the terminal
  (interrupts the user's terminal work).

## R17. Reuse map (Principle V)

| Need | Reused |
|---|---|
| Composer, @ picker, readable refs, images, snippets | `mention-editor`, `mention-picker`, `readable-refs.ts`, board images |
| Message body, chips, live labels | `markdown-view`, `mention-chip`, `mention-group`, `ref-text`, `BoardMentionsService` |
| Live steps + Stop | `LiveWork`, `app-live-work-box` |
| Questions | specs/019 `questions` block + `quick-answer` |
| Proposals, consent, undo | `BoardActionsService` consent dialog, `undo-toast` pattern, proposal re-check |
| Reactions | the comment reactions (`CommentExtrasUseCase`) shape, stored on the chat message |
| Fix report + re-test | `RetestService`, `board_retest_plan` |
| Visuals | specs/017 locked snippet runner, `board_widget_put` |
| Diff / compare | `diff_calls`, `compare_cycles` outputs rendered by existing table/markdown views |
| Change signal | `BoardChangeFeed` (/ws/board), `board_wait` |

## Setup checks (T001-T003, 2026-10-15)

- `gateway/nginx.conf` line 58 and `SpaPageFilter` already route every `/board/...` request to the backend - `/board/chats/...`
  needs no gateway or SPA change.
- `/chat` (the separate window) is not a backend prefix in either list, so a page load of `/chat` is served the SPA; no
  `$spa_page` entry needed.
- No contradiction found with R1-R20 in docs/architecture.md (board slice is SQLite-only, `board.db`).
