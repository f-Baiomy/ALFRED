# Contract: the agent catching log lines (009)

**Switch in**: per request, `X-Alfred-Call: id=<callId>; db=0|1; log=1` (the reverse proxy sets `log=1` while the
project's ▤ is on - unchanged from 008). Outside-call lines: while the heartbeat answer's `logsOn` is true.

**Behaviour**
1. `log=1` opens a call context even with `db=0` (`capture=false`): a CALL_OPEN marker with `logs=1` and the thread is
   sent; no statements are recorded for it. The 008 MDC tag is still set.
2. An event reaching a hook (research R1) after the application's own level/filter check, on a thread whose context
   has `logs=true`, becomes one `LogRecord` with the context's next `seq`. On a thread with no context, while
   `logsOn`, it becomes an outside-call record. Re-entrant events (bridges) and agent work are never recorded.
3. Caps per call: 5,000 lines, 2 MB text, 32 KB per line (cut, `cut=true`); beyond → counted in `droppedLogs`.
   After the call ends: 5 s grace, then counted as dropped.
4. Records join the existing batch (`logs`, `droppedLogs`); a full queue drops and counts - the application never
   waits.
5. Failures (unknown framework version, a `toString` that throws while formatting) are logged once per kind by
   `AgentLog` and never reach the application; a line whose message cannot be formatted keeps its raw pattern.

**Batch addition** (`POST /db-capture/agent/batch`, `X-Webhook-Secret`):
```json
{ "logs": [ { "callId": "500d0cdc-…", "seq": 17, "at": "2026-10-06T14:08:54.035Z", "level": "WARN",
              "logger": "com.tt.nc.FlightSearchAppServiceImpl", "thread": "default task-4",
              "message": "SabreNdc slow: 2,451 ms", "exception": null, "cut": false },
            { "callId": null, "seq": 0, "at": "…", "level": "INFO", "logger": "org.quartz…", "thread": "scheduler-1",
              "message": "job fired", "exception": null, "cut": false } ],
  "droppedLogs": { "500d0cdc-…": 12 } }
```
Validated (`@Valid`, sizes clamped: ≤ 5,000 records per batch, message ≤ 32 KB, logger/thread ≤ 512).

**Guarantees**: application behaviour and log output unchanged (FR-003); < 5 % on a 100-line call (SC-003); Java 8;
no new runtime dependency (frameworks read reflectively).
