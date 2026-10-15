# Review D4 - board chat, US8 (T091-T092)

Reviewed: the D4 diff against FR-030..035 and FR-047; bug hunt (watch after cycle stop, duplicate fire, bridge echo, the
split view sending to the wrong chat, the snippet sandbox).

## What D4 adds

| Requirement | Where |
|-------------|-------|
| FR-030 watch while I test | ◉ in a cycle chat's header sets the chat's `watching`. `ChatWatchService.callCompleted` (from `boardbridge/BoardRetestWatchAdapter`, on its own thread) keeps ONE waiting `watch` task per watching cycle chat whose Claude is on; calls arriving while it waits join it (`calls`, `since`). The chat's Claude checks the batch (`wait_for_calls` + `check_calls`) and answers once; nothing found → `chat_reply` with `{quiet: true}` closes the task and posts nothing. `/alfred-listen` keeps its job and its findings also appear in the cycle chat as "👂 listen runner: …" (none for a clean batch). The panel shows "◉ watching while you test". |
| FR-031 tell me when | `chat_watch` STATUS ("5xx", "404"), ERROR_LOG (an endpoint part or "*"), ITEM_PASSES ("AC5", an item key or the start of its text). Calls fire STATUS / ERROR_LOG; the board's "requirements" signal (`BoardChangeFeed.observe`) fires ITEM_PASSES when the verdict is MET. Each posts one 🔔 line under the message that set it and is removed first, so it never posts twice. Listed in the panel with ✕. |
| FR-032 visuals | Claude's answers render through the board's markdown view with previews on: fixed blocks, `calls`, `compare` and `html live` / `python live` snippets in the same locked frame; in a cycle chat 📌 pins to the cycle and ★ saves a project widget. |
| FR-033 diff / compare | `diff_calls`, `compare_cycles` and the ```` ```compare ```` block, named in the chat's rules. |
| FR-034 report page | `board_page_put` on the cycle and a mention of it (rules). |
| FR-035 bridge | The project chat's composer "Ask … the Claude of <cycle>" posts with `origin: bridge:<cycle>`: the message lives in the cycle's chat (`bridge_from = project`) and is answered by that cycle's Claude; question and answer show in both chats (one record each). |
| FR-047 split | ◫ opens a second chat beside the first (its own scope, send box and draft), ⇆ makes it the main one, ✕ closes it. |

## Findings

| # | Kind | Finding | Fix | Test |
|---|------|---------|-----|------|
| F1 | Duplicate | Two calls at the same moment could both fire a "tell me when". | The watch is deleted first; only the call that deleted it posts. | `ChatWatchServiceTest.aStatusWatchFiresOnce…` |
| F2 | Batching | Every call would start its own check. | One waiting task per chat; calls join it until Claude takes it. A taken batch is closed, the next call starts the next. | `ChatWatchServiceTest.watchingQueuesOneBatch…` |
| F3 | Quiet | A clean batch must post nothing. | `{quiet: true}` on a watch task answers it without a message. | same test |
| F4 | Bridge | Only the project chat may bridge, and a bridged question starts its own thread. | Refused otherwise (INVALID). | `ChatWatchServiceTest.theProjectChatAsksACyclesClaude…` |
| F5 | Split | Keyboard shortcuts answered by both panels toggled full screen twice. | Only the main panel answers keys. | manual |
| F6 | Split | Sending from the second chat must go to its own scope. | `scope` is per panel (`second` input); the send box, chips and draft key use it. | manual |
| F7 | Text | Bash heredoc edits turned `\n` inside JS strings into real line breaks (the listen runner's finding post). | Rewritten with the editor; `node --check` on the runner files. | `node --check` |
| F8 | Sandbox | Visuals in chat answers. | Unchanged `snippet-host` (sandbox `allow-scripts`, CSP `connect-src 'none'`); `snippet-security.spec.ts` green in the full run. | `snippet-security.spec.ts` |

Known limit: the board slice is not told when a cycle stops recording, so "watch while I test" ends when the user turns
◉ off (or the chat's Claude stops). With the runner gone nothing queues - a batch needs the chat's Claude on.
