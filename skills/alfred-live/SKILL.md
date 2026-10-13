---
name: alfred-live
description: Claude answers you on the Alfred board live, as a background job - you comment, reply, answer or ask a question, move, close or edit a card, and Claude replies within seconds in the card's thread and acts on it. Runs beside /alfred-listen or any other skill, non-stop until you say stop. Use when the user says "answer me live", "stay on the board", "live sync", or "/alfred-live".
argument-hint: "[project] [cycle] | stop"
---

# Alfred live

Read `rules.md` in this skill's folder first and follow it. This skill is /alfred-sync made live: the same card
journal, the same limits - but one card at a time, the moment the user acts.

## Start (the main session)

1. `stop` as the argument → go to **Stop**.
2. The project (and cycle) as every skill finds them: the argument, the repo's `CLAUDE.md` (`Alfred project:`), or ask.
   No cycle → the whole project board.
3. Start the loop as **one background agent** - the Agent tool with `run_in_background: true`, description
   "Alfred live", and this prompt (fill in the folder this file is in, the project, the cycle and the cursor `now`):

   > You are the /alfred-live loop. Read `<this folder>/rules.md`, then the section "The loop" of
   > `<this folder>/SKILL.md`, and run it for project `<project>`, cycle `<cycle or none>`, starting at cursor
   > `<cursor>`, until you are stopped. Write nothing to the user's chat; everything you say goes on the board.

4. Tell the user in two lines: Claude now answers on the board within seconds; stop it with `/alfred-live stop` (or
   say "stop live"), pause it with Pause on the board's live strip. Then go back to what the user was doing - listen,
   fix, anything runs beside it.
5. When the background agent ends with `RESTART <cursor>`, start a fresh one the same way with that cursor (a fresh
   agent stays fast). When it ends any other way, tell the user in one line that live answers stopped and why.

## The loop (the background agent)

Once, before the first wait: `task_context` on the cycle (when there is one) - the brief, requirements and decisions
you answer against - and `board_closed_reasons` for the project. Do not read them again unless `board_live` says the
brief changed.

Then, every turn:

1. **Wait** - `board_live` with `project`, `cycleId`, `cursor`. It returns when the user does something (or after
   50 s with nothing). `nothing` → call it again at once with the returned cursor; write nothing, think nothing.
   `paused: true` → answer nothing; call again.
2. **Answer each card, fastest first** - a question to you, then an answer to your question, then a reply, then the
   rest. `board_live` already gives the thread with its `[indexes]`, the open questions and what each change asks for
   (`userDid`) - do not `board_get` a card it gave you. Answer in **one call** when you can:
   - The user **asks** you something → `board_reply` with `replyTo` the comment's index: the answer in 1-3 sentences.
     When the answer needs evidence (a call, a log line, the code), first `board_reply` one line ("Checking the
     confirm call - back in a minute"), look it up in at most three calls, then `board_reply` the finding with its
     mention (`@[call:…]`).
   - The user **answers your question** → `board_reply` in that thread with what it changes ("Got it - fare may
     change; I'm turning this into a bug: the price change is not shown"), then do it within the rules: your own Inbox
     card → `board_edit` its kind / description; a "must" about something already seen → `board_add` the BUG with
     the calls; a `Learn:` answer → a check line you propose at the end (rules "Learning"); still unclear →
     `board_ask` once.
   - The user **replies** to your comment → answer in that thread, or say what you will do.
   - The user **dismisses a proposal** → one state comment (`board_comment`): what you will do instead.
   - **Moves, closes, flags, edits** → nothing unless `userDid` says to answer; never thank or confirm a move.
     Moved to Fixed with no re-test steps → `board_retest_plan`.
   - A **brief or decision change** (`cycleChanges`) → `task_context` again; tell nobody unless it changes an open card.
3. Every reply is short, plain and in the user's language. Say what you did, never what you are about to think.
4. Back to 1 with the returned `cursor`. `alsoChanged` cards: `board_get` each and answer after the others.

Speed rules: one tool call per reply when you can; never re-read rules or cards you already have; no summary between
turns; keep only the cursor and the open threads in mind, never the tool output. The board's limits stay: you never
move cards to To do for the user, close, mark the checklist or set scope - propose (`board_propose`,
`board_suggest_mark`).

After about 150 turns, or when the conversation feels long: `board_session_log` (did: answered N cards; found: what
changed; next: still open), then end with exactly `RESTART <cursor>` - the main session starts a fresh agent there.

## Stop (the main session)

`/alfred-live stop` or "stop live": stop the background agent (TaskStop), `board_live_stop` for the project, and
`board_session_log` on the cycle if the agent did not write one. Check lines the answers gave: one before / after of the
repo's `## Alfred checks` (rules "Project checks"), saved only on yes. Say in one line how many cards were answered.

## With other skills

- `/alfred-listen` in the same session or another one on this machine: its `board_wait` says `/alfred-live is
  answering the user` - listen then leaves the user's changes to this skill and keeps checking calls.
- `/alfred-sync` while live runs is not needed; run it after stopping to catch up on anything said while it was off.
