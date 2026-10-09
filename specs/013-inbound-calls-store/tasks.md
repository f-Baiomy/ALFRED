# Tasks: Inbound calls that survive a busy backend

**Input**: Design documents from `specs/013-inbound-calls-store/` (plan.md, spec.md, research.md, data-model.md,
contracts/webhooks.md, contracts/settings.md, quickstart.md)

**Tests**: included - the constitution (VI) requires tests per layer and a failing-first test for every bug fix.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 reports survive a stall · US2 failures visible · US3 heap headroom · US4 SQLite store
- **E2E**: scenarios E1-E10 (research R9) run by `sh tests/e2e/run_inbound_e2e.sh [E..]` on the isolated `alfred-e2e`
  stack; each story's checkpoint requires its scenarios to print `PASS`. Never point E2E at the owner's stack.

## Path Conventions

- `IC` = `backend/backend-internal-calls/src/main/java/com/fathy/alfred/backend/internalcalls`
- `ICT` = `backend/backend-internal-calls/src/test/java/com/fathy/alfred/backend/internalcalls`
- Large files: never read `proxy/interception.py` or `frontend/src/styles.scss` whole; use `codegraph explore`/Grep.
- Backend tests: Docker JDK 21 (`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -pl backend-internal-calls test`); proxy tests: `cd proxy && python -m pytest -q`.

---

## Phase 1: Setup

**Purpose**: confirm the baseline the success criteria are measured against.

- [X] T001 Record the baseline in `specs/013-inbound-calls-store/quickstart.md` "Baseline" section: run the Story 3 jcmd/jstat commands and `docker exec backend sh -c 'wc -l /appdata/internal-calls.log; ls -la /appdata/internal-calls.log'`; note heap limit, old-gen % after forced GC, line count, file size (expected ~1 GB / ~80 % / ~10k lines / ~467 MB)

---

## Phase 2: Foundational

**Purpose**: the shared delivery helper both proxies use - US1 and US2 both build on it.

- [X] T002 In `proxy/log_and_route_reverse.py`, extract the body of `_send_webhook(phase, call_id, data)` into `_deliver(phase, call_id, data, timeout, retries)` that returns `('ok' | 'retryable' | 'final', reason)` - classify `urllib.error.HTTPError` 5xx and `TimeoutError`/`socket.timeout`/`URLError`/`ConnectionError` as retryable, HTTP 4xx as final; keep `_send_webhook` as the caller (no behaviour change yet) and keep the existing `X-Webhook-Secret`/URL building
- [X] T003 [P] Mirror T002 in `proxy/log_and_route.py` (forward proxy; same function shape, its own `WEBHOOK_URL` paths `/calls/webhook/...`)

### E2E harness (used by every story)

- [X] T003a [P] Create `tests/e2e/upstream_app.py` (stdlib `http.server`, listens on 8000): any method/path answers 200 JSON `{"method","path","headers","body"}` echoing the request; `OPTIONS` answers 200 with CORS headers; `/slow?ms=N` sleeps N ms first; `/status?code=N` answers with status N; prints nothing per request
- [X] T003b [P] Create `tests/e2e/e2e.env` (`WEBHOOK_SECRET=e2e`, `REVERSE_PROXY_ENABLED=true`, `INTERNAL_CALL_SERVICES=e2e:18080:8000`, `REVERSE_PROXY_UPSTREAM_HOST=e2e-upstream`, `INTERNAL_CALLS_RETENTION_ROWS=50`, `INTERNAL_CALLS_STORAGE=sqlite`, `BACKEND_PORT=15000`) and `tests/e2e/compose.e2e.yml` overriding `docker-compose.yml`: `container_name: !override alfred-e2e-<service>` for every service; `ports: !reset` then E2E ports (backend `127.0.0.1:15000:5000`, app-gateway `127.0.0.1:13000:80`, reverse-proxy `127.0.0.1:18080:18080`, proxy `127.0.0.3:18443:8080`); every `./backend/data` and `./proxy/*.flag` bind mount re-pointed at `./tests/e2e/.work/...` (same container targets); named volumes renamed `alfred-e2e-*`; add service `e2e-upstream` (`python:3.12-alpine`, mounts `upstream_app.py`, on `alfred-net`); add `tests/e2e/.work/` to `.gitignore`
- [X] T003c Create `tests/e2e/run_inbound_e2e.sh`: `set -e`; recreate `tests/e2e/.work/` (data dir, flag files with `e2e=on`); compose command = `docker compose -p alfred-e2e --env-file tests/e2e/e2e.env -f docker-compose.yml -f tests/e2e/compose.e2e.yml`; register an EXIT trap running `down -v` with it so the stack is always removed; `up -d --build`; wait for `http://127.0.0.1:15000/health`; run `python tests/e2e/inbound_store_e2e.py "$@"`; exit with the script's code. Refuse to run if a running container already uses one of the E2E host ports
- [X] T003d Create `tests/e2e/inbound_store_e2e.py` skeleton copying `call`/`wait`/`step` from `tests/e2e/native_install_e2e.py` (BASE `http://127.0.0.1:15000`, reverse proxy `http://127.0.0.1:18080`, forward proxy `http://127.0.0.3:18443`), a `compose(*args)` helper (same project/env/files as T003c), `proxy_log_since(seconds)`, `send_inbound(n, path)`, a scenario registry (`E1`..`E10`, run all or those named in argv), exit code = failures; add **E1** now (one inbound call stored complete: method, URL, timestamp, project `e2e`, request and response bodies via `/internal-calls` and its detail endpoint) - it passes against today's file store too
- [X] T003e Run `sh tests/e2e/run_inbound_e2e.sh E1`; must print `PASS` and leave no `alfred-e2e-*` container or volume (`docker ps -a`, `docker volume ls`)

**Checkpoint**: `cd proxy && python -m pytest -q` still 453+ passed; E1 passes on the isolated stack.

---

## Phase 3: User Story 1 - A slow moment never loses or damages a call (Priority: P1) MVP

**Goal**: reports wait 15 s and are retried 3 times (2/5/10 s) on retryable failures, in order, off the request path;
a repeated report never creates a second row.

**Independent Test**: quickstart "Stories 1-2" - pause the backend 10 s while sending 20 calls; all stored complete,
no "given up" line.

### Tests for User Story 1

- [X] T004 [P] [US1] Create `proxy/test_webhook_delivery.py` (reuse `test_interception.FakeFlow`/`run` like `test_db_capture_headers.py`): with `urllib.request.urlopen` patched to fail N times then succeed - (a) a timeout is retried and delivered on attempt 2, sleeping 2 s (patch `time.sleep`, assert the waits are `[2]`); (b) 4 failures give up after waits `[2, 5, 10]`; (c) HTTP 404 and 401 are not retried; (d) HTTP 503 is retried; (e) queue order: a prepare that fails twice is still sent before its complete; (f) the Relive synchronous prepare path is attempted once on the request path and, on a retryable failure, put on the worker queue (assert `put_nowait(('prepare', id, ...))`) where it gets its retries before the call's complete - for both `log_and_route_reverse` and `log_and_route`
- [X] T005 [P] [US1] In `ICT/adapter/out/filelog/InternalCallsFileLogAdapterTest.java` add `aRepeatedCompletionNeverStoresASecondRow`: prepare "x", complete "x" twice (second as if retried after a timeout) -> `readAll()` has exactly one "x" and the second `complete` returns true without writing; and `aRepeatedPrepareAfterCompletionIsMergedNotHeld` (prepare after its completion, twice -> merged once, `pendingById` empty)

### Implementation for User Story 1

- [X] T006 [US1] In `proxy/log_and_route_reverse.py` set defaults `WEBHOOK_TIMEOUT_SECONDS = float(os.environ.get('WEBHOOK_TIMEOUT_SECONDS', '15'))` and `PREPARE_TIMEOUT_SECONDS` default `'15'`; add `WEBHOOK_RETRY_DELAYS = (2, 5, 10)`; make `_send_webhook` loop over attempts using `_deliver`, `time.sleep(delay)` between retryable failures (worker thread only - add a comment that this never runs on the mitmproxy loop), stop on `'ok'`/`'final'`; for the Relive `asyncio.to_thread(_send_webhook, 'prepare', ...)` call pass `retries=False` and, when that single attempt ends `'retryable'`, `_webhook_queue.put_nowait(('prepare', call_id, call_log))` so the worker retries it (request never waits on a retry)
- [X] T007 [P] [US1] Same as T006 in `proxy/log_and_route.py` (find its synchronous Relive/parent prepare call, if any, and give it the same once-then-queue handling)
- [X] T008 [US1] In `IC/adapter/out/filelog/InternalCallsFileLogAdapter.java` `complete(...)`: when no pending call exists and the id is already stored in the cached lines with a non-null response, return true without saving (a retried completion); keep the 326ac85b paths otherwise; make T005 pass
- [X] T009 [US1] Verify outbound idempotency in `backend/backend-calls/.../adapter/out/sqlite/SqliteCallsRepository.java` `complete`/`prepare` (repeat = same row; find via `codegraph explore "SqliteCallsRepository complete prepare"`); if a repeated prepare after complete would reset the outcome, change its SQL to keep outcome columns, with a test in `backend/backend-calls/src/test/java/.../adapter/out/sqlite/SqliteCallsRepositoryTest.java`
- [X] T010 [US1] Run `cd proxy && python -m pytest -q` and the internal-calls + calls module tests; all green
- [X] T010a [US1] Add E2E scenarios to `tests/e2e/inbound_store_e2e.py`: **E2** `compose("pause","backend")`, send 20 inbound calls (threads), sleep 10 s, unpause -> within 60 s all 20 listed complete (request and response present), proxy log has no "given up"; **E3** send 30 calls 1/s while `compose("restart","backend")` -> 30 stored complete; **E4** `compose("stop","backend")`, send 3 calls -> each answered by the upstream within 2 s (traffic never waits on reports), after 90 s the proxy log shows "given up" for them, then `compose("start","backend")`; **E5** pause backend, send one call through the forward proxy to `http://e2e-upstream:8000/out`, unpause -> it appears in `/calls`. Run `sh tests/e2e/run_inbound_e2e.sh E2 E3 E4 E5`: all PASS

**Checkpoint**: US1 deliverable alone - retries in place, no duplicates.

---

## Phase 4: User Story 2 - A failed report is visible when it happens (Priority: P1)

**Goal**: every failed attempt and every give-up is printed immediately with phase, attempt and reason.

**Independent Test**: stop the backend, send one call, the line is in `docker logs reverse-proxy` within 5 s.

### Tests for User Story 2

- [X] T011 [P] [US2] In `proxy/test_webhook_delivery.py` add: captured stdout (patch `builtins.print`) shows exactly the contract lines from `contracts/webhooks.md` (`[webhook] prepare attempt 1/4 failed for <id>: timed out`, `... given up for <id> after 4 attempts`, `... failed for <id>: HTTP 404 Not Found (not retried)`), each printed with `flush=True`, and never containing the secret, a header value or a body - both addons

### Implementation for User Story 2

- [X] T012 [US2] In `proxy/log_and_route_reverse.py` `_send_webhook`: print the contract lines with `flush=True` (attempt n of 1+len(delays), reason from `_deliver`), replacing today's single `[webhook] ... failed to notify` lines
- [X] T013 [P] [US2] Same as T012 in `proxy/log_and_route.py`
- [X] T014 [P] [US2] In `docker-compose.yml` add `- PYTHONUNBUFFERED=1` to the `environment:` of the `proxy` and `reverse-proxy` services, with a one-line comment (failure lines only appeared at container restart on 2026-10-09)
- [X] T015 [P] [US2] In `packaging/launcher/supervisor.py` make sure both mitmproxy children run unbuffered (add `PYTHONUNBUFFERED=1` to their env where the proxy commands are built; find with Grep `mitmdump`); extend `tests/python/test_supervisor*.py` (or the existing launcher test that checks proxy env) to assert it
- [X] T015a [US2] Extend E2 in `tests/e2e/inbound_store_e2e.py`: while the backend is paused, poll `proxy_log_since(...)` - the first `[webhook] prepare attempt 1/4 failed` line for one of the 20 calls must appear within 20 s of sending it (15 s timeout + 5 s, SC-002), i.e. while the container is still running, not at restart; and assert no proxy log line contains a request body text or the secret
- [X] T016 [US2] Deploy and verify per quickstart: `docker compose up -d reverse-proxy proxy`, `docker stop backend`, one curl through 127.0.0.1:8080, `docker logs --since 30s reverse-proxy | grep webhook` shows the attempt line within 5 s; `docker start backend`; then the quickstart restart case (30 calls during `docker restart backend` -> 30 stored complete, SC-001); record results in `specs/013-inbound-calls-store/quickstart.md`

**Checkpoint**: US1 + US2 = the full P1 scope; commit.

---

## Phase 5: User Story 3 - Alfred has room to work (Priority: P2)

**Goal**: backend heap 1.5 GB of the 2 GB container.

**Independent Test**: quickstart "Story 3" - MaxHeapSize 1.5 GB, old gen <= 60 % after forced GC with 7,000 calls.

- [X] T017 [US3] In `backend/Dockerfile` change `-XX:MaxRAMPercentage=50` to `75` in the `CMD`, with a comment citing the 2026-10-09 measurement (835 MB live of 1 GB)
- [X] T018 [P] [US3] Update the `mem_limit` comments in `docker-compose.yml` (around the `backend` service, "Gives the JVM's -XX:MaxRAMPercentage ...") to say 75 % / 1.5 GB heap / 512 MB outside it
- [X] T018a [US3] Add **E9** to `tests/e2e/inbound_store_e2e.py`: the backend container's memory limit (`docker inspect alfred-e2e-backend --format '{{.HostConfig.Memory}}'`) and the running JVM's max heap (`docker run --rm --pid=container:alfred-e2e-backend maven:3.9-eclipse-temurin-21 jcmd 1 VM.flags`, field `MaxHeapSize`) -> heap = 75 % of the limit (within 1 %); run E9: PASS
- [X] T019 [US3] Rebuild (`docker compose up -d --build backend && docker compose restart app-gateway`), run the Story 3 commands, record MaxHeapSize and old-gen % in `specs/013-inbound-calls-store/quickstart.md`; SC-003 met when free >= 40 %

**Checkpoint**: commit; US3 independent of US1/US2.

---

## Phase 6: User Story 4 - Inbound calls live in a database (Priority: P2)

**Goal**: SQLite store for `backend-internal-calls` (default), file store as `type=file`, one-time migration,
count + size retention in small batches, every reader unchanged.

**Independent Test**: quickstart "Story 4" - migration logged, `.migrated` file kept, list/search/cycles/exports
unchanged, memory flat at 1,500 vs 20,000 calls, reports < 1 s during trims.

### Tests for User Story 4

- [X] T020 [US4] Create `ICT/adapter/out/InternalCallStoreContractTest.java`: abstract JUnit class with `protected abstract CallLogPort newStore(Path dir, int retentionRows)`; move every store-behaviour test from `ICT/adapter/out/filelog/InternalCallsFileLogAdapterTest.java` that is not file-specific (prepare/complete, completion without prepare + `known`, late prepare merge, repeated complete/prepare, query filters/search/sort/pagination, findById, findByReliveRunId, deleteByReliveRunIds incl. an in-flight call completing after its run was deleted, ws messages + cap, recentRequestHeaders, baseline, statusBreakdown, retention by count) into it; make `InternalCallsFileLogAdapterTest` extend it keeping the file-only tests (compaction, missing ids, tombstone journal, malformed lines)
- [X] T021 [P] [US4] Create `ICT/adapter/out/sqlite/SqliteInternalCallsRepositoryTest.java` extending the contract (store on `@TempDir`), plus SQLite-only tests: prepare-then-complete and complete-then-prepare give identical rows; a prepared call survives a new repository instance on the same file (restart) as `IN_PROGRESS`; retention by size removes oldest first and never more than 200 rows per pass; FTS search matches a substring inside a response body and the LIKE fallback gives the same ids; list query never selects body columns (assert the SQL string or use a 2 MB body and a heap-bound check)
- [X] T022 [P] [US4] Create `ICT/adapter/out/sqlite/SqliteInternalCallLogAdapterMigrationTest.java`: legacy `internal-calls.log` with 12 lines (one malformed, one without id, one whose id is in `internal-calls.log.relive-deleted`) and retention 5 -> exactly the newest 5 valid non-deleted calls inserted oldest-first; file renamed to `internal-calls.log.migrated`; a second start does nothing; an interrupted run (file not renamed, 3 rows already inserted) completes without duplicates

- [X] T022a [P] [US4] In `ICT/adapter/out/sqlite/SqliteInternalCallsRepositoryTest.java` add `aFailedWriteIsReportedNotSwallowed`: make the database read-only (or point the writer at a file on a full/locked path) and assert `complete` throws (so the controller answers 500 and the proxy retries), an ERROR is logged with the call id, and `query`/`findById` still answer for rows written before (FR-014)
- [X] T022b [P] [US4] In `ICT/adapter/in/web/` (the existing `InternalCallsWebhookController` test, or a new `InternalCallsWebhookControllerTest.java` with `@WebMvcTest`) assert a completion whose `call.url` exceeds 8 KB or `call.method` exceeds 16 chars answers 400, and a store failure answers 500 (FR-014, FR-015)
- [X] T022c [P] [US4] Add `readAllIsNeverUsedOnARequestPath` to `SqliteInternalCallsRepositoryTest.java`: wrap the repository so `readAll()` throws, then exercise every `CallLogPort` method the services use (query, findById, findByReliveRunId, findResolvedInRange, recentRequestHeaders, baselineFor, statusBreakdown, wsMessages) - none may call it (C1)

### Implementation for User Story 4

- [X] T023 [P] [US4] Create `IC/adapter/out/sqlite/BatchWriter.java` by copying `backend/backend-calls/src/main/java/com/fathy/alfred/backend/calls/adapter/out/sqlite/BatchWriter.java` into this package (package line + Javadoc pointing at the original as the reference; slices do not share code)
- [X] T024 [US4] Create `IC/adapter/out/sqlite/SqliteInternalCallsRepository.java`: `@Value("${INTERNAL_CALLS_DB_FILE:/appdata/internal-calls.db}")`, `@Value("${alfred.storage.internal-calls.max-size-bytes:10737418240}")`, retention rows from `alfred.internal-calls.retention-rows`, ws cap from `alfred.internal-calls.ws-max-messages`; schema exactly as `data-model.md` (`internal_call_metadata`, `internal_call_request`, `internal_call_response`, `internal_call_ws_message`, `internal_calls_fts` trigram + LIKE fallback, `internal_store_meta`, indexes on timestamp_millis, status_rank, status_state, duration_ms, service_name, `json_extract(relive_json,'$.runId')`); WAL + incremental auto-vacuum set before schema creation (copy `ensureIncrementalAutoVacuum` reasoning from the outbound repository)
- [X] T025 [US4] In `SqliteInternalCallsRepository` implement writes through `BatchWriter`: `prepare` = `INSERT ... ON CONFLICT(id) DO UPDATE` of request-side columns + request row only, returning whether the row already had an outcome (for `prepareOrMerge`); `complete` = upsert of outcome columns + response row, filling identity columns from `known` only where null, returning whether a prepared row existed; refuse (return false, write nothing) a completion whose Relive run was deleted while in flight (in-memory set of deleted run ids); `haystack` rebuilt on each write from the same fields `IC/application/service/CallListSupport.matchesSearch` uses
- [X] T026 [US4] In `SqliteInternalCallsRepository` implement reads as SQL per `data-model.md` "Port methods": `query` (metadata only, FTS/LIKE, session/operation/request-id substring filters, service names, relive filter via `ReliveFilter` semantics, sort newest/oldest/slowest/status, `LIMIT/OFFSET`, `COUNT(*)` total), `findById` (joins), `findByReliveRunId`, `findResolvedInRange` (windowed, `LIMIT` seatbelt), `recentRequestHeaders`, `baselineFor`, `statusBreakdown`, `storageSizeBytes`, `wsMessages`, `appendWsMessages`, `deleteAll`, `deleteByReliveRunIds`, `readAll` (documented as not for request paths)
- [X] T026a [US4] Audit `readAll()` reachability: `codegraph explore "CallLogPort readAll findByReliveRunId findResolvedInRange recentRequestHeaders"` plus Grep `readAll()` across `backend/*/src/main` for every path into `backend-internal-calls`' ports; confirm each default that filters `readAll()` (today `CallLogPort.java` lines 96, 112, 162) is overridden in `SqliteInternalCallsRepository`, and that `findResolvedInRange` returns bodies null (its callers `CallOverlapService` and `TriageBackfill` read bodies per call via detail); make T022c pass
- [X] T027 [US4] In `SqliteInternalCallsRepository` implement retention on the writer thread every N saves: delete oldest rowids while count > retention or used bytes > max size, at most 200 per pass, then `PRAGMA incremental_vacuum`; `setRetentionRows(int)` live
- [X] T028 [US4] Create `IC/adapter/out/sqlite/SqliteInternalCallLogAdapter.java` implementing `CallLogPort` and `RetentionPort`, `@Component @ConditionalOnProperty(prefix = "alfred.storage.internal-calls", name = "type", havingValue = "sqlite", matchIfMissing = true)`, delegating to the repository; `@PostConstruct migrateLegacyFileIfPresent()` per research R6 (offset ring of the newest `retentionRows` lines via a streaming pass, skip journal ids, `INSERT OR IGNORE` oldest-first in batches, rename file and journal to `.migrated`, log count/skipped/duration)
- [X] T028a [US4] In `IC/adapter/in/web/dto/CompleteInternalCallRequestDto.java` add Bean Validation to `CallIdentityDto` (`@Size(max = 8192)` on `url`/`originalUrl`, `@Size(max = 16)` on `method`) and `@Valid` on the `call` component and on the controller's `@RequestBody` in `IC/adapter/in/web/InternalCallsWebhookController.java`; let a store exception propagate to `GlobalExceptionHandler` (500) - make T022b pass
- [X] T029 [US4] Annotate `IC/adapter/out/filelog/InternalCallsFileLogAdapter.java` with `@ConditionalOnProperty(prefix = "alfred.storage.internal-calls", name = "type", havingValue = "file")` and update its class Javadoc (no longer the only store); check `IC/adapter/out/filestore/FileLoggingToggleAdapter.java` stays unconditional
- [X] T030 [US4] Add `alfred.storage.internal-calls.type=${INTERNAL_CALLS_STORAGE:sqlite}` and `alfred.storage.internal-calls.max-size-bytes=${INTERNAL_CALLS_MAX_SIZE_BYTES:10737418240}` to `backend/backend-app/src/main/resources/application.properties` next to the other `alfred.storage.*.type` lines
- [X] T031 [P] [US4] Add `INTERNAL_CALLS_STORAGE`, `INTERNAL_CALLS_DB_FILE`, `INTERNAL_CALLS_MAX_SIZE_BYTES` to the `backend` service env in `docker-compose.yml` (defaults per `contracts/settings.md`, `INTERNAL_CALLS_DB_FILE=/appdata/internal-calls.db`) and to `settings.properties` with explanatory comments, and rewrite the `inbound_calls_retention_rows` comment block (no longer "kept entirely in memory")
- [X] T032 [P] [US4] In `packaging/launcher/supervisor.py` map `INTERNAL_CALLS_DB_FILE` to `<data>/internal-calls.db` next to where `CALLS_DB_FILE` is mapped; add the new keys to the native settings list the `backend-server` slice serves (find with `codegraph explore "CALLS_DB_FILE ALFRED_CALLS_MAX_SIZE_BYTES settings catalog"`), with tests in their existing test files
- [X] T033 [US4] Frontend check: with the SQLite store, an in-progress inbound row is returned by `GET /internal-calls`; confirm the live list renders it as in progress and replaces it on completion (`codegraph explore "internal calls list state in-progress row"`); fix only if broken, with a spec under `frontend/src/app/...` next to the touched file
- [ ] T034 [US4] Run the internal-calls module tests, then the full backend reactor + ArchUnit in Docker JDK 21, `cd frontend && npm test && npm run build` if T033 changed anything; all green
- [X] T034a [P] [US4] Create `scripts/inbound_load.py` (stdlib only: `urllib`, `concurrent.futures`, `argparse`): `--url`, `--secret`, `--calls`, `--concurrency`, `--body-kb` (default 60), `--project` (default `loadtest`); for each call POST `/internal-calls/webhook/prepare` then `/internal-calls/webhook/{id}/complete` with realistic JSON request/response bodies and the `call` identity; print stored count (via `GET /internal-calls?serviceNames=<project>&limit=1` total), failures, and p50/p95/max latency per webhook; refuse to run without `--url` (no default pointing at the real backend)
- [ ] T034b [US4] Run the quickstart load section against the throwaway `alfred-loadtest` container: 20,000 calls at concurrency 8 and a 200-call burst at concurrency 200; record p95/max webhook latency (SC-005 < 1 s), 200/200 burst stored, heap after forced GC at 1,500 vs 20,000 retained (SC-004 within 10 %), and database bytes per 1,000 calls (FTS share) in `specs/013-inbound-calls-store/quickstart.md`; remove the container and volume
- [X] T034c [US4] Add to `tests/e2e/inbound_store_e2e.py`: **E6** migration - before `up`, write `tests/e2e/.work/data/internal-calls.log` with 80 lines of realistic `CallRecord` JSON (one real line's shape: id, original_url, url, method, request{headers, body ~5 KB}, timestamp, duration_ms, response{status, headers, body ~20 KB}, state, service_name) incl. one malformed line, one without `id`, one whose id is listed in `internal-calls.log.relive-deleted`; start with retention 50 -> `/internal-calls?sort=oldest&limit=200` returns exactly the newest 50 valid ids in order, `internal-calls.log.migrated` and `internal-calls.db` exist in `.work/data`; restart backend -> same 50, no duplicates. **E7** parity - with `INTERNAL_CALLS_STORAGE=file` send 30 calls (varied methods/paths, statuses via `/status?code=`, one 2 MB body, fixed `X-Request-Id`s), record list (newest/oldest/slowest), search for a body substring, project filter, detail of 3 calls, status breakdown, `/call-overlaps` for the window, `/call-logs/search`, and a `.json` export of a session cycle made from those calls; `down -v`; repeat with `sqlite` and the same calls; compare all answers ignoring timestamps/durations - equal (FR-010, FR-013). **E8** retention - send 120 calls with retention 50 -> exactly the newest 50 remain; time each direct `complete` POST in a variant of the run -> max < 1 s (FR-008, SC-005). **E10** POST a completion to `/internal-calls/webhook/<id>/complete` with secret `e2e` and a 9 KB `call.url` -> 400 (FR-015)
- [ ] T034d [US4] Run `sh tests/e2e/run_inbound_e2e.sh` (all E1-E10) on the isolated stack: all PASS; paste the PASS/FAIL output into `specs/013-inbound-calls-store/quickstart.md` under "E2E results"
- [ ] T034e [P] [US4] Extend `tests/e2e/native_install_e2e.py`: after the existing settings step that configures project `demo:9001:8080`, send one request through `http://127.0.0.1:9001/` and assert it is listed by `/internal-calls` with its response, and that `/opt/alfred/data/internal-calls.db` exists; run via `python build.py` (Linux) + `tests/e2e/run_in_container.sh`: PASS
- [ ] T035 [US4] Deploy (`docker compose up -d --build backend && docker compose restart app-gateway`); verify migration log line, `internal-calls.db` + `internal-calls.log.migrated` in `/appdata`, live list/search/triage/one cycle export unchanged (spot-check via MCP `search_calls`, `search_logs`, `triage`); export one session cycle as .json, re-import it, compare call count and one body byte-for-byte (FR-013); record the migration count/duration (SC-006) in `specs/013-inbound-calls-store/quickstart.md`

**Checkpoint**: commit; US4 complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T036 [P] Update `CLAUDE.md` (the "Outbound and inbound are both capped" bullet: inbound now SQLite with count + size retention, file fallback; webhook timeout/retry; heap share) and `AGENTS.md` equivalents
- [X] T037 [P] Update `docs/architecture.md` (remove "backend-internal-calls is the one exception", the in-memory ring-buffer paragraph becomes the file-fallback description, add migration + retention), `docs/supplier-integrations.md` (report delivery policy from `contracts/webhooks.md`), `docs/server.md` (new settings)
- [X] T037a [P] Document the E2E suite in `docs/testing.md`: what it covers, `sh tests/e2e/run_inbound_e2e.sh [E..]`, isolation rules (own project name, ports, data; always torn down; never the owner's stack)
- [ ] T038 Run `sh tests/e2e/run_inbound_e2e.sh` (full), then quickstart end to end once more on the Docker install (Stories 1-4) and tick `specs/013-inbound-calls-store/checklists/requirements.md` notes with the measured results; final commit

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup (T001) -> Foundational (T002-T003, E2E harness T003a-T003e) -> US1 -> US2 (same functions in the addons; US2 edits what US1 wrote).
- E2E scenarios are added in the story that makes them pass: E1 (T003d), E2-E5 (T010a), E2 log timing (T015a), E9 (T018a), E6-E8 and E10 (T034c); full suite T034d and T038; native install T034e.
- US3 (T017-T019) depends on nothing - can go any time.
- US4 depends on US1's T008 only for the file-fallback idempotency test being in the contract (T020 moves it); otherwise independent of US1-US3.
- Polish after the stories it documents.

### Within Each User Story

- Tests first (they must fail before the implementation: T004/T005 before T006-T008, T011 before T012, T020-T022 before T024-T028).
- US4: T023 -> T024 -> T025/T026/T026a/T027 (same file, sequential) -> T028 -> T028a -> T029/T030 -> T031/T032 [P] -> T033 -> T034 -> T034a [P with T033] -> T034b -> T035.
- Tests T022a/T022b/T022c before T025-T028a.

### Parallel Opportunities

- T003 with T002; T003a/T003b together; T034e with T035; T004 with T005; T007 with T006; T013/T014/T015 together; T018 with T017; T021/T022/T022a/T022b/T022c/T023 together; T031 with T032; T034a with T033; T036 with T037.
- Owner's budget rule (CLAUDE.md): do the work in the main session; at most ONE subagent at a time, only for a fully specified chunk (candidate: T024-T027 after T020/T021 exist).

## Parallel Example: User Story 4

```text
After T020: T021 (SQLite contract tests) | T022 (migration tests) | T023 (BatchWriter copy)
After T030: T031 (compose + settings.properties) | T032 (native supervisor + settings catalog)
```

## Implementation Strategy

### MVP First

US1 + US2 (both P1): retries and visible failures stop calls being lost or half-stored on the next stall. Deploy and
verify (T016) before anything else.

### Incremental Delivery

1. T001-T016 (incl. E2E harness and E1-E5) -> commit -> deploy (MVP)
2. T017-T019 -> commit -> deploy (headroom)
3. T020-T035 (incl. T022a-c, T026a, T028a, T034a-b) -> commit -> deploy (database store, removes the cause)
4. T036-T038 -> docs, final verification

## Notes

- Commit after each story checkpoint, on branch `013-inbound-calls-store`.
- Every bug-fix behaviour (retry, idempotent complete, late prepare) has a test that fails without it.
- Never print bodies, headers or the webhook secret in any new log line.
