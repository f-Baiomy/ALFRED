# Using Alfred from Claude (MCP)

Lets Claude Code, opened in the project Alfred records (e.g. odeysys), read what Alfred captured - session cycles,
inbound and outbound calls with their bodies, database statements, findings and call chains - and write back:
comments on calls, new cycles, copied calls, spacers, recording on/off, and export files. The typical session:

> "Debug the cycle 'booking fails at payment'."

Claude reads the cycle as a story (calls in run order, spacers, comments, each captured call's database summary
line and findings), opens the odeysys files named in a statement's call chain (`SystemSettingService.java:75`),
proposes the fix and records what it found as a 🤖 comment on the call, visible in Alfred's UI.

Spec, plan and tool contract: `specs/007-alfred-mcp-server/`.

## How it works

```
Claude Code (any project) ──stdio──► mcp-server (node + tsx, local process) ──HTTP──► Alfred gateway :3000 ──► backend
                                        │
                                        └── imports frontend/src/app/shared/utils (findings, exports, masking, spacer layout)
```

- **Local stdio only.** Claude Code starts the server as a child process; it opens no port, runs in no container,
  and talks only to `ALFRED_URL` (default `http://localhost:3000`). Nothing in Alfred changed for it: no new endpoint,
  service or gateway rule - it calls the same API the Angular UI calls.
- **One implementation.** The database summary line and findings (`db-findings.ts`, `db-analysis.ts`), the export
  builders, Redactions masking (`redact.ts`) and spacer placement (`spacer-gap-controller.ts`) are imported from the
  frontend, not re-written, so Claude, the UI and the exported files never disagree. All imports go through
  `mcp-server/src/frontend.ts`; a frontend rename breaks that one file and `npm run typecheck`. The export dialog's
  "build the file" step lives in `shared/utils/export-build.ts` so the UI and the server share it (masking included).
- **No polling.** Every tool fetches on demand.
- **Sized for a conversation.** A reply stays under 16,000 characters. Nothing is cut silently: lists return
  `nextOffset`, bodies and SQL return a chunk with `totalLength` and `nextOffset`, long comments are previewed with
  how to read them in full.

## Install and register (once)

Prerequisites: Alfred running (`python3 start.py`), Node 22+, and `frontend/node_modules` installed
(`cd frontend && npm ci`) - the server imports the frontend's utils, which resolve `@angular/core`/`rxjs` there.

One command does it all - installs what is missing, registers (replacing an older registration), and starts the
server once over stdio to prove it answers:

```bash
python setup_mcp.py
```

Options: `--scope project --project-dir C:/projects/odeysys` (writes that repo's `.mcp.json`), `--scope local
--project-dir …` (only you, only there), `--alfred-url http://host:3000`, `--mask`, `--source-root <folder>` (where call-chain
frames are looked up; by default the folder Claude Code is started in - set it only if that is not the project),
`--remove`, `--dry-run`.

By hand, the same thing:

```bash
cd mcp-server && npm ci
```

Register for every project on the machine (user scope):

```bash
claude mcp add --scope user alfred -- node C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs C:/projects/Alfred/Alfred/mcp-server/src/index.ts
```

This runs `node` directly - no `npm`/`npx` (which on native Windows would need a `cmd /c` wrapper) and no download
at start. Add `-e ALFRED_URL=http://host:3000` if Alfred is elsewhere, `-e ALFRED_MCP_MASK=1` to start every session
with masked replies.

Per-project alternative - a `.mcp.json` in the odeysys repo root:

```json
{
  "mcpServers": {
    "alfred": {
      "command": "node",
      "args": ["C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs", "C:/projects/Alfred/Alfred/mcp-server/src/index.ts"]
    }
  }
}
```

Check it: `claude mcp list` shows `alfred` connected; in a session, "list my Alfred cycles".

### Over HTTP (native install, Alfred on another machine)

The native install (specs/012-server-program, docs/server.md) runs this same server with
`ALFRED_MCP_TRANSPORT=http` on `127.0.0.1` (port in `ALFRED_MCP_PORT`), and the backend relays `/mcp` on the UI port
to it - so nothing is installed on your machine. Register the URL you reach the UI on:

```bash
claude mcp add --transport http alfred http://localhost:3000/mcp
```

`localhost:3000` through an SSH tunnel (`ssh -L 3000:localhost:3000 staging`), a LAN address, or the Cloudflare
tunnel URL all work: `/mcp` is reachable wherever the UI is (FR-082), so anyone with the tunnel URL can use these
tools. Each client connection gets its own MCP session; the server never listens beyond loopback, and request bodies
over 10 MB are refused. In the install it is a bundle: `app/mcp/dist/mcp-server.mjs` (src plus the frontend utils
it imports, built by `npm run bundle`) next to `app/mcp/node_modules` (production dependencies only).

The relay is `backend-app/mcpbridge/McpRelayController`: it streams the server-sent events chunk by chunk, passes the
`Mcp-Session-Id` header both ways, and answers `502` with a clear message when the MCP process is down (the Docker
install has no `/mcp`; run `mcp-server` locally there). Differences from the local stdio server:

- **Exports are downloads.** A caller on another machine cannot read the server's disk, so `export_calls` always saves
  into `data/exports` (`ALFRED_EXPORT_DIR`, pinned; only a file name is accepted) and answers with
  `download: /mcp-exports/<name>` instead of a path - open it on the same address as `/mcp`. `McpExportsController`
  serves one file by name, never a path, and deletes exports older than 7 days when the backend starts.
- **`exportFolder` and `sourceRoot` cannot be changed** through `session_settings`: neither may point the server at its
  own folders on a remote caller's behalf.
- Session settings (`maskSecrets`) are per MCP process, so they are shared by every client of that Alfred.

`npm run test:http` runs the whole test suite a second time with every tool call going over this HTTP transport.

## Tools

| Area | Tools |
|---|---|
| Session | `session_settings` - mask secrets in replies on/off; default export folder; `sourceRoot` (the project call chains resolve in) |
| Triage | `triage` - **start here**: what needs attention first, for a cycle, several cycles / everything (`scope`) or a project's live calls in a time window, in six groups with the evidence attached - failed statements, failing supplier calls, errors in 200 bodies, and the first ERROR log lines of each call (a 2xx that logged an error or an exception is a hidden failure); WARN lines and database flags as weaker evidence (see "Triage" below) |
| Problems (specs/010) | `problem_calls` - every call with an error or a warning from HTTP, the database or the logs, counts per signal first, filters `all` / `any` / `none` over the signals `HTTP_ERROR`, `NO_ANSWER`, `DB_FAILED`, `SUPPLIER_FAILED`, `LOG_ERROR`, `LOG_EXCEPTION`, `REDIS_FAILED`, `DB_WARNING` (any database flag, `dbFlags` to narrow), `LOG_WARNING`, `CACHE_COLD` (a Redis miss on a key an earlier recorded call wrote, TTL run out); `investigate_call` (signals, first error with the five items before it, the exception's source line, failing supplier calls, a similar call that succeeded, the call's Redis at a glance); `endpoint_health`; `problem_timeline` (signals per minute, first seen); `compare_cycles` (log problems new / gone / still, signals side by side) |
| Cycles | `list_cycles`, `get_cycle` (opens with a "Needs attention" line; the debugging story: ✖ errors inside 200 responses, ∅ empty results, ↳ each inbound call's supplier calls, optional `bodyPreview`, OPTIONS preflights hidden and counted), `wait_for_calls` (new calls in a recording cycle, event-driven, ≤ 60 s), `create_cycle` (empty or from live calls), `rename_cycle`, `start_recording`, `stop_recording`, `add_calls_to_cycle`, `remove_calls_from_cycle` |
| Search / compare | `search_cycle` (inside one cycle, its own copies: text, direction, project, supplier, status, failed incl. errors inside 200s, `needsAttention`, `dbFailed`, slow, time - rows numbered as `get_cycle` numbers them), `diff_calls` (two calls: status/URL/duration, then headers and JSON/XML-aware body hunks; page with `hunkOffset`) |
| Spacers | `add_spacer`, `rename_spacer`, `move_spacer` (how a story is rearranged - calls stay in recorded-time order), `delete_spacer`, `suggest_spacers` (steps proposed from pauses and URL areas; writes nothing) |
| Calls | `search_calls` (project, direction, supplier, text, status/class, failed - including errors inside 200s -, `needsAttention` (>= `minStatus`, default 300), `dbFailed` (a failed statement, whatever the status), slow, time range), `get_call` (everything, or `fields`/`paths` such as `["method","url"]`; carries `attention` - its triage group and failing supplier calls - and `dbFailures`), `get_call_body` (page through a body) |
| Logs | `call_logs` - the application log lines one inbound call wrote (offset, level, thread, logger, message, exception, `matchedBy` CAUGHT), filtered by level or text, paged; `capturedLevel` is the Log level that applied to that call (`levelAssumed` when only the current setting is known); `call_story` (statements, supplier calls and lines in the call's own order - the Together view; `startAt: "firstError"`); `log_context` (the items around one line); `exception_source` (a logged exception's application frames → project file:line); `search_logs` (lines of many calls by text, regex, level, logger, exception type, time - each hit names its call; total exact; a regex stops after 2 s and says `cutShort`); `log_problems` (repeated ERROR/WARN lines grouped by meaning - ids and numbers set aside - with counts, first/last seen, endpoints, new or not; `fingerprint` lists a problem's calls); `outside_logs` (lines no call wrote around a moment, by thread). Masked like bodies; every one says why lines are missing (▤ off, no agent, below the Log level) |
| Database | `db_overview` (summary line, time breakdown, query totals, findings), `db_statements` (filtered, paged; `failedOnly` alone is read from the failed-statement index), `db_statement` (SQL, params, rows, `callers` = call chain, origin HQL), `db_query` (the window's search/SQL over recorded statements), `trace_value` |
| Redis (specs/011) | `redis_commands` - one call's Redis commands in order (seq shared with its statements), filtered `all`/`reads`/`writes`/`misses`/`failed`/`cold` or by key, paged; with `commandId` one command in full: every argument, the reply and the value decoded by Alfred (JSON, Java serialization, Kryo, gzip, Snappy), the value before a write, who last wrote the key; `redis_overview` (counts, hit rate, key patterns, the window's Redis findings); `redis_key_history` (every recorded call that read or wrote a key). Keys masked in the project's settings stay masked; each says when ⬢ was off |
| Comments | `list_comments`, `add_comment` (a note on the whole call by default, or on a line of request/response headers or body; prefixed `🤖 Claude:`), `add_comments` (many at once), `delete_comment` |
| Export | `export_calls` - .md / .json / .html of a cycle, chosen calls or a search; the export dialog's own files (masked, untruncated, .json re-importable), opening with "At a Glance" (steps, failures, errors inside 200s, empty results, notes); `includeDb: "summary"` for a report for people; environment `Local` |
| Code | `locate_source` (call-chain frames → `path/in/project/File.java:line`); `db_statement` (`sources`), `db_statements` (`source`) and `db_overview` (`gapSources`) carry the same |
| Rules and Relive (read-only) | `list_rules`, `get_rule`, `list_relive_cycles`, `list_relive_runs`, `get_relive_run` (each step: state, status, error, what differed from the recording); a call a rule changed shows ⚡ with the rule name |
| Projects | `list_projects` (listen ports, inbound logging, database capture and its agent, log catching and its Log level), `set_inbound_logging` (only with `confirm: true` after the user agreed), `set_db_capture` and `set_log_capture` (▤ on/off, Log level ERROR…TRACE or APP) - Claude may change these two when an investigation needs it (the owner's decision, specs/010); every reply lists `changed` (old → new) for Claude to tell the user |
| Redactions | `add_default_redactions` - Authorization, Cookie, x-api-key, password (SOAP `wsse:Password` and form fields too), apiKey, tokens; only the missing ones, as normal global Redactions (ask the user first) |

Prompts: `debug_cycle` and `debug_call` (in Claude Code, `/mcp__alfred__debug_cycle`) start a session with the steps that
find a cause fastest - triage, the story, the flagged calls, the database findings and their code, a diff of two
attempts, the rules, a comment - and end by reading the succeeded calls related to the problem.

## Triage

`triage` answers "what needs attention first" from marks Alfred **saves as calls arrive** (`backend-triage`, its own
`triage.db`), so it costs the same for 10 calls or 10,000: one request for the marks (per 100 calls), one for the failed
statements, and no body is read. A call "needs attention" when its status is at or over `minStatus` (default **300**, so
redirects such as a 307 session check count), it has an error, or it is still running 5 minutes after it started.

| Group | Calls |
|---|---|
| 1 | needs attention, and a supplier call it made needs attention too or hid an error inside a 2xx (e.g. OTA 322) |
| 2 | needs attention, with failed database statements |
| 3 | other calls that need attention |
| 4 | succeeded, but a supplier call or a database statement under it failed - **hidden failures** |
| 5 | succeeded, with an error inside its own body or an empty result |
| 6 | everything else, never left out - commented, database-flagged (fan-out, duplicates, …) or much slower calls first |

Every call is listed once, in its highest group, with its evidence: the failing supplier calls (by their number in the
cycle), the failed statements (`#seq`, table, SQL state, message, swallowed / rolled back, the first call-chain frame
resolved to a project file). A supplier call made by an inbound call of the cycle is evidence under it, not an entry; a
supplier call with no known parent is an entry of its own. The groups are a **reading order, not a filter** - a call
that succeeded can hold the cause (a login that set the session the next call rejected).

How the marks stay current, whatever arrives first (backend-app/triagebridge): every inbound and outbound call is
reported when it is intercepted and when it completes (the body is read once then, for an error inside a 2xx and an
empty result - `backend-triage`'s `SoftFailures`, the Java twin of `soft-failure.ts`; both run
`specs/007-alfred-mcp-server/soft-failure-vectors.json`); a supplier call re-counts its parent's failing supplier
calls; db-capture reports a call's failed / swallowed statement counts after every batch that adds a failed statement
and when the call completes. Writes run on one writer thread, so a webhook is never slowed down. Rows are capped
(`alfred.triage.retention-rows`, default 100,000, oldest first) except calls a session cycle holds. Calls recorded
before this version were marked once at the first start (a marker row in triage.db). A call with no mark (past the cap)
is still listed, under 6, and the header says so; `get_cycle` then judges its body as before.

Endpoints (read-only, behind the gateway): `GET /triage/calls?callIds=…&minStatus=` (≤ 500 ids),
`GET /triage/live?project=&since=&to=&maxPriority=5&minStatus=&limit=` (newest first, ≤ 500),
`GET /triage/counts?project=&since=&to=`; `/ws/triage` signals `attention-changed` with the call ids.

Deliberately **not** offered: deleting or clearing a cycle, editing recorded call content, reordering calls, resend,
editing interception rules, running Relive cycles - anything that changes live traffic or destroys recorded evidence in
bulk. (Switching a project's inbound logging is offered behind `confirm: true`; ◆ database capture, ▤ log catching and the
Log level Claude may change itself, and says so.)

**Scopes** (specs/010): every cross-call tool takes `scope` - `{live:true}` (default), `{cycle}`, `{cycles:[...], includeLive}`
or `{all:true}`. The backend resolves it once (`backend-app/investigationbridge`): a call held live and in cycles counts
once and says where it is held (`heldIn`). The endpoints are POSTs (`/triage/problem-calls`, `/triage/endpoints`,
`/triage/timeline`, `/call-logs/search`, `/call-logs/problems`, `/call-logs/problems/calls`) - scopes and filters travel
in the body, since the gateway refuses a request line over 8 KB (about 200 ids; the tools also send at most 100 ids per
GET). Problem calls, endpoint health and the timeline read triage's saved marks, which carry each call's log
error/warning/exception counts, the Log level it was caught at and its database flags (fed by db-capture through
`triagebridge`, also for imported calls and when a project's thresholds change). Search and grouping read db-capture's
caught lines through an FTS5 trigram index and a per-line fingerprint (`docs/db-capture.md`).

Behaviour worth knowing:

- **Everything Claude changes shows live in an open Alfred UI, without a reload**: cycles, recording state, copied/removed calls and spacers through `/ws/session-cycles`, and comments through `/ws/comments` (a call already open re-reads its comments when one is added or deleted anywhere).
- **Errors inside successful responses** (`shared/utils/soft-failure.ts`): a SOAP `Fault`, an OTA `<Error Code=…>`, JSON `errors`/`error`/`success: false` in a response below 400. The same detector feeds `get_call`, the exports' "At a Glance" and - through the saved triage marks - `triage`, `get_cycle` and the `failed`/`needsAttention` filters (which read a body only for a call with no mark).
- `wait_for_calls` listens on the calls and session-cycles sockets, re-reads the cycle only when one fires, and returns after at most 60 s. Pass the previous reply's `lastCallId` as `sinceCallId` to continue. `until: "logError" | "logWarning" | "dbFailed" | "problem"` waits for the next call with that kind of trouble (listening on `/ws/db-capture` and `/ws/triage` too, since lines and marks settle a moment after a call ends) and lists it under `matched`.

- `create_cycle` leaves the new cycle **paused** unless `record: true` (Alfred itself creates cycles recording - right
  for "new cycle, then reproduce", wrong for a cycle assembled from chosen calls). Several cycles may record at once;
  `start_recording` lists the others.
- Inbound calls are a ring buffer (the last ~1,500). A call that has dropped out is reported as such, with the
  cycles that still hold a copy; read it from there with `cycleId`.
- `search_calls` filters text, project and supplier in Alfred; status, failed, slow and time in the server, scanning
  at most 2,000 recent calls per direction (`scanCapHit` says when the cap was reached).
- Comment line numbers are the call card's: headers as pretty JSON, bodies pretty-printed when JSON/XML.
  `get_call_body` (default `pretty: true`) shows exactly those lines.

## Session settings

The server lives exactly as long as the Claude session, so settings last for the session and are never stored.

- **Masking replies** - "hide secrets for this session" → `maskSecrets: true`: every reply is masked with Alfred's
  Redactions and secret variables - the same rules as exports - including database params, rows and query cells.
  Each reply says `masked` and `maskedValues`; any read tool takes `mask` to override one request.
- **Export location** - with no path, Claude asks where to save each time. "Save exports to C:/tmp/alfred for this
  session" → `exportFolder`; exports with no path or a relative path go there. An existing file is never
  overwritten unless asked.
- **Source root** - where `File.java:line` frames are looked up: the folder Claude Code started the server in, unless
  `ALFRED_SOURCE_ROOT` or `sourceRoot` says otherwise. Source files are indexed by name on first use (build output,
  `node_modules` and dot-folders skipped). A frame carries no package, so when two classes share a name (odeysys has two
  `GenericDAOImpl.java`) the server keeps the file whose method at that line is the frame's method, then the one the
  calling frame's file imports; only a frame that is still ambiguous comes back as `candidates`. A file you edit is re-read.

## Data warning

Alfred keeps bodies, headers, tokens and database rows verbatim (by design). With masking off, tool replies carry
them as recorded, and they reach the model provider through the Claude session. Exported files are always masked
with Alfred's Redactions, as in the UI. Add Redactions (Settings) for anything that must never leave the machine.

## Verify

```bash
cd mcp-server && npm run typecheck && npm test
```

`npm test` runs every tool against an in-memory fake Alfred speaking the real wire shapes (summaries, captured-call
wrappers, part details with their nulls, 404s, and its WebSocket change signals), including parity checks: `db_overview` equals `analyzeCapture` on the same capture, exports equal
the dialog's builders byte for byte apart from the generation time, and the .json re-imports through
`import-parser.ts`.

```bash
cd mcp-server && npm run live-check
```

Against the running Alfred: reads call `500d0cdc-…` (the HQL fan-out #19-#25 and the swallowed failure at #42),
adds a comment, creates a cycle from the call with a spacer, searches it, diffs the call with its cycle copy, reads the
rules, Relive cycles and projects (asking - never flipping - a project switch), exports .md/.json/.html, records a
second cycle while sending marker requests through the first project's reverse-proxy listener (`wait_for_calls` must wake
on them), then deletes everything it made. With `ALFRED_SOURCE_ROOT=<odeysys checkout>` it also resolves a real frame.
`-- --pause` stops before the cleanup so the open UI can be checked. `npx tsx scripts/stdio-check.ts` starts the
server the way Claude Code does and calls a tool over real stdio.

## Troubleshooting

- **"Alfred is not reachable"** - start it (`python3 start.py`) or fix `ALFRED_URL`.
- **"gateway answered 502"** after a backend rebuild - `docker compose restart app-gateway`.
- **Server fails to start: cannot find `@angular/core`** - `cd frontend && npm ci`.
- **Tools missing in Claude** - `claude mcp list`; the registered paths must be absolute.
