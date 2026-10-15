# 018 - Requirement evidence: implementation plan

Status: **IMPLEMENTED 2026-10-15**. Inputs: `alfred-missing-feature-detection-report.md` (2026-10-14, task 61813,
cycle `decc8783`), [impact.md](impact.md), [mock-requirements.html](mock-requirements.html).

Changes made while building (they override the text below):
- **Five check kinds, not four.** A plain shape check could not tell "the request cannot carry it" from "the user
  chose something else" (one branch picked would have made "All Branches" MISSING). So: `REQUEST_SHAPE` (list |
  scalar | present - what the request must be able to carry, absent allowed) and a new `REQUEST_WHEN` (none | one |
  list | list>=2 | present - which calls exercise the item; others are not counted).
- **The card is created with no call in its text**, then the call is linked: `BoardService` refuses a Claude card
  that shares a call with a card closed as Fine (61813's #39 shares two search calls), which would have hidden the
  missing feature. The check's own rule replaces it: an item whose card was closed Fine / Not in this flow is never
  carded again.
- **A carded item that becomes MET**: one comment per card per run; a proposal (Verified / Done) only when every item
  of the card is met and the card is Fixed / Verified (Claude may not propose from the Inbox).
- **Small-id flow anchors** (asked for after the plan): `branchId: 948` and `agencyIds: [949]` link under their own
  name, compared only across calls, never two requests of one endpoint, never a list row - flows without the noise.
- The Task tab's evidence editor takes one check per line (`shape $.branch* list`, `when …`, `match … in …`,
  `rows …`, `status …`), not a form.

## 1. Goal and done criteria

Every Acceptance item of a cycle is checked against the calls **in code, automatically, as calls complete** - no model,
no spacers, no approval in the way. When the calls show an item is not built, a card says so at once.

Done when, replaying cycle `decc8783` (5 searches, all `{"branchId":948,"agencyIds":[949,10646],...}`, `total:0`):

| Items | Verdict | Card |
|---|---|---|
| AC5, AC6, AC7, AC9, AC10 | MISSING (call #1: `branchId` is one number; a list or none is needed) | one TASK `Missing feature: branch list / All Branches`, linked to all five items, calls #1-#5 linked |
| AC3, AC8 | NO_DATA (request fine, `total: 0`) | none; Task tab says what data is needed |
| AC2 | NOT_EXERCISED (no search without `agencyIds`) | none during listen; TASK at finish (as today) |
| AC1, AC4 | MANUAL | none; checked from frontend code when the repo has it |
| AC11-AC14 | per their evidence | - |

and all existing suites pass unchanged except the additions listed in §9.

## 2. Non-goals / fixed decisions

- No new `Flag`, no new `Actor`, no new `CardKind` (older Alfreds throw on unknown enum values - impact §4).
- `groupKey` unchanged; batch wait (3 s quiet) and late-line rechecks unchanged (impact §1, §2).
- Spacers are never read for judging, batching or steps (owner's decision).
- Evidence needs no approval; the user's edit wins over Claude's.
- Claude's board limits unchanged: the requirement check opens cards as CLAUDE (Inbox), never closes, marks or moves
  beyond what Claude may.
- Card re-test plans keep their five expectation kinds.

## 3. Model

### 3.1 ItemEvidence (new, `backend-board/domain/model/ItemEvidence.java`)

```java
record ItemEvidence(String cycleId, String fileName, String itemKey, String project,
                    String endpoint,              // "POST /odeysysadmin/{x}/refunded-requests/search" pattern, or "UI"
                    List<Check> checks,           // ≤ 10
                    String howTo,                 // ≤ 300 chars: what to do in the app
                    Actor updatedBy, Instant updatedAt)
record Check(Kind kind, String path, String shape, String rows, String field, Integer min, String range)
enum Kind { REQUEST_SHAPE, ROWS_MATCH_FILTER, ROWS_PRESENT, STATUS }
```

- `REQUEST_SHAPE` - `path` = request JSON path with an optional trailing `*` on the last key (`$.branch*`); `shape` ∈
  `list` | `list>=2` | `none` (absent, null, `[]`, `""`, `"ALL"`/`"all"`/`-1`) | `present` | `one` (a single value, not a list).
- `ROWS_MATCH_FILTER` - `rows` (`$.payload`), `field` (row key, `*` allowed), `path` (request filter path): every row's
  field value ∈ the request filter's value(s). Skipped (passes) when the filter is `none`.
- `ROWS_PRESENT` - `rows`, `min` (default 1).
- `STATUS` - `range` as in `Expectation` (`2xx`, `!5xx`).
- Validation in `Check.problem()`, like `Expectation.problem()`.
- **Wildcard rule**: `branch*` must resolve to **exactly one** key of the object; zero or several → the check is
  UNKNOWN for that call (never MISSING). `branchId` and `branchIds` both present → UNKNOWN, named in the reason.
- `endpoint` matched with triage's normalizer (`NormalizeEndpointUseCase`) - the same signature a card's call has.

### 3.2 Verdicts (new `ItemVerdict` record, computed, stored)

Per call to the item's endpoint (`CallResult`: per check PASS / FAIL / UNKNOWN + the value seen):

| Call result | Rule |
|---|---|
| CONTRADICTS | any REQUEST_SHAPE FAIL |
| WRONG | shapes PASS, a ROWS_MATCH_FILTER or STATUS FAIL |
| NO_DATA | shapes PASS, ROWS_PRESENT FAIL, nothing else failed |
| MEETS | every check PASS |
| UNKNOWN | any UNKNOWN and nothing failed |

Item verdict over **the calls since the newest of: the cycle's start, the project's last app start (`app_starts`, the
same "new build" signal re-tests use), the fix of a card linked to the item** - so a redeploy starts the item fresh and
old-code calls stop counting:

`MISSING` if any call CONTRADICTS · else `WRONG` if any WRONG · else `MET` if any MEETS · else `NO_DATA` if any NO_DATA ·
else `UNKNOWN` if any UNKNOWN · else `NOT_EXERCISED`. `endpoint = UI` → `MANUAL`. No evidence → `NO_EVIDENCE`.

Kept per item with the deciding call id, the failing check text ("`$.branch*` is a list - sent `branchId: 948`") and
`judgedAt`. The user's checklist mark still wins on the Task tab; verdict and mark are shown side by side.

### 3.3 Cards the check opens

- On an item's first MISSING or WRONG, with no **open** card linked to it (`card_spec_items`): find the other items of
  the same cycle that are MISSING on **the same request path** in the same call → one card for all of them.
  - TASK for MISSING, BUG for WRONG; author CLAUDE; status INBOX; teams Backend + Frontend for MISSING (the request
    shape is the browser's, the endpoint is the backend's), Backend for WRONG.
  - Title `Missing feature: <shortest item text>` (+ `and N more`); `Wrong result: <item>` for WRONG.
  - Description in the board's card shape: summary, facts (`branchId: 948 (a number) · 5 items · call #1`), Evidence
    (the call mention, the request field as ```json, each item's text with its `@[spec:…]`), Next.
  - First comment: "Opened by Alfred's requirement check (no model): …" with `waitingOn` USER.
  - Linked to each item (`card_spec_items`); the call linked; later calls of the same verdict are linked, never a new card.
- Refused by the board as a repeat of a card closed Fine / Not in this flow → no card; the verdict stays and shows
  "dismissed by you (#N)". Never retried.
- An item that becomes MET while its card is open → one state comment with the call, and a proposal CLOSED (Fixed) -
  the user accepts. Never closed in code.
- At most 10 cards per cycle per hour from the check (a safety stop against a wrong evidence plan); over → one NOTE
  "Requirement check paused: too many missing items - check the evidence".

## 4. Backend (`backend-board` + `backend-app/boardbridge`)

### 4.1 Storage - `SqliteBoardRepository` (+ `BoardStorePort`)

```sql
CREATE TABLE IF NOT EXISTS item_evidence (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
  project TEXT NOT NULL, endpoint TEXT NOT NULL, evidence_json TEXT NOT NULL, updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (cycle_id, file_name, item_key));
CREATE INDEX IF NOT EXISTS item_evidence_endpoint ON item_evidence(project, endpoint);
CREATE TABLE IF NOT EXISTS item_verdicts (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
  verdict TEXT NOT NULL, call_id TEXT, reason TEXT, calls_json TEXT NOT NULL, card_id TEXT, since INTEGER,
  judged_at INTEGER NOT NULL, PRIMARY KEY (cycle_id, file_name, item_key));
```

- `evidence_json` / `calls_json` read with Jackson inside try → bad JSON = no evidence / no verdict (never a crash).
  `verdict` read with a tolerant parse (unknown → `UNKNOWN`) so a future value never breaks a list.
- Cycle deleted → rows removed (`BoardCycleRemovedAdapter`, as checklist marks are).
- Item text edited → new key → old rows orphaned exactly like marks today; listen re-drafts evidence for items without.
- Board export/import: unchanged (cycle data is not in the board export; impact §6).

### 4.2 Ports

- `CallFactsPort.requestFacts(callId, cycleId, Set<String> requestPaths, Set<RowsSpec> rows)` → `RequestFacts`
  (request values and key names at the paths - the matching keys for a `*`, row count, row field values ≤ 500 rows).
  `BoardCallFactsAdapter` reads the stored body once, parses once, extracts only these; nothing is kept.
- `CycleCallsPort` unchanged (`calls(cycleId, limit)` gives the endpoint signature and time).

### 4.3 `RequirementService` (new) - implements `RequirementUseCase`, `RequirementWatchUseCase`

- `evidence(cycleId)`, `putEvidence(actor, cycleId, fileName, itemKey, ItemEvidence)` - Claude refused when the item
  has a user mark or the evidence was last written by the user; validation via `Check.problem()`; clears the endpoint
  cache; re-judges the item now.
- `verdicts(cycleId)` - every item of every spec file of the cycle (via `AcceptanceItems`), its evidence and verdict
  (MANUAL / NO_EVIDENCE included), plus counts.
- `callArrived(project, endpoint)` - from `BoardRetestWatchAdapter` (one extra line). On its own single-thread executor
  (not the re-test one, so a slow body read never delays re-test chips): cache lookup `project|endpoint → items`
  (rebuilt on evidence write; empty map = fast path); for each matching cycle, read its calls (`CycleCallsPort`,
  ≤ 5000), judge the calls not judged yet, update the verdict, open / link / propose per §3.3, notify (`/ws/board`,
  kind `requirements`). Re-signalled after 20 s like re-tests, so a call not yet in the cycle is caught.
- `judgeAll(cycleId)` - the same over the whole cycle (after `putEvidence`, and on demand).
- Card writes go through the existing `BoardUseCase` add/link/comment/propose paths with Actor CLAUDE, so every Claude
  limit and the closed-reasons refusal apply unchanged.
- ArchUnit: lives in `backend-board/application/service`, uses only its own ports - no new cross-slice dependency.

### 4.4 REST (`RequirementController`, under `/board` - no gateway / `SpaPageFilter` change)

| Method | Path | Body / result |
|---|---|---|
| GET | `/board/cycles/{cycleId}/evidence` | every item's evidence |
| PUT | `/board/cycles/{cycleId}/evidence/{fileName}/{itemKey}` | `ItemEvidence` (actor from `X-Alfred-Actor`) |
| DELETE | same | user only |
| GET | `/board/cycles/{cycleId}/requirements` | verdicts + counts |
| POST | `/board/cycles/{cycleId}/requirements/judge` | re-judge the cycle now |

Writes follow the board edit rule (`BoardEditAccessInterceptor`) like every board write.

### 4.5 Fix → re-judge

`board_fix` on a card linked to items → those items' window restarts at the fix time (`since`); `board_verify`'s result
gains `task: {counts, items:[{key, before, after, call}]}`.

## 5. MCP server (`mcp-server`)

- `tools/board.ts`: `board_evidence_put` (Claude drafts; several items in one call), `board_requirements` (verdicts,
  counts, each with its call mention). Descriptions carry the 61813 example.
- `tools/task.ts` (`task_context`): REQUIREMENTS lines show the verdict beside the mark:
  `· MISSING (#41) [key] The Branch dropdown keeps several branches… - $.branch* is a list, sent branchId: 948`; counts
  line `5 missing · 0 wrong · 0 met · 2 no data · 1 not exercised · 2 manual · 4 no evidence`.
- `board_verify`: passes the `task` section through.
- `tools/check.ts`: each group gets `shape` (hash of the example request's field names + list/object/value; null
  matches anything; `null` when the body is not read yet). Computed in `sidesOf` from the body already parsed; kept in
  `CycleMemory.shapes` (survives an index drop). `groupKey` untouched.
- `check.ts` batch text: calls inside a batch are split into **action sections**: a new section when the gap since the
  previous call's end ≥ `clamp(4 × median intra-burst gap, 250 ms, 3 s)` (median over the cycle so far; 3 s until 10
  calls) or the inbound area changes (`areaOf`). Shown as `── action 2 · 0.9 s pause ──`; JSON
  `sections:[{from,to,reason}]`. Text only - no change to which calls are in the batch.

## 6. Listen runner (`skills/alfred-listen/alfred-listen.mjs`)

- Ledger `fine` entries store `shape`; `splitKnown`: a known `fine` group whose `shape` is non-null and differs →
  unknown (judged once, the new shape stored).
- Pack: new `requirements` part (from `board_requirements`); the SPACERS part is removed; the steps line shows the
  items each step names.
- Live strip: `requirements 5 missing · 2 no data · 1 not exercised · 2 manual`.
- Start: items with `NO_EVIDENCE` → one model run (new `evidence.md` system prompt) drafts them with
  `board_evidence_put`, before the first batch. Failure → said in the chat, listening continues.
- 0-commit: at start, only when `git rev-parse --abbrev-ref HEAD` equals the branch the brief names and `diffStat`
  says no change → one TASK `Task branch has no changes since <base>` (`board_similar` first) and a strip warning.
  Once per cycle (stored in state).
- `stop --now`: writes `board_session_log` in code: calls checked, cards, requirement counts, the STATE text.
- Steps: a step naming items (`→ AC6`) is SEEN when its items have a MEETS / NO_DATA call, FAILED when one is MISSING /
  WRONG; other steps grouped by the action sections. The judge marks; the runner supplies the data.

## 7. Skills (prompts)

| File | Change |
|---|---|
| `_shared/rules.md` §0 | "Checking the task against what was asked": verdicts come from the calls (`board_requirements`); code is a hint that names the file; never "fine" because "old code" |
| `_shared/rules.md` §4 | `Missing feature: …` / `Wrong result: …` cards come from the requirement check - link to them, never open a second; a "Requirement status" paragraph (verdict meanings) |
| `_shared/rules.md` §4 head | steps by items and action sections, not spacers |
| `alfred-setup`, `alfred-spec` | draft evidence for every item with the spec and save it (`board_evidence_put`); test steps name items (`→ AC6`) |
| `alfred-listen/SKILL.md` | drop "Steps need spacers. Ask once…" |
| `alfred-listen/batch.md` | step 1b: the REQUIREMENTS block - explain WRONG / UNKNOWN items from the code; ledger: a group whose call misses an item is never `fine`; step 4 rules |
| `alfred-listen/finish-steps.md` | step 3 reads verdicts: NOT_EXERCISED → TASK; MANUAL → check the frontend code (`MET by code` / `MISSING in code` as a suggestion with evidence), else `board_ask` |
| `alfred-listen/evidence.md` (new) | drafting evidence: shapes, wildcards, one endpoint per item, `UI` for pure UI |
| `alfred-review/SKILL.md` | same verdicts; steps by items |
| `alfred-verify/SKILL.md` | Task section; "nothing of task X was fixed" said plainly |
| `alfred-status`, `alfred-report` | requirement counts per task, MISSING first |

## 8. Frontend (Task tab)

- `board.models.ts`: `ItemEvidence`, `ItemVerdict`, `RequirementsView`.
- `board-api.service.ts`: the five calls.
- `acceptance-checklist.component.ts`: verdict pill (Missing red, Wrong orange, Met green, No data amber, Not exercised
  grey dashed, Manual blue, No evidence grey), the deciding call, the failing check line, the card; counts at the top;
  refresh on the `/ws/board` `requirements` signal (no polling). Styles in `styles.scss` (board section, existing tokens).
- `item-evidence-editor` (new component): inline under the item - endpoint, checks, how-to; row layout like
  `card-retest`, not shared (kinds differ).
- Card re-test editor untouched.

## 9. Tests (each phase ends green)

**Phase 1 - backend + MCP**
- `CheckTest`: every kind's `problem()`; wildcard one / none / several; `none` values.
- `ItemVerdictTest`: the call-result table, the item rule, the new-build / fix window.
- `RequirementServiceTest`: 61813 replay (§1 table; one card for AC5/6/7/9/10; calls linked; no duplicate on call #5);
  closed-as-Fine refusal respected; MET → proposal; 10/hour stop; Claude refused on a user-marked item; late call caught
  on the re-signal; cache cleared on put.
- `BoardCallFactsAdapterTest`: request paths, `*` keys, rows ≤ 500, missing body.
- `RequirementControllerTest`; repository round trip; tolerant enum / JSON read.
- mcp-server: `board-work.test.ts` (new tools on `fake-alfred.ts`), `check.test.ts` (`shape` same / different / null;
  action sections for ms-apart and s-apart calls; area change), task-context test.
- Commands: `mvn -B -pl backend-board,backend-app -am test` (Docker JDK 21); `cd mcp-server && npm test`.

**Phase 2 - runner**: `listen-runner.test.ts` - shape change re-judges a `fine | recurs` group once; SPACERS gone;
REQUIREMENTS present; evidence-drafting run; 0-commit TASK once and only on the brief's branch; `--now` session log.

**Phase 3 - skills**: `python -m pytest tests/python/test_alfred_skill.py`.

**Phase 4 - frontend**: `acceptance-checklist` and `item-evidence-editor` specs;
`npx ng test --watch=false --browsers=ChromeHeadless --include=...`.

**Phase 5 - full**: `mvn test` (all modules, ArchUnit), `npm test && npm run build`, mcp-server tests, python tests.

## 10. Order, checkpoints, rollback

| Phase | Deliverable | Checkpoint | Est. |
|---|---|---|---|
| 1 | §3-§5 | targeted tests green; replay 61813 on the Docker Alfred (`alfred-docker`) gives the §1 table and one card | 2.5-3 h |
| 2 | §6 | runner tests green; a dry listen on 61813 shows the strip counts | 1-1.5 h |
| 3 | §7 | skill test green | 45 min |
| 4 | §8 | specs green; screenshot of the Task tab on 61813 | 1 h |
| 5 | docs (`docs/board.md` "Requirements", `docs/mcp.md`, one `CLAUDE.md` rule line), full suites | all green | 1 h |

- One commit per phase (only when asked), never mixed with the uncommitted snippet work already in the tree
  (`snippet-host.component.ts`, `snippet-frame.ts`, `styles.scss` - staged by path; the Task tab styles go in a
  separate hunk of `styles.scss`, so ask before committing that file).
- Rollback: every phase is additive (new tables, tools, service). No evidence rows → no verdicts, nothing opened; the
  runner treats a missing `board_requirements` tool as "no requirements".
- A usage-limit stop between phases leaves a working tree; inside a phase, the checkpoint says what is left.
- The 61813 replay writes a real card on the Docker Alfred's board: asked before it runs (or run with a throwaway cycle).

## 11. Risks kept (after impact.md)

| Risk | Guard |
|---|---|
| Wrong evidence opens false cards | exact-one wildcard → UNKNOWN; Inbox; card shows the failing check; Fine closes teach; 10/hour stop |
| Old-code calls keep an item MISSING after the deploy | verdict window starts at the last app start / the fix |
| Body reads slow the board | only matching calls, paths only, ≤ 500 rows; own executor, never the webhook or re-test thread |
| Item text edit orphans evidence | same as marks today; listen re-drafts missing evidence |
| A call not yet in the cycle | 20 s re-signal; judged from the cycle's calls |
| Spacer users lose step grouping | owner's decision; action sections replace it |
