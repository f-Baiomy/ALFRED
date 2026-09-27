# Implementation Plan: Relive Cycle

**Branch**: `003-relive-cycle` | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/003-relive-cycle/spec.md`
**UX gate**: [mock.html](./mock.html) - must be reviewed and approved before `/speckit-tasks`.

## Summary

A new **Relive Cycles** section lets a user freeze recorded calls into an ordered, tree-shaped workflow, choose per
call (and per outbound child) whether it runs **LIVE** or is **REPLAYED** by ALFRED, add cycle variables,
extractions, assertions, cycle rules and a chosen set of global rules, and run it - automatically or guided -
while a live checklist shows every step's state, differences against the recording (with noise filtered), and
what reached an external system. A cycle can be **rebuilt** (refresh from sources, from a new recording, or start over keeping settings, always
previewed and undoable), and any selection in Live Calls or a session cycle offers **Relive ▾** (add to cycle,
new cycle, Relive now, replace steps). Any step can **pause before and/or after** it runs, so the user can continue,
replay it as often as they like (editing between tries), skip it or stop, before moving on. Runs are kept as
history.

Technical approach (see [research.md](./research.md)): the run is **orchestrated by the browser tab**, as
Scenarios already are, so extraction, substitution, dynamic tokens, assertions, diffing and call-tree logic are the
existing TypeScript - not reimplemented. A new **`backend-relive`** slice stores cycles and runs (SQLite) and
publishes a **per-run proxy snapshot**; the mitmproxy addons attribute each request to a run (trusted run header →
propagated `X-Operation-Id` → in-flight uniqueness) and evaluate **step → cycle → selected global** rules, answering
REPLAY children from stored answers. Inbound steps are sent through the existing **`POST /resend`**.

## Technical Context

**Language/Version**: Java 21 (Spring Boot, Maven reactor), TypeScript 5.5 / Angular 18.2 (standalone + signals),
Python 3 (mitmproxy addons)
**Primary Dependencies**: existing only - Spring Web/WebSocket, SQLite JDBC, Jackson; Angular; mitmproxy. No new
libraries.
**Storage**: SQLite (new tables in the shared ALFRED database via the platform's SQLite support); proxy snapshot
files in the shared `proxy/interception/relive/` directory
**Testing**: JUnit 5 + Mockito + AssertJ, `@WebMvcTest`, ArchUnit (`backend-architecture-test`); Karma/Jasmine for
`shared/utils` and components; pytest-style tests in `proxy/test_interception.py`
**Target Platform**: Docker Compose deployment (Linux server or desktop), Chrome/Edge for the UI
**Project Type**: web application (backend + frontend + proxy addons)
**Performance Goals**: zero added cost per proxied request when no run is active beyond one cached `stat`; with runs
active, attribution and matching are in-memory lookups; run-view state changes visible ≤ 1 s (SC-005); a 200-step
cycle stays usable (SC-009)
**Constraints**: nothing blocks the proxy request path; no polling (WebSocket signals + lease); list endpoints never
return bodies; recorded calls immutable; exports never truncated; secrets masked by default
**Scale/Scope**: ≤ 500 steps per cycle, unlimited concurrent runs (one tab each), 50 runs per cycle + 500 MB total
run storage cap

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* **Result: PASS (pre- and post-design),
two justified items in Complexity Tracking.**

- [x] **I. Security**: all new DTOs `@Valid`, counts/sizes clamped (steps ≤ 500, list `limit` ≤ 100); the run header
  `X-Alfred-Relive` is trusted only from the backend's peer address and stripped before upstream and log (same
  rule as `X-Alfred-Resend-*`); secrets masked in the frontend (backend returns data in full, like the rest of ALFRED) in run view, details, compare and exports via the existing redaction
  list + secret variables, reveal is per view; no call data in logs (ids and sizes only); run data rendered through
  Angular's normal sanitisation, exports escaped by the existing builders. A LIVE external call can't start without
  the pre-run confirmation (FR-016), and REPLAY never falls back to the real system (FR-018).
- [x] **II. Performance**: the addons read snapshots through an mtime-cached loader (≤ 1 directory `stat`/s); no
  backend call on the request path; no polling anywhere (`/ws/relive` change signals; the lease is socket presence,
  not a heartbeat timer); `GET /relive-cycles` and run lists return headers/summaries only; step-result bodies are
  fetched when a run is opened; `inflight.json` is written only while a run is active; retention: 50 runs/cycle +
  500 MB cap, oldest first; cycle definitions deliberately unbounded like session-cycle capture (bounded manual
  artifact); the Live calls log (`relive_live_calls`) is deliberately never pruned - each row is a real supplier
  answer that can't be fetched again without calling the supplier again (FR-015b) - and is bounded instead by the
  user: size shown, warning above 200 MB, delete per row (FR-015c; see Complexity Tracking).
- [x] **III. Architecture**: new slice **`backend-relive`** (hexagonal: `domain.model`, `application.port.in|out`,
  `application.service`, `adapter.in.web`, `adapter.out.sqlite|websocket|snapshot`). **No new cross-slice edge**:
  observing calls and adding the resend run header both go through **`backend-app`** bridges (`relivebridge`)
  implementing existing ports (`NewCallObserverPort`, `NewInternalCallObserverPort`) and a new
  `ReliveRunLookupPort`; ArchUnit gains an isolation rule for the new slice. Frontend: standalone components +
  signals, shared components reused as-is.
- [x] **IV. Style**: `*UseCase` per operation, `*Port`, `ReliveCyclesService`/`ReliveRunsService`,
  `SqliteReliveCycleStoreAdapter`, `*RequestDto`, records, constructor injection; TS strict; addon code follows
  `interception.py`'s structure.
- [x] **V. Clean code**: reused (named in research inventory): `POST /resend`, `resend-draft-chain.ts`,
  `dynamic-tokens.ts`, `scenario-assertions.ts`, `interception-diff.ts`, `call-tree.ts`, `match-from-call.ts`,
  `rule-dialog`, `scenario-run-compare`, call picker, stored-answer format, `_resolve_variable_tokens`, `Match`/
  `Rule`, and `proxy/breakpoints.py` + `BreakpointUseCase` for held supplier calls (checkpoints). New code only where nothing exists: run attribution + tiered evaluation in the addon, noise classification
  (`relive-noise.ts`), the relive slice, the Relive pages. Reusable templates deferred (spec assumption).
- [x] **VI. Verification**: see Test strategy below; bug-fix tasks carry a failing-first test.
- [x] **Invariants**: exports untruncated (run export reuses builders); interception stays in the addons (run rules
  are proxy-evaluated); gateway regex gains `relive-cycles`; docs updated (`docs/relive.md` new, `CLAUDE.md` +
  `AGENTS.md` pointers, `docs/interception.md` evaluation tiers, `docs/architecture.md` slice list).

### Spec amendment to approve at the mock review

Research D1 changes one edge case: **closing the tab that orchestrates a run stops the run** (Interrupted after a
15 s grace, proxy snapshot removed, partial results kept, "Run from step" offered) instead of "continues on its
own". Everything else in the spec is met as written.

## Test strategy

- **Backend** (`backend-relive`): services against fake ports (validation findings, retention, lease expiry, stale
  `If-Match` → 409, run from step seeding); SQLite adapters against a temp DB with body-sized fixtures (~30 KB);
  `@WebMvcTest` per controller (clamps, 422 on blocking findings); ArchUnit isolation rule. `backend-resend`: the
  `relive` field adds both headers and nothing else. Bridges in `backend-app`: observer → inflight publication.
- **Proxy** (`proxy/test_interception.py`): run header trusted only from backend peer and stripped; attribution
  order HEADER → OPERATION_ID → INFLIGHT → UNATTRIBUTED; each unattributed choice; endpoint + order ordinals incl.
  more calls than recorded; tier order + `stopProcessing`; `globalRules` NONE/ALL/SELECTED; no run active = today's
  behaviour byte-for-byte (regression suite unchanged); snapshot removal takes effect within 1 s.
- **Frontend**: pure utils tested directly - `relive-noise.ts` (auto detectors, ignore lists, overrides), step
  outcome function (FR-034a table from the clarification example), validation mapping, tree derivation from
  `call-tree.ts`; components where behaviour is DOM-only - mode switch, pre-run summary gating, run timeline states,
  guided "expected next".
- **End-to-end manual** (quickstart.md): the Supplier A REPLAY / B LIVE / C REPLAY scenario against a stub supplier,
  proving the stub receives exactly one call (SC-002).

## Project Structure

### Documentation (this feature)

```text
specs/003-relive-cycle/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── mock.html            # Phase 1 UX approval gate
├── contracts/
│   ├── rest-api.md
│   └── proxy-snapshot.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (after mock approval)
```

### Source Code (repository root)

```text
backend/
├── backend-relive/                                  # NEW slice
│   └── src/main/java/com/fathy/alfred/backend/relive/
│       ├── domain/model/        ReliveCycle, Step, FrozenCall, CycleVariable, CycleRule, NoiseRule, Run, StepResult, ValidationFinding
│       ├── application/port/in/ ManageReliveCyclesUseCase, ValidateCycleUseCase, StartRunUseCase, RecordStepResultUseCase,
│       │                        StopRunUseCase, FinishRunUseCase, ListRunsUseCase, CompareRunsUseCase, ObserveRunCallUseCase
│       ├── application/port/out/ ReliveCycleStorePort, ReliveRunStorePort, RunSnapshotPublisherPort, InflightPublisherPort,
│       │                        GlobalRuleLookupPort, ReliveNotificationPort
│       ├── application/service/ ReliveCyclesService, ReliveRunsService, CycleValidator, RunLeaseRegistry
│       └── adapter/ in/web (controllers + dto) · out/sqlite · out/websocket (/ws/relive + lease) · out/snapshot (file publisher)
├── backend-resend/                                  # + optional `relive` on ResendRequest → X-Alfred-Relive, X-Operation-Id
├── backend-calls/, backend-internal-calls/          # + optional `relive` attribution field on logged calls
├── backend-app/src/main/java/.../relivebridge/      # NEW: call observers → ObserveRunCallUseCase; GlobalRuleLookup → interception
├── backend-architecture-test/                       # + isolation rule for backend-relive
└── pom.xml                                          # + module

proxy/
├── interception.py                                  # + ReliveRuns loader, attribution, tiered evaluation, ordinals, relive field on logged call
├── log_and_route.py, log_and_route_reverse.py       # + call into the relive layer; strip/trust X-Alfred-Relive
└── test_interception.py                             # + relive tests

frontend/src/app/
├── pages/relive/                                    # cycle list
├── pages/relive-cycle/                              # overview · step config drawer · run view (one route, /relive/:id)
├── components/relive-step-tree/                     # tree with mode switches, badges, drag reorder
├── components/relive-run-timeline/                  # checklist, progress, filters
├── components/relive-step-details/                  # original/effective/actual, diff, rules, variables
├── components/relive-prerun-summary/                # findings + LIVE confirmation + unattributed choices
├── core/services/relive-api.service.ts, core/state/relive-run.service.ts (orchestrator, reuses resend-draft-chain)
├── shared/utils/relive-types.ts, relive-noise.ts, relive-outcome.ts, relive-tree.ts (from call-tree.ts)
└── layout/main-layout (nav entry "Relive")

gateway/nginx.conf                                   # regex + relive-cycles
docs/relive.md (new), docs/interception.md, docs/architecture.md, CLAUDE.md, AGENTS.md
```

**Structure Decision**: web application layout already used by ALFRED - one new backend slice, bridges in
`backend-app`, addon changes in `proxy/`, new Angular pages/components under the existing `frontend/src/app` layout.

## Delivery slices (for /speckit-tasks)

1. **P1 foundation**: backend-relive storage + CRUD + validation; Relive list/overview UI with step tree, freezing
   from the call picker; reorder/enable/duplicate/reset (US1).
2. **P1 modes + proxy** (call rule per step, `relive-call-rule.ts`, D17; new `MATCHES_RECORDED_CALL`
   condition in ALFRED's Condition action): run snapshot, attribution, REPLAY answers, endpoint + order, unattributed choices, LIVE
   markers, pre-run summary (US2, safety FRs); request-changed handling per child and the unexpected-call
   policy with its rules (FR-014d/e/f, D15).
3. **P1 run**: Automatic orchestration, timeline, states, progress, stop, hold on failure / differences with
   retry, edit & retry, continue with next calls (dependent steps skipped), end run here; continue the rest of an
   ended run; lease (US3, D13).
4. **P2**: checkpoints: pause before/after, replay/edit & replay attempts, held supplier calls via the existing
   breakpoints with a per-step timeout (US3b); step details + differences + noise, Compare tab reusing the resend comparison (US4, D16); variables + extraction panel (US5); cycle rules, step rules and
   the call-scoped match rule in the shared `RuleEditorComponent` (`RULE_EDITOR_TARGET` + `scope`, D14), global
   participation + copy-to-cycle (US6); Guided driver.
5. **P3**: rebuild (3 modes, preview, undo) + Relive ▾ selection menu + quick run (US6b); history + compare (US7); run from step + optional steps (US8); docs.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| `backend-relive` is SQLite-only (no file adapter) | Run results are body-heavy, windowed and retained by size; a flat-file fallback would re-create the rewrite-the-whole-store problem the constitution warns against | A file adapter doubles every adapter and test for no user benefit; `backend-scenarios` already set the SQLite-only precedent for run stores |
| Live calls log (`relive_live_calls`) has no automatic retention (constitution II) | Every row is a real, already-paid-for supplier answer; pruning it would force a second real supplier call to get it back (FR-015b) | A row/size cap would silently delete real supplier answers; instead the log shows its size, warns above 200 MB and lets the user delete rows (FR-015c) |
| Relive writes its own stored-answer files (`relive/answers/<runId>/`) instead of calling interception's `StoredAnswersService` | Run answers must disappear with the run and never appear in the global Answers library; slices may not share code | Routing through interception would publish run-private answers globally and need a new cross-slice edge |
