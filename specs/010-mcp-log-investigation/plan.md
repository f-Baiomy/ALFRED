# Implementation Plan: Log lines in Claude's investigation tools

**Branch**: `010-mcp-log-investigation` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/010-mcp-log-investigation/spec.md`

## Summary

Make the agent-caught log lines (specs/009) and the database signals first-class in Alfred's MCP tools. Three backend
additions carry the cross-call work so the MCP server never pulls thousands of lines to filter them itself:

1. **Signals on triage's saved mark** - `call_attention` gains log error/warning/exception counts and the call's database
   warning flags, fed by db-capture through a new observer port (the same shape as `StatementFailuresObserverPort`). One
   indexed table then answers "problem calls", endpoint health and the per-minute timeline for any scope.
2. **Searchable, groupable log lines** - `call_log_lines` gains a `fingerprint` (logger + exception type + message with
   varying parts set aside) and an FTS5 trigram index over message/logger/exception text, kept in step by triggers so
   retention deletes stay one statement.
3. **Scopes** - a new `backend-app/investigationbridge` resolves a scope (live, one cycle, named cycles ± live, or
   everything) into call ids once, with each call counted once and labelled with where it is held, and serves the
   cross-call endpoints under the existing `/triage` and `/call-logs` prefixes (POST bodies - no id lists in URLs).

The MCP server gets new tools (`problem_calls`, `search_logs`, `log_problems`, `call_story`, `log_context`,
`exception_source`, `endpoint_health`, `problem_timeline`, `compare_cycles`, `investigate_call`, `outside_logs`,
`set_log_capture`) and extends existing ones (`triage`, `call_logs`, `diff_calls`, `trace_value`, `wait_for_calls`,
`set_db_capture`), composing per-call views (story, context, report, diff, source) from endpoints that already exist.

## Technical Context

**Language/Version**: Java 21 (backend, Spring Boot 3.3), TypeScript 5 on Node 22 (`mcp-server/`, stdio MCP)
**Primary Dependencies**: existing only - Spring JDBC + xerial sqlite-jdbc 3.46.1.3 (FTS5 with the trigram tokenizer is built in), `@modelcontextprotocol/sdk`, zod
**Storage**: `db-capture.db` (`call_log_lines` + new FTS table `call_log_text`, new column `fingerprint`), `triage.db` (`call_attention` + new columns); no new database file
**Testing**: JUnit 5/AssertJ/Mockito + `@TempDir` SQLite (backend), ArchUnit, `node --test` with the fake Alfred (`mcp-server/test/fake-alfred.ts`)
**Target Platform**: the Alfred docker stack (backend container) and the developer's machine (MCP server, stdio)
**Project Type**: web service (hexagonal Maven reactor) + MCP stdio server
**Performance Goals**: any cross-call request over 1,500 live calls + 20 cycles (≈ 30,000 calls, 2 M log lines) answers in < 1 s; problem-calls / endpoints / timeline are one indexed query over `call_attention`
**Constraints**: no id lists in URLs (gateway refuses > 8 KB request lines - found in 009, MCP's `MAX_IDS = 500` has the same bug); every response within the MCP reply budget, paged, nothing silently cut; masking identical to bodies
**Scale/Scope**: 15 user stories, 12 new MCP tools, 7 extended; 6 new backend endpoints + 1 extended; agent sends the per-call Log level on CALL_OPEN

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Security**: request bodies are records validated with `@Valid` (text ≤ 500 chars, pattern ≤ 200 chars and must compile; SQLite `REGEXP` is never used - a pattern narrows through FTS5 by its longest literal, then Java `Pattern` matches over a deadline-checking `CharSequence`: 2 s / 200,000 candidates at most, answered as `cutShort`, so a catastrophic pattern cannot hold a thread), every `limit`/`after`/window clamped server-side, scope cycle lists capped at 50. Log text reaching the agent is masked by the MCP server's existing `maskCall`/`maskText` (same vectors as bodies). The settings tools change only Alfred's own flags (owner decision: freely, reported).
- [x] **II. Performance**: nothing touches the proxy path. Cross-call reads are indexed: `call_attention` gets `ix_attention_signals(signal_rank, started_at)`; log search goes through FTS5 (`MATCH`) restricted by a scope temp table joined on `call_id`; grouping reads `ix_log_lines_fp(fingerprint, at_ms)`. No bodies are read for lists. Retention unchanged: FTS rows and fingerprints die with their lines (triggers), `call_attention` keeps its row cap.
- [x] **III. Architecture**: db-capture owns lines, fingerprint and FTS; triage owns the signal columns and the endpoint/timeline aggregation; the scope resolver and cross-slice endpoints live in a new `backend-app/investigationbridge` (composition root, like `calllogsbridge`/`triagebridge` - depends only on `*UseCase`/`*Port` interfaces, ArchUnit unchanged). The signal feed is a new db-capture out-port `CallSignalsObserverPort` implemented in `triagebridge`. No new slice-to-slice edge.
- [x] **IV. Style**: `*UseCase`/`*Port`/`Sqlite*` naming, records for DTOs, constructor injection; MCP tools follow `register(server, client)` + `run()` + `ok()` + `fitItems()` exactly as `logs.ts`/`triage.ts`.
- [x] **V. Clean code**: reuses `resolveFrames` (source.ts) for exception frames, `buildStatementTree`'s ordering rule (seq) for the story, `diff.ts`'s normaliser for log diffs, `call_log_summary` counts for signals, the 009 `/call-logs` page for per-call lines, the existing `/db-capture/outside/logs` (gains from/to/level). No second copy of masking, fingerprinting or path normalising.
- [x] **VI. Verification**: per layer - fingerprint unit tests (ids/uuids/numbers/quoted values/timestamps; distinct errors never merge), SQLite tests with realistic volumes (50 k lines) for search/grouping/retention, triage repository tests for signal columns and filters, `@WebMvcTest` for the bridge endpoints, ArchUnit, MCP tests against the fake Alfred for every tool incl. masking vectors and the "why missing" answers. The MCP `MAX_IDS` 414 bug gets a failing-first test.
- [x] **Invariants**: exports untouched; no new route prefix (endpoints under `/triage` and `/call-logs`, already in the gateway regex); docs updated (`docs/mcp.md`, `docs/db-capture.md`, `CLAUDE.md` MCP line, MCP server instructions).

## Project Structure

### Documentation (this feature)

```text
specs/010-mcp-log-investigation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── investigate-api.md   # new backend endpoints
│   └── mcp-tools.md         # new and changed MCP tools
├── checklists/requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── backend-db-capture/src/main/java/.../dbcapture/
│   ├── domain/LogFingerprint.java                  # NEW normaliser (pure)
│   ├── domain/model/{LogSearchQuery,LogSearchHit,LogProblem}.java   # NEW
│   ├── application/port/in/CallLogLinesUseCase.java          # + search, problems, problemCalls, outside window
│   ├── application/port/out/CallSignalsObserverPort.java     # NEW (log counts + DB flags per call)
│   ├── application/service/{DbCaptureService,DbCaptureQueryService}.java
│   └── adapter/out/sqlite/SqliteDbCaptureRepository.java     # fingerprint column, FTS5 table + triggers, backfill
├── db-agent/src/main/java/.../transport/MarkerRecord.java   # + logLevel on CALL_OPEN (per-call level, FR-016)
├── backend-triage/src/main/java/.../triage/
│   ├── domain/model/{CallAttention,CallSignals,ProblemFilter,EndpointHealth,SignalBucket}.java
│   ├── domain/EndpointPattern.java                 # NEW path normaliser (pure)
│   ├── application/port/in/{RecordCallAttentionUseCase,QueryAttentionUseCase}.java   # + signals, problemCalls, endpoints, timeline
│   └── adapter/out/sqlite/SqliteAttentionRepository.java     # signal columns + index
└── backend-app/src/main/java/.../
    ├── triagebridge/TriageCallSignalsAdapter.java  # NEW implements CallSignalsObserverPort
    └── investigationbridge/                         # NEW
        ├── InvestigationScope.java                  # live | cycles | all, resolve → ids + where held
        ├── ScopeResolver.java
        ├── InvestigationController.java             # POST /triage/problem-calls|endpoints|timeline, /call-logs/search|problems|problems/calls
        └── InvestigationModels.java

mcp-server/
├── src/scope.ts                    # NEW scope schema + "held in" labels
├── src/signals.ts                  # NEW signal names, severities, evidence lines
├── src/tools/investigate.ts        # NEW problem_calls, endpoint_health, problem_timeline, compare_cycles, investigate_call
├── src/tools/logs.ts               # + search_logs, log_problems, log_context, outside_logs, exception_source, call_story
├── src/tools/{triage,diff,db,watch,projects}.ts   # extended
├── src/triage.ts                   # MAX_IDS 500 → 100 (414 fix)
├── src/prompts.ts / server.ts      # instructions: logs + signals; settings changed freely and reported
└── test/{investigate,logs-search,story}.test.ts + fake-alfred.ts
```

**Structure Decision**: existing hexagonal reactor + `mcp-server`. Cross-call reads are backend endpoints (indexed SQL
over data already stored); per-call compositions (story, context, report, diff, exception source) are MCP-side, built
from existing per-call endpoints, like `get_cycle`'s story.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| FTS5 virtual table + triggers in `db-capture.db` | substring search over ~2 M lines in < 1 s | `LIKE '%x%'` scans every line of the scope (measured class: seconds at 2 M rows); a Java-side scan pulls bodies into memory |
| POST for read endpoints | scopes and id sets exceed the 8 KB URL limit | GET with ids in the query string is exactly the 414 bug found in 009 |
