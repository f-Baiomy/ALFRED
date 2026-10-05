---
description: "Task list for 007-alfred-mcp-server"
---

# Tasks: Alfred for Claude (MCP server)

**Input**: Design documents from `specs/007-alfred-mcp-server/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/tools.md](contracts/tools.md), [quickstart.md](quickstart.md)

**Tests**: Requested by the spec (unit tests against a fake Alfred + a live check). Test tasks are included per story.

**Organization**: grouped by user story; phases in priority order (P1: US1, US2 → P2: US3, US4, US6 → P3: US5, US7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- Paths are relative to the repo root `C:\projects\Alfred\Alfred`.

## Ground rules for whoever runs these tasks

- CodeGraph first (`codegraph explore "<symbols>"`) before reading frontend/backend code; never whole-file-read `styles.scss` or `proxy/interception.py`.
- No subagent fan-out. No push. Commit only with explicit paths.
- The MCP server never calls an endpoint outside [contracts/tools.md](contracts/tools.md) and never one listed under "Not exposed".
- Never log bodies, headers or rows (stderr: tool name, ids, sizes, ms only).
- Every frontend import goes through `mcp-server/src/frontend.ts` (one place to fix on a rename).
- Test commands: `cd mcp-server && npx tsx --test test/<file>.test.ts` (one file), `npm test` (all), `npm run typecheck`. Frontend single spec: `cd frontend && npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/shared/utils/export-build.spec.ts`.

---

## Phase 1: Setup

**Purpose**: the `mcp-server/` package exists, type-checks against the frontend files it imports, and starts over stdio.

- [X] T001 Create `mcp-server/package.json` (private, `"type": "module"`, engines node ≥ 22; pinned deps `@modelcontextprotocol/sdk`, `zod`, `jsdom`; pinned devDeps `tsx`, `typescript` (same major as `frontend/package.json`), `@types/node`, `@types/jsdom`; scripts `start: tsx src/index.ts`, `test: tsx --test test/*.test.ts`, `typecheck: tsc --noEmit`, `live-check: tsx scripts/live-check.ts`) and run `npm install` to create `mcp-server/package-lock.json`
- [X] T002 Create `mcp-server/tsconfig.json` (strict, `noEmit`, `"module": "ES2022"`, `"moduleResolution": "bundler"` - same as `frontend/tsconfig.json`, whose relative imports have no file extension and fail under `NodeNext`, `include`: `src`, `test`, `scripts`, and the imported `../frontend/src/app/shared/utils/**/*.ts` + `../frontend/src/app/core/models/**/*.ts` minus `*.spec.ts`; `typeRoots` so `@angular/core`/`rxjs` types resolve from `frontend/node_modules`)
- [X] T003 [P] Add `mcp-server/node_modules/` to the root `.gitignore` (check existing entries first) and create `mcp-server/README.md` with three lines pointing to `docs/mcp.md`

---

## Phase 2: Foundational (blocks every story)

**Purpose**: HTTP client, reply shaping, frontend bridge, session settings/masking, call hydration + field selection, DB capture assembly, fake Alfred, server bootstrap.

- [X] T004 Create `mcp-server/src/dom-shim.ts`: sets `globalThis.DOMParser` from `new JSDOM('').window.DOMParser` only if undefined; comment why (research R5: `body-format.ts`/`xml-tokenizer.ts` need a browser-like `parsererror`)
- [X] T005 Create `mcp-server/src/frontend.ts`: imports `./dom-shim` first, then re-exports from `../../frontend/src/app/...`: types (`CallRecord`, `CallDetail`, `CallDetailPart`, `CallSummaryDto`, `SessionCycle`, `CycleSpacer`, `Comment`, `CommentBlock`, `CapturedStatement`, `CallStatementsPage`, `CallDbSummary`, `CallDbCapture`, `CallDbAnalysis`, `RecordedQueryRequest`, `RecordedQueryResult`, `TraceHit`, `Redaction`), and functions `toCallRecord`, `callTime`, `supplierOf` (`shared/utils/call-utils.ts`), `buildOverview`, `findingSummary` (`db-findings.ts`), `analyzeCapture`, `timeBreakdown`, `queryTotals`, `suppliersOf` (`db-analysis.ts`), `layoutSpacers`, `spacerSlots` (`spacer-gap-controller.ts`), `redactCalls` (`redact.ts`), `detectAndFormatBody` (`body-format.ts`). Locate each symbol's real file/model with CodeGraph before writing the import (some types may live in `core/state/call-selection.tokens.ts` or `session-cycle.model.ts`)
- [X] T006 Create `mcp-server/src/alfred-client.ts`: `ALFRED_URL` (default `http://localhost:3000`, trailing slash trimmed), `get/post/patch/del<T>(path, {query?, body?})` over global `fetch` with `AbortSignal.timeout(4000)`, a 4-slot concurrency limiter, `encodeURIComponent` on path ids, typed `AlfredError{kind: 'unreachable'|'not_found'|'invalid'|'backend', status?, message, tried}`; 404 → `not_found`, 400 → `invalid`, network/timeout → `unreachable` with "start Alfred with `python3 start.py`" hint
- [X] T007 [P] Create `mcp-server/src/reply.ts`: `REPLY_BUDGET = 16_000`; `ok(value, meta?)` → MCP `{content:[{type:'text', text}]}` with compact JSON, refusing (throws in dev) a reply over budget so callers must page; `fail(err)` → `isError: true` + `{error, message, tried?}`; `chunkText(text, offset, length)` → `BodyChunk{text, offset, length, totalLength, nextOffset|null}`; `isBinary(contentType, text)` helper (image/*, application/octet-stream, gzip/zip, or >5% control chars) → report type + size only
- [X] T008 [P] Create `mcp-server/src/session.ts`: in-memory `SessionSettings{maskSecrets (initial `process.env.ALFRED_MCP_MASK === '1'`), exportFolder: string|null}`; `registerSessionTool(server)` for `session_settings` per contracts (validate `exportFolder` is an existing directory via `fs.stat`, store `path.resolve`d; `null` clears); tool description says masking-off sends recorded data to the model provider
- [X] T009 Create `mcp-server/src/masking.ts`: `resolveMask(override?: boolean)` (override ?? session.maskSecrets); `loadRedactions(client)` → `GET /redactions` once per tool call; `maskCalls(calls, redactions)` → `redactCalls`, returns `{calls, maskedValues}`; `maskCapture(call, capture, redactions)` → wraps the capture as `{...call, dbCapture: capture}`, runs `redactCalls` (so per-call `db-column` rules and `redactDbCapture` apply to params, rows, before-image rows and origin), returns the masked capture + count; `maskQueryResult(callId, result, redactions)` → blanks `RecordedQueryResult` cells whose column name is a `db-column` redaction for that call and runs `redactSecrets` over every remaining cell; `maskTraceValue` → when masking is on and the traced value itself matches a secret/redaction, the reply returns hits without echoing the value. Every DB tool goes through these - no DB reply bypasses masking. `withMaskMeta(reply, masked, maskedValues)` adds `masked`/`maskedValues` to every read reply (depends on T005, T006, T008). Export `redactSecrets` (and any `db-column` name helper it needs) through `src/frontend.ts`
- [X] T010 Create `mcp-server/src/calls.ts`: `Direction` ↔ source mapping (`inbound`=`internal-calls`, `outbound`=`calls`); `resolveSource(client, id, hint?)` (try `/internal-calls/{id}/summary`, then `/calls/{id}/summary`, or cycle endpoints when `cycleId` given); `hydrate(client, ref, cycleId?)` = `toCallRecord(summary, source)` merged with `/detail` (as `BulkActionsBarComponent.hydrateOne`); `fetchParts(client, ref, parts[], cycleId?)` using `?part=`; `toRow(call)` default CallRow; `select(call, fields?, paths?)` → `{values, missing[]}` with the field names from contracts and dot-path lookup (case-insensitive header keys) - fetch only the parts the selection needs. When an id is found in neither live store: if it is inbound-shaped or was asked as inbound, the `not_found` message says "no longer in the live log (inbound keeps the last 1,500 calls)" and, by scanning cycle call lists (summaries, `paged=true`), names the cycles that still hold a copy so Claude can retry with `cycleId`
- [X] T011 Create `mcp-server/src/db-capture.ts`: `loadCapture(client, callId)` → loops `GET /db-capture/calls/{id}/statements?afterSeq&limit=500` until `!hasMore`, plus `GET /db-capture/summaries?callIds=` (missing key → `not_found` "call has no database capture"), returns a `CallDbCapture`-shaped object; `overviewOf(client, call, capture)` → children from `GET /calls/{id}/children` → `analyzeCapture(call, capture, suppliersOf(call.id, children))`; `nonNoteFindings(analysis)` filter. No own findings logic
- [X] T012 Create `mcp-server/test/fake-alfred.ts`: `node:http` server on port 0 with a route table (method + path pattern → handler), request log for assertions, `start()/stop()`, and `ALFRED_URL` pointed at it per test; plus `mcp-server/test/harness.ts` that connects an MCP `Client` to the server over an in-memory transport (`InMemoryTransport.createLinkedPair()`) and calls tools by name
- [X] T013 Create `mcp-server/test/fixtures/` JSON fixtures shaped from real responses (fetch once from the running Alfred with `curl` and replace every secret/token/cookie value with placeholders): one outbound + one inbound summary and detail, `/calls/{id}/children`, a session cycle + its calls pages + spacers, comments, `/db-capture/summaries`, a 2-page statements response with flags (QUERY_FAN_OUT, a failure), one statement + rows, a query result, trace hits, `/redactions`
- [X] T014 Create `mcp-server/src/index.ts`: `McpServer({name:'alfred', version from package.json})`, registers session + all tool modules (each `src/tools/*.ts` exports `register(server, client)`), connects `StdioServerTransport`; uncaught errors go to stderr without call data
- [X] T015 Foundation tests in `mcp-server/test/foundation.test.ts`: unreachable Alfred → every tool kind returns `unreachable` within 5 s (SC-006); 404 → `not_found` naming the id; a dropped inbound id that sits in a cycle → message names the ring buffer and that cycle; `select()` returns only requested fields and lists unknown ones in `missing`; `chunkText` pages a 100 KB body to the end with no gap/overlap; masking on → `/redactions` applied and `maskedValues > 0`, off → untouched; `session_settings` rejects a non-existent folder

**Checkpoint**: `npm run typecheck` and `npm test` pass; `npm start` lists tools over stdio.

---

## Phase 3: User Story 1 - Debug a recorded session cycle (P1) 🎯 MVP

**Goal**: "debug the cycle X" returns the cycle story: calls in run order, spacers, comments, DB summary line + non-note findings.

**Independent test**: with a recorded cycle, Claude lists the calls in order, names the failing call, quotes its findings and cites a `File.java:line` from a statement's call chain (via US2's `db_statement`, or the findings' seqs).

### Tests

- [X] T016 [P] [US1] `mcp-server/test/cycles-read.test.ts`: `list_cycles` filters by name/status; `get_cycle` by id and by name text; two name matches → `candidates`; story merges inbound+outbound by time, places spacers exactly where `layoutSpacers` does (including a spacer anchored to a call on the previous page and a `top` spacer), shows comments under their call, and for a captured call shows `analysis.summary` and only non-note findings; paging returns `nextOffset` and never repeats a call

### Implementation

- [X] T017 [US1] Create `mcp-server/src/tools/cycles.ts` with `list_cycles` (`GET /session-cycles`, name-contains + status filter; `callCount` per cycle = `total` of `GET .../calls?paged=true&limit=1` + `total` of `GET .../internal-calls?paged=true&limit=1`, fetched with concurrency 4, as `SessionCycle` carries no count) and a shared `findCycle(client, idOrName)` (exact id → `GET /session-cycles/{id}`; else case-insensitive contains over the list; >1 match → `candidates`)
- [X] T018 [US1] Create `mcp-server/src/cycle-calls.ts` with `listCycleCalls(client, cycleId)` → `{calls: CallRecord[] (summaries, both sources, merged by callTime), spacers: CycleSpacer[]}`: fetches `GET /session-cycles/{id}/calls` and `/internal-calls` with `paged=true&sort=oldest-call`, paging at limit 200 to the end, plus `GET .../spacers` (reused by `get_cycle`, spacer tools T028 and export T036). Then in `mcp-server/src/tools/cycles.ts` add `get_cycle`: `listCycleCalls`, slice `offset/limit`, place spacers with `layoutSpacers`/`spacerSlots`, comments for the page's calls (`GET /comments?callId`, concurrency 4), `GET /db-capture/summaries` for the page's inbound calls and `overviewOf` for each captured one; apply `fields`/`paths` and masking; render Markdown story lines (`#n time dir METHOD url → status (ms)`, `── label ──`, `  💬 [block L<n>] text`, `  ◆ DB: summary`, `  ⚠ finding`) followed by the JSON block; respect the reply budget by lowering the page size and returning `nextOffset`

**Checkpoint**: US1 independently usable.

---

## Phase 4: User Story 2 - Drill into one call and its database statements (P1)

**Goal**: full call with paged bodies and supplier children; DB overview, statements, statement detail with call chain, SQL search, trace.

**Independent test**: call 500d0cdc-ed5b-459e-9afa-ef7c2996949f → overview shows the fan-out #19-#25 and the swallowed failure #42; `db_statement` for #42 shows its callers.

### Tests

- [X] T019 [P] [US2] `mcp-server/test/calls-read.test.ts`: `get_call` default returns headers, chunked bodies (`totalLength`, `nextOffset`), timing, children with ids, comments, db summary; `get_call_body` pages to the end; binary body reports type + size only; `fields:['method','url']` triggers no `/detail` request (assert via fake request log); `cycleId` reads the cycle copy endpoints
- [X] T020 [P] [US2] `mcp-server/test/db.test.ts`: `db_overview` output deep-equals `analyzeCapture` run directly on the same fixture (parity, SC-003); not-captured call → `not_found`; `db_statements` filters (failedOnly, slowMicros, kind, table, text) and pages; `db_statement` returns full SQL, params, rows page, callers, origin; `db_query` passes `{mode,text,offset,limit}` and cuts cells at 300 chars with full length noted; `trace_value` maps hits. Masking on, with a `db-column` redaction for the call: the hidden column's values are absent from `db_overview`, `db_statements` (SQL preview params), `db_statement` (params, rows, before-image rows), `db_query` cells and `trace_value`; a `redactSecrets` secret value inside a query cell is masked; `maskedValues` counts them. Masking off: values verbatim

### Implementation

- [X] T021 [P] [US2] Create `mcp-server/src/tools/calls.ts` with `get_call` (default = full call via `hydrate`, bodies through `chunkText` with `bodyOffset/bodyLength`, inbound → children from `/calls/{id}/children` as short rows, comments, db summary line when captured; `fields`/`paths` path uses `select`; masking) and `get_call_body` (`part`, `offset`, `length`)
- [X] T022 [P] [US2] Create `mcp-server/src/tools/db.ts` with `db_overview` (`loadCapture` + `overviewOf`, queries top 20 + count), `db_statements` (filters applied over loaded statements, `sqlPreview` 160 chars, `durationMs`), `db_statement` (`GET /db-capture/statements/{id}` + `.../rows?part&offset&limit`, SQL chunked if over budget), `db_query` (`POST /db-capture/calls/{callId}/statements/query`), `trace_value` (`GET .../trace?value=`); when masking resolves on, every reply passes through `maskCapture` / `maskQueryResult` / `maskTraceValue` (T009) before shaping - for `db_statement`, build a one-statement capture (statement + fetched rows) so the same `redactDbCapture` path masks it
- [X] T023 [P] [US2] Create `mcp-server/src/tools/comments.ts` with `list_comments` (`GET /comments?callId`, `line = lineIndex + 1`, `byClaude = comment.startsWith('🤖 Claude: ')`)

**Checkpoint**: US1 + US2 = MVP for debugging.

---

## Phase 5: User Story 3 - Record findings back into Alfred (P2)

**Goal**: Claude adds a comment on the right block and line, marked as Claude's; can delete it.

**Independent test**: comment on line 12 of a response body appears on that line in the UI, prefixed 🤖.

- [X] T024 [US3] Find the pure text→lines path the call card uses for comment line numbers (`json-panel.component.ts` `baseText`/`allLines`, `parsed()`; CodeGraph `JsonPanelComponent baseText parsed splitTokensIntoLines`) and confirm it equals `detectAndFormatBody(text).body.split('\n')` for JSON, XML and headers; if it differs, extract the panel's text derivation into a pure function in `frontend/src/app/shared/utils/` used by `json-panel.component.ts` (no behavior change) with a spec, and export it through `mcp-server/src/frontend.ts`
- [X] T025 [US3] Add `add_comment` and `delete_comment` to `mcp-server/src/tools/comments.ts`: fetch the block via `?part=`, compute lines with the T024 function, pick `line` (1-based) or first line containing `lineMatch` (error listing nearest matches if none), default line 1; `POST /comments {callId, block, lineIndex, lineText, comment: '🤖 Claude: ' + text}`; `DELETE /comments/{id}`
- [X] T026 [P] [US3] `mcp-server/test/comments.test.ts`: line computed on pretty-printed JSON and XML matches the panel function; `lineMatch` picks the right line; posted body has prefix and correct `lineText`; delete of unknown id → `not_found`

---

## Phase 6: User Story 4 - Organise evidence into session cycles (P2)

**Goal**: create (empty or from live calls), rename, copy in, remove, spacers add/rename/move/delete.

**Independent test**: "put the flight search call into a new cycle 'fan-out repro' with a spacer 'search' above it" → visible in Session Cycles.

- [X] T027 [US4] Add to `mcp-server/src/tools/cycles.ts`: `create_cycle` (`POST /session-cycles {name}` then optional copy), `rename_cycle` (`PATCH /session-cycles/{id} {name}`), `add_calls_to_cycle` (hydrate each ref, group by source, `POST .../calls/copy` / `.../internal-calls/copy` in batches of 20, per-item report `{added, skipped, notFound[]}`), `remove_calls_from_cycle` (`POST .../{calls|internal-calls}/remove {callIds}` grouped by source, report `{removed, notFound}`)
- [X] T028 [P] [US4] Create `mcp-server/src/tools/spacers.ts`: `add_spacer`, `move_spacer` (resolve `afterCallId` among the cycle's calls from `listCycleCalls` → send its own `timestamp` as `anchorTimestamp`; `'top'` → both null; call not in cycle → `invalid`), `rename_spacer` (`PATCH .../spacers/{id} {label}`), `delete_spacer` (`DELETE .../spacers/{id}`)
- [X] T029 [P] [US4] `mcp-server/test/cycles-write.test.ts`: copy posts full hydrated records (request/response present) to the right endpoint per source; mixed batch with one bad id → added 1, notFound [id]; create-from-calls creates once then copies; remove groups by source; spacer anchor = that call's timestamp; move to a call outside the cycle → `invalid`; no tool ever hits `DELETE /session-cycles/{id}` or `/calls/clear` (assert on the fake's log)

---

## Phase 7: User Story 6 - Record a session cycle while reproducing (P2)

**Goal**: start/stop recording from the conversation.

**Independent test**: start, send two requests through odeysys, stop → cycle has exactly those calls.

- [X] T030 [US6] Add `start_recording` / `stop_recording` to `mcp-server/src/tools/cycles.ts`: read current cycle, `POST .../record` or `.../pause`, return `{cycle, changed}`; `start_recording` also lists other cycles with status RECORDING (`otherRecording`); a Relive-run cycle (`reliveRunId`) → `invalid` "a Relive run's cycle never records"
- [X] T031 [P] [US6] `mcp-server/test/recording.test.ts`: idempotent start/stop report `changed:false` without a second state change; `otherRecording` lists the others; Relive cycle refused; `get_cycle`/`list_cycles` show status

---

## Phase 8: User Story 5 - Find calls without a cycle (P3)

**Goal**: search live calls by project, direction, text, status, failed, slow, time range; short rows or chosen fields.

**Independent test**: "which odeysys calls failed in the last 15 minutes?" → short list with ids.

- [X] T032 [US5] Add `search_calls` to `mcp-server/src/tools/calls.ts`: server-side `search` (text), `supplier`, `serviceNames` (project, inbound), `sort`; page summaries newest-first at limit 200, apply status class / failed (status ≥ 400 or error) / `slowMs` / `from`/`to` client-side, stop at first row older than `from` or at the 2,000-row scan cap; `both` merges inbound+outbound by time; return `{scanned, scanCapHit, offset, nextOffset, calls}` with `select` + masking applied
- [X] T033 [P] [US5] `mcp-server/test/search.test.ts`: each filter alone and combined; `both` ordering; pagination without repeats; scan cap reported; `fields:['method','url']` reply ≥ 10× smaller than full rows for 100 calls (SC-010)

---

## Phase 9: User Story 7 - Export calls as files (P3)

**Goal**: .md/.json/.html of a cycle, chosen calls or a search result, identical to the UI's, written where the user says or to the session default folder.

**Independent test**: export a cycle as html to a named path; file matches the UI export of the same cycle.

- [X] T034 [US7] Extract `ExportDialogComponent.buildContent` (`frontend/src/app/components/export-dialog/export-dialog.component.ts:305-361`) into pure `buildExportFile(format: 'markdown'|'html'|'json'|'postman', input)` in `frontend/src/app/shared/utils/export-build.ts` (input: calls, form, commentsByCallId, overlapCandidates, statusFilter, cycle, spacers, listOrder, redactions, rows, exportedAt, fileName) - it ALWAYS runs `redactCalls` first and returns `{kind:'lines'|'payload'|'text', ..., filename, mimeType, redactedValueCount}`; make the dialog call it with no behavior change (redactedValueCount computed signal keeps working)
- [X] T035 [P] [US7] `frontend/src/app/shared/utils/export-build.spec.ts`: each format picks the same builder/filename the dialog did (single call vs bulk vs cycle); a redaction rule always masks (cannot be bypassed); fixtures built with `buildBulkExportPayload`; run with `ng test --include`
- [X] T036 [US7] Create `mcp-server/src/tools/export.ts` `export_calls`: resolve source (`cycleId` → `listCycleCalls` (calls + spacers) + `GET .../call-overlaps` + cycle meta; `calls` → hydrate; `search` → run the search_calls core, all pages to the cap), hydrate every call, comments per call, `POST /calls/export-metadata`, `GET /redactions`, when `includeDb` per inbound call `GET /db-capture/calls/{id}/export` + children → `analyzeCapture` (as `ExportDialogComponent.loadDbCaptures`, 404 = not captured); call `buildExportFile`; mirror `cycle-export.service.ts` order and inputs exactly (read it with CodeGraph first)
- [X] T037 [US7] In `mcp-server/src/tools/export.ts` add path resolution + writing: absolute `path` → use; relative or missing → join to `session.exportFolder`; neither → `{needsPath:true, suggestedName}` and write nothing; existing file without `overwrite` → `invalid`; write to `<target>.tmp-<pid>` via `fs.createWriteStream` line by line (json lines joined by `\n`, never one string), then `rename`; reply `{path, bytes, calls, redactedValues}`, never the content
- [X] T038 [P] [US7] `mcp-server/test/export.test.ts`: md/html/json bytes equal the frontend builders' output for the same fixture except `exportedAt`/generation timestamps (SC-008); .json parses back with `import-parser.ts` to the same calls; no path + no folder → `needsPath`, nothing on disk; session folder used for no-path and relative path; overwrite guard; redaction applied even with `maskSecrets` off

---

## Phase 10: Polish & cross-cutting

- [X] T039 Create `mcp-server/scripts/live-check.ts` (spec live scenario against the running Alfred): find call 500d0cdc-ed5b-459e-9afa-ef7c2996949f, assert overview findings include QUERY_FAN_OUT over #19-#25 and a swallowed failure at #42, `db_statement` #42 has callers; add a comment; create cycle `mcp-live-check-<timestamp>`, copy the call in, add a spacer, export md/json/html to an OS temp dir; recording (SC-009): create a second cycle `mcp-live-rec-<timestamp>`, `start_recording`, send two GET requests through a reverse-proxy listener with inbound logging on (port/project read from `GET /internal-calls/services`; skip with a printed reason if none is enabled), `stop_recording`, send one more, wait 2 s, assert the cycle holds exactly the two calls made between start and stop; then clean up: delete the comment via `delete_comment` and both test cycles via a direct `DELETE /session-cycles/{id}` in the script (not a tool; a cycle still recording is paused first, as delete returns 409 while recording), and assert all are gone - cleanup runs in `finally`. Add a `--pause` flag that stops after the writes and waits for Enter before cleanup, for the UI check in T043
- [X] T040 [P] Write `docs/mcp.md` "Using Alfred from Claude (MCP)": what it is, install, user-scope registration and `.mcp.json` alternative (from quickstart.md), `ALFRED_URL`/`ALFRED_MCP_MASK`, session settings (masking, export folder), the tool table, typical prompts (debug a cycle, drill into DB, comment, record, export), what is deliberately not exposed, the data warning, troubleshooting (Alfred down, `frontend/node_modules` missing, gateway 502 after backend rebuild)
- [X] T041 [P] Add one line to the "Detailed docs" list in `CLAUDE.md` (`docs/mcp.md — Using Alfred from Claude (MCP): tools, setup, session settings`) and one line to the project map in `AGENTS.md` describing `mcp-server/` (local stdio, no container, imports frontend pure utils)
- [X] T042 Run `cd mcp-server && npm run typecheck && npm test`, then `cd frontend && npm test && npm run build` once; fix failures
- [X] T043 Live UI check (FR-018, SC-004): open `http://localhost:3000` in the browser pane on Session Cycles, run `cd mcp-server && npm run live-check -- --pause`, and confirm without reloading - by `read_page` within 2 s of each write - that the test cycle appears, the copied call is in it, the spacer sits above it, and the 🤖 comment shows on the call; screenshot as proof; press Enter to let cleanup run and confirm (again without reload) that comment and cycles disappear. Record pass/fail lines in the final report
- [ ] T044 Register with `claude mcp add --scope user alfred -- node C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs C:/projects/Alfred/Alfred/mcp-server/src/index.ts` only after asking the owner (it changes their Claude config); then commit with explicit paths: `mcp-server/` (no node_modules), `frontend/src/app/shared/utils/export-build.ts`, `export-build.spec.ts`, `export-dialog.component.ts`, any T024 extraction, `docs/mcp.md`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`, `specs/007-alfred-mcp-server/`

---

## Dependencies & execution order

- Phase 1 → Phase 2 → stories. Inside Phase 2: T004 → T005 → (T006, T007, T008 parallel) → T009, T010, T011 → T012, T013 → T014 → T015.
- **US1** (T016-T018) needs Phase 2 (uses `db-capture.ts`, `calls.ts`).
- **US2** (T019-T023) needs Phase 2 only; independent of US1 (no shared files).
- **US3** (T024-T026) needs T023 (`comments.ts` exists).
- **US4** (T027-T029) needs T017 (`cycles.ts`, `findCycle`) and T018 (`cycle-calls.ts` `listCycleCalls`, used by T028).
- **US6** (T030-T031) needs T017.
- **US5** (T032-T033) needs T021 (`tools/calls.ts`).
- **US7** (T034-T038) needs T032 (search source) and T018 (`listCycleCalls`); T034/T035 (frontend) can run any time after Phase 1.
- Polish after all stories.

## Parallel examples

- Phase 2: T007 `reply.ts` and T008 `session.ts` together after T006.
- US2: T021 `tools/calls.ts`, T022 `tools/db.ts`, T023 `tools/comments.ts`, plus tests T019/T020 - all different files.
- US4: T028 `spacers.ts` alongside T027 `cycles.ts` writes.
- US7: T034/T035 (frontend) alongside T032 (MCP search).
- Polish: T040 docs and T041 CLAUDE/AGENTS lines together.

(Per CLAUDE.md, "parallel" here means order-independent for one session, not a subagent fan-out.)

## Implementation strategy

1. **MVP** = Phase 1 + 2 + US1 + US2: Claude can debug a cycle and drill into calls and statements from odeysys. Stop and let the owner try it (register manually).
2. Then US3 (comments) + US4 (cycle editing) + US6 (recording) - the write side.
3. Then US5 (search) + US7 (export, incl. the one frontend refactor).
4. Polish: docs, full suites, live check, registration (asked), commit.

## Implementation notes (2026-10-05)

- T013: fixtures are synthetic but shaped from real responses (`mcp-server/test/fixtures.ts`), not JSON copied from the running Alfred - no recorded body, token or row is committed.
- T014: the server is built in `src/server.ts` (`createServer`) so the stdio entry (`src/index.ts`) and the in-memory test harness share it.
- T024: the call card's comment lines equal `detectAndFormatBody(text).body` for bodies and pretty JSON of the header object for headers (json-panel `baseText`), so no frontend extraction was needed.
- Found while testing live: Alfred creates a cycle already RECORDING, so `create_cycle` pauses it unless `record: true`; cycle `remove` takes the cycle's own entry id (mapped from the call id); Node `fetch` to `localhost` resolves IPv6 first, so the live check uses `127.0.0.1`.
- Registration documented as `node <mcp-server>/node_modules/tsx/dist/cli.mjs <mcp-server>/src/index.ts` (no npm/npx, so no `cmd /c` on Windows); `scripts/stdio-check.ts` proves both launch forms over real stdio from another folder.
- T042: frontend 2235/2235 tests, build OK; its bundle-budget warning (27.97 kB over) is identical without this change.

## Follow-up: bug report from a real odeysys session (2026-10-05)

- Bug 1 (`fields` bodies empty): a part request answers the other half with explicit nulls, which overwrote a body fetched by another part. Fixed in `withParts`; the fake Alfred now answers parts with the same nulls; regression test reads one body five ways.
- Bug 2 (`get_cycle` children/db "missing"): extras now filled in the story.
- Bug 3 (supplier calls missing): not a bug - one outbound call and one agent marker; the rest came from the app's cache.
- Live UI for every MCP edit: cycles/spacers/calls were already signalled; comments were not. New `/ws/comments` (backend-comments `CommentNotificationPort`), `CommentsStore` re-reads a loaded call on the signal (`COMMENT_EVENTS`).
- Improvements: soft failures and empty results (`shared/utils/soft-failure.ts`, shared with exports), supplier calls under inbound calls, body previews, OPTIONS hidden by default, compact field rows, `appHost` for inbound, whole-call comments (`block: 'call'` - card notes + exports), `add_comments`, `suggest_spacers`, `wait_for_calls` (WebSocket-driven, ≤ 60 s), `Local` environment, XML/form body redaction + `add_default_redactions`, `includeDb: "summary"` for .md/.html, "At a Glance" at the top of bulk exports (`export-highlights.ts`). No per-export `redact: false` (owner decision).
