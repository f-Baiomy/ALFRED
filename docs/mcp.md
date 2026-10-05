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
--project-dir …` (only you, only there), `--alfred-url http://host:3000`, `--mask`, `--remove`, `--dry-run`.

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

## Tools

| Area | Tools |
|---|---|
| Session | `session_settings` - mask secrets in replies on/off; default export folder |
| Cycles | `list_cycles`, `get_cycle` (the debugging story: ✖ errors inside 200 responses, ∅ empty results, ↳ each inbound call's supplier calls, optional `bodyPreview`, OPTIONS preflights hidden and counted), `wait_for_calls` (new calls in a recording cycle, event-driven, ≤ 60 s), `create_cycle` (empty or from live calls), `rename_cycle`, `start_recording`, `stop_recording`, `add_calls_to_cycle`, `remove_calls_from_cycle` |
| Spacers | `add_spacer`, `rename_spacer`, `move_spacer` (how a story is rearranged - calls stay in recorded-time order), `delete_spacer`, `suggest_spacers` (steps proposed from pauses and URL areas; writes nothing) |
| Calls | `search_calls` (project, direction, supplier, text, status/class, failed - including errors inside 200s -, slow, time range), `get_call` (everything, or `fields`/`paths` such as `["method","url"]`), `get_call_body` (page through a body) |
| Database | `db_overview` (summary line, time breakdown, query totals, findings), `db_statements` (filtered, paged), `db_statement` (SQL, params, rows, `callers` = call chain, origin HQL), `db_query` (the window's search/SQL over recorded statements), `trace_value` |
| Comments | `list_comments`, `add_comment` (a note on the whole call by default, or on a line of request/response headers or body; prefixed `🤖 Claude:`), `add_comments` (many at once), `delete_comment` |
| Export | `export_calls` - .md / .json / .html of a cycle, chosen calls or a search; the export dialog's own files (masked, untruncated, .json re-importable), opening with "At a Glance" (steps, failures, errors inside 200s, empty results, notes); `includeDb: "summary"` for a report for people; environment `Local` |
| Redactions | `add_default_redactions` - Authorization, Cookie, x-api-key, password (SOAP `wsse:Password` and form fields too), apiKey, tokens; only the missing ones, as normal global Redactions (ask the user first) |

Deliberately **not** offered: deleting or clearing a cycle, editing recorded call content, reordering calls, resend,
interception rules, switching proxy logging or database capture, Relive runs - anything that changes live traffic or
destroys recorded evidence in bulk.

Behaviour worth knowing:

- **Everything Claude changes shows live in an open Alfred UI, without a reload**: cycles, recording state, copied/removed calls and spacers through `/ws/session-cycles`, and comments through `/ws/comments` (a call already open re-reads its comments when one is added or deleted anywhere).
- **Errors inside successful responses** (`shared/utils/soft-failure.ts`): a SOAP `Fault`, an OTA `<Error Code=…>`, JSON `errors`/`error`/`success: false` in a response below 400. The same detector feeds `get_cycle`, `get_call`, `search_calls failed:true` and the exports' "At a Glance".
- `wait_for_calls` listens on the calls and session-cycles sockets, re-reads the cycle only when one fires, and returns after at most 60 s. Pass the previous reply's `lastCallId` as `sinceCallId` to continue.

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

## Data warning

Alfred keeps bodies, headers, tokens and database rows verbatim (by design). With masking off, tool replies carry
them as recorded, and they reach the model provider through the Claude session. Exported files are always masked
with Alfred's Redactions, as in the UI. Add Redactions (Settings) for anything that must never leave the machine.

## Verify

```bash
cd mcp-server && npm run typecheck && npm test
```

`npm test` runs every tool against an in-memory fake Alfred speaking the real wire shapes (summaries, captured-call
wrappers, 404s), including parity checks: `db_overview` equals `analyzeCapture` on the same capture, exports equal
the dialog's builders byte for byte apart from the generation time, and the .json re-imports through
`import-parser.ts`.

```bash
cd mcp-server && npm run live-check
```

Against the running Alfred: reads call `500d0cdc-…` (the HQL fan-out #19-#25 and the swallowed failure at #42),
adds a comment, creates a cycle from the call with a spacer, exports .md/.json/.html, records a second cycle while
sending marker requests through the first project's reverse-proxy listener, then deletes everything it made.
`-- --pause` stops before the cleanup so the open UI can be checked. `npx tsx scripts/stdio-check.ts` starts the
server the way Claude Code does and calls a tool over real stdio.

## Troubleshooting

- **"Alfred is not reachable"** - start it (`python3 start.py`) or fix `ALFRED_URL`.
- **"gateway answered 502"** after a backend rebuild - `docker compose restart app-gateway`.
- **Server fails to start: cannot find `@angular/core`** - `cd frontend && npm ci`.
- **Tools missing in Claude** - `claude mcp list`; the registered paths must be absolute.
