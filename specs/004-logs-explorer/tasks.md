---
description: "Implementation tasks for Logs Explorer, written for an implementer who has not seen the planning discussion"
---

# Tasks: Logs Explorer

**Input**: `specs/004-logs-explorer/` - [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/rest-api.md](./contracts/rest-api.md),
[contracts/log-query.md](./contracts/log-query.md), [contracts/ui-mock-map.md](./contracts/ui-mock-map.md),
[quickstart.md](./quickstart.md), **[mock.html](./mock.html)** (the approved UX; every UI task names the mock
function to copy layout, wording and behaviour from).

**Tests**: included. Constitution VI requires them; every behaviour task is followed by the test that proves it.

**Gate**: do not start any task until the owner has explicitly said "start".

## Read this first (every implementer, every task)

1. **Source of truth**: spec.md Clarifications (both 2026-10-03 sessions) win over anything else. Later bullets
   override earlier ones (e.g. line identity is input + position, NOT content hash).
2. **UI reference**: open `mock.html` in a browser; the purple bar jumps between screens. Its `<script>` is plain
   JS. Each UI task names the mock functions to read (e.g. `rowHtml()`, `bulkBar()`). Copy **layout, wording,
   states, order of controls and keyboard shortcuts**, not its code style: the real app is Angular standalone
   components + signals. Mock CSS classes map to a new `frontend/src/styles/_logs.scss` using the existing design
   tokens of `frontend/src/styles.scss` (grep the `--` custom properties; never read the whole ~10k-line file).
   `contracts/ui-mock-map.md` is the element-by-element checklist.
3. **Code search**: use `codegraph explore "<symbols>"` (or the `codegraph_explore` MCP tool) before Grep/Read.
4. **Reuse, don't fork**: when a task says "reuse X", import X. Named reuse targets are in research.md §R12.
5. **Backend build**: bare `mvn` may run JDK 8; use the Docker JDK 21 command in quickstart.md, mounting the repo
   root. Frontend single spec: `npx ng test --watch=false --browsers=ChromeHeadless --include=<spec>`.
6. **Paths**: `BL` = `backend/backend-logs/src/main/java/com/fathy/alfred/backend/logs`,
   `BLT` = `backend/backend-logs/src/test/java/com/fathy/alfred/backend/logs`, `FE` = `frontend/src/app`.
7. **Never** log line content (ids, sizes, counts only); never use `innerHTML`/`bypassSecurityTrust*` for line
   data; every client-supplied size is clamped server-side (limits in contracts/rest-api.md).

## Open decision (blocks T017's secret table, T076, T078, T080, T083)

**C1 - secrets** (from /speckit-analyze): the constitution (I) says credentials and tokens MUST come from env/config.
The current design stores user-entered OpenSearch passwords in `logs.db` and per-source push tokens. The owner has
deferred the choice between (a) push uses the existing `X-Webhook-Secret` and OpenSearch credentials are referenced
by env-variable name, or (b) a constitution amendment allowing write-only stored credentials. Do not implement the
listed tasks until the owner decides.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1…US8 from spec.md

---

## Phase 1: Setup (shared infrastructure)

- [X] T001 Create module `backend/backend-logs/pom.xml` (copy `backend/backend-relive/pom.xml` deps: web, validation, websocket, jdbc, sqlite-jdbc, HikariCP, test) and the empty package tree under `BL/` per plan.md "Source Code"
- [X] T002 Register the module: add `backend-logs` to `<modules>` in `backend/pom.xml`, as a dependency in `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`
- [X] T003 Add ArchUnit rule `logsSliceMustNotDependOnOtherSlices` (no imports of any other slice package) in `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java`, modelled on the relive rule
- [X] T004 [P] Add `alfred.storage.logs.type=sqlite`, `LOGS_DB_FILE`, `LOGS_UPLOAD_DIR`, `LOGS_ROOT_DIR=/logs`, `LOGS_FOLLOW_STAT_MS=1000`, `LOGS_PUSH_MAX_BYTES=10485760`, `LOGS_MIN_FREE_BYTES=2147483648` defaults in `backend/backend-app/src/main/resources/application.properties`
- [X] T005 [P] In `docker-compose.yml` backend service add `LOGS_DB_FILE=/appdata/logs.db` and the read-only volume `${ALFRED_LOGS_DIR:-./logs-drop}:/logs:ro`; add `logs_drop_dir` to `settings.properties` and its `.env` gap-fill in `start.py`/`restart.py` `sync_env_from_settings()` (setdefault only); add `logs-drop/` to `.gitignore`
- [X] T006 [P] In `gateway/nginx.conf` add `logs` to the backend prefix regex (line ~42) and `logs` to the `$spa_page` map (line ~20) so a browser reload of `/logs` serves the SPA
- [X] T007 [P] Create `frontend/src/styles/_logs.scss` (import it from `styles.scss`) with the mock's classes translated to theme tokens: `.qp.*` pill colours, `.lvl.*`, `.stripe`, `.cdot`, `.dur`, `.lv`/`.mk` chips, `.jl`/`.cbtn`, `.minimap`, `.kv`, `.hist` (source: mock `<style>`)
- [X] T008 [P] Add routes `logs`, `logs/new`, `logs/:id`, `logs/:id/structure` (lazy) in `FE/app.routes.ts` and the "Logs" nav tab with the NEW badge between Relive Cycles and Settings in the header component (mock `.nav`)

---

## Phase 2: Foundational (blocks every story)

### Domain + pure ingest logic

- [X] T009 [P] Domain records/enums in `BL/domain/model/`: `LogSource`, `RawMode`, `PrivacyMode`, `RemoteMode`, `LogStructure`, `FieldDef`, `FieldType`, `SearchMode`, `Role`, `GroupLevel`, `GroupSort`, `LogInput`, `InputKind`, `InputStatus`, `LogLine`, `LogLineSummary`, `LogPage`, `IngestProgress` exactly as data-model.md
- [X] T010 [P] `LogQuery` model (`Pill`, `Op` = EQ/NEQ/GT/LT/BETWEEN/EXISTS/NOT_EXISTS/TEXT/SELECTION, `Sort`, `Cursor`) in `BL/domain/model/LogQuery.java` per contracts/log-query.md, with a `validate()` clamping pills ≤ 50, selection ≤ 10,000, limit ≤ 500
- [X] T011 [P] `Flattener` in `BL/domain/ingest/Flattener.java`: Jackson `JsonNode` → ordered `Map<path,value>`; `.` paths; unwrap one-element arrays; keep multi-element arrays as JSON text
- [X] T012 [P] `ObjectTextParser` in `BL/domain/ingest/ObjectTextParser.java`: parse `Name(k=v, k2=v2, …)` (nested parens, values with commas inside parens) into key/values; returns empty when not that shape
- [X] T013 [P] `ValueTyper` in `BL/domain/ingest/ValueTyper.java`: convert text → typed value for DATE/DATETIME (ISO-8601, epoch s/ms by magnitude, user pattern + zone), NUMBER (unit stripped), BOOLEAN (true/false words, 1/0); returns empty on mismatch (never throws)
- [X] T014 `StructureDetector` in `BL/domain/ingest/StructureDetector.java`: from ≤ 1,000 sample lines build `FieldDef`s with type (≥ 95 % rule), matchRate, invalidCount, boolean suggestion for 0/1, role guesses, label (path minus wrapper prefixes, unique), JSON-in-string unpack + `duplicateOf`, `ObjectTextParser` children; structure id = hash of sorted paths (research §R5)
- [X] T015 [P] Tests `BLT/domain/ingest/FlattenerTest.java`, `ObjectTextParserTest.java`, `ValueTyperTest.java`
- [X] T016 Test `BLT/domain/ingest/StructureDetectorTest.java` using the full OpenSearch hit from spec.md's discussion as a fixture file `BLT/../resources/fixtures/opensearch-hit.ndjson` and a raw `detail.log` body line: asserts `_source.body` unpacked and marked duplicate, `LoginDTO(...)` parsed, `fields.*` arrays unwrapped, `@timestamp` DATETIME, `ERROR_flag` NUMBER with boolean suggestion, roles guessed

### Storage

- [X] T017 `SqliteLogsRepository` in `BL/adapter/out/sqlite/SqliteLogsRepository.java`: Hikari pool + PRAGMAs copied from `SqliteReliveRepository`; base tables `log_source`, `log_structure`, `log_field`, `log_input`, `log_comment`, `log_saved_view`, `log_secret`, `log_upload`; per-source DDL helpers `createSourceTables(id)` (`ll_`, `fts_` trigram external-content, `lg_`, `lp_`) and `addFieldColumns(id, n, typed)` (`ALTER TABLE ADD COLUMN f<N>`/`t<N>`); `@ConditionalOnProperty(prefix="alfred.storage.logs", name="type", havingValue="sqlite", matchIfMissing=true)`
- [X] T018 Out ports in `BL/application/port/out/`: `LogSourceStorePort`, `LogLineStorePort` (appendBatch, query, get, context, histogram, fieldValues, stats, delete-oldest), `LogGroupStorePort`, `LogPatternStorePort`, `LogCommentStorePort`, `LogInputStatePort`, `RawLineReaderPort`, `LineSourcePort`, `RemoteLogQueryPort`, `LogNotificationPort`, `SecretStorePort`
- [X] T019 `SqliteLogQueryTranslator` in `BL/adapter/out/sqlite/SqliteLogQueryTranslator.java`: `LogQuery` → parameterised SQL per the table in contracts/log-query.md (typed columns for typed fields, FTS `MATCH` for TEXT ≥ 3 chars else `LIKE` flagged slow, keyset cursor); field labels resolved through `log_field` only (never string-concatenate user input into SQL)
- [X] T020 [P] Test `BLT/adapter/out/sqlite/SqliteLogQueryTranslatorTest.java`: each op, NEQ/NOT_EXISTS include missing fields, GT on string field rejected, cursor clause, injection attempt in value stays a parameter
- [X] T021 `SqliteLogSourceStoreAdapter` and `SqliteLogLineStoreAdapter` in `BL/adapter/out/sqlite/`: batch insert in one transaction (lines + FTS rows), keyset query returning `LogLineSummary` (role + template + column fields only), get full line, context by `(input_id, byte_offset)` order, retention delete-oldest skipping `pinned=1`
- [X] T022 Test `BLT/adapter/out/sqlite/SqliteLogLineStoreAdapterTest.java` on `@TempDir`: 20k-line batch, keyset paging stable across pages, FTS fragment `anotrav` finds `evilanotravel@…`, Exact filter, new field `ALTER TABLE` mid-ingest, retention keeps pinned lines

### Ingest pipeline + notifications

- [X] T023 `LogIngestService` in `BL/application/service/LogIngestService.java`: consumes `LineSourcePort` `(bytes, inputId, offset)`; Jackson parse (line > 16 MB or invalid → unparsed row with raw); `Flattener` → `ValueTyper` per field → `GroupKeyer` (stub returning level 0 until US4) → batch of 5,000 → `appendBatch` + input position saved in the same transaction; new fields → `addFieldColumns`; retention check after each batch; progress via `LogNotificationPort`; heap independent of file size; before each batch check `Files.getFileStore(dbDir).getUsableSpace()` against `LOGS_MIN_FREE_BYTES` → input `PAUSED` with reason `LOW_DISK` (FR-046); compare each line's path set with the structure and mark lines missing more than half of its fields `structure_mismatch=1`, counted per input (FR-045)
- [X] T024 [P] WebSocket `/ws/logs` in `BL/adapter/out/websocket/` (`LogsWebSocketConfig`, `LogEventsWebSocketHandler`, `WebSocketLogNotificationAdapter`) copying the scenarios shape; events from contracts/rest-api.md "WebSocket"
- [X] T025 Test `BLT/application/service/LogIngestServiceTest.java` with fake ports: batches of 5,000, unparsed line kept, position saved per batch, new field mid-file announced, retention invoked
- [X] T026 [P] Frontend `FE/core/services/logs-api.service.ts` (all endpoints of contracts/rest-api.md, typed) and `FE/core/services/logs-socket.service.ts` using the existing reconnecting socket helper (as `relive-socket.service.ts`); models in `FE/core/models/logs.model.ts` mirroring data-model.md
- [X] T027 [P] `FE/shared/utils/logs-time.ts`: format epoch ms in a source's IANA zone (`Intl.DateTimeFormat`), hover text = UTC + raw value; spec `logs-time.spec.ts`

**Checkpoint**: module builds, ArchUnit passes, ingest + query proven by tests.

---

## Phase 3: User Story 1 - Load a large log file and browse it (P1) 🎯 MVP

**Goal**: create a source from an uploaded or server file, watch it load, browse lines and open any line in full.
**Independent test**: quickstart.md scenario 1 (10 GB file, random line equals file line).

- [X] T028 [P] [US1] `UploadLineSource` + `LogUploadController` (`POST /logs/uploads`, `PUT …/chunks/{n}` ≤ 40 MB, `GET …/uploads/{id}`, complete = size + SHA-256 check, streamed assembly into `LOGS_UPLOAD_DIR`) in `BL/adapter/out/input/` and `BL/adapter/in/web/`
- [X] T029 [P] [US1] `ServerFileLineSource` + `GET /logs/server-files?dir=` in `BL/adapter/out/input/ServerFileLineSource.java`: only under `LOGS_ROOT_DIR` (`normalize()` + `startsWith`), counting stream yielding byte offsets
- [X] T030 [P] [US1] `OffsetRawLineReader` in `BL/adapter/out/rawfile/OffsetRawLineReader.java`: seek + read one line; returns `rawUnavailable` reason when file missing or fingerprint changed
- [X] T031 [US1] Use cases + `LogsService` for create/list/rename/delete source (+ `GET …/delete-impact`), add/pause/resume/retry/delete input (fingerprint → 409 `DUPLICATE_FILE` unless `confirmDuplicate`), list lines, get line, context in `BL/application/port/in/` and `BL/application/service/LogsService.java`
- [X] T032 [US1] Controllers `LogSourcesController`, `LogInputsController`, `LogQueryController` (lines, line, context) with `@Valid` DTOs and clamps in `BL/adapter/in/web/`
- [X] T033 [P] [US1] `@WebMvcTest`s `BLT/adapter/in/web/LogUploadControllerTest.java`, `LogInputsControllerTest.java` (traversal 400, duplicate 409, chunk > 40 MB 413), `LogQueryControllerTest.java` (limit clamp)
- [X] T034 [US1] Sources page `FE/pages/logs/logs-sources.component.ts|html` + `FE/components/logs/log-input-row.component.ts`: cards, input rows, status pills, `⋯` menu, live progress from socket, delete confirmation via `ConfirmDialogService` with delete-impact counts, pause reason "Paused: low disk space (N GB free)" with Resume (mock `renderSources()`, delsrc dialog, low-disk row)
- [X] T035 [US1] Wizard `FE/pages/logs/log-source-wizard.component.ts|html`: steps bar, kind cards, Upload + File-on-server forms (`FE/components/logs/log-input-form.component.ts`), raw-mode segment + hint, chunked resumable upload with progress, duplicate-file confirm (mock `renderWizard()`, `wizInput()`)
- [X] T036 [US1] Load step `FE/components/logs/log-load-progress.component.ts`: bar, lines/bytes/time-left, unparsed count, "new field found", low-disk pause notice, "Open explorer now →" (mock `wizLoad()`)
- [X] T097 [US1] "Different structure" lines: input-row badge "N lines with a different structure" + action "Start new source from them" calling `POST …/inputs/{inputId}/split` (service copies those lines into a new source and detects its structure); test in `BLT/application/service/LogsServiceTest.java` (mock `renderSources()` mismatch badge)
- [X] T098 [US1] Source settings dialog from the card `⋯` menu: retention max size (GB) and max age (days), saved with `PATCH /logs/sources/{id}`; values clamped server-side (data-model.md LogSource) (mock `renderSources()` Settings dialog)
- [X] T037 [US1] Explorer shell `FE/pages/logs/logs-explorer.component.ts|html` + `FE/core/state/logs-explorer-state.service.ts` (signals: query, rows, cursor, openData, sel, drawer) - header, list, footer counts; refetch on `/ws/logs lines-added` only (mock `renderExplorer()`)
- [X] T038 [US1] List + row `FE/components/logs/log-list.component.ts` (cdk virtual scroll, flattened `LogRowItem` union, keyset paging on scroll) and `log-row.component.ts` (level stripe, data toggle, time in source zone, level badge, summary, correlation dot, duration bar, ⇥ drawer) (mock `headRow()`, `rowHtml()`)
- [X] T039 [US1] Data panel `FE/components/logs/log-data.component.ts` with Table|JSON segment, Copy, Open in drawer; `log-table-view.component.ts` (full values, wrapping) and `log-json-view.component.ts` built on `FE/shared/utils/logs-json-lines.ts` + existing `JsonTokensComponent` with folding (mock `dataHtml()`, `tableHtml()`, `jsonLines()`)
- [X] T040 [US1] Drawer `FE/components/logs/log-drawer.component.ts` with tabs Fields, Raw (byte count), Context (±20, current highlighted); Trace/Comments tabs come in US8 (mock `renderDrawer()`)
- [X] T041 [P] [US1] Spec `FE/shared/utils/logs-json-lines.spec.ts`: one line per value, one-element arrays share the flattened path, fold state, 5 MB string never truncated
- [X] T042 [US1] Keyboard on the explorer host: `j`/`k`, `Enter`, `/` (mock `keydown` listener)

**Checkpoint**: US1 independently usable (MVP).

---

## Phase 4: User Story 2 - Describe the structure (P1)

**Goal**: types, formats, search modes, roles, sensitive flag, template, time zone, privacy, default data view.
**Independent test**: quickstart.md scenario 2.

- [X] T043 [US2] `POST /logs/structure/preview` (detect from the first 1,000 lines of a draft input without storing) and `GET/PUT …/structure` in `BL/application/service/LogsService.java` + `LogSourcesController`; the preview returns `matchingSource` when an existing source has the same structure id, and the wizard offers "Use settings from ‹source›" (default on) and skips the structure step (FR-048); test in `BLT/application/service/LogsServiceTest.java` (same id ⇒ settings reused) (mock `wizStructure()` same-structure banner)
- [X] T044 [US2] `StructureRebuildService` in `BL/application/service/StructureRebuildService.java`: single-thread executor per source; re-type (`UPDATE … t<N>` chunks of 50,000), search-mode change (create/drop index, rebuild FTS columns); `structure-changed` / `rebuild-done` events; `GET …/fields/{label}/invalid`
- [X] T045 [US2] Privacy at ingest in `LogIngestService`: `REDACT_AT_LOAD` replaces sensitive values in `f<N>` and `raw` (forces COPY mode, rejected with OFFSET in `@Valid`)
- [X] T046 [P] [US2] Tests `BLT/application/service/StructureRebuildServiceTest.java` (re-type keeps originals, invalid listed) and redact-at-load case in `LogIngestServiceTest`
- [X] T047 [US2] Structure editor `FE/pages/logs/log-structure-editor.component.ts|html` used as wizard step 2 and at `/logs/:id/structure`: fields table (Type, Format, Detection with match %, invalid link, "boolean?", "set by you", Search, Role, Sensitive, Sample), time zone select, Personal data segment, default data view, Cancel / Save structure, "rebuilding" states (mock `wizStructure()`, `matchCell()`)
- [X] T048 [US2] Template editor `FE/components/logs/log-template-editor.component.ts` + `FE/shared/utils/logs-template.ts` (`{label}` tokens, ` · ` segments, empty segments dropped) with live preview; spec `logs-template.spec.ts`
- [X] T049 [US2] Mask mode in rows, data panel and drawer: fields flagged sensitive masked through existing `FE/shared/utils/redact.ts`, reveal per view

---

## Phase 5: User Story 3 - Search and filter fast (P1)

**Goal**: pills, autocomplete, histogram, sidebar values + field actions, toggle columns, saved views, time range.
**Independent test**: quickstart.md scenario 3; timings within SC-002.

- [X] T050 [US3] Histogram, field values (latest-10,000 window) and field stats endpoints in `LogQueryController` + `SqliteLogLineStoreAdapter` (research §R9; exact percentiles only on Exact fields)
- [X] T051 [US3] Saved views CRUD (`…/views`, ≤ 100/source) in `BL/application/service/LogsService.java` + controller
- [X] T052 [P] [US3] Tests: histogram buckets by level, values window size, stats exact vs sampled flag, saved view limit in `BLT/adapter/out/sqlite/SqliteLogLineStoreAdapterTest.java` and `BLT/adapter/in/web/LogQueryControllerTest.java`
- [X] T053 [P] [US3] `FE/shared/utils/logs-query-parse.ts` + `logs-pills.ts` (grammar table in contracts/log-query.md; pill text and colour class) with spec `logs-query-parse.spec.ts`
- [X] T054 [US3] Query bar `FE/components/logs/log-query-bar.component.ts`: pills with ✕, Backspace removes last, autocomplete fields → values with counts → exists / search text with ↑↓/Tab/Enter/Esc, time range select remembered per source (localStorage in try/catch; first visit = last 24 h of data) (mock `parseQ()`, `suggest()`, `drawAc()`)
- [X] T055 [US3] Histogram `FE/components/logs/log-histogram.component.ts`: stacked by level, legend, drag across bars → BETWEEN pill (mock `renderHist()` + drag handlers in `afterExplorer()`)
- [X] T056 [US3] Sidebar `FE/components/logs/log-field-sidebar.component.ts` + shared `log-field-actions.component.ts` (⊕ ⊖ ▥ ∃, ▥ highlighted when on): roles list, fields with type icon and presence %, top values (mock `renderSide()`, `fieldActs()`)
- [X] T057 [US3] Toggle columns: columns state saved in structure (`PUT …/structure`), header with ✕ per column, cells per column with status ≥ 500 red (mock `colTemplate()`, `headRow()`)
- [X] T058 [US3] Highlight TEXT pill terms in summary/cells/table/JSON via a pure `highlightSegments()` in `FE/shared/utils/logs-pills.ts` rendered with Angular bindings (no innerHTML)
- [X] T059 [US3] Saved views select + "☆ Save view" in the explorer header (mock header of `renderExplorer()`)

---

## Phase 6: User Story 4 - Grouped view by levels (P2)

**Goal**: n-level tree of real log lines with per-level sort and all placement edge cases.
**Independent test**: quickstart.md scenario 4.

- [X] T060 [US4] `GroupKeyer` in `BL/domain/ingest/GroupKeyer.java` implementing the placement rule in data-model.md (level = count of present IDs, skipped level → nearest ancestor + `missingLevel`, no level-1 ID → bucket)
- [X] T061 [US4] Test `BLT/domain/ingest/GroupKeyerTest.java`: every edge case (missing parent, siblings, skipped level, no IDs, 4+ levels)
- [X] T062 [US4] `SqliteLogGroupStoreAdapter` (`lg_<id>` upsert per batch: counts, first/last ts, errors, max duration, head line) + rebuild on level change in `StructureRebuildService`
- [X] T063 [US4] `POST …/groups` (parentPath, level, sort, cursor; filtered aggregates for the visible page) in `LogQueryController`; returns `GroupNode` with head line / placeholder, siblings, skipped children
- [X] T064 [P] [US4] Tests: group adapter on `@TempDir` (aggregates after two batches, rebuild after level change) + groups endpoint clamp
- [X] T065 [US4] Levels editor `FE/components/logs/log-levels-editor.component.ts` in the structure editor: badge, field select, sort select, ↑, ✕, + Add level, rules hint (mock levels card in `wizStructure()`)
- [X] T066 [US4] Grouped rows in `log-list`/`log-row`: children ± toggle independent of data toggle, `L1 · N below`, `sibling`, `‹field› missing`, placeholder rows, "No ‹field›" bucket, lazy child pages; toolbar Collapse all / to L1 / L2 / All, per-level sort selects, lines sort (mock `renderList()` grouped `walk`, `expandTo()`)

---

## Phase 7: User Story 5 - Inspect: selection, compare, stats, columns (P2)

**Goal**: multi-select with bulk actions, compare two lines, field stats popover.
**Independent test**: quickstart.md scenario 5.

- [X] T067 [US5] `POST …/compare`, `…/selection/export` (streamed ndjson/json/md/html, never truncated), `…/selection/pin` accepting `{lineIds}` or `{allMatching, except}` in `BL/application/service/LogsService.java` + controller
- [X] T068 [P] [US5] Tests: export of a 5 MB line byte-identical, all-matching with exceptions, clamps
- [X] T069 [P] [US5] `FE/shared/utils/logs-selection.ts` (range by on-screen order, all-matching + except, hidden-by-filter count) with spec; `FE/shared/utils/logs-export.ts` builders reusing `escapeHtml` and `redact.ts` with spec (no truncation, HTML escaped)
- [X] T070 [US5] Row checkbox with shift-click range, header select-all (indeterminate; shift = all matching), keys `x`, `J`/`K`, `Esc` (mock `[data-cmp]` handler, `#selall`, keydown)
- [X] T071 [US5] Bulk bar `FE/components/logs/log-bulk-bar.component.ts`: count + hidden count, Select all N matching, + children of selected (grouped), Compare (pick 2), Show selection only (SELECTION pill), Copy raw, Export…, Pin, "Make Alfred calls · later" message, Clear (mock `bulkBar()`, `bulk()`)
- [X] T072 [US5] Compare dialog `FE/components/logs/log-compare-dialog.component.ts` with "Only differences" and "N of M fields differ" (mock `compareDlg()`)
- [X] T073 [US5] Stats popover `FE/components/logs/log-field-stats-pop.component.ts`: tiles, distribution (top 10 % red), quick actions, text top-10 bars, "latest 10,000" label (mock `statsPop()`)

---

## Phase 8: User Story 6 - Live logs: follow and push (P2)

**Goal**: followed files and HTTP push appear live; "N new lines" when scrolled.
**Independent test**: quickstart.md scenario 6.

- [X] T074 [US6] `FollowFileLineSource` in `BL/adapter/out/input/FollowFileLineSource.java`: `WatchService` hint + `LOGS_FOLLOW_STAT_MS` stat, rotation (file key change or size < offset), resume from saved offset, WAITING when missing
- [X] T075 [US6] Test `BLT/adapter/out/input/FollowFileLineSourceTest.java`: append, rotate by rename, rotate by truncate, restart resume, zero duplicates/losses
- [ ] T076 [US6] `LogPushController` + `PushLinesUseCase`: `X-Log-Push-Token` constant-time check against `pushTokenHash`, body ≤ `LOGS_PUSH_MAX_BYTES`, bounded queue → 503 + `Retry-After: 2`; `POST …/push-token` regenerate
- [ ] T077 [P] [US6] `@WebMvcTest` `BLT/adapter/in/web/LogPushControllerTest.java`: 202 / 401 / 413 / 503 + Retry-After
- [ ] T078 [US6] Follow + push forms in the wizard (start-from select; push address, token Copy/Regenerate, NDJSON note) (mock `wizInput()` follow/push)
- [X] T079 [US6] Live toggle + "N new lines · paused while you're scrolled · jump to newest" pill driven by `lines-added` events (mock `toggleLive()`, `.newpill`)

---

## Phase 9: User Story 7 - OpenSearch as a source (P3)

**Goal**: import, follow and in-place browse.
**Independent test**: quickstart.md scenario 7.

- [ ] T080 [US7] `OpenSearchClient` (JDK `HttpClient`, basic auth from `SecretStorePort`) + `OpenSearchLineSource` (PIT + `search_after` on `[@timestamp,_id]`, page size, pages/s limit, follow interval, cursor saved per batch) in `BL/adapter/out/opensearch/` and `BL/adapter/out/input/`
- [ ] T081 [US7] `OpenSearchQueryTranslator` implementing `RemoteLogQueryPort` (contracts/log-query.md "OpenSearch translation", groups via `terms` + `top_hits`); `LogsService` routes IN_PLACE sources to it; commenting/pinning copies the hit into `ll_<id>`
- [ ] T082 [P] [US7] Tests: translator per op; line source paging past 10,000 against a stubbed `HttpClient` server (`com.sun.net.httpserver`); credentials never in DTO or logs
- [ ] T083 [US7] OpenSearch form in the wizard (address, credentials write-only "set · replace", index, query, time range, mode segment, limits) and in-place notes (Patterns/minimap hidden) (mock `wizInput()` opensearch, in-place card in `renderSources()`)

---

## Phase 10: User Story 8 - Comments, patterns, minimap, trace (P3)

**Goal**: field-anchored comments with pinning, Patterns view, minimap, trace.
**Independent test**: quickstart.md scenario 8.

- [X] T084 [US8] Comments: `SqliteLogCommentStoreAdapter`, use cases, `LogCommentsController` (`GET/POST …/lines/{id}/comments` with `{path, text, authorProfileId}`, `DELETE …/comments/{id}`, `POST …/selection/comment`); creating pins the line; `comment-changed` event
- [X] T085 [P] [US8] Tests: comment pins line, retention keeps it, path stored, text 1–4,000 clamp
- [X] T086 [US8] Comments UI: 💬 gutter per JSON line and Table row with counts, inline cards with profile emoji + name ("deleted profile" fallback), editor with Cancel/Comment and empty-text error, "💬 Comment on the whole line", folded block "💬 N inside", drawer Comments tab with field select, bulk "Comment on all"; author = remembered profile with a picker on first comment (`GET /profiles`) (mock `commentBlock()`, `cBtn()`, `jsonLines()` fold branch, drawer comments)
- [X] T087 [US8] `PatternMiner` (Drain-style) in `BL/domain/ingest/PatternMiner.java` wired into ingest; `SqliteLogPatternStoreAdapter`; `POST …/patterns`, `…/patterns/{pid}/lines`; test `BLT/domain/ingest/PatternMinerTest.java`
- [X] T088 [US8] Patterns view rows (worst-level stripe, ±, template, ×count, expanded lines) (mock `renderList()` patterns branch)
- [X] T089 [US8] `POST …/minimap` (`ntile(200)` per the chosen condition pill, default ERROR/WARN; even sample above 5 M matches with `sampled: true`; statement timeout) + `FE/components/logs/log-minimap.component.ts` (condition selector "Errors + warnings ▾" accepting any pill, "sampled" label, ticks, window box synced to scroll, click to jump) (mock `renderMinimap()`, `syncWin()`, `jumpTo()`)
- [X] T090 [US8] `GET …/trace` + drawer Trace tab `FE/components/logs/log-trace.component.ts` (waterfall bars, duration labels) (mock drawer trace branch)

---

## Phase 11: Polish & cross-cutting

- [X] T091 [P] `docs/logs.md`: model, ingest pipeline, storage layout, limits, privacy modes, follow/push/OpenSearch behaviour, Complexity Tracking items; link from `CLAUDE.md` "Detailed docs"
- [X] T092 [P] Update `CLAUDE.md`, `AGENTS.md`, `docs/architecture.md` (slice list, isolation rule, `logs` prefix and `$spa_page` entry, `logs.db`, Settings → Database table lists `logs.db`)
- [X] T093 [P] Add `logs.db` to the Settings → Database table (`DatabaseStatsController` in `backend-app`)
- [X] T094 Scale script `scripts/gen-logs.py` (NDJSON from the OpenSearch sample with varied ids/levels/durations and 3 grouping levels) and run the 10 GB measurement in both raw modes; record SC-001..SC-007 numbers in `docs/logs.md`, with index bytes and total `logs.db` bytes reported separately (SC-007)
- [ ] T095 Walk `contracts/ui-mock-map.md` row by row against the running app beside `mock.html`; fix mismatches or get the owner's approval for each deviation
- [X] T096 Full suites: backend `mvn test` (Docker JDK 21), frontend `npm test` and `npm run build`; ArchUnit green

---

## Implementation notes (2026-10-03)

- **Not built, waiting on C1:** T076, T077, T080–T083 (HTTP push, OpenSearch). The backend rejects those input kinds
  with 503 and the wizard shows them as "later". T078's follow form is done; its push half waits on C1.
- **Deviations from the task text, same behaviour for the user:**
  - T037/T038: explorer state lives in the page component's signals, and the list appends keyset pages of 200 as you
    scroll instead of a cdk virtual-scroll viewport (rows have variable height once data panels open).
  - T028: there is no separate `UploadLineSource`; chunks are written straight into the upload file and the same
    `FileLineSource` reads it.
  - T067: compare is done in the browser from the two full lines; there is no `POST …/compare` endpoint. Selection
    export is built in the browser too (reusing `escapeHtml` and the redaction rules) and refuses more than 5,000
    lines rather than cutting anything.
  - T020/T022/T025: the translator, adapter and ingest service are covered by `LogsIngestAndQueryIntegrationTest`
    on a real logs.db instead of separate unit tests.
  - Search-mode defaults: only low-cardinality fields and role fields default to Exact (every Exact field is an index
    updated on every insert); grouping-level fields are always indexed.
- **Gap round (2026-10-03, after review):** age retention removed and no default size cap (owner: "you load all");
  load-more for group nodes, a node's own and level-skipping lines, the no-ID bucket and pattern lines (FR-023);
  sensitive values masked in list rows too (FR-043); "+ Input" adds an input to an existing source with the
  duplicate-file confirm; invalid values listable from the structure page (FR-012); saved views deletable; minimap
  condition accepts any filter (FR-027); stats "Slowest by service"; interrupted uploads resume after a refresh;
  server paths resolved through symlinks.
- **T094:** measured on 200,000 generated lines, not a full 10 GB file - see docs/logs.md.
- **T095** (walk ui-mock-map row by row with the owner) stays open for the review. T096: backend `mvn test` BUILD SUCCESS, frontend 2,092 specs pass, `ng build` clean.

## Dependencies & execution order

- Phase 1 → Phase 2 → stories. Phase 2 blocks all stories.
- US1 (MVP) first. US2 and US3 extend US1's explorer/editor and follow it. US4 needs US2's structure editor.
  US5 needs US3 (columns, pills). US6, US7 need only Phase 2 + US1. US8 comments need US1's data views;
  patterns/minimap need US3's query path.
- Order inside a story: backend (domain → adapter → service → controller → test) then frontend (utils + spec →
  components).

## Parallel examples

- Phase 2: T011, T012, T013 together; then T015; T024, T026, T027 alongside T017–T022.
- US1: T028, T029, T030 together; T033 and T041 alongside the UI tasks.
- US3: T053 alongside T050–T052.

## Implementation strategy

1. MVP = Phase 1 + 2 + US1, then stop and let the owner compare with the mock.
2. Then US2 → US3 (all P1), each checked against quickstart.md and the ui-mock-map rows it covers.
3. Then US4, US5, US6 (P2), then US7, US8 (P3), then Polish.
4. Per the owner's token budget: do the work in the main session; at most one subagent at a time, only for a
   self-contained task with exact files named.

- **Multi-structure round (2026-10-04)**: each line may have its own structure (FR-045 amended, spec Session
  2026-10-04, eight cases decided against OpenSearch's behaviour). Combined field list (900 searchable), line
  structures (`ShapeMatcher`, `ls_<id>`, `structure:S2`, per-structure template, move to own source), roles on
  several fields (`roleRank`), "seen in X %", hide missing fields, `-` for absent columns, background sorting of
  older lines (`ShapeBackfillService`). Write transactions IMMEDIATE, busy_timeout 30 s, batch updates in short
  transactions. Verified in the browser on a 3-structure file; backend 29 tests, frontend 2,096 specs green.
- **Structure page round (2026-10-04)**: tabs (Fields / Grouping levels / Summary line template / Line structures,
  last tab remembered per browser session); fields shown as a tree grouped by dotted path (single-child chains
  merged, open groups remembered per source, find box, expand/collapse all), full names wrapping instead of cut,
  per-group menu to set search mode or sensitive for every field below, Format/Detection/Sensitive/Sample moved
  into a per-field detail row. `shared/utils/logs-field-tree.ts` + spec. Frontend 2,100 specs green.
- **Performance round (2026-10-04)**: OOM on wide lines fixed (byte-capped batches, own parse pool, failures and OOM
  mark the input FAILED, ExitOnOutOfMemoryError + restart-loop guard), G1 GC threads capped, SQLite pool/cache
  trimmed, `LogsChangeTracker` result cache, streamed sidebar counts, throttled live aggregates, payload option A
  (`PayloadRule`), `logs.db` on a named volume with one-time copy. Real detail.log: OOM → 29 s; numbers in docs/logs.md.
- **Line data grouping (2026-10-04)**: a line's Table view groups fields by dotted path (generic `buildPathTree` in
  `shared/utils/logs-field-tree.ts`, shared with the structure editor), with a Grouped | Flat switch per line
  (remembered per line for the browser session, folded groups too; payload groups start folded) and a per-source
  default (`LogStructure.defaultFieldLayout`, Summary line template tab). Compare has its own switch, with
  "N differ" per group. Verified in the browser on the real detail.log source.

