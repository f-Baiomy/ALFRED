# Contract: agent Redis capture

## Header (reverse proxy → application)

`X-Alfred-Call: id=<callId>; db=0|1[; log=1][; redis=1][; run=<runId>/<stepKey>]`

- `redis=1` is added only when the project's inbound logging is on AND its line in
  `proxy/redis-capture-enabled.flag` is `on` (missing line = off).
- The agent creates a call context when any of `db`, `log`, `redis` is 1. `redis=1` alone records commands but no
  statements and no log lines.
- Unknown parts stay ignored (older agents ignore `redis=1`).

## What the agent records

For a request with `redis=1`, every command sent by Lettuce, Jedis or Redisson (and APIs built on them) from the
request thread or threads it handed work to (`wrapRunnable`/`wrapCallable`), until the request ends plus the existing
5 s late grace for asynchronous replies.

- Never recorded: commands with no call context; housekeeping (PING, AUTH, HELLO, CLIENT *, SELECT/READONLY during
  connection setup, client health checks) unless `redisHousekeeping` is on.
- AUTH / HELLO … AUTH arguments are always replaced by `‹credentials not stored›`.
- The agent never changes the command, its arguments, its reply or its timing beyond the measured overhead (SC-003),
  and sends no command of its own except the before-write reads when `redisBeforeImage` is on (R7), which are never
  sent inside MULTI, pipelines, subscriber or blocking connections.
- Every agent-internal call runs under the dispatcher's agent-work guard (no recursion into its own hooks).

## Batch (POST /db-capture/agent/batch, existing endpoint) - additions

```json
{
  "agentId": "a1", "project": "odeysys",
  "statements": [], "markers": [], "logs": [],
  "redis": [
    {
      "sid": "a1-9132", "callId": "a5b4f2f0-…", "seq": 12, "at": "2026-10-06T21:36:47.082Z", "micros": 310,
      "command": "GET", "keys": ["fare:rule:EK"], "args": "KjINCiQzDQpHRVQNCiQxMg0KZmFyZTpydWxlOkVLDQo=",
      "reply": "JDMwMA0KrO0ABXNy…", "replyType": "BULK", "resp": 2, "argsBytes": 31, "replyBytes": 307,
      "client": "lettuce 6.2.6", "connection": "conn-r-1a07", "server": "redis:6379", "db": 0,
      "thread": "default task-4", "code": "com.tt.ts.cache.FareRuleCache.get(FareRuleCache.java:57)",
      "origin": {"store": "spring-cache", "cache": "fareRules", "operation": "@Cacheable", "method": "FareRuleService.load(\"EK\")"},
      "fingerprint": "GET fare:rule:* [k]"
    },
    {
      "sid": "a1-9150", "callId": "a5b4f2f0-…", "seq": 27, "command": "SET", "keys": ["upsell:a5b4f2f0"],
      "chunked": true, "argsBytes": 217088, "replyBytes": 5, "reply": "K09LDQo=", "replyType": "SIMPLE",
      "before": "JC0xDQo=", "beforeType": "NIL", "group": null, "…": "…"
    }
  ],
  "redisChunks": [
    {"sid": "a1-9150", "which": "args", "part": 0, "of": 1, "data": "…base64 ≤ 256 KB…"}
  ],
  "droppedRedis": {"a5b4f2f0-…": 0}
}
```

Rules: chunks of a command may arrive in earlier batches than its record; the command becomes visible when all `of`
parts of each chunked `which` and the record are stored. A command is dropped whole when any part cannot be queued, and
counted in `droppedRedis`.

## Heartbeat (existing) - additions

`redis: {clients: [{client, version, connections, servers, dbs}], springCaches: [names]}` - shown in the ▾ settings
("Clients found", "Spring Cache names").

## Agent settings (GET /db-capture/agent/settings, existing) - additions

`redisBeforeImage`, `redisHousekeeping` (the other Redis settings are display-only and stay in the backend).

## Seams for a later Relive (FR-052) - built, not used

`RedisInterceptor` interface in the agent with `onSend(PendingCommand)` / `onReply(PendingCommand, bytes)`; the shipped
implementation is `CaptureOnlyRedisInterceptor` (records). A later version can return a supplied reply at `onSend`
instead of letting the client write - the same split as `StatementInterceptor` / `CaptureOnlyInterceptor`.
