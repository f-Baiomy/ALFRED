# Contract: MCP tools exposed by `mcp-server`

Server name `alfred`. Every tool returns one text content block containing compact JSON (or, for `get_cycle`, a short Markdown story followed by JSON), never above the reply budget (16,000 chars by default). Errors return `isError: true` with `{error: "unreachable" | "not_found" | "invalid" | "backend", message, tried?}`.

Shared input pieces (zod):

```ts
const CallRef   = z.object({ id: z.string().min(1), direction: z.enum(['inbound','outbound']).optional() }); // direction auto-detected when omitted (inbound tried first)
const Page      = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(25) };
const Fields    = z.array(z.enum(['id','direction','method','url','originalUrl','status','duration','time','state','error',
                    'project','supplier','parentCallId','requestHeaders','requestBody','responseHeaders','responseBody',
                    'timing','children','comments','db'])).optional();
const Paths     = z.array(z.string().regex(/^[A-Za-z0-9_.\-]+$/)).max(20).optional(); // dot paths into the call record
const Chunk     = { bodyOffset: z.number().int().min(0).default(0), bodyLength: z.number().int().min(256).max(15000).default(4000)  // length counts JSON-escaped characters, so a chunk always fits a reply };
const Block     = z.enum(['request-headers','request-body','response-headers','response-body']);
```

`direction`: inbound = `/internal-calls` (into a project Alfred fronts, e.g. odeysys); outbound = `/calls`.

## Session settings

The server process lives as long as the Claude session, so session settings are in-memory only (never written to disk) and reset when the session ends.

| Tool | Input | Output |
|---|---|---|
| `session_settings` | `{maskSecrets?: boolean, exportFolder?: string | null}` - omitted fields unchanged; `exportFolder: null` clears it | `{maskSecrets, exportFolder}` (current values). `exportFolder` must be an existing directory; stored as an absolute path. |

- `maskSecrets` initial value: env `ALFRED_MCP_MASK` (`1` = on), default off. When on, every read tool runs its calls through `redactCalls` with `GET /redactions` (fetched once per tool call) before shaping the reply. Every read tool also accepts `mask?: boolean` to override for that one request. Every reply carries `masked: boolean, maskedValues: number`.
- Masking covers database data too: `db_overview`, `db_statements`, `db_statement` mask through `redactCalls` with the capture attached as `call.dbCapture` (per-call `db-column` rules → params, rows, before-image rows, origin); `db_query` blanks cells of redacted columns and runs `redactSecrets` over the rest; `trace_value` never echoes a value that is itself masked. No reply path bypasses masking.
- Claude sets these only when the user asks ("hide secrets for this session", "save exports to C:/tmp/alfred from now on").

## Read tools

| Tool | Input | Endpoints | Output |
|---|---|---|---|
| `list_cycles` | `{nameContains?, status?: 'recording'|'paused'}` | `GET /session-cycles`; per cycle `GET .../calls?paged=true&limit=1` + `.../internal-calls?paged=true&limit=1` for totals | `[{id, name, status, createdAt, assignedTo, callCount}]` |
| `get_cycle` | `{cycle: string /* id or name text */, ...Page(limit default 50), fields?, paths?, includeDb?: boolean=true, includeComments?: boolean=true}` | `GET /session-cycles`, `GET /session-cycles/{id}`, `GET .../calls` + `.../internal-calls` (`paged=true, sort=oldest-call`), `GET .../spacers`, `GET /comments?callId` (per call on page), `GET /db-capture/summaries`, per captured call: statements pages + `/calls/{id}/children` → `buildOverview` | Story: cycle header (name, status, total calls), then rows in run order `#n time dir METHOD url → status (ms)` with spacer lines (`── label ──`) placed by `layoutSpacers`, comments indented under their call, captured calls with summary line + non-note findings. Ambiguous name → `{candidates:[{id,name}]}`. |
| `search_calls` | `{direction?: 'inbound'|'outbound'|'both'='both', project?, supplier?, text?, status?: number|'2xx'|'3xx'|'4xx'|'5xx', failed?: bool, slowMs?: number, from?: ISO, to?: ISO, sort?: 'newest'|'oldest'|'slowest'='newest', ...Page, fields?, paths?}` | `GET /calls`, `GET /internal-calls` (`search`, `supplier`, `serviceNames`, `sort`, `offset`, `limit≤200`) | `{total?, scanned, scanCapHit, offset, nextOffset, calls:[row]}`; default row = id, direction, method, url, status, duration, time. |
| `get_call` | `{id, direction?, cycleId?, fields?, paths?, ...Chunk, mask?}` | `/summary`, `/detail?part=` (only parts requested), `/calls/{id}/children` (inbound), `/comments?callId`, `/db-capture/summaries` | Full call by default: headers, bodies (chunked: `{text, offset, length, totalLength, nextOffset, contentType, binary?}`), timing, children `[{id, method, url, status, ms}]`, comments, db summary line. With `cycleId`, reads the cycle copy. |
| `get_call_body` | `{id, direction?, cycleId?, part: Block, offset, length≤15000, pretty=true}` (pretty = the call card's text, the lines add_comment numbers) | `/detail?part=` | one chunk - for paging large bodies/headers. |
| `db_overview` | `{callId, queries=8}` | `/db-capture/summaries`, statements pages, `/calls/{id}/children` | `{summary, time: TimeBreakdown, queries: QueryTotal[] (top 20 + total count), findings: DbFindingSummary[]}` = `analyzeCapture`. Not captured → `not_found` "call has no database capture". |
| `db_statements` | `{callId, failedOnly?, slowMicros?, kind?, table?, text?, ...Page(limit≤100)}` | statements pages (`afterSeq`, `limit=500`) | `{total, offset, nextOffset, statements:[{id, seq, kind, table, durationMs, outcome, sqlPreview(160)}]}` |
| `db_statement` | `{statementId: number, rowsOffset?=0, rowsLimit?=50, part?: 'RESULT'|'BEFORE_IMAGE'}` | `/db-capture/statements/{id}`, `.../rows` | full SQL, params, rows page `{columns, rows, total, nextOffset}`, `callers` (class, method, file, line), origin HQL. |
| `db_query` | `{callId, mode: 'search'|'sql'=search, text, ...Page}` | `POST /db-capture/calls/{callId}/statements/query` | `RecordedQueryResult` (cells cut at 300 chars with full length noted). |
| `trace_value` | `{callId, value}` | `GET /db-capture/calls/{callId}/trace` | `{hits:[{seq, where, index, column}]}` |
| `list_comments` | `{callId, commentId?, offset}` (commentId pages one long comment) | `GET /comments?callId` | `[{id, block, line: lineIndex+1, lineText, comment, createdAt, byClaude}]` |

## Write tools

| Tool | Input | Endpoints | Output |
|---|---|---|---|
| `add_comment` | `{callId, block: Block='response-body', line?: number (1-based), lineMatch?: string, comment: string(1..4000)}` | `/detail?part=block` (to compute lines), `POST /comments` | created comment; text stored as `🤖 Claude: <comment>`; `lineText` filled by server. |
| `delete_comment` | `{commentId}` | `DELETE /comments/{id}` | `{deleted: true}` / not_found |
| `create_cycle` | `{name, calls?: CallRef[] (≤200), record=false}` (Alfred creates cycles RECORDING; paused unless record) | `POST /session-cycles`, then as `add_calls_to_cycle` | `{cycle, copy?: CopyReport}` |
| `rename_cycle` | `{cycleId, name}` | `PATCH /session-cycles/{id}` `{name}` | cycle |
| `start_recording` | `{cycleId}` | `POST /session-cycles/{id}/record` | `{cycle, changed: bool, otherRecording:[{id,name}]}` |
| `stop_recording` | `{cycleId}` | `POST /session-cycles/{id}/pause` | `{cycle, changed: bool}` |
| `add_calls_to_cycle` | `{cycleId, calls: CallRef[] (1..200)}` | per call `/summary` + `/detail`; `POST .../calls/copy` and/or `.../internal-calls/copy` (batches of 20) | `CopyReport{added, skipped, notFound:[id]}` |
| `remove_calls_from_cycle` | `{cycleId, calls: CallRef[] (1..200)}` | `POST .../{calls|internal-calls}/remove` | `{removed, notFound}` |
| `add_spacer` | `{cycleId, label, afterCallId: string | 'top'}` | cycle call lookup (timestamp), `POST .../spacers` | spacer |
| `rename_spacer` | `{cycleId, spacerId, label}` | `PATCH .../spacers/{spacerId}` | spacer |
| `move_spacer` | `{cycleId, spacerId, afterCallId: string | 'top'}` | cycle call lookup, `PATCH .../spacers/{spacerId}/move` | spacer; call not in cycle → invalid |
| `delete_spacer` | `{cycleId, spacerId}` | `DELETE .../spacers/{spacerId}` | `{deleted: true}` |
| `export_calls` | `{format: 'md'|'json'|'html', path?: string, overwrite?: bool=false, source: {cycleId} | {calls: CallRef[]} | {search: <search_calls input>}, includeDb?: bool=true, rows?: 'all'|'sample'='all', description?, environment?}` | as `cycle-export.service.ts` + `export-dialog.component.ts` (hydrate, comments, overlaps, metadata, spacers, `/redactions`, db export + `analyzeCapture`), then `buildExportFile` | Path resolution: absolute `path` → used; relative `path` or no `path` → joined to the session `exportFolder` (no `path` uses the builder's generated file name); no `exportFolder` and no absolute path → `{needsPath: true, suggestedName}`, nothing written, Claude asks the user. Else `{path (absolute), bytes, calls, redactedValues}`. Exports are always masked (same as the UI), whatever `maskSecrets` says. Writes via temp file + rename, lines streamed (never one big string for .json). |

## Not exposed (FR-019)

Cycle delete, cycle clear, resend, interception, proxy logging toggles, db-capture project toggles/settings, Relive runs, editing recorded call content, manual call order.
