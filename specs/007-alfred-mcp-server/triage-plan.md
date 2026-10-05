# Plan: Triage - "what needs attention first"

Status: implemented 2026-10-06 (owner said "start"). Differences from the text below, decided while building:
- triage has its own SQLite file `triage.db` (like every other slice), not a table in `alfred.db`.
- Indexes: `ix_attention_recent` (started_at) and `ix_attention_project` (project, started_at), both partial
  `WHERE parent_call_id IS NULL AND priority <= 5`; `ix_attention_parent`; `ix_attention_progress` (IN_PROGRESS only);
  `ix_attention_started`. A query repeats `priority <= 5` literally so SQLite can use the partial indexes; tests assert
  every index with `EXPLAIN QUERY PLAN`.
- Row cap default 100,000 (a call is one small row; 20,000 was below what calls.db holds).
- Writes run on one writer thread (bounded queue, caller-runs when full), so no webhook waits for a body read.
- The one-time fill reads bodies by id where they can change the mark (range reads carry metadata only).
- `/calls/children?parentIds=` (3.2 of the first draft) was not needed: the saved rows carry the parent link.
- UI: the "Needs attention" list filter was not built - the approved mock has "Has DB failures" only; it is the
  Filters menu item plus a "✖ DB failures" stats-bar pill. The status pills already cover failing statuses.
- Live check: the supplier call in the user-flow cycle (#16, OTA 322) has no parent link in the recorded data, so it
  is listed on its own in group 5 rather than under the flight search; the flight search is group 4 by its failed
  statement.

## 1. The goal

When Claude debugs a session cycle or the live calls, its first question is "what needs attention?" One tool answers it
fast, in priority order, with the evidence for each call already attached:

| Priority | Call | Evidence attached |
|---|---|---|
| 1 | Inbound call with status >= 300 or an error, whose **supplier calls** also need attention (>= 300, an error, or an error inside a 200 such as the Air Arabia 322) | the failing supplier calls (number in the cycle, status, the error from the body) |
| 2 | Inbound call with status >= 300 or an error, with **failed database statements** | the failed statements (#seq, table, SQL state, message, swallowed or not, call chain resolved to project files) |
| 3 | Other inbound calls with status >= 300 or an error | - |
| 4 | Inbound call under 300 with a failing supplier call or failed database statements - **hidden failures** (e.g. flight search 200 while #42 failed and was swallowed) | the failing supplier calls and/or failed statements |
| 5 | Call under 300 with an error inside its body, or an empty result | the error / the empty keys |
| 6 | **Every other call** - never left out | compact row; within the group, calls with other signals first: database findings that are not failures (fan-out, duplicates, slow queries, idle gaps), much slower than the rest, or commented |

The groups are a **reading order**, not a filter: they make the first look fast and point at the likeliest cause, but
a call that succeeded can still be the cause (a 200 with wrong data, a login that set the session the next call
rejects). Totals cover all six groups and add up to every call in scope; the prompts tell Claude to read the group-6
calls related to the problem - first the ones just before a failing call - after groups 1-5.

- A call that is both 1 and 2 is listed once, under 1, with both kinds of evidence.
- "Needs attention" = status >= 300, an error, or still in progress after it should have finished. The threshold is a
  parameter (`minStatus`, default 300); 300 means redirects count (e.g. the 307 session check).
- Outbound calls are judged too (>= 300, error, error inside a 200), but they are listed under the inbound call that made
  them; an outbound call with no inbound parent is listed on its own at the same priority as its own state.

## 2. What exists today (checked in the code, before this plan)

- `call_db_summary` (backend-db-capture, SQLite) holds per call `failed_count` and the flags (e.g. FAILED_SWALLOWED);
  `GET /db-capture/summaries?callIds=` reads up to 500 calls in one request. Finding "which calls had a failed
  statement" is already fast for a known list of calls.
- Failed **statements** are not indexed: "failed" lives inside `statements.outcome_json`. Listing a call's failed
  statements means reading every statement of the call (181 in the odeysys search call).
- Supplier calls of an inbound call: `GET /calls/{id}/children`, backed by `idx_call_metadata_parent` - indexed, but one
  request per inbound call.
- There is no "recent calls with a failed statement" query; the summary table has no index for it.

## 3. Backend changes - everything saved and indexed when the call happens

Owner's requirement: the relation (call -> its failing supplier calls -> its failed statements) and the priority are
**saved and indexed as the calls arrive**, not worked out when Claude asks. `triage` is then one indexed read.

### 3.1 backend-db-capture: failed statements stored and indexed per call

- `statements.failed INTEGER NOT NULL DEFAULT 0` - set at insert from the outcome (kind FAILED). Added with the
  existing `addColumnIfMissing`; existing rows filled once at start-up
  (`UPDATE statements SET failed = 1 WHERE failed = 0 AND json_extract(outcome_json, '$.kind') = 'FAILED'`, guarded so it
  runs only when the column was just added).
- `CREATE INDEX ix_statements_failed ON statements(call_id, seq) WHERE failed = 1` - partial: only failed rows, tiny.
- `refreshSummary` counts from the `failed` column (no more `json_extract` over every statement of the call).
- New out port `DbSummaryChangedPort` - called after each `refreshSummary`/`markComplete` with
  `(callId, failedCount, swallowedCount)`; the triage bridge implements it (3.3). No other slice is imported.
- `GET /db-capture/failures?callIds=a,b,...` (max 500 ids, else 400) ->
  `{ "<callId>": { failedCount, swallowedCount, statements: [{ id, seq, kind, table, sqlState, vendorCode, message,
  swallowed, undone, codeLocation, callers }] } }` - only calls that have failed statements. One query on
  `ix_statements_failed`.

### 3.2 New leaf slice backend-triage: the saved, indexed attention record

Own SQLite table (in the shared `alfred.db`, like the other SQLite slices), one row per call, written as the call
happens, read by `triage`:

```
call_attention(
  call_id TEXT PRIMARY KEY, direction TEXT,            -- INBOUND / OUTBOUND
  project TEXT, parent_call_id TEXT,                   -- outbound: the inbound call that made it
  method TEXT, url TEXT, status INTEGER, error TEXT, started_at INTEGER, finished_at INTEGER,
  state TEXT,                                          -- IN_PROGRESS / DONE
  soft_error TEXT,                                     -- error inside a 2xx body ("322: No availability"), else NULL
  empty_result TEXT,                                   -- the empty keys, else NULL
  failing_children INTEGER NOT NULL DEFAULT 0,         -- supplier calls of this call that need attention
  failed_statements INTEGER NOT NULL DEFAULT 0, swallowed_statements INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL,                           -- 1..6 (section 1), recomputed on every change of this row
  updated_at INTEGER)
CREATE INDEX ix_attention_priority ON call_attention(priority, finished_at DESC);
CREATE INDEX ix_attention_project  ON call_attention(project, finished_at DESC) WHERE priority <= 5;
CREATE INDEX ix_attention_parent   ON call_attention(parent_call_id) WHERE parent_call_id IS NOT NULL;
```

- `priority` is stored for `minStatus` 300 (the default). A different `minStatus` on `triage` re-ranks from the
  stored columns (status, error, failing_children, failed_statements, soft_error) - still no other read.
- **Arrival order does not matter.** Whatever arrives first (the inbound call, a supplier call, a DB batch) upserts
  the row; every later fact updates its column and recomputes `priority` in the same transaction. A supplier call that
  completes after its parent re-counts `failing_children` on the parent row through `ix_attention_parent`; a DB batch
  that arrives after the response updates `failed_statements` the same way.
- **Error inside 200 / empty result** is detected once, when the call completes, by a Java port of the frontend's
  `soft-failure.ts` rules (only for status < 300, JSON/XML bodies). Both implementations run the same shared vectors
  (`specs/007-alfred-mcp-server/soft-failure-vectors.json`) in their tests, as the dynamic-token vectors already do,
  so they cannot drift apart silently.
- **Retention.** Rows follow the calls: pruned past `alfred.triage.retention-rows` (default 20000, newest kept), except
  calls a session cycle holds (same idea as db-capture's `RetainedCallIdsAdapter`), so a cycle's triage never loses
  its marks.
- **Back-fill once** at first start-up of this version: existing outbound calls, the inbound ring buffer, cycle copies
  and db summaries are read once and written into `call_attention` (guarded by a marker row, runs in the background,
  logged).
- Use case `QueryAttentionUseCase`, endpoints (gateway regex gains `triage`):
  - `GET /triage/calls?callIds=a,b,...` (max 500, else 400) -> the rows of those calls plus their failing supplier
    calls - what a cycle triage needs, one indexed query.
  - `GET /triage/live?project=&since=&to=&maxPriority=5&limit=` (limit clamped to 500) -> newest first, by
    `ix_attention_project` / `ix_attention_priority`.
  - `GET /triage/counts?project=&since=` -> per-priority totals (for the `get_cycle` attention line and the UI).
- WebSocket `/ws/triage` signals "attention changed" (no polling), so an open UI re-reads only when a mark changes.

### 3.3 backend-app/triagebridge (the only place that knows both sides)

Same pattern as `dbcapturebridge`:
- `InboundAttentionAdapter` (`NewInternalCallObserverPort`): prepared -> row IN_PROGRESS; completed -> status, error,
  soft failure / empty result, DONE.
- `OutboundAttentionAdapter` (`NewCallObserverPort`): same for supplier calls, with `parent_call_id`; a failing one
  bumps the parent's `failing_children`.
- `DbAttentionAdapter` (`DbSummaryChangedPort`): failed / swallowed statement counts.
- A retained-ids adapter for triage (cycle-held ids).
ArchUnit: `triage` isolated from every slice; new rule added.

### 3.4 Not changed

How calls and statements are captured, the proxies, the export formats.

## 4. MCP server changes

- **`triage`** (new tool). Input: `cycle` (id or name) **or** a live scope (`project`, `from`/`to`, `direction`, default
  last 60 minutes), plus `minStatus` (default 300), `includeOptions` (false), `limit` per group, `mask`.
  Flow (cycle): cycle call ids (already loaded by `listCycleCalls`) -> one `/triage/calls` (priorities, relations,
  soft errors - all saved) -> one `/db-capture/failures` for the calls with failed statements (the evidence) -> group,
  sort, resolve call chains to project files (`resolveFrames`). No body is read; two requests whatever the cycle size.
  Flow (live): one `/triage/live` for the window, then the same `/db-capture/failures`.
  Output: groups 1-6 (6 = every remaining call, compact, signals first), each entry `#n` (cycle) or id, method, URL, status, and its evidence; totals per group;
  `nextOffset` per group when cut to the reply budget.
- **`get_cycle`**: a first line "Needs attention: 1: #15 (2 supplier calls) · 2: ... · 4: #15 ..." from the same
  computation (only the numbers; `triage` has the evidence).
- **`get_call`**: `dbFailures` (the failed statements, from `/db-capture/failures`) instead of reading all statements.
- **`db_statements failedOnly`**: served by `/db-capture/failures` (no full read).
- `get_cycle` flags (✖ error inside 200, ∅ empty result) come from the saved rows instead of reading bodies.
- **`search_calls` / `search_cycle`**: `needsAttention: true` (>= `minStatus`, error, or error inside a 200) and
  `dbFailed: true` (has a failed statement), both answered from the saved rows. `failed: true` keeps meaning
  >= 400.
- **Prompts** `debug_cycle` / `debug_call`: step 1 becomes `triage`; a later step says to read the related group-6 calls
  (successful calls, starting with those just before a failure) - the priorities order the work, they do not exclude.
- Fake Alfred: the new endpoints, with the real shapes.

## 5. UI (approved - see triage-mock.html)

- The ◆ DB chip on a call whose status is under 300 but which has a failed statement turns red:
  `✖ DB 1 failed · swallowed`, with a tooltip naming the statement (#42, table, message).
- Filters menu: "Has DB failures" and "Needs attention" - from the saved rows (`/triage/calls` for the loaded page).
- Optional: the same red mark on waterfall rows.

## 6. Tests

- backend-db-capture: failed column set at insert, back-fill of old rows, `ix_statements_failed` used (`EXPLAIN QUERY
  PLAN`), failures for many calls, 500-id limit -> 400, `DbSummaryChangedPort` called per batch and on completion.
- backend-triage: priority for every group and both `minStatus` values; **arrival in any order** gives the same row
  (child before parent, DB batch after response, child completing late); retention keeps cycle-held ids; back-fill;
  the three endpoints (`@WebMvcTest`, limits); every index used (`EXPLAIN QUERY PLAN`); Java soft-failure on the
  shared vectors (the frontend spec runs the same file).
- triagebridge: the three adapters wired end to end (Spring test with in-memory SQLite).
- ArchUnit: triage isolation rule.
- mcp-server: `triage` ordering, "listed once", exactly two requests for a cycle (fake's log), live scope, `get_cycle`
  attention line, `get_call` dbFailures, search filters, reply budget paging.
- Frontend: chip spec, filter spec, soft-failure vectors spec.
- Live check: `triage` on "Session 2026-10-05 – user flow" (#15 with #16's 322 and #42, #2's 401, #1's 307) and on
  call 500d0cdc (priority 4); a fresh call through the reverse proxy shows its row within the same second; full
  backend `mvn test`, frontend `npm test` + build, MCP `npm test`.

## 7. Docs

docs/mcp.md (triage, filters, attention line), docs/db-capture.md (failed index and the two endpoints),
docs/architecture.md if the port defaults need a line, CLAUDE.md pointer unchanged.

## 8. Order of work

1. db-capture failed column, index, port, endpoint + tests -> 2. backend-triage slice + soft-failure port + vectors +
tests -> 3. triagebridge + back-fill + gateway + ArchUnit -> 4. rebuild, check live (rows appear as calls arrive) ->
5. MCP triage, attention line, filters, prompts + tests -> 6. UI -> 7. full suites, live check, docs, commit.
