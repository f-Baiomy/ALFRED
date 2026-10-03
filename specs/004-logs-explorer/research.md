# Research: Logs Explorer

All Technical Context unknowns are resolved below. Each item: **Decision**, **Rationale**, **Alternatives**.

## R1. Storage engine for v1

- **Decision**: SQLite, own file `logs.db`, pooled exactly like `SqliteReliveRepository` (Hikari, WAL,
  `synchronous=NORMAL`, `busy_timeout` via `connectionInitSql`). Every read and write goes through ports that speak
  the storage-neutral `LogQuery` (contracts/log-query.md), so a MongoDB adapter replaces the SQLite adapters only.
- **Rationale**: matches every other slice; FTS5 (trigram tokenizer) and window functions ship inside `sqlite-jdbc`;
  no new service to run.
- **Alternatives**: DuckDB (better analytics, weak fragment search, new dependency); embedded Lucene (new
  dependency, second storage system); MongoDB now (owner chose "SQLite now, Mongo-ready").

## R2. Table layout for dynamic structures

- **Decision**: one table per source, `ll_<sourceId>`:
  `line_id TEXT PK` (`<inputId>:<byteOffset>` or remote `_id`), `input_id`, `byte_offset`, `ts_ms INTEGER`,
  `level TEXT`, `group_level INTEGER`, `group_path TEXT`, `pattern_id INTEGER`, `pinned INTEGER`, `raw TEXT NULL`
  (COPY mode), then for each field N: `f<N> TEXT` (original text) and, for typed fields only, `t<N>` (typed value:
  INTEGER epoch-ms / REAL / 0-1). Field N ↔ path mapping in `log_field`. New fields: `ALTER TABLE ADD COLUMN`
  (constant time in SQLite).
- **Rationale**: per-field B-tree indexes and typed range queries; invalid values simply leave `t<N>` NULL while
  `f<N>` keeps the original (FR-012 "kept, counted, listable" = `f<N> IS NOT NULL AND t<N> IS NULL`).
- **Alternatives**: EAV table (join per filter, no typed index); one JSON column + expression indexes (re-parse on
  every unindexed read).

## R3. Fragment (Text) search

- **Decision**: per source an external-content FTS5 table `fts_<sourceId>` with `tokenize='trigram'`, columns =
  the fields marked Text only. Terms ≥ 3 chars use `MATCH`; shorter terms fall back to `LIKE` on those columns with
  the page `LIMIT`. Highlight positions computed in the frontend from the returned values.
- **Rationale**: millisecond substring search (`anotrav` in `evilanotravel@…`), index cost bounded to chosen fields
  (SC-007).
- **Alternatives**: `LIKE '%x%'` scans (seconds per search at 4 M rows); word tokenizer (misses fragments).

## R4. Ingest pipeline and memory

- **Decision**: `LineSourcePort` yields `(rawBytes, inputId, byteOffset)` from a counting buffered stream; Jackson
  `JsonParser` builds a tree per line (lines ≤ 16 MB; larger lines are stored as unparsed with a warning);
  `Flattener` → `ValueTyper` → `GroupKeyer` → `PatternMiner`; batches of 5,000 rows per transaction with prepared
  statements; FTS and group upserts in the same transaction. Progress events every batch on `/ws/logs`.
- **Rationale**: heap is O(batch), not O(file) (constitution II, 2 GB `mem_limit`); one transaction per batch is
  what makes SQLite insert ~100k rows/s.
- **Alternatives**: whole-file parse (OOM); row-at-a-time autocommit (≈100× slower).

## R5. Structure detection and typing

- **Decision**: sample first 1,000 parsed lines. Flatten nested objects with `.` paths; unwrap one-element arrays;
  a string that parses as a JSON object is unpacked under its own path, and marked `duplicateOf` when its leaves
  equal another subtree (the OpenSearch `_source.body` case); `Name(k=v, k2=v2)` strings become key/value children
  (`ObjectTextParser`). Type = the first of datetime (ISO-8601, epoch s/ms by magnitude), date, boolean, number
  whose match rate ≥ 95 %, else string; 0/1-only numbers get a "boolean?" suggestion. Role guesses by name
  (`@timestamp|timestamp`, `log.level|level`, `*correlation*|traceId|sessionId`, `timeTaken|duration*`,
  `statusCode|status`, `message`, `error`). Fields first seen after the sample are added live (`ALTER TABLE`) and
  announced on the Load screen.
- **Rationale**: matches the mock's Structure screen (match %, invalid count, boolean? link, "new field found").
- **Alternatives**: schema from the whole file (needs a second pass over 10 GB).

## R6. Type / search-mode / level changes after load

- **Decision**: `StructureRebuildService` runs one background job per change on a single-thread executor per
  source: re-type = `UPDATE … SET t<N> = convert(f<N>)` in chunks of 50,000 by rowid; search-mode change =
  create/drop index or rebuild FTS columns; level change = recompute `group_level/group_path` and rebuild the group
  table. The UI shows "rebuilding" on that field/view; everything else stays usable (FR-012).
- **Alternatives**: re-ingest the source (minutes, and impossible in OFFSET mode if a file moved).

## R7. Grouped view (levels)

- **Decision**: at ingest `GroupKeyer` computes `ids = values of the level fields`; `group_level` = number of
  level IDs present (spec rule); a skipped level (A + C, no B) is placed under its nearest present ancestor with
  `missing_level` recorded; `group_path` = present IDs joined by `\u0001`. A `lg_<sourceId>` table
  holds one row per node path: `path, level, parent_path, first_ts, last_ts, line_count, error_count, max_duration,
  head_line_id` (earliest line at exactly that level = parent row; NULL ⇒ placeholder row), upserted per batch.
  Expanding a node = one indexed query for child nodes (`parent_path = ?`, sorted by the level's sort column,
  keyset-paged) plus one for the node's own sibling lines and skipped-level lines. Filters: when pills are active,
  node aggregates are recomputed for the filtered set over the visible page of nodes only (bounded by page size).
- **Rationale**: SC-004 (< 1 s expand) on millions of lines; exactly one placement implementation (domain
  `GroupKeyer`), unit-tested against every spec edge case.
- **Alternatives**: grouping at query time with `GROUP BY` over the whole source (seconds per expand).

## R8. Patterns

- **Decision**: Drain-style fixed-depth parse tree on the message-role field (fallback: rendered summary),
  similarity threshold 0.5, tokens with digits/ids masked as `‹n›`/`‹id›`; `pattern_id` stored per line; `lp_<src>`
  holds `id, template, count`. Patterns view = `GROUP BY pattern_id` over the filtered set, keyset by count.
- **Alternatives**: regex masking only (mock's simplification; too coarse on real messages).

## R9. Histogram, minimap, sidebar counts, stats

- **Decision**: histogram = `GROUP BY ts_ms / bucket, level` on the filtered set (index on `ts_ms`), 48–120 buckets.
  Minimap = `ntile(200) OVER (ORDER BY ts_ms DESC, line_id)` over the filtered set, returning per-bucket counts of
  lines matching the chosen condition (default ERROR/WARN; any pill); above 5 M matches it runs on an even sample
  (`rowid % k = 0`) and the response says `sampled: true` (FR-027); computed lazily after the first page, with a
  statement timeout as the seatbelt. Sidebar
  value counts and text-field top values = over the most recent 10,000 matches (labelled "in the latest 10,000"),
  like OpenSearch Discover's sample. Stats: exact percentiles for indexed typed fields via
  `ORDER BY t<N> LIMIT 1 OFFSET ⌊p·n⌋`; otherwise over the same 10,000 window, labelled.
- **Rationale**: every request bounded (constitution II) while matching the mock's numbers and controls.

## R10. Inputs

- **Upload**: `POST /logs/uploads` → id; `PUT …/chunks/{n}` (≤ 40 MB, under the gateway's 50 MB); `POST …/complete`
  verifies size + SHA-256 then assembles into `/appdata/logs/uploads/` (streamed append) and starts ingest. Resumable:
  `GET …/uploads/{id}` lists received chunks.
- **Server file**: listing and reading only under `/logs` (read-only bind mount `${ALFRED_LOGS_DIR:-./logs-drop}`),
  `Path.normalize()` + `startsWith(root)`.
- **Follow**: saved `(fileKey, size, offset)`; wake-up from `WatchService` plus 1 s stat fallback (Complexity
  Tracking); rotation = file key changed or size < offset → finish old handle, reopen from 0; restart resumes from
  saved offset; offset saved in the same transaction as the batch (no loss, no duplicates - SC-005).
- **Push**: `POST /logs/sources/{id}/push`, NDJSON body ≤ 10 MB, `X-Log-Push-Token`; ingest queue per source bounded
  (2 batches); full → `503` + `Retry-After: 2` (clarification: reject, sender retries).
- **OpenSearch**: `HttpClient`; import = PIT + `search_after` on `[@timestamp, _id]`, page 1,000, ≤ N pages/s;
  follow = every N s `range @timestamp ≥ last` with `_id` tiebreak; position saved per batch. In-place = no copy;
  `OpenSearchQueryTranslator` maps `LogQuery` to query DSL (+ `terms` aggs for groups). Comment ⇒ pin ⇒ copy that one
  line into `ll_<src>` with `pinned=1`.
- **Same-file warning**: input fingerprint = name + size + SHA-256 of first 1 MB; a match on an existing input in
  the source returns `409 DUPLICATE_FILE` unless `?confirm=true`.

## R11. Privacy, time zone, secrets

- **Decision**: per-source `privacyMode`: `SHOW` (no change), `MASK` (frontend masks fields flagged `sensitive` via
  the existing `shared/utils/redact.ts`, reveal per view - same model as Relive/calls: backend returns data in full),
  `REDACT_AT_LOAD` (ingest replaces sensitive values in `f<N>` and in `raw`; forces COPY mode). Exports always run
  `redact.ts` rules. Time zone: per-source IANA zone in the structure; frontend formats with `Intl.DateTimeFormat`,
  raw value on hover. OpenSearch credentials: `SecretStorePort` (SQLite table, never returned; DTOs say
  `credentialsSet: true`).

## R12. Reuse (constitution V)

| Need | Reused |
|---|---|
| SQLite pool, PRAGMAs, `@PostConstruct` dir creation | pattern from `SqliteReliveRepository` |
| WebSocket config/handler/notification adapter | `ScenariosWebSocketConfig` / `ScenarioEventsWebSocketHandler` / `WebSocketScenarioNotificationAdapter` shape |
| Frontend socket with reconnect | existing `reconnectingSocket` helper used by `relive-socket.service` |
| JSON token colouring | `shared/utils/json-tokenizer` + `JsonTokensComponent` (log-json-view adds per-field comment gutter around it) |
| Masking | `shared/utils/redact.ts` + `RedactionsApiService` rules |
| Export escaping | `escapeHtml` in `shared/utils/html-builder.ts` |
| Confirm dialogs | `ConfirmDialogService` |
| Error shape / validation | `GlobalExceptionHandler`, Bean Validation |

Not reused, deliberately: `JsonFlatViewComponent`'s comments anchor by **line index**; log comments anchor by
**field path** (FR-042) so they survive folding and the Table↔JSON switch - a different anchoring model, not a
duplicate of the same behaviour. `backend-comments` is call-scoped and stays untouched.

## R13. Frontend list rendering

- **Decision**: `cdk-virtual-scroll-viewport` with variable-height support via an autosize strategy limited to
  collapsed rows; opened data/children render as separate items in the flattened row model (`LogRowItem` union:
  line, data panel, placeholder, pattern), so the viewport never measures arbitrary HTML. Pages of 200 fetched with
  keyset cursors as the user nears the end (mock appends 150).
- **Alternatives**: render-all (DOM blow-up beyond ~5k rows).
