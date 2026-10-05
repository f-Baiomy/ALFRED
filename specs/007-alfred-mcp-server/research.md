# Research: Alfred for Claude (MCP server)

All findings below were read from the current source on branch `007-alfred-mcp-server` (CodeGraph + targeted reads), not assumed.

## R1. Transport and runtime

- **Decision**: Local stdio MCP server, TypeScript on Node 22 (installed: v22.12.0), `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), `zod` input schemas, run with `tsx` (`npx tsx mcp-server/src/index.ts`).
- **Rationale**: Decided with the owner. Stdio means no listener (FR-020); TypeScript lets the server import the frontend's pure functions directly (R4, R5).
- **Alternatives considered**: HTTP/SSE MCP inside a container (rejected by owner: a listener plus a compose service for a single-user tool); Python/Java port of the findings logic (rejected: two implementations drift).
- **Note**: `tsx` is not installed globally (`npx --no-install tsx` fails). It becomes a pinned `devDependency` of `mcp-server/`, and the registration command runs `mcp-server/node_modules/.bin/tsx` through `npm --prefix` so nothing is fetched at start-up.

## R2. Endpoints (all already routed by `gateway/nginx.conf` - no gateway change)

| Need | Endpoint | Shape notes |
|---|---|---|
| List outbound | `GET /calls?search&supplier&sort&offset&limit` | summaries only; `limit` clamped to `alfred.calls.max-limit` (200). `search` = case-insensitive substring over method, URLs, status, error, headers, bodies. `sort`: newest, oldest, newest-call, oldest-call, slowest, fastest, status. **No server-side status or time filter.** |
| List inbound | `GET /internal-calls?...&serviceNames=a,b` | same contract, plus project filter `serviceNames`; clamp 200. |
| One call row | `GET /{calls|internal-calls}/{id}/summary` | `CallSummaryDto` → `toCallRecord(dto, source)` (`shared/utils/call-utils.ts`). |
| Call detail | `GET /{calls|internal-calls}/{id}/detail?part=` | `{request, response, relive}`; `part` ∈ request-headers, request-body, response-headers, response-body. |
| Supplier children | `GET /calls/{inboundId}/children` | outbound calls whose `parentCallId` is the inbound call. |
| Cycles | `GET/POST /session-cycles`, `GET/PATCH /session-cycles/{id}` | `SessionCycle{id,name,createdAt,assignedTo,status: RECORDING|PAUSED,reliveRunId}`; PATCH body `{name?, assignedTo?}`. |
| Record / stop | `POST /session-cycles/{id}/record`, `POST /session-cycles/{id}/pause` | idempotent (same status returns unchanged); a Relive run's cycle never records. **Several cycles may record at once** - no exclusivity rule exists. |
| Cycle calls | `GET /session-cycles/{id}/calls` and `/internal-calls` with `paged=true&offset&limit&sort=oldest-call` (+`serviceNames` inbound) | must pass `paged=true` (cycle pagination is off by default). |
| Cycle call detail | `GET /session-cycles/{id}/{calls|internal-calls}/{callId}/detail?part=` | |
| Copy into cycle | `POST /session-cycles/{id}/calls/copy`, `/internal-calls/copy` body `{calls: CallRecord[]}` | **takes full hydrated records, not ids** (summary + detail merged, as `BulkActionsBarComponent.hydrateOne`); returns `{added, skipped}`. |
| Remove | `POST /session-cycles/{id}/{calls|internal-calls}/remove` body `{callIds}` | returns `{removed, notFound}`. |
| Spacers | `GET/POST /session-cycles/{id}/spacers`, `PATCH .../{spacerId}` `{label}`, `PATCH .../{spacerId}/move` `{afterCallId, anchorTimestamp}`, `DELETE .../{spacerId}` | anchor = call ABOVE + that call's own timestamp; both null = above every call. |
| Comments | `GET /comments?callId`, `POST /comments`, `DELETE /comments/{id}` | `{callId, block, lineIndex, lineText, comment}`; `block` ∈ request-headers, request-body, response-headers, response-body. **No author field.** |
| DB summary | `GET /db-capture/summaries?callIds=a,b` | `CallDbSummary` incl. `flags`; absent key = not captured. |
| DB statements | `GET /db-capture/calls/{callId}/statements?afterSeq&limit` (≤500) | `{statements, transactions, supplierMarkers, hasMore}`. |
| DB statement | `GET /db-capture/statements/{id}`, rows `GET .../{id}/rows?part=RESULT|BEFORE_IMAGE&offset&limit` | |
| DB SQL search | `POST /db-capture/calls/{callId}/statements/query` `{mode:'search'|'sql', text, offset, limit, sortColumn?, sortDir?}` | `RecordedQueryResult{columns, rows, total, statementSeqs?, error?}` |
| Trace | `GET /db-capture/calls/{callId}/trace?value=` | `{hits: TraceHit[]}` |
| DB for export | `GET /db-capture/calls/{callId}/export` | whole capture incl. rows. |
| Export inputs | `POST /calls/export-metadata`, `GET /session-cycles/{id}/call-overlaps`, `GET /redactions` | as `cycle-export.service.ts` / `export-dialog.component.ts` use them. |

Excluded on purpose (FR-019): `DELETE /session-cycles/{id}`, `POST .../calls/clear`, resend, interception, `/internal-calls/services/{name}/logging-enabled`, `/db-capture/projects/*`, Relive.

## R3. Filters the API does not have

- **Decision**: `search_calls` maps project → `serviceNames` (inbound) and URL/text → `search` server-side; status class, failed (status ≥ 400 or `error`), slow (`duration_ms ≥ slowMs`, default 1000) and time range are applied in the MCP server while paging newest-first through summaries (≤200 per request), stopping at the first row older than `from` or after a scan cap (default 2000 rows, reported in the reply).
- **Rationale**: no new backend endpoints (FR-022); summary rows carry no bodies, so scanning 2000 is cheap; the cap keeps it bounded (Constitution II).
- **Alternatives**: add filters to `CallListSupport` (rejected: backend change); scan unbounded (rejected).

## R4. Database overview reuse

- **Decision**: Import `buildOverview`, `findingSummary` (`db-findings.ts`) and `analyzeCapture`, `timeBreakdown`, `queryTotals`, `suppliersOf` (`db-analysis.ts`) directly. Inputs are assembled exactly as the window/export dialog do: statements pages (`afterSeq` loop until `!hasMore`) → `statements/transactions/supplierMarkers`; `summary` (with `flags`) from `/db-capture/summaries`; suppliers from `/calls/{id}/children` → `suppliersOf`.
- **Rationale**: one implementation (Constitution V); SC-003 requires 100% agreement.
- **Import closure**: these two files import only `core/models/*` types and `db-statement-display`, `sql-param-columns` - no Angular, no DOM.

## R5. Export reuse - runs outside the browser?

- **Finding**: The import closure of `markdown-builder.ts`, `html-builder.ts`, `json-export-v2.ts` is 37 files. Runtime dependencies outside plain TS:
  - `@angular/core` / `rxjs` via `spacer-gap-controller.ts` (`signal`) and `core/state/call-selection.tokens.ts` (`InjectionToken`) - both import fine in plain Node (no zone, no DI needed for module load); resolved from `frontend/node_modules`.
  - `DOMParser` used at call time in `body-format.ts` (XML well-formedness → pretty print), `xml-tokenizer.ts`, `soap-summary.ts` (guarded by `typeof DOMParser`).
  - `localStorage` only in `db-group-preference.ts`, used by the dialog, not the builders. `document.`/`window.` hits in `html-builder.ts`, `report-chrome.ts`, `db-export-section.ts` are inside the generated page's `<script>` strings, not executed.
- **Decision**: Install `DOMParser` on `globalThis` from **jsdom** before importing the builders (`mcp-server/src/dom-shim.ts`). jsdom returns a `parsererror` document for malformed XML like browsers do, which `body-format.ts` relies on.
- **Alternatives**: `@xmldom/xmldom` (rejected: reports errors through callbacks, no `parsererror` element → different formatting of invalid XML than the UI); forking builders (rejected: invariant "exports never truncate" and re-import format must stay single-sourced).
- **Orchestration**: The builders are pure, but choosing builder, masking with `redactCalls` (`shared/utils/redact.ts`), and file naming live in `ExportDialogComponent.buildContent`. **Decision**: extract that body into a pure `shared/utils/export-build.ts` (`buildExportFile(format, input)`) used by both the dialog and the MCP server - so redaction can never be skipped by the MCP path. Fetching (hydrate, comments, overlaps, metadata, spacers, db captures + `analyzeCapture`) is RxJS/HttpClient in `cycle-export.service.ts` / `export-dialog.component.ts`; the MCP server repeats those fetches with `fetch` and a parity test (SC-008) proves equal output.

## R6. Comment anchoring

- **Finding**: A comment's `lineIndex` is the line's position in the text the call card panel renders for that block (`json-panel.component.ts` `allLines`, from its `baseText`); the exports read it back as `detectAndFormatBody(text).body.split('\n')[lineIndex]`.
- **Decision**: `add_comment` takes `block` + either `lineIndex` or `lineMatch` (text to find); the server computes the line list with the same pure formatter the panel uses (located/extracted during implementation; task T-comment-lines asserts panel and server line lists match on JSON, XML, headers), and fills `lineText` itself. Default: line 0 of the block.
- **Claude marker**: no author field exists → comment text is prefixed `🤖 Claude: `. No backend change.

## R7. Spacer placement and cycle story order

- **Decision**: The story merges outbound and inbound cycle calls by `callTime` and places spacers with `layoutSpacers`/`spacerSlots` from `spacer-gap-controller.ts` (the one placement function; invariant). `add_spacer`/`move_spacer` take `afterCallId` (or `"top"`) and send that call's own `timestamp` as `anchorTimestamp`.
- **Rearranging**: only spacer moves (clarified); call order is recorded time.

## R8. Copy and "create cycle from live calls"

- **Decision**: For each id: resolve source (try `/internal-calls/{id}/summary`, then `/calls/{id}/summary`, or use a `source` the caller gives), fetch `/detail`, merge as `{...toCallRecord(summary), ...detail}`, group by source, POST in batches of 20. Per-item result: added / skipped (already in cycle) / not found. `create_cycle({name, callIds?})` = POST cycle then copy.

## R9. Selected fields

- **Decision**: `fields` (named, see contracts) + `paths` (dot paths into the merged CallRecord, e.g. `response.headers.content-type`, `request.body`). Unknown names/paths reported per field (edge case). Named fields map to the cheapest source: list fields from summaries; header/body fields trigger `?part=` detail fetches only for the parts asked (`CallDetailPart`).

## R10. Size limits and paging

- **Decision**: Default reply budget 16,000 characters (SC-005). Bodies and long SQL are returned in chunks with `{offset, length, totalLength, nextOffset}`; lists carry `{total, offset, nextOffset}`. Nothing is cut silently (FR-006).

## R11. Live UI update

- **Finding**: every write endpoint above already calls the slice's notification port (e.g. `notifySessionCyclesChanged`), which drives the UI WebSocket. **Decision**: nothing extra needed (FR-018).

## R12. Agent context script

- `.specify/scripts/powershell/update-agent-context.ps1` does not exist in this install; CLAUDE.md gets its pointer line by hand in the docs task (FR-026).
