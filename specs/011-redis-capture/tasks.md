---
description: "Tasks for 011-redis-capture - Redis linked to calls"
---

# Tasks: Redis linked to calls

**Input**: `specs/011-redis-capture/` - plan.md, spec.md, research.md (R1-R18), data-model.md, contracts/, quickstart.md, mock.html
**Tests**: included - the constitution (VI. Verified Changes) requires tests per layer.
**UI**: every UI task must match `specs/011-redis-capture/mock.html` (classes, wording, order, colours - SC-008).

## Path aliases (used in every task)

- `{agent}` = `db-agent/src/main/java/com/fathy/alfred/dbagent`
- `{agent-test}` = `db-agent/src/test/java/com/fathy/alfred/dbagent`
- `{dbc}` = `backend/backend-db-capture/src/main/java/com/fathy/alfred/backend/dbcapture`
- `{dbc-test}` = `backend/backend-db-capture/src/test/java/com/fathy/alfred/backend/dbcapture`
- `{app}` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `{fe}` = `frontend/src/app`

Rules for every task: no whole-file reads of `frontend/src/styles.scss`, `SqliteDbCaptureRepository.java`,
`CaptureDispatcher.java` or `proxy/interception.py` - use `codegraph explore` / Grep for the part you change. Backend
needs JDK 21 (Docker Maven command in CLAUDE.md); agent ITs run on JDK 8 and 21.

## Format: `- [ ] [ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Add test-scope dependencies Lettuce 6.x, Jedis 5.x, Redisson 3.x (pinned versions, JDK 8 compatible) to `db-agent/pom.xml`; confirm the shaded agent jar does not include them (`mvn -pl db-agent package` + jar listing)
- [X] T002 [P] Create the in-test RESP server `{agent-test}/redis/MiniRedis.java`: socket server on a free port, RESP2 + `HELLO 3` (RESP3 maps/sets), commands GET SET(EX/PX/NX) DEL MGET MSET INCR EXPIRE PTTL TTL TYPE HGETALL HSET LRANGE RPUSH SMEMBERS SADD ZRANGE ZADD PUBLISH MULTI EXEC EVAL EVALSHA (NOSCRIPT) AUTH PING CLIENT SELECT KEYS, plus a hook to delay replies
- [X] T003 [P] Add the Redis style block from `specs/011-redis-capture/mock.html` ("NEW - Redis" section: `--redis` tokens for dark and light themes, `.redis-chip`, `.redis-sw`, `.redis-glyph`, `.v-rr/.v-rw/.v-rx`, `.k-redis*`, `.rd-*`, `.orig.spc`, `.rd-keys`, `.rd-pop`) to `frontend/src/styles/_db-capture.scss`

---

## Phase 2: Foundational (blocks every story)

### ⬢ switch end to end

- [X] T004 [P] Add `REDIS_CAPTURE_TOGGLE_FILE` (`/home/mitmproxy/redis-capture-enabled.flag`, default off) as a third `_ToggleState`, and `redis_on` → `; redis=1` in `alfred_call_header()` (only while inbound logging is on) in `proxy/log_and_route_reverse.py`
- [X] T005 [P] Extend `proxy/test_db_capture_headers.py`: `redis=1` present only with the project on, absent when off/missing line, client-sent header still stripped
- [X] T006 [P] Mount `redis-capture-enabled.flag` into reverse-proxy (`REDIS_CAPTURE_TOGGLE_FILE=/home/mitmproxy/…`) and backend (`/appdata/…`) next to `log-link-enabled.flag` in `docker-compose.yml`; create the empty file in `start.py`/`restart.py` where the other flag files are created
- [X] T007 [P] Create port `{dbc}/application/port/out/RedisCaptureTogglePort.java` and adapter `{dbc}/adapter/out/filestore/FileRedisCaptureToggleAdapter.java` (reuse `ProjectFlagFile`, mirror `FileLogLinkToggleAdapter`, property `REDIS_CAPTURE_TOGGLE_FILE`)
- [X] T008 Add `redisOn` (+ `redisClients`, `springCaches`, empty until US6) to `{dbc}/domain/model/ProjectCaptureStatus.java`; set/read it in `{dbc}/application/service/DbCaptureProjectsService.java` (409 `InboundLoggingOffException` when inbound logging is off); add `PUT /db-capture/projects/{project}/redis` to `{dbc}/adapter/in/web/DbCaptureProjectsController.java`; publish the existing `projects` WebSocket message
- [X] T009 [P] Tests: `{dbc-test}/adapter/out/filestore/FileRedisCaptureToggleAdapterTest.java` (`@TempDir`), service test for redis toggle + 409, `@WebMvcTest` for the new PUT in `{dbc-test}/adapter/in/web/DbCaptureProjectsControllerTest.java`
- [X] T010 [P] Add `redisOn` to the project status model and `setRedis(project, on)` to `{fe}/core/services/db-capture-api.service.ts` and `{fe}/core/state/db-capture-state.service.ts`
- [X] T011 Add the ⬢ switch after ▤ in `{fe}/components/sources-bar/` (template + component): classes `source-pill-switch redis-sw [on]`, glyph `<span class="redis-glyph">⬢</span>`, tooltips as in mock section 1, blocked with reason when inbound logging is off or no agent (same rule as ◆); also in the Session cycles sources bar (shared component)

### Agent plumbing

- [X] T012 Parse `redis=1` in `{agent}/capture/CallContext.java` (`public final boolean redis`; a context exists when db, log or redis is 1); add `redis` to the CALL_OPEN `{agent}/transport/MarkerRecord.java` and its JSON in `BatchWriter` (and `MarkerDto`/`CallMarker` in `{dbc}`); unit tests in `{agent-test}/capture/CallContextTest.java` and `BatchWriterTest`
- [X] T013 [P] Create `{agent}/transport/RedisCommandRecord.java` and `{agent}/transport/RedisChunkRecord.java` per data-model.md (fields, `approxBytes()`); the display copies are cut in the record itself (command name ≤ 64 chars, ≤ 64 keys × 1,024 chars, `keysTotal`) so a record can never fail backend validation
- [X] T014 Add `redis(RedisCommandRecord)`, `redisChunk(RedisChunkRecord)` and `droppedRedis(callId, n)` defaults to `{agent}/transport/StatementSink.java`; queue them in `{agent}/transport/BatchSender.java` under the existing caps with whole-command drop (a command's chunks + record are offered atomically: if any fails, release what was queued and count one drop), batch limits 2,000 commands / 100 chunks / ≤ 32 MB body; serialise `redis`, `redisChunks`, `droppedRedis` in `{agent}/transport/BatchWriter.java`
- [X] T015 [P] Tests: `{agent-test}/transport/BatchWriterTest.java` (redis JSON shape per contracts/agent-redis-capture.md), `{agent-test}/transport/BatchSenderTest.java` (chunked command dropped whole when the byte cap is hit, drop counted, batch ≤ 32 MB)

### Backend storage and ingest

- [X] T016 [P] Create domain records `{dbc}/domain/model/IncomingStoreCommand.java`, `IncomingStoreChunk.java`, `StoreCommandSummary.java`, `StoreCommand.java`, `DecodedValue.java`, `KeyWriter.java`, `KeyPatternRow.java`, `CallStoreSummary.java` per data-model.md (records, no Spring)
- [X] T017 [P] Create `{dbc}/adapter/in/web/dto/RedisCommandDto.java` and `RedisChunkDto.java` with Bean Validation limits from data-model.md - a single command that still fails a check MUST NOT reject the batch: validate commands individually in the service, store a failing one with `error = "invalid record: …"` + its raw bytes, log a WARN with call id and sizes, store the rest; test that one bad command leaves the batch's statements, logs and other commands stored; add `redis`, `redisChunks`, `droppedRedis` to `{dbc}/adapter/in/web/dto/BatchRequestDto.java` and `{dbc}/domain/model/IngestBatch.java`
- [X] T018 Create tables and indexes `store_commands`, `store_command_data`, `store_keys`, `call_store_summary` (data-model.md) in the schema init of `{dbc}/adapter/out/sqlite/SqliteDbCaptureRepository.java`
- [X] T019 Add store methods to `{dbc}/application/port/out/DbCaptureStorePort.java` and implement in `SqliteDbCaptureRepository`: `saveStoreCommands(project, commands)`, `saveStoreChunks(chunks)` (row `complete=0` until all parts + record present), `storeCommands(callId, offset, limit)` (summaries only, no blobs, `complete=1`), `storeCommand(id)` (assembles parts in order), `storeSummaries(callIds)`, `storeBytes()`, `oldestStoreCallIds(n, keep)`, `deleteStoreForCalls(ids)` (commands + data + keys + summary together), `purgeIncompleteStore(olderThan)`; call `deleteStoreForCalls` from the existing call delete path (`DeleteCallStatementsUseCase` / `DELETE /db-capture/calls/{callId}` and re-import of a call) so a deleted call loses its commands (FR-036)
- [X] T020 Derive at ingest in `{dbc}/application/service/DbCaptureService.java`: `rw`, `outcome` (HIT/MISS/OK/FAILED from command + reply type), `bytes`, `reply_preview` (≤ 200 chars text or `‹binary n B›`), `store_keys` rows (op, `value_hash` SHA-256, `ttl_ms` from EX/PX/EXPIRE args), `call_store_summary` upsert incl. `dropped`; create the summary row (`commands=0`, `live=1`) from a CALL_OPEN marker with `redis`, set `live=0` at CALL_CLOSE and `ended_early=1` under the existing ended-early rule; parse RESP for these in a pure helper `{dbc}/domain/Resp.java`
- [X] T021 Add the Redis budget to `{dbc}/application/service/DbCaptureRetention.java`: `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES` (default 2147483648) - evict oldest calls' commands whole, keep `RetainedCallIdsPort` ids, purge incomplete commands older than 10 min; document the variable in `settings.properties` and `.env` docs where `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` is documented
- [X] T022 Publish `{"type":"store-commands","callIds":[…]}` after a batch with commands via `{dbc}/application/port/out/DbCaptureNotificationPort.java` / `{dbc}/adapter/out/websocket/WebSocketDbCaptureNotificationAdapter.java`
- [X] T023 [P] Tests: `{dbc-test}/adapter/out/sqlite/SqliteStoreCommandsTest.java` (`@TempDir`: save, chunk assembly, incomplete hidden, summaries, delete together, `run_tag` stored (FR-053), deleting a call removes its commands, a zero-command summary from CALL_OPEN, `live`/`ended_early` transitions), `{dbc-test}/domain/RespTest.java` (reads `specs/011-redis-capture/fixtures/resp-cases.json`, created with T030), retention test in `{dbc-test}/application/service/DbCaptureRetentionTest.java` (small cap: oldest calls whole, retained kept), ingest controller test for the new batch fields and validation limits
- [X] T024 [P] Create `{fe}/core/models/store-command.model.ts` (summary, detail, decoded value, key row, writer, call summary types) and store endpoints in `{fe}/core/services/db-capture-api.service.ts` (`storeCommands`, `storeCommand`, `storeKeys`, `keyHistory`, `redisCli`)

**Checkpoint**: ⬢ toggles live; a batch with Redis records is stored and listed by the API.

---

## Phase 3: User Story 1 - See a call's Redis commands (P1) 🎯 MVP

**Goal**: commands recorded for Lettuce, Jedis and Redisson and shown on the card chip and in the Redis view.
**Independent test**: ⬢ on, one request that reads/writes Redis → chip counts match, the Redis view lists each command with its full reply (quickstart steps 1-4).

### Tests for US1

- [X] T025 [P] [US1] `{agent-test}/RedisCaptureLettuceIT.java`: sync, async (reply on Netty thread attributed to the call), reactive, pipelined (auto-flush off), MULTI/EXEC, PUBLISH, a 1.8 MB value (chunked, bytes identical), error reply, no context → nothing recorded, `redis=0` → nothing, seq shared with a JDBC statement in the same call, a command sent from a worker thread the call started (`ExecutorService.submit` → `wrapRunnable`) attributed to the call (FR-005), `BLPOP` with a 300 ms delayed reply recorded with its full wait, RESP3 (`HELLO 3`) map/set/double reply types stored exactly, `run=` tag from the header on every record (FR-053), `write(Collection)` and auto-flush-off writes marked as one `pipeline` group
- [X] T026 [P] [US1] `{agent-test}/RedisCaptureJedisIT.java`: plain, `Pipeline`, `Transaction`, pooled connection, RESP re-encoding equals server bytes (compare with MiniRedis capture), error reply, connection lost → `NONE` + error, worker-thread command attributed, `BLPOP` full wait, a command with 100 keys (MSET) stored with `keysTotal=100` and full `args`
- [X] T027 [P] [US1] `{agent-test}/RedisCaptureRedissonIT.java`: `RBucket`/`RMap` ops, async, batch, error
- [X] T028 [P] [US1] `{agent-test}/RedisCredentialsIT.java`: AUTH and HELLO AUTH never stored (args scrubbed) whatever `redisHousekeeping`; housekeeping (PING/CLIENT/SELECT at connect) skipped by default

### Implementation for US1

- [X] T029 [US1] Add to `{agent}/bootstrap/Bridge.java` `Dispatcher`: `redisSend(String client, Object command, Object connection, Object argsOrBuffer)`, `redisReplyEnter(String client, Object command, Object buffer)` → token, `redisReplyExit(Object token, Object result, Throwable thrown)`, `redisConnectionInfo(Object connection, String server, int db)` (JDK types only)
- [X] T030 [P] [US1] Create `{agent}/capture/RespFrame.java`: RESP request framing from argument byte arrays, top-level reply type detection (RESP2/3), Jedis reply re-encoding (byte[], Long, List, `JedisDataException`, null), key extraction per command (first key / MSET pairs / EVAL numkeys / DEL n keys), fingerprint (`command + key pattern (digits/hex→*) + arg shape`); unit test `{agent-test}/capture/RespFrameTest.java` reading the shared fixture `specs/011-redis-capture/fixtures/resp-cases.json` (RESP bytes → expected type/keys), which the backend `RespTest` (T023) reads too, so the two parsers stay in step
- [X] T031 [US1] Create `{agent}/capture/RedisCatcher.java`: `PendingCommand` (context, seq, start nanos, thread, code via `CodeLocation`, args bytes), `WeakIdentityMap` by command object (Lettuce/Redisson) and FIFO per connection (Jedis), completion → `RedisCommandRecord` (+ chunks > 256 KB) to the sink, housekeeping filter, AUTH/HELLO scrub to `‹credentials not stored›`, connection ids `conn-r-xxxx`, late grace = existing 5 s; all under the dispatcher's agent-work guard; never throws
- [X] T032 [US1] Create `{agent}/redis/RedisInterceptor.java` and `{agent}/redis/CaptureOnlyRedisInterceptor.java` (Relive seam, FR-052: `onSend`/`onReply`, shipped impl records only) and route `RedisCatcher` through it
- [X] T033 [US1] Wire the Redis section in `{agent}/capture/CaptureDispatcher.java` (delegate the new `Bridge.Dispatcher` methods to `RedisCatcher`, only when `context.redis`) and add Redis client / Spring Data / Netty / reactor packages to `CodeLocation`'s skip list in `{agent}/capture/CodeLocation.java`
- [X] T034 [US1] Create `{agent}/RedisInstrumentation.java` + advices `{agent}/advice/LettuceWriteAdvice.java` (`io.lettuce.core.protocol.DefaultEndpoint.write(RedisCommand|Collection)`), `{agent}/advice/LettuceDecodeAdvice.java` (`RedisStateMachine.decode(ByteBuf, RedisCommand, CommandOutput)`: reader index before/after, accumulate until true); register in `{agent}/Instrumenter.java`; make T025 pass
- [X] T035 [US1] Add Jedis hooks in `RedisInstrumentation`: `{agent}/advice/JedisSendAdvice.java` (`redis.clients.jedis.Connection.sendCommand(ProtocolCommand, byte[][])` and `sendCommand(CommandArguments)`), `{agent}/advice/JedisReadAdvice.java` (`redis.clients.jedis.Protocol.read(RedisInputStream)` exit); make T026 pass
- [X] T036 [US1] Add Redisson hooks: `{agent}/advice/RedissonExecuteAdvice.java` (`org.redisson.command.RedisExecutor.execute()` - context capture), `{agent}/advice/RedissonEncodeAdvice.java` (`CommandEncoder.encode`), `{agent}/advice/RedissonDecodeAdvice.java` (`CommandDecoder.decode` reader-index slice); make T027 pass
- [X] T037 [US1] Use cases `{dbc}/application/port/in/GetStoreCommandsUseCase.java`, `GetStoreCommandUseCase.java` implemented in `{dbc}/application/service/DbCaptureQueryService.java`; endpoints `GET /db-capture/calls/{callId}/store-commands` (limit clamped 1..500) and `GET /db-capture/store-commands/{id}?raw=` in `{dbc}/adapter/in/web/DbCaptureController.java` (decoded = text/JSON only in US1; binary formats land in US4); `redis` block on `GET /db-capture/summaries`
- [X] T038 [P] [US1] Tests: `{dbc-test}/application/service/DbCaptureQueryServiceStoreTest.java` (fake port), controller tests for both endpoints incl. clamping and 404
- [X] T039 [P] [US1] Create `{fe}/core/state/call-store-counts.service.ts` (on-screen batched counts ≤ 100 ids, refresh on `store-commands` socket message, mirror `call-log-counts.service.ts`)
- [X] T040 [US1] Create `{fe}/components/db-capture/redis-chip.component.ts` (`db-chip redis-chip [failed] [live]`, text states per contracts/ui.md, muted `⬢ Redis 0`, none when ⬢ off; click → window on `redis` view) and place `<app-redis-chip>` after `<app-log-chip>` in the call card template (`{fe}/components/call-card/`)
- [X] T041 [US1] Create `{fe}/components/db-capture/store-command-list.component.ts` (rows `.r.rd-row` with `.rh`: chev, num, verb class `v-rr|v-rw|v-rx`, `.rkey` + `.arg`, `.res.rres.r-hit|r-miss|r-err|r-plain`, ms (`mid` when slow), off) and `{fe}/components/db-capture/store-command-detail.component.ts` (`.rd-detail` kv rows: command, reply, value size, ttl, sent/reply, client, thread, code; full value `<pre>`; foot "Copy as redis-cli")
- [X] T042 [US1] Add the `Redis n` tab (`views button.rd`) and Redis view to `{fe}/components/db-capture/db-window.component.ts/.html` (open on `redis` from the chip; header `· 22 Redis · 25.4 ms`; summary `Redis 25 ms`; footer "Showing n of m Redis commands"); window refetch on `store-commands` message; spec `{fe}/components/db-capture/db-window.component.spec.ts` updated for the new view

**Checkpoint**: MVP - commands visible per call for all three clients.

---

## Phase 4: User Story 2 - Redis in the call's story (P1)

**Goal**: Together, the Redis lane, header totals, groups.
**Independent test**: a call with statements, a supplier call, log lines and commands → Together interleaves by seq; lane present; `GET ×9` and `MULTI ×2` groups.

- [X] T043 [P] [US2] Create `{fe}/shared/utils/store-command-tree.ts` (≥ 3 consecutive single reads of one pattern from one code line → group `GET ×n` with hit/miss counts and the warning text; `group.kind=tx` → `MULTI ×n · 1 round trip · EXEC <result>`; `pipeline` → `PIPELINE ×n`) + `{fe}/shared/utils/store-command-tree.spec.ts`
- [X] T044 [US2] Render groups in `store-command-list.component.ts` (`.g.query` rows opening to their commands, `.g-warn` for the batching warning)
- [X] T045 [US2] Merge Redis items and groups into Together by `seq` in `{fe}/components/db-capture/db-window.component.ts`; Together count and footer include Redis ("7 statements · 1 supplier call · 2 log lines · 22 Redis commands")
- [X] T046 [US2] Add the `Redis` lane to `{fe}/components/db-capture/db-timeline.component.ts` (strip + detailed: `k-redis`, `k-redis-miss` outline, failed red; hover card number/command/key/reply/time; click selects in the list) and the legend text "Redis: n connections (client) · pool wait · n commands in m round trips" in `db-window.component.html`
- [X] T047 [P] [US2] Tests: timeline lane items (`db-timeline` spec), Together merge order with all four kinds (`db-window` spec)

---

## Phase 5: User Story 3 - Find the problem fast (P1)

**Goal**: failures pill/filter, view filters and search, findings, slow threshold.
**Independent test**: failed EVALSHA + 9 single GETs → `✖ Redis failures` counts the call; Findings lists both with fixes.

- [X] T048 [US3] Add `redisFailedCallIds` to `GET /db-capture/failures` in `{dbc}/application/service/DbCaptureQueryService.java` (index `ix_store_summary_failed`) and its controller test
- [X] T049 [US3] Add `redisFailures` to `{fe}/core/state/call-list-view.ts` stats + filter, the `✖ Redis failures` pill (`stat-pill db-failed`, tooltip from mock) in `{fe}/components/stats-bar/stats-bar.component.html`, and the filter option in `{fe}/components/header/header.component.html`; spec in `call-list-view` tests
- [X] T050 [US3] Filters All/Reads/Writes/Misses/Failed (`.seg`, visible on the Redis view) and search over command, key, args, value preview and Spring Cache name (placeholder "Search SQL, key, value or log - e.g. fare:rule, 948") in `db-window.component.ts` + `store-command-list.component.ts`
- [X] T051 [P] [US3] Create `{fe}/shared/utils/store-findings.ts`: failed command (+ nearest following ERROR log line), single reads ≥ 3 of one pattern/line, miss → statement → write of the same key, big value (≥ 1 MB written / ≥ 512 KB read), cache cold (from backend `cold` seqs), KEYS/FLUSHDB/FLUSHALL/SCAN > 1,000 note; texts as mock section 4; `{fe}/shared/utils/store-findings.spec.ts`
- [X] T052 [US3] Merge Redis findings into `{fe}/shared/utils/db-findings.ts` and render chips that jump to commands in `{fe}/components/db-capture/db-findings.component.ts`; rail counts include them
- [X] T053 [US3] Slow threshold (`redisSlowMillis`, default 10) → `ms mid` highlight and "slow - over n ms" tag; read from project settings in `db-window.component.ts`

---

## Phase 6: User Story 4 - Understand the values (P2)

**Goal**: structural decoding, Spring Cache origin, "Written by", Keys view.
**Independent test**: a JDK-serialized hit written by an earlier recorded call → decoded object, format, cache + method, writer with link.

- [X] T054 [P] [US4] Create `{dbc}/domain/SnappyDecoder.java` (raw + framed) and gzip/zlib unpack with a 64 MB output limit in `{dbc}/domain/StoreValueDecoder.java`; tests with real compressed fixtures
- [X] T055 [P] [US4] Create `{dbc}/domain/JdkStreamReader.java` - JDK serialization stream parser (TC_OBJECT/CLASSDESC/STRING/ARRAY/ENUM/REFERENCE/BLOCKDATA, field types, common JDK classes and java.time `Ser`), never `ObjectInputStream`, unreadable custom data shown as bytes; `{dbc-test}/domain/JdkStreamReaderTest.java` with fixtures serialized at test time (nested objects, lists, maps, BigDecimal, LocalDate, back-references, a custom `writeObject`)
- [X] T056 [P] [US4] Create `{dbc}/domain/KryoReader.java` (registered → `class #n` + values in order, unregistered → names) + tests with Kryo-written fixtures (test-scope Kryo dependency in `backend/backend-db-capture/pom.xml`)
- [X] T057 [US4] Complete `{dbc}/domain/StoreValueDecoder.java`: detect format (gzip/zlib/Snappy → inner; `AC ED` → JDK; Kryo heuristics; JSON incl. Spring `@class` hints; UTF-8 text; else raw) → `DecodedValue{format, className, text, partial}`; used by `GetStoreCommandUseCase` and export; never at ingest; `{dbc-test}/domain/StoreValueDecoderTest.java` incl. a zip bomb (stays raw, message) 
- [X] T058 [US4] Agent Spring Cache origin: hooks `CacheAspectSupport.execute(…)` and `RedisCache.{lookup,put,putIfAbsent,evict,clear,get}` in `{agent}/RedisInstrumentation.java` + `{agent}/advice/SpringCacheAdvice.java`, per-thread origin stack in `RedisCatcher` (pattern of `OriginTracker`), `origin` on the record; fake classes `db-agent/src/test/java/org/springframework/cache/interceptor/CacheAspectSupport.java` and `org/springframework/data/redis/cache/RedisCache.java`; `{agent-test}/RedisSpringCacheIT.java`
- [X] T059 [US4] "Written by": `latestWrite(project, key, beforeAtMs)` in `DbCaptureStorePort`/`SqliteDbCaptureRepository` (index `ix_keys_key_at`); create out port `{dbc}/application/port/out/CallMetadataPort.java` (`metadata(Set<String> callIds) → Map<id, {method, path, status}>`) and its adapter `{app}/dbcapturebridge/CallMetadataAdapter.java` reading the calls and internal-calls slices through their use-case ports (like `InboundProjectsAdapter`; `HexagonalArchitectureTest` must still pass - no slice→slice edge), `sameValue` by hash, `none` reason; `cold` seqs for the call (miss on a key whose last recorded write's TTL elapsed) in `storeCommands` response; tests
- [X] T060 [US4] Keys: `{dbc}/domain/KeyPattern.java` (digits/hex/uuid/call-id segments + ≥ 3 siblings in the call → `*`) with tests; `StoreKeysUseCase` + `GET /db-capture/calls/{callId}/store-keys` (pattern rows with last writer)
- [X] T061 [US4] Detail additions in `store-command-detail.component.ts`: Spring Cache row, value format row, `.rd-src` "Written by" box (link to the call, "same value as written ✓"), `.rd-fmt` Decoded / Raw bytes switch (raw fetched with `raw=true`); row tag `.orig.spc` CACHE/PUT in `store-command-list.component.ts`
- [X] T062 [US4] Create `{fe}/components/db-capture/store-keys.component.ts` (`.rd-bar` hits/misses/hit rate, `table.rd-keys` columns incl. "Last written by") and the `Keys n` tab (`views button.rd`) in `db-window`

---

## Phase 7: User Story 5 - What a write replaced; follow a value (P2)

**Goal**: opt-in before-reads; value tracing; key history.
**Independent test**: option on → INCR shows the old value; click `a5b4f2f0` → all other places in the call.

- [X] T063 [US5] Create `{agent}/capture/RedisBeforeReader.java`: for write commands (list in research R7) when `redisBeforeImage` is on - `TYPE`, type read, `PTTL` through the same client's public API under the agent-work guard; skip with a reason inside MULTI, pipelines, subscriber or blocking connections; result as `before`/`beforeType`/`beforeNote`; `redisBeforeImage` in `{agent}/transport/AgentSettings.java` and the settings response
- [X] T064 [P] [US5] `{agent-test}/RedisBeforeImageIT.java`: before value recorded for SET/INCR/HSET/DEL; nothing extra sent when off (MiniRedis command log); skipped in MULTI and pipeline with the reason; app results unchanged
- [X] T065 [US5] Backend: store/serve `before` (decoded) in `GetStoreCommandUseCase`; detail row "before the write" in `store-command-detail.component.ts`
- [X] T066 [US5] Trace: Redis hits (`kind: redis`, key / arg n / reply path / before) in the existing call trace in `{dbc}/application/service/DbCaptureQueryService.java` and `{fe}/shared/utils/db-trace.ts`; `.rd-trace` chips + results list in `store-command-detail.component.ts`; a masked key's value is never searched or shown in trace results (the hit says where, not the value); tests for both
- [X] T067 [US5] Key history: `GET /db-capture/store-keys/history` (limit ≤ 200) in `DbCaptureController` + `StoreKeysUseCase`; "Every call that used this key ↗" opens a list (calls with op, time, status) from the detail; tests

---

## Phase 8: User Story 6 - Control capture per project (P2)

**Goal**: settings section, masking, detected clients and caches, pool wait.
**Independent test**: add `session:*` → window shows `‹masked · n B›`, stored bytes unchanged.

- [X] T068 [US6] Add `redisMaskPatterns` ([]), `redisShowValues` (DECODED), `redisBeforeImage` (false), `redisSlowMillis` (10, 1..60000), `redisHousekeeping` (false) to `{dbc}/domain/model/DbCaptureSettings.java` with defaults for old JSON; validation in the settings DTO; pass agent-relevant ones in `GET /db-capture/agent/settings`
- [X] T069 [US6] Apply masking server-side to every Redis value returned (list preview, detail, export, MCP-facing investigate) in `DbCaptureQueryService` via a pure `{dbc}/domain/KeyMask.java` (glob patterns); tests incl. stored data unchanged
- [X] T070 [US6] Agent heartbeat reports Redis clients (client, version, connections, servers, dbs) and Spring Cache names; stored with the agent status and exposed as `redisClients`/`springCaches` in `ProjectCaptureStatus`
- [X] T071 [US6] Pool wait hooks (`JedisPool.getResource`, commons-pool2 `GenericObjectPool.borrowObject` for Redis connections) in `RedisInstrumentation` → `poolWaitMicros` on the next command of the thread; shown in detail "pool wait"; IT case in `RedisCaptureJedisIT`
- [X] T072 [US6] Redis section in `{fe}/components/db-capture/db-capture-settings.component.ts` (`.rd-pop` rows in mock order: Capture, Clients found, Stored (fixed text), Mask on screen of keys (empty default), Show values as, Spring Cache names, Value before a write, Slow command, Also record housekeeping); component spec updated

---

## Phase 9: User Story 7 - Exports, cycles, Claude (P2)

**Goal**: Redis travels with the call everywhere.
**Independent test**: export .json → re-import → identical commands; Claude lists Redis failures.

- [X] T073 [US7] Add `commands[]` (all fields + base64 bytes unless masked + decoded text) to `GET /db-capture/calls/{callId}/export` and accept them in `POST /db-capture/import` (`{dbc}/domain/model/CallDbCaptureExport.java`, `DbCaptureController`, service); tests
- [X] T074 [P] [US7] Create `{fe}/shared/utils/store-export-section.ts` (.md + .html Redis section per contracts/export-and-mcp.md, escaped, untruncated) + spec with a 2 MB value guard; one Redis sentence in `{fe}/shared/utils/export-narrative.ts`
- [X] T075 [US7] `redis` records in `{fe}/shared/utils/json-export-v2.ts` (index offsets) and reading them in `{fe}/shared/utils/import-parser.ts`; round-trip test in `json-export-v2.spec.ts` built with `buildBulkExportPayload`; v1/v2 imports unchanged
- [X] T076 [P] [US7] Create `{fe}/shared/utils/redis-cli.ts` (quoting, `\xNN` for binary, masked → `‹masked›`) + spec; wire "Copy as redis-cli" and "Export .redis" in the window footer and detail
- [X] T077 [US7] Verify session-cycle and imported calls keep commands (retained ids) - test in `DbCaptureRetentionTest` with a cycle-held call over the cap
- [X] T078 [US7] Redis signals: `redis-failed` (problem) and `cache-cold` (warning) through `{dbc}/application/service/CallSignalsPublisher.java` → triage (`{app}/triagebridge`); `redis` block in `GET /db-capture/investigate/{callId}` (`DbCaptureInvestigationService`); tests
- [X] T079 [P] [US7] MCP: `mcp-server/src/tools/redis.ts` (`redis_commands`, `redis_overview`, `redis_key_history`, limits ≤ 200, masking kept) registered with the server; Redis in `investigate.ts`, `triage.ts` (`problem_calls`), `trace_value`; vitest specs; server instructions mention Redis

---

## Phase 10: User Story 8 - Redis across calls (P3)

**Goal**: endpoint health and cycle comparison columns.
**Independent test**: endpoint health shows Redis/call, hit rate, miss→DB, failed; comparing two cycles shows the change.

- [X] T080 [US8] `StoreSummariesUseCase` in `{dbc}/application/port/in/` (aggregates from `call_store_summary` for a set of call ids) and use it in `{app}/investigationbridge` endpoint health (`POST /triage/endpoints`, `InvestigationService`) and the data compare-cycles reads (per endpoint `redisPerCall`, `hitRate`, `missToDbPerCall`, `failedCalls`; per cycle pair change by command and key pattern); tests
- [X] T081 [US8] Redis columns in Claude's output only - MCP `endpoint_health` and `compare_cycles` in `mcp-server/src/tools/investigate.ts` (no ALFRED screen; mock section 7's table is this output) + vitest specs

---

## Phase 11: Polish & cross-cutting

- [X] T082 [P] Overhead: Redis case in `{agent-test}/OverheadMeasurementIT.java` (100 commands per call, ⬢ on vs off) - record ≤ 0.2 ms/command, ≤ 5 % (SC-003) in `docs/db-capture.md`
- [X] T083 [P] Docs: `docs/db-capture.md` "Redis" section (switch, hooks per client, chunking/drop rule, storage tables, 2 GB cap, decoding, before-reads, Relive seam), `docs/mcp.md` Redis tools, `CLAUDE.md` non-obvious rule for ⬢ / `redis=1` / store tables, `AGENTS.md` map
- [X] T084 Run full suites: backend `mvn test` (Docker JDK 21, incl. ArchUnit - no rule changes expected), agent ITs on JDK 8 and 21, `cd frontend && npm test && npm run build`, mcp-server tests, proxy pytest
- [ ] T085 Live check per `specs/011-redis-capture/quickstart.md` on odeysys (steps 1-10) incl. timing ⬢ on → next call recorded (≤ 2 s, SC-002), and compare every screen against `mock.html` (SC-008, with its two noted exceptions); screenshots in `specs/011-redis-capture/screenshots/`

---

## Dependencies & execution order

- **Setup (T001-T003)** → **Foundational (T004-T024)** → stories.
- **US1 (T025-T042)** is the MVP and blocks US2-US8 (they render or enrich its list/detail).
- After US1: **US2, US3, US4, US6** can proceed in parallel (different files, except `db-window.component.ts` - coordinate edits); **US5** needs US4's detail work (T061) for its rows; **US7** needs US4's decoder (T057) for decoded export text; **US8** needs US7's signals only for Claude parts (T081 MCP) - its backend part (T080) needs only Foundational.
- **Polish** last.

Within stories: tests marked [P] first (they fail), then agent → backend → frontend.

## Parallel examples

- Foundational: T004/T005/T006 (proxy + compose) ‖ T007/T009 (backend toggle) ‖ T013/T015 (agent transport) ‖ T016/T017 (backend records/DTOs) ‖ T024 (frontend model).
- US1: T025 ‖ T026 ‖ T027 ‖ T028 (ITs) and T030 (RespFrame) ‖ T039 (counts service); then T034 → T035 → T036 sequential (shared `RedisInstrumentation.java`).
- US4: T054 ‖ T055 ‖ T056 (decoders) then T057.
- US7: T074 ‖ T076 ‖ T079.

## Implementation strategy

1. **MVP** = Setup + Foundational + US1 with **Lettuce only** (T034) - odeysys works end to end; then T035 (Jedis) and T036 (Redisson).
2. Add US2 + US3 (both P1) - the full P1 experience matches mock sections 1-4.
3. US4 → US5 → US6 → US7 (P2), then US8 (P3).
4. Commit per phase; run targeted tests per task, full suites once in T084.
