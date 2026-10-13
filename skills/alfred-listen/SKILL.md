---
name: alfred-listen
description: Listen to an Alfred session cycle live while the user tests - check every new call (HTTP, ERROR/WARN logs, SQL, supplier calls, Redis, values that drift between the steps of a flow) against the cycle's spec in batches, open cards with evidence and a first state comment, tick the test steps, and answer the user's comments on the board as they come. Runs on this machine as its own background process - Alfred may be here or on another machine on the LAN - with no model running while calls are clean, warm Claude processes so a flagged batch is judged at once, several batches judged in parallel, nothing lost when a run fails; each finding shows in this chat. Use when the user says "listen to cycle X", "watch while I test", or "/alfred-listen".
argument-hint: "<cycle> [--model <name>] [--parallel n] [--dry] [--finish] | status | stop [--now]"
---

# Alfred listen

Read `rules.md` in this skill's folder first. This skill starts, shows and stops the **listen runner** - the runner
does the listening (docs/mcp.md "Listen runner"):

- The runner is `alfred-listen.mjs` in this skill's folder (it uses `/alfred-live`'s runner code, installed beside it).
  It runs **on this machine**, beside this session and the app's repo, whether Alfred runs here, in Docker or on
  another machine (`alfred-lan-83`). A local Alfred MCP server is started once by the runner and shared by every run.
- It holds one connection to the Alfred MCP server and calls `check_calls` itself - waiting for the user's next burst
  of calls with **no model running**. A batch that is all clean ends there: counts on the board's live strip, nothing
  in this chat. A group it already judged (its card still open, or a verdict marked recurring) is linked in code.
- A batch with new flagged groups becomes a judge job: **one fresh Claude run on a warm process** (`batch.md`) that
  judges the batch exactly as `/alfred-review` would - cards with evidence, links, step marks, the ledger, `Learn:`
  questions - given a context pack the runner keeps (the task, Acceptance items with full keys, teams, closed cards,
  the cards already on the board, the task branch's diff, what earlier runs learned). Up to `--parallel` runs (3) at
  once; a run that fails stays queued and is tried again; a group a run leaves without an outcome gets a second look.
  **A cycle listened to and then reviewed gives no new cards.**
- The user's comments on cards are answered within seconds by the runner's live lane (the same answers `/alfred-live`
  gives), unless a real `/alfred-live` runs - then it leaves them to it. Answers to `Learn:` questions reach the next
  judge run.
- Stop drains the queue, sweeps, runs a whole-cycle pass for what has no outcome, then three finish runs in parallel
  (`finish-sweep.md`, `finish-steps.md`, `finish-regressions.md`: steps, Acceptance marks, requirements, unsure
  expectations, regressions, shape regressions, logging gaps) and the annotations and session log in code. Every
  phase is recorded; an interrupted finish resumes with `--finish`.
- Every event is a line in the runner's full log; only each judged batch's findings (with their evidence), the live
  lane's answers, failures, start and stop go to its chat log, which this session watches. A clean batch adds nothing.

## Start

1. `status` or `stop` as the argument → go to that section.
2. The cycle (`list_cycles` by name) and the Alfred MCP server name (`<server>`) as rules.md "Which Alfred" says.
   `get_cycle` with `limit: 1`: its id, its project and whether it is recording - if not, tell the user to press
   Record (listening still works; it waits for calls).
3. **Steps need spacers.** Listening matches calls to the brief's steps by the user's spacers. Ask once: "Add a spacer
   in the cycle before each test step - or I group them by endpoint and show you the grouping at the end."
4. Start the runner with Bash, from this session's working folder (the app's repo):

   ```bash
   node "<this skill's folder>/alfred-listen.mjs" start --server <server> --cycle <cycle id> --project <project> [--model <name>] [--parallel 3] [--dry] [--finish]
   ```

   `--model` **only when the user named one**. `--dry`: the runs list what they would write and write nothing.
   `--finish`: the listening ended without Stop (interrupted, closed) - the runner only finishes what is left.
   It prints JSON with the log files and `watch`. `alreadyRunning` → only re-arm the watch. An error line (`cannot
   reach Alfred at …`) → show it and stop.
5. Watch the chat log: the Monitor tool with the returned `watch` command (`tail -n 0 -F "<chat log>"` - the
   runner's short log for this session), description "Alfred listen · <cycle>", `timeout_ms` 3600000.
6. Tell the user in two lines what is checked (the Acceptance items, the project checks, the test steps), that clean
   calls cost no model and the board answers their comments, and how to stop (`/alfred-listen stop`, or Pause on the
   live strip). Then go back to what the user was doing.

## While it runs (this session)

- A Monitor event is a line from the runner's chat log - only what adds to this session: a finding with its evidence,
  an answer given on the board, a failure, start and stop (each step and every quiet batch stay in the full log,
  `status` shows them). It is context for later questions in this session - **write nothing in reply to it**: no
  "still working", no restating it, no summary. Do not open cards or run tools for it; the runner already did the work.
- The watch expires after an hour: re-arm it with the same command, nothing else. A `⚠` line that repeats (the runner
  cannot reach Alfred, the MCP server or Claude; a usage limit) → tell the user once, with the line.
- The user asks about a finding → answer from the board (`board_get`), not from the log.

## status

`node "<this skill's folder>/alfred-listen.mjs" status --server <server> --cycle <cycle id>`: running or not, since
when, the counts (batches, calls, cards, batches still queued) and the last lines of the log - show them.

## stop

`node "<this skill's folder>/alfred-listen.mjs" stop --server <server> --cycle <cycle id>`: the runner finishes its
current wait (up to a minute), judges what is queued, sweeps and runs the finish phases, then ends - keep the watch
until the log says `● Listen stopped` (or `⚠ Finish incomplete`: then `/alfred-listen <cycle> --finish` resumes
it), then stop the watch (TaskStop) and give the user the finish line and: "Sort the Inbox: `/alfred-triage`".
`stop --now` ends at once without the finish (`--finish` runs it later; nothing queued is lost).
