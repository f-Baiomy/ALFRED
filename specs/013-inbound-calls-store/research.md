# Research: Inbound calls that survive a busy backend

All figures measured on the running Docker install on 2026-10-09 unless marked otherwise.

## R1. Why reports fail today (baseline)

- **Decision**: treat two causes as primary - memory headroom and the locked whole-file rewrite - and the 2 s report
  timeout as the trigger that turns any stall into a lost or damaged call.
- **Evidence**:
  - Heap limit 1 GB (`-XX:MaxRAMPercentage=50` of the 2 GB container, `backend/Dockerfile`). After a forced full GC
    (`jcmd GC.class_histogram`, 324 ms incl. the histogram) 835 MB stays live; 680 MB of it `byte[]` - the 7,000
    cached `CallRecord`s of `InternalCallsFileLogAdapter` (`INTERNAL_CALLS_RETENTION_ROWS=7000` in `.env`). 5 full GCs
    in ~20 quiet minutes.
  - `internal-calls.log` is 467 MB / 10,031 lines. Compaction runs when lines exceed retention + max(50, retention/2)
    (= 10,500) and is `synchronized` with `save`/`complete`. On the Docker Desktop bind mount (`/appdata` =
    `backend/data` on the Windows host) `cp` of that file takes 6.7 s, `cat` 2.5 s.
  - Appends do not trigger a rescan (3 probe calls, list reads stayed 10-15 ms).
  - Proxy `print()` output is block-buffered under Docker (no TTY, no `PYTHONUNBUFFERED`): the `[webhook] ... failed`
    lines for 02:09 UTC only appeared at the 02:33 container restart.
- **Alternatives considered**: blaming a full rescan of the file on every append (ruled out by the probe); blaming
  WildFly or the network (the failures are on the proxy -> backend hop only).

## R2. Report timeout and retry (FR-001, FR-002)

- **Decision**: one shared policy in both addons' `_send_webhook`: timeout `WEBHOOK_TIMEOUT_SECONDS` and
  `PREPARE_TIMEOUT_SECONDS` default **15** (env-overridable as today). On a *retryable* failure retry up to **3**
  times after **2, 5, 10 s** (`asyncio`-free: the worker is a plain thread, so `time.sleep` there is correct - it is
  never the mitmproxy event loop). Retryable = timeout, connection refused/reset, HTTP 5xx. **Not** retried: HTTP 4xx
  (401 wrong secret, 404 unknown call, 400 bad payload) - a definite answer that a retry cannot change.
- **Ordering**: the worker is a single thread draining a FIFO queue, so a call's prepare is delivered or given up
  before its complete is even attempted. Retries block the queue behind them - acceptable: the spec asks for delay,
  not loss, and the proxied traffic never waits on the queue.
- **Synchronous path**: a Relive step's prepare is sent with `asyncio.to_thread(_send_webhook, ...)` on the request
  path (the app may call a supplier immediately). It is tried **once** there with the longer timeout; on a retryable
  failure the same prepare is put on the worker queue (`_webhook_queue.put_nowait(('prepare', ...))`) so it still gets
  its 3 retries (FR-001) without the request waiting. The queue is FIFO, so it is still sent before that call's
  complete.
- **Idempotency**: a timed-out attempt may still have been processed. A repeated prepare must merge, a repeated
  complete must not add a second row - see R5 (upserts by id) and, for the file fallback, a "already stored" check in
  `complete` (the call id is already on disk -> update nothing, return true).
- **Alternatives considered**: retry forever with a bounded queue (rejected in clarification: floods the backend after
  an outage); raising only the timeout (does not cover a restart).

## R3. Failure lines visible immediately (FR-003)

- **Decision**: `print(..., flush=True)` for every webhook failure line, and `PYTHONUNBUFFERED=1` for both proxy
  services in `docker-compose.yml` (covers every other diagnostic print too). The native supervisor already reads the
  child's stdout line by line - check during implementation that it passes `-u`/`PYTHONUNBUFFERED` too.
- **Line shape**: `[webhook] <phase> attempt <n>/4 failed for <call id>: <kind>: <detail>` and on give-up
  `[webhook] <phase> given up for <call id> after 4 attempts`. Never a body, header or the secret (constitution I).

## R4. Heap share (FR-004, FR-005)

- **Decision**: Docker `backend/Dockerfile` CMD `-XX:MaxRAMPercentage=75` (1.5 GB of the unchanged 2 GB container).
  Leaves 512 MB for metaspace (~55 MB measured), thread stacks, the SQLite page caches and direct buffers.
- **Native install**: the supervisor starts the backend with `-Xmx${ALFRED_MEMORY:-2g}` (`packaging/launcher/supervisor.py`)
  - a 2 GB **heap** already, more than the 1.5 GB target. No change; FR-005 is met by the existing default, and the
  owner's `ALFRED_MEMORY` still wins.
- **Expected effect**: 835 MB live of 1.5 GB = 44 % free after GC (target >= 40 %, SC-003), before Story 4 removes the
  in-memory window entirely.
- **Alternatives considered**: raising `mem_limit` to 3 GB (rejected in clarification); `-Xmx` in Docker (a percentage
  keeps following `mem_limit` if the owner changes it).

## R5. Inbound store in SQLite (FR-006 - FR-013)

- **Decision**: a `SqliteInternalCallLogAdapter` + `SqliteInternalCallsRepository` + `BatchWriter` in
  `backend-internal-calls/adapter/out/sqlite`, selected by `alfred.storage.internal-calls.type` (`sqlite` default,
  `matchIfMissing=true`; `file` keeps `InternalCallsFileLogAdapter`). Database file `INTERNAL_CALLS_DB_FILE`, default
  `/appdata/internal-calls.db` (native: `<data>/internal-calls.db` through the supervisor's env mapping, like
  `CALLS_DB_FILE`).
- **Modelled on** `backend-calls`' `SqliteCallsRepository`/`BatchWriter` (metadata/request/response/ws-message tables,
  FTS5 trigram haystack with LIKE fallback, single writer thread with group commit, incremental auto-vacuum, size
  retention). **Copied, not shared**: slices never share code (`docs/architecture.md`: "same webhook/query/detail
  shape, deliberately not shared code"; `CallListSupport` is already duplicated the same way). Only what the inbound
  port needs is copied - no supplier attribution, no timing columns, no parent/child, no legacy single-table
  migration.
- **Prepare and complete become order-independent upserts**: prepare = `INSERT ... ON CONFLICT(id) DO UPDATE` of the
  request-side columns only (keeping any outcome already there); complete = `INSERT ... ON CONFLICT(id) DO UPDATE` of
  the outcome columns only (keeping any request already there; the completion's `call` identity fills url/method/time/
  project only where still null). Either order yields the same row, a repeat of either is harmless, and a restart
  between them loses nothing (the prepared row is on disk, `IN_PROGRESS`, as outbound already does). This replaces the
  in-memory `pendingById` + `completedWithoutPrepare` race handling of commit 326ac85b for the SQLite store;
  `prepareOrMerge` returns true when the upsert met a row that was already completed, so the service still pushes
  "completed" instead of "prepared".
- **Visible in-progress rows**: with the file store a prepared call lived only in memory and appeared on completion;
  with SQLite it is listed `IN_PROGRESS` from prepare on - same as outbound calls and what the WebSocket "prepared"
  push already announces (`InternalWebSocketCallNotificationAdapter` broadcasts the same `CallEvent`, with the
  summary's `IN_PROGRESS` state, for both). Verify during implementation that the inbound list view renders a fetched
  in-progress row the way the outbound one does (until now it only ever received them by push).
- **Retention (FR-008)**: count = existing `alfred.internal-calls.retention-rows` (live-changeable via `RetentionPort`,
  as today); size = new `alfred.storage.internal-calls.max-size-bytes` (env `INTERNAL_CALLS_MAX_SIZE_BYTES`, default
  10 GB). Checked every N saves on the writer thread; deletes the oldest by `rowid` in batches of at most 200 per pass
  (`DELETE ... WHERE rowid IN (SELECT rowid ... ORDER BY rowid LIMIT ?)`), then `PRAGMA incremental_vacuum` for size,
  exactly as outbound does. Never a whole-table rewrite.
- **Relive run deletes**: `DELETE` by `json_extract(relive_json,'$.runId') IN (...)` with an expression index (as
  outbound) - no tombstone journal needed; an in-flight call of a deleted run is refused at complete by checking a
  short in-memory set of deleted run ids, mirroring what the file adapter's journal achieves.
- **Range reads are metadata-only - checked**: `findResolvedInRange` serves `GetCallsInRangeUseCase`, whose callers
  are `backend-call-overlap` (`CallOverlapService`: timing bars, metadata only) and `backend-app/triagebridge/
  TriageBackfill`, which already reads each body separately through the detail use case (`withBody(...)`, its own
  comment at line 152: "Range reads carry metadata only"). So the SQLite override returns `CallRecord`s with
  `request`/`response` bodies null, exactly as outbound's `SqliteCallsRepository.findResolvedInRange` does.
- **Disk full / database error (FR-014)**: a failed `BatchWriter` commit surfaces as an exception to the webhook
  thread; the service lets it reach `GlobalExceptionHandler` (500, ERROR logged with the call id, no body), so the
  proxy retries (R2). Reads use separate pooled connections and keep working.
- **Reads never materialize the store** (constitution II): `query` is windowed SQL over metadata with FTS; `readAll()`
  is kept only for the callers that truly need everything and is reviewed per caller (see data-model "Port methods").
  `findResolvedInRange`, `recentRequestHeaders`, `baselineFor`, `statusBreakdown`, `findByReliveRunId` get SQL
  overrides - the `readAll()`-default trap from `docs/architecture.md`.
- **Alternatives considered**: keeping the file and only shrinking retention (rejected by the owner); moving
  `BatchWriter` into `backend-platform` to share it (platform holds only web cross-cutting code; a shared persistence
  helper would be the first cross-slice code dependency and touch `backend-calls` for no user value).

## R6. Migration from `internal-calls.log` (FR-009, SC-006)

- **Decision**: `@PostConstruct migrateLegacyFileIfPresent()` on the SQLite adapter, like `SqliteCallLogAdapter`:
  1. Skip if `INTERNAL_CALLS_FILE` does not exist (fresh install or already migrated).
  2. One streaming pass records the byte offsets of the last *retention* non-empty lines (no parsing, a few bytes per
     line - the same `lastNonEmptySpans` technique compaction uses), skipping ids in the Relive deleted-ids journal.
  3. Parse and insert those lines oldest-first through the writer in batches (`INSERT OR IGNORE` by id).
  4. Rename the file to `internal-calls.log.migrated` (and the journal to `.migrated`). The rename is the completion
     marker: an interrupted migration re-runs on the next start and `OR IGNORE` skips what was already copied.
  - Malformed lines are skipped with a WARN (count logged), id-less lines get a generated id - same rules as today.
- **Measured budget**: reading the 467 MB file takes 2.5 s; 7,000 inserts in 500-row group commits are seconds. SC-006
  (< 5 min) has wide margin; the backend logs the migrated count and duration.
- **Startup (revised after the real move)**: the move runs in a background thread and the backend serves from the
  start. Measured on the owner's install (6,751 calls, 467 MB, Docker Desktop bind mount of a Windows folder): 22.7 min
  run inline at startup - backend unreachable, reports given up - and still ~18 min with batched transactions, because
  the work is I/O-bound across the mount (12.7 % CPU), not commit-bound. Moved calls are written at negative rowids fixed
  by their line position, new calls always get positive ones (`max(max(rowid), 0) + 1`), so the list order and
  retention stay right while both happen at once, and a re-run puts each call back on its own row. Each migration
  connection also uses the 16 MB page cache (below).

## R7. What reads inbound calls (FR-010 regression surface)

Callers of `backend-internal-calls` ports, all through use-case ports (no adapter access from outside the slice):
the live list and filters (`GetCallsUseCase`), detail, WebSocket messages, baseline, recent request headers (resend
host lookup), status breakdown/storage size (Settings), Relive run lookup/delete (`FindInternalReliveRunCallsUseCase`,
`DeleteInternalReliveCallsUseCase`), session-cycle capture (observer port, unchanged), investigation and triage
bridges (through `GetCallsUseCase`/detail), exports and MCP (through the HTTP API). **Decision**: run the existing
`InternalCallsFileLogAdapterTest` scenarios against both adapters via a shared abstract contract test, plus the
slice's service/controller tests unchanged.

## R9. End-to-end tests

- **Decision**: a stdlib-only Python E2E script, `tests/e2e/inbound_store_e2e.py`, in the style of the existing
  `tests/e2e/native_install_e2e.py` (`step(name, ok, detail)` printing `PASS`/`FAIL`, `wait(predicate, seconds)`,
  exit code = number of failures). It drives a **separate, throwaway Docker stack** built from the real
  `docker-compose.yml` plus an override, never the owner's running Alfred:
  `docker compose -p alfred-e2e --env-file tests/e2e/e2e.env -f docker-compose.yml -f tests/e2e/compose.e2e.yml`.
  - `compose.e2e.yml` (Compose >= 2.24 merge tags; this machine has 2.35): `container_name: !override alfred-e2e-*`
    for every service, `ports: !reset [...]` with E2E-only host ports (backend 15000, gateway 13000, reverse proxy
    listener 18080, forward proxy 127.0.0.3:18443), every bind mount of `backend/data` and the `proxy/*.flag` files
    re-pointed at `tests/e2e/.work/` (gitignored, recreated per run), and one extra service `e2e-upstream`
    (`python:3.12-alpine`, a ~30-line echo app: returns JSON with the request it got, `/slow?ms=` sleeps).
  - `e2e.env`: `WEBHOOK_SECRET=e2e`, `REVERSE_PROXY_ENABLED=true`, `INTERNAL_CALL_SERVICES=e2e:18080:8000`,
    `REVERSE_PROXY_UPSTREAM_HOST=e2e-upstream`, `INTERNAL_CALLS_RETENTION_ROWS=50`, store type per scenario.
  - Reusing the real compose file keeps the E2E stack in step with what ships; the override only renames, re-ports
    and re-homes it.
- **Scenarios** (one function each, each starts from a clean `.work/` unless noted):
  E1 an inbound call through the reverse proxy is stored complete (SQLite store; method, URL, time, project,
  request and response bodies via `/internal-calls` + detail) · E2 `docker pause` backend 10 s while 20 calls flow ->
  20 stored complete, proxy log has attempt lines within 5 s and no "given up" (SC-001, SC-002) · E3 `docker restart`
  backend during 30 calls -> 30 stored (SC-001) · E4 backend stopped 90 s -> "given up" lines appear, nothing hangs,
  traffic still answered by the upstream (FR-002) · E5 forward proxy: an outbound call during a 10 s pause is stored
  (FR-001 on the forward proxy) · E6 migration: `.work/data/internal-calls.log` seeded with 80 realistic lines (incl.
  one malformed, one id-less, one tombstoned in `internal-calls.log.relive-deleted`) and retention 50 -> first start
  stores exactly the newest 50 valid ones in order, file renamed `.migrated`, restart changes nothing (FR-009) ·
  E7 parity: the same 30 calls sent once with `INTERNAL_CALLS_STORAGE=file` and once with `sqlite` give equal answers
  for list (all sorts), search (a body substring), project filter, detail, status breakdown, `/call-overlaps`,
  `/call-logs/search` and a `.json` export of a cycle (FR-010, FR-013) · E8 retention: 120 calls with retention 50 ->
  exactly the newest 50 remain, each report answered < 1 s (FR-008, SC-005) · E9 heap: `MaxHeapSize` of the backend
  container is 75 % of its limit (FR-004) · E10 identity bounds: a completion with a 9 KB `call.url` answers 400
  (FR-015).
- **Native install**: extend `tests/e2e/native_install_e2e.py` with one inbound check - a call through the native
  reverse proxy is stored and `<data>/internal-calls.db` exists (FR-012) - run by the existing
  `tests/e2e/run_in_container.sh` flow after `python build.py`.
- **Cost**: the stack builds from local images (`docker compose build` once); a full run is a few minutes, so it is
  run at each story checkpoint, not on every edit. Owner's budget rule: the main session runs it.
- **Alternatives considered**: a standalone E2E compose file (drifts from the shipped one); running against the
  owner's stack (would pollute and evict real calls); Testcontainers in JUnit (the proxies are Python/mitmproxy and
  the point is the whole Docker topology).

## R8. Docs to update in the same change

`CLAUDE.md` (inbound ring-buffer paragraph, memory note), `AGENTS.md`, `docs/architecture.md` (internal-calls is no
longer the file-only exception; retention, migration), `docs/supplier-integrations.md` (webhook timeout/retry),
`docs/server.md` (new settings), `settings.properties` (+ comments on inbound retention/memory), `docker-compose.yml`
comments for `mem_limit`/heap share.
