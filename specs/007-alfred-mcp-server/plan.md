# Implementation Plan: Alfred for Claude (MCP server)

**Branch**: `007-alfred-mcp-server` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-alfred-mcp-server/spec.md`

## Summary

A local stdio MCP server in `mcp-server/` (TypeScript, Node 22, `@modelcontextprotocol/sdk` + `zod`, run by `tsx`) that lets Claude Code in any project - mainly odeysys - read Alfred's recorded data and edit cycles through Alfred's **existing** HTTP API on the gateway (`ALFRED_URL`, default `http://localhost:3000`). 25 tools ([contracts/tools.md](contracts/tools.md)): cycle story, call search/detail with field selection and body paging, database overview/statements/query/trace, comments, cycle create/rename/record/stop/copy/remove, spacers add/rename/move/delete, and .md/.json/.html export to a user-named path. The database findings and the exports come from the frontend's own pure functions, imported directly, so Claude, the UI and the files never disagree. No backend, proxy, gateway or compose change. One small frontend refactor: the export dialog's "build the file" step moves into a pure util both sides call, so the MCP path cannot skip Redactions.

## Technical Context

**Language/Version**: TypeScript 5.x (frontend's version), Node 22.12 (installed)
**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, `tsx` (runner), `jsdom` (only for `globalThis.DOMParser`, see research R5); imports `frontend/src/app/shared/utils/*` + `core/models/*` by relative path; `@angular/core`/`rxjs` resolved from `frontend/node_modules` (load-time only)
**Storage**: none - the server is stateless; Alfred backend stays the only system of record
**Testing**: `node:test` via `tsx --test` with a fake Alfred (`node:http` server on an ephemeral port, fixtures built from real response shapes and, for exports, by `buildBulkExportPayload`); `npm run live-check` against the running Alfred; frontend `ng test --include` for the extracted export util
**Target Platform**: owner's Windows 10 machine (also works on Linux/macOS); started by Claude Code over stdio
**Project Type**: CLI-style local tool (MCP server) inside the Alfred monorepo
**Performance Goals**: typical tool reply < 2 s on a local Alfred; cycle story of 50 calls with DB overviews < 5 s (4 concurrent requests); unreachable Alfred reported < 5 s (SC-006, 4 s fetch timeout)
**Constraints**: replies ≤ 16,000 chars (SC-005), every truncation states full size + next offset; no polling; no listener; at most 4 concurrent requests to Alfred; list `limit ≤ 200` (backend clamp); export writes streamed (temp file + rename)
**Scale/Scope**: inbound ring buffer 1,500 rows, outbound cap by size; captures up to thousands of statements; bodies up to MBs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Security**: No new inbound boundary in Alfred. The MCP server validates every tool input with zod and clamps every limit/offset/length before calling Alfred (backend clamps again). No listener (stdio only). Talks only to `ALFRED_URL`. Never logs bodies/headers (stderr logs tool name, ids, sizes, durations). Exports go through the extracted `buildExportFile`, which always applies `redactCalls` with `/redactions` - same masking as the UI; html export escaping unchanged (same builder). Tool *replies* - calls and database statements, rows, query cells and trace values alike - are masked when the user turns masking on (owner decision below); with it off the data reaches the model provider through Claude Code - `docs/mcp.md` and the `session_settings` tool description say so.
- [x] **II. Performance**: Nothing on the proxy path. No polling - fetch on demand per tool call. Lists use summary endpoints (no bodies); bodies fetched per part only when asked. Client-side filters (status/time/slow) scan summary pages newest-first with a 2,000-row cap reported in the reply. Statement pages 500 at a time; concurrency 4. JSON export streamed line-by-line to disk, never one String (invariant).
- [x] **III. Architecture**: No backend slice touched; no cross-slice edge. New top-level `mcp-server/` package. Frontend change stays in `shared/utils` (pure, tested directly); `ExportDialogComponent` calls the extracted function - no forked component.
- [x] **IV. Style**: strict TS, no `any`; reuses frontend types; one concern per file; comments explain why.
- [x] **V. Clean code**: Reused, not re-implemented: `buildOverview`, `findingSummary`, `analyzeCapture`, `timeBreakdown`, `queryTotals`, `suppliersOf` (db), `buildBulkExportMarkdown/Html`, `buildExportMarkdown/Html`, `buildJsonExportV2`, `redactCalls`, filename helpers (export), `layoutSpacers`/`spacerSlots` (spacers), `toCallRecord`, `callTime`, `supplierOf` (calls), `detectAndFormatBody` + the panel's line splitter (comments). Duplicated by necessity: the *fetch sequence* of `cycle-export.service.ts`/export dialog (RxJS + HttpClient there, `fetch` here) - recorded in Complexity Tracking, guarded by a parity test.
- [x] **VI. Verification**: unit tests per tool against the fake Alfred; parity tests (overview vs `analyzeCapture` on a real-shaped capture; export bytes vs frontend builders minus timestamps); frontend spec for `buildExportFile` incl. "redaction always applied"; live check; full `npm test`/`npm run build` in frontend once at the end.
- [x] **Invariants**: exports untruncated and re-importable (same builders, SC-008 test re-imports with `import-parser.ts`); spacers only via `layoutSpacers`; no new route prefix → gateway untouched; docs: new `docs/mcp.md` + CLAUDE.md pointer + AGENTS.md map line.

Post-design re-check: still passes; no violation beyond the one tracked below.

## Owner decisions (2026-10-05)

1. **Masking tool replies - the user decides.** `session_settings({maskSecrets})` switches it for the session (initial value from env `ALFRED_MCP_MASK`, default off); any read tool takes `mask` to override one request. Masking = `redactCalls` with Alfred's Redactions, the same rules as exports. Every reply says `masked` + `maskedValues`. Exports are always masked, as in the UI.
2. **Export location - ask each time, unless a session default is set.** No path (or a relative path) and no default → nothing written, `needsPath` → Claude asks. `session_settings({exportFolder})` sets a default folder for the rest of the session; no-path and relative-path exports go there. In-memory only (server process = Claude session).

## Project Structure

### Documentation (this feature)

```text
specs/007-alfred-mcp-server/
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/tools.md   # Phase 1 - tool names, input schemas, endpoints, outputs
└── tasks.md             # /speckit.tasks (not yet)
```

### Source Code

```text
mcp-server/
├── package.json          # private; deps pinned: @modelcontextprotocol/sdk, zod, jsdom; dev: tsx, typescript, @types/node
│                         # scripts: start (tsx src/index.ts), test (tsx --test test/*.test.ts), typecheck (tsc --noEmit), live-check
├── tsconfig.json         # strict; include src, test and the imported ../frontend/src/app/{shared/utils,core/models} files
├── src/
│   ├── index.ts          # McpServer + StdioServerTransport; registers tool modules
│   ├── dom-shim.ts       # globalThis.DOMParser from jsdom - imported first (research R5)
│   ├── alfred-client.ts  # fetch wrapper: ALFRED_URL, 4 s timeout, concurrency 4, typed errors (unreachable/not_found/backend)
│   ├── frontend.ts       # the ONE place that imports ../../frontend/src/app/... (re-exports what tools use)
│   ├── calls.ts          # source detection, summary+detail hydration, field/path selection, body chunking
│   ├── reply.ts          # JSON/Markdown reply builder with the 16k budget and ToolError
│   ├── session.ts        # in-memory SessionSettings (maskSecrets, exportFolder) + session_settings tool
│   ├── masking.ts        # applies redactCalls/redactSecrets (frontend) to call AND database replies when masking is on; counts masked values
│   ├── cycle-calls.ts    # listCycleCalls: a cycle's full ordered call summaries (both sources) + spacers - shared by get_cycle, spacers, export
│   └── tools/
│       ├── cycles.ts     # list_cycles, get_cycle, create/rename, start/stop_recording, add/remove calls
│       ├── spacers.ts    # add/rename/move/delete_spacer
│       ├── calls.ts      # search_calls, get_call, get_call_body
│       ├── db.ts         # db_overview, db_statements, db_statement, db_query, trace_value
│       ├── comments.ts   # list/add/delete_comment
│       └── export.ts     # export_calls (fetch sequence + buildExportFile + streamed write)
├── test/
│   ├── fake-alfred.ts    # node:http fake with real-shaped fixtures; records requests for assertions
│   ├── fixtures/         # call/cycle/capture JSON copied from real responses (secrets replaced)
│   └── *.test.ts         # one per tool module + parity tests
└── scripts/live-check.ts # the spec's live scenario, cleans up after itself

frontend/src/app/shared/utils/
├── export-build.ts       # NEW: pure buildExportFile(format, input) extracted from ExportDialogComponent.buildContent
└── export-build.spec.ts  # NEW
frontend/src/app/components/export-dialog/export-dialog.component.ts   # calls buildExportFile (behavior unchanged)

docs/mcp.md               # "Using Alfred from Claude (MCP)"
CLAUDE.md, AGENTS.md      # one pointer line each
```

**Structure Decision**: a separate top-level `mcp-server/` package with its own `package.json`, outside the Angular build and outside Docker. It reaches into `frontend/src/app` only through `src/frontend.ts`, so a frontend rename breaks one file and `npm run typecheck` catches it.

## Implementation phases (for /speckit.tasks)

1. **Skeleton**: package, tsconfig, `alfred-client`, `reply`, `frontend.ts` + `dom-shim`, `session` + `masking`, server start; smoke test: tools list over stdio; "Alfred down" error < 5 s.
2. **P1 read** (US1, US2): `list_cycles`, `get_cycle` (story + `layoutSpacers` + DB summary/findings), `get_call`, `get_call_body`, `db_*`, `trace_value`, `list_comments`; overview parity test.
3. **Field selection + search** (US5, FR-012a): `fields`/`paths`, `search_calls` with client-side filters and scan cap.
4. **Writes** (US3, US4, US6): comments (line computation shared with the panel), cycles, copy/remove with hydration, spacers, record/stop.
5. **Export** (US7): extract `buildExportFile` in frontend (+spec, dialog unchanged in behavior), `export_calls`, parity + re-import test.
6. **Docs + live check**: `docs/mcp.md`, CLAUDE.md/AGENTS.md lines, `live-check` against call 500d0cdc…, cleanup verified; full frontend `npm test && npm run build` once.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Export *fetch sequence* (hydrate, comments, overlaps, metadata, spacers, db captures) written a second time with `fetch` | Angular services use HttpClient/RxJS/DI and cannot run in the MCP process | Extracting a transport-agnostic fetcher from `cycle-export.service.ts` touches several UI services for no user benefit; a parity test comparing MCP export bytes with the frontend builders' output on the same data catches drift. Builders, redaction and analysis themselves are NOT duplicated. |
| New runtime dependency `jsdom` | Builders call `DOMParser` to pretty-print/validate XML; Node has none | `@xmldom/xmldom` reports errors without a `parsererror` element, so invalid-XML bodies would export differently from the UI. |
