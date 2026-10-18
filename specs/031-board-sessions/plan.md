# 031 - One Claude session per board

Status: built on branch `031-board-sessions` (2026-10-18). Mock: [mock.html](mock.html) (23 steps).

What landed: `backend-sessions` (keys, pairing, holders, requests, hand-over, away rule, commenters' queue, sessions,
helper commands, My settings, audit) with the lock in `boardbridge` (`BoardLockInterceptor`, `BoardWriteTargets`); the
Azure token per user (`TokenVault` + `TeamCallerPort`, `PUT /teamboards/me/token`); the MCP server, its relay and the
live runner passing `X-Alfred-Key`; `helper/alfred-helper.mjs` (`alfred helper`); the frontend ▶ alfred-live button,
the held banner, the chat's lock and commenters' queue, one-click start from a ▶ run, 👤 Me (My settings).
**Connect this PC** (2026-10-18): nobody installs or updates anything by hand. One downloaded file (`POST /board/connect`,
one-time token, never in a URL) fetches the helper and node.exe from Alfred, registers the PC as its Claude account,
pairs the browser that downloaded it (collected on the /ws/sessions signal), installs the skills and the MCP server
(with the user's key), and the helper keeps both current from the heartbeat's `versions`. The first ▶ for a project
opens a folder picker on the PC; ▶ menu ▸ Restart Claude Desktop shows new sessions. docs/server.md "Connect this PC".
Not built: moving a transcript between PCs (refused with "continue from Alfred's copy"); toasts for questions, drafts
and listen findings (requests, starts, failures and the budget toast are built); a per-board budget (the budget is per
user per day).

## Goal

Every board (and the project chat) gets its own Claude Code session, started from a button in Alfred, visible in
Claude Desktop and resumable from a terminal, attached to the board until the user releases it. Only the session's
owner can write on a held board. Works the same when Alfred runs on another machine on the LAN: Claude always runs on
the user's own PC.

This replaces the rule "Alfred never starts or resumes a session itself" with "Alfred starts or resumes a session only
when the user presses a button for it".

## What we know (2026-10-17, this PC)

- A Claude Desktop Code session is a JSON record at
  `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<uuid>.json`. Its `cliSessionId` points at the normal
  Claude Code transcript `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`.
- One folder pair per account/org - this tells "other account" apart from "other PC".
- Headless sessions (`claude -p`, the runner's forks) never appear in the Desktop sidebar.
- `claude://claude.ai/epitaxy/local_<uuid>` opens an existing Desktop session.
- The Desktop record format is private and undocumented. Writing it is the only way found to show a CLI session in
  Desktop; a Desktop update may break it.

## S1 result (2026-10-17): pass, after a Desktop restart

- Headless session `claude -p --session-id 4a2f4a52-…` plus a hand-written record in the shape the official `/desktop`
  command writes (`sessionId` = `local_<cliSessionId>`, `adoptedFromOtherSurface: true`, title, cwd, model) showed in
  the Desktop sidebar after Desktop was restarted.
- The running Desktop does not see a new record (`get_session` said not found until restart). So: Alfred asks before
  restarting Desktop, batches new sessions into one restart, or offers the `/desktop` path (terminal `claude --resume
  <id>` then `/desktop`) which adopts without a restart.
- Test file to remove after S2/S3: `local_4a2f4a52-2f23-45c1-bc5c-f4c1f5a606ed.json` in the current account folder.
- **One writer at a time** (replaces the S2 fallback): while a session is open in Desktop or a terminal, that session
  answers jobs itself through `/alfred-live` + Monitor (today's "Answered by your terminal"); the helper runs headless
  `--resume` turns only while nothing has it open.

## S2/S3 result (2026-10-18): two writers fork the session - one writer at a time is required

- Desktop turn D1 (session running in Desktop), then a helper turn `claude -p --resume <id>` → H1, appended in line on
  the same session id (`-p --resume` does not fork by itself).
- Next Desktop turn: Desktop did not know H1 ("S1 … / Hey … / D1") and wrote its turn under the message before H1:
  the transcript forked (`fd61b4e6` → H1 branch and Desktop branch). H1 is on a branch Desktop never shows.
- So a running Desktop session neither sees nor survives turns written by another process (S3 answered too). The
  one-writer rule above is a requirement: while the session runs in Desktop or a terminal, jobs go to that session
  (`/alfred-live` + Monitor, or the app's own message delivery); headless `--resume` turns only while it is not running.
- **Folder trust**: Desktop refuses to run a session in a folder it has not trusted ("Workspace requires trust approval
  before starting a session."). Alfred never writes trust itself; each folder in My settings is trusted once, by the
  user, the first time a session opens there. Open: does trusting a repo cover its `.alfred-worktrees` folders?
- Desktop groups sidebar rows by folder name, so worktree folders get readable names (`AB61813-seat-map`).

## Spikes first (each can change the design)

| # | Question | Pass | If it fails |
|---|----------|------|-------------|
| S1 | Does a hand-written Desktop record for a `claude -p --session-id X` session show in Desktop and continue there? | Shows (maybe after restart), continues with full history | No Desktop view; terminal only (`claude --resume`) |
| S2 | Can the helper run `claude -p --resume X` turns while X is open in Desktop or a terminal without breaking the transcript? | Transcript stays linear | One writer at a time: helper waits while Desktop/terminal is mid-turn (fs.watch on the transcript) |
| S3 | Does an open Desktop session show turns the helper added? | Shows live or on refocus | Show "reopen to see new turns" in Desktop's row |

## Concepts

- **Board session**: a Claude Code session tied to one board (or to the project chat). Many per board over time; one
  is the board's current one.
- **Helper**: the user's long-running local process (today's `skills/alfred-live/chat.mjs` + listen runner, merged).
  Connects OUT to Alfred, claims jobs addressed to its PC, runs `claude` locally. Alfred never reaches into the PC.
- **Job**: anything that needs Claude - chat turn, comment, ask, skill run, setup, listen, compact.
- **Holder**: the helper (user + PC) that holds a board. Only the holder writes on it.

## Routing (mock step 12)

| Job | Goes to |
|-----|---------|
| Board chat message, card comment, ✦ ask on a board | board session |
| Project chat, off-board ask, Team Incoming sort | project session |
| Define / Start from Azure (`/alfred-setup`) | board session, created if none |
| ▶ verify / fix / sync / triage / review / spec / report / resume | board session, queued (`skill_runs`), one at a time, ⚡ first |
| `/alfred-listen` | background lane on the board session's PC; judges in forks, never types into the session |
| Chat compact | that chat's session |
| Requirement verdicts, re-test checks | no Claude (backend code) |

A job on a board with no session opens "This needs Claude" (step 9): start a session and run, send to the project
session, or keep waiting.

## Phases

### Phase 0 - spikes S1-S3
Script in `scratchpad`, report on this PC. No product code.

### Phase 1 - registry and holder (backend-board)
- `board_sessions` (board.db): id, boardId or `project:<p>`, cliSessionId, desktopId, machineId, accountHash, cwd
  (worktree), state (STARTING/ANSWERING/IDLE/WAITING_BUDGET/WAITING_LIMIT/STOPPED/GONE), lastChatSeq, tokensToday,
  created/lastActive.
- `board_holders`: boardId, holderKeyId, sessionId, since, awayRule. No new enum values on existing types (older Alfreds
  throw on unknown ones).
- `helper_keys`: keyId, hash, user email, machine name, created, last seen; `browser_keys`: keyId, helper keyId,
  user-agent, paired at.
- REST `/board/sessions`, `/board/holders` (take, request, hand over, release, force release), `/board/helpers`
  (heartbeat, pair). WebSocket signal on change; no polling.
- Lock check once, in the board write gate next to `BoardEditAccess`: a held board refuses every write (chat, comment,
  card, brief, spec, run, ask, MCP) without the holder's key or a paired browser key of that holder. Unheld board =
  today's behaviour. Force release only from the server's own machine. Tunnel stays read only.
- Audit (10): every board write records holder, PC, session/browser.
- Job queue: `skill_runs` gains a target machine; claim returns only the claiming helper's jobs.
- Gateway regex + `SpaPageFilter` for any new prefix (none planned; all under `/board`).

### Phase 2 - helper
- `alfred helper install` (key, autostart, `alfred-helper://` protocol handler), `alfred helper pair` (6-digit code, 2
  min), tray icon.
- Heartbeat: machine, Claude account/org, IP, Desktop present, project→folder map, version.
- Start: create worktree (1) `<repo>/.alfred-worktrees/<board>` on the board branch; `claude -p --session-id <uuid>`
  with `/alfred-live <board>`; write the Desktop record (S1); report ids.
- Turns: `claude -p --resume <id>` per job with the job's model (5) and `--permission-mode`/`--allowedTools` (2):
  chat/ask/listen read only; setup/triage/review read + board writes; verify + run tests; fix edits inside the worktree.
- One writer at a time (S2). Budget (3): count tokens per turn, stop claiming at the budget, report usage-limit resets.
- Open in Desktop (`claude://` link), open in terminal (`claude --resume`), Stop all (9), Windows toasts (8).
- Listen lane: today's listen runner, started/stopped by job, findings as one line in the session.
- Bring transcript from another PC: helper-to-helper through Alfred, user approves each time (transcripts can hold
  secrets).

### Phase 3 - frontend
- ▶ alfred-live split button with states (steps 1-5, 11, 18).
- Sessions list per project (8, 18), Routing (12), This PC (13), session settings per board (17).
- Dialogs: not found (6), sync (7), needs Claude (9), Start from Azure (10), locked + ask (14), request (15), pair
  (16), commenter approval (20), Stop all (21).
- View only when the board is held by someone else.

### Phase 4 - continuity
- Not found here (6): continue from Alfred's copy (new session seeded from chat summary, records, brief via
  `ChatTransfer`), pick another session, enter an id, bring the transcript.
- Sync on return (7): feed missed chat messages as one turn (today's catch-up delta).
- Handover note (4, step 19): on hand over / release the session writes state + NEXT to the brief; the next holder's
  first turn is `/alfred-resume`.
- Away rule (6): offline over N hours → accept next request / release / nothing.
- Commenters (7): named helpers may chat/comment; each message waits for the holder's OK before Claude answers.

### Phase 4b - My settings, per user (mock steps 22-23)
- A **user** is the identity behind a helper key (Claude account email) plus the browsers paired to it. Settings
  follow the user, not the browser: every paired browser on every PC shows the same page.
- `GET/PUT /board/me/settings` answers only for the caller's own key. No endpoint lists or reads another user's
  settings - not even for the admin, who can only revoke a helper (Settings ▸ Users: name, PCs, last seen).
- Stored on the server (`user_settings` in board.db, keyed by user): per PC project → repo folder, worktree root,
  "open sessions in" (Desktop / Terminal / Both / Background only); models per job; daily budget; max sessions per PC;
  away rule; notification choices.
- **Azure PAT per user, never on the server's disk.** Today's rule (one shared token, 8 h in `TokenVault` memory,
  last entered wins) becomes: the token is kept on the user's PC by the helper, encrypted with Windows DPAPI (current
  user), and handed to Alfred's memory while the helper is online, keyed by user. Searches and consent bundles use the
  caller's own token; `TOKEN_MISSING` names whose token is missing. Tunnel rule unchanged. Needs docs/team.md and
  CLAUDE.md updated - it changes "everyone reads with the last token entered".
- "Pick folder" runs a folder picker on that PC through its helper; the server never browses a PC.

### Phase 5 - docs and skills
- CLAUDE.md, docs/board.md "Board chat", docs/server.md (helper), docs/mcp.md (holder header), skills
  `alfred-live`/`alfred-listen`/`alfred-setup`/`alfred-guide` and `skills/_shared/rules.md`.

## Security notes

- Alfred only queues jobs; the helper decides what runs. A job is a known skill or a chat turn for a board the helper
  serves - never a raw command line.
- Keys are never logged or returned; MCP sends the helper key in a header.
- On a LAN over plain HTTP a sniffer can copy a key. HTTPS for the LAN Alfred is the fix; offered, not required.
- Alfred stores no transcripts. The handover note and chat summary carry what another session needs.

## Open questions

- Desktop sidebar grouping ("Alfred · odeysys") - does the record have a group field? (part of S1)
- Worktree cleanup when a board closes: keep, ask, or delete after merge?
- Budget unit: tokens or money?
