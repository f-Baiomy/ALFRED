---
name: alfred-live
description: Claude answers you on the Alfred board live while you work - you comment, reply, answer or ask a question, move, close or edit a card, and within seconds the card shows Claude working (each step as it happens, the reply typing in, Stop) and the answer lands in its thread. Runs on this machine as its own background process - Alfred itself may be here or on another machine on the LAN - beside /alfred-listen or anything else, with no model running while you are idle, a warm Claude process so an answer starts at once, cards answered in parallel, and a fresh short run per change, until you stop it; each answer also shows in this chat. Use when the user says "answer me live", "stay on the board", "live sync", or "/alfred-live".
argument-hint: "[project] [AB#1234 | board name or id | cycle] [--model <name>] [--parallel n] | status | stop"
---

# Alfred live

Read `rules.md` in this skill's folder first. This skill only starts, shows and stops the live runner - the runner does
the answering (docs/mcp.md "Live answers"):

**Boards** (specs/030): the task may be named as `AB#1234`, its name or its id (rules §0 "Naming a board") - `task_context` resolves it; the runner takes the cycle id `task_context` gives. A bare `#n` is a card.

**Board sessions** (specs/031, specs/032): the board's **Claude button** (▶ Start Claude) does all of this for the user -
their Alfred helper starts the board's session on their PC and this runner with it; the button then says **● Claude on**,
and its panel has **⏸ Pause Claude** (stops this runner, keeps the session - ▶ Resume Claude continues it) and **↩ Hand
the board back** (a Handover note card, then stop and release). Started from a terminal instead, the button says
**● Claude on · terminal** and tells the user to stop it with `/alfred-live stop`. With Claude Desktop (the default), ▶
Start Claude opens a **Desktop chat** in the board's folder whose first message asks it to read the task and run this
skill - that chat is the board's session and answers everything here, visibly. **⏸ Pause** from the board stops only
the runner: keep the Monitor watch on (no reply), because ▶ Resume starts the runner again on the same chat log. A board another user holds refuses
writes (HELD, with who holds it): say so and that the user can ask for it from the 🔒 button - never retry.

- The runner is `alfred-live.mjs` in this skill's folder. It runs **on this machine**, beside this session, the app's
  repo and Claude Code - whether Alfred runs here, in Docker, or on another machine (`alfred-lan-83` →
  `http://192.168.1.83:3000`). It reaches Alfred over HTTP; a local Alfred MCP server is started once by the runner and
  shared by every run (a LAN Alfred's `/mcp` is used as it is).
- It waits on the board with **no model running**, but keeps `claude` processes warm, so a change is answered the
  moment it arrives. Each change the user makes gets **one fresh, short Claude run** that sees only that card's recent
  thread and the change - no conversation grows. Cards are answered in parallel (`--parallel`, default 3); a card
  waiting for a slot shows "waiting its turn" and can be stopped.
- While a run works, the card shows it: "✦ Claude is acting on your answer", each step as it happens ("checking call
  #3", "reading OrderMapper.java:58", "→ will turn #12 into a BUG"), the reply typing in, and Stop (read within a
  second). The board's live strip shows the same, with the machine answering. Moves to To do, closes, flags and team
  changes are only noted.
- A run that fails is tried again (a usage limit waits 10 minutes); a run that answers in its own text instead of on
  the board is told to post it; a reply the board refuses is reported. Pause on the live strip holds the changes until
  the resume - nothing is skipped.
- Every event is a line in the runner's full log; only the answers, failures, start and stop go to its chat log,
  which this session watches.

## Start

1. `stop` or `status` as the argument → go to that section.
2. The project (and board) as every skill finds them: the argument, the repo's `CLAUDE.md` (`Alfred project:`), or ask.
   A board is a task (`board_boards` lists them); a cycle id given instead resolves to its board, as the board tools do.
   The Alfred MCP server name (`<server>`) as rules.md "Which Alfred" says: `alfred`, `alfred-lan-83`, ….
3. Start the runner with Bash, from this session's working folder (the app's repo):

   ```bash
   node "<this skill's folder>/alfred-live.mjs" start --server <server> --project <project> [--cycle <boardId>] [--model <name>] [--parallel 3]
   ```

   `--model` **only when the user named one**; otherwise the runs use Claude Code's default model. With `--cycle <boardId>`, this
   chat handles that board (specs/027: the flag kept its name; it takes the board id): every ▶ on its cards and every comment that needs an investigation comes into this chat
   (see "While it runs"); `--no-board-runs` when the user wants answers only. It prints JSON: the
   Alfred it reaches, the log files, and `watch` (the command to follow the chat log). `alreadyRunning` → say so and
   only re-arm the watch (step 4). An error line → show it and stop: `cannot reach Alfred at …`; `does not let this
   machine edit its board` (the board's owner adds this machine to Settings → Server's edit access,
   `ALFRED_SETTINGS_EDIT_FROM`); `older than /alfred-live needs`; `already answers this board from <machine>` (one
   answerer per board - stop it there, or `--force`); `This board already runs in a chat on <machine>` (one chat per
   board - the user stops it in that chat first). Without `--cycle`, the runner also answers every board chat of the
   project that no terminal holds.
4. Watch the chat log: the Monitor tool with the returned `watch` command (`tail -n 0 -F "<chat log>"` - the runner's
   short log for this session, not its full one), description "Alfred live · <project>", `timeout_ms` 3600000.
5. Tell the user in two lines: Claude now answers on the board within seconds and shows each step on the card; stop
   with `/alfred-live stop`, pause with Pause on the board's live strip. Then go back to what the user was doing.

## While it runs (this session)

- A Monitor event is a line from the runner's chat log (except the two kinds below) - only what adds to this session: a finding with its evidence,
  an answer given on the board, a failure, start and stop (each step and every quiet batch stay in the full log,
  `status` shows them). It is context for later questions in this session - **write nothing in reply to it**: no
  "still working", no restating it, no summary. Do not open cards or run tools for it; the runner already did the work.
- **Two kinds of line are for you to act on** (docs/board.md "Run from the board") - this chat handles the cycle, so
  the board sends its work here:
  - `▶ from the board: /alfred-fix 35 · note: … · run <id> - …` - the user pressed ▶. When your current turn is free:
    `board_run_take <id>` (it returns the full prompt and the user's note; `cancelled` → skip it), run that command here
    exactly as if the user had typed it (the skill, with this chat's context - the note is the user's instruction for
    it), then `board_run_end <id>` with one `outcome` line ("→ plan posted on #35") and `result` (`#35`, `#35 [16]`)
    - `done: false` with the reason if it failed. Several lines → one after another, in order.
  - `💬 #35 "…" · you commented: "…" - …` - a comment that needs an investigation (a card outside this cycle):
    investigate with what this chat knows (the code, the calls, the logs) and answer on the card (`board_get 35`, then
    `board_reply`).
- **This session answers the cycle's board chat and the comments on its cards itself** - no copy, no fork
  (rules.md "Board chat"). Before the first such line, read the `chatRules` file the start printed, once.
  - `✉ board chat #N ⚡?: "…" - …` - a chat message for you. When your turn is free (⚡ first): `chat_read` with the
    line's `project`/`scope`/`id` for its thread when you need it, do the work here, then **one** `chat_reply`.
  - `✉ #35 "…" · you commented: "…" - …` - a comment on a card of this cycle: `board_get 35`, then `board_reply`.
  - **Final answers only**: what you did between them (tool calls, steps, drafts) stays in this session - Alfred keeps
    the user's messages, your final answers, the questions or proposals that need the user, and records. Short: the
    finding first; long output (a plan, a report) goes to a file or a board page and the answer links it.
  - A long job (a skill like /speckit-plan, a big fix) - ask once in the reply first ("Run it here? ~20 min"), unless
    the message already asked for it. A decision you need mid-task → a reply that asks it (or `board_ask` on a card),
    then pause that job: the answer comes back as a new `✉` line.
  - "open a board for AB#1234" / "open a new board <name>", or a `/alfred-setup <conn>/<id>` message (the user's Start
    button): open it as rules.md "Board chat" says - `askedIn` = that message, the new board related back to this chat's
    board, never a second board for one item, and "not in the cache yet: Refresh the Team tab first" when it is missing.
  - `↪ handed over: …` - another terminal session answers the cycle now: stop the Monitor watch, answer nothing more.
  - After starting in a cycle that already has a chat: read the chat's summary and the brief (`chat_read`,
    `get_brief`) before the first answer - they are what this session did not see.
- **Other board-chat lines** (the project chat, or an older Alfred): `⚡ board chat: …` - act on it before your next
  step, or tell the user why not; `💬 board chat: …`, `↻`, `↳` - context only, write nothing.
- The watch expires after an hour: re-arm it with the same command, nothing else. A line starting `⚠` that repeats
  (the runner cannot reach Alfred or Claude) → tell the user once, with the line.
- The user asks something about a live answer → answer from the board (`board_get`), not from the log.

## status

`node "<this skill's folder>/alfred-live.mjs" status --server <server> --project <project>`: running or not, since
when, the model, and the last lines of the log - show them.

## stop

`node "<this skill's folder>/alfred-live.mjs" stop --server <server> --project <project>`, then stop the Monitor watch
(TaskStop). Say in one line how many cards it answered (count the `→ ✦` lines in its last lines, or "see the board").
Check lines the user's answers gave are proposed by `/alfred-sync` - offer it.

## With other skills

- `/alfred-listen` in any session, on any machine: its board changes say `/alfred-live is answering the user (from
  <machine>)` - the runner's heartbeat is in Alfred. Listen's own live lane stands down while this runner answers,
  and takes over when it stops.
- One runner per board: a second `start` on this machine only re-arms the watch; on another machine it is refused.

## Team tracker in the chat (specs/028)

"What's on me in Azure", "find the refund bugs": `team_search` (mine, text, filters) and answer with mentions. "Comment
on AB#1234 …", "resolve it": `team_comment` / `team_move_state` - a bundle that waits for the user; reply that it is
waiting on the card or board, never that it was sent. "Link this card to AB#…" asked in the message: `team_link_card`
with `askedIn` = that message. "Open a board for AB#…": rules §4.
