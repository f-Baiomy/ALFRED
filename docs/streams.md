# Streams between Alfreds (specs/035)

Alfreds on the same LAN can link and then **stream** a session cycle or a board to each other. The reader sees the
owner's thing live - its calls with headers, bodies, SQL, log lines and Redis commands, or a board with its cards,
brief, specs and cycles - read from the owner on each request and kept nowhere on the reader. A stream is one thing
to one linked Alfred, view only or view + comment; comments are requests the owner accepts. A board can also be tested
on several Alfreds at once (environments: Local, STG, UAT…), each filling its own column of the Task tab.

Code: `backend/backend-links` (the leaf slice: links, pairing, streams, requests, read log, presence, environments, the
peer transport, `links.db`) and `backend/backend-app/linksbridge` (everything that touches other slices: the read
allowlist, the relay filters, masking, the loopback dispatcher, the board/env adapters). Frontend: `core/links/` and
`components/links/`. MCP: `mcp-server/src/tools/links.ts`, and `mcp-server/src/origin.ts`, which opens every tool reply
whose input names a linked Alfred's ref with "⇇ From <Alfred> - read only" (the reply itself unchanged). Decisions D1-D41 are in `specs/035-cycle-streams/plan.md`.

## Refs

Another Alfred's thing is named by its owner's id with the **tag** of the link it is reached through:
`<id>@<slug>` - `8f1c…@stg-83`. The slug comes from the name this Alfred gave the link (lower case, digits and `-`,
at most 24) and never changes, even when the link is renamed. A ref read through a second link gets a second tag
(`x@stg-83@pc-1`): the outermost tag is the link to use. A board call ref keeps its cycle: `in:<call>@<cycle>@<slug>`.

Every read API takes a ref where it takes an id. `RemoteRefFilter` sees the `@<slug>` (path, query or a POST read's
`callIds`), relays the request over that link, and tags every id in the answer (`RefTagger`, streaming JSON rewrite -
bodies, headers and rows are copied byte for byte). `/links/r/{slug}/<path>` is the explicit form (no tagging) for
reading an owner's thing in its own terms.

## Linking (D1-D4, D32, D33)

Settings → Links & streams. Type an address (or pick one **Found on this network**) and a name; the other Alfred shows
an offer with a six-digit code in every open tab; anyone there checks the code and accepts, naming this Alfred back.
The side that asked dials one WebSocket (`/ws/links/peer`, HMAC challenge with the link's shared secret) and keeps it
up with backoff; the other side never dials. A link alone shares nothing. Unlink ends every stream both ways.

Link health on each row: connected / offline, round trip, peer version, last seen, the last error, a clock skew warning.
LAN discovery is native only: the supervisor announces `{id, name, version, port}` on multicast `239.255.70.70:47070`
(TTL 1) every 30 s while "Announce this Alfred" is on, answers queries, forgets an Alfred not heard for 2 minutes
(`packaging/launcher/supervisor.py` `Discovery`, control API `GET /discovery`, `POST /discovery/announce`). Docker
cannot hear the LAN and says so. Discovery never links by itself.

## Streams and what they let through (D5-D9, D17, D28)

A stream is `(link, CYCLE|BOARD, target, mode VIEW|COMMENT, autoAccept, passOn+passMode, unmasked)`, kept by the owner;
the reader keeps a copy of its names only. The owner answers a read only when a stream covers it:

- `StreamRoutes` is the read allowlist - every GET route of the backend is either in `ROUTES` (with where its ref
  sits and what it names) or in `NEVER` (settings, interception, Relive, resend, the Logs explorer, Team tracker,
  sessions, server, storage, exports outside the board). `StreamRoutesTest` walks every controller and fails on a GET
  route in neither list. NEVER wins over a route that would take a word as an id.
- `StreamScope` decides coverage: a cycle stream covers the cycle and its calls (statements and Redis commands by their
  call, checked on the answer); a board stream covers the board, its cards, chat (read only), files, pictures,
  snippets and the cycles on it - this Alfred's own in full, another Alfred's only where its owner allows passing on.
- Masking happens on the owner before anything leaves (`SourceMasker`): the always-masked headers (the same list as the
  frontend's `azure-export.ts`), the owner's redaction rules over bodies (JSON, XML, form), URL parameters and DB
  columns - unless the stream is "send unmasked".
- Writes are never relayed (`RelayLoopbackFilter` answers reads only; `/links/r/**` refuses the rest). On the reader,
  a local write naming a remote thing is refused `409 REMOTE_WRITE` (`RemoteRefFilter`) - except this Alfred's own
  relations: a remote cycle on (or off) a board here, its flags there, a card's cycles, and the links API.
- The owner answers over loopback HTTP to itself with an in-process token (`LoopbackDispatcher` → `RelayLoopbackFilter`
  sets `RelayContext`): the same controllers answer a stream as a page, nothing is duplicated.

Frames are multiplexed on the one socket: `req/head/chunk/end/err/credit/cancel/event/ack/signal/ping/pong/bye`;
bodies go in 128 KB chunks under credit (8 initial), at most 16 answers served at once per link. Durable events
(stream started/ended, request states, environments) go through an outbox with sequence numbers and an inbox that
drops repeats; on every connect the reader reconciles its stream copies and gets a `resync` signal.

**Pass-through (D8)**: a reader that streams a board on to a third Alfred can carry the cycles another Alfred streams to
it, when that owner allows passing on (`passOn`, `passMode`). The far owner sees the hop list and the reader behind the
middle one in its read log; at most 3 hops; loops are refused.

## Requests (D10-D14)

On a COMMENT stream the reader may comment or ask on a card, comment on the brief, or write a note on a call - each a
request (`POST /links/requests`), never a write. The owner sees it in the bottom-right tray of every page (⇄n in the tab
title); the first answer in any tab wins (compare-and-swap); Reject takes a note the reader sees; an accepted request
can be undone (the comment is struck through, the brief comment resolved, the note deleted). With auto-accept on,
requests go in at once and show an Undo toast. An offline owner: the request stays in that browser (a draft) and goes
out when the link comes back. The reader withdraws what still waits. A middle Alfred passes a note on a passed-on call
on to its owner and the answer back.

## Signals and presence (D26, D29)

`LocalSignalTap` listens to this Alfred's own `/ws/session-cycles`, `/ws/board`, `/ws/comments`, `/ws/db-capture` and
sends each change to the linked Alfreds whose streams it concerns (`SignalScopePort.concerns`). The reader tags the ids
and pushes it to its pages on `/ws/links` (`{type:'signal', slug, channel, data}`); `BoardSocketService` merges the
board channel, so a streamed board refreshes like a local one. No polling anywhere. A page that shows a streamed thing
says so on `/ws/links` (`viewing`), and the owner shows "👁 open now" on the stream - never stored.

## On the reader's pages (D20-D25)

- **Session Cycles**: a "⇇ Shared with me" section (boards and cycles streamed here, live / offline / stream ended,
  the boards here a cycle is on); every own cycle has ⇉ Stream… and an out pill `⇉ STG 83 · comment ▾`.
- **A remote cycle page** (`/cycles/<id>@<slug>`): read only (no recording, spacers, removal), every inbound project
  of the owner, refreshed by its signals; a comment on a call becomes a note request; offline shows a banner and no
  data. **⧉ Keep a copy** (D34) fetches the whole cycle - calls, statements, log lines, spacers - and stores it as
  a local cycle "copy of <name> · from <Alfred> · <date>" (a `copy · from` chip, never live again); the owner's read
  log says so.
- **A board's Cycles tab**: a remote cycle is worked like a local one (D25) - listen, review, re-test, compare,
  evidence pack - with its pill; the board's own choices (baseline, archive, remove) are the host's, the cycle's own
  (recording, name, description, steps) stay its owner's. "＋ Add existing cycle" lists the cycles streamed here.
- **A streamed board** (Boards ▾ → ⇇ Shared with me): read only, with the owner's chat read only; on a COMMENT stream
  the card drawer and the brief carry "ask the owner" composers.
- **Mentions** of a remote card or call show `⇇ <Alfred>`; a deleted one says "Gone on <Alfred>" (D19 - a mention here
  never keeps the owner's call). A board call ref of a streamed cycle is `in:<call>@<cycle>@<slug>`: the board's own
  tables keep the owner's call id with the tagged cycle (what that cycle's calls carry when the board judges them), and
  the page asks for its badges as `<call>@<slug>` - matched to mentions in a cycle of that same link only.
- **Exports never cut call data (D23)**: a remote cycle is fetched in full at export time and the "About This
  Document" section says it was streamed from its Alfred; an evidence pack with cycles on an offline Alfred names them
  and offers "Export without them".

## Environments (D35-D41)

The host names a board's environments on the Task tab (Requirements) - each filled by this Alfred or by an Alfred the
board is streamed to - and ticks which are required. Every acceptance item, test step and Fixed card's re-test gets one
column per environment; **Overall** passes when every required one passes. Each column lives on its own Alfred (its
marks, ticks, re-tests and test cycles in its `links.db`), streamed back live; offline is "waiting", never guessed.

An environment Alfred sees its own column on the streamed board: marks with evidence, step ticks, **● Record for STG**
(a cycle here, streamed automatically to the host and put on its board as STG's) and **↻ Re-test cards for STG…** -
the host judges each card with its own re-test code on that Alfred's calls (`/links/data/env-judge`), and the
verdicts land in that column. Claude on the environment Alfred marks directly with `env_mark` / `env_step` /
`env_retest` (D37).

## The read log (D31)

Settings → Links & streams lists, per day, what each reader opened from here (cycle, call, board, db, logs…), who it
was for when passed on, and "copy" / "export" when a reader kept a copy or exported. Kept 30 days, removed with the link.

## Access

`/links` and `/ws/links` are refused through the Cloudflare tunnel; writes follow the settings edit rule
(`LinksAccessFilter`), except the pairing endpoints the other Alfred calls. A streamed read through the tunnel is
refused too (`TUNNEL`).

## Storage

`links.db` (`LINKS_DB_FILE`, `/appdata/links.db` in Docker, `data/links.db` natively): settings (this Alfred's id,
name, announce), links (with their secret), streams, requests and their relays, outbox/inbox, read log, environment
definitions, assignments, marks, steps, re-tests and env cycles. Nothing of another Alfred's data is stored.

## Tests

- `backend-links`: `RefsTest` (refs, slugs, tagging, a 25 M-character string), `SqliteLinksRepositoryTest` (restart,
  first answer wins, outbox/inbox), `EnvVerdictTest`.
- `backend-app`: `StreamRoutesTest` (every GET route decided).
- `tests/python/test_supervisor.py` `DiscoveryTest`.
- Frontend: `core/links/*.spec.ts`, `components/links/links-components.spec.ts`.
- End to end with three Alfreds on one Docker network: `sh tests/e2e/run_streams_e2e.sh` (linking, NOT_STREAMED,
  tagged reads, masking, a 3 MB body in chunks, requests accept/reject/undo/withdraw/view-only/auto, REMOTE_WRITE,
  the read log, pass-through, environments, stream ended and removed).
