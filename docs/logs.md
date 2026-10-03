# Logs Explorer (`backend-logs` + the Logs tab)

Spec, plan and UX contract: `specs/004-logs-explorer/` (`mock.html` is the approved look; `contracts/ui-mock-map.md`
maps every mock element to the component that renders it).

## What it does

Loads logs where **every line is one JSON object** (any structure; each line may have its own), from an
uploaded file, a file under the server's `/logs` mount, or a followed (growing) file. ALFRED detects the structure,
the user sets per field: type (date / datetime / number / string / boolean, with a format), search mode
(Exact / Text / Not searched), role (time, level, correlation, message, duration, …) and "sensitive"; plus grouping
levels (an ordered list of ID fields), a summary template, a time zone and a privacy mode. The explorer then
browses, filters, groups (parents and children are ordinary lines), shows patterns, stats, a minimap, traces,
field-anchored comments, multi-select with bulk actions and full exports.

HTTP push and OpenSearch inputs are designed but **not built**: they wait on the secrets decision recorded as
"Open decision C1" at the top of `specs/004-logs-explorer/tasks.md` (the constitution requires secrets to come from
env/config). The backend rejects those input kinds with 503 until then; the wizard shows them as "later".

## Shape

- `backend-logs` is a leaf slice (ArchUnit `logsSliceMustNotDependOnOtherSlices`). A comment's author is a plain
  profile id string, like session-cycles' `assignedTo` - no link to `backend-profiles`.
- **One ingest pipeline** for every input: `LineSourcePort` (complete lines + byte offsets) → `LineBuilder.parse`
  (Jackson, `Flattener`, redact-at-load, mismatch check; run in parallel) → new fields registered →
  `LineBuilder.toRecord` (typed values via `ValueTyper`, time/level/duration from roles, `GroupKeyer` placement,
  `PatternMiner`) → `LogLineStorePort.append`, **one transaction per 5,000 lines** that also moves the input's
  position and the source's counters. A crash resumes from the last committed position: no loss, no duplicates.
- **Line identity** = `<inputId>:<offset>`, where the offset's top bits carry the follow-rotation generation
  (`LogIngestService.compose`). Loading the same file twice is a second input (ALFRED warns first, by fingerprint =
  SHA-256 of the first MB + size).
- **Storage** (`logs.db`, `SqliteLogsRepository`): per source `ll_<id>` (a row per line; `f<N>` original text per
  field, `t<N>` typed value for typed fields - an invalid value leaves `t<N>` NULL and keeps the text), `fts_<id>`
  (contentless FTS5 **trigram** index over the Text fields), `lg_<id>` (group-node aggregates for the grouped view)
  and `lp_<id>` (pattern templates). Table names come only from server-generated ids. Exact fields get a B-tree index;
  grouping-level fields are always indexed.
- Every read goes through the storage-neutral `LogQuery` (`contracts/log-query.md`); `SqliteLogQueryTranslator` is
  the only place SQL is built from it. A MongoDB adapter later replaces the `Sqlite*` adapters only.
- List endpoints return `LogLineSummary` (role fields, template tokens, chosen columns, level ids) - never the raw
  line. Full data comes from `GET /logs/sources/{id}/lines/{lineId}`.
- Sidebar counts and non-indexed stats are computed over the **latest 10,000 matches** and say so; percentiles are
  exact (index walk) for Exact fields. The minimap uses `ntile(200)` and samples evenly above 5 M matches.
- `/ws/logs` only signals `lines-added`, `input-progress`, `structure-changed`, `sources-changed`,
  `comment-changed`; pages refetch. The explorer coalesces a burst of `lines-added` into one refetch per second (a
  one-shot delay, not polling).

## Lines with different structures (FR-045 as amended 2026-10-04)

Each line may have its own structure - decided case by case against OpenSearch's behaviour (spec.md, Session
2026-10-04):

- **One combined field list**, like an OpenSearch index mapping: `LineBuilder.parse` reports every path the
  structure lacks, from any line, and `LogIngestService.addFields` registers it. Caps: 900 searchable (stored)
  fields per source (`LogStructure.MAX_STORED_FIELDS`, two SQLite columns each), 2,000 in all; past that a path is
  listed in `overflowPaths` (raw line and JSON view only) and the structure editor says so. OpenSearch would reject
  the document instead.
- **Structures among the lines**: `ShapeMatcher` puts each line, by its set of stored fields, into the structure
  it overlaps most (Jaccard ≥ 0.7, so one optional field is not a new structure), else a new one; past 100 it joins
  the nearest. Per line `ll_<id>.shape`; per structure `ls_<id>` (field set, line count, per-field counts, name,
  template), written in the batch transaction. The explorer shows them in the sidebar (counts for the current
  search via `POST /structures`), a badge per row, the `structure:S2` filter (translator pseudo-field; a real field
  named `structure` wins), a summary template per structure, and "Move to own source" on the structure page.
  "Seen in X %" per field = Σ field counts / Σ lines, so it costs nothing to show.
- **Roles on several fields** (instead of OpenSearch's ingest pipeline / field alias): `FieldDef.roleRank`, read
  through `LogStructure.rolesOf`; `LineBuilder.derive` takes time/level/duration/message from the first role
  field a line has; a trace matches any correlation field. Detection gives a role to a second field only when no
  sampled line has both (an alternate name, not a second value).
- **Hide missing fields** in the sidebar (on by default, from the latest-10,000 window), and a column a line does
  not have shows `-`, as in Discover.
- **Older data**: `ShapeBackfillService` sorts lines stored before this into structures once, in the background.
  Lines once flagged "different structure" are re-read from their raw text (COPY mode) so their own fields are
  stored; those fields arrive as Not searched (building an index over every stored line would hold the write
  lock for minutes on a slow disk). OFFSET-mode sources keep the old count until the file is loaded again.
- Write transactions are `IMMEDIATE` (JDBC URL), and multi-row updates run as one transaction: a deferred
  transaction that reads first fails at once with SQLITE_BUSY when another writer commits in between, and
  thousands of auto-commits starve other writers on a slow disk.

## Payloads (option A, 2026-10-04)

A big or id-keyed part of a line - a request/response body, a bean dump - is kept as ONE text field holding its JSON
(`LogStructure.payloadPaths`, `PayloadRule`, the idea of OpenSearch's `flattened` type). Chosen when a part has more
than 50 leaf fields of its own, or keys that are data (ids, numbers, base64); fields with the request-body,
response-body or error role are always one field. A part holding a field with another role, a grouping level, a
column or a template token is never a payload. Decided on the wizard sample and again per batch for new paths (the
batch is then parsed again). The payload is searchable by any fragment (Text) and shown in full in the JSON view; it
can be marked sensitive as a whole. Fields registered before a part became a payload stay (older lines keep them).

On the real `detail.log` (16,864 lines, 182 MB): before, ~920 fields, 23+ structures and the backend ran out of
memory; after, 29 fields at detection / 125 after the whole file.

## Performance and memory (2026-10-04)

- A batch ends at 5,000 lines **or 8 MB of raw text** (`BATCH_BYTES`): memory per batch is bounded by bytes, not
  by line count (5,000 wide lines held more than the 1 GB heap).
- Parsing runs on its own 4-thread pool (`PARSE_THREADS`), not the JVM-wide common pool sized to every host core.
- Any failure of a load - including `OutOfMemoryError` - marks the input FAILED with the reason. The JVM runs with
  `-XX:+ExitOnOutOfMemoryError` (a JVM keeps running half-broken after one) and G1 with 4 parallel / 2 concurrent GC
  threads (`backend/Dockerfile`). An input resumed after a restart that stops the backend again before storing a
  batch is not resumed a third time (`RESUME_MARK`).
- SQLite: 6 pooled connections × 16 MB page cache (was 8 × 64 MB of native memory); write transactions IMMEDIATE;
  multi-row updates in short transactions.
- `LogsChangeTracker`: a version per source, bumped by every write/rebuild, keys a 200-entry cache of histogram,
  sidebar values, minimap, patterns and structure counts. The unfiltered total comes from the source's counter.
- The sidebar's value counts stream (never hold the rows) and read at most 500,000 cells.
- Explorer live mode: the line list refreshes once a second while lines arrive; whole-result aggregates at most
  every 15 s (`AGGREGATE_EVERY_MS`), and once more after the last batch.
- `logs.db` on a named volume instead of the `./backend/data` bind mount.

Measured on Docker Desktop / Windows, loading the real `detail.log`:

| | before | after |
|---|---|---|
| Load | out of memory (backend stuck) | 29.4 s |
| Backend CPU during load | bursts to 800-1,600 % | max 275 %, avg 147 % |
| Backend memory | 1.4-1.9 GB, then OOM | 0.8-1.06 GB |
| Fields | ~920 (cap hit) | 125 |
| Lines / sidebar values / histogram | 0.3 s / 20 s / 4.7 s (bench source) | 0.02 / 0.11 / 0.03 s |

The same load on the bind mount with all other fixes took 391 s - the volume alone is ~13× on Windows.

## Deliberate exceptions (plan.md Complexity Tracking)

- A followed file is checked every `LOGS_FOLLOW_STAT_MS` (1 s): bind mounts and network shares send no file events.
  The UI never polls.
- No flat-file adapter: per-field indexes, FTS and group aggregates over millions of lines have no file equivalent.
- Tables and columns are created at runtime (`ALTER TABLE ADD COLUMN` for a field first seen mid-file).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `LOGS_DB_FILE` | `/appdata/logs.db` (compose: `/logsdb/logs.db` on the `logs-db` named volume) | the store |
| `LOGS_DB_LEGACY_FILE` | (compose: `/appdata/logs.db`) | copied once to `LOGS_DB_FILE` if that does not exist yet; the old file is left in place |
| `LOGS_UPLOAD_DIR` | `/appdata/logs/uploads` | assembled chunked uploads |
| `LOGS_ROOT_DIR` | `/logs` | read-only mount of `settings.properties`' `logs_drop_dir` (`ALFRED_LOGS_DIR`, default `./logs-drop`) |
| `LOGS_FOLLOW_STAT_MS` | 1000 | follow check interval |
| `LOGS_MIN_FREE_BYTES` | 2 GB | loading pauses (`PAUSED`, reason `LOW_DISK`) below this free space |

**Retention:** none by default - every line you load stays (owner decision 2026-10-03). There is no age-based
retention. A source can be given an optional size cap in its Settings; then the oldest unpinned lines go first
(trimmed to 90 % of the cap so it runs rarely) and commented/pinned lines are never removed. The disk is protected by
the low-disk pause instead.

## Measured (T094)

`LogsIngestPerformanceTest` (run with `-Dlogs.perf.lines=200000`; synthetic 450-byte lines, 3 grouping levels,
12 Exact fields, 2 Text fields), Docker `maven:3.9-eclipse-temurin-21` on the container's own disk, 2026-10-03:

| | |
|---|---|
| Ingest | 200,000 lines in 16.7 s = **~12,000 lines/s** (≈ 4.9 min for 3.5 M lines) |
| Exact filter (`level = ERROR`) | 84 ms |
| Text fragment (`agent7`) | 108 ms |
| Range on an indexed number | 6 ms |
| Histogram / group roots / field values / minimap | 179 / 41 / 213 / 407 ms |
| `logs.db` size | 327 MB for 89 MB of input (small lines: per-row index overhead dominates) |

Two things that mattered: checking free disk space **once per batch, not per line** (it halved throughput), and
batching inserts with row ids assigned up front plus group aggregates summed per batch.

**Docker Desktop on Windows:** with `logs.db` on the `./backend/data` bind mount the same load ran at ~700 lines/s
and a histogram over 200k lines took 10 s - SQLite on a Windows bind mount is the bottleneck, not the code. On a
Linux host (or a named Docker volume) the numbers above apply.
