# Research: Redis linked to calls

Decisions behind [plan.md](plan.md). Each: Decision / Rationale / Alternatives considered. Code references are to
the tree as of branch `011-redis-capture` (based on `010-mcp-log-investigation`).

## R1 - Where the agent sees a command and its reply (one capture point per client)

**Decision**: one pair of hooks per client, at the place the client turns a command into bytes and the place it
turns reply bytes into a result - the lowest common point every API of that client (sync, async, reactive,
pipelined, Spring Data) passes through:

| Client | Send (request thread, call attributed here) | Reply (raw bytes) |
|---|---|---|
| Lettuce 5/6 | `io.lettuce.core.protocol.DefaultEndpoint.write(RedisCommand)` / `write(Collection)` - still on the caller's thread; `write(Collection)` (and writes while the connection's auto-flush is off, until `flushCommands()`) mark the commands as one `pipeline` group | `io.lettuce.core.protocol.RedisStateMachine.decode(ByteBuf, RedisCommand, CommandOutput)`: the reader index before/after each call bounds the exact RESP bytes of that command's reply (accumulated across partial reads until it returns true) |
| Jedis 3/4/5 | `redis.clients.jedis.Connection.sendCommand(ProtocolCommand, byte[]...)` and `sendCommand(CommandArguments)` | `redis.clients.jedis.Protocol.read(RedisInputStream)` exit: the parsed reply (byte[], Long, List, `JedisDataException`) is re-encoded to RESP - RESP2 encoding is deterministic, so the bytes equal what the server sent |
| Redisson 3 | `org.redisson.client.handler.CommandEncoder.encode(ctx, CommandData, ByteBuf)` for bytes; `org.redisson.command.RedisExecutor.execute()` on the caller thread for the call | `org.redisson.client.handler.CommandDecoder.decode(ctx, ByteBuf, ...)`: reader index before/after per reply, as Lettuce |

The request is stored as the RESP array of bulk strings (exact argument bytes) the client wrote.

**Rationale**: these points are below every higher API (Spring `RedisTemplate`, `@Cacheable`, reactive), so one hook
covers them all; reading the reply from the decoder's buffer gives byte-exact RESP (FR-050) with no re-encoding for
the two Netty clients. All three are hooked by name with `Advice` inlined, like JDBC (no compile dependency, works
when the client is absent).

**Alternatives**: hooking the high-level `RedisCommands`/`Jedis` API methods (hundreds of methods, misses pipelines and
Spring's raw connection use); a TCP-level proxy in front of Redis (sees bytes but not the call, thread or code line,
and needs the app's Redis address changed - rejected, the app must not be reconfigured); hooking `CommandOutput.set*`
callbacks in Lettuce (decoded pieces, no raw bytes, loses RESP3 attribute frames).

## R2 - Attributing a reply that arrives on another thread

**Decision**: at send, the dispatcher reads `ContextPropagation.current()` on the caller's thread, assigns the call's
next `seq` (`CallContext.nextSeq()`, shared with statements/supplier calls/log lines), captures the code line and the
Spring Cache origin, and stores a `PendingCommand` in a `WeakIdentityMap` keyed by the client's command object
(Lettuce `RedisCommand`, Redisson `CommandData`) or, for Jedis (synchronous, FIFO per connection), in a per-connection
FIFO queue keyed by the `Connection`. The reply hook looks the pending command up by the same object, completes it and
sends a `RedisCommandRecord` to the sink. Commands with no call (no context) are not recorded (FR edge case).

**Rationale**: Lettuce and Redisson complete on Netty event-loop threads; the command object travels with the work, so
an identity map is exact. Jedis pipelines send N commands then read N replies on the same connection in order - a FIFO
per connection matches them exactly. The existing `WeakIdentityMap` (used for statements/result sets) avoids leaks if
a reply never comes.

**Alternatives**: thread-locals only (wrong for Netty threads); matching by timing (ambiguous under concurrency).

## R3 - Stored form of request and reply (Relive-ready)

**Decision**: store `args_raw` = RESP request bytes, `reply_raw` = RESP reply bytes, `reply_type` = the top-level RESP
type (`SIMPLE`, `ERROR`, `INTEGER`, `BULK`, `NIL`, `ARRAY`, `NIL_ARRAY`, `MAP`, `SET`, `DOUBLE`, `BOOLEAN`, `BIG_NUMBER`,
`VERBATIM`, `PUSH`), plus `resp_version` (2/3). Hit/miss is derived (`NIL`, `NIL_ARRAY`, empty array/map for reads =
miss). The fingerprint is `command + key pattern + argument shape` (R13 key patterns; shape = argument count and which
are keys/numbers/blobs), computed by the agent like `SqlShape` does for SQL.

**Rationale**: RESP bytes are the one form any client can be answered with later (FR-050); keeping the type separately
makes list queries and hit/miss cheap without parsing blobs.

**Alternatives**: storing decoded values (loses type and binary exactness); storing client-specific objects (unusable
across clients).

## R4 - Values of any size through the agent's queue (never shortened)

**Decision**: a command whose request+reply is ≤ 256 KB travels as one `RedisCommandRecord`. A larger one is split into
`RedisChunkRecord`s of 256 KB (`commandSid`, `part`, `of`, `which` = args|reply|before, base64) followed by the record
itself; the backend assembles parts into the blob table and only then makes the command visible. Each part counts
against the existing queue caps (`MAX_QUEUED_BYTES` 64 MB). If any part cannot be queued, the whole command is dropped
(never part of it) and counted in `droppedCommands` per call, which the backend shows as "capture incomplete: n Redis
commands not kept (agent queue full)". Batches stay under the backend's 32 MB request cap (`MAX_BATCH_BYTES`).

**Rationale**: the spec forbids shortening (FR-012); the agent must still never block or grow without bound
(Constitution II, agent rule "a backend that is down costs the application nothing"). Dropping whole and saying so is
the only honest option.

**Alternatives**: raising queue caps (unbounded memory in the app); truncating big values (forbidden); writing big values
to a temp file in the app's container (side effect on the host app - rejected).

## R5 - Spring Cache origin

**Decision**: hook `org.springframework.cache.interceptor.CacheAspectSupport.execute(CacheOperationInvoker, Object,
Method, Object[])` (enter/exit) to push "method + args" on a per-thread origin stack, and
`org.springframework.data.redis.cache.RedisCache.{lookup,put,putIfAbsent,evict,clear,get}` to push the cache name and
operation (`@Cacheable` for lookup/get, `cache put` for put/putIfAbsent, `evict`, `clear`). A command sent while the
stack is non-empty carries `origin = {store:"spring-cache", cache, operation, method}`. Same mechanism as
`OriginTracker` for Hibernate (HQL origin).

**Rationale**: exact attribution with no guessing from key prefixes; works whether the cache is sync or uses
`RedisCacheWriter` directly.

**Alternatives**: inferring cache names from key prefixes (`fareRules::EK`) - unreliable with custom key prefixes.

## R6 - Code line, thread, connection, pool wait

**Decision**: `CodeLocation` (existing stack walk used for statements) with the Redis client, Spring Data Redis, Spring
cache, Netty and reactor packages added to its skip list; thread = caller thread name at send; connection = an
agent-assigned short id per client connection object (`conn-r-xxxx`, identity hash, as `conn-…` for JDBC); server =
host:port and database index read from the client's connection/URI once per connection. Pool wait: Jedis
`JedisPool.getResource()` and commons-pool2 `GenericObjectPool.borrowObject()` when called for a Redis connection
(enter/exit timing on the caller thread, attached to the next command of that thread); shown "- (no pool)" when no pool
is used (Lettuce's shared connection).

**Rationale**: reuses the existing origin/caller machinery so Redis commands and statements name code the same way.

## R7 - Value before a write (opt-in)

**Decision**: when the project setting `redisBeforeImage` is on, for a write command (SET family, INCR/DECR family,
APPEND, GETSET, MSET, HSET/HDEL/HINCRBY, LPUSH/RPUSH/LPOP/RPOP/LSET/LREM, SADD/SREM, ZADD/ZREM/ZINCRBY, DEL/UNLINK,
EXPIRE family, PERSIST, RENAME, EVAL/EVALSHA with keys) the agent reads, before the write, on the same client through its
own public API and under the dispatcher's agent-work guard: `TYPE key`, then the type's full read (`GET`, `HGETALL`,
`LRANGE 0 -1`, `SMEMBERS`, `ZRANGE 0 -1 WITHSCORES`, `XRANGE - +`) and `PTTL`. Skipped - and recorded as
`before: "not read (in a transaction / pipeline / subscriber / blocking connection)"` - when the connection is inside
MULTI, pipelining (Lettuce auto-flush off, Jedis `Pipeline`), in subscriber mode, or the command is blocking. Before
bytes are stored like replies (`before_raw`, may be chunked).

**Rationale**: mirrors the database before-image (opt-in, the one own query); reading inside a transaction would queue
the read in the app's MULTI and change the app's results - forbidden. `DUMP` was considered (one command, exact) but its
RDB encoding cannot be shown to a person without an RDB decoder.

**Alternatives**: a separate connection opened by the agent (needs credentials, a new socket from the app's process -
rejected); `DUMP`+`PTTL` (unreadable).

## R8 - Housekeeping and credentials

**Decision**: PING, AUTH, HELLO, CLIENT *, SELECT and READONLY sent while a connection is being set up, and Lettuce/
Redisson internal health checks, are skipped unless the project's `redisHousekeeping` is on. AUTH and HELLO … AUTH
arguments are NEVER kept: the agent replaces them with `‹credentials not stored›` before the record leaves the
dispatcher, whatever the setting.

**Rationale**: FR-007, Constitution I (secrets never stored or logged).

## R9 - Storage in `db-capture.db` (slice `backend-db-capture`)

**Decision**: commands live in the database-capture slice and file - the agent already posts its batches there, the
call's statements, log lines and markers are there, and retention/cycle keeping already work there. New tables (see
data-model.md): `store_commands` (one row per command, no blobs), `store_command_data` (blobs: args, reply, before -
fetched only for detail/export), `store_keys` (one row per key touched: key, call, seq, read/write, at, value hash -
for "written by", key history, Keys view), `call_store_summary` (per call: counts, misses, failures, ms - for chips and
the stats pill). Indexes: `(call_id, seq)`, `store_keys(project, key, at_ms)`, `store_keys(call_id)`,
`call_store_summary(failed) WHERE failed > 0`.

**Rationale**: no new slice, no new cross-slice edge, no new gateway prefix (`db-capture` already routed). List queries
read `store_commands` + summary only (Constitution II: summaries for lists, no bodies).

**Alternatives**: a new `backend-redis-capture` slice (the agent batch would need splitting across slices, retention and
cycle keeping duplicated - rejected); one table with blobs inline (list queries would page blobs in SQLite).

## R10 - Size cap (2 GB, oldest calls out)

**Decision**: `DbCaptureRetention.enforce()` gains a second budget: `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES` (default
2147483648). `store.storeBytes()` is one indexed `SUM(bytes)` over `store_commands` (bytes = args + reply + before
sizes). When over, `oldestStoreCallIds(EVICT_BATCH, keep)` → `deleteStoreForCalls(ids)` removes all of each call's
commands, data and keys together. `keep` is the existing `RetainedCallIdsPort` (session-cycle and Relive-cycle calls);
imported calls are held by their cycle. Checked every 20 batches, as today.

**Rationale**: clarified answer Q2; same mechanism and code path as the 4 GB statement cap, so behaviour and tests are
uniform.

## R11 - Decoding for display (structural, in ALFRED, on demand)

**Decision**: a pure Java `StoreValueDecoder` in `backend-db-capture` `domain` (no Spring), called only when a value is
requested (`GET /db-capture/store-commands/{id}` and exports), never at ingest:

- **gzip / zlib / Snappy (raw and framed)** unpacked with an output limit of 64 MB (zip-bomb guard; beyond it the
  value is shown raw with "too large to unpack for display" - storage untouched). Snappy is a ~100-line decoder (format
  is small); no new dependency.
- **JDK serialization**: a stream parser over `TC_*` tokens (class descriptors, field types, values, back-references,
  strings, arrays, enums, common JDK classes - String, boxed numbers, BigDecimal/BigInteger, Date, java.time `Ser`
  proxies, ArrayList/LinkedList/HashMap/LinkedHashMap/HashSet/TreeMap) - never `ObjectInputStream`, never class loading.
  Custom `writeObject` data it cannot interpret is shown as bytes under the field.
- **Kryo**: varint-based reader; registered classes shown as `class #n`, field values in order, unregistered classes
  with their names.
- **JSON / text**: valid UTF-8 JSON pretty-printed; other UTF-8 text as is; Spring's
  `GenericJackson2JsonRedisSerializer` `@class` hints shown as the class name.
- Result: `{format, className?, decoded (text), partial: bool}` or `raw`.

**Rationale**: clarified Q4 and `decoding-mock.html`; parsing without instantiating removes the deserialization-gadget
risk and costs the application nothing.

**Alternatives**: decoding in the agent (rejected in Q4); `ObjectInputStream` with a filter (still instantiates
classes; needs the app's classes).

## R12 - "Written by", key history, cache cold

**Decision**: every command row adds one `store_keys` row per key with `op` (r/w), `at_ms` and `value_hash` (SHA-256 of
the value bytes written or read, computed at ingest from the reply/args). "Written by" for a read = the latest `w` row
of the same project and key with `at_ms` < the read's, joined to its call: method/path/status come from a new out port `CallMetadataPort` in
`backend-db-capture` (`metadata(Set<callId>) → {method, path, status}`), implemented by a new
`CallMetadataAdapter` in `backend-app/dbcapturebridge` that reads the calls and internal-calls slices through their
use-case ports - a composition-root adapter like `InboundProjectsAdapter`, no new slice→slice edge. "Same value" = hashes equal.
"Cache cold" = a miss on a key whose latest earlier write had `EX`/`PX`/`EXPIRE` and whose TTL has elapsed by the read.
Key history = `store_keys` rows for a key, newest first, paged (≤ 200).

**Rationale**: one indexed lookup per opened command; the call metadata join reuses an existing bridge.

## R13 - Key patterns

**Decision**: a key's variable segments become `*`: segments (split on `:`/`::`) that are all digits, UUID/hex ≥ 8,
call-id-like, or that differ across ≥ 3 sibling keys of the same prefix within the call (e.g. `fare:rule:EK…CX`) →
`fare:rule:*`. Implemented once in the backend (`KeyPattern`), used for the Keys view, grouping, findings, endpoint
health and comparisons; the agent's fingerprint uses the same digit/hex rule (no sibling rule - it sees one command).

## R14 - Grouping in the list

**Decision**: frontend `store-command-tree.ts` (beside `db-statement-tree.ts`): consecutive reads of one pattern from
one code line (≥ 3) fold into a `GET ×n` group; commands with a common `txGroup` (MULTI … EXEC) fold into a transaction
row; pipelines into `PIPELINE ×n` (same shape). Together merges the tree items by `seq` with statements, supplier calls
and log lines (existing Together merge in `db-window.component.ts`).

## R15 - Findings

**Decision**: computed in the frontend `db-findings.ts` (existing findings engine) from the call's command list plus
the backend's `cold` marks: failed command (+ the error log line nearest after it), single reads ≥ 3 of one pattern from
one line (`MGET`/pipeline fix), miss followed within the call by a statement whose result was then written to the same
key (miss → DB), big value (≥ 1 MB written, or ≥ 512 KB read), cache cold, and the dangerous-command note (KEYS,
FLUSHDB, FLUSHALL, SCAN loops > 1,000 keys). Slow threshold from settings (default 10 ms).

## R16 - The ⬢ switch

**Decision**: `proxy/redis-capture-enabled.flag` (same `name=on|off` format, missing = off), written by a new
`FileRedisCaptureToggleAdapter` (`ProjectFlagFile`, like `FileLogLinkToggleAdapter`), read by
`log_and_route_reverse.py` through a third `_ToggleState('REDIS_CAPTURE_TOGGLE_FILE', default=False)`; when on (and
inbound logging on) `X-Alfred-Call` gains `redis=1`. `CallContext` parses `redis` → `boolean redis`; a context exists
when any of db/log/redis is 1. `ProjectCaptureStatus` gains `redisOn`; `PUT /db-capture/projects/{p}/redis`.
docker-compose mounts the flag in reverse-proxy and backend like the other two.

## R17 - Exports, import, masking, Claude

**Decision**: `GET /db-capture/calls/{callId}/export` (existing) gains `commands[]` with raw bytes (base64) and the decoded
display text; the frontend export builders render a "Redis" section in .md/.html (`store-export-section.ts`, beside
`db-export-section.ts`) and .json v3 gets `redis` records next to `dbRows` (`json-export-v2.ts`), read back by
`import-parser.ts` and posted with the call's statements to `/db-capture/import`. Masking (`redisMaskPatterns` in
`DbCaptureSettings`) is applied by the backend to every value it returns (window, export, MCP) - `‹masked · n B›` - and
never to storage; a masked value exported to .json re-imports as masked (same as redacted bodies). MCP tools:
`redis_commands`, `redis_overview`, `redis_key_history` (new `mcp-server/src/tools/redis.ts`); `problem_calls`,
`triage`, `investigate_call`, `trace_value`, `endpoint_health`, `compare_cycles` include Redis signals through the
existing `CallSignalsPublisher` → triage and `investigationbridge` paths.

## R18 - Testing

**Decision**: agent ITs (JDK 8 and 21, as today) with real Lettuce 6.x, Jedis 5.x and Redisson 3.x jars in test scope
against an in-test minimal RESP server (`MiniRedis`, a socket server supporting the ~25 commands the tests use, RESP2
and RESP3 HELLO) - no Docker; fake Spring cache classes outside the agent package (like `org.jboss.logmanager` fakes).
Backend: service tests with fake ports, `SqliteDbCaptureRepository` against `@TempDir`, decoder unit tests with real
serialized fixtures produced by the JDK/Kryo at test time, retention test over the 2 GB rule with a small cap. Frontend:
pure utils (tree, findings, export section, redis-cli quoting) tested directly; export round trip built with
`buildBulkExportPayload`. Proxy: `test_db_capture_headers.py` extended for `redis=1`. Overhead measured with the
existing `OverheadMeasurementIT` pattern (SC-003).
