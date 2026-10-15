# Review D1 - board chat, US1-US4 (T062-T065)

Reviewed: the D1 diff against FR-001..019, FR-036..042, FR-048..060 and mock.html; bug hunt; security and performance pass.
Every finding below was fixed with a test that failed first (or a test added where none covered it). No open item.

## Gaps against the spec (T062)

| # | Requirement | Finding | Fix | Test |
|---|-------------|---------|-----|------|
| R1 | FR-012 | Chats were not in the board export/import. | `ChatTransfer` writes `chatSettings`/`chat`/`chatRecord`/`chatTerminal` records through `GET /board/chats/export` (paged); `ImportBoardService` reads them back: threads, answers and summaries remapped, waiting/taken messages come back STOPPED, records keep their line but refuse Undo (what they wrote belongs to the other board), terminal items come back read. A cycle chat whose cycle is not here lands in the project chat marked `[from cycle <name>]`. | `ImportBoardServiceTest` (3 new), `SqliteChatRepositoryTest.exportPages…`, `terminalItemsCannotLeave…` |
| R2 | FR-016 | A new conversation taking over a chat (another machine, a copy of another terminal session) was not marked in the chat. | `putSession` adds a system line when the session changes host or source; a continued or re-copied session adds none (the runner says "re-copied" itself). | `ChatServiceTest.anotherConversationTakingOver…` |
| R3 | FR-037 | The place in line ignored a card Claude was answering, and the header did not say Claude was busy on a card. | `busyCards` from the live work of the project; header "busy on #N"; position counts it. | covered by `chat-queue.spec` (`queuePosition` with `busy`) |
| R4 | FR-042 | The middle notification level was "answers to me"; the spec says "only questions and failures". | `ChatMute` = `all` / `questions` / `none`; `shouldNotify` pops up at `questions` only for a new question/proposal/confirm or a failed/stopped run. | `chat-bar.spec` "notifies per chat level" |
| R5 | FR-050/051 | Skill text did not tell the terminal session what ⚡ / 💬 board-chat lines mean, and a context line read like the existing "💬 #35 … you commented" line that asks for work. | `💬 board chat: …` prefix for context lines; rules.md "Board chat" section; alfred-live SKILL.md "Lines from the board chat". | `chat-runner.test` terminal line; `test_alfred_skill.py` |

## Bugs (T063)

| # | Where | Bug | Fix | Test |
|---|-------|-----|-----|------|
| B1 | chat-message template | `'…terminal session's chat log'` - an apostrophe inside a quoted template string. The AOT build of the earlier commit did not include it yet; JIT (tests) failed to compile the component. | Reworded. | `chat-panel.component.spec` (renders the message) |
| B3 | `ChatRecordService` | Two constructors and none marked `@Autowired`: the slice tests build it by hand, so only the whole-app context failed ("No default constructor found") - the backend would not have started. | `@Autowired` on the public constructor. | `BackendContextStartsTest` (failed first) |
| B2 | `chat_reply` | An answer edited in place (`updateId`) sent a second mirrored exchange to the terminal (FR-050: one item per exchange). A question the terminal itself asked would be echoed back. | No mirror item for `updateId` or `bridgeFrom: terminal`. | `chat.test` "updateId edits the earlier answer in place" |

Races checked and already covered: two takes (compare-and-swap, `ChatServiceTest.aMessageWaitsIsTakenOnce…`), edit during take (`editWaiting` only `WHERE state='WAITING'`), runner gone mid-answer (`…TakenByARunnerThatWentAway…`), run failed/stopped (`aRunThatFails…`), auto-compact during an answer never folds in-flight (`autoCompactQueuesOneTask…`), undo of records and of a brief changed since (`recordsAreWritten…`, `aBriefChangedSince…`), cycle removal (`SqliteChatRepositoryTest` mentions + `cycleRemoved`), handover from the summary (`searchMarksFoldedHits…`), card comments and chats in arrival order (`chat-runner.test` order).

## Security and performance (T064)

| # | Check | Result |
|---|-------|--------|
| S1 | Input clamps | Text 64 KB (DTO + service), page limit 1..100, search query 200, context ≤ 10, records ≤ 20, terminal items ≤ 11. **Finding:** a reply's `extra` had no cap - now 256 KB serialized (`ChatServiceTest.aReplyPayloadOver256KbIsRefused`). |
| S2 | Tunnel read-only | Every `/board/chats` write goes through `BoardEditAccessInterceptor` (`BoardEditAccessInterceptorTest` tunnel chat writes). |
| S3 | Claude-only routes | take, reply, summary, session, terminal, delivered, release, system refuse a non-Claude actor; compact, settings, undo refuse Claude. |
| S4 | No transcript to Alfred | The runner sends only ids, times and host (`PUT session`); transcript deltas go to the local `claude` process only. |
| S5 | Masking | Every terminal item and mirror is masked by `maskProseWith` before storage (`chat.test` masking tests). |
| S6 | No timers/polling | `grep setInterval|interval(|timer(|setTimeout` over the chat components, chat state and chat.mjs: none. The transcript is watched by `fs.watch` only (`chat-runner.test`). |
| S7 | Bar / list SQL | The bar is one GROUP BY over `idx_chat_messages_chat` plus one read of the last message per chat (preview cut). **Finding:** `terminalOf` (export) had no index on `message_id` - added `idx_chat_terminal_message`. |
| S8 | Monitor events | One chat-log line per mirrored exchange; urgent items as their own ⚡ line. |
