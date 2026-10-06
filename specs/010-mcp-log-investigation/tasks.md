# Tasks: Log lines in Claude's investigation tools

**Input**: Design documents from `/specs/010-mcp-log-investigation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/investigate-api.md, contracts/mcp-tools.md, quickstart.md

**Tests**: included - the constitution (VI) requires tests per layer; bug fixes start with a failing test.

**Path shorthands** (used in every task):
- `DC` = `backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture`
- `DCT` = `backend/backend-db-capture/src/test/java/com/fathy/alfred/backend/dbcapture`
- `TR` = `backend/backend-triage/src/main/java/com/fathy/alfred/backend/triage`
- `TRT` = `backend/backend-triage/src/test/java/com/fathy/alfred/backend/triage`
- `APP` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `APPT` = `backend/backend-app/src/test/java/com/fathy/alfred/backend`
- `MCP` = `mcp-server/src`, `MCPT` = `mcp-server/test`

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Write a failing test in MCPT/triage.test.ts: triage over a cycle of 250 inbound calls makes no request whose `callIds` exceeds 100 ids (fake Alfred rejects longer lists with 414, like the gateway); then lower `MAX_IDS` to 100 in MCP/triage.ts and the `/comments/counts` chunk (500 → 100) in MCP/tools/triage.ts
- [ ] T002 [P] Create the shared fingerprint vectors file specs/010-mcp-log-investigation/fixtures/fingerprint-vectors.json: ≥ 30 cases `{logger, exceptionType, message, group}` covering UUIDs, ISO/epoch timestamps, hex ≥ 8, quoted strings, numbers/decimals, emails, IPs, and pairs of different errors that must NOT share a group (research R4)

---

## Phase 2: Foundational (blocking all stories)

### Fingerprint and full-text index (db-capture)

- [ ] T003 [P] Implement the pure normaliser `LogFingerprint.of(logger, exceptionType, message)` (16 hex chars of sha1 over `logger|type|normalised`) and `LogFingerprint.normalise(message)` in DC/domain/LogFingerprint.java per research R4
- [ ] T004 [P] Test LogFingerprint against fingerprint-vectors.json (same group ⇔ same fingerprint) in DCT/domain/LogFingerprintTest.java
- [ ] T005 Add `fingerprint` to `call_log_lines` via `addColumnIfMissing`, the partial index `ix_log_lines_fp(fingerprint, at_ms)` for ERROR/SEVERE/FATAL/WARN/WARNING, set it in `saveLogLines` and `importLines`, and a start-up backfill in batches of 5,000 for rows with NULL fingerprint in DC/adapter/out/sqlite/SqliteDbCaptureRepository.java
- [ ] T006 Add the FTS5 table `call_log_text(message, logger, thread, exception, content='call_log_lines', content_rowid='id', tokenize='trigram')`, AFTER INSERT/DELETE triggers (exception = type + ' ' + message from `exception_json`), and a one-time `rebuild` when the table is created, in DC/adapter/out/sqlite/SqliteDbCaptureRepository.java
- [ ] T007 Test fingerprint set on insert/import, backfill of old rows, FTS rows following inserts and retention deletes (size-cap delete removes them), with 50,000 realistic lines in DCT/adapter/out/sqlite/SqliteDbCaptureRepositoryTest.java

- [ ] T008 Send the applied Log level on the CALL_OPEN marker: `MarkerRecord.logLevel` set from `AgentSettings` (name of the setting) in db-agent/src/main/java/com/fathy/alfred/dbagent/transport/MarkerRecord.java and db-agent/src/main/java/com/fathy/alfred/dbagent/capture/CaptureDispatcher.java, serialised by db-agent/src/main/java/com/fathy/alfred/dbagent/transport/BatchWriter.java; test in db-agent/src/test/java/com/fathy/alfred/dbagent/LogCaptureIT.java (marker carries `ERROR` by default, `APP` after `applyLogLevel("APP")`)
- [ ] T009 Store it: `MarkerDto.logLevel` / `CallMarker.logLevel`, column `call_markers.log_level` (add-if-missing), exposed on `/call-logs/{id}` as `capturedAtLevel` (falls back to the current setting, marked `assumed: true`, for older calls) in DC/adapter/in/web/dto/MarkerDto.java, DC/domain/model/CallMarker.java, DC/adapter/out/sqlite/SqliteDbCaptureRepository.java and APP/calllogsbridge/CallLogsService.java + tests in DCT and APPT/calllogsbridge/CallLogsServiceTest.java

### Signals on triage's mark

- [ ] T010 Create the out-port `CallSignalsObserverPort.signalsChanged(String callId, int logErrors, int logWarnings, int logExceptions, String logStatus, String logLevel, List<String> dbFlags)` in DC/application/port/out/CallSignalsObserverPort.java (same shape and javadoc style as StatementFailuresObserverPort)
- [ ] T011 Emit `signalsChanged` from DC/application/service/DbCaptureService.java: after an ingest batch that changed a call's log counts (from `call_log_summary`, exceptions counted at ingest), and when the call closes (DB flags taken from the summary code that computes `CallDbSummary.flags`; `logStatus` = CAUGHT / OFF / NO_AGENT as `/call-logs` decides it); optional setter injection like `setLogLink`
- [ ] T012 Re-emit signals so stored flags never go stale and imports are covered: (1) after `saveSettings`/`markExpected` changes a project's thresholds, expected statements or ignore list, recompute and emit the flags of that project's calls in batches of 500 on a background executor (DC/application/service/DbCaptureProjectsService.java); (2) emit for every call in `importLines` and the DB-capture import (DC/application/service/DbCaptureQueryService.java, DC/application/service/DbCaptureService.java)
- [ ] T013 [P] Test the emission (batch with ERROR+exception lines, close with an N+1 call, settings change re-emitting a project's flags, import emitting) in DCT/application/service/DbCaptureServiceTest.java
- [ ] T014 [P] Add record `CallSignals(logErrors, logWarnings, logExceptions, logStatus, logLevel, dbFlags)` with `rank()` (2 error / 1 warning / 0) in TR/domain/model/CallSignals.java and the `Signal` enum (HTTP_ERROR, NO_ANSWER, DB_FAILED, DB_WARNING, LOG_ERROR, LOG_WARNING, LOG_EXCEPTION, SUPPLIER_FAILED with severity) in TR/domain/model/Signal.java
- [ ] T015 Extend `CallAttention` with `logErrors, logWarnings, logExceptions, logStatus, dbFlags, signalRank` (+ `withSignals`) in TR/domain/model/CallAttention.java and update every constructor call in TR and TRT
- [ ] T016 Add columns `log_errors, log_warnings, log_exceptions, log_status, log_level, db_flags, signal_rank` (add-if-missing), index `ix_attention_signals(signal_rank, started_at) WHERE signal_rank > 0`, mapping and an upsert `saveSignals(callId, CallSignals)` that creates an UNKNOWN row when the call is not reported yet, in TR/adapter/out/sqlite/SqliteAttentionRepository.java (and AttentionStorePort in TR/application/port/out/AttentionStorePort.java)
- [ ] T017 Add `RecordCallAttentionUseCase.signals(callId, CallSignals)` and implement it in TR/application/service/TriageService.java (recompute `signal_rank` from status/error/failed statements/failing children + signals on every write that touches any of them)
- [ ] T018 [P] Test columns, upsert-before-call, rank recomputation and retention in TRT/adapter/out/sqlite/SqliteAttentionRepositoryTest.java and TRT/application/service/TriageServiceTest.java
- [ ] T019 Implement `TriageCallSignalsAdapter implements CallSignalsObserverPort` → `record.signals(...)` in APP/triagebridge/TriageCallSignalsAdapter.java, and feed existing calls once on start (calls in `call_log_summary` or with flags, bounded by triage's row cap) next to APP/triagebridge/TriageBackfill.java
- [ ] T020 Imported calls get full triage marks: when calls are imported into a cycle, record each call's mark (method, url, status, timing, error, parent) through `RecordCallAttentionUseCase` before its signals - verify the existing import path in APP/triagebridge/ and add the missing feed in APP/triagebridge/TriageImportFeed.java
- [ ] T021 [P] Test the adapter, the start-up feed, imported calls appearing with marks + signals, and a cycle-held call older than the row cap keeping its mark (existing `TriageRetainedCallIdsAdapter`) in APPT/triagebridge/TriageCallSignalsAdapterTest.java

- [ ] T022 [P] Implement pure `EndpointPattern.of(method, url)` per research R6 in TR/domain/EndpointPattern.java with tests in TRT/domain/EndpointPatternTest.java (`/booking/123` and `/booking/456` → `/booking/{id}`; unknown shapes kept) - needed by US3, US10, US14

### Scopes (investigationbridge)

- [ ] T023 Create `InvestigationScope(kind LIVE|CYCLES|ALL, List<String> cycleIds ≤ 50, boolean includeLive)` with validation and `ResolvedScope(Set<String> ids, Map<String, List<String>> heldIn, List<Unavailable> unavailable, Instant from, Instant to)` in APP/investigationbridge/InvestigationModels.java
- [ ] T024 Implement `ScopeResolver.resolve(scope, project, from, to)`: live inbound ids and their supplier calls from the internal-calls and calls use cases, cycle ids through the same session-cycles use case `triagebridge/CycleCallsReader` uses, de-duplicated with `heldIn` labels (`live`, `cycle:<name>`), plus `unavailable` projects (▤ off / no agent / ◆ off) from ManageDbCaptureUseCase, in APP/investigationbridge/ScopeResolver.java
- [ ] T025 [P] Test resolver: a call live and in two cycles counts once with three labels; unknown cycle → 404 message; > 50 cycles → 400, in APPT/investigationbridge/ScopeResolverTest.java
- [ ] T026 Add scope-table support to both stores: `withScope(Collection<String> ids, Function<JdbcTemplate,T>)` that fills `CREATE TEMP TABLE scope_ids(call_id TEXT PRIMARY KEY)` on one connection and runs the query joined to it, in DC/adapter/out/sqlite/SqliteDbCaptureRepository.java and TR/adapter/out/sqlite/SqliteAttentionRepository.java
- [ ] T027 Create `InvestigationController` with validated POST bodies (records + `@Valid`, limits clamped per data-model.md) and 400/404 mapping, no endpoints yet, in APP/investigationbridge/InvestigationController.java; confirm ArchUnit still passes (bridge depends only on use cases)

### MCP shared pieces

- [ ] T028 [P] Create MCP/scope.ts: zod `ScopeSchema` (`{live:true} | {cycle} | {cycles, includeLive} | {all:true}`), conversion to the backend body (cycle names → ids via `findCycle`), and `heldInText()`
- [ ] T029 [P] Create MCP/signals.ts: signal names/severities, `evidenceLine(call)` (one line per call, masked), `why` texts (LOGS_OFF, NO_AGENT, BELOW_LEVEL naming the call's `capturedAtLevel` and saying "assumed" when it is the current setting, DB_OFF) and a TS port of the fingerprint normaliser tested against the same vectors file
- [ ] T030 Extend MCPT/fake-alfred.ts with the six POST endpoints of contracts/investigate-api.md backed by in-memory calls/lines/signals, and a `signals` state per call

**Checkpoint**: lines carry fingerprints and are searchable; every call's mark carries its signals; scopes resolve.

---

## Phase 3: User Story 0 - Problem calls, DB or logs (P1) 🎯 MVP

**Goal**: one request lists every call with an error or warning from HTTP, DB or logs, with counts per signal.
**Independent test**: quickstart §1 - each filter returns exactly the expected calls; counts equal the pills.

- [ ] T031 [US0] Add `QueryAttentionUseCase.problemCalls(ResolvedScope, ProblemFilter, cursor, limit)` returning counts per signal over the whole scope + one page ordered by severity, signal count, newest; `ProblemFilter(all, any, none, dbFlags, minStatus, project, from, to)` in TR/domain/model/ProblemFilter.java; implement in TR/application/service/TriageService.java and SQL in TR/adapter/out/sqlite/SqliteAttentionRepository.java (signals derived from columns: HTTP_ERROR = status ≥ minStatus, NO_ANSWER = error/no status, SUPPLIER_FAILED = failing_children > 0, etc.)
- [ ] T032 [P] [US0] Test filters (AND/OR/NOT, dbFlags), counts, ordering and paging with 5,000 marks in TRT/adapter/out/sqlite/SqliteAttentionRepositoryTest.java
- [ ] T033 [US0] Expose `POST /triage/problem-calls` (contract) in APP/investigationbridge/InvestigationController.java, adding method/path/status from the marks and `heldIn`/`unavailable` from the resolved scope
- [ ] T034 [P] [US0] `@WebMvcTest` for `/triage/problem-calls` (body validation, scope errors, response shape) in APPT/investigationbridge/InvestigationControllerTest.java
- [ ] T035 [US0] Implement the `problem_calls` tool (counts first, then calls with signals + evidence line, `next`) in MCP/tools/investigate.ts and register it in MCP/server.ts
- [ ] T036 [P] [US0] Test `problem_calls`: no filter, `LOG_ERROR AND status 200`, DB warnings only, `all` scope counting once, unavailable project stated, masking of evidence, and counts using the same signal definitions as the frontend pills (DB failures = failed statement, Log errors = ≥ 1 ERROR line, Log warnings = ≥ 1 WARN line) in MCPT/investigate.test.ts

---

## Phase 4: User Story 1 - Triage counts log errors (P1)

**Goal**: a 2xx call that logged an ERROR/exception moves into an attention group with the line as evidence.
**Independent test**: quickstart §2.

- [ ] T037 [US1] Make log errors/exceptions a hidden failure (group 4) and log warnings + DB flags weaker evidence that never raises a group, in TR/domain/Priority.java (stored priority recomputed on signal writes)
- [ ] T038 [P] [US1] Test priority for: 200 + ERROR line → 4; 200 + WARN only → 6; 500 + ERROR → unchanged group, counted once, in TRT/domain/PriorityTest.java
- [ ] T039 [US1] In MCP/tools/triage.ts add per-call log evidence (up to 3 lines: level, logger, masked message, exception type, "+N more" from `/call-logs/{id}` for calls in groups 1-5), DB flag names, a `scope` input (MCP/scope.ts), and the "logs unavailable for project X" note
- [ ] T040 [P] [US1] Test triage evidence, ordering and the unavailable note in MCPT/triage.test.ts

---

## Phase 5: User Story 2 - Search log lines across calls (P1)

**Goal**: find every call that logged a text/pattern/exception, paged, with exact totals.
**Independent test**: quickstart §3 (search).

- [ ] T041 [US2] Add `CallLogLinesUseCase.search(Collection<String> scopeIds, LogSearchQuery)` → `LogSearchPage(total, hits, next)` with records LogSearchQuery/LogSearchHit in DC/domain/model/, implemented in DC/application/service/DbCaptureQueryService.java and DC/adapter/out/sqlite/SqliteDbCaptureRepository.java: FTS5 `MATCH` on a quoted literal (≥ 3 chars) or `LIKE` fallback (< 3 chars), level/logger/exception/time filters, scope temp table, `outside` lines optional, cursor by line id
- [ ] T042 [US2] Pattern search: narrow by the pattern's longest literal run through FTS, then filter candidates with `java.util.regex.Pattern` over a deadline-checking `CharSequence` (2 s total, ≤ 200,000 candidates; compile errors → 400; time/candidate limit → `cutShort { scannedLines, reason }`) in DC/domain/DeadlineCharSequence.java and DC/application/service/DbCaptureQueryService.java
- [ ] T043 [P] [US2] Test search: literal with special characters, short text fallback, pattern, search by thread, level ≥ WARN, exception type, scope restriction, exact total, paging, 50,000 lines under 1 s, and a catastrophic pattern (`(a+)+$` over long `aaaa…b` lines) returning `cutShort` within 3 s, in DCT/adapter/out/sqlite/SqliteDbCaptureRepositoryTest.java
- [ ] T044 [US2] Expose `POST /call-logs/search` (contract; hits enriched with method/path/status/callAt from the call use cases, `heldIn`) in APP/investigationbridge/InvestigationController.java + test in APPT/investigationbridge/InvestigationControllerTest.java
- [ ] T045 [US2] Implement `search_logs` (text/pattern/minLevel/logger/exceptionType/from/to/outside/scope, masked lines, total + next) in MCP/tools/logs.ts
- [ ] T046 [P] [US2] Test `search_logs` (cycle-only scope incl. calls no longer live, masking vectors, paging) in MCPT/logs-search.test.ts

**Checkpoint**: P1 complete - problem calls, triage and search work end to end.

---

## Phase 6: User Story 3 - Repeated errors grouped into log problems (P2)

- [ ] T047 [US3] Add `CallLogLinesUseCase.problems(scopeIds, levels, newSince, limit)` → LogProblem list (GROUP BY fingerprint over `ix_log_lines_fp`, counts, distinct calls, first/last, sample) and `problemCalls(scopeIds, fingerprint, cursor, limit)` in DC/domain/model/LogProblem.java, DC/application/service/DbCaptureQueryService.java, DC/adapter/out/sqlite/SqliteDbCaptureRepository.java
- [ ] T048 [P] [US3] Test grouping: 40 same-error calls with varying ids → one problem; distinct errors never merge (vectors); `isNew`; problem calls paging, in DCT/adapter/out/sqlite/SqliteDbCaptureRepositoryTest.java
- [ ] T049 [US3] Expose `POST /call-logs/problems` and `POST /call-logs/problems/calls` (endpoints per log problem = top 5 path patterns of its calls via TR/domain/EndpointPattern.java from T022) in APP/investigationbridge/InvestigationController.java + controller test
- [ ] T050 [US3] Implement `log_problems` (list; with `fingerprint` input → its calls) in MCP/tools/logs.ts + tests in MCPT/logs-search.test.ts

---

## Phase 7: User Story 4 - One call's story in order (P2)

- [ ] T051 [US4] Create MCP/call-story.ts: page through `/db-capture/calls/{id}/statements` (statements + supplier markers) and `/call-logs/{id}`, merge by `seq` (statement < supplier < log on ties, the 009 rule), offsets, `startAt: start | firstError | seq`, compact item lines (long SQL/messages shortened with their full length stated), `why` when lines are missing
- [ ] T052 [US4] Implement `call_story` in MCP/tools/logs.ts (paged by items within REPLY_BUDGET)
- [ ] T053 [P] [US4] Test story order against a fixture whose Together order is known (line between two statements), firstError start, 3,000-item paging, missing-lines `why`, in MCPT/story.test.ts

---

## Phase 8: User Story 5 - Logged exception to source line (P2)

- [ ] T054 [US5] Add `framesOfStack(stack: string)` (parse `at pkg.Cls.m(File.java:N)`, skip the same JDK/framework prefixes statement chains skip) and reuse `resolveFrames` in MCP/source.ts
- [ ] T055 [US5] Implement `exception_source { callId, lineId }` in MCP/tools/logs.ts (first application frame resolved, other app frames listed, skipped count, "no application frame" answer)
- [ ] T056 [P] [US5] Test with a stack through a project file in the test fixture tree and a framework-only stack in MCPT/logs-search.test.ts

---

## Phase 9: User Story 9 - The lines around an error (P2)

- [ ] T057 [US9] Implement `log_context { callId, lineId, before, after }` on MCP/call-story.ts's window (outside-call lines: same thread by time via `/db-capture/outside/logs`) in MCP/tools/logs.ts
- [ ] T058 [P] [US9] Test window bounds and mixed item kinds in MCPT/story.test.ts

---

## Phase 10: User Story 10 - Endpoint health (P2)

- [ ] T059 [US10] Add `QueryAttentionUseCase.endpoints(ResolvedScope, project, from, to, limit)` → EndpointHealth (calls, per-signal counts, median/max duration; grouping in Java over the scope's marks - columns only, no bodies) in TR/domain/model/EndpointHealth.java and TR/application/service/TriageService.java + test in TRT/application/service/TriageServiceTest.java
- [ ] T060 [US10] Expose `POST /triage/endpoints` in APP/investigationbridge/InvestigationController.java + controller test; implement `endpoint_health` in MCP/tools/investigate.ts + test in MCPT/investigate.test.ts

---

## Phase 11: User Story 6 - Compare a failing and a passing call's logs (P3)

- [ ] T061 [US6] Add a `logs` section to `diff_calls` (only in A, only in B, first divergence; aligned by LCS over fingerprints from MCP/signals.ts) in MCP/tools/diff.ts + test in MCPT/improvements.test.ts

---

## Phase 12: User Story 7 - Outside-call lines around a moment (P3)

- [ ] T062 [US7] Extend `GET /db-capture/outside/logs` with `from`, `to`, `minLevel` (clamped) in DC/adapter/in/web/DbCaptureLogsController.java, DC/application/service/DbCaptureQueryService.java, DC/adapter/out/sqlite/SqliteDbCaptureRepository.java + tests in DCT
- [ ] T063 [US7] Implement `outside_logs { project, around (ISO or callId), minutesBefore, minutesAfter, minLevel }` grouped by thread in MCP/tools/logs.ts + test in MCPT/logs-search.test.ts

---

## Phase 13: User Story 8 - Wait for the next error; change the level (P3)

- [ ] T064 [US8] Add `until: any | logError | logWarning | dbFailed | problem` to `wait_for_calls`, checking new calls' marks via `/triage/calls` and returning the first matching line/statement, in MCP/tools/watch.ts + test in MCPT/recording.test.ts
- [ ] T065 [US8] Add `set_log_capture { project, on?, level? }` (uses the existing ▤ switch endpoint and the project's capture settings `logLevel`; returns `changed: [{setting, from, to}]`), drop `confirm` from `set_db_capture` (returns `changed`), show ▤ and Log level in `list_projects`, in MCP/tools/projects.ts + tests in MCPT/foundation.test.ts
- [ ] T066 [US8] Replace the ask-first wording for switches with "change when it helps; always report old → new", and add the investigation order (problem_calls/triage → investigate_call → call_story/log_context → exception_source/locate_source) in MCP/server.ts and MCP/prompts.ts

---

## Phase 14: User Story 11 - When problems started (P3)

- [ ] T067 [US11] Add `QueryAttentionUseCase.timeline(ResolvedScope, bucketMinutes, signals)` (GROUP BY started_at bucket over `ix_attention_signals`, ≤ 1,440 buckets, first seen per signal) in TR/domain/model/SignalBucket.java, TR/application/service/TriageService.java, TR/adapter/out/sqlite/SqliteAttentionRepository.java + test
- [ ] T068 [US11] Expose `POST /triage/timeline` + controller test; implement `problem_timeline` in MCP/tools/investigate.ts + test in MCPT/investigate.test.ts

---

## Phase 15: User Story 12 - Compare two cycles (P3)

- [ ] T069 [US12] Implement `compare_cycles { before, after }` from two `log_problems` and two `problem_calls` counts (new / gone / still by fingerprint; signal counts side by side) in MCP/tools/investigate.ts + test in MCPT/investigate.test.ts

---

## Phase 16: User Story 13 - Trace a value through log lines (P3)

- [ ] T070 [US13] Make `trace_value` also search the call's lines (message + exception text, masked) and report level/logger/seq in MCP/tools/db.ts + test in MCPT/db.test.ts

---

## Phase 17: User Story 14 - Investigation report (P3)

- [ ] T071 [US14] Implement `investigate_call { callId, cycleId? }`: signals (`/triage/calls`), first error + 5 items before (call-story), exception source (T054), failing supplier calls, most similar success (same EndpointPattern-equivalent path, status < 400, nearest in time, from `/triage/problem-calls` with `none` of all error signals) in MCP/tools/investigate.ts
- [ ] T072 [P] [US14] Test the report for a call with a failed supplier call followed by a logged exception, and for a call with nothing wrong, in MCPT/investigate.test.ts

---

## Phase 18: Polish & cross-cutting

- [ ] T073 [P] Document the new tools, signals, scopes and the settings rule in docs/mcp.md; search/fingerprint/FTS and signal feed in docs/db-capture.md; the MCP line of CLAUDE.md
- [ ] T074 [P] One MCP test running the masking vectors (same as bodies) through every tool that returns log text - `call_logs`, `search_logs`, `log_problems`, `call_story`, `log_context`, `outside_logs`, `exception_source`, `investigate_call`, `diff_calls` logs, `trace_value`, `triage` evidence, `problem_calls` evidence - asserting no unmasked value appears, in MCPT/masking-logs.test.ts
- [ ] T075 [P] Tool-budget test (SC-004, SC-009): on a fixture with a 200 call that logged an exception after a failing supplier call, `triage` then `investigate_call` (2 calls) name the failing supplier call, the error line and the source file:line, in MCPT/investigate.test.ts
- [ ] T076 [P] Scale test: 20,000 marks and 1,000,000 lines - problem calls, endpoints, timeline, search, log problems each < 1 s, in DCT/adapter/out/sqlite/DbCaptureThroughputTest.java and TRT/adapter/out/sqlite/SqliteAttentionRepositoryTest.java
- [ ] T077 Run full suites once: backend `mvn test` (Docker JDK 21, incl. ArchUnit), `mcp-server` `npm test`, frontend unchanged check `npx ng build --configuration production`
- [ ] T078 Deploy (`docker compose up -d --build backend` + `docker compose restart app-gateway`) and walk quickstart.md §1-§5 against live data; mark spec checklist and tasks done

---

## Dependencies & Execution Order

- **Setup (T001-T002)**: none. T001 is an independent bug fix and can ship alone.
- **Foundational (T003-T030)**: blocks all stories. Inside: T003→T004, T003→T005→T006→T007; T008→T009 (per-call level); T010→T011→T012→T013 (signal feed, settings re-emit, imports); T014→T015→T016→T017→T018 (triage columns); T017+T011→T019→T020→T021 (bridge, imports, retention); T022 independent (EndpointPattern); T023→T024→T025, T026 after T005/T016, T027 after T023 (scopes); T028-T030 independent of the backend.
- **P1**: US0 (T031-T036) → US1 (T037-T040) can start in parallel with US0 once T017 is done; US2 (T041-T046) only needs T006/T026/T027.
- **P2**: US3 needs T005; US4 needs nothing new on the backend; US5 needs US4's call data only; US9 needs US4; US10 independent after T026 (EndpointPattern in T022).
- **P3**: US6 needs T029; US7 independent; US8 needs T031 (problem check); US11 needs T026; US12 needs US0+US3; US13 independent; US14 needs US0, US4, US5, US10.
- **Polish** last.

### Parallel examples

- Foundational: T003/T004 (db-capture domain) ∥ T014 (triage domain) ∥ T023 (bridge models) ∥ T028/T029 (MCP).
- US0: T032 (repo test) ∥ T034 (controller test) ∥ T036 (MCP test) once their targets exist.
- P2: US4 (MCP only) ∥ US3 (backend grouping) ∥ US10 (triage aggregation).

## Implementation Strategy

1. T001 first (live bug, ships alone).
2. Foundational, then **MVP = US0 + US1 + US2** (problem calls, triage with log evidence, search) - deploy and validate quickstart §1-§3.
3. P2 stories (grouping, story, source, context, endpoints) - each deployable alone.
4. P3 stories in any order respecting the dependencies above.
5. Full suites once at the end (owner's rule), deploy, quickstart walk.
