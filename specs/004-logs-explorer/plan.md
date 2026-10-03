# Implementation Plan: Logs Explorer

**Branch**: `004-logs-explorer` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/004-logs-explorer/spec.md`
**UX contract**: [mock.html](./mock.html) is the approved look and behaviour. Every screen, control and interaction in
it maps to a component, endpoint and requirement in [contracts/ui-mock-map.md](./contracts/ui-mock-map.md); the
built UI must match the mock (layout, wording, colours from the shared theme, keyboard shortcuts). Any deviation is a
change to the mock first, approved by the owner, then to the code.
**Implementation gate**: no code is written until the owner explicitly says "start".

## Summary

A new **Logs** tab loads JSON-per-line logs of any structure, from five inputs (upload, server file, followed file,
HTTP push, OpenSearch), detects the structure, lets the user set per-field type/format/search mode/role/sensitivity,
grouping levels, summary template, time zone and privacy mode, and then browses millions of lines with filter
pills, a level-stacked histogram, Lines / Grouped / Patterns views, Table|JSON data with field-anchored comments,
toggle columns, multi-select with bulk actions, compare, field stats, an error minimap, a side drawer, traces and
live updates - exactly as in `mock.html`.

Technical approach (details in [research.md](./research.md)): a new leaf slice **`backend-logs`** owns everything.
Ingest is a single streaming pipeline (any input → `(rawLine, position)` → detect → flatten → typed values → batched
insert). Storage is a SQLite file `logs.db` with **one table per source** (a column per field: original text + a
typed shadow column for typed fields), an **FTS5 trigram** index over the fields the user marked Text, B-tree
indexes over Exact fields, a **group table** maintained at ingest for the grouped view, and a **pattern table**
from Drain-style template mining. All reads go through a storage-neutral **`LogQuery`** model so the later move to
a document database, and in-place OpenSearch browsing, are new adapters only. The frontend is standalone Angular +
signals under `pages/logs/`, fetch-on-demand on a `/ws/logs` "changed" signal, reusing the JSON tokenizer, redaction
utilities, export escaping and dialog patterns that already exist.

## Technical Context

**Language/Version**: Java 21 (Spring Boot, Maven reactor), TypeScript 5.5 / Angular 18.2 (standalone + signals,
`@angular/cdk` 18 for virtual scroll)
**Primary Dependencies**: existing only - Spring Web/WebSocket/JDBC, `sqlite-jdbc` (FTS5 + window functions are
built into the bundled SQLite), HikariCP, Jackson (streaming parser for ingest), `java.net.http.HttpClient`
(OpenSearch); Angular + CDK. **No new libraries.**
**Storage**: SQLite `LOGS_DB_FILE=/appdata/logs.db` (per-slice file, like `relive.db`); uploads assembled under
`/appdata/logs/uploads/`; server files read from a read-only mount `/logs`
**Testing**: JUnit 5 + Mockito + AssertJ, `@TempDir` SQLite adapter tests, `@WebMvcTest`, ArchUnit; Karma/Jasmine
for `shared/utils/logs-*` and the few DOM-only components; a scale script that generates a 10 GB NDJSON file
**Target Platform**: Docker Compose (Linux server or desktop), Chrome/Edge
**Project Type**: web application (backend slice + frontend tab + gateway/compose config)
**Performance Goals**: SC-001..SC-007 - 10 GB (~3.5 M lines) ingested < 5 min with flat heap; Exact filter < 1 s,
Text fragment < 2 s, page scroll < 200 ms p95; group expand < 1 s; follow latency < 2 s
**Constraints**: backend `mem_limit` 2g - ingest streams, never holds a file or result set; no UI polling;
list endpoints return line summaries (no raw) - raw/full data on open; exports never truncate; gateway body limit
50 MB (uploads are chunked); Mongo migration later must not change behaviour
**Scale/Scope**: up to ~10 sources, each up to tens of millions of lines within its retention (default 20 GB / 30
days), up to ~300 fields per structure, grouping depth ≤ 8 levels

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* **Result: PASS (pre- and post-design),
three justified items in Complexity Tracking.**

- [x] **I. Security**: every DTO `@Valid`; all sizes clamped server-side (page `limit` ≤ 500, context ±100, group
  page ≤ 500, push body ≤ 10 MB, chunk ≤ 40 MB, levels ≤ 8, pills ≤ 50, saved views ≤ 100/source); server files
  only from the `/logs` mount with path normalisation + `startsWith` check (no traversal); push requires a
  per-source token (`X-Log-Push-Token`, constant-time compare); OpenSearch credentials are write-only (never
  returned, never logged, stored only in `logs.db`, masked in every DTO); logs never print line content (ids,
  sizes, counts only); line data rendered via Angular interpolation (no `innerHTML`/`bypassSecurityTrust*`; the
  JSON view uses the existing token component); exports escaped by the existing `escapeHtml`; privacy mode per
  source (show / mask via existing `redact.ts` / redact-at-load in the ingest pipeline, which forces COPY raw mode
  so no unredacted original is reachable).
- [x] **II. Performance**: no proxy involvement at all; no UI polling - `/ws/logs` signals then fetch; list rows
  are summaries (time, level, summary inputs, chosen columns, ids) - raw/full fields on open; every query is
  keyset-paged, indexed and `LIMIT`ed; FTS5 trigram for fragments; ingest streams via Jackson parser in batches of
  5,000 in one transaction, heap independent of file size; sidebar counts and stats run on a bounded window (most
  recent 10,000 matches) unless the field is indexed; group aggregates are maintained incrementally, never computed
  over the whole source per request; retention per source (size/age, pinned lines excluded). Backend-side tail/pull
  timers are justified in Complexity Tracking.
- [x] **III. Architecture**: new leaf slice `backend-logs`, hexagonal layout, **no cross-slice edge** (comments,
  saved views, pins are owned by the slice; it does not depend on `backend-comments` - that slice's model is
  call-line-index based). New isolation rule `logsSliceMustNotDependOnOtherSlices`. SQLite default via
  `@ConditionalOnProperty(prefix="alfred.storage.logs")`; there is no flat-file adapter for this slice (see
  Complexity Tracking). Frontend standalone + signals; dialogs via existing `*DialogService` pattern; JSON
  rendering via existing `JsonTokensComponent` + `json-tokenizer`.
- [x] **IV. Style**: `*UseCase` per operation, `*Port`, `LogsService`/`LogIngestService`, `SqliteLogs*Adapter` +
  one `SqliteLogsRepository`, `*RequestDto`, records, constructor injection, outcome enums (e.g.
  `PushOutcome { ACCEPTED, UNAUTHORIZED, BUSY, TOO_LARGE }`); TS strict, `inject()`, signals.
- [x] **V. Clean code**: reuse named in research §R12 (`escapeHtml`, `redact.ts`, `json-tokenizer`,
  `JsonTokensComponent`, `ConfirmDialogService`, socket helper, gateway/`$spa_page`, `SqliteReliveRepository`'s
  pool/PRAGMA setup); grouping placement, query parsing, template rendering each have exactly one implementation;
  YAGNI: no call conversion, no Mongo adapter now.
- [x] **VI. Verification**: per layer in [quickstart.md](./quickstart.md) §Tests - detector/flattener/typing unit
  tests on the real OpenSearch sample and on a raw `detail.log` body; group placement tests covering every edge case
  in the spec; SQLite adapter tests on `@TempDir` (keyset paging, FTS fragments, type re-conversion, retention keeps
  pinned); `@WebMvcTest` for clamps/validation/token; frontend utils tests; the 10 GB scale run records numbers in
  `docs/logs.md`.
- [x] **Invariants**: exports untruncated (selection export reuses the no-truncation guard pattern); interception
  untouched; gateway regex gains `logs`, `$spa_page` gains `/logs`; docs added (`docs/logs.md`) and `CLAUDE.md` /
  `AGENTS.md` / `docs/architecture.md` updated (slice list, prefix list, `logs.db`).

## Project Structure

### Documentation (this feature)

```text
specs/004-logs-explorer/
├── spec.md · mock.html (UX contract) · plan.md · research.md · data-model.md · quickstart.md
├── contracts/
│   ├── rest-api.md        # HTTP + WebSocket contract of backend-logs
│   ├── log-query.md       # the storage-neutral LogQuery model and its SQL / OpenSearch translations
│   └── ui-mock-map.md     # every mock.html element → component · endpoint · FR
├── checklists/requirements.md
└── tasks.md               # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
backend/backend-logs/src/main/java/com/fathy/alfred/backend/logs/
├── domain/model/            LogSource, LogInput(+Kind,+Status), LogStructure, FieldDef(+FieldType,+SearchMode,+Role),
│                            GroupLevel, LogLineSummary, LogLine, LogQuery(+Pill,+Op,+Sort,+Cursor), LogPage,
│                            GroupNode, Pattern, FieldStats, Histogram, Minimap, LogComment, SavedView,
│                            PrivacyMode, RawMode, PushOutcome, IngestProgress
├── domain/ingest/           StructureDetector, Flattener, ValueTyper, ObjectTextParser (Name(k=v,…)),
│                            GroupKeyer, PatternMiner  (pure, no Spring)
├── application/port/in/     CreateSourceUseCase, UpdateStructureUseCase, AddInputUseCase, ControlInputUseCase,
│                            QueryLinesUseCase, GetLineUseCase, GetContextUseCase, QueryGroupsUseCase,
│                            QueryPatternsUseCase, HistogramUseCase, MinimapUseCase, FieldValuesUseCase,
│                            FieldStatsUseCase, TraceUseCase, CommentUseCase, SavedViewUseCase, PinUseCase,
│                            PushLinesUseCase, UploadChunkUseCase, ExportSelectionUseCase
├── application/port/out/    LogSourceStorePort, LogLineStorePort, LogGroupStorePort, LogPatternStorePort,
│                            LogCommentStorePort, LogInputStatePort, RawLineReaderPort, LineSourcePort,
│                            RemoteLogQueryPort, LogNotificationPort, SecretStorePort
├── application/service/     LogsService, LogIngestService (pipeline + batching + retention),
│                            StructureRebuildService (background re-type / re-index / re-group)
├── adapter/in/web/          LogSourcesController, LogQueryController, LogInputsController, LogPushController,
│                            LogUploadController, LogCommentsController + dto/
├── adapter/out/sqlite/      SqliteLogsRepository (pool, schema, per-source DDL), SqliteLogLineStoreAdapter,
│                            SqliteLogGroupStoreAdapter, SqliteLogPatternStoreAdapter, SqliteLogSourceStoreAdapter,
│                            SqliteLogCommentStoreAdapter, SqliteLogQueryTranslator
├── adapter/out/input/       UploadLineSource, ServerFileLineSource, FollowFileLineSource, OpenSearchLineSource
├── adapter/out/opensearch/  OpenSearchClient, OpenSearchQueryTranslator (in-place mode)
├── adapter/out/rawfile/     OffsetRawLineReader (OFFSET mode)
└── adapter/out/websocket/   LogsWebSocketConfig, LogEventsWebSocketHandler, WebSocketLogNotificationAdapter

frontend/src/app/
├── pages/logs/              logs-sources.component, log-source-wizard.component (Input/Structure/Load),
│                            log-structure-editor.component, logs-explorer.component
├── components/logs/         log-query-bar, log-histogram, log-field-sidebar, log-field-stats-pop, log-list
│                            (virtual scroll; lines/grouped/patterns rows), log-row, log-data (Table|JSON),
│                            log-json-view (field-anchored comments), log-table-view, log-bulk-bar,
│                            log-compare-dialog, log-drawer (Fields/Raw/Context/Trace/Comments), log-minimap,
│                            log-trace, log-levels-editor, log-template-editor
├── core/services/           logs-api.service, logs-socket.service
├── core/state/              logs-explorer-state.service (signals: pills, view, cols, open sets, selection,
│                            drawer, live), logs-sources-state.service
└── shared/utils/            logs-query-parse.ts, logs-pills.ts, logs-template.ts, logs-json-lines.ts,
                             logs-selection.ts, logs-export.ts, logs-time.ts (per-source zone)

gateway/nginx.conf           + `logs` in the backend prefix regex, + `/logs` in `$spa_page`
docker-compose.yml           backend: LOGS_DB_FILE, ALFRED_LOGS_DIR mount → /logs:ro
settings.properties          logs_drop_dir (fills .env gap only)
docs/logs.md                 new; CLAUDE.md, AGENTS.md, docs/architecture.md updated
```

**Structure Decision**: one new leaf backend slice plus one new frontend tab, following `backend-relive` /
`pages/relive` as the nearest precedent (own SQLite file, own WebSocket, own controllers).

## Delivery phases (each ends usable; mock sections in brackets)

1. **Core load + browse + search** (US1, US2, US3): slice skeleton + ArchUnit rule; detector/flattener/typer;
   upload (chunked) + server file inputs; COPY/OFFSET raw; SQLite per-source table, Exact indexes, FTS5 trigram;
   wizard (Input / Structure / Load) and structure editor incl. types, formats, search modes, roles, template,
   time zone, privacy, default data view; explorer: query bar + pills + autocomplete, histogram + drag zoom, sidebar
   with values and field actions, Lines view, row visuals, toggle columns, Table|JSON data, drawer
   (Fields/Raw/Context), keyboard. [Sources · Wizard · Structure editor · Explorer lines]
2. **Grouped view + inspect** (US4, US5): grouping levels editor, group table + placement rules, per-level sort,
   children/data toggles, expand-to-level; multi-select + bulk bar (compare, selection only, copy, export, pin);
   field stats popover; saved views. [Grouped · Bulk bar · Compare · Stats]
3. **Live + comments** (US6, US8 part): follow file (offset resume, rotation), HTTP push (token, 503 + Retry-After),
   live toggle + "N new lines"; comments (line / field-anchored, JSON + Table + drawer, bulk) with pinning; trace
   tab. [Live · Comments · Trace]
4. **Patterns + minimap** (US8 rest): Drain-style mining at ingest, Patterns view; minimap endpoint + strip.
   [Patterns · Minimap]
5. **OpenSearch** (US7): import (PIT + `search_after`), follow pull, in-place browse via `OpenSearchQueryTranslator`,
   write-only credentials, rate limits. [Sources: OpenSearch input · Wizard: OpenSearch form]
6. **Later, not in this feature**: lines → ALFRED calls; MongoDB adapter.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Backend timers: file follow checks the file every 1 s; OpenSearch follow pulls every N s (default 10) | A growing file and a remote cluster cannot push "changed" to ALFRED; the no-polling rule targets UI list refreshes, and the UI still only reacts to `/ws/logs` signals | `WatchService` alone misses appends on Docker bind mounts and network shares (no inotify events), so it is used as a wake-up hint with the 1 s stat as the fallback; OpenSearch has no change feed |
| No flat-file adapter for `backend-logs` (SQLite only) | Per-field indexes, FTS and group aggregates over millions of lines have no file-based equivalent; a file adapter would be a second, unusable implementation | The constitution's "file fallback stays working" applies to slices that had one; a new slice keeps the `@ConditionalOnProperty` switch so a future Mongo adapter plugs in the same way |
| One SQLite table per source with DDL at runtime (`ALTER TABLE ADD COLUMN` on new fields) | Field sets are user data, unknown at build time; typed columns + per-field indexes are what makes Exact filters < 1 s | A single key/value (EAV) table needs a join per filtered field and cannot index typed ranges per field; JSON-in-one-column with `json_extract` indexes needs DDL anyway and re-parses JSON on every non-indexed read |
