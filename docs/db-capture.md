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

## Switching it on

1. Inbound logging must be on for the project (statements are attached to inbound calls).
2. Load the agent into the application's JVM, either
   - live, into a running WildFly: `python3 start.py --db-capture on <project>` (or `restart.py`, or
     `wildfly-proxy-toggle/db-capture-on.sh|.bat <project>` directly) - finds WildFly through the Attach API like
     the outbound proxy toggle, builds the agent jar on first use, passes `secretFile=<repo>/.env` so the webhook
     secret never appears on a command line; or
   - at JVM start: `-javaagent:/path/alfred-db-agent.jar=alfredUrl=http://localhost:3000;project=<project>;secretFile=/path/.env`.
3. Switch capture on: the `◆` next to the project's inbound-logging dot in Live Calls' Sources bar, the **Log DB**
   column in the cycle widget's Sources popover, or Settings → Database capture. One setting, three places; every
   change is broadcast on `/ws/db-capture`, so all three (and every other open tab) follow it.

`--db-capture off` / `db-capture-off` / the switch only stop capture: **an agent cannot be unloaded from a running
JVM**, so it stays loaded and records nothing until the JVM restarts. Loading it twice is harmless. With
`restart.py`, name services before the flag (`restart.py backend --db-capture on wallet-app`) - a word after
`on|off` is taken as the project.

The agent reports in every 10 s (`/db-capture/agent/heartbeat`); a project counts as "agent attached" while it was
heard from in the last 30 s. Its answer carries the project's settings and switch, so a settings change reaches the
agent within one heartbeat. JBoss Modules: the agent puts its bridge on the boot class path and opens it to every
module; if a deployment still cannot see it, add `-Djboss.modules.system.pkgs=com.fathy.alfred.dbagent.bootstrap`.

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

## Settings per project (Settings → Database capture)

| Setting | Default | Meaning |
|---|---|---|
| Rows kept per result | 50,000 | rows past this are counted, not stored - the window says so ("120,480 rows returned - 50,000 stored") |
| Before-image tables | none | for these tables the agent reads the affected rows just before each UPDATE/DELETE (one extra read, same transaction) |
| Flags | slow 20 ms, huge 1,000 rows, N+1 from 5 repeats, large delete 100 rows | when the window's flags fire; DELETE/UPDATE without WHERE always flags |
| Expected | none | statement fingerprints marked expected never raise a flag |
| Ignore | `SELECT 1` | statements never recorded (`%` wildcard, or a table name) |
| Outside calls | on | also record statements no inbound call caused (scheduled jobs, listeners, startup), in their own window |

Redaction: values are never hidden in Alfred itself. A `db-column` redaction (⊘ on a column in the database window,
listed under Settings → Database capture) masks that column in exported result rows, before-images and the
parameters bound to it (`sql-param-columns.ts`: INSERT column lists, `SET col = ?`, `WHERE col = ?`).

## Exports

`.md` and `.html` get a "Database" section per captured call (every statement with its values, transactions,
supplier calls where they ran, every stored row); `.json` carries `dbCapture` on the event that completes the call
and re-imports it (`POST /db-capture/import`); Export .sql in the window writes a runnable script. Nothing is cut.

## Measurements

- Agent overhead (`OverheadMeasurementIT`, 50-statement call, H2 in memory, 1,000 iterations): ~19 us added per
  statement on Java 8 (1.8.0_504) and Java 21 - against a real database round trip of 0.3-5 ms that is well inside
  the 5 % budget. The main costs were the regex passes over the SQL and the stack walk for "where in code"; both are
  now cached per SQL text / walked lazily (`StackWalker` on 9+, per-frame access on 8).
