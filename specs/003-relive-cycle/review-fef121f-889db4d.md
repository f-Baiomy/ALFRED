# Deep review: Relive Cycle and related work, `fef121f` → `889db4d`

- **Range:** `fef121fc05cf97cdb77b75a960476350a493d361` (docs: spec, plan, mock and tasks) up to
  `889db4d13c8aed76b7278728ebe0768341c13348` (hold the loading skeleton). That is 82 commits and 379 files,
  with +33,700 / −1,067 lines.
- **Reviewed against:** `specs/003-relive-cycle/spec.md` (FR-001 to FR-051, SC-001 to SC-011),
  `tasks.md` (T001 to T091), `CLAUDE.md` project rules.
- **Date:** 2026-10-02.
- **Method:** I read the core files in full: `proxy/relive.py`, `ReliveRunsService`, `RunSnapshotBuilder`,
  `CycleValidator`, `SqliteReliveRunStoreAdapter`, `RunLeaseRegistry`, the websocket handler,
  `relive-run.service.ts` and `relive-cycle.component.ts`. I also read the proxy, backend and frontend diffs
  around them. The bugs marked **[REPRODUCED]** were confirmed with a throwaway script against the real proxy
  code; nothing was changed in the repository. `proxy/test_relive.py` passes (52 tests). The backend and
  frontend suites were not run for this review.

Severity scale:
- **CRITICAL:** breaks the safety promise (a REPLAY call reaches a real supplier) or makes a main flow unusable.
- **HIGH:** wrong result in a normal flow.
- **MEDIUM:** wrong result in a less common flow, or a large performance cost.
- **LOW:** polish, edge cases, conventions.

---

## 1. Executive summary

The structure is close to the spec: a backend slice, a proxy module, the call-rule model, the rule editor
reused through `RULE_EDITOR_TARGET`, and the tiered engine. Most of T001–T090 has code behind it. The
problems sit at the joins between proxy, backend and browser. Many tasks are ticked `[X]` while the code
behind them is a stub, never called, or only covers the happy path. Section 4 lists each one.

The most important problems:

| # | Problem | Severity | Section |
|---|---|---|---|
| 1 | Parallel supplier calls of one inbound step are blocked as "unexpected" (502) while a sibling is in flight **[REPRODUCED]** | CRITICAL | B1 |
| 2 | Guided runs: every supplier call is blocked as "claimed by more than one run" (502) **[REPRODUCED]** | CRITICAL | B2 |
| 3 | In the first second of a run, a REPLAY child can be forwarded to the real supplier **[REPRODUCED]** | CRITICAL | B3 |
| 4 | Finished runs become INTERRUPTED 15 s after the tab closes or the socket reconnects. "Continue with the rest" returns 409 in the same tab | CRITICAL | B4 |
| 5 | "Run from here" re-sends every earlier step, because `fromStepKey` is never persisted | HIGH | B5 |
| 6 | A child "pause before" checkpoint is treated as a "request differs" hold. On timeout it becomes a 502 instead of continuing | HIGH | B6 |
| 7 | "Relive now": "Save as cycle" does not exist, and Save never clears `transient`, so the cycle is always deleted when the run ends | HIGH | B7 |
| 8 | A project with logging turned off makes every REPLAY child of its runs fail with a 502 | HIGH | B8 |
| 9 | Differences are one whole-body row. There are no per-field differences, no expected/noise labels, and no "Ignore this field" | HIGH (spec gap) | §4 |
| 10 | Run writes rewrite the whole cycle definition, with every recorded body, on every step result, variable or log entry | HIGH (perf) | P1 |
| 11 | The newest commit (`889db4d`) writes a signal inside `effect()` without `allowSignalWrites` on Angular 18.2, which throws NG0600 | MEDIUM | B20 |

---

## 2. What was implemented (commit inventory)

### 2.1 Relive Cycle, by phase (tasks.md)

| Phase | Commits | What landed |
|---|---|---|
| 1 Setup (T001–T006) | `526ecbd` | `backend-relive` module, gateway prefix `relive-cycles`, `/relive` routes and nav, `_relive.scss`, `relive-types.ts` |
| 2 Foundation (T007–T021) | `9b4bb0f`, `43ce00c`, `c274f71`, `e3a1db1`, `3430958`, `0335da0` | Domain records, SQLite store (cycles, versions, runs, step results, live calls), CRUD service plus validation on save, REST controller, `/ws/relive`, interception bridges, ArchUnit isolation, frontend API/socket/state, `relive-call-rule.ts`, `relive-external-reach.ts` |
| 3 US1 build (T022–T028) | `33e7761` … `d20d028` | `freezeCalls`, list page, cycle page plus editor state, step tree (drag, modes, badges, search, fold), add-calls dialog, step drawer, reset and duplicate |
| 4 US2 LIVE/REPLAY (T029–T045) | `279a882` … `3d3868f` | `proxy/relive.py` (attribution, tiers, unexpected, STOPPING), `MATCHES_RECORDED_CALL` condition, `RunSnapshotBuilder`, `FileRunSnapshotPublisher`, call-rule section, request-differs dialog, external-reach notice, inbound switch, unexpected-calls section, pre-run dialog, `CycleValidator` |
| 5 US3 run (T046–T056) | `2eb4930` … `200d453` | Run use cases, `RunLeaseRegistry`, runs controller, resend carries `X-Alfred-Relive`, call observers plus `inflight.json`, call-card badge, outcome rules, Automatic orchestrator, holds, resume, timeline, unexpected list |
| 6 US3b checkpoints (T057–T058) | `05eb027` | Inbound-step pauses in the browser tab. Child pauses rely on the existing breakpoints (see B6, B9) |
| 7 US4 differences (T059–T063) | `97f184f`, `65c9895`, `72a37b6`, `6d96e05`, `c9c7433`, `0939e7d` | `relive-noise.ts`, run-mode drawer tabs, Compare tab (reuses `InterceptionPanelComponent`), masking |
| 8 US5 variables (T064–T066) | `9db4543`, `273ac37`, `a2fc093`, `51caafe` | Variables tab, extract and assert tab, unresolved blocking, then run-scoped `{{$.name}}` variables and the proxy RELIVE scope |
| 9 US6 rules (T067–T068) | `35acf06`, `5da1ee1`, `8c716c8` | Rules tab (copy global, participation mode, overlap warning), per-tier rule ids from the proxy |
| 10 US6b rebuild (T069–T071) | `5417fdb`, `349faf8`, `5f0c4ce` | `pairSteps`, Rebuild dialog, "Relive ▾" menu |
| 11 US7 history (T072–T074) | `de3882f`, `2f0e5eb`, `0bc4908` | History tab, run compare, Live calls log (backend plus frontend), Mock with it, Resend, Export |
| 12 US8 (T075–T077) | `639c2e2`, `91ffcbe`, `4fbb22e` | Run from here, optional steps, Guided driver (partial), `GUIDED_PROJECT_BUSY` |
| 13 Polish (T078–T081) | `4975e90`, `9293a74`, `0345a77`, `d931eda` | `docs/relive.md`, run export with no-truncation guard, performance specs, production build fixes |
| 14/15 Convergence (T083–T090) | `f7c64a8`, `5ff1ffb`, `ecf9f42` | Mock-faithful styling, New-cycle flow, session-cycle source, detail hydration, picker return path |

### 2.2 Fixes and features after the task list

| Commit | What it does | Review note |
|---|---|---|
| `52b60fd` fix: replay supplier children from recording | Matches children on URL, method, stable headers and canonical JSON/SOAP body; Python-safe regex quoting | Stronger matching than the spec's "endpoint + order". It causes B10 |
| `e8ae13c` fix: allow saving a live call rule | Validation accepted an empty IF branch | OK |
| `9d14054` fix: keep following a live run | Reattach after reload settles a step from the logged call | Adds a 400 ms polling loop with no end (B14) |
| `6bc0921` perf: omit snapshot bodies from lists | Interception bodies leave the list payload | Good |
| `e8bce73` fix(internal-calls): stop caching raw log lines | Halves the heap of the inbound file store | Good; see the note on `deleteByReliveRunIds` (P7) |
| `9221814` fix: keep a hold visible | Pins the hold decision in the timeline | OK |
| `c7e2666` fix: replay a child again after retry | Ordinal epoch per in-flight call id | OK, but see B1 (inflight entries of outbound children) |
| `1d569e7` chore: disable the Angular CLI disk cache | Stops the disk filling up | Slower incremental builds; a cache cleanup would be a better fix |
| `42b1ff5` fix: whole-body mismatch is a difference | A JSON check with no path becomes a difference, gzip is inflated, long reasons open a popup | Turns all differences into one row (§4, FR-040/041) |
| `efca3ff` feat: fingerprint recorded requests | `SEMANTIC_V1` SHA-256 (Java plus Python), per-step `fingerprintIndex`, stamping and rebuild UI | Not in the spec. Stable headers are part of the hash, which causes B10 |
| `5467829` feat: bulk stop and history delete with call cleanup | Multi-select in History, stop selected or all, delete runs with or without their logged calls, tombstone journal for the inbound file store | See B16, P7 |
| `91c2a9d` chore: butler logo and favicon | Header badge and favicon | OK |
| `7c5d474`, `889db4d` skeleton loading cards | Five shimmer rows in Live Calls while the first page loads, held 700 ms | B20, B21 |
| `9ff3428` chore(spec-kit): Codex integration | Adds `.agents/skills/*`, deletes `update-agent-context.ps1` (513 lines) | Tooling only; check that nothing still calls the deleted script |

---

## 3. Bugs

Each bug has: **where**, **what happens**, **why**, and **fix**.

### CRITICAL

#### B1. Parallel supplier calls are blocked while a sibling is in flight [REPRODUCED]
- **Where:** `ReliveRunsService.onOutboundCallPrepared` (`backend-relive/.../ReliveRunsService.java:458`) adds an
  in-flight entry for every **outbound** call. `proxy/relive.py` `_inflight_entries` / `_deepest_inflight_entry`
  (`relive.py:384-423`) then treats that entry as the owner of the next call.
- **What happens:** Search calls Supplier A, B and C in parallel (the spec's own example). A's `prepare`
  webhook adds `{stepKey: c-a}` to `inflight.json`. When B arrives, the deepest in-flight entry is `c-a`, the
  child itself. `match_child(c-a)` has no candidates, so B goes to `_handle_unexpected` and gets
  `502 Blocked by ALFRED Relive`. With two siblings in flight, both are leaves, so the result is
  `AMBIGUOUS` (also a 502). Probe output: `SIBLING CASE -> 502 {"error": "Blocked by ALFRED Relive"} {'attribution': 'UNEXPECTED'}`.
- **Why:** `inflight.json` was meant to hold *inbound* executions (contracts/proxy-snapshot.md). Outbound
  children were added to the same list, and the "deepest" rule cannot tell them apart.
- **Fix:** Only inbound calls create in-flight entries. Either remove `addInflightEntry` from
  `onOutboundCallPrepared` / `onOutboundCallCompleted`, or tag entries with `direction` and make the proxy
  ignore outbound ones in `_deepest_inflight_entry`. Add a test with two concurrent siblings.

#### B2. Guided runs block every supplier call [REPRODUCED]
- **Where:** `relive.py:1217-1220` returns `stepKey: None` for a Guided inbound call.
  `onInboundCallPrepared` stores `{runId, stepKey: null}`. `_deepest_inflight_entry` (`relive.py:413-423`)
  skips keys that are `None`, so it finds no leaf and returns `None`, and `attribute()` returns `AMBIGUOUS`.
- **What happens:** In a Guided run, every outbound call the application makes is answered
  `502 claimed by more than one run`. It is also logged as `AMBIGUOUS_BLOCKED` in the run. REPLAY never works
  in Guided mode.
- **Why:** The Guided path was tested only at the inbound step
  (`test_guided_run_claims_untagged_inbound_call_for_its_sole_project`). No test sends a supplier call during
  a Guided run.
- **Fix:** In Guided mode, match the inbound call to the expected step **in the proxy**. The next step not yet
  run, matched by endpoint, gives a real `stepKey` and lets the inbound call rule apply (see B11). Failing
  that, treat a single entry with no `stepKey` as "whole run" and match against all children of not-yet-run
  steps. Add the missing outbound-in-Guided test.

#### B3. REPLAY child forwarded to the real supplier in the first second of a run [REPRODUCED]
- **Where:** `ReliveRuns.refresh` (`relive.py:92-97`). Run files are re-listed at most once per second;
  `inflight.json` is re-read on every call.
- **What happens:** An unrelated call lists `relive/` at time t. A run is published and its first inbound step
  is sent at t+0.2 s, and the app calls its supplier at t+0.4 s. `inflight.json` already names the run, but
  `active_runs()` does not contain it yet. So `with_run` is empty, `_handle_unattributed` finds no run, and the
  verdict is `None`: **the call goes to the real supplier**. Probe output: `START WINDOW -> None None`.
- **Why:** Throttling run files and not throttling inflight data is inconsistent. The code never checks
  "inflight names a run I don't know about".
- **Fix:** In `attribute()` (and `apply_inbound`), when the header's runId or any inflight `runId` is not in
  `active`, call `runs.refresh(force=True)` once and look again. A cheaper alternative: write a "generation"
  counter into `inflight.json` that the backend bumps on every publish, and force a run-file refresh when it
  changes.

#### B4. Leases are never released: finished runs become INTERRUPTED, and resume returns 409
- **Where:** `ReliveSocketService.releaseLease` (frontend) sends nothing the backend understands.
  `ReliveEventsWebSocketHandler.handleTextMessage` (`ReliveEventsWebSocketHandler.java:49-61`) only handles
  `type: "lease"`. `RunLeaseRegistry.onSessionClosed` (`RunLeaseRegistry.java:58-70`) then calls
  `ReliveRunsService.interrupt()`, which calls `finalizeRun()` **with no status check**
  (`ReliveRunsService.java:308-310, 399-413`).
- **What happens:**
  1. A run finishes (COMPLETED / FAILED / STOPPED). The session still "holds" the lease. Closing the tab,
     reloading, or **any socket reconnect** closes the session. 15 s later the run is re-finalized as
     **INTERRUPTED**: `finishedAt` is overwritten, missing steps become CANCELLED, a STOPPING snapshot is
     republished, prune runs, and a transient cycle is deleted. History statuses are wrong.
  2. In the same tab, "▶ Continue with the rest" on a FAILED run calls `resume`. `leaseQuery.hasActiveLease`
     is still true, so the result is a 409 `RunLeaseHeldException`. FR-034d does not work from the page that
     ran it.
- **Fix:**
  1. Handle `{"type":"release","runId"}` in the handler, and send it from `releaseLease`.
  2. In `RunLeaseRegistry`, drop the run's holders when the run leaves RUNNING (call it from `finalizeRun`).
  3. Make `interrupt()` a no-op unless `status == RUNNING`. `finish`/`stop` on an already-final run should
     also be a no-op, or a 409.

### HIGH

#### B5. "Run from here" re-executes every earlier step
- **Where:** `SqliteReliveRunStoreAdapter` `DETAIL_ROW_MAPPER` (`SqliteReliveRunStoreAdapter.java:200-209`)
  passes `null` for `fromStepKey` and an empty list for `seedVariables`. There are no columns for them in
  `relive_runs`. `ReliveRunsService.start` returns `runStore.create(run)`, which is read back from the DB.
- **What happens:** `ReliveRunService.start()` reads `run.fromStepKey`, which is `null`, so `topIdx = 0`. Every
  step before the chosen one is sent again, including LIVE ones. FR-036 and US8 scenario 1 are broken ("steps
  1-4 are not re-sent"). Also, "Run from here" does not show the pre-run LIVE confirmation
  (`relive-cycle.component.ts:318-325` calls `launchRun` directly), so SC-003 is also violated.
- **Fix:** Add `from_step_key` and `seed_json` columns (or put both in `summary_json`) and map them. Open the
  pre-run dialog for "Run from here". Validate on the backend that `seedFromRunId` belongs to the same cycle,
  and seed only the variables produced *up to* `fromStepKey` (FR-036 says "up to that point").

#### B6. Child "pause before" is treated as "request differs"; timeout gives a 502, not "continue"
- **Where:** `relive.py:1011-1016` `_tag_changed_pause` tags **every** request-phase pause as
  `at: 'CHANGED'`. `log_and_route.py` `_decide` then turns any no-decision outcome of a `CHANGED` pause into
  the failure mock.
- **What happens:** A LIVE Supplier B with "pause before, 30 s" (US3b): when no one answers, the call is mocked
  `502 no decision on a changed request` instead of being sent (FR-035d: "continues with its configured
  mode"). A REPLAY child with pause-before also fails instead of replaying. The run view also lists it as a
  "request changed" hold.
- **Why:** The tag cannot tell the call rule's ASK branch (a `PAUSE_REQUEST` inside the `IF_REQUEST` else
  branch) apart from a plain checkpoint `PAUSE_REQUEST`.
- **Fix:** Tag only a pause that came from the `otherwise` branch of the `RECORDED_CALL` condition. For example,
  the call rule builder (`setOnRequestChanged`) can mark that pause action `{reliveAt:'CHANGED'}`, and the
  engine can carry the action's marker into `verdict.pause`. Tag checkpoints `at:'BEFORE'`/`'AFTER'` so the run
  view can show them.

#### B7. "Relive now" can never be saved
- **Where:** `ReliveCyclesService.update` keeps `existing.isTransient()` (`ReliveCyclesService.java:151, 209`).
  Nothing in the backend ever sets it to false. The frontend has no "Save as cycle" control: the transient
  banner (`relive-cycle.component.html:46-50`) has no button. `ReliveRunsService.cleanupIfTransient` deletes
  the cycle and its runs as soon as the run is finalized.
- **What happens:** The quick run cannot be kept, before or after the end (FR-003c, US6b scenario 6). The
  javadoc in `cleanupIfTransient` describes clearing the flag, but no code does it. If the user presses Save
  during the run, the cycle is still deleted at the end, and a later Save on the open page fails with 404.
- **Fix:** Add `POST /relive-cycles/{id}/keep` (or a `transient=false` field on update) and a "Save as cycle"
  button in the banner and in the finished-run header. Defer `cleanupIfTransient` until the page releases the
  lease, so "Save as cycle" is still possible after the run ends.

#### B8. Logging turned off for a project makes every REPLAY child of its runs fail
- **Where:** `log_and_route_reverse.py:190`, `if not WEBHOOK_URL or not _toggle.enabled(name)`, skips the
  `prepare` webhook. Then no in-flight entry exists, and children are unattributed and blocked (BLOCK
  default).
- **What happens:** Inbound logging for a project is turned off (a documented, live toggle). Relive runs for
  that project return 502 for every REPLAY child, and no `run-call` event arrives, so the orchestrator marks
  the children NOT_CALLED.
- **Fix:** When `relive_info` is set, always send `prepare`/`complete` (or a lighter "relive-inflight" webhook),
  whatever the logging toggle says. Or add a BLOCK validation finding "project X logging is off".

#### B9. Pause decisions cannot be made from the run view
- **Where:** `relive-run-timeline` only emits `openPausedCall`, and `ReliveCycleComponent.openPausedCallInInterception`
  (`relive-cycle.component.ts:304-306`) navigates to `/interception`. `POST /interception/paused/{id}/decision`
  is never called from Relive code. `changedPauses` only lists `at==='CHANGED'`. A child's response-phase
  "pause after" carries no `relive` tag, so it never shows in the run at all.
- **What happens:** T056/T058's pause box (countdown ring, Replay recorded answer / Edit answer & replay /
  Send to real with a second confirmation / Mock a failure / Stop) is missing. The user has to leave the run
  page. FR-035e and US2 scenario 8 ("Ask me") are not met in the run view.
- **Fix:** Build the pause box in the timeline. Decide through `InterceptionApiService.decide`. Tag
  response-phase pauses with `{runId, stepKey, at:'AFTER'}` in `relive.py` (response path) so they can be
  filtered.

#### B10. Matching on full body plus headers: same-URL suppliers (SOAP) all become "unexpected"
- **Where:** `relive.py` `match_child` / `_finish_scan` (`relive.py:785-862`). A child is chosen by an exact
  fingerprint (endpoint, stable headers and canonical body). The single same-URL fallback applies only when
  **exactly one** child has that URL.
- **What happens:** A SOAP supplier posts every operation to one URL. When the inbound request is edited
  (US2 scenario 8), or any non-noise header or body field changes (a timestamp in the SOAP header, a token
  header not on the generated list), nothing matches exactly. With two or more same-URL children,
  `endpoint_only` has more than one entry, so the result is `None`. Every call becomes an **unexpected** call
  and is blocked (502). The spec's "request differs" handling per child (FR-014d) never runs.
- **Why:** The spec's default match is endpoint + order (FR-014a). Body equality was meant for the
  `MATCHES_RECORDED_CALL` *condition* (FR-014d), not for choosing the step.
- **Fix:** Pick the child by endpoint + order (ordinal) when no fingerprint hits. Use the fingerprint only to
  break ties among same-URL siblings. Let the call rule's condition decide "differs".

#### B11. Guided runs never apply the inbound call rule or inbound pauses
- **Where:** `relive.py:1217-1220`. For Guided, `step_key` is `None`, so no rulesets apply.
- **What happens:** Inbound REPLAY mocks, inbound request edits and inbound "pause before" (FR-035f) do nothing
  in Guided runs. The rest of the Guided driver is also partial: a repeat of the same step (double-click,
  edge case) is matched to the *next* step or flagged unexpected, `pause after` is not honoured, and disabled
  steps can still be matched.
- **Fix:** As B2: match the expected step in the proxy. Keep `topIdx` on a matched step until a different
  step arrives, so a repeat is matched as a repeat attempt.

#### B12. Concurrent writes to a run lose data
- **Where:** `ReliveRunsService.recordStepResult`, `setVariable`, `hold`, `handleAmbiguousIfPresent` and
  `finalizeRun` all read the run, change it, and write the whole row back, with no lock or version check.
- **What happens:** The proxy posts a RELIVE-scope variable (B23) while the browser PUTs a step result, sets a
  hold, or the observer appends `AMBIGUOUS_BLOCKED`. The last writer wins, so variable timeline entries, log
  entries or a hold are lost. `finalizeRun` uses the `run` read before `cancelRemainingSteps` and can drop a
  variable written in between.
- **Fix:** Use per-run locks (`ConcurrentHashMap<String, Object>`), or split the columns: store
  `variables_json`, `log_json` and `hold_json` with targeted `UPDATE … SET col = json_insert(...)` statements
  instead of rewriting the whole row.

#### B13. Several ticked tasks have no working code path
| Task / FR | State |
|---|---|
| T054 / FR-044a "apply to this run too?" | `ReliveRunService.applyDefinitionEdit` exists but **nothing calls it**. There is no dialog. Edits during a run only affect the next run |
| T057 / FR-035b–c "Edit & replay", save edits to the cycle | `CheckpointDecision = 'CONTINUE' \| 'REPLAY' \| 'SKIP'`. There is no edit step. `POST …/save-edits` is never called by the frontend |
| FR-035b every attempt kept | On checkpoint Replay, the previous attempt's result is only set in memory and never PUT (`relive-run.service.ts:702-707`). History keeps a RUNNING placeholder for it. Child results always use `attempt: 1`, so a retry overwrites them |
| FR-014d "request changed" pill, three stages in Compare | `requestChanged` is always `null` (`relive-run.service.ts:943, 998`) |
| FR-035d "continued after timeout" | `pauses` is always `[]` |
| FR-034a timeout | `timedOut` is always `false` |
| FR-041b/c "Ignore this field" | Not implemented anywhere (`grep ignoreField` finds nothing) |
| T062 shared step strip (`call-step-strip`) | Not extracted; the Relive Compare has no strip |
| FR-003c "Save as cycle" | Missing (B7) |
| FR-015c bulk delete / export above the threshold | The threshold is hard-coded in the frontend; no settings endpoint |
| T082 manual end-to-end, SC-010 isolation check | Not done (unchecked) |
| T091 pre-run uses the saved definition | Partly done (`startRun` saves a dirty draft), still unchecked; the dialog still previews the draft |

### MEDIUM

#### B14. Endless polling loop, and polling against the "no polling" rule
- `ReliveRunService.waitForLoggedCall` (`relive-run.service.ts:755-766`) polls `GET /calls` every 400 ms **with
  no end condition** except `stopped`. If the call is never logged (logging off, B8; webhook down; the resend
  failed before reaching the proxy), the reattached page polls forever.
- `ReliveCycleComponent.showHistorySnapshot` uses `interval(1000)` to re-fetch a RUNNING run
  (`relive-cycle.component.ts:422-429`).
- Both break the CLAUDE.md rule "No polling anywhere - lists are fetch-on-demand, driven by a WebSocket".
- **Fix:** Drive both from `/ws/relive` `run-changed` / `run-call` events. Put a deadline (for example the step
  timeout) on the reattach wait, then settle the step as FAILED "lost after reload".

#### B15. `stop()` during an in-flight step throws
- `stop()` sets `this.eventsSub = null`. `runInboundStep` then resumes after the resend and calls
  `this.eventsSub.unsubscribe()` (`relive-run.service.ts:697`), which throws a `TypeError`. The rejected
  promise reaches `startRun`, which shows "Could not start the run". It also misses the `stopped` check before
  `settleResult`.
- **Fix:** Keep the subscription in a local variable, and check `this.stopped` right after the resend returns.

#### B16. History delete holds the inbound store's lock during a full file scan
- `InternalCallsFileLogAdapter.deleteByReliveRunIds` is `synchronized` and scans the whole log (hundreds of
  MB). `save`/`complete` share the same monitor, so every inbound webhook waits. That can mean proxy webhook
  timeouts and lost inbound calls during a delete (the failure mode CLAUDE.md warns about).
- The tombstone journal `internal-calls.log.relive-deleted` and `reliveDeletedCallIds` are never pruned when
  the ring evicts those lines. Both grow without limit until "clear all".
- The needle `"relive":{"runId":"` depends on Jackson keeping the proxy's key order. It works today, but it is
  fragile.
- **Fix:** Scan without holding the monitor (snapshot the path and size first), then take the lock only to add
  tombstones. Prune the journal at compaction: keep only ids still on disk.

#### B17. `reachedUpstream` is guessed at prepare time
- `log_and_route.py:194` and `log_and_route_reverse.py:188` set `reached_upstream = not verdict.terminal`
  before pauses are decided. An "Ask me" pause that times out (and becomes a mock), a pause the user aborts,
  or a connection that fails upstream are all still saved as **Live calls** (FR-015b), and the run shows
  "💾 saved".
- **Fix:** Send `reachedUpstream` in the `complete` webhook, after `_decide`, based on whether `flow.response`
  came from upstream. Make `maybeAddLiveCall` use only that value.

#### B18. The validator differs from the spec and from the frontend
- `LIVE_EXTERNAL` only checks for an enabled top-level `MOCK_RESPONSE`. It misses "request differs → Call
  live" (else branch `SEND_TO_HOST`), `REWRITE_URL`, and an unexpected policy of `SEND_REAL`. It also ignores
  internal hosts. FR-015a requires the same `reachesHost` analysis everywhere.
- `RULE_OVERLAP` compares cycle rules with each other only. The spec asks for GLOBAL vs CYCLE overlap (FR-017,
  FR-028, US6 scenario 4).
- `GUIDED_PROJECT_BUSY` runs only when the cycle's *default* driver is GUIDED. Choosing Guided in the pre-run
  dialog on an Automatic-default cycle skips it, so two Guided runs on one project are allowed. The proxy then
  matches neither (`len(guided) == 1` is false).
- `projectsOf` reads top-level steps only, while the snapshot's `projects` also includes children.
- `MAY_BE_UNATTRIBUTED` is cycle-wide (Guided only). FR-049a asks for a per-REPLAY-step finding.
- `DUPLICATE_STEP` checks duplicate keys, not "the same recorded call added twice" (edge case).
- `UNRESOLVED_VARIABLE` collects tokens from call rules only, not from a step's frozen URL or headers.
- **Fix:** Port `reachesHost` to Java, or have the frontend send its findings with the run. Pass the chosen
  `driver` to `validate` from `start`.

#### B19. Orchestrator data gaps
- `varRefsOf` and `usedVarsOf` read `recording.requestBody`, not the `SET_REQUEST_BODY` override
  (`relive-run.service.ts:92-95`). Variables used only in an edited body are missing from FR-034c dependents
  and from `variablesUsed`, so a dependent step is **sent** with a gap instead of being skipped.
- `substituteVars` ends with `substituteTokens(withGlobal, vars)`, which fills bare `{{name}}` from Relive
  variables. FR-020 says bare `{{name}}` reads only the global store.
- A child FAILED (for example "request differs → Mock a failure") never holds the run. Only the inbound step's
  own result goes through `applyFailurePolicy`.
- `CHILD_EVENTS_GRACE_MS = 500`. Outbound `complete` webhooks are queued in the proxy, so a busy proxy or a
  fire-and-forget supplier call arrives late, and the child is wrongly marked NOT_CALLED.
- Unexpected calls are kept only in a signal. They are not persisted in `StepResult.unexpectedCalls`, so
  History and reloads lose them (FR-014f).
- Children have no `startedAt`/`durationMs` (FR-032). The inbound `actualRequest` is the browser's computed
  request, not what the proxy sent after rules. `rulesApplied` is empty for inbound steps.
- Child `mode` is read from the definition, not from what the proxy did (Ask me → sent, unattributed, STOPPING).

#### B20. Skeleton effect throws NG0600 on Angular 18.2 (newest commit)
- `call-list.component.ts:200-212`. The effect calls `this.skeletonVisible.set(true)` synchronously, without
  `{ allowSignalWrites: true }`. Angular is `18.2.14`, where a signal write inside an effect throws
  `NG0600`. The repo convention is to pass `allowSignalWrites` (23 uses).
- **What happens:** On the first load the signal's initial value hides the error. Every later
  "loading while empty" (filters cleared, new search, reconnect) logs NG0600, and the skeleton does not
  re-appear.
- **Fix:** Add `{ allowSignalWrites: true }`, or derive visibility with `computed` plus a separate
  `toSignal(timer)` hold.

#### B21. Skeleton holds real data back for 700 ms
- While `skeletonVisible` is true, the template shows the skeleton **instead of** data
  (`@if (skeletonVisible()) … @else if`). The first calls, and a live push into an empty list, are hidden for
  up to 700 ms. The commit message claims "live-push latency is untouched", which is not true for the empty
  list case.
- **Fix:** Hold only the case where data is still empty. Once `hasAnyData()` is true, hide the skeleton at once.

### LOW

- **B22.** `ReliveRunsService.start` publishes the snapshot **before** `runStore.create`
  (`ReliveRunsService.java:160-161`). If the insert fails, a RUNNING snapshot is left with no DB row, no drain
  timer, and no startup sweep. Its REPLAY/BLOCK rules then apply to traffic until someone deletes the file.
  Create first, then publish.
- **B23.** RELIVE-scope variable writes call the backend on the request path:
  `interception._flush_relive_promotions` awaits a 3 s HTTP POST before the call continues. With the backend
  down, every such call waits 3 s. That breaks CLAUDE.md's "no backend round trip on the request path" rule
  (only paused calls are exempt). Queue it as `_notify_promotion` does, and rely on the local overlay.
- **B24.** `ReliveRunsController` ignores the `{id}` (cycle) path variable everywhere, and `recordStepResult`
  trusts `body.runId` / `body.stepKey` / `body.attempt` over the path. It also accepts results for runs that
  are already final. Check that they match, and return 409 for final runs.
- **B25.** `save-edits` calls `manageCycles.update(id, updated, null, reason)`. `ifMatch = null` skips the
  optimistic check, so it can overwrite another tab's edits.
- **B26.** `finalizeRun` with `FINISHED`/`COMPLETED` marks every step with no result as **CANCELLED**
  (disabled steps, children never reported). A successful run's summary then shows cancellations.
- **B27.** `pruneRuns` may delete a still-RUNNING run (no status filter). If the newest run alone is larger
  than 500 MB, the size cap deletes it too.
- **B28.** `apply_outbound` logs `'choice': child.get('mode')`, which is always `None` for current snapshots.
  `maybeAddLiveCall` then records the reason as `REACHED_UPSTREAM` instead of why the call went live
  (FR-015b).
- **B29.** `_rule_applications` covers the request phase only. Response-phase rule changes are never listed
  (FR-028a: "naming the rule").
- **B30.** `apply_inbound` does not call `_guard_replay`. An inbound REPLAY step whose mock is missing goes to
  the app (FR-018).
- **B31.** `_canonical_xml` drops element `tail` text, so mixed-content XML that differs only there compares
  equal. `ET.fromstring` runs on untrusted bodies; the DOCTYPE guard only checks the first 800 characters.
- **B32.** `RunSnapshotBuilder` writes the recorded request body with `getBytes(UTF_8)`. A binary or base64
  recorded body never matches, so it always "differs".

---

## 4. Spec coverage matrix (what should exist vs what does)

✅ done · 🟡 partial or buggy · ❌ missing

| Req | Status | Notes |
|---|---|---|
| FR-001 section list | ✅ | List with step, LIVE and rule counts |
| FR-002 create / rename / duplicate / delete | ✅ | Delete refuses while running |
| FR-003 / 003a add calls, Pick from anywhere | ✅ | After T087–T090 |
| FR-003b Relive ▾ menu | ✅ | Bulk bar and call actions |
| FR-003c Relive now plus Save as cycle | 🟡 | Runs, but cannot be saved (B7); skips the pre-run dialog |
| FR-003d Replace steps with preview and undo | 🟡 | Selection dialog exists; preview is limited |
| FR-004 inbound brings children | ✅ | |
| FR-005 reorder / enable / duplicate / remove / optional | ✅ | |
| FR-006 recordings immutable | ✅ | Frozen copies |
| FR-007 reset step / cycle | ✅ | |
| FR-007a–c Rebuild modes, preview, undo | 🟡 | "Run it once for real" path not verified; undo through versions exists |
| FR-008 unsaved warning | ✅ | `canDeactivate` |
| FR-009 keep enough of the recording | ✅ | Frozen |
| FR-010 / 010a call rule, mode read from rule | ✅ | `relive-call-rule.ts` |
| FR-010b Reset call rule | ✅ | |
| FR-011 inbound switch | ✅ | |
| FR-012 REPLAY answers, never contacts | 🟡 | Broken by B1, B2, B3, B10 |
| FR-013 LIVE recorded as external | 🟡 | `reachedUpstream` guess (B17) |
| FR-014 / 014a deterministic endpoint + order | 🟡 | Replaced by fingerprint matching (B10) |
| FR-014b / c custom match plus badge | ✅ | |
| FR-014d request differs (4 choices) | 🟡 | Condition works; "Ask me" decided outside Relive (B9); "request changed" pill never set (B13) |
| FR-014e parent banner | ✅ | |
| FR-014f unexpected policy | 🟡 | Works in the proxy; list not persisted (B19) |
| FR-014g Compare reuses resend compare | 🟡 | `InterceptionPanelComponent` reused; step strip not extracted |
| FR-015 LIVE visually distinct, count | ✅ | |
| FR-015a external-reach notice plus Undo | ✅ | Frontend only; backend validator differs (B18) |
| FR-015b Live calls log | 🟡 | Exists; false entries (B17); reason field empty (B28) |
| FR-015c size warning | 🟡 | Hard-coded threshold |
| FR-016 pre-run LIVE summary plus confirmation | 🟡 | Skipped by Run from here and Relive now (B5) |
| FR-017 pre-run validation | 🟡 | Several checks weaker than specified (B18) |
| FR-018 REPLAY never falls back | 🟡 | Outbound guarded; inbound not (B30); start window (B3) |
| FR-019–020a variables, `{{$.name}}`, RELIVE scope | 🟡 | Bare `{{name}}` falls back to Relive vars (B19); backend round trip (B23) |
| FR-021 extraction | ✅ | |
| FR-022 / 022a masking | ✅ | Per-view reveal |
| FR-023 variable panel live | ✅ | |
| FR-024 no unresolved send | 🟡 | Edited-body variables missed (B19) |
| FR-025–027 cycle rules, participation, copy | ✅ | |
| FR-028 precedence plus per-step applied list | 🟡 | Request phase only (B29) |
| FR-028a response rules on mocks, labelled expected | 🟡 | Engine applies them; Compare never labels them EXPECTED (`expected: []`) |
| FR-029 / 029a / 029b reuse rule editor | ✅ | `RULE_EDITOR_TARGET`, catalog-driven |
| FR-030 / 030a Automatic and Guided | 🟡 | Guided broken (B2, B11) |
| FR-030b out-of-order, end Guided | 🟡 | Partly; repeats wrong |
| FR-030c Guided extraction | 🟡 | |
| FR-031 the 12 states | 🟡 | INTERCEPTED / REPLAYED / LIVE states never assigned by the orchestrator |
| FR-032 progress and durations | 🟡 | No child durations |
| FR-033 stop plus STOPPING drain | ✅ | Plus B15 crash |
| FR-034 hold on failure | 🟡 | Children never hold (B19) |
| FR-034a outcome | 🟡 | Timeout never detected |
| FR-034b differences hold optional | ✅ | |
| FR-034c skip dependents | 🟡 | B19 |
| FR-034d continue with the rest | 🟡 | 409 in the same tab (B4) |
| FR-035 retry keeps attempts | 🟡 | Child attempts overwritten (B13) |
| FR-035a checkpoints as Pause actions | ✅ | Badges and buttons |
| FR-035b–c Replay / Edit & replay / save edits | ❌ / 🟡 | Edit & replay and save-edits missing; attempts not persisted (B13) |
| FR-035d held child, timeout continues | ❌ | B6 |
| FR-035e pause box with countdown | ❌ | B9 |
| FR-035f Guided pauses | ❌ | B11 |
| FR-036 run from step | ❌ | B5 |
| FR-037 filter / search / collapse in run view | ✅ | |
| FR-038 execution log | 🟡 | Only HELD / CONTINUED / AMBIGUOUS entries; no per-step "matched, replayed, forwarded, variable set" |
| FR-039 compare with recording | 🟡 | One whole-body row |
| FR-040 difference count on the step | 🟡 | Always 0 or 1 |
| FR-041 expected vs unexpected | ❌ | `expected: []` always |
| FR-041a auto noise visible, collapsed | 🟡 | Noise drops the row; not shown as "ignored as noise" |
| FR-041b / c Ignore this field, override | ❌ | |
| FR-042 full step details | 🟡 | Effective/actual requests are browser-side; rules for inbound empty |
| FR-043 never truncate | ✅ | Guard test |
| FR-044 / 045 run stored separately | ✅ | Full definition snapshot (at a big cost, P1) |
| FR-044a mid-run edit dialog | ❌ | B13 |
| FR-046 compare two runs | ✅ | |
| FR-047 retention visible | ✅ | |
| FR-048 Scenarios untouched, parts reused | ✅ | |
| FR-049 / 049a / 049b attribution choice | 🟡 | Per-step choice saved; `unattributedChoices` request field ignored by backend (dead) |
| FR-050 concurrent runs isolated | 🟡 | SC-010 never run (T082) |
| FR-050a ambiguous → block both | ✅ | Over-triggers (B1, B2) |
| FR-051 calls still in Live Calls with badge | ✅ | |
| SC-002 zero REPLAY leaks | ❌ | B3 |
| SC-003 no LIVE run without confirmation | ❌ | B5 |
| SC-005 ≤ 1 s update | 🟡 | WebSocket driven, but NOT_CALLED grace and polling paths |
| SC-009 200-step usability | 🟡 | Spec test exists; editor `dirty` stringify cost (P4) |
| SC-011 noise | 🟡 | Whole-body grading cannot reach "zero differences after marking noise", because there is no marking |

---

## 5. Performance issues and fixes

| # | Where | Cost | Fix |
|---|---|---|---|
| P1 | `SqliteReliveRunStoreAdapter.insertOrUpdate` writes the full `definition_json` (every recorded body) on **every** run update: step result summary, variable, hold, log line, ambiguous call. `findById` re-parses it each time, including in `maybeAddLiveCall` just to read `cycleId` | O(updates × definition size). A 200-step cycle with 100 KB bodies means about 20 MB written and parsed per step | Write `definition_json` once at create, resume and updateDefinition. Use `UPDATE … SET summary_json=?` / `variables_json=?` / `log_json=?` / `hold_json=?` for the rest. Add `findHeader(runId)` without the definition |
| P2 | `recordStepResult` reloads **all** step results (with bodies) to recompute the summary | O(n²) per run | Keep summary counters incrementally, or `SELECT step_key, attempt, state` only |
| P3 | `RunSnapshotBuilder.build` writes a **new** recorded-request answer file per REPLAY child, with a new UUID, on every publish: start, every `setVariable` that a rule uses, `updateDefinition`, `finalizeRun` (STOPPING), resume. Old files are removed only at unpublish | Disk churn plus proxy cache growth (P5) | Use a stable answer id per (runId, stepKey), for example a UUIDv5. Write only when missing |
| P4 | `ReliveCycleEditorState.dirty` is `JSON.stringify` of saved and draft (full bodies) on every draft change. `externalReach(draft)` runs in an effect on every change | Each keystroke in the name field serializes MBs | Track a `revision` counter on edits, and compare structurally only on save. Memoize `externalReach` per step |
| P5 | Proxy memory: `_TIER_CACHE` (relive.py:869), `_RECORDED_REQUEST_CACHE` (interception.py:2219), `engine._answer_caches` (interception.py:3014) and `_relive_overlays` are global and **never evicted** when a run ends. Each holds full mock or recorded bodies | Unbounded growth over many runs | Evict all four in `ReliveRuns._forget_ordinals` (already called when a run disappears) |
| P6 | The whole snapshot (all mocks inline; the builder admits "not yet moved out of line") is `json.load`-ed **on mitmproxy's event loop** inside the request hook on every republish | Large cycles freeze every proxied connection for the parse | Move oversized mock bodies to answer files as T033 specified. Load snapshots in a thread, or only when the mtime changes |
| P7 | `deleteByReliveRunIds` scans the whole inbound log under the adapter monitor | Blocks all inbound webhooks during a delete | See B16 |
| P8 | `_match_unattributed_all` / `_runs_with_matching_outbound_child` loop over every child of every active run with `interception.Match` for **every** unattributed outbound call while any run is active | O(runs × children) on all unrelated traffic | Pre-index children by (method, host) per snapshot load |
| P9 | `canonical_body` (JSON re-serialization, XML tree) runs on the event loop per outbound call for up to 2 MB bodies, as part of fingerprinting | CPU spikes on the loop | Lower the inline limit, or hash the raw body first and canonicalize only when the endpoint already matched |
| P10 | `FileRunSnapshotPublisher` is fully `synchronized`. A large snapshot write blocks `publishInflight`, which the reverse proxy's **synchronous** prepare is waiting on | Adds inbound latency during republish | Separate locks for snapshot and inflight |
| P11 | `setVariable` is sent one HTTP call per produced variable, each possibly republishing | N republishes per step | Batch endpoint: `POST …/variables` with a list |
| P12 | `1d569e7` disables the Angular CLI cache | Slower dev builds | Re-enable, and prune `.angular/cache` in a script instead |

---

## 6. Style and convention issues

- **Polling is forbidden by CLAUDE.md:** `interval(1000)` in `relive-cycle.component.ts:422` and the 400 ms
  loop in `relive-run.service.ts:755` (B14).
- **The backend round trip on the request path is forbidden by CLAUDE.md:** `_flush_relive_promotions` (B23).
- **Templates:** 138 inline `style="…"` attributes in Relive templates (for example the transient banner,
  `relive-cycle.component.html:47`). They belong in `_relive.scss` under `rl-` classes, per T005.
- **`_relive.scss`:** 27 hex colours and 76 `rgba()` literals, while T005 asks for existing CSS variables.
  Replace them with `--red`, `--amber`, `--purple-light`, `--border-strong` and so on.
- **The hexagonal rule is bent in the controller:** `ReliveRunsController.saveEdits` builds the new
  `ReliveCycle` and calls `manageCycles.update` itself. That logic belongs in a `SaveRunEditsUseCase` in the
  service (constitution: one `*UseCase` per operation).
- **Record rebuilding:** `new Run(run.id(), run.cycleId(), …14 args…)` is repeated about 10 times in
  `ReliveRunsService`, and `new ReliveCycle(…15 args…)` about 6 times. Add `withX(...)` helpers on the records.
  This is also how fields got dropped (B5).
- **Dead or unused code:** `StartRunCommand.unattributedChoices` (ignored); `ReliveRunService.applyDefinitionEdit`
  (never called); `POST …/save-edits` (never called from the UI); `RunSnapshotBuilder` `for (String
  branchesField : new String[] {"branches"})` (a loop over one constant); `_take_ordinal`'s
  "consume with no slot" counter bump.
- **`any` in TypeScript:** `catch (error: any)` in `relive-cycle.component.ts:459, 568`. Use `unknown` plus a
  narrow check (strict-mode convention).
- **Misleading comments:** `ReliveRunsService.cleanupIfTransient` says a mid-run save clears `transient`
  (it does not). `CHILD_EVENTS_GRACE_MS` says every child "has already happened" (not true with queued
  webhooks). Commit `889db4d` claims live-push latency is untouched (B21).
- **`docs/relive.md`** should document the fingerprint matching (`SEMANTIC_V1`) and its deviation from
  FR-014a, and the RELIVE-scope backend call.

---

## 7. Test gaps (why these bugs got through)

- The proxy tests cover one in-flight entry at a time. There is no test with two concurrent siblings (B1), a
  supplier call during a Guided run (B2), or a run published inside the refresh window (B3).
- `ReliveRunsServiceTest` uses in-memory fakes, so the SQLite mapper dropping `fromStepKey` (B5) can never fail
  a test. Add a store-backed start → findById round-trip test.
- No test sends a lease and then closes the session after the run finished (B4).
- No test covers a child `PAUSE_REQUEST` checkpoint timeout (B6). The only timeout tests use the CHANGED path.
- `relive-run.service.spec.ts` covers Replay at a checkpoint only in memory. It never asserts that attempt N
  was PUT (B13).
- There is no frontend test for the call-list skeleton effect. A spec that flips loading → data → loading
  would hit NG0600 (B20).
- T082 (manual E2E) and the SC-010 two-run isolation check have never been run. That is the single check that
  would have caught B1–B3.

---

## 8. Fix plan, in order

1. **Safety (CRITICAL):** B3 (forced refresh on an unknown runId), B1 (no outbound in-flight entries), B2 and
   B11 (Guided step matching in the proxy), B4 (lease release plus status guards). Add the four missing proxy
   and service tests listed in §7.
2. **Broken flows (HIGH):** B5 (persist `fromStepKey`/seed, pre-run for Run from here), B6 (tag only the
   differs branch), B7 (Save as cycle, keep), B8 (Relive prepare ignores the logging toggle), B10 (endpoint +
   order first), B12 (per-run lock or column updates).
3. **Missing spec pieces:** B9 pause box in the run view; FR-044a apply-to-this-run dialog; Edit & replay plus
   save-edits; attempts persisted; per-field differences with EXPECTED labels and "Ignore this field"
   (FR-039–041c); `requestChanged`, `pauses`, timeout.
4. **Performance:** P1, P2, P3, P5, P6 first. They grow with cycle size and run count.
5. **Medium and low bugs, then style:** B14–B32, §6.
6. **Close the open tasks:** T091 checkbox, T082 manual E2E with SC-002 and SC-010 on a real app plus a stub
   supplier, then tick the tasks in `tasks.md` that are really done and untick the ones listed in B13.

---

## 9. Found while fixing (Phase 16)

| # | Bug | Severity | Fixed in |
|---|---|---|---|
| B33 | Releasing a request-phase pause sent the request to the host and skipped the rest of the call rule. A REPLAY child with "pause before" reached the real supplier on Continue or timeout | CRITICAL | T098 |
| B34 | `_guard_replay` turned every paused REPLAY child into an immediate 502, so "Ask me" and child checkpoints never held | HIGH | T098 |
| B35 | `backend-app` tests did not compile after `CallDetail` gained `relive`; two `ReliveCyclesControllerTest` cases failed after `create()` gained `deferFingerprint` | MEDIUM | T095 |
