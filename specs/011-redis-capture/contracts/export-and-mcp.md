# Contract: exports, import and Claude's tools

## .md / .html

Per call, after the database section: **Redis** - header line (`22 commands · 5 miss · 1 failed · 25.4 ms`), then
every command in `seq` order: number, command, key, arguments (binary as `\xNN`), reply, time, offset, Spring Cache
origin, code line; then its value in full (decoded text with format line, or raw hex when undecodable; masked keys as
`‹masked · n B›`). Groups (`GET ×9`, `MULTI ×2`) are a heading with their commands under it. Built by
`shared/utils/store-export-section.ts`; escaped with the existing `escapeHtml`/`mdCell`. Never truncated (guard test
with a 2 MB value).

The "About This Document" narrative (`export-narrative.ts`) adds one sentence when Redis commands are present.

## .json (alfred-calls/3)

A `redis` record per command, after the call's `dbRows`:

```json
{"t":"redis","callId":"…","seq":27,"command":"SET","keys":["upsell:a5b4f2f0"],"replyType":"SIMPLE","resp":2,
 "args":"<base64>","reply":"<base64>","before":"<base64>","at":"…","micros":14200,"client":"lettuce 6.2.6",
 "connection":"conn-r-1a07","server":"redis:6379","db":0,"thread":"default task-4","code":"…","origin":{…},
 "group":null,"fingerprint":"SET upsell:* [k,blob,EX,n]","masked":false}
```

The `index` lists them with byte offsets like other records. `import-parser.ts` reads them back unchanged (round-trip
test with `buildBulkExportPayload`); versions 1 and 2 have no Redis and import as before.

## Copy as redis-cli / Export .redis

One line per command: `SET "upsell:a5b4f2f0" "\x1f\x8b\x08…" EX 900`; a header comment with call id and time.
`.redis` is the same text as a file.

## Claude (mcp-server)

New `src/tools/redis.ts`:

- `redis_commands { callId, filter?: all|reads|writes|misses|failed, offset?, limit? (≤200) }` - rows with decoded
  values (masked stays masked; session masking applies).
- `redis_overview { callId }` - counts, hit rate, slow, big values, cold keys, findings.
- `redis_key_history { project, key, limit? (≤200) }` - every recorded call that read or wrote the key.

Changed: `problem_calls` / `triage` / `investigate_call` gain the `redis-failed` (problem) and `cache-cold` (warning)
signals; `trace_value` searches Redis keys, arguments and replies; `endpoint_health` and `compare_cycles` gain the Redis
columns. Tool descriptions say when ⬢ capture was off for the call.
