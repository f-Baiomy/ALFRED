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

## Search rules (audited 2026-10-04)

Every filter, page, sort and aggregate was checked against a brute-force evaluation over every line of three
sources (3,000 / 5,000 / 36,880 lines, up to 900 fields); `SqliteLogQueryTranslator` is the one place the rules live.

- **Query bar**: `field:value` =, `-field:value` ≠, `field:*` / `-field:*` present / missing, `field>v` / `field<v`,
  `"text"` or anything else = free text. The field is the longest KNOWN label the text starts with, so a label with
  spaces, slashes or colons (any JSON key) can be typed; `"quoted"` values lose their quotes; `field:` with nothing
  after it is an unfinished filter, never a text search. **Enter** takes the highlighted suggestion when it was
  picked with the arrow keys, when only a field name or `field:` is typed, or when it completes the typed value
  (`level:E` -> `level:ERROR`); otherwise the typed text is the filter.
- **=, ≠** are exact and case-sensitive on the original text (typed fields compare as their type: `2201.0` = `2201`).
  ≠ and "missing" include lines without the field (as OpenSearch does). Pills are ANDed unless joined with OR (below).
- **The level role's first field** filters, counts (sidebar) and sorts by the LINE's level - that field or the
  role's next field a line has, normalised (WARNING = WARN, FATAL/SEVERE = ERROR, any case) - so `level:ERROR`
  matches what the histogram and minimap count as ERROR. Its other fields keep their own values.
- **Free text** searches the Text-search fields (trigram index; 1-2 character terms scan with LIKE and are flagged
  slow), case-insensitive. A NUL byte in a value is stored as `␀` (U+2400): SQLite's text index and LIKE stop at
  NUL, so text after it was unsearchable. The raw line keeps the original bytes.
- **Sort**: newest first by default; click Time for oldest first, or any column / Level heading for largest first,
  smallest first, back to time. Typed fields sort as their type, lines lacking the field come last, and pages
  continue with a value cursor (`f:ts:rid:value`), so nothing is skipped or repeated. A sorted list does not insert
  live lines on top - it shows "N new lines · reload".
- **Labels are unique per source**: a top-level path that arrives after another structure already took its short
  label (`timestamp` after `_source.attributes.timestamp`) is labelled `timestamp_2`; structures saved before this
  are repaired on load. Two fields sharing a label made every filter reach only the first.
- Saved views keep pills, range or zoomed time range, view and sort.

## Filters and time (design B++, 2026-10-04)

Mocks: `specs/004-logs-explorer/mock-filters-time-b-plusplus.html` (and the B / B+ compare pages beside it).

- **A pill is a small form** (`log-filter-editor`): Include / Exclude, a typed field with suggestions (any part of
  the name), condition (is / contains / exists / greater / less), value with the field's top values and counts.
  Several clicked values = one **is any of** pill (`values`, SQL `IN` / `NOT IN`). Exclude sets `not`, which wraps
  the condition as `NOT coalesce((cond), 0)` so lines without the field count as "not matching".
  `CONTAINS` is `LIKE %v%` on the field's text (the level role uses the normalised level).
- **AND / OR**: a pill with `or: true` joins the pill before it; `SqliteLogQueryTranslator.where()` builds OR groups
  and ANDs the groups (AND binds tighter, as in most query languages).
- **On / off dot**: an off pill stays in the bar but is not sent (`off` is explorer-only).
- **"−N" per pill**: `POST /logs/sources/{id}/pills/impact` returns, per sent pill, matches without it minus
  matches with all of them (removing an OR-joined pill clears the `or` of its successor). Negative = an OR pill
  that brings lines in, shown as "+N". Cached with the other aggregates.
- **Level chips** above the list count per level for the filters minus the level-field pills; a click shows only
  that level, again shows all.
- **Time** (`log-time-panel`, `log-timeline`, `log-clock-dial`, `shared/utils/logs-time-range.ts`): quick ranges
  count back from the newest line; Today / Yesterday; words ("yesterday 14:00 to 16:30"); calendar with day dots;
  From / To cards with ▲▼, typing, wheel and a clock dial; To follows From until To is changed; a length lock;
  "around From"; "To = now, keep moving" (`to: null`); recent ranges (localStorage per source); the line count before
  Apply. The timeline zooms to the selection; the histogram honours an explicit from/to exactly (bucket width =
  span / buckets), so zoomed bars line up with the selection.
- **UTC | Local** in the header changes display and picking only - every query is epoch ms.
- **◀ ▶ / `[` `]`** step the range by its length; **Ctrl+Z / Ctrl+Y** undo / redo filters and time (a snapshot is
  recorded on every refresh); ticked lines → **⏱ Use as time range** (± 1 min).
- **Search as text** (`shared/utils/logs-filter.ts` `toQueryText` / `parseQueryText`): `field:v`, `-field:v`,
  `field:a|b`, `field~v`, `field:*`, `field>v`, `"text"`, `OR`, `@last:24h` or `@ISO..ISO|now`; field names with
  spaces are quoted. The parser is the exact inverse of the writer.
- Explorer inputs bound to child components must be stable signals (`activePills`, `timeRange` are `computed`):
  a method returning a new array each change detection re-fired the timeline's fetch effect forever and froze
  the tab.

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
  batch or reading to the end of its file is not resumed a third time (`RESUME_MARK`; reaching the end clears it,
  or an idle followed file was failed by its second restart). A reader interrupted by the backend STOPPING is not
  a failure: its status is left as is and it resumes on the next start (it used to be marked FAILED, which
  silently stopped a watched file for good after any redeploy).
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

## Watched folders - live, notified (2026-10-04)

`settings.properties` `logs_watch_dirs=name:path,...` (overridable in `.env` as `ALFRED_LOGS_WATCH_DIRS`) lists the
folders Alfred LISTENS ON - separate from `logs_drop_dir`, which is only for loading files. `start.py`/`restart.py`
(through `alfred_logwatch.py`) mount each read-only at `/watch/<name>` in the generated `docker-compose.override.yml`
(a missing folder is skipped with a warning - Compose would refuse to start backend). Changing the list needs
`restart.py`.

- A **WATCH** input owns one **WATCHED_FILE** input per matching file (`LogWatchService`), so every file uses the
  normal pipeline: positions saved per batch, restart without loss or duplicates, rotation.
- **Start with:** everything / the last N lines (across files newest first, or per file -
  `WatchFoldersPort.lastLines` walks back from the end, complete lines only) / only new lines.
- **Rotated copies** (`detail.log.1`, `detail.log.2026-10-03`, matched by stripping the rotation suffix) are
  *archives*: read once for the starting window, never followed. The live file's reader follows the rotation
  itself (it finishes the renamed file's unread tail, then switches), so nothing is read twice. A new live file
  is read from its first line; a new archive (a rotation) is ignored.
- **Waiting is event-driven:** a reader that has read everything blocks in `FileChangeSignals` until its file is
  signalled. Signals come from:
  - `WatchServiceEvents` (`LOGS_WATCH_MODE=events`): the kernel (inotify) - Linux hosts, or a writer sharing a
    Docker volume. Subfolders are registered as they appear; an `OVERFLOW` rescans the folder; a watch-limit
    error names `fs.inotify.max_user_watches`.
  - The **host log agent** (`LOGS_WATCH_MODE=agent`): Docker Desktop (Windows/macOS) delivers no host file events
    into containers, so `log-agent/agent.py` (Python + `watchdog`, started/stopped by start.py/restart.py/stop.py)
    receives the OS notifications and POSTs `/logs/agent/changes` (`X-Agent-Secret` = `ALFRED_LOGS_AGENT_SECRET`,
    generated once into `.env`; constant-time compare; 503 when unset). Only "file X changed" crosses - the backend
    reads the bytes from its own mount. On (re)connect it calls `/logs/agent/hello` and the backend rescans.
  - **Windows does not notify writes to a file its writer keeps open** (every logger: log4j2, logback) - only
    when it is closed or rotated, so a live log arrived in bursts minutes apart. For the files being followed
    (and only those: `GET /logs/agent/followed`, the live non-archive files of active watches, re-read every
    5 s) the agent therefore also checks the size every 200 ms (`os.stat`: a metadata query that never blocks
    the writer's rename on rotation) and reports a change. Nothing is sent while a file is unchanged. This is
    the one timer on the watched-folder path; Linux (inotify) does not need it.
  - `logs_watch_mode=auto` (default) picks agent on Windows/macOS, events on Linux.
- Measured (Docker Desktop on Windows, agent): a line appended to a watched file that its writer keeps open is
  searchable after **66-113 ms, median 85 ms** (before the size check: when the writer closed the file, minutes
  later). A writer that closes the file after each write: 41-78 ms, median 48 ms. The explorer inserts new lines at the top without clearing or reloading the list (no flicker),
  ~150 ms after the signal.
- Linux limits: network shares (NFS/SMB) send no events for other machines' writes (run the agent on the writer);
  buffered loggers show lines when they flush; `logrotate copytruncate` itself can lose lines (prefer `create`);
  SELinux hosts get the `z` label on the mount.

## Session recordings (2026-10-04)

`log_session` (one JSON document per session). A session is a stretch of arrival time (`INGESTED` pill, epoch ms on
`ll_<id>.ingested_ms`) plus either an optional filter (**time window**) or `EQ idField idValue` (**one ID** - only
lines carrying it). Recording never pauses reading; markers are wall-clock notes; stopping pins the lines (kept
forever) and stores line/error counts. Opening a session is an ordinary explorer query with its pills
(`/logs/:id?session=<id>`), markers shown between the lines; `/logs/:id/sessions` lists, renames, annotates and
deletes them (deleting keeps the lines).

## Deliberate exceptions (plan.md Complexity Tracking)

- A single followed file under `/logs` ("Follow a file") is checked every `LOGS_FOLLOW_STAT_MS` (1 s): that folder
  has no notifier. Watched folders (above) are notified instead and never use the timer. The UI never polls.
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
