# Quickstart: Logs Explorer (verification guide)

## Run

```bash
mkdir -p logs-drop && cp /path/to/opensearch-export.ndjson logs-drop/
docker compose up -d --build backend frontend app-gateway
```

Open `http://localhost:3000/logs` → **+ New source** → File on server → pick the file → Next → check types/roles →
Load → **Open explorer now**. Compare every screen against `specs/004-logs-explorer/mock.html` side by side
(contracts/ui-mock-map.md is the checklist).

## Scenario checks (one per user story)

1. **US1** Load a 10 GB generated file (`scripts/gen-logs.py --size 10G` added with phase 1); watch progress; open a
   random line and diff its Raw tab with `sed -n '<n>p'` of the file (SC-003).
2. **US2** Change `date_with_weekday` to `date` with pattern `yyyy-MM-dd (EEEE)`, set `ERROR_flag` to boolean via
   "boolean?"; sort and filter follow the new types; the invalid link lists non-matching values.
3. **US3** `externalService:Sabre`, `"anotrav"`, `timeTaken>6000`, `error:*`; each < 1–2 s; drag the histogram.
4. **US4** Levels session → inbound → external; check placeholder, sibling, "missing" rows and per-level sorts.
5. **US5** Toggle three columns, reload, still there; select 2 → Compare; stats on `timeTaken`; Table↔JSON.
6. **US6** `printf '%s\n' '{…}' >> logs-drop/detail.log` while following; rotate (`mv` + new file); restart backend;
   counts match the file. Push with a wrong token (401) and a right one (202).
7. **US7** OpenSearch import > 10,000 hits; count equals `_count`; in-place filters equal Discover's.
8. **US8** Comment on a JSON field, switch to Table (same comment), fold its parent ("💬 1 inside"); retention run
   keeps the commented line; Patterns view groups lines that differ only in ids/numbers; minimap click jumps.

## Tests

Backend (Docker JDK 21, see CLAUDE.md):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -pl backend-logs -am test
```

- `StructureDetectorTest` (the OpenSearch sample from the spec + a raw `detail.log` body; JSON-in-string unpack,
  duplicate marking, `LoginDTO(...)` parsing, one-element arrays, types + match rates, role guesses)
- `GroupKeyerTest` (every placement rule: level by ID count, missing parent, same-level siblings, skipped level,
  no-ID bucket)
- `ValueTyperTest`, `PatternMinerTest`, `LogQueryTranslatorTest` (each op, keyset cursor, typed comparisons)
- `SqliteLogLineStoreAdapterTest` on `@TempDir` (insert batch, FTS fragment, Exact filter, re-type keeps originals,
  retention skips pinned, new field `ALTER TABLE`)
- `FollowFileLineSourceTest` (append, rotation by rename and by truncate, resume from saved offset, no duplicates)
- `LogPushControllerTest` / other `@WebMvcTest`s (401 / 413 / 503 + Retry-After, clamps, traversal 400)
- `HexagonalArchitectureTest` with `logsSliceMustNotDependOnOtherSlices`

Frontend:

```bash
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless --include='src/app/shared/utils/logs-*.spec.ts'
cd frontend && npm test && npm run build
```

- `logs-query-parse.spec` (grammar table in log-query.md), `logs-template.spec` (empty segments dropped),
  `logs-json-lines.spec` (field-path anchors, one-element arrays share the flattened path, fold counts),
  `logs-selection.spec` (range, all-matching with exceptions), `logs-export.spec` (large lines never truncated,
  HTML escaped)

## Scale run (record results in `docs/logs.md`)

10 GB / ~3.5 M lines: ingest time, peak heap (`docker stats`), `logs.db` size, p50/p95 for Exact filter, Text
fragment, histogram, group expand, page scroll. Targets: SC-001..SC-007.
