---
name: alfred-live
description: Claude answers you on the Alfred board live while you work - you comment, reply, answer or ask a question, move, close or edit a card, and within seconds the card shows Claude working (each step as it happens, the reply typing in, Stop) and the answer lands in its thread. Runs as its own background process beside /alfred-listen or anything else, with no model running while you are idle and a fresh short run per change, until you stop it; each event also shows in this chat. Use when the user says "answer me live", "stay on the board", "live sync", or "/alfred-live".
argument-hint: "[project] [cycle] [--model <name>] | status | stop"
---

# Alfred live

Read `rules.md` in this skill's folder first. This skill only starts, shows and stops the live runner - the runner does
the answering (docs/mcp.md "Live answers"):

- It waits on the board with **no model running**. Each change the user makes gets **one fresh, short Claude run** that
  sees only that card and the change - no conversation grows, however long it runs.
- While a run works, the card shows it: "✦ Claude is acting on your answer", each step as it happens ("checking call
  #3", "reading OrderMapper.java:58", "→ will turn #12 into a BUG"), the reply typing in, and Stop. The board's live
  strip shows the same. Moves to To do, closes, flags and team changes are only noted, without a run.
- Every event is one line in the runner's log; this session shows them as they come.

## Start

1. `stop` or `status` as the argument → go to that section.
2. The project (and cycle) as every skill finds them: the argument, the repo's `CLAUDE.md` (`Alfred project:`), or ask.
3. `live_start` with `project`, `cycleId` (when one was named), `cwd` = this session's working folder (the app's repo -
   `pwd`), and `model` **only when the user named one** (`--model sonnet`); otherwise the runs use Claude Code's
   default model. It returns the log file and the command to watch it. Already running → say so and only re-arm the
   watch (step 4).
4. Watch the log so each event shows here: the Monitor tool with the returned `watch` command
   (`tail -n 0 -F "<log>"`), description "Alfred live · <project>", `timeout_ms` 3600000.
5. Tell the user in two lines: Claude now answers on the board within seconds and shows each step on the card; stop
   with `/alfred-live stop`, pause with Pause on the board's live strip. Then go back to what the user was doing.

## While it runs (this session)

- A Monitor event is the runner's log line - your chat shows it; **do nothing about it**: do not answer it, do not open
  the card, do not run tools. The runner already did the work on the board.
- The watch expires after an hour: re-arm it with the same command, nothing else. A line starting `⚠` that repeats
  (the runner cannot reach Alfred or Claude) → tell the user once, with the line.
- The user asks something about a live answer → answer from the board (`board_get`), not from the log.

## status

`live_status` for the project: running or not, since when, the model, and the last lines of the log - show them.

## stop

`live_stop` for the project, then stop the Monitor watch (TaskStop). Say in one line how many cards it answered (count
the `→ ✦` lines in `live_status`'s last lines, or "see the board"). Check lines the user's answers gave are proposed
by `/alfred-sync` - offer it.

## With other skills

- `/alfred-listen` in this or another session on this machine: its board changes say `/alfred-live is answering the
  user` - listen then leaves the user's changes to the runner and keeps checking calls.
- One runner per project and Alfred: `live_start` again only re-arms the watch.
