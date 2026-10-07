# Implementation Plan: Redis linked to calls

**Branch**: `011-redis-capture` | **Date**: 2026-10-07 | **Spec**: [spec.md](spec.md) | **Mock**: [mock.html](mock.html) (decoding decision: [decoding-mock.html](decoding-mock.html))
**Input**: Feature specification from `specs/011-redis-capture/spec.md`

## Summary

Record every Redis command an application sends while serving a recorded inbound call, and show it with that call
everywhere statements and log lines are shown - card chip, stats pill, the call's window (Redis view, Keys view, a
Redis lane, Together, Findings), settings, exports/import, session cycles and Claude's tools - matching `mock.html`.

The db-agent gains one send hook and one reply hook per client (Lettuce, Jedis, Redisson) at the layer every API
passes through, attributes asynchronous replies through the client's command object, and sends byte-exact RESP request
and reply bytes (chunked when large, never shortened) in its existing batches. A third per-project switch ⬢ (flag file
`proxy/redis-capture-enabled.flag`, `redis=1` in `X-Alfred-Call`) turns it on. `backend-db-capture` stores commands in
store-generic tables in `db-capture.db` under a separate 2 GB cap, decodes values structurally on demand (never by
instantiating objects), resolves "written by" and key history from a key index, and feeds the existing triage /
investigation paths. Nothing is built for Relive replay, but bytes, reply types, sequence, fingerprints, run tags and an
interceptor seam are kept for it.

## Technical Context

**Language/Version**: Java 21 (backend), Java 8 (db-agent - runs inside WildFly/JDK 8+), TypeScript/Angular 20 (frontend), TypeScript/Node (mcp-server), Python 3 (reverse-proxy addon)
**Primary Dependencies**: Spring Boot 3, ByteBuddy (agent, existing), Angular standalone + signals. **No new runtime dependency.** Test-scope only in `db-agent`: Lettuce 6.x, Jedis 5.x, Redisson 3.x (to run the agent against the real clients)
**Storage**: SQLite `db-capture.db` - new tables `store_commands`, `store_command_data`, `store_keys`, `call_store_summary`; new fields in `capture_settings.settings_json`; new flag file `redis-capture-enabled.flag`
**Testing**: JUnit5/Mockito/AssertJ + ArchUnit; agent ITs on JDK 8 and 21 against an in-test RESP server (`MiniRedis`) with the real client jars; Karma/Jasmine; mcp-server vitest; proxy pytest
**Target Platform**: Docker (backend, frontend, gateway, proxies); the db-agent inside odeysys WildFly
**Project Type**: web application (multi-module backend + Angular frontend) + Java agent + MCP server
**Performance Goals**: ≤ 0.2 ms and ≤ 5% call time added per call with 100 commands (SC-003); ⬢ effective on next call ≤ 2 s (SC-002); list of a call's commands one indexed query, no blobs
**Constraints**: agent never blocks or changes the app, never sends its own command except opt-in before-reads; values never shortened (chunked, or dropped whole and counted); exports never truncate; no polling; limits clamped (≤ 500 commands/page, ≤ 100 ids/summary request, ≤ 200 key-history rows); decode output ≤ 64 MB (zip-bomb guard)
**Scale/Scope**: calls with up to thousands of commands; values up to tens of MB; 2 GB Redis budget (≈ tens of thousands of typical calls)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* - **PASS (both checks)**

- [x] **I. Security**: ingest DTOs `@Valid` with size caps (data-model "Validation"); every list clamped; AUTH/HELLO
  credentials never stored (R8); values are call data - rendered by Angular bindings, escaped in .md/.html exports;
  binary values decoded by a parser that never instantiates classes (no deserialization gadgets, R11) with a 64 MB
  unpack limit; masking applied server-side to every read and export (R17); backend logs ids, counts and sizes only.
- [x] **II. Performance**: nothing on the proxy path changes beyond one more flag-file read (mtime-cached like the other
  two); agent work per command = copying bytes already in the client's buffer + one map entry, bounded queue with
  drop-whole-and-count (R4); no polling (existing `/ws/db-capture` gains a `store-commands` message); list endpoints return
  summaries from `store_commands` without blobs (`store_command_data` only for detail/export); indexed lookups for chips,
  writer and key history; explicit retention - 2 GB cap, oldest calls out, cycle calls kept (R10).
- [x] **III. Architecture**: owned by `backend-db-capture` (agent ingest, storage, retention, settings already there) -
  hexagonal packages (`domain.model` records, `StoreValueDecoder`/`KeyPattern` pure domain, `port.in` use cases,
  `SqliteDbCaptureRepository` adapter). **No new slice, no new cross-slice edge, no new gateway prefix**. Call metadata for
  "written by" via the existing `backend-app/dbcapturebridge`; Redis signals to triage via the existing
  `CallSignalsPublisher` → `triagebridge`; endpoint health via `investigationbridge` with a new use-case port. Frontend:
  new standalone components under `components/db-capture/`, the db window gains views (no fork); pure logic in
  `shared/utils`.
- [x] **IV. Style**: `*UseCase`/`*Port`/`*Service`, records, constructor injection, strict TS; agent follows
  `LogInstrumentation`/`LogCatcher`/`LogRecord` shape (`RedisInstrumentation`, `RedisCatcher`, `RedisCommandRecord`);
  addon follows `_ToggleState`.
- [x] **V. Clean code**: reuses `ContextPropagation`, `CallContext.nextSeq`, `WeakIdentityMap`, `CodeLocation`,
  `OriginTracker` pattern, `BatchSender` queue/caps, `ProjectFlagFile`, `DbCaptureRetention`, `RetainedCallIdsPort`,
  `db-findings.ts`, the db-window Together merge, `db-trace`, `db-export-section`/`json-export-v2`/`import-parser`,
  `CallLogCountsService` pattern. Store-generic names only where the spec requires it (FR-035) - no other store built.
- [x] **VI. Verification**: tests per layer (research R18): agent ITs per client incl. async, pipeline, MULTI,
  pub/sub, big chunked value, AUTH never stored, before-reads skipped in MULTI; decoder fixtures generated by the real
  JDK/Kryo; repository on `@TempDir`; retention; export round trip via `buildBulkExportPayload`; no-truncation guard with
  a 2 MB value; overhead IT for SC-003.
- [x] **Invariants**: exports untruncated (guard extended); interception untouched; no new route prefix (gateway
  unchanged, verified: all routes under `db-capture`); docs updated (`docs/db-capture.md` new "Redis" section,
  `docs/mcp.md`, `CLAUDE.md` non-obvious rule for ⬢, `AGENTS.md` map).

## Project Structure

### Documentation (this feature)

```text
specs/011-redis-capture/
├── spec.md, mock.html, decoding-mock.html, checklists/requirements.md
├── plan.md              # this file
├── research.md          # R1-R18
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── agent-redis-capture.md
│   ├── store-commands-api.md
│   ├── export-and-mcp.md
│   └── ui.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
proxy/log_and_route_reverse.py                 # REDIS_CAPTURE_TOGGLE_FILE, redis=1 in X-Alfred-Call
proxy/test_db_capture_headers.py               # redis=1 cases
docker-compose.yml                             # mount redis-capture-enabled.flag (reverse-proxy + backend)

db-agent/src/main/java/com/fathy/alfred/dbagent/
├── RedisInstrumentation.java                  # NEW: hooks for Lettuce, Jedis, Redisson, Spring cache, pools
├── Instrumenter.java                          # + RedisInstrumentation.add
├── advice/Redis*Advice.java                   # NEW: send / reply / origin / pool advices
├── bootstrap/Bridge.java                      # + redisSend/redisReply/cacheEnter/cacheExit/poolEnter/poolExit
├── capture/CallContext.java                   # parse redis=1
├── capture/CaptureDispatcher.java             # Redis section delegating to RedisCatcher
├── capture/RedisCatcher.java                  # NEW: pending commands, attribution, RESP framing, housekeeping, AUTH scrub
├── capture/RespFrame.java                     # NEW: RESP request/reply framing + Jedis reply re-encoding, reply type
├── capture/RedisBeforeReader.java             # NEW: opt-in TYPE/read/PTTL via the client API
├── redis/RedisInterceptor.java + CaptureOnlyRedisInterceptor.java   # NEW: Relive seam (FR-052)
├── transport/RedisCommandRecord.java, RedisChunkRecord.java          # NEW
├── transport/BatchSender.java, BatchWriter.java, StatementSink.java  # redis + chunks + droppedRedis
└── transport/AgentSettings.java               # redisBeforeImage, redisHousekeeping
db-agent/src/test/java/…/RedisCaptureIT.java (Lettuce/Jedis/Redisson), MiniRedis.java, org/springframework/cache fakes

backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture/
├── domain/model/{StoreCommand,StoreCommandSummary,DecodedValue,KeyWriter,KeyPatternRow,CallStoreSummary,IncomingStoreCommand,IncomingStoreChunk}.java  # NEW
├── domain/{StoreValueDecoder,JdkStreamReader,KryoReader,SnappyDecoder,KeyPattern,RedisCli}.java                                         # NEW (pure)
├── domain/model/{DbCaptureSettings,ProjectCaptureStatus,IngestBatch}.java                                                             # + redis fields
├── application/port/in/{GetStoreCommandsUseCase,GetStoreCommandUseCase,StoreKeysUseCase,StoreSummariesUseCase}.java                   # NEW
├── application/port/out/{DbCaptureStorePort,RedisCaptureTogglePort}.java                                                              # + store methods / NEW
├── application/service/{DbCaptureService,DbCaptureQueryService,DbCaptureRetention,DbCaptureProjectsService,CallSignalsPublisher,DbCaptureInvestigationService}.java
├── adapter/in/web/{DbCaptureController,DbCaptureProjectsController}.java + dto/{RedisCommandDto,RedisChunkDto}.java, BatchRequestDto
├── adapter/out/filestore/FileRedisCaptureToggleAdapter.java                                                                           # NEW
└── adapter/out/sqlite/SqliteDbCaptureRepository.java                                                                                  # tables + queries
backend/backend-app/src/main/java/com/fathy/alfred/backend/dbcapturebridge/CallMetadataAdapter.java   # NEW: writer call method/path/status (CallMetadataPort)
backend/backend-app/src/main/java/com/fathy/alfred/backend/{investigationbridge,triagebridge}/           # endpoint health (Claude/API only), signals
backend/backend-architecture-test/                                                                              # unchanged rules (verify)

frontend/src/
├── styles/_db-capture.scss                                    # Redis block from mock.html
└── app/
    ├── core/models/store-command.model.ts                     # NEW
    ├── core/services/db-capture-api.service.ts                # + store endpoints
    ├── core/state/{db-capture-state.service.ts,call-store-counts.service.ts(NEW),call-list-view.ts}
    ├── components/sources-bar/…                               # ⬢ switch
    ├── components/stats-bar/…, components/header/…            # ✖ Redis failures pill + filter
    ├── components/call-card/…                                 # <app-redis-chip>
    ├── components/db-capture/{redis-chip,store-command-list,store-command-detail,store-keys}.component.ts  # NEW
    ├── components/db-capture/{db-window.*,db-timeline.component.ts,db-findings.component.ts,db-capture-settings.component.ts}
    └── shared/utils/{store-command-tree,store-findings,store-export-section}.ts (NEW; redis-cli text is built by the backend endpoint, as built) + db-findings, db-trace, json-export-v2, import-parser, export-narrative

mcp-server/src/tools/redis.ts (NEW), investigate.ts, triage.ts, calls.ts (trace_value), projects.ts (health/compare)
docs/db-capture.md, docs/mcp.md, CLAUDE.md, AGENTS.md
```

**Structure Decision**: existing web-application + agent layout; everything backend-side inside `backend-db-capture`
plus the three existing `backend-app` bridges - no new module.

## Phases (for /speckit-tasks)

1. **Foundation**: ⬢ flag file end to end (backend toggle adapter + projects endpoint + proxy `redis=1` + compose mount +
   Sources-bar switch); agent `CallContext` `redis`; batch/DTO/IngestBatch shape; SQLite tables, ingest, chunk assembly;
   `call_store_summary`; retention budget; `/ws` message; Redis CSS block.
2. **US1 (P1) capture + view**: `RespFrame`, `RedisCatcher`, Lettuce hooks first (odeysys), then Jedis, then Redisson;
   AUTH scrub and housekeeping; `GET …/store-commands`, `GET /store-commands/{id}` (raw + decoded text/JSON only);
   chip + counts service; Redis view list/detail; header totals.
3. **US2 (P1) story**: Redis lane; Together merge; groups (single-read runs, MULTI, pipeline).
4. **US3 (P1) problems**: failures pill/filter; filters + search; findings engine (5 + note); slow threshold.
5. **US4 (P2) values**: `StoreValueDecoder` (gzip/zlib/Snappy, JDK stream, Kryo, Spring JSON hints); Spring Cache origin
   hooks; "written by" via `store_keys`; Keys view.
6. **US5 (P2) before + trace**: opt-in before-reads (skips), detail line; trace hits for Redis; key history ("every call
   that used this key").
7. **US6 (P2) settings**: Redis section of ▾ (masked patterns applied server-side, show values as, before-image, slow,
   housekeeping), clients/caches from heartbeat; pool wait hooks.
8. **US7 (P2) exports/cycles/Claude**: export endpoint + .md/.html section + .json v3 records + import; cycle keeping
   check; redis-cli copy/export; MCP `redis_*` tools and Redis signals in existing tools.
9. **US8 (P3) across calls**: endpoint health (`POST /triage/endpoints` + Claude's `endpoint_health` - no ALFRED screen) and compare cycles columns.
10. **Polish**: docs, overhead IT (SC-003), full suites (backend, agent 8/21, frontend, mcp, proxy), prod build, live check
    per quickstart, compare UI against mock.html (SC-008).

## Complexity Tracking

None - no constitution violations. (Store-generic table names are required by FR-035, not speculative: the spec makes the
shared model part of this feature.)
