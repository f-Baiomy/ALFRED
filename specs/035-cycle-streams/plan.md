# specs/035 - Streams: another Alfred's cycles and boards, live, without copies

Mock: `mock.html`. Status: design agreed (grilling, 2026-10-19), not started.

## The problem

A task is tested in more than one place. Some cycles of a task are recorded on this PC (calls, SQL, log lines, Redis
commands); others on 192.168.1.83. Today the only way to see both together is to export one side, import it on the
other and set the board up again - a stale copy the moment it lands, and the history, acceptance items and test steps
re-entered by hand. Opening the other Alfred in a browser does not help: it shows everything there, not this task, and
its cycles cannot be asked about from this board's chat.

## The idea

Each Alfred keeps its own data. A **stream** lets another Alfred read one of its cycles or boards **live**, put it next
to its own with a label saying where it lives, and - when the stream's mode allows - ask for changes, which the owner
approves. **Nothing streamed is stored on the reading Alfred.**

## Decisions

**Links**

- **D1 A link joins two Alfreds.** On one, Settings → Links → Link an Alfred, with the other's address. The other shows
  a one-time code; anyone using it accepts (Alfred has no users - see D4). Either side can remove the link; every stream
  on it ends.
- **D2 The reader names the link.** Each side picks its own name for the other ("83", "QA server", "PC-1"), editable.
  That name is the origin chip (`⇇ 83`) and the tag in a remote ref (`<uuid>@83`).
- **D3 One connection per link, opened by the side that can reach the other** (the PC dials the LAN server, as the
  helper does). It carries everything in both directions: reads, live signals, requests. LAN only - the Cloudflare
  tunnel never carries a link.
- **D4 An Alfred is the actor, never a person.** Popups, history and audit say "83", or "83 (Claude)" when the other
  Alfred's Claude asked. The specs/031 user keys are not used across a link.

**Streams**

- **D5 Two kinds**, both in v1:
  - **cycle stream** - one cycle, every call (also those recorded after the stream starts), with its SQL, log lines and
    Redis commands;
  - **board stream** - a whole task: cards and their activity, brief and brief comments, spec files, requirements, test
    steps, pages and images, the Azure copies the board holds (read-only, D16), the board chat (read-only, D15), and its
    cycles.
- **D6 Anyone using the owning Alfred may start, change or stop a stream** (cycle ⋯ / board ⋯ → Stream, and Settings →
  Links lists them all).
- **D7 Modes**: `view` (read) and `comment` (+ comments on cards, questions, brief comments, notes on the owner's
  calls). Changed or stopped live. There is no edit mode: **the board's host is the only one who works the board** -
  creates cards, moves their states, edits them, closes and deletes them, edits the brief, specs, acceptance items and
  test steps, runs `/alfred-listen`, `/alfred-triage`, `/alfred-verify` and the rest. A receiver never does any of it,
  not even as a request - except an environment Alfred's own column (D36).
- **D8 Pass-through.** A board stream carries the board's cycles from other Alfreds only when their owner switched
  **allow passing on** for that stream (off by default), and that owner sets the mode re-shared readers get - alone,
  not capped by the middle Alfred's mode. Without it the reader sees the cycle's name and "⇇ 90 - not shared here". A
  write from the far reader goes to that cycle's owner. The owner sees who reads through whom ("83 via PC-1"). At most
  3 hops; a loop is refused.
- **D9 Never through a stream**: Azure in any form (live reads, bundles, the token), settings, recording (start, pause,
  stop), capture switches (▤ ◆ ⬢, log level), interception rules, exports and files outside the board, Relive and
  resend, the owner's Claude, runner or chat input, and anything not in the stream. Checked by the owner on every
  request, not by any prompt.

**Requests and approval**

- **D10 Every write from the reader is a request** - a comment, question, brief comment or call note - applied and
  stored by the owner once accepted.
- **D11 The popup shows in every open tab of the owner's Alfred**: who, what, old → new, Approve / Reject with a reason.
  The first answer wins and the other tabs close theirs. With no tab open, requests wait in the tray; the tab title
  shows `⇄3`.
- **D12 Auto-accept per stream**: `off` (every request asks) or `on` (every request goes in at once). Every
  auto-accepted request is recorded and can be undone.
- **D13 A request waits until answered.** The reader sees "waiting for PC-1" and can withdraw it. Ending a stream
  rejects what still waits.
- **D14 Owner offline**: the reader still reads nothing (D20), but can write - the request is kept **in that browser
  only** (never in the reading Alfred's database), sent when the owner is back, and deleted from the browser once sent.

**Chats**

- **D15 Only the host uses the board chat.** A board stream carries the host's chat read-only; the receiver has no
  chat of its own about the streamed board in v1 and never uses the host's Claude. The host's Claude works on every
  cycle of the board, local or streamed in (D25).

**The host works streamed-in cycles as if they were local**

- **D25 A cycle streamed to the host is worked like a local one.** On the host's board, a cycle from 83 is listened to
  (`/alfred-listen`: 83 signals each new call, the host's runner reads and checks it), triaged, verified and judged by
  the requirements like a local cycle; the host opens cards from its calls, mentions them, moves and closes those cards,
  and comments on the cards. All of that is the host's board data, stored on the host - 83 is never asked. The one
  exception: a **comment on a call itself** (a call note) belongs with the call, so it is a request to the call's owner
  and stored there once accepted. Recording, capture switches and 83's own boards stay 83's.

**Data**

- **D16 Azure copies are shown, never used.** The reader sees the board's main item and card items as the owner last
  synced them, marked with that time. No live tracker read from the reader.
- **D17 Secrets masked at the source by default.** The always-masked credential headers (Authorization, cookies, API
  keys - `ALWAYS_MASKED_HEADERS`) are masked before they leave the owner; a stream may switch on "send unmasked".
- **D18 A remote cycle may go on a board of any project.** Requirements are judged by endpoint, not project name.
- **D19 Remote mentions keep nothing on the owner.** A card mentioning a .83 call does not hold it out of .83's storage
  limits; when .83 deletes it the chip says "gone on 83".
- **D20 Nothing streamed is stored on the reader**: no calls, bodies, statements, log lines, Redis, cards, specs or
  chat of the owner. What the reader stores is its own: that a remote cycle is on one of its boards, its own cards,
  comments and verdicts, its own chat.
- **D21 Offline is a state.** An unreachable origin shows `⇇ 83 offline` with the last time seen; its data is not
  shown, guessed or cached. Claude says it cannot reach 83 and answers from what it can.
- **D24 Streamed things live where local ones do, with an origin pill.** Boards streamed to this Alfred are in the
  board switcher (Boards ▾, a "Shared with me" section) and the Boards list. Streamed cycles are on the Session Cycles
  page, both grouped by board (boards here, then boards shared with me, then streamed cycles on no board) and in the
  flat list. Each one carries a pill `⇇ 83 ▾`, or `⇇ 90 via PC-1 ▾` when passed on; a local item that is streamed out
  carries `⇉ 83 · comment ▾`. A click on a pill opens its details: name, kind, from (name and address), through, state,
  what you may do (and who set it), their auto-accept, secrets, streamed since, "stored here: nothing", ref tag, then
  project, calls / failed, status, created, the boards here it is on - with Open, Add to board, Remove from this
  board. An out pill lists each reader with mode, auto, pass on, secrets, since, waiting requests, Change and Stop.
- **D22 Stopping a stream** leaves the reader a name and "stream ended" where it was (on boards, in mentions); no data.
  The reader may remove it.

**Exports**

- **D23 Exports never cut call data.** A board export with remote cycles fetches every remote call in full at export
  time. If an origin is offline it stops and names those cycles; "Export without them" writes them as references and
  says so at the top of the file. There is no switch for it: a cycle streamed to an Alfred may always be exported
  there (.md, .html, .json, cURL - a board, a cycle or one call), in full, with the secrets as the stream sends them
  (masked unless "send unmasked"). The same holds for the MCP `export_calls` tool.

**Correctness, data and trust (chosen 2026-10-19)**

- **D26 Catch-up after a reconnect.** Every stream keeps a cursor (`seq`) per reader. When a link comes back, the owner
  replays every signal after the reader's cursor - new calls, changed cards, ended recordings - so listen, the
  requirements and re-tests judge the calls recorded while the reader was away. No signal is lost to a disconnect.
- **D27 Evidence is written into a card opened from a remote call.** Whoever opens it (the host or the host's Claude),
  the card text gets the call's facts: request line, status, duration, the failing SQL and the ERROR/WARN log lines,
  with the remote mention beside them. That text is the host's board data, so the card still says why it exists when
  the owner is offline or the call is gone (D19). Bodies are not copied.
- **D28 The owner's redaction rules apply at the source** (`backend-redactions`), on top of the always-masked headers
  (D17), before anything leaves - bodies included. "Send unmasked" turns both off for that stream.
- **D29 Presence.** Each side sees who has the streamed board or cycle open right now ("👁 83 · card #7"), carried on
  the link as a heartbeat - never stored.
- **D30 Cross-Alfred compare in one click.** In the Cycles tab, selecting a local and a streamed-in cycle offers
  **Compare**: calls, failed, median time, SQL statements, requirements met, endpoints only in one, endpoints whose
  status differs (first). The same `compare_cycles` the MCP has, reading the remote side live.
- **D31 Read log on the owner.** Settings → Links & streams lists what each reader opened - "83 opened 14 calls of
  error flow · 10:41", "83 exported AB#61813 (.html)" - grouped per stream, kept with the link and removed with it.
- **D32 Link health.** Each link shows connected / offline, round trip (ms), last seen, the peer's Alfred version and
  reconnects today. A peer without streams says so plainly ("83 runs Alfred 1.40 - no streams there").

- **D33 LAN discovery.** Every Alfred announces itself on the LAN (name, address, version - nothing else) and listens
  for others; Settings → Links & streams shows **Found on this network** with each one's name and address and a Link
  button, so nobody types an IP. Typing an address stays possible (another subnet, a VPN). A switch "Announce this
  Alfred on the LAN" (on by default) stops the announcing; discovery never links by itself - the one-time code (D1)
  still decides. Never through the tunnel.
- **D34 Keep a copy (host only, explicit).** On a cycle streamed in, the host may press **Keep a copy**: the cycle is
  fetched in full and imported through the existing export/import (alfred-calls/3), becoming a local cycle named
  "copy of <name> · from 83 · <date>" with a `copy · from 83` chip - never a pill, never live again. The streamed one
  stays as it was. Its board mentions and verdicts can be moved to the copy in the same step. Nothing is ever copied
  by itself; the owner sees it in its read log ("PC-1 kept a copy of error flow").

**Environments: every Alfred tests the same task (chosen 2026-10-19)**

- **D35 The host names the board's environments** (Local, STG, UAT…) on the Task tab and picks the Alfred that fills
  each: Local = this Alfred, STG = 83. An environment is assigned only to an Alfred the board is streamed to. Every
  acceptance item and every test step gets one column per environment.
- **D36 Each environment's marks live on its own Alfred.** STG's marks (Pass / Fail / Can't tell with evidence), its
  test-step ticks (SEEN / FAILED) and its re-test results are stored on 83 and streamed back to the host, shown live in
  the STG column; while 83 is offline the column says so and nothing is guessed. Only 83 writes STG; only the host
  writes Local. This is the one exception to D7: an Alfred assigned to an environment works that environment's column
  of the host's board - nothing else of it.
- **D37 On an environment Alfred, Claude marks directly.** 83's own Claude (its account, through 83's MCP in a
  terminal - `/alfred-verify`, `/alfred-listen` on the board) sets STG marks with evidence, ticks STG's steps and
  writes STG's re-test results itself; a person on 83 may mark too. On the host, Local stays as today (Claude suggests,
  the user marks). 83 still has no board chat (D15).
- **D38 An environment Alfred records its own cycles for the board.** On the streamed board 83 gets **● Record for
  STG**; those cycles are 83's, are streamed to the host automatically (view; comment if the host's stream says so),
  and land on the host's Cycles tab marked STG - so every STG mark's evidence can be opened from the host.
- **D39 Overall = every required environment.** The host ticks which environments are required. An item or step is
  Pass when every required environment passes, Fail when any fails, and "waiting on STG" while a required one has no
  mark or is offline. Re-tests the same: a Fixed card shows `✓ Local · ✗ STG` and is verified only when every required
  environment passed.
- **D40 Re-test all, per environment.** Each environment re-tests the Fixed cards against its own live calls since the
  fix (`RetestService`, code, no model, same expectations as today); on 83 its Claude runs it (`/alfred-verify`) and the
  results are STG's. Verified and Done stay the host's decision.
- **D41 Test cycles per environment.** Every cycle on the board belongs to one environment (its chip: `🧪 Local`,
  `🧪 STG`), and the Cycles tab filters by environment. Each environment records its own test cycles - a recording
  (**● Record for STG**) or a **re-test cycle** (**↻ Re-test cards for STG…**: pick the Fixed cards; the cycle is named
  after them, `Re-test #7 · STG`, the same naming as `CycleNaming`, and linked to each card). A re-test cycle given for an
  environment is the only evidence that environment's re-test uses (as today, D40); its verdicts land in that
  environment's column. 83's cycles stay on 83 and reach the host by D38's automatic stream.

## What the host does with a cycle streamed in

- Puts it on a board (Cycles tab and Session Cycles, with its origin pill, calls, failed count, requirement verdicts).
- Opens its calls: headers, bodies, SQL, log lines, Redis - fetched from the owner on open.
- Opens cards from its calls, mentions them, moves, comments and closes those cards - all on the host (D25).
- Asks its Claude about it: every investigation tool takes a remote ref (`check_calls`, `investigate_call`,
  `call_story`, `db_statements`, `call_logs`, `redis_commands`, `compare_cycles` local vs remote, `diff_calls` across
  Alfreds); answers say where the data came from. `/alfred-listen`, `/alfred-triage` and `/alfred-verify` run on it.
- Judges requirements and re-tests on its calls: the owner signals each new call (ids only); the host reads it and
  judges it as if it were local. The verdict is the host's board data.
- Writes a note on one of its calls - a request to its owner (D25).

## What a receiver of a board stream does

- Finds it in Boards ▾ "Shared with me", the Boards list and Session Cycles, with its pill.
- Opens it: every tab of the host's board, read live - cards, brief, specs, requirements, test steps, cycles, calls,
  the Azure copies and the host's chat, all read-only.
- In `comment` mode: comments and questions on cards, brief comments, notes on the host's calls - each a request.

## Not in v1

Relive or resend of a remote call; interception rules across Alfreds; copying a remote cycle by itself (only the host's
explicit Keep a copy, D34); any Azure use from the reading side; a receiver's own chat or Claude on a streamed board; any card work by a
receiver.

Later (suggested, not chosen yet): stream expiry (1 day / 1 week / until stopped); a desktop toast from the helper
for requests when no Alfred tab is open.

## How it fits the code (investigation, 2026-10-19)

- **Ids**: cycle and captured-call ids are UUIDs (`SessionCyclesService`, `SqliteSessionCyclesRepository`), so ids from
  two Alfreds never clash; a remote ref only needs its origin tag for routing.
- **Mentions**: `MentionParser` accepts any ref without `]`, `|` or a line break - `@[call:<uuid>@83|…]` works with no
  new `MentionType`.
- **No new enum values** (older Alfreds throw on unknown ones): an approved remote write is applied as `Actor.USER` with
  "83" (or "83 (Claude)") as the author and a line in the board's audit. `BoardCycleLink` gains an origin **string**.
- **Routing in the backend, not in MCP**: each MCP server talks to one `ALFRED_URL`, so the reader's backend forwards
  remote refs over the link. Claude, the runner and the board UI keep calling the same endpoints.
- **Reads reuse the existing API.** The owner answers a forwarded GET through its own controllers after a scope check
  that maps the request to a stream (cycle id, a call in a streamed cycle, its statements / log lines / Redis, a
  streamed board's id) - the read-side twin of `BoardWriteTargets`. No mapping = refused.
- **Requirement judging** goes through ports already: an origin-aware `CycleCallsPort` / `CallFactsPort` in
  `boardbridge`, and `RequirementService.callArrived(project, endpoint)` called on a remote new-call signal.
- **The board lock** (409 HELD) checks HTTP writes; an approved request is applied by the owner's own service call, so a
  held board takes it as the holder's approval.
- **Signals, no polling**: the owner forwards its `/ws` signals for streamed cycles and boards over the link; the
  reader's pages re-fetch on them as they do locally.

## Where it lives

- Backend: a leaf slice `backend-links` with its own `links.db` - links (peer key as SHA-256 only), streams, modes,
  auto settings, pass-through switches, waiting requests, audit. Configuration and requests only, never streamed data.
  A bridge `backend-app/linksbridge` answers a peer's reads from the existing slices (scope check first) and forwards
  this side's remote reads. `COPY backend-links/pom.xml` in `backend/Dockerfile`; prefix `links` in `gateway/nginx.conf`
  and `SpaPageFilter` (no SPA page named `/links`: the UI lives under Settings and the board pages).
- MCP: remote refs pass through unchanged; tool results carry the origin label.
- Frontend: Settings → Links (link, name, code, streams list); Stream dialog on a cycle and a board (mode, auto, pass-on,
  send unmasked); the origin pill and its details popover (D24) in the board switcher, the Boards list, the Session
  Cycles page (grouped by board and flat), the board's Cycles tab, the cycle page, call lists, mention chips and the
  call popup; the request popup and tray; "Shared with me" on the reader; a streamed board page with the owner's chat
  read-only; browser-kept drafts while the owner is offline.

## To settle in the build plan

- R1 Ref syntax (`<uuid>@<link>` proposed) through URLs, mentions and MCP arguments.
- R2 The read allowlist: which existing GET routes may be forwarded, and the scope rule for each.
- R3 Large bodies over the link: chunked frames and backpressure (exports never cut, so a 200 MB body must stream).
- R4 Handshake and versions: an Alfred without streams answers "not supported" and the UI says so.
- R5 Docker and native: the backend container dials the LAN peer; the native supervisor needs nothing new.
- R6 Pass-through routing: hop header, loop detection, the far owner's re-share mode.
