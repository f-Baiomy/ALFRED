# Data Model: Redis linked to calls

All storage is in `db-capture.db` (slice `backend-db-capture`, SQLite - the slice has no file adapter today). Names
are the store-generic ones (FR-035); `store` is `'redis'` for every row this feature writes.

## Agent → backend (transport, contracts/agent-redis-capture.md)

### RedisCommandRecord (agent `transport`)

| Field | Type | Notes |
|---|---|---|
| sid | string | agent-unique command id (`agentId-n`), joins chunk parts |
| callId | string | the call it belongs to (never null - outside-call commands are not recorded) |
| runTag | string? | Relive run tag from `X-Alfred-Call` (FR-053) |
| seq | int | shared call sequence (FR-004, FR-051) |
| at | ISO instant | when sent (3-digit fraction) |
| micros | long | round trip, send → reply complete |
| command | string | upper-case name, `CLIENT SETNAME` style for two-word commands |
| keys | string[] | key arguments for display/index (UTF-8 if valid, else `\xNN` escaped): at most 64 keys, each cut to 1,024 chars with `…` - the full keys are always in `args` |
| keysTotal | int | number of keys the command really has (> 64 → the list above is the first 64) |
| args | base64? | RESP request bytes - absent when chunked |
| reply | base64? | RESP reply bytes - absent when chunked or failed without reply |
| replyType | enum | `SIMPLE`, `ERROR`, `INTEGER`, `BULK`, `NIL`, `ARRAY`, `NIL_ARRAY`, `MAP`, `SET`, `DOUBLE`, `BOOLEAN`, `BIG_NUMBER`, `VERBATIM`, `PUSH`, `NONE` (timeout/connection lost) |
| resp | int | 2 or 3 |
| error | string? | error reply text, or `timeout`/`connection lost: …` |
| argsBytes / replyBytes | long | sizes (full, even when chunked) |
| chunked | bool | parts follow/precede in `redisChunks` |
| client | string | `lettuce 6.2.6`, `jedis 5.1.0`, `redisson 3.27.0` |
| connection | string | `conn-r-1a07` |
| server | string | `redis:6379` |
| db | int | database index |
| thread | string | caller thread |
| code | string? | first application frame (CodeLocation) |
| callers | string[]? | further frames, as statements |
| origin | object? | `{store:"spring-cache", cache, operation, method}` |
| group | object? | `{kind: "tx"|"pipeline", id, index, size}` |
| poolWaitMicros | long? | absent = no pool |
| before | base64? / beforeType / beforeNote | value before the write (R7) or the reason it was not read |
| fingerprint | string | command + key pattern + argument shape |

### RedisChunkRecord

`sid`, `which` (`args`|`reply`|`before`), `part` (0-based), `of`, `data` (base64, ≤ 256 KB decoded).

### Batch additions

`redis: RedisCommandRecord[]` (≤ 2,000 per batch), `redisChunks: RedisChunkRecord[]` (≤ 100 per batch, batch ≤ 32 MB),
`droppedRedis: {callId: count}`.

### MarkerRecord (existing, CALL_OPEN) - addition

`redis: true` when the call's header said `redis=1`. The backend creates the call's `call_store_summary` row
(`commands = 0`, `live = 1`) from it, so a call with ⬢ on and no command shows muted `⬢ Redis 0`, and a call with no
row shows no chip (⬢ was off). CALL_CLOSE sets `live = 0`; a call whose capture ended early (existing marker state)
sets `ended_early = 1`.

## Stored (SQLite)

### store_commands - one row per command, no blobs

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| store | TEXT NOT NULL | `'redis'` |
| project | TEXT NOT NULL | |
| call_id | TEXT NOT NULL | |
| run_tag | TEXT | |
| seq | INTEGER NOT NULL | unique per (call_id, seq) |
| at_ms | INTEGER NOT NULL | epoch ms |
| micros | INTEGER NOT NULL | |
| command | TEXT NOT NULL | |
| keys_json | TEXT | JSON array of keys |
| key_pattern | TEXT | of the first key (R13) |
| rw | TEXT NOT NULL | `r`, `w`, `o` (other: PUBLISH, SCRIPT, …) |
| outcome | TEXT NOT NULL | `HIT`, `MISS`, `OK`, `FAILED` (derived at ingest) |
| reply_type | TEXT NOT NULL | |
| resp | INTEGER NOT NULL | |
| error | TEXT | |
| args_bytes, reply_bytes, before_bytes | INTEGER | sizes |
| bytes | INTEGER NOT NULL | args + reply + before - the retention budget |
| reply_preview | TEXT | first 200 chars of the reply as text (or `‹binary n B›`) - list rows only, never used for export |
| client, connection, server | TEXT | |
| db_index | INTEGER | |
| thread | TEXT | |
| code | TEXT | |
| callers_json | TEXT | |
| origin_json | TEXT | Spring Cache origin |
| group_kind, group_id, group_index, group_size | TEXT/INTEGER | |
| pool_wait_micros | INTEGER | NULL = no pool |
| before_note | TEXT | why no before value |
| fingerprint | TEXT | |
| complete | INTEGER NOT NULL | 0 while chunk parts are missing - hidden from all reads |

Indexes: `ux_store_call_seq (call_id, seq)` unique; `ix_store_at (at_ms)`; `ix_store_failed (call_id) WHERE outcome =
'FAILED'`; `ix_store_run (run_tag) WHERE run_tag IS NOT NULL`; `ix_store_fp (project, fingerprint)`.

### store_command_data - the bytes (detail and export only)

| Column | Type | Notes |
|---|---|---|
| command_id | INTEGER | FK store_commands.id |
| which | TEXT | `args`, `reply`, `before` |
| part | INTEGER | chunk order (0 for unchunked) |
| data | BLOB | |

PK `(command_id, which, part)`. Assembled in order on read; never selected by list queries.

### store_keys - one row per key a command touched

| Column | Type | Notes |
|---|---|---|
| project | TEXT | |
| key | TEXT | |
| call_id | TEXT | |
| seq | INTEGER | |
| op | TEXT | `r` / `w` |
| at_ms | INTEGER | |
| value_hash | TEXT | SHA-256 hex of the value read or written (NULL for misses/deletes) |
| ttl_ms | INTEGER | TTL set by this write (EX/PX/EXPIRE…), NULL if none |

Indexes: `ix_keys_key_at (project, key, at_ms)`, `ix_keys_call (call_id)`.

### call_store_summary - per call, for chips, the stats pill and endpoint health

| Column | Type |
|---|---|
| call_id | TEXT PK |
| project | TEXT |
| commands, reads, writes, hits, misses, failed | INTEGER |
| micros | INTEGER (sum of round trips) |
| dropped | INTEGER (commands not kept - queue full) |
| live | INTEGER (1 from CALL_OPEN with `redis`, 0 at CALL_CLOSE) |
| ended_early | INTEGER (agent detached / ⬢ switched off before the call ended - existing ended-early rule) |
| first_seen | TEXT |

Index `ix_store_summary_failed (failed) WHERE failed > 0`, `ix_store_summary_first_seen (first_seen)`.

### DbCaptureSettings (existing record, `capture_settings.settings_json`) - new fields

| Field | Type | Default |
|---|---|---|
| redisMaskPatterns | string[] | `[]` (Q3) |
| redisShowValues | `DECODED` \| `RAW` | `DECODED` |
| redisBeforeImage | bool | false |
| redisSlowMillis | int | 10 (1..60000) |
| redisHousekeeping | bool | false |

Settings stored before these existed read back with the defaults (existing compact-constructor pattern).

### ProjectCaptureStatus (existing record) - new fields

`redisOn` (⬢), `redisClients` (detected: `[{client, version, connections, servers[], dbs[]}]`, from agent heartbeats),
`springCaches` (names seen).

## Domain records (backend `domain.model`)

- `StoreCommand` - the row above + `DecodedValue reply`, `DecodedValue before` (detail only), `KeyWriter writtenBy`
  (reads with a hit), `boolean cold`.
- `StoreCommandSummary` - list row (no bytes): id, seq, at, micros, command, keys, keyPattern, rw, outcome, replyPreview,
  origin, group, code, slow.
- `DecodedValue` - `format`, `className`, `text`, `partial`, `rawBase64` (only when asked), `masked`, `bytes`.
- `KeyWriter` - callId, seq, method, path, status, `agoMillis`, `sameValue`; or `none` with reason.
- `KeyPatternRow` - pattern, commands, reads, writes, hits, misses, failed, micros, lastWriter.
- `CallStoreSummary` - the summary row.
- `IncomingStoreCommand`, `IncomingStoreChunk` - ingest forms.

## State

A command row is `complete = 0` from its first chunk until its last part and its record have arrived; reads filter
`complete = 1`. Parts older than 10 minutes without completion are deleted with the incomplete row (and counted in the
call's `dropped`) by the retention pass. A call's summary is `live = 1` from CALL_OPEN until CALL_CLOSE (existing
markers).

## Validation (ingest DTOs, Bean Validation)

`redis` ≤ 2,000 items; `redisChunks` ≤ 100; chunk `data` ≤ 350,000 base64 chars (the agent never builds bigger parts);
the display copies `command` and `keys` are cut by the agent (command name ≤ 64 chars, ≤ 64 keys × 1,024 chars) so they
can never fail validation - and no field of a command is ever a reason to reject a batch: a command that still fails a
check is stored with `error = "invalid record: …"` and its raw bytes, while the rest of the batch is stored normally
(failures stay loud - logged with call id and sizes); `seq` ≥ 1; `micros` ≥ 0; `replyType` one of the enum; batch body ≤ 32 MB (existing check). Query
parameters: page `limit` clamped to 1..500, key history ≤ 200, summaries ≤ 100 ids per request (existing rule).
