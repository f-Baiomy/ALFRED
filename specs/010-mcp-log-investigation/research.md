# Research: Log lines in Claude's investigation tools

## R1 - Where cross-call questions are answered

- **Decision**: backend endpoints answer every cross-call question (problem calls, log search, grouped problems,
  endpoint health, timeline); the MCP server composes only per-call views.
- **Rationale**: a scope of "everything" is ~30 k calls and ~2 M lines; pulling them into the MCP process to filter is
  slow and blows the reply budget. Triage already proved the pattern ("one request for the marks").
- **Alternatives**: MCP-side aggregation over `/call-logs/{id}` per call - one request per call, minutes for a cycle.

## R2 - Signals stored on triage's mark

- **Decision**: `call_attention` gains `log_errors`, `log_warnings`, `log_exceptions`, `db_flags` (comma list of flag
  names) and `signal_rank` (0 none, 1 warning, 2 error - computed on write). db-capture emits
  `CallSignalsObserverPort.signalsChanged(callId, logErrors, logWarnings, logExceptions, dbFlags)` after a batch that
  changed a call's log counts and when the call closes (flags are final then); `triagebridge` records them.
- **Rationale**: the same feed shape as `StatementFailuresObserverPort` (009-era, proven); one indexed table answers
  filters, endpoint health and timelines. DB flags are computed by db-capture's existing summary code at close, so
  thresholds stay in one place.
- **Alternatives**: join `triage.db` with `db-capture.db` at read time (two SQLite files - ATTACH crosses slice
  ownership); recompute flags in triage (duplicates thresholds).
- **Backfill**: on start, calls in `call_log_summary` / with flags but no signals on their mark are fed once, bounded
  by triage's row cap (same as `TriageBackfill`).
- **Stale flags**: when a project's capture settings change (thresholds, expected statements, ignore list), db-capture
  re-emits the flags of that project's calls in batches of 500 (background, after the save returns), so stored flags
  always match what the database window would show.
- **Imports**: importing calls (cycle import with `dbCapture`/log lines) records their triage marks (call fields +
  signals) through the same bridge, so imported calls are in every answer.
- **Per-call level**: the agent sends the Log level it applied on the CALL_OPEN marker; db-capture stores it on
  `call_markers` and passes it in `signalsChanged`, so `BELOW_LEVEL` names the level of that call.
- **Cycle calls past the cap**: already protected - `TriageRetainedCallIdsAdapter` keeps marks of every call a cycle
  holds when `call_attention` trims.

## R3 - Log search

- **Decision**: FTS5 external-content table `call_log_text(message, logger, exception)` with `tokenize='trigram'`,
  synced by AFTER INSERT/DELETE triggers on `call_log_lines`. Text queries use `MATCH` (quoted, so input is literal);
  queries shorter than 3 characters fall back to `LIKE` over the scope (bounded by scope + `LIMIT`). Patterns
  ("regex") narrow with their longest literal run through FTS, then a Java `Pattern` filters the candidates. Time
  bound: matching runs over a deadline-checking `CharSequence` (throws when 2 s have passed), and at most 200,000
  candidates are examined; the answer then says `cutShort`. The FTS table also indexes `thread` (FR-029).
- **Rationale**: sqlite-jdbc 3.46.1.3 ships FTS5 with trigram (SQLite ≥ 3.34). Substring semantics match what users
  type ("No enum constant", ids). Triggers keep retention deletes one statement.
- **Alternatives**: `LIKE '%x%'` (full scan), Lucene (new dependency, violates I/V), regex in SQLite (`REGEXP` needs a
  Java UDF called per row - slow and a ReDoS risk).

## R4 - Fingerprint (grouping repeated errors)

- **Decision**: `fingerprint = sha1(logger | exceptionType | normalised(message))[0..16]`, computed at ingest.
  Normalisation replaces, in order: UUIDs, ISO/epoch timestamps, hex ≥ 8, quoted strings, numbers (incl. decimals),
  emails, IPs → `<x>`; collapses whitespace; cuts to 300 chars. Unrecognised shapes stay literal (errs toward splitting).
- **Rationale**: conservative merging (SC-003: two different errors never merge). Hash keeps the index small.
- **Backfill**: existing rows get a fingerprint in batches of 5,000 on start (only ERROR/WARN lines need it for grouping;
  all lines get it for uniformity).
- **Alternatives**: Drain-style template mining (the Logs Explorer's `PatternMiner`) - heavier, merges aggressively;
  reuse only its masking idea, not the miner.

## R5 - Scopes

- **Decision**: `scope = { kind: live | cycles | all, cycleIds?: string[] (≤ 50), includeLive?: boolean }`. Resolution
  in `investigationbridge`: live ids from `ListCapturedInternalCallsUseCase`-equivalent for the live ring (inbound) and
  their supplier calls; cycle ids via the session-cycles use case already used by `triagebridge/CycleCallsReader`;
  `all` = live ∪ every cycle. Ids are de-duplicated; each result carries `heldIn: ["live", "cycle:<name>"…]`.
  The id set is written to a per-request SQLite temp table (`CREATE TEMP TABLE scope_ids`) in each slice's query, never
  an `IN (…)` list of thousands.
- **Rationale**: one call can be live and in several cycles (same call id - the cycle copy keeps it); counting once is
  SC-010.
- **Alternatives**: `all` meaning "every row in triage.db" - would include calls neither live nor kept (past the ring
  but not yet trimmed) and could not say where a call is held.

## R6 - Endpoint pattern

- **Decision**: method + path with segments that are numbers, UUIDs, hex ≥ 8 or contain digits mixed with letters
  over 6 chars replaced by `{id}`; query string dropped. Pure function in triage's domain, unit tested.
- **Alternatives**: user-configured route templates - not available; later refinement.

## R7 - Per-call compositions in the MCP server

- **Story**: statements (`/db-capture/calls/{id}/statements`, paged), supplier markers (same page) and lines
  (`/call-logs/{id}`, paged) merged by `seq` - the 009 rule; first-error start = first item with failure or ERROR.
- **Context**: the story window around a line's `seq`.
- **Exception source**: parse `exception.stack` frames (`at a.b.C.m(C.java:12)`), skip JDK/framework prefixes (same
  list as statement chains), `resolveFrames` (source.ts).
- **Log diff**: normalise with R4's function (ported to TS in `signals.ts`, one shared test vector file with the Java
  tests) and align by longest common subsequence of fingerprints.
- **Investigation report**: problem signals (from `/triage/calls`), story from first error with 5 items before, source
  of the first exception, failing supplier calls, most similar successful call = same endpoint pattern, status < 400,
  nearest in time.

## R8 - Settings changed freely

- **Decision**: new `set_log_capture { project, on?, level? }`; `set_db_capture` drops its `confirm` requirement. Both
  return `{ changed: [{ setting, from, to }] }` and the server instructions say "report every change you make".
- **Rationale**: owner decision (clarification Q4). Alfred's own flags only; nothing in the application changes.

## R9 - Bug found while planning

- `mcp-server/src/triage.ts` sends 500 ids per GET (`MAX_IDS = 500`) and `tools/triage.ts` sends 500 ids to
  `/comments/counts` - the gateway refuses > ~200 ids with 414 (fixed in the frontend in 009). Lower to 100 with a
  failing-first test.
