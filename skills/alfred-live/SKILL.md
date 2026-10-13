---
name: alfred-live
description: Claude answers you on the Alfred board live while you work - you comment, reply, answer or ask a question, move, close or edit a card, and within seconds the card shows Claude working (each step as it happens, the reply typing in, Stop) and the answer lands in its thread. Runs on this machine as its own background process - Alfred itself may be here or on another machine on the LAN - beside /alfred-listen or anything else, with no model running while you are idle, a warm Claude process so an answer starts at once, cards answered in parallel, and a fresh short run per change, until you stop it; each answer also shows in this chat. Use when the user says "answer me live", "stay on the board", "live sync", or "/alfred-live".
argument-hint: "[project] [cycle] [--model <name>] [--parallel n] | status | stop"
---

# Alfred live

Read `rules.md` in this skill's folder first. This skill only starts, shows and stops the live runner - the runner does
the answering (docs/mcp.md "Live answers"):

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
2. The project (and cycle) as every skill finds them: the argument, the repo's `CLAUDE.md` (`Alfred project:`), or ask.
   The Alfred MCP server name (`<server>`) as rules.md "Which Alfred" says: `alfred`, `alfred-lan-83`, ….
3. Start the runner with Bash, from this session's working folder (the app's repo):

   ```bash
   node "<this skill's folder>/alfred-live.mjs" start --server <server> --project <project> [--cycle <cycleId>] [--model <name>] [--parallel 3]
   ```

   `--model` **only when the user named one**; otherwise the runs use Claude Code's default model. It prints JSON: the
   Alfred it reaches, the log files, and `watch` (the command to follow the chat log). `alreadyRunning` → say so and
   only re-arm the watch (step 4). An error line → show it and stop: `cannot reach Alfred at …`; `does not let this
   machine edit its board` (the board's owner adds this machine to Settings → Server's edit access,
   `ALFRED_SETTINGS_EDIT_FROM`); `older than /alfred-live needs`; `already answers this board from <machine>` (one
   answerer per board - stop it there, or `--force`).
4. Watch the chat log: the Monitor tool with the returned `watch` command (`tail -n 0 -F "<chat log>"` - the runner's
   short log for this session, not its full one), description "Alfred live · <project>", `timeout_ms` 3600000.
5. Tell the user in two lines: Claude now answers on the board within seconds and shows each step on the card; stop
   with `/alfred-live stop`, pause with Pause on the board's live strip. Then go back to what the user was doing.

## While it runs (this session)

- A Monitor event is a line from the runner's chat log - only what adds to this session: a finding with its evidence,
  an answer given on the board, a failure, start and stop (each step and every quiet batch stay in the full log,
  `status` shows them). It is context for later questions in this session - **write nothing in reply to it**: no
  "still working", no restating it, no summary. Do not open cards or run tools for it; the runner already did the work.
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
