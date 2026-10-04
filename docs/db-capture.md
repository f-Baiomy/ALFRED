# Database Capture

Records every database statement a Java application runs, tied exactly to the inbound call that caused it and
ordered exactly against that call's supplier calls, and shows it per call in ALFRED (the `◆ DB` chip and the
database window). Spec, plan and the agreed UI mock: `specs/006-db-capture/`.

Relive replay of statements is a **later feature**. The agent and the stored format are already shaped for it
(see "Relive-ready seams" below) - nothing replays today.

## How it works

```
caller ──► reverse-proxy ──X-Alfred-Call: id=…; db=1──► app (WildFly) ──JDBC──► database
                                                          │  db-agent (in the app's JVM)
                                                          │   - servlet entry opens a call context
                                                          │   - JDBC advice records each statement
                                                          │   - outbound HTTP gets X-Alfred-Parent ──► proxy (popped)
                                                          └── batches ──► backend-db-capture (/db-capture/agent/batch)
```

- **Switch**: `proxy/db-capture-enabled.flag` (`name=on|off`, a missing line is **off**). The reverse proxy reads it
  and sets `db=1` in `X-Alfred-Call` only when the project's inbound logging AND database capture are on.
- **Agent**: `db-agent/` (Java 8 bytecode, ByteBuddy shaded). Never blocks the application: it only enqueues;
  one daemon thread sends batches; when the queue is full statements are dropped and counted.
- **Backend**: `backend-db-capture` slice, own SQLite file `db-capture.db`.
- **Frontend**: `components/db-capture/*`, the `◆` switch in the Sources bar, "Log DB" in the cycle widget,
  Settings → Database capture.

## Settings and environment

| Variable | Default | Meaning |
|---|---|---|
| `DB_CAPTURE_DB_FILE` | `/dbcapturedb/db-capture.db` (named volume `db-capture-db`) | the store |
| `DB_CAPTURE_TOGGLE_FILE` | `/appdata/db-capture-enabled.flag` (backend), `/home/mitmproxy/db-capture-enabled.flag` (reverse-proxy) | the per-project switch |
| `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` | `4294967296` (4 GiB) | size cap; oldest calls' statements evicted first, never those held by a session cycle or Relive cycle |

## Relive-ready seams

- `StatementInterceptor` in the agent - the one place a later version can answer a statement instead of the database.
- Statements store placeholder SQL, typed parameters, the full outcome, a fingerprint and their order number.
- The Relive run tag from `X-Alfred-Call` is stored on statements.

## Measurements

(Filled in by the implementation: overhead per call, ingest throughput, window open time.)
