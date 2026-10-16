# Plan: the cycle chat and the cycle's cards are answered by the terminal session

Mock: [mock-terminal-answers.html](mock-terminal-answers.html). Decided with the user (2026-10-16):

- A cycle chat, and every comment on that cycle's cards, is answered by the **terminal session that ran
  `/alfred-live <cycle>`** - no fork, no copy, no headless run. One Claude, one memory.
- A busy terminal: messages **wait** until its turn ends. A closed terminal: messages wait; **never** a copy, and
  Alfred never starts, opens or resumes Claude Code.
- Alfred stores only the user's messages, Claude's **final** answers, what needs the user (a question, a proposal, a
  confirmation) and records. The work in between is never stored (the live progress is memory-only).
- A decision in the middle is an ordinary chat reply (or card question) with the usual notification; the work pauses
  until the answer comes back. No size limit: the rules make Claude keep answers short and put long output in files or
  pages.
- The newest `/alfred-live` for a cycle takes the chat over; the old terminal is told and stops. The new one starts
  from Alfred's memory (summary, brief, recent messages) and reads more with `chat_read` when it needs to.
- Cards of other cycles and cards with no cycle stay with the project runner. The project chat is unchanged.

## How it works

`/alfred-live <project> <cycle>` already starts a runner process (no model) and this session already follows the
runner's chat log with Monitor - that is how ▶ runs from the board reach the terminal today. The change is what the
runner does with cycle work:

| Today (cycle) | After |
|---|---|
| A chat message → `claude -p --resume <terminal> --fork-session` answers | The runner takes it (WAITING → TAKEN by this terminal) and writes one line to the chat log; Monitor wakes the terminal, which answers with `chat_reply` |
| A card comment that needs an investigation → the chat's copy answers | Every card comment of the cycle → one line to the chat log; the terminal answers on the card (`board_reply`) |
| Other card changes → a fresh headless run | Same: to the terminal (quiet ones - moves, flags - are only noted, as today) |
| The copy's session, catch-up text, re-copies, "Terminal moved on" | Gone for cycle chats (the stored copy session is cleared at start) |
| `chat_reply` mirrors each exchange to the terminal | No mirror when the terminal itself answered |

A busy terminal needs no code: Monitor events are delivered when the current turn ends.

## Tasks

1. **Runner, cycle chats → terminal** (`skills/alfred-live/chat.mjs` `ChatLane.answer`): for a cycle scope, take the
   messages and write `chatLine(message)` per message (⚡ first) to the chat log - no pool run, no fork, no reporter
   draft. Release a message that cannot be written. Project scope: unchanged.
2. **Runner, cycle cards → terminal** (`alfred-live.mjs` card handling): with a cycle chat, every non-quiet card change
   goes to the terminal as `commentLine` (the existing path); the fork branch (`answerCard`/`runCard`) goes.
3. **Runner start / takeover** (`alfred-live.mjs start`): the chat log is per terminal session (its id in the file
   name). `start` with another `--chat` for a running cycle runner hands over: the old log gets
   `↪ handed over to another terminal session - stop watching`, the runner restarts on the new chat. At start the
   cycle chat's stored copy session is cleared (`PUT /board/chats/<cycle>/session` with no session).
4. **MCP `chat_reply`** (`mcp-server/src/tools/chat.ts`): no mirror item when the chat has no copy session (the
   terminal answered itself). `chat_take`/`chat_read` unchanged.
5. **Backend** (`backend-board`): a session PUT that clears the copy (if not already possible); the chat's context
   says who answers (`answeredBy: terminal`, host, alive) for the header.
6. **Rules and skill** (`skills/_shared/rules.md` "Board chat", `skills/alfred-live/SKILL.md` "While it runs"): the
   chat-log lines to act on (`💬 chat #N …`, card comments), how to answer (CHAT_RULES' content: records, proposals,
   visuals), final answers only and short, long work in files/pages, a long skill asks once first, a decision is a
   reply then pause, a takeover starts from Alfred's memory. `CHAT_RULES` stays for the project chat runner.
7. **Frontend** (chat header, context line, ⋯ menu): "Answered by your terminal · <host>", "Terminal offline ·
   messages wait until you run /alfred-live in a terminal"; no "Terminal moved on", no catch-up / "what the terminal
   got" / "continue in a terminal" for terminal-answered cycle chats.
8. **Tests**: runner (`mcp-server/test/chat-runner.test.ts`: a cycle message becomes a chat-log line and no run; a
   card comment goes to the terminal; takeover writes the hand-over line; project chat still runs), MCP (`chat_reply`
   without mirror), backend (session clear), frontend (header states). Install the skills, restart the user's runner.
9. **Docs**: docs/board.md "Board chat", this plan's outcome.

**Phase 2 (after the core works and the user tried it):** Claude Code hooks for "Terminal A is working", the live
progress line and the permission hint (Notification / UserPromptSubmit / Stop / PostToolUse) - they change the user's
Claude Code settings, so they are installed only with the user's yes.

## Checks

- A real terminal session: quick question, a question while the terminal works (waits), a card comment, a decision in
  the middle, takeover by a second terminal, terminal closed (messages wait, nothing starts).
- Alfred stores per exchange only the message, the final answer and decisions/records (board.db rows checked).

## Outcome (2026-10-16)

Tasks 1-9 built. Tests: MCP runner/chat suites, backend-board (all), frontend chat specs (13), test_alfred_skill.
Changed beyond the plan: `ChatService.tookOver` also marks a copy replaced by the terminal session itself; the runner
writes `chat-rules.md` (the chat's rules and visuals) next to the chat log and prints it as `chatRules`, read once by
the session before its first `✉` line. Known gap: a message taken for a session that closes before answering stays
TAKEN until another session starts the cycle (`runnerStarted` queues it again). Phase 2 (hooks) not started.
