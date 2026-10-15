# MCP contract: chat tools (mcp-server/src/tools/chat.ts)

Every write goes through `ReadableWriter` (specs/021): shorthand (`AC8`, `#47`, `calls #75`) becomes chips before it is
stored. Tool names are checked by `tests/python/test_alfred_skill.py` against the skills.

| Tool | Input | Output / effect |
|---|---|---|
| `chat_take` | `{project, scope, messageId, chatId}` | the message, its thread, context chips, quote; refused (with the holder) when another chat holds the cycle |
| `chat_reply` | `{project, messageId, text, records?, toTerminal?, extra?, updateId?}` | posts the answer; returns the record lines ("✓ recorded …") and terminal items as stored, `readable`/`notFound` like other board writes |
| `chat_read` | `{project, scope, id?, answerOf?, part?, before?, limit?}` | one message whole (or one part: `diff`, `sql`, `visual`) or a page - what a mirrored reference points to |
| `chat_summary` | `{project, scope, text, coversTo}` | a compact summary (decisions, findings, open questions as chips) |
| `chat_mirror` | `{project, scope, items: {text, urgent, reason}[]}` | runner only: items for the terminal outside an answer (a compact pointer); masked with `maskProse` always |
| `chat_watch` | `{project, scope, kind, target, label, messageId}` | tell-me-when; Alfred posts when it fires |

Changed tools:

- `board_changes` / `board_wait`: + `chats` (messages to answer, in time order with card entries, urgent first) and
  `fromChat` (items for a terminal session).
- `task_context`: + the cycle chat's latest summary, messages after it, decisions, and unread / held terminal items.

## Skill rules (skills/_shared/rules.md, new bullets)

- **Record it if another session needs it to continue the work correctly; otherwise don't.** Decision → `records:
  DECISION`; new problem → `CARD`; new acceptance condition → `ITEM` (the user accepts); code change → `FIX`; question
  left open → `NEXT`. Plain explanation and Q&A: no record.
- **Urgent for the terminal** (`toTerminal.urgent`): a decision contradicting what the terminal is doing or did, a change
  to files the terminal edited, a message the user addressed to it ("@terminal"). Everything else is mirrored by Alfred.
- A ⚡ line from the board chat in the terminal session: act on it before the next step. A 💬 chat line: context only,
  write nothing.
