# Contract: cross-call investigation endpoints (backend)

All are `POST` with a JSON body (scopes and filters never travel in the URL - the gateway refuses request lines over
8 KB). All served by `backend-app/investigationbridge` under prefixes already routed by the gateway. Every response
carries `scope: { kind, cycles: [{id, name}], includeLive, calls, from, to }` and `unavailable: [{ project, why }]`
(`why` ∈ `LOGS_OFF`, `NO_AGENT`, `DB_OFF`).

Common body part:

```json
{ "scope": { "kind": "live" | "cycles" | "all", "cycleIds": ["…"], "includeLive": false },
  "project": "odeysys", "from": "2026-10-06T17:00:00Z", "to": "2026-10-06T19:00:00Z" }
```

## POST /triage/problem-calls

Body: common + `{ "all": ["LOG_ERROR"], "any": [], "none": ["HTTP_ERROR"], "dbFlags": ["REPEATED_QUERY"], "minStatus": 400, "after": "cursor", "limit": 50 }`

```json
{ "counts": { "HTTP_ERROR": 3, "NO_ANSWER": 0, "DB_FAILED": 6, "DB_WARNING": 41, "LOG_ERROR": 99, "LOG_WARNING": 5,
              "LOG_EXCEPTION": 12, "SUPPLIER_FAILED": 2, "total": 186 },
  "calls": [ { "callId": "…", "method": "POST", "path": "/odeysysadmin/Booking2/flight-search/search", "status": 200,
               "startedAt": "…", "durationMs": 9436, "project": "odeysys", "heldIn": ["live", "cycle:impo"],
               "signals": ["DB_FAILED", "LOG_ERROR", "LOG_WARNING", "DB_WARNING"], "severity": "error",
               "evidence": { "failedStatements": 1, "swallowed": true, "dbFlags": ["SLOW"], "logErrors": 5, "logWarnings": 1,
                             "logExceptions": 2, "failingSupplierCalls": 0 } } ],
  "next": "cursor|null", "scope": {}, "unavailable": [] }
```

Order: severity, then number of signals, then newest. Counts are over the whole scope, before `after`/`limit`.

## POST /triage/endpoints

Body: common + `{ "limit": 50 }` → `{ "endpoints": [EndpointHealth], "more": n }` worst first (error calls, then warnings).

## POST /triage/timeline

Body: common + `{ "bucketMinutes": 1 }` → `{ "buckets": [{ "minute": "…", "counts": { "LOG_ERROR": 4, … } }], "firstSeen": { "LOG_ERROR": "…" } }`; empty minutes omitted, at most 1,440 buckets.

## POST /call-logs/search

Body: common + `{ "text": "No enum constant", "pattern": null, "minLevel": "WARN", "logger": "MainLogger",
"exceptionType": "IllegalArgumentException", "after": "lineId|null", "limit": 50 }`

```json
{ "total": 3, "hits": [ { "callId": "…", "method": "POST", "path": "…", "status": 200, "callAt": "…", "heldIn": ["live"],
   "line": { "lineId": "c:812", "seq": 14, "offsetMs": 839, "at": "…", "level": "ERROR", "logger": "…", "thread": "…",
             "message": "…", "exception": { "type": "…", "message": "…", "stack": "…" }, "cut": false } } ],
  "next": "lineId|null", "cutShort": null, "scope": {}, "unavailable": [] }
```

`text` matches message, logger, thread and exception text. A `pattern` search is time-bounded (2 s, 200,000 candidates);
when a limit is hit the answer carries `"cutShort": { "scannedLines": n, "reason": "TIME" | "CANDIDATES" }` and the hits
found so far.

Lines outside any call are included only with `"outside": true` in the body (`callId` null). `total` is exact.

## POST /call-logs/problems

Body: common + `{ "levels": ["ERROR"] | ["ERROR","WARN"], "limit": 30, "newSince": "ISO|null" }` →
`{ "problems": [LogProblem], "more": n }` most lines first. `isNew` = first seen at or after `newSince`
(default: the second half of the scope's time range).

## POST /call-logs/problems/calls

Body: common + `{ "fingerprint": "9f2c…", "after": "cursor", "limit": 50 }` → `{ "calls": [ { callId, method, path, status, startedAt, heldIn, lines } ], "next" }`.

## GET /call-logs/{callId} (existing) - extended

`logLevel` is now the Log level that applied to this call (from its CALL_OPEN marker), with `levelAssumed: true` when
the call predates per-call levels and the project's current setting is shown instead.

## GET /db-capture/outside/logs (existing) - extended

New query params: `from`, `to`, `minLevel` (all short scalars - safe in a URL).

## Errors

400 with `{ "error": "…" }` for invalid scope/filters (unknown signal, > 50 cycles, bad pattern, bad dates); 404 naming
an unknown cycle.
