# 035 Streams - build plan

The design is in [plan.md](plan.md) (D1-D41) and [mock.html](mock.html). This file says how to build it: research
outcomes, modules, the order of work, tests and risks. Nothing here changes a decision; where a decision needed a
technical answer, the answer is written next to the decision number.

## Research outcomes

**R1 - Ref syntax: `<uuid>@<link>`, resolved in the backend.** Call and cycle ids are UUIDs, `@` is a legal path
character (RFC 3986 `pchar`), and `MentionParser` already accepts it. A request to an existing route whose id segment
carries `@<link>` (for example `GET /internal-calls/8f1c…@stg83/summary`) is caught by one filter in
`backend-app/linksbridge` before any controller, relayed over the link with the suffix stripped, and answered with the
owner's response. So the frontend, the MCP server and the skills keep calling the same paths with the ids they were
given: no MCP tool changes for reads, and `tests/python/test_alfred_skill.py` needs nothing new for them. Board refs use
the same suffix (`AB#61813@PC-1` in text, the board id plus `@<link>` in a path). A link name is restricted to
`[a-z0-9-]{1,24}` (the pill shows the display name; the ref uses this slug), so it can never contain `@`, `/`, `|`, `]`.

**R2 - Read allowlist and scope rule: `StreamReadTargets`, the read twin of `BoardWriteTargets`.** On the owner, every
relayed GET is mapped to the stream that allows it, or refused (403 `NOT_STREAMED`). The first allowlist, from the
routes the frontend and `mcp-server/src` call today:

| Route family | Allowed when |
|---|---|
| `/session-cycles/{id}`, `/{id}/call-overlaps`, `/{id}/spacers`, `/{id}/{callId}/**` (detail), `/{id}/summary`, `/{id}/notes` (GET) | `{id}` is a streamed cycle |
| `/internal-calls/{id}`, `/{id}/summary`, `/calls/{id}`, `/calls/{id}/children` | the call is in a streamed cycle (looked up through the cycle's captured ids) |
| `/db-capture/calls/{id}/statements`, `/statements/query`, `/store-commands`, `/store-keys`, `/trace`, `/export`; `/db-capture/statements/{sid}`, `/{sid}/rows`; `/db-capture/store-commands/{id}` | the call (or the statement's call) is streamed |
| `/call-logs/{id}` | the call is streamed |
| `/comments?callId=…`, `/comments/counts` | filtered to streamed calls |
| `/triage/calls`, `/triage/problem-calls`, `/triage/timeline` | with `cycleId` of a streamed cycle only |
| `/board/boards/{id}`, `/board/boards/{id}/stage`, `/board/cards?board=…`, `/board/cards/{id}`, `/board/cards/{id}/cycles`, `/board/cards/{id}/retest`, `/board/chats/{scope}/messages` (read), and the per-board `/board/cycles/{boardId}/…` reads (`brief`, `brief/comments`, `checklist`, `requirements`, `requirements/calls`, `steps`, `specs`, `specs/{name}`, `evidence`, `log`, `call-badges`, `home`) | the board is streamed (a card through `BoardOfUseCase.boardOfCard`; the board id is the old task key, so `/board/cycles/{boardId}` is a board route) |
| `/teamboards/boards/{id}/items` (copies only) | the board is streamed; live tracker routes are never relayed (D9, D16) |

Everything else is refused, including every route `TeamTunnelGuard` guards, `/settings/**`, `/interception/**`,
`/relive-cycles/**`, `/resend/**`, `/logs/**` (the explorer), `/server/**`. The table lives in one class with one test
that walks every `@GetMapping` in the reactor and fails when a new route is neither in the table nor in an explicit
"never" list - so a new read route is a conscious decision.

**R3 - Large bodies: chunked frames with credit-based backpressure.** The link is one WebSocket (D3). A relayed response
is sent as `head` (status, headers) + `chunk` frames of 256 KB + `end`. The reader grants credit (8 chunks in flight per
request, 4 MB per link) and the owner reads the body from its store as a stream, never as one string. A 200 MB body
crosses without either side holding it whole, and an export never cuts (D23): if the link drops mid-body, the request
fails as `OFFLINE` and the export flow offers "export without them". Requests are multiplexed by a request id; one slow
body cannot stall a small request because credit is per request.

**R4 - Handshake and versions.** `GET /links/hello` (plain HTTP, no link needed) answers
`{alfred, version, streams: 1, announceName}`. An Alfred without streams answers 404 there; the UI says "this Alfred is
too old for streams - update it". The link WebSocket opens with `{proto: 1, features: [...]}`; a peer drops frames
of a kind it does not know and answers `UNSUPPORTED`, never an error page. Unknown JSON fields are ignored on both sides
(no new enum values anywhere - D4).

**R5 - Docker and native.**
- Dialing out: a Docker backend reaches LAN addresses through Docker Desktop's NAT (the same way it reaches Azure), so
  the link connection works from both. The peer's address is the gateway port (3000 Docker, 3001/3000 native).
- Inbound: `/links/**` and `/ws/links` must reach the backend: add `links` to the gateway prefix regex, to
  `SpaPageFilter`'s prefix list, and `/ws/links` is covered by `/ws/`.
- **LAN discovery (D33) works natively only.** UDP multicast from inside a Docker Desktop container does not reach the
  LAN (the VM's NAT drops it, and Docker Desktop on Windows has no host network). Native: the supervisor sends and
  listens on `239.255.70.70:47070` (one small JSON every 30 s: name, address, version - never a key) and serves what it
  heard at its control API; the backend reads it from there. Docker: "Found on this network" shows "Discovery needs the
  native install - type the address below" and the Announce switch is disabled with the same reason. `start.py` does
  not get a host-side announcer in v1.
- Tunnel: every `/links/**` route and `/ws/links` is refused through the Cloudflare tunnel (`BoardEditAccess.viaTunnel`),
  reads included (D3).

**R6 - Pass-through (D8).** A relayed request carries `X-Alfred-Hops: <origin link id>,<hop>…`. A hop that sees its own
id refuses (`LOOP`); a fourth hop refuses (`TOO_FAR`). A middle Alfred relays only a stream whose owner set "allow
passing on", and applies the mode the far owner set for passing on; the middle never widens it. The far owner's read log
names both: "read by 90 through 83".

## Modules and where each piece goes

**`backend-links` (new leaf slice, `links.db`).** Same shape as `backend-sessions`: `adapter/in/web`,
`adapter/out/{sqlite,websocket}`, `application/{port/in,port/out,service}`, `domain/model`. Tables:
- `links` (id, slug, display name, peer address, peer key SHA-256, our key, created, last seen, health)
- `pairing_codes` (code SHA-256, from, expires - 10 min, one use)
- `streams` (id, owner side, kind CYCLE|BOARD, target id, peer link, mode VIEW|COMMENT, auto OFF|ON, pass_on, pass_mode,
  unmasked, active, created, ended)
- `stream_seq` (stream, reader link, last delivered seq - D26 catch-up)
- `requests` (id, stream, kind, payload JSON, from, state WAITING|ACCEPTED|REJECTED|WITHDRAWN|UNDONE, answered by, at,
  undo token)
- `read_log` (D31: link, route family, target, at - kept 30 days, counted per day after 7)
- `env_marks`, `env_steps`, `env_retests` (D36 - only on an environment Alfred: the host board ref, item key / step key /
  card, mark, evidence, history, actor, at). This is the environment's own data, not streamed data, so D20 holds.

It never stores streamed calls, bodies or board text.

**`backend-app/linksbridge` (new bridge).**
- `RemoteRefFilter` - R1, catches `@<link>` ids and relays.
- `StreamReadTargets` + `StreamScopeInterceptor` - R2, on the owner side.
- `LinkRelay` - the WebSocket client/server, frames, credit, offline state.
- `RemoteCycleCallsAdapter` / `RemoteCallFactsAdapter` - origin-aware twins of the `boardbridge` adapters, so
  `RequirementService` and `RetestService` judge a streamed-in cycle's calls exactly as local ones (D25).
- `SignalForwarder` - subscribes to the owner's `/ws` signals for streamed targets and forwards them; the reader
  re-emits them on its own sockets with the origin tag (no polling).
- `RequestApplier` - applies an accepted request by calling the owner's own use case as `Actor.USER` with the author
  text "83" / "83 (Claude)" and an audit line; a held board takes it as the holder's approval (no 409, the call is not an
  HTTP write).
- `EnvJudge` - on an environment Alfred, judges its own calls against the host's re-test plan and requirement evidence,
  read through the stream (D36, D40).

**`backend-board` (small changes, no new enum values).**
- `BoardCycleLink` gains `origin` (string, empty = local). Built through a `with*` method, like `SessionCycle`.
- Board environments (D35): `board_envs` (board id, name, alfred link slug or empty for the host, required) and
  `board_cycles.env` (string). Host-only writes.
- The static judging in `RetestService` (`judge`, `value`, `unknownWhy`) and the evidence check in
  `RequirementService` move into a pure domain class `CallJudge` so `EnvJudge` can call it through a new
  `JudgeUseCase` (plan + calls in, verdicts out) without the bridge reaching into the service.
- `activity.origin` text column (addColumn). The board export writes it as a free key; the importer of an older Alfred
  ignores it (checked in a test with a v1.52 export fixture built by the real exporter).
- Overall verdict (D39): `BoardStage` reads environment verdicts through a new port `EnvVerdictsPort` (implemented in
  `linksbridge`; empty when no environment is assigned, so boards without environments behave as today).

**`backend-session-cycles`:** `session_cycles.env` (string) and `retest_for` (card numbers JSON) for test cycles and
re-test cycles (D38, D41). Named by `CycleNaming` ("Re-test #7 · STG").

**Exports (frontend).** The export builders already read calls through the API, so a remote call fetched by its
`@<link>` ref goes into the file unchanged; the "About This Document" narrative gains one line per origin ("12 calls
recorded on 83 (STG)"). An offline origin stops the export with the D23 dialog. `json-export-v2.ts` writes the origin
as a free key on each call record; `import-parser.ts` keeps it (Keep a copy, D34, is an import of that file).

**MCP server (`mcp-server/`).** Reads need no change (R1). Additions:
- Results label remote items: the backend adds `origin: "83"` to relayed JSON; tool formatters print it.
- Environment Alfred tools (D37): `env_boards` (boards this Alfred is an environment for), `env_mark`, `env_step`,
  `env_retest` - writing `env_*` on this Alfred only. On an environment Alfred, Claude marks directly; on the host,
  Claude still only suggests (`board_suggest_mark` unchanged).
- `skills/_shared/rules.md`: one section "Streamed items" (remote refs, what is a request, never Azure through a stream)
  and the env tools in `/alfred-listen`'s and `/alfred-verify`'s steps. `test_alfred_skill.py` covers the new names.

**Frontend.**
- `core/links/`: `LinksService` (signals, socket-driven), `RemoteRef` helpers (parse / format `@<link>`),
  `RequestsService` (the request queue, auto-accept, undo), `DraftsStore` (D14, IndexedDB, wrapped in try/catch).
- `components/links/`: Settings → Links section (found on network, announce, type an address, pairing code, link list
  with health and read log), Stream dialog (cycle and board), `OriginPillComponent` + details popover (D24),
  request popup + tray (D11, tab title ⇄n), Keep a copy, compare picker (D30).
- Existing components extended, not forked (reuse rule): Boards ▾ and the Boards list, Session Cycles page and
  board Cycles tab (env chip, filters, re-test chip, "↻ Re-test cards for STG…"), call drawer (comment as a request,
  ＋ Card from a remote call - D27), mention chips ("gone on 83" - D19), Task tab requirements and steps (one column
  per environment, `Overall`), chat panel read-only for a receiver (D15), Team items read-only (D16).
- A streamed-in board page reuses the board page with a `readOnlyOrigin` input; every write control becomes "Ask the
  owner…" or disappears per D7/D10.

**Gateway and native.**
- `gateway/nginx.conf` regex and `SpaPageFilter` + `SpaPageFilterTest`: prefix `links` (no SPA page named `/links`).
- `backend/Dockerfile`: `COPY backend-links/pom.xml backend-links/pom.xml`.
- `packaging/launcher/supervisor.py`: discovery sender/listener + `GET /discovery` on the control API (R5).

## Phases

Each phase ends with its tests green and something usable; nothing in a later phase is needed to ship an earlier one.

1. **Links** - `backend-links` skeleton, pairing code, link WebSocket, hello/version, health, read log; Settings →
   Links; gateway/SpaPageFilter/Dockerfile. Done when two stacks link and show each other online/offline.
2. **Cycle stream, view** - streams table, `StreamReadTargets`, `RemoteRefFilter`, chunked relay, masking and redaction
   at the source (D17, D28), signals, catch-up (D26), origin pills on Session Cycles and the board Cycles tab, call
   drawer for remote calls, offline state (D21), stream ended (D22). Done when PC-1 opens a call recorded on 83 with its
   statements and log lines, and MCP `get_call` / `db_statements` / `check_calls` work on it.
3. **Host works streamed-in cycles** - `BoardCycleLink.origin`, remote cycles on any board (D18), the remote ports for
   `RequirementService` / `RetestService`, evidence cards from a remote call (D27), mentions (D19), exports with remote
   calls and the offline export dialog (D23). Done when a requirement is judged from 83's calls on PC-1's board.
4. **Board stream and requests** - board stream view for a receiver, chat read-only, Azure copies read-only, presence
   (D29); requests (comment, question, brief comment, call note), popup in every tab, auto-accept, undo, withdraw,
   offline drafts (D10-D14). Done when 83 comments on PC-1's card through an approved request and undo removes it.
5. **Environments** - `board_envs`, `env_*` tables, `EnvJudge`, `CallJudge` extraction, "● Record for STG", env test
   cycles streamed back automatically, re-test cycles per environment, the env columns and Overall, the env MCP tools and
   skills text (D35-D41). Done when 83 records a STG re-test, its Claude marks STG, and PC-1 shows Overall waiting on
   STG until it passes.
6. **Extras** - pass-through (D8, R6), compare across Alfreds (D30), Keep a copy (D34), LAN discovery native (D33),
   link health detail (D32).

Rough size: phases 1-2 are the biggest (new slice, relay, allowlist); 3 and 5 are mostly wiring through existing ports;
4 is mostly frontend. Done in the main session, one phase per commit series; no subagent fan-out (CLAUDE.md budget).

## Tests

- **Backend, per slice:** pairing (expiry, one use, wrong code), key hashing, stream modes, request state machine
  (first answer wins, withdraw, undo window), catch-up cursor replay, env tables.
- **`StreamReadTargetsTest`:** every allowlisted route mapped and scoped; the reactor-wide walk that fails on an
  unlisted `@GetMapping`; refused routes stay refused (settings, interception, Relive, live tracker).
- **Relay:** a 200 MB body through two in-process relays with a slow reader (no full buffering - heap bound asserted),
  drop mid-body gives `OFFLINE`, per-request credit keeps a small request moving.
- **Masking:** `ALWAYS_MASKED_HEADERS` and the owner's redaction rules applied before the frame leaves; "send unmasked"
  only when the owner set it.
- **ArchUnit:** `backend-links` depends on no other slice; only `linksbridge` touches both.
- **Board:** `CallJudge` gives the same verdicts as before the extraction (existing `RetestServiceTest` /
  `RequirementServiceTest` unchanged and green); Overall with and without environments; `activity.origin` round-trips
  through export/import, and an older export imports unchanged.
- **Frontend:** `OriginPillComponent`, remote ref parsing, request popup across tabs, drafts store without storage,
  export with an offline origin (stops, offers "without them", never cuts a body - extends the no-truncation guard
  tests), streamed board page has no write controls.
- **MCP / skills:** origin labels in tool output; env tools write only `env_*`; `test_alfred_skill.py`.
- **`SpaPageFilterTest`** with the new prefix; `docker compose build backend` before calling phase 1 done.
- **E2E:** `tests/e2e/run_streams_e2e.sh` - two isolated stacks (`alfred-e2e-a`, `alfred-e2e-b`) on one Docker network,
  scripted: link, stream a cycle, read a call with statements from A on B, request + approve, stop the owner (offline
  state, drafts kept), start it (drafts synced), env re-test on B judged and shown on A. Native discovery is checked by
  hand on the staged Windows build (memory: native install e2e check), since it cannot run in Docker.

## Risks

- **Discovery in Docker** (R5): not possible in v1; said in the UI. If wanted later, a host-side announcer in `start.py`.
- **Allowlist drift:** a new GET route could leak through a stream. Mitigated by the reactor-wide route walk test.
- **Hidden local-only assumptions:** code that takes a call id and opens the local store directly (not through a
  route) would miss `@<link>`. Known places: `CommentedCallsKept`, `CallDeletionCascade`, triage feeding, board mention
  re-index. Each gets an explicit "remote ref = skip locally" check and a test.
- **Owner load:** a reader's export pulls every body from the owner. Credit limits keep memory flat; the read log shows
  who pulled what.
- **Claude marking directly on an environment Alfred** (D37) is the one place Claude marks, against today's board rule
  ("Claude marks nothing"). It is kept to the `env_*` tables of that Alfred, never `checklist_marks`, so the existing
  test stays as it is.
- **Clock skew between Alfreds:** re-test "calls since the fix" compares the fix time on the host with call times on
  83. The handshake records the offset and the judge applies it; a skew over 2 minutes shows on link health.

## Open for the go

- Phase order as above, or environments (phase 5) before the board stream and requests (phase 4)?
- v1 cut: ship phases 1-5, with phase 6 as a follow-up?
