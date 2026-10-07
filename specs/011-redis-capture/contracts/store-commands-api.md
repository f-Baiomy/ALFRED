# Contract: backend REST + WebSocket (all under the existing `db-capture` prefix - no gateway change)

All ids are path-validated; every list is clamped server-side. Masked values (project `redisMaskPatterns`) are
returned as `{"masked": true, "bytes": n}` with no data - in every endpoint below, including export.

## Switch and settings

- `GET /db-capture/projects` - each project gains `redisOn`, `redisClients[]`, `springCaches[]`.
- `PUT /db-capture/projects/{project}/redis` `{ "on": true }` → 200 status; 409 when inbound logging is off (as `/logs`).
- `GET|PUT /db-capture/projects/{project}/settings` - `DbCaptureSettings` gains `redisMaskPatterns`, `redisShowValues`,
  `redisBeforeImage`, `redisSlowMillis` (1..60000), `redisHousekeeping`; validated with `@Valid`.

## Per call

- `GET /db-capture/calls/{callId}/store-commands?store=redis&offset=0&limit=500` →
  `{ total, commands: StoreCommandSummary[], cold: [seq…], dropped }` (no bytes; limit ≤ 500).
- `GET /db-capture/store-commands/{id}?raw=false` → `StoreCommand` with `reply`/`before` decoded
  (`DecodedValue`), `writtenBy`, full `args` as text tokens; `raw=true` adds `rawBase64` for args/reply/before.
- `GET /db-capture/calls/{callId}/store-keys?store=redis` → `KeyPatternRow[]` (Keys view, with `lastWriter`).
- `GET /db-capture/store-keys/history?project=&key=&limit=50` → `[{callId, seq, op, at, method, path, status, sameValueAsPrevious}]` (limit ≤ 200).
- `GET /db-capture/calls/{callId}/store-commands/redis-cli?seq=…` → `text/plain` redis-cli lines for the listed (or all)
  commands; binary arguments as `"\xNN"` escapes; masked keys' values written as `‹masked›`.

## Lists and filters

- `GET /db-capture/store/summaries?callIds=…` (≤ 100 ids) → `{callId: CallStoreSummary}` - `{commands, reads, writes,
  hits, misses, failed, micros, dropped, live, endedEarly}`; absent when ⬢ was off for the call, `commands: 0` when the
  agent saw none. (As built: its own endpoint beside the statement summaries, so neither response changes shape.)
- `GET /db-capture/store/failures?callIds=…` (≤ 500 ids) → the ids among them with a failed Redis command (for the
  `✖ Redis failures` pill and filter).

## Trace

- `GET /db-capture/calls/{callId}/trace?value=…` (existing) - hits gain `{kind: "redis", seq, where: "key"|"arg n"|"reply $.path"|"before"}`.

## Export / import

- `GET /db-capture/calls/{callId}/export` (existing) gains `commands[]`: every field of `StoreCommand` plus
  `argsBase64`, `replyBase64`, `beforeBase64` (absent when masked) and `decoded` display text. No truncation.
- `POST /db-capture/import` (existing) accepts `commands[]` in the same shape and stores them for the imported call.

## Investigation (Claude, endpoint health)

- `GET /db-capture/investigate/{callId}` (existing) gains `redis: {commands, misses, failed, cold, slow, bigValues, findings[]}`.
- Endpoint health / compare cycles (in `investigationbridge`) read `call_store_summary` through a new
  `StoreSummariesUseCase` port: per endpoint `redisPerCall`, `hitRate`, `missToDbPerCall`, `failedCalls`; per cycle pair
  the change by command and key pattern.

## WebSocket (existing `/ws/db-capture`)

`{"type":"store-commands","callIds":[…]}` after a batch stored commands - the window and chips refetch (no polling).
`{"type":"projects"}` after a ⬢ toggle (existing message).
