---
description: "Implementation tasks for Relive Cycle, written for an implementer who has not seen the planning discussion"
---

# Tasks: Relive Cycle

**Input**: `specs/003-relive-cycle/` - [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/rest-api.md](./contracts/rest-api.md),
[contracts/proxy-snapshot.md](./contracts/proxy-snapshot.md), [quickstart.md](./quickstart.md), **[mock.html](./mock.html)**
(the approved UX; every UI task names the mock function to copy the layout and behaviour from).

**Tests**: included. The constitution (VI) and plan "Test strategy" require them, and every behaviour task
below ends with the test that proves it.

## Read this first (every implementer, every task)

1. **What the feature is**: the spec's Overview + Clarifications (spec.md lines 1-153) are the source of truth.
   If a task and the spec disagree, the **spec's Clarifications win**. Later clarifications override earlier ones:
   e.g. the "call rule" model (FR-010a) replaced the old per-step `mode` / `matchRule` / `faults` / `checkpoint`
   fields. data-model.md is already updated to that model.
2. **UI reference**: open `specs/003-relive-cycle/mock.html` in a browser. The top bar has walkthroughs 1-12. Its
   `<script>` is plain JS; each UI task names the functions to read (e.g. `configTab()`, `callRuleSection()`).
   Copy **layout, wording, states and order of controls**. Do **not** copy its code style: the real app is
   Angular standalone components + signals. Mock CSS classes (`.pill`, `.p-live`, `.step`, `.pausebox`...) map to
   a new `frontend/src/styles/_relive.scss`, using the existing design tokens from `frontend/src/styles.scss`
   (grep the `--` custom properties there; never read the whole 10k-line file).
3. **Code search**: this repo has `.codegraph/`. Use `codegraph explore "<symbols>"` (shell) or the
   `codegraph_explore` MCP tool before Grep/Read. **Never read whole** `frontend/src/styles.scss` (~10k lines) or
   `proxy/interception.py` (~3.4k lines): explore the named symbols only.
4. **Reuse, don't fork**: when a task says "reuse X", import X. If X needs a small extension (an input, a DI
   token), make it in X's own file and keep X's existing tests green.
5. **Build & test commands** (JDK 21 required; bare `mvn` on this machine may be JDK 8 - use Docker):
   - Backend one module: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -pl backend-relive -am test` (run from repo root)
   - Backend one test: add `-Dtest=ClassName -Dsurefire.failIfNoSpecifiedTests=false`
   - Frontend one spec: `cd frontend && npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/shared/utils/relive-call-rule.spec.ts`
   - Proxy: `cd proxy && python -m pytest test_relive.py -q` (and `test_interception.py` must stay green)
6. **Style rules** (constitution IV/V): Java records for models, constructor injection, one `*UseCase` interface
   per operation, `*Port` for outbound, `@Valid` DTOs with sizes clamped. TS strict, signals, `inject()`,
   standalone components with separate `.html` templates, as in `components/cycle-widget/`. No polling: lists
   refresh when `/ws/relive` says something changed.
7. **Naming**: backend package root `com.fathy.alfred.backend.relive`; frontend files prefixed `relive-`.
8. **Do not commit** unless the owner asks. Mark a task `[x]` in this file when done and its test passes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel with other [P] tasks of the same phase (different files, no unfinished dependency)
- **[USn]**: user story from spec.md (US3b and US6b are written `[US3b]`, `[US6b]`)

## Path shortcuts used below

- `BR` = `backend/backend-relive/src/main/java/com/fathy/alfred/backend/relive`
- `BRT` = `backend/backend-relive/src/test/java/com/fathy/alfred/backend/relive`
- `APP` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `FE` = `frontend/src/app`

---

## Phase 1: Setup

- [X] T001 Create the Maven module `backend/backend-relive/pom.xml` by copying `backend/backend-scenarios/pom.xml` (same parent, same dependencies: web, validation, websocket, jdbc, sqlite-jdbc 3.46.1.3, test). Set `artifactId`/`name` to `backend-relive`, and set the description to "Vertical slice: Relive cycles (frozen call workflows with per-call rules), their runs, per-run proxy snapshots and the live-call log. Hexagonal; talks to other slices only through backend-app bridges." Add `<module>backend-relive</module>` after `backend-scenarios` in `backend/pom.xml`. Add a `backend-relive` dependency to `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`, next to the existing `backend-scenarios` entries (lines ~85-87).
- [X] T002 Create empty package folders under `BR/`: `domain/model`, `application/port/in`, `application/port/out`, `application/service`, `adapter/in/web/dto`, `adapter/out/sqlite`, `adapter/out/websocket`, `adapter/out/snapshot`. Create `BRT/TestApplication.java` by copying `backend/backend-scenarios/src/test/java/com/fathy/alfred/backend/scenarios/TestApplication.java` (change the package). Verify with the backend module build command (Read-this-first §5): it must compile with zero sources.
- [X] T003 [P] Add `relive-cycles` to the backend prefix regex in `gateway/nginx.conf` line ~42 (`location ~ ^/(calls|...|scenarios)(/|$)`), giving `...|scenarios|relive-cycles)`. Check the same file for the `/ws/` location: `/ws/relive` is covered by it. Do not add a `$spa_page` entry, because the SPA route is `/relive`, not `/relive-cycles`.
- [X] T004 [P] Add the route and nav entry.
  - In `FE/app.routes.ts`, add two lazy children to the `MainLayoutComponent` route, in the same style as `interception`:
    - `{ path: 'relive', loadComponent: () => import('./pages/relive/relive-list.component').then(m => m.ReliveListComponent) }`
    - `{ path: 'relive/:id', loadComponent: () => import('./pages/relive-cycle/relive-cycle.component').then(m => m.ReliveCycleComponent) }`
  - In `FE/layout/main-layout/main-layout.component.html`, add `<a routerLink="/relive" routerLinkActive="active">Relive <span class="nav-new">new</span></a>` between the Interception and Settings links. Match the mock's nav: `mock.html` `<nav class="nav">`.
  - Create placeholder components (selector, empty template) so the build passes.
- [X] T005 [P] Create `frontend/src/styles/_relive.scss` and add `@import "styles/relive";` after `@import "styles/cycle-widget";` in `frontend/src/styles.scss` (line ~10171).
  - Port these mock.html `<style>` rules, renaming each class with an `rl-` prefix to avoid clashes: `.pill` and every `.p-*` variant (p-live, p-replay, p-cycle, p-global, p-mod, p-diff, p-fail, p-ok, p-wait, p-pause, p-new), `.step`, `.step.child`, `.st` (state circle and its variants), `.seg.mode`, `.choice`, `.rulecard`, `.ext-banner`, `.pausebox`, `.haltbox`, `.re-col`, `.re-act`, `.cmp`, `.extnote`, `.kv`, `.sect`, `.progress`, `.filters`, `.drow`.
  - Replace hard-coded colours with the nearest existing CSS variables (grep `styles.scss` for `--red`, `--amber`, `--cyan`, `--border`...), and add a new variable only when none fits.
- [X] T006 [P] Create `FE/shared/utils/relive-types.ts`: the TypeScript mirror of data-model.md.
  - **Types**: `ReliveCycle`, `ReliveSettings` (`inboundMode`, `onFailure: 'HOLD'|'CONTINUE'`, `onDifferences: 'CONTINUE'|'HOLD'`, `defaultDriver`), `Step` (key, parentKey, label, enabled, optional, direction, serviceName, `recording: FrozenCall`, `source`, `callRule: InterceptionRuleDraft`, `unattributed`, `extract: ExtractRule[]`, `assertions: Assertion[]`, `noise: NoiseRule[]`), `FrozenCall`, `CycleVariable`, `CycleRule` (= `InterceptionRuleDraft & { copiedFrom }`), `NoiseRule`, `UnexpectedCallsPolicy`, `CycleVersion`, `Run`, `RunSummary`, `StepResult`, `StepState` (the 13 states in data-model.md), `ValidationFinding`, `LiveCall`, `LogEntry`.
  - **Import, don't redefine**: `InterceptionRuleDraft` from `core/models/interception.model.ts`, `ExtractRule` and `Assertion` from `shared/utils/scenario-types.ts`.
  - **Derived helpers**: `mode`, `checkpoint` and `onRequestChanged` are NOT fields; they are computed by `relive-call-rule.ts` (T020).

---

## Phase 2: Foundational (blocks every user story)

### Backend: model, storage, CRUD, events

- [X] T007 Create the domain records in `BR/domain/model/` from data-model.md: `ReliveCycle`, `ReliveSettings`, `Step`, `FrozenCall`, `CycleVariable`, `CycleRule`, `NoiseRule`, `UnexpectedCallsPolicy`, `GlobalRulesSelection`, `CycleVersion`, `Run`, `RunStatus` (enum), `RunSummary`, `StepResult`, `StepState` (enum), `ValidationFinding`, `LiveCall`.
  - **Rule documents stay opaque:** hold them as Jackson `JsonNode` fields. This covers `Step.callRule`, `CycleRule.rule`, `extract`, `assertions`, `StepResult` request/response. The backend never interprets actions.
  - **Constants:** add `MAX_STEPS = 500`, `MAX_VARIABLES = 200`, `MAX_CYCLE_RULES = 200` and `MAX_LIST_LIMIT = 100` in `ReliveLimits.java`.
- [X] T008 Create `BR/adapter/out/sqlite/SqliteReliveRepository.java` by copying the structure of `backend/backend-scenarios/.../adapter/out/sqlite/SqliteScenariosRepository.java`:
  - Hikari pool; the PRAGMA `connectionInitSql`.
  - `@ConditionalOnProperty(prefix="alfred.storage.relive", name="type", havingValue="sqlite", matchIfMissing=true)`.
  - DB file from `${RELIVE_DB_FILE:/appdata/relive.db}`.
  - Create these tables with `CREATE TABLE IF NOT EXISTS`:
    - `relive_cycles(id PK, name, description, definition_json, transient INTEGER, created_at, updated_at)`
    - `relive_cycle_versions(cycle_id, version INTEGER, saved_at, reason, definition_json, PRIMARY KEY(cycle_id, version))`
    - `relive_runs(id PK, cycle_id, status, driver, started_at, finished_at, summary_json, definition_json, hold_json, resumed_json, variables_json, log_json, size_bytes)`
    - `relive_step_results(run_id, step_key, attempt, state, result_json, size_bytes, PRIMARY KEY(run_id, step_key, attempt))`
    - `relive_live_calls(id PK, cycle_id, run_id, step_key, reason, method, url, status, duration_ms, at, request_json, response_json, size_bytes)`
  - Add indexes on `cycle_id` for runs, versions and live calls.
- [X] T009 [P] Create the outbound ports in `BR/application/port/out/`:
  - `ReliveCycleStorePort`: list, get, save, delete, `saveVersion`, `listVersions`, `getVersion`, `pruneVersions(cycleId, keep=10)`.
  - `ReliveRunStorePort`: create, get, list, update status/hold/resumed/summary, `putStepResult`, `listStepResults`, `pruneRuns(cycleId, keep 50, maxBytes)`.
  - `LiveCallStorePort`: add, list, get, delete, `totalBytes(cycleId)`.
  - `RunSnapshotPublisherPort`: `publish(runId, snapshotJson)`, `unpublish(runId)`, `publishInflight(json)`, `clearInflight()`.
  - `ReliveNotificationPort`: `cycleChanged()`, `runChanged(cycleId, runId)`, `runCall(event)`.
  - `RuleValidationPort`: `List<String> validate(JsonNode ruleDoc)`.
  - `GlobalRulesLookupPort`: `List<GlobalRuleRef> list()` and `boolean exists(id)`.
- [X] T010 Implement `BR/adapter/out/sqlite/SqliteReliveCycleStoreAdapter.java`, `SqliteReliveRunStoreAdapter.java` and `SqliteLiveCallStoreAdapter.java` as thin wrappers over `SqliteReliveRepository.jdbc()`, in the scenarios adapters' style.
  - **Serialisation:** records to and from `definition_json`, etc. with the Spring `ObjectMapper`.
  - **List queries select headers only, never bodies** (constitution II). The cycles list must not read `definition_json`: store `step_count`, `live_count` and `last_run_json` in extra columns when saving, and add those columns to T008.
  - **Test:** `BRT/adapter/out/sqlite/SqliteReliveStoreAdaptersTest.java` against a temp file DB (`@TempDir`) with ~30 KB bodies: round-trip; list without bodies; version pruning keeps the newest 10; run pruning keeps the newest 50 and the size cap; live calls are never pruned by run pruning.
- [X] T011 Create the inbound use cases in `BR/application/port/in/`: `ManageReliveCyclesUseCase` (list, get, create, update with `ifMatch` + optional `reason`, duplicate, delete, `createTransient`), `ValidateCycleUseCase`, `ManageCycleVersionsUseCase` (list, restore).
- [X] T012 Implement `BR/application/service/ReliveCyclesService.java`, which implements T011's use cases.
  - **Validation on save** (data-model "Validation on save"): unique step keys; every `parentKey` resolves to an inbound step; variable names match `[A-Za-z_][A-Za-z0-9_]*` and are unique; clamps from `ReliveLimits`; every `callRule` and cycle rule passes `RuleValidationPort`. Errors raise the existing validation exception shape (see how `backend-scenarios` returns 400).
  - **Optimistic update:** `update` compares `ifMatch` with the stored `updatedAt`, throws `StaleCycleException`, which maps to 409.
  - **Versioned update:** with a `reason` present, save the previous definition as a version first, then `pruneVersions`.
  - **Delete:** refuses with 409 while a RUNNING run exists (ask `ReliveRunStorePort`).
  - **Notify:** call `cycleChanged()` after every write.
  - **Test:** `BRT/application/service/ReliveCyclesServiceTest.java` with in-memory fake ports - each rule above, one test each.
- [X] T013 Create the REST controller `BR/adapter/in/web/ReliveCyclesController.java` (`@RequestMapping("/relive-cycles")`) with DTOs in `adapter/in/web/dto/`.
  - **Endpoints:** exactly the "Cycles" table of `contracts/rest-api.md`: `GET` list, `GET /{id}`, `POST` (plus `?transient=true`), `PUT /{id}` reading header `If-Match` and optional `?reason=`, `POST /{id}/duplicate`, `DELETE /{id}`, `POST /{id}/validate` (a stub returning `[]` until T045), `GET /{id}/versions`, `POST /{id}/versions/{version}/restore`.
  - **DTOs:** `@Valid` on every DTO; `@Size` on lists.
  - **Test:** `BRT/adapter/in/web/ReliveCyclesControllerTest.java` (`@WebMvcTest`) - happy paths, 400 on an invalid name, 409 on a stale `If-Match`, the list payload has no `recording` bodies.
- [X] T014 [P] Create `BR/adapter/out/websocket/ReliveWebSocketConfig.java`, `ReliveEventsWebSocketHandler.java` and `WebSocketReliveNotificationAdapter.java` by copying `backend-scenarios/.../adapter/out/websocket/*`.
  - **Path:** `/ws/relive`.
  - **Events** (JSON strings): `{"type":"relive-changed"}`, `{"type":"run-changed","cycleId","runId"}`, `{"type":"run-call",...}`.
  - **Leases:** the handler also receives `{"type":"lease","runId"}` messages and forwards them to `RunLeaseRegistry` (T047). Keep the registry interface-only here, as a `LeaseListener` port.
- [X] T015 [P] Create the bridges in `APP/relivebridge/`. Look at `APP/interceptionbridge/RecordedCallLookupAdapter.java` for the bridge style.
  - **`RuleValidationAdapter`** implements `RuleValidationPort`: it deserialises the `JsonNode` into interception's `InterceptionRule` (via the same Jackson mapping the interception controller uses) and returns `RuleValidator.validate(rule)`.
  - **`GlobalRulesLookupAdapter`** implements `GlobalRulesLookupPort` by calling interception's list-rules use case (find it with `codegraph explore "ListRulesUseCase InterceptionRulesService"`).
  - **Test:** `backend/backend-app/src/test/java/com/fathy/alfred/backend/relivebridge/RuleValidationAdapterTest.java`: a valid `MOCK_RESPONSE` rule gives no errors; an unknown action type gives an error.
- [X] T016 Add an ArchUnit rule to `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java`, named `reliveSliceMustNotDependOnOtherSlices()`.
  - **Rule:** `..backend.relive..` may not depend on calls, comments, export, sessioncycles, profiles, settings, internalcalls, calloverlap, redactions, interception, resend or scenarios.
  - **Other slices' rules:** add `"..backend.relive.."` to the package lists of every other slice's rule (see lines 74-220; each rule lists the forbidden packages).
  - **Run:** `mvn -pl backend-architecture-test -am test`.

### Frontend: API, socket, the call-rule helper, the external-reach check

- [X] T017 [P] Create `FE/core/services/relive-api.service.ts`, in the style of `FE/core/services/scenario-api.service.ts` (HttpClient + `AppConfigService.backendUrl`).
  - **Endpoints:** one method per endpoint in `contracts/rest-api.md`: cycles, versions, validate, runs, attempts, variables, stop, finish, hold, resume, definition, save-edits, compare, live-calls, use-as-recording.
  - **Update:** `update(id, cycle, ifMatch, reason?)` sets the `If-Match` header.
  - **Test:** `relive-api.service.spec.ts` with `HttpTestingController` covers the URL and headers for update, resume and live-calls.
- [X] T018 [P] Create `FE/core/services/relive-socket.service.ts`.
  - **Connection:** a bidirectional WebSocket to `${backendUrl.replace(/^http/,'ws')}/ws/relive`. It reconnects like `FE/core/state/reconnecting-socket.ts`, but keeps a `WebSocket` so it can `send()`.
  - **Exposes:** `events$` (a `Subject` of the three event types), `holdLease(runId)` and `releaseLease(runId)`. Every lease still held is re-sent `{type:'lease',runId}` on every (re)connect.
  - **Test:** `relive-socket.service.spec.ts` with a fake WebSocket: leases are re-sent after reconnect.
- [X] T019 [P] Create `FE/core/state/relive-cycles-state.service.ts` (root): `cycles` signal and `load()` via the API, reloaded when `relive-changed` arrives (no timers).
- [X] T020 Create `FE/shared/utils/relive-call-rule.ts`: the pure core of FR-010a (research D17). Behaviour must equal mock.html `ACT`, `mkAct`, `applyFields`, `deriveFields`, `ensureAct`, `removeAct`, but work on real `InterceptionRuleDraft` action objects (`type`, `enabled`, fields).
  - **Action types:**
    - `MOCK_RESPONSE` (status, headers, body from `step.recording`)
    - `REPLACE_RESPONSE` ("Reply with a different response", filled the same way)
    - `PAUSE_REQUEST` / `PAUSE_RESPONSE` (timeout seconds)
    - `IF_REQUEST` with the new `MATCHES_RECORDED_CALL` condition (T031), whose else-branch is one of:
      - `MOCK_RESPONSE` 502 `{"error":"Request differs from the recording - blocked by ALFRED Relive"}` (= FAIL)
      - `PAUSE_REQUEST` whose timeout default is that failure (= ASK)
      - `SEND_TO_HOST` (= LIVE)
    - `SET_REQUEST_BODY` ("Replace the request body").
  - **Exports:**
    - `defaultCallRule(step, settings)`: children get `[IF_REQUEST(FAIL), MOCK_RESPONSE(recording)]`; inbound gets an empty pipeline, or a mock when `settings.inboundMode==='REPLAY'`.
    - `applyMode(rule, mode, recording)`: REPLAY turns the mock on (creating it if deleted) and turns the replace off. LIVE turns the mock off and keeps its data. LIVE_MOCKED turns the mock off and turns the replace on (creating it from the recording). It never touches other actions.
    - `modeOf(rule)` returns `'REPLAY'|'LIVE'|'LIVE_MOCKED'`.
    - `setOnRequestChanged(rule, 'FAIL'|'ASK'|'REPLAY'|'LIVE', recording)`: places the condition after edit actions and before the mock.
    - `onRequestChangedOf(rule)`.
    - `setCheckpoint(rule, 'before'|'after', on, timeoutSec)`.
    - `checkpointOf(rule)`.
    - `reachesHost(rule): {reaches: boolean, reason: string|null}`: walks every enabled path, including `IF_REQUEST` then/else branches. The host is reached when no enabled terminal answer precedes it on some path. `SEND_TO_HOST` and `REWRITE_URL` to another host count as reaching. The reasons are the mock's `extReason()` strings.
    - `isModified(rule, step, settings)`: compares against `defaultCallRule`.
  - **Test:** `FE/shared/utils/relive-call-rule.spec.ts`, one `it` per behaviour. Include the four mock verifications:
    - LIVE keeps edited mock data and switching back restores it;
    - a deleted mock is re-created;
    - LIVE_MOCKED turns the replace on;
    - `reachesHost` is true for mock off, mock deleted, else=SEND_TO_HOST and a `REWRITE_URL` rule, and false for else=FAIL or PAUSE.
- [X] T021 Create `FE/shared/utils/relive-external-reach.ts`.
  - **`externalReach(cycle): Map<string, {label, host, reason}>`** combines:
    - `reachesHost` for every enabled outbound child not on an internal host (hosts ending `.internal`, or listed in the cycle settings' `internalHosts: string[]` - add that field to `ReliveSettings` in T006/T007 with default `[]`);
    - the unexpected-call policy `SEND_REAL`, or `RULES` with fallback `SEND_REAL`;
    - each `unattributed === 'SEND_REAL'`.
  - **`newlyReaching(before, after)`** returns the keys added.
  - **Test:** `relive-external-reach.spec.ts`.

**Checkpoint**: backend module builds, CRUD endpoints work via curl through the gateway (`/relive-cycles`), `/relive` route renders placeholders, `relive-call-rule.spec.ts` green.

---

## Phase 3: User Story 1 - Build a Relive Cycle from recorded calls (P1) 🎯 MVP

**Goal**: create, name, save, reorder, enable/disable, duplicate, reset and delete cycles built from recorded calls
(FR-001-009). **Independent test**: spec.md US1 acceptance scenarios 1-6; mock walkthrough **1 Build**.

- [X] T022 [P] [US1] Create `FE/shared/utils/relive-freeze.ts`.
  - **`freezeCalls(calls: CallRecord[], details: Map<id, detail>, settings): Step[]`** turns recorded calls (inbound roots with their outbound children) into steps.
    - **Parents:** use `buildCallTree` from `FE/shared/utils/call-tree.ts` to find each inbound call's outbound children.
    - **`FrozenCall`:** copy every field listed in data-model.md, bodies in full.
    - **Keys:** `key` = `crypto.randomUUID()`; `source` = `{callId, cycleId, direction}`.
    - **Defaults:** `callRule` = `defaultCallRule(...)` (T020); `unattributed:'BLOCK'`; label `METHOD path`.
  - **Test:** `relive-freeze.spec.ts` with fixtures built the way call-tree tests build them. Cover: one inbound call with 3 children gives 4 steps with the right `parentKey`; each child's default rule is REPLAY + FAIL.
- [X] T023 [US1] Create the list page `FE/pages/relive/relive-list.component.{ts,html}`. It copies mock.html `listView()` and `lastRunPill()`.
  - **Table columns:** name, description, steps, LIVE count, last run pill, updated.
  - **Actions:** open / duplicate / delete (delete uses the existing `ConfirmDialogService`).
  - **"＋ New cycle":** opens the add-calls flow (T026) and then creates the cycle.
  - **Empty state:** text from the mock.
  - **Data:** from `ReliveCyclesStateService`.
  - **Test:** `relive-list.component.spec.ts`: rows render; delete asks for confirmation.
- [X] T024 [US1] Create the cycle page shell `FE/pages/relive-cycle/relive-cycle.component.{ts,html}` and its state `FE/pages/relive-cycle/relive-cycle-editor.state.ts` (component-provided service).
  - **Page:** copies mock.html `cycleView()`: header with editable name and description, the badge row (`N steps · M outbound children`, `⚠ N can reach an external system`, `GLOBAL rules: …`, `N CYCLE rule`, `N variables`, `inbound: …`), the tabs Steps / Variables / Rules / Run / History, and the Save / ⟳ Rebuild / Duplicate / ▶ Run buttons.
  - **Editor state:** holds `draft: signal<ReliveCycle>`, `saved` (last loaded), `dirty = computed(...)`, `selectedStepKey`, `save()` (PUT with If-Match; 409 shows a "changed elsewhere - reload?" dialog), `discardGuard` (FR-008: warn on leaving with unsaved changes, via a `canDeactivate` guard on the route in `app.routes.ts`).
  - **Test:** `relive-cycle-editor.state.spec.ts`: dirty tracking; a 409 shows the reload prompt.
- [X] T025 [US1] Create `FE/components/relive-step-tree/relive-step-tree.component.{ts,html}`. It copies mock.html `stepsPanel()`, `stepRow()`, `childRow()`, `bindDnD()`, `moveBefore()`.
  - **Inbound rows:** ordered, with ⋮⋮ drag handle, number, enabled toggle, method badge, label + path, `N ↗` children count, mode pill, duplicate, delete.
  - **Child rows:** indented, with the 3-button mode segment REPLAY / LIVE ⚠ / LIVE · mocked reply ⚠ (the buttons call `applyMode`, T020), and badges ⏸ checkpoint, `custom match`, `rule edited`, `? attribution`.
  - **Reordering:** drag reorders a whole inbound block, children included, using `@angular/cdk/drag-drop` (already a dependency - `rule-editor` imports `CdkDropList`).
  - **Search:** box filters by label or path (FR-037-style search).
  - **Folding:** collapse/expand per inbound row.
  - **Validation list:** above the tree, the findings list and the external-systems banner (mock `stepsPanel()` top).
  - **Test:** `relive-step-tree.component.spec.ts`: reorder moves children with their parent; the mode buttons change `modeOf(step.callRule)`.
- [X] T026 [US1] Add calls to a cycle. Create `FE/components/relive-add-calls/relive-add-calls-dialog.component.{ts,html}`, copying mock.html `openAdd()` / `confirmAdd()`.
  - **List:** the calls of a chosen session cycle, as inbound calls with their children shown indented (children follow their parent automatically).
  - **"📌 Pick from anywhere…":** uses the existing `CallPickerService` (`FE/core/services/call-picker.service.ts`) exactly as other features do. Find usages with `codegraph explore "CallPickerService pick"`, and match mock `openPicker()` / `donePicking()`.
  - **Freezing:** chosen calls are frozen with `freezeCalls` after fetching each call's detail through the existing calls API, and appended to the draft.
  - **Hint:** "Calls are copied into the cycle - the recording itself is never modified."
- [X] T027 [US1] Step drawer: Configure tab (basic) in `FE/components/relive-step-drawer/relive-step-drawer.component.{ts,html}`. It copies mock.html `drawer()` and the non-run part of `drawerBody()`.
  - **Tabs:** Configure / Request / Response / Extract & assert. Extract & assert is wired in US5; keep it empty here.
  - **Configure:** label, "Optional" checkbox, the recorded status and duration, and "open original ↗" (navigates to the source call with the existing `CallFocusService.revealIn`).
  - **Request tab:** shows the recorded request read-only for now; T037 makes it editable.
  - **Response tab:** shows the recording.
- [X] T028 [US1] Reset and duplicate (FR-006, FR-007, FR-010b).
  - **In the editor state:** `resetStep(key)` (confirm dialog text from mock `confirmReset()`; rebuilds `callRule` with `defaultCallRule`, restores `recording` edits, clears the custom match), `resetCycle()` ("Reset to recording" button, mock `resetCycle()`), `duplicateStep(key)` (new keys for the step and its children), and `duplicateCycle()` via the API.
  - **Test:** in `relive-cycle-editor.state.spec.ts`.

**Checkpoint**: US1 acceptance scenarios pass manually; walkthrough 1 reproducible in the real app.

---

## Phase 4: User Story 2 - LIVE / REPLAY per call, the call rule, safety (P1)

**Goal**: FR-010-018, 014a-g, 015a, 016, 049a-b; research D2, D3, D4, D14, D15, D17. **Independent test**: US2
scenarios 1-9 + quickstart.md "Supplier A REPLAY / B LIVE / C REPLAY" against a stub supplier: the stub receives
exactly one call (SC-002). Mock walkthroughs **2**, **4**, **11**, **12**.

### Proxy (Python)

- [X] T029 [US2] Create `proxy/relive.py`. It is a new module; do NOT grow `interception.py`.
  - **`ReliveRuns` loader:** reads every `proxy/interception/relive/<runId>.json` (shape: `contracts/proxy-snapshot.md`, with each child carrying `callRule` per the D17 note) plus `relive/inflight.json`. It checks the directory mtime at most once per second and costs nothing when the directory is missing or empty (pattern: `_RulesCache` in `interception.py`; explore it).
  - **`attribute(flow, source, service_name, backend_addresses)`** returns `(run, step_entry | None, attribution)` in this order:
    - `HEADER`: `X-Alfred-Relive: <runId>/<stepKey>`, trusted only when the peer is in `backend_addresses`, the same rule as `take_resend_headers`. Always strip it.
    - `OPERATION_ID`: `X-Operation-Id` starts `relive-<runId>-`.
    - `INFLIGHT`: `inflight.json` has exactly one entry for the calling project, and that entry has a `runId`.
    - `AMBIGUOUS` (FR-050a): the call is not attributed by HEADER or OPERATION_ID, and either `inflight.json` has entries from more than one run for the calling project, or the request would match a child of more than one active run. Return the list of those run ids.
    - `UNATTRIBUTED`.
  - **Outbound matching:** match against the run's children of the step in flight, on endpoint + order. Keep per-run, per-parent-step ordinal counters; `ordinal` comes from the snapshot. A child with a custom `callRule.match` uses it instead.
  - **STOPPING** (FR-033): when the snapshot has `state: "STOPPING"`, `attribute` still attributes, and the caller
    answers every attributed call, and every unattributed call matching one of the run's REPLAY children, with
    `502 {"error":"Blocked by ALFRED Relive - run stopping","runId":…}`. No call rule or policy of the run runs.
  - **Test:** `proxy/test_relive.py`: STOPPING blocks a REPLAY child, a LIVE child and an unexpected call; each attribution route; the header comes from a non-backend peer (not trusted, stripped); ordinals with more calls than recorded (the extra call is unexpected); no directory means `attribute` returns quickly and does no file reads after the first stat.
- [X] T030 [US2] Run tiers through the existing engine (research D4, FR-028a).
  - **Engine change:** in `proxy/interception.py`, add an optional `extra_rulesets` parameter to `InterceptionEngine._apply_request_phase` / `_apply_response_phase` / `_matched_for_response` (explore them first). The engine then evaluates, in order: the call rule (tier STEP, a `RuleSet` built from the snapshot's `callRule` via the existing `Rule` / `_prepare_actions`), then cycle rules (tier CYCLE), then the global rules filtered by the snapshot's `globalRules` (NONE / ALL / SELECTED ids). `stopProcessing` and priority keep their meaning within each tier.
  - **No run:** with no `extra_rulesets`, behaviour must be byte-for-byte today's.
  - **Response phase:** later rules' response actions still run on a mocked answer (FR-028a).
  - **`relive.py`:** exposes `rulesets_for(run, step_entry)`, which caches the built RuleSets per snapshot mtime.
  - **Tests:** `proxy/test_relive.py` covers tier order, `stopProcessing` inside a tier, and a GLOBAL response rule rewriting a mocked body. The whole of `proxy/test_interception.py` must pass unchanged.
- [X] T031 [US2] New ALFRED condition `MATCHES_RECORDED_CALL` (research D15/D17, FR-014d).
  - **Proxy:** in `proxy/interception.py`, `Condition.__init__` / its evaluate method (explore `Condition`) accepts `subject: 'RECORDED_CALL'`, `operator: 'MATCHES'`, `answerId` and `ignore: [paths]`. It compares the request **as it is at that point in the pipeline** (method, path, query, and the canonical JSON body - reuse `_squash_json` - or the text body) with the recorded request loaded from the answer store, removing `ignore` paths and the cycle noise paths first. Headers are compared only when `headers: true`.
    - **Answer store:** for global rules it is `proxy/interception/answers/`; for a Relive run it is the run's `relive/answers/<runId>/` (the `_AnswerCache` that `relive.py` points there, T033). The engine passes the store to `Condition` with the ruleset.
    - **Safety:** a missing or unreadable answer, or one that is not a request, makes the condition **false** ("differs"), never true. A test covers it.
  - **Definition form:** in a cycle's call rule the condition carries `recordedStepKey` instead of `answerId`; the backend (T035) swaps it for an `answerId` in the snapshot. `RuleValidator` accepts exactly one of the two.
  - **Backend:** add the condition to `RuleValidator` (`backend/backend-interception/.../domain/model/RuleValidator.java`): `answerId` must be a UUID and `ignore` ≤ 50 paths.
  - **Frontend:** add a UI row to the Condition editor in `FE/components/rule-editor/` (explore `IF_REQUEST` there): "request matches a recorded call (ignoring noise)" with a call picker for the recorded call. It works in global rules too.
  - **Tests:** `test_interception.py` (equal, edited, noise-only difference); a `RuleValidatorTest` case; a rule-editor spec case.
- [X] T032 [US2] Hook the addons.
  - **Outbound:** in `proxy/log_and_route.py` `request()` (line ~155), right after `take_resend_headers`, call `relive.attribute(...)`.
    - **Attributed:** pass the run's rulesets to the engine, and set `flow.metadata['relive'] = {runId, stepKey, attribution, choice}`.
    - **Unattributed but the request would match a REPLAY child of an active run:** apply that step's `unattributed` choice (BLOCK answers `502 {"error":"Blocked by ALFRED Relive - unattributed"}`, REPLAY_ANYWAY applies the call rule, SEND_REAL does nothing).
    - **Attributed but matching no step:** apply `unexpectedCalls` (T034).
    - **AMBIGUOUS** (FR-050a): answer `502 {"error":"Blocked by ALFRED Relive - claimed by more than one run","runIds":[…]}` and never forward, whatever any step's `unattributed` choice says (even SEND_REAL). Set `flow.metadata['relive'] = {ambiguousRunIds:[…], attribution:'AMBIGUOUS'}`.
    - **Test:** two active snapshots whose REPLAY children both match one unattributed call, one with `unattributed: SEND_REAL`: the call is blocked, never forwarded.
  - **Isolation (SC-010):** two active runs from different cycles plus one call unrelated to either (no snapshot
    matches it, no run claims it): assert exactly 0 calls are wrongly replayed, rewritten or blocked across the
    two runs - each run only ever touches its own children, and the unrelated call passes through untouched.
  - **Inbound:** `proxy/log_and_route_reverse.py` gets the same change for inbound steps (HEADER attribution; Guided: the project's guided run).
  - **Logging:** add the `relive` dict and `reachedUpstream: bool` to the logged-call payload next to `resend_of` (explore how `resend_of` is sent).
  - **Test:** the addon-level tests in `test_relive.py` use the same fake-flow helpers `test_interception.py` uses.
- [X] T033 [US2] REPLAY answers and the request-differs flow.
  - **Mocks:** a REPLAY child's `callRule` already contains `MOCK_RESPONSE` with inline status, headers and body. Confirm that the existing `MOCK_RESPONSE` action code serves it. If a body is over the action's inline limit (check `RuleValidator` limits), the backend stores it as an answer file under `proxy/interception/relive/answers/<runId>/<answerId>.{meta.json,body}` (same format as `proxy/interception/answers/`; see `_AnswerCache`) and the action references it. Extend `_AnswerCache` usage so `relive.py` can point one at `relive/answers/<runId>`.
  - **FR-018:** a REPLAY child whose answer is missing must FAIL (502) and never forward. Add that guard in `relive.py`.
  - **ASK:** `PAUSE_REQUEST` goes through the existing `breakpoints.py`, with the paused registration carrying `relive: {runId, stepKey, at:'CHANGED'}` (look at how the pause spec's metadata reaches `breakpoints.snapshot`). When time runs out, the default action is the failure mock, never forwarding.
  - **Test:** in `test_relive.py`.
- [X] T034 [US2] Unexpected outbound calls (FR-014f), in `proxy/relive.py`.
  - **BLOCK** (default): answer `502` `{"error":"Blocked by ALFRED Relive","runId":…}` without contacting upstream.
  - **SEND_REAL:** forward.
  - **RULES:** evaluate the snapshot's `unexpectedCalls.rules` with the engine (first match wins, then `fallback`).
  - **Logging:** log `relive.unexpected=true`.
  - **Test:** in `test_relive.py`.

### Backend

- [X] T035 [US2] Create `BR/application/service/RunSnapshotBuilder.java`. It turns a run's `definition` into the snapshot JSON of `contracts/proxy-snapshot.md`:
  - `version`, `runId`, `cycleId`, `driver`, `globalRules`, `projects`, `variables` (secret values included, because the proxy needs them to render; `secrets` lists their names), `steps[]` with `children[]`, `cycleRules`, `unexpectedCalls`;
  - per child: `stepKey`, `ordinal` (position among siblings with the same method + host + path), `match` (from `callRule.match`, else endpoint + order), `callRule`, `unattributed`, `recordedRequest`.
  - **Answers:** writes answer files under `relive/answers/<runId>/` through `RunSnapshotPublisherPort`:
    - for oversized mock bodies (T033);
    - **the recorded request of every child whose call rule has a `MATCHES_RECORDED_CALL` condition** (FR-014d; contracts/proxy-snapshot.md "Recorded request file"): `meta.json` = `{kind:"RECORDED_REQUEST", method, path, query, headers}`, `.body` = the recorded request body, byte for byte. Replace the condition's `recordedStepKey` with the new `answerId`. Without this file every REPLAY child's request counts as "differs".
  - **Test:** `BRT/application/service/RunSnapshotBuilderTest.java`: the snapshot for the mock's Book-flow cycle - ordinals are correct; secret names listed; ALL / SELECTED global rules passed through; every REPLAY child's condition has an `answerId` whose request file holds the recorded body unchanged; no `recordedStepKey` is left in the snapshot.
- [X] T036 [US2] Create `BR/adapter/out/snapshot/FileRunSnapshotPublisher.java`, implementing `RunSnapshotPublisherPort`.
  - **Directory:** `${ALFRED_INTERCEPTION_DIR:/proxy-interception}/relive/`. Find the real env var/property that `FileRulesPublisherAdapter` in backend-interception uses and reuse it.
  - **Writes:** atomic (temp file + `Files.move(ATOMIC_MOVE)`), exactly like `FileRulesPublisherAdapter`.
  - **Removal:** `unpublish` deletes the run file and its answers directory.
  - **Test:** with `@TempDir`.

### Frontend

- [X] T037 [US2] Call rule section of the step drawer, in `FE/components/relive-step-drawer/`. It copies mock.html `modeButtons()`, `callRuleSection()`, `actLine()`, `hostCard()`, `setCp()`, `configTab()`.
  - **Mode:** the Execution mode segment: 3 buttons for children, LIVE / REPLAY for inbound.
  - **Call rule preview:** Match line (method + host + path + `#n in Parent` + a `custom` / `endpoint + order` pill); "1 Request - before it leaves ALFRED" with each action's summary line, off actions dimmed with an "off" pill; the "The host" card, whose 3 variants are exactly the mock's texts; "2 Response - after the host answers".
  - **Buttons:** "Open call rule…" (T039), "＋ / − Pause before", "＋ / − Pause after", "When the request differs: X…" (T038), "Reset call rule…" (T028's confirm).
  - **Request tab:** editable. Edits are saved as a `SET_REQUEST_BODY` action ("saved as 'Replace the request body' in the call rule"). On blur of a REPLAY child's request, if the "request differs" choice was never made for that step, open T038 (mock `askIfEdited`).
  - **Response tab:** edits the enabled mock's (or replace's) status, headers and body (mock `drawerBody` response branch). It says "Your edits stay even if you switch to LIVE and back."
  - **Test:** `relive-step-drawer.component.spec.ts`.
- [X] T038 [US2] "When the request differs" dialog: `FE/components/relive-request-differs-dialog/…`. It copies mock.html `openChanged()`, `CHG`, `setChanged()`, `confirmCallLive()`.
  - **Choices:** four cards: Mock a failure (default, with an editable status), Ask me, Replay recording anyway, Call live ⚠.
  - **Call live:** opens the danger confirmation, whose button stays disabled until "I understand … will be contacted" is ticked.
  - **Parent banner:** add mock `editedParentBanner()` to an inbound step whose request was edited: set all REPLAY children at once; "Call live" asks for confirmation first.
  - **Test:** Call live can't be chosen without ticking the confirmation.
- [X] T039 [US2] Reuse the real rule editor (research D14, FR-029a/b).
  - **Save target:** in `FE/components/rule-editor/rule-editor.component.ts`, add an injection token `RULE_EDITOR_TARGET` (new file `FE/components/rule-editor/rule-editor-target.ts`). Its interface is `{ save(draft: InterceptionRuleDraft, ruleId: string|null): Observable<InterceptionRule|InterceptionRuleDraft|null> }`, and the default provider saves through `InterceptionStateService.createRule/updateRule` (today's behaviour). Replace the direct calls inside `save()` (line ~2060) with the target.
  - **Scope:** add `@Input() scope: 'GLOBAL'|'CYCLE'|'CALL'|'UNEXPECTED' = 'GLOBAL'`.
    - `CALL`: the Match section shows the step's match (editable) and "#n in Parent". The pipeline shows "The host" card between Request and Response (the `hostCard` equivalent). A warning banner appears when saving would make the call reach the host (mock `renderRuleEditor` ext-banner).
    - `CYCLE` / `UNEXPECTED`: the header pill and hint text from the mock.
  - **Relive host:** Relive opens the editor through a new `FE/pages/relive-cycle/relive-rule-dialog.service.ts`, modelled on `RuleDialogService`, that provides a `RULE_EDITOR_TARGET` writing into the cycle draft. "Pick from anywhere" parking must return to `/relive/:id` (`goToCall` flow).
  - **Existing tests:** the rule-editor specs must stay green.
  - **Test:** a new spec with a stubbed `actionTypes()` catalog containing an unknown future type proves it is offered and saved in `CALL` scope (the guard test in D14).
- [X] T040 [US2] External-reach watcher (FR-015a). In the editor state (T024), add an `effect` that computes `externalReach(draft)` after each change, diffs it against the previous value with `newlyReaching`, and pushes a notice.
  - **Notice:** a new small component `FE/components/relive-external-notice/…` stacked bottom-left, copying mock `notifyExternal()`. It reads "**Label** can now contact the real **host** - reason." with ↶ Undo (restores the draft snapshot taken before the edit) and "That's intended".
  - **No setup noise:** loading, resetting, or a rebuild's apply must not notify - pass a `quiet` flag.
  - **Test:** turning off a mock notifies; Undo restores; an internal host doesn't notify.
- [X] T041 [US2] Cycle-level inbound switch (FR-011 clarification): in the Rules or Settings area of the cycle page, "inbound: LIVE / REPLAY".
  - **Effect:** changing it runs `applyMode` on every inbound step's call rule.
  - **Hand-edited steps:** steps where `isModified` is true are listed in a confirm dialog first ("these N steps have hand-edited call rules - apply anyway?").
- [X] T042 [US2] Unexpected-calls section in the Rules tab. It copies mock.html `unexpectedSection()` and `handleUnexpected()` wording.
  - **Policy:** Block (default) / Send to the real system ⚠ / Handle with my rules.
  - **Rules:** a list of UNEXPECTED rules edited with the T039 editor in `UNEXPECTED` scope, plus a fallback choice.
  - **Warning:** changing the policy to send-real triggers the T040 notice.
- [X] T043 [US2] Attribution choice per REPLAY child (FR-049a): the "If ALFRED can't tell the call is yours" choice in the drawer (Block default / Replay anyway / Send to real system), with the mock's hint text.
- [X] T044 [US2] Pre-run dialog `FE/components/relive-prerun-summary/…`. It copies mock.html `openPrerun()`.
  - **Driver:** segment Automatic / Guided.
  - **Findings:** blocking findings with a "Define it" fix link.
  - **"May reach external systems":** children whose request-differs choice is LIVE, and a send-real unexpected policy.
  - **"Can reach external systems (N)":** one `ext-banner` per call from `externalReach`.
  - **Unattributed choices:** per call.
  - **Warnings.**
  - **Failure policy:** the "When something goes wrong" policy section (mock `policySection()`, used by US3).
  - **Confirmation:** the LIVE checkbox "I understand N calls will contact real external systems"; Start stays disabled until it's ticked, and while blocking findings remain (FR-016/017).
  - **Test:** Start is disabled with LIVE calls until ticked, and with a BLOCK finding.
- [X] T045 [US2] Validation: `BR/application/service/CycleValidator.java` (backend, authoritative), mirrored by `FE/shared/utils/relive-validate.ts` for instant feedback.
  - **Codes:** UNRESOLVED_VARIABLE, MISSING_RECORDING, DUPLICATE_STEP, GLOBAL_RULE_GONE (via `GlobalRulesLookupPort`), RULE_OVERLAP, NOTHING_TO_RUN, MAY_BE_UNATTRIBUTED, LIVE_EXTERNAL, UNUSED_VARIABLE, ORDER_DEPENDENCY. Severities as in data-model.md. Variable references are found with the same regex as `FE/shared/utils/variable-tokens.ts` `VARIABLE_TOKEN`.
  - **Endpoint:** `POST /relive-cycles/{id}/validate` returns them.
  - **Tests:** `CycleValidatorTest.java` (one case per code) and `relive-validate.spec.ts`.

**Checkpoint**: quickstart.md's SC-002 check passes; walkthroughs 2, 4, 11, 12 reproducible (until "Run", which is US3).

---

## Phase 5: User Story 3 - Run a cycle and follow it live (P1)

**Goal**: FR-030-034d, 044a; research D1, D13. **Independent test**: US3 scenarios 1-7 + 6a-6c; mock walkthroughs
**4 Run** and **10 Continue after a failure**.

- [X] T046 [US3] Create `BR/application/port/in/` `StartRunUseCase`, `RecordStepResultUseCase`, `StopRunUseCase`, `FinishRunUseCase`, `HoldRunUseCase`, `ResumeRunUseCase`, `UpdateRunDefinitionUseCase`, `ListRunsUseCase`, `GetRunUseCase`, `SetRunVariableUseCase`, and implement them in `BR/application/service/ReliveRunsService.java`.
  - **start:**
    1. Validate (422 on BLOCK findings).
    2. Snapshot the definition into the run.
    3. `publish(snapshot)`, then status RUNNING.
    4. `runChanged`.
  - **recordStepResult:** PUT per attempt, which also updates the summary.
  - **setVariable:** republish when the variable is used by a rule.
  - **stop / finish / interrupt** (FR-033, FR-003c): never unpublish at once. This order is a safety rule: an in-flight
    inbound step whose REPLAY children are not answered yet would otherwise send them to the real supplier.
    1. Set the status (STOPPED / FINISHED / INTERRUPTED) and cancel the remaining steps.
    2. Republish the snapshot with `state: "STOPPING"` (contracts/proxy-snapshot.md).
    3. Unpublish when `inflight.json` has no entry with this `runId` (T050 calls `ReliveRunsService.onInflightDrained(runId)`),
       or 30 s after step 2, whichever comes first. Use the same `ScheduledExecutorService` as T047.
    4. `runChanged`.
    5. **Transient cleanup (FR-003c):** if the run's cycle is `transient: true` (an unsaved "Relive now") and was
       not saved via "Save as cycle" before this point, delete the cycle and this run once the run reaches a
       final status (FINISHED/STOPPED/FAILED/INTERRUPTED). A cycle saved mid-run (`transient` cleared) is kept
       normally.
    - **Test:** stop with one in-flight inbound call: the snapshot is STOPPING, not removed; it is removed on
      drain; with no drain it is removed after 30 s (controllable clock). A transient cycle finishing unsaved is
      deleted; one saved mid-run is kept.
  - **hold:** set `hold_json` and log HELD / CONTINUED.
  - **resume** (FR-034d):
    1. Only from FAILED / STOPPED / INTERRUPTED.
    2. Republish the run's own definition.
    3. Status RUNNING, and add `resumed[]`.
    4. 409 if another tab holds the lease.
  - **updateDefinition** (FR-044a): merge the changed steps not yet executed (409 if any has a result), then republish.
  - **Retention:** after finish, `pruneRuns`.
  - **Test:** `ReliveRunsServiceTest.java`, one test per bullet.
- [X] T047 [US3] Create `BR/application/service/RunLeaseRegistry.java` (D1).
  - **Tracking:** which WebSocket sessions hold which runId.
  - **Interrupt:** 15 s after the last holder goes, `ReliveRunsService.interrupt(runId)` sets INTERRUPTED and
    follows the same STOPPING drain as stop (T046); it never unpublishes at once. Use a `ScheduledExecutorService`; this is event-driven, not polling.
  - **Startup:** every RUNNING run from before the restart becomes INTERRUPTED, and its snapshot file (if still in
    `relive/`) is republished as STOPPING and removed 30 s later.
  - **Test:** with a controllable clock/executor.
- [X] T048 [US3] Create `BR/adapter/in/web/ReliveRunsController.java`, covering the "Runs" table of `contracts/rest-api.md` (runs, attempts, variables, stop, finish, hold, resume, definition, save-edits, compare).
  - **Test:** `ReliveRunsControllerTest.java`, including the 422 on blocking findings and `limit` clamped to 100.
- [X] T049 [US3] Resend carries the run.
  - **Where:** `backend/backend-resend/.../domain/model/ResendRequest.java` + `adapter/in/web/dto/ResendRequestDto.java` gain an optional `relive: {runId, stepKey}`.
  - **Headers:** `ResendService` (next to `RESEND_OF_HEADER`, line ~55) then adds `X-Alfred-Relive: <runId>/<stepKey>` and `X-Operation-Id: relive-<runId>-<stepKey>` (only when `relive` is present).
  - **Test:** `ResendServiceTest`: both headers added, nothing else changed.
- [X] T050 [US3] Observers and in-flight tracking, in `APP/relivebridge/ReliveCallObserverAdapter.java`. It implements `NewCallObserverPort` (backend-calls) and `NewInternalCallObserverPort` (backend-internal-calls). It forwards to a new `BR/application/port/in/ObserveRunCallUseCase` implemented by `ReliveRunsService`, which:
  - maintains `inflight.json` while any run is active (including STOPPING runs): on `onCallPrepared`, add the inbound call for its project; on `onCallCompleted`, remove it; `runId` is set when the call carried the relive header. When the last entry of a STOPPING run is removed, call `ReliveRunsService.onInflightDrained(runId)` (T046);
  - broadcasts `run-call` events for calls with a `relive` field;
  - for a call whose `relive.ambiguousRunIds` is set, appends an `AMBIGUOUS_BLOCKED` log entry to **each** of those runs (FR-050a) and broadcasts `runChanged` for each;
  - adds a `LiveCall` when `reachedUpstream` is true (used by US7's log, D18).
  - **Logged-call field:** add the `relive` + `reachedUpstream` fields to backend-calls and backend-internal-calls `CallRecord` (optional, trusted like `resend_of` - explore how `resend_of` flows from webhook DTO to record).
  - **Test:** `ReliveCallObserverAdapterTest`, plus a service test for inflight add/remove.
- [X] T050a [US3] Relive badge on logged calls (FR-051). `FE/components/call-card/call-card.component.ts` gains
  an optional input carrying the call's `relive` field (set by T050/T032, `{runId, stepKey}` or `{ambiguousRunIds}`);
  when present, render a small badge "Relive · <cycle name>" (tooltip: run id, step). Wire the input from
  `call-list.component.ts` (Live Calls) and the session-cycle capture view, both of which already render
  `call-card` per call - no new lookup, just pass the field through if the call record has it.
  - **Test:** `call-card.component.spec.ts`: badge shown only when `relive` is set; the ambiguous case shows
    "Claimed by 2 runs" instead of a cycle name.
- [X] T051 [US3] Create `FE/shared/utils/relive-outcome.ts`: `outcomeOf(result, recording, assertionsResult, noise): 'COMPLETED'|'COMPLETED_WITH_DIFFERENCES'|'FAILED'`, following FR-034a exactly.
  - **FAILED** on: transport error, timeout, no answer, 5xx, a status-class change, or a failed assertion.
  - **DIFFERENCES** on at least one UNEXPECTED difference.
  - **Test:** `relive-outcome.spec.ts`, with the clarification's example table (Price 450 → 455 is yellow; 201 → 500 is red).
- [X] T052 [US3] Create `FE/core/state/relive-run.service.ts`, the Automatic orchestrator (component-provided on the cycle page). It follows mock.html `startRun`, `tick`, `runStep`, `afterSettle`, `finish`, `stopRun`.
  - **start:** `POST runs` and `holdLease`.
  - **Per inbound step, in order:**
    1. Substitute variables with `substituteDraft` / `substituteTokens` from `FE/shared/utils/resend-draft-chain.ts`, and `resolveDynamicTokens` from `dynamic-tokens.ts`.
    2. `POST /resend` through the existing `ResendApiService` with `relive:{runId, stepKey}`.
    3. Mark the children WAITING.
    4. Wait for `run-call` events of this step, and for the resend result.
    5. For each child, fetch its logged call and build its StepResult: mode, attribution, request / response, `differences` (T060 later; until then, empty), outcome (T051), duration.
    6. Children never called become NOT_CALLED.
    7. `extractValues` → run variables (`POST …/variables`).
    8. `PUT` attempts.
  - **Progress:** `done/total`, elapsed time, and per-step and total durations as signals.
  - **stop:** remaining steps CANCELLED; the backend unpublishes.
  - **Test:** `relive-run.service.spec.ts` with fake API / socket: happy path; a child never called; stop.
- [X] T053 [US3] Hold on failure / differences (FR-034, 034c; D13), in `relive-run.service.ts`. It copies mock `afterSettle`, `dependents`, `skipDependents`, `haltBox`, `haltRetry`, `haltEdit`, `haltContinue`, `haltEnd`, `PRODUCES` logic.
  - **Holding:** `settings.onFailure` / `onDifferences` decide whether to hold; `PUT …/hold`.
  - **Dependent steps:** later steps whose `{{refs}}` include a variable only the failed step extracts, and which has no value, are listed. On Continue they are SKIPPED with `skipReason:'MISSING_VARIABLE'` and an error text like "Skipped - needs {{bookingId}}, which Book did not produce".
  - **"Keep going":** takes the same path without waiting.
  - **Test:** Book fails → Continue → Booking details is SKIPPED, while Profile and Logout run; the final status is FAILED ("continued past 1").
- [X] T054 [US3] Resume and mid-run edits.
  - **Resume:** "▶ Continue with the rest" on a failed step of an ended run (mock `resumeRun`, the run-row buttons in `runPanel`) calls `POST …/resume`, re-takes the lease and continues at the step after it.
  - **Mid-run edits** (FR-044a): while a run is RUNNING, any editor change asks "Apply to this run too, or only next runs?" (a small dialog). "This run" calls `PUT …/runs/{runId}/definition`.
  - **Test:** in `relive-run.service.spec.ts`.
- [X] T055 [US3] Run view `FE/components/relive-run-timeline/…`. It copies mock.html `runPanel()`, `statePill()`, `stIcon()`, `haltBox()`, `policySection()`.
  - **Header:** run title pill (running / holding - your call / completed / …), driver pill, progress bar `done / total completed`, total seconds.
  - **Boxes and banners:** the hold box (red for failures, amber for differences), the pause box (US3b), and the "N calls reached a real system - saved" banner (US7).
  - **Filters:** All / In progress / Differences / Failed / LIVE / REPLAY.
  - **Step rows:** state circle, direction arrow, method, label + url, mode pill (`LIVE · contacted host (· reply mocked)`), GLOBAL RULE pill, `⚠ n differences`, `✕ status`, `attempt n`, `request changed…` pill, `💾 saved`, the Retry / Continue with the rest / Run from here buttons on a failed row of an ended run, state pill, duration.
  - **Variables panel:** masked secrets with a "reveal" link.
  - **Live updates:** within 1 s (SC-005), driven by signals.
  - **Test:** a component spec renders each state.
- [X] T056 [US3] Unexpected calls and request-changed in the run.
  - **Unexpected calls:** under the timeline, the "Unexpected outbound calls (n) - matched no step" card (mock `runPanel` bottom), fed by `run-call` events with `unexpected=true`.
  - **Request-changed hold:** when a `PAUSE_REQUEST` with `relive.at==='CHANGED'` arrives (via the existing paused-calls feed - explore `PausedCallsComponent` / interception-state paused signal), show the CHANGED pause box (mock `pauseBox()` CHANGED branch).
    - **Timer:** ring timer.
    - **Diff:** a diff row, and a "compare the whole request with the recording →" link.
    - **Buttons:** Replay recorded answer / Edit answer & replay / ⚠ Send to real (second confirmation) / ✕ Mock a failure / ■ Stop run. They release through `POST /interception/paused/{id}/decision`.
    - **Wording:** "no decision = mocked failure".

**Checkpoint**: US1-3 = MVP. A full Automatic run of the quickstart cycle with Supplier A REPLAY, B LIVE, C REPLAY
completes; failure hold / continue works.

---

## Phase 6: User Story 3b - Checkpoints: pause before / after, replay until satisfied (P2)

**Goal**: FR-035a-c; research D11. **Independent test**: US3b scenarios; mock walkthrough **5 Pause & replay**.

- [X] T057 [US3b] Checkpoints in the orchestrator, in `relive-run.service.ts`. Copy mock `pauseAt`, `pContinue`, `pReplay`, `pEditReplay`, `applyEditReplay`, `pSkip`.
  - **Inbound steps ALFRED sends:** "pause before" / "pause after" come from `checkpointOf(callRule)`. The pause is in the tab, before POST / after the result: nothing is held in the proxy.
  - **Outbound children:** the call rule's `PAUSE_REQUEST` / `PAUSE_RESPONSE` hold the call in the proxy through breakpoints. Show the pause box with a ring timer; decisions go through the existing breakpoint decision endpoint.
  - **Attempts:** Replay and Edit & replay create attempt n+1. Every attempt is kept (`PUT …/attempts/{n}`).
  - **Edits:** run-only unless "Also save these edits to the cycle" is ticked (`POST …/save-edits`).
- [X] T058 [US3b] Pause box UI in `relive-run-timeline`. It copies mock `pauseBox()` (non-CHANGED branches) and `updateRing()`: the attempts strip `#n ✓/✕/⚠ status ✎`, the request / response preview, and the button sets exactly as the mock builds them for held vs not-held and before vs after.
  - **Test:** a component spec.

---

## Phase 7: User Story 4 - Step details, differences, Compare (P2)

**Goal**: FR-038-043, 014g, 041a-c; research D16. **Independent test**: US4 scenarios; walkthrough **6 Inspect
differences**.

- [X] T059 [P] [US4] Create `FE/shared/utils/relive-noise.ts`.
  - **Auto detectors:** ids, tokens, timestamps (ISO/epoch), Date / ETag / trace headers, values equal to a variable that was extracted or substituted (these are EXPECTED, not noise).
  - **User rules:** step and cycle `NoiseRule`s; `count:true` overrides an auto decision.
  - **`classify(diffs, ctx)`** tags each difference `EXPECTED | NOISE_AUTO | NOISE_USER | UNEXPECTED` with a `cause` (a rule name, variable, or detector).
  - **Test:** `relive-noise.spec.ts`, including the mock's Supplier B example: 2 unexpected, 1 expected (the GLOBAL rule), 1 noise (traceId).
- [X] T060 [US4] Compute differences in the orchestrator: for each settled step, build recorded vs actual with `buildHttpDiff` (`FE/shared/utils/interception-diff.ts`), flatten the JSON body paths, then `classify` (T059). Store the result in `StepResult.differences`.
- [X] T061 [US4] Run-mode step drawer tabs, in `relive-step-drawer`. They copy mock `drawer()` run tabs and `runOverview()`:
  - **Configure:** state, mode, attribution, status vs recorded, duration vs recorded, error, attempts, checkpoints, the differences summary pills with "inspect →", and a quick look.
  - **Original / Effective** (variables highlighted, as `highlightVars`) / **Actual**.
  - **Rules & variables:** tier pills STEP / CYCLE / GLOBAL, in order.
  - **Log.**
- [X] T062 [US4] Compare tab (D16): reuse `InterceptionPanelComponent` (`FE/components/interception-panel/`, inputs `interception`, `phase`, `embedded`, `labels`).
  - **Inputs:** build a `CallInterception` from `step.recording` (before) and the StepResult's actual request / response (after), with `labels = {title:'Recorded vs this run', before:'Recorded', after:'This run', legend:'Red is what the recording had; green is what happened this run.'}`. Add Request / Response toggles.
  - **Step strip:** extract the 1-7 strip markup from `FE/components/resend-panel/resend-panel.component.html` into a presentational `FE/components/call-step-strip/call-step-strip.component.ts` that both resend-panel and Relive use. The resend-panel specs must stay green. The Relive strip is Recorded call → Your edits → Variables → Sent → Rules → Upstream / ALFRED answered → Response (mock `compareBox`).
  - **Below the compare:** "What ALFRED makes of it" - Unexpected, Expected (with the cause), and noise (collapsed), each with "Ignore this field" (mock `diffTab`, `ignoreField`, `doIgnore`: only for this step / for the whole cycle).
  - **Test:** Compare renders for a LIVE and a REPLAY step.
- [X] T063 [US4] Masking (FR-022, FR-022a). The backend returns everything in full plus `secrets: string[]` (contracts/rest-api.md masking note); masking is the frontend's job, as in the rest of ALFRED.
  - **Helper:** add `maskRelive(text, secrets, values)` in `FE/shared/utils/relive-mask.ts`. It first applies the existing `redact.ts` helpers (redaction rules, Authorization and cookie headers), then replaces every value of a variable named in `secrets` with `•••`. Do not change `redact.ts` itself.
  - **Where:** every place that shows a body, header or variable value goes through it: the step drawer, Compare (T062, before building the `CallInterception`), the run log, the variables panel (T065), the Live calls log (T074) and the run exports (T079).
  - **Reveal:** a per-view "Reveal" toggle, a component signal, never saved; it resets when the view closes.
  - **Test:** `relive-mask.spec.ts` (secret value in body, header and URL; redaction rule; Authorization header), and one spec per view above that the value is masked until Reveal is clicked.

---

## Phase 8: User Story 5 - Cycle variables and extraction (P2)

**Goal**: FR-019-024. **Independent test**: US5 scenarios; the Variables tab of the mock (`varsPanel()`).

- [X] T064 [US5] Variables tab `FE/components/relive-variables/…`, copying mock `varsPanel()`: name, initial value, secret toggle, source (defined / extracted · Step → path), note, and the live value column during a run (masked with "reveal").
  - **Test:** a component spec.
- [X] T065 [US5] Extract & assert tab in the drawer, copying mock `extractTab()`.
  - **Extract:** "＋ Extract a value…" uses the existing `JsonPathInputComponent` (`FE/components/json-path-input/`) on the recorded response, producing `ExtractRule`s (same shape as Scenarios).
  - **Assertions:** use `ScenarioAssertionEditorComponent` (`FE/components/scenario-assertion-editor/`), which is reused, not copied.
  - **Evaluation:** assertions are evaluated in the orchestrator with `evaluate` from `FE/shared/utils/scenario-assertions.ts`.
- [X] T066 [US5] Unresolved-variable blocking (FR-024): the orchestrator refuses to send a step with an unresolved `{{name}}` and marks it FAILED with "unresolved {{name}}". Pre-run validation already reports it (T045).
  - **Test:** in `relive-run.service.spec.ts`.

---

## Phase 9: User Story 6 - Cycle rules and global rules (P2)

**Goal**: FR-025-029b. **Independent test**: US6 scenarios; walkthrough **3 Rules**.

- [X] T067 [US6] Rules tab `FE/components/relive-rules-panel/…`, copying mock `rulesPanel()`, `copyRule()`.
  - **CYCLE rules:** a list with Edit (T039 editor, `CYCLE` scope) and ✕, plus "＋ New cycle rule".
  - **GLOBAL rules:** a segment No global rules / All / Selected, the global rules list (from `InterceptionStateService`) with checkboxes in Selected mode, and "applies / ignored in this cycle".
  - **"Copy into cycle":** clones the rule into `cycleRules` with `copiedFrom {ruleId, name, copiedAt}`.
  - **Also on this tab:** the RULE_OVERLAP warning, and the T042 unexpected-calls section.
  - **Test:** copy creates an independent rule; editing the copy doesn't touch the global rule.
- [X] T068 [US6] Per-step "rules applied" (FR-028): the proxy's logged `relive.ruleIds` plus the tier are shown in the drawer's "Rules & variables" tab in order. Add `ruleIds` and tiers to the logged-call `relive` field in `proxy/relive.py` (T032).

---

## Phase 10: User Story 6b - Rebuild, and Relive from a selection (P3)

**Goal**: FR-003b-d, 007a-c; research D12. **Independent test**: US6b scenarios; walkthroughs **8 Rebuild** and
**9 Relive ▾ from Live Calls**.

- [X] T069 [P] [US6b] Create `FE/shared/utils/relive-match.ts`: `pairSteps(oldSteps, newSteps)` returns `{matched:[old,new][], added, removed}` on endpoint + order within the same parent (the same key as the proxy's ordinal).
  - **Test:** `relive-match.spec.ts`.
- [X] T070 [US6b] Rebuild dialog `FE/components/relive-rebuild-dialog/…`, copying mock `openRebuild()`, `rebuildPreview()`, `applyRebuild()`, `undoRebuild()`.
  - **Modes:** Refresh from sources / Rebuild from a new recording (pick a session cycle, or "run it once for real", which goes through the pre-run LIVE confirmation) / Start over, keep settings.
  - **Preview:** added / updated / re-linked / removed, and what happens to each step's settings.
  - **Apply:** `PUT ?reason=…`.
  - **Undo:** a toast with Undo calls `versions/{v}/restore`.
- [X] T071 [US6b] "Relive ▾" menu on selections. Add it to `FE/components/bulk-actions-bar/` and `FE/components/call-actions/` (the ⋯ menu), copying mock `openLiveCalls()`, `reliveAction()`, `applyReplace()`.
  - **Menu items:**
    - Add to cycle… (pick a cycle);
    - New cycle from selection;
    - ⚡ Relive now: `POST ?transient=true`, then open it with the run started, all REPLAY; the banner "not saved" offers "Save as cycle";
    - Replace steps of cycle…, with a preview and undo.
  - **Existing specs:** the specs of both components must stay green; add one case each.

---

## Phase 11: User Story 7 - Run history and the Live calls log (P3)

**Goal**: FR-044-047, 015b-c; research D18. **Independent test**: US7 scenarios; after walkthrough 6, the History tab
shows the run and its live call.

- [X] T072 [US7] History tab `FE/components/relive-history/…`, copying mock `historyPanel()`, `compare()`.
  - **Runs table:** when, status pill, summary (including "continued past N"), duration, Open, and "Compare with newest".
  - **Compare:** reuses `ScenarioRunCompareComponent` (`FE/components/scenario-run-compare/`) via an adapter from StepResults to its input shape. If its input doesn't fit, add an input there rather than copying it.
- [X] T073 [US7] Live calls log, backend: `BR/adapter/in/web/LiveCallsController.java` (list / get / delete / use-as-recording, per `contracts/rest-api.md`).
  - **Use-as-recording:** replaces the matched step's `recording` and its call rule's `MOCK_RESPONSE` data through the versioned update (reason `USE_LIVE_CALL`; add it to the reason enum).
  - **Size:** `totalBytes` is returned in a response header `X-Live-Calls-Bytes` on the list.
  - **Test:** a controller + service test; live calls survive run pruning.
- [ ] T074 [US7] Live calls log, frontend, in the History tab. It copies mock `liveLogPanel()`, `useAsRecording()`, `applyRecording()`, `mockWith()`, `applyMockWith()`, `openLiveCompare()`, `delLive()`.
  - **Table:** when + run, call, why it went live, status + ms.
  - **Actions:**
    - Use as recording (red/green preview, Undo);
    - Mock with it (pick a step's mock, or a new cycle rule);
    - Compare (the T062 component);
    - Resend (existing `ResendDialogService`, LIVE confirmation);
    - Export ▾ (existing export builders, never truncated);
    - ✕ (confirmation says the answer can't be fetched again without calling the supplier).
  - **Size:** the header shows the size; above `alfred.relive.live-calls.warn-bytes` (default 200 MB; read it from a settings endpoint, or hard-code the default in the frontend if none exists) show a warning with bulk delete and export (FR-015c).
  - **Run view:** the "saved" banner and the `💾 saved` badge in the run view.

---

## Phase 12: User Story 8 - Run from a step, optional steps, Guided driver (P3)

**Goal**: FR-036, 030a-c, optional steps. **Independent test**: US8 scenarios; mock "Run from here" and Guided in
walkthrough 4.

- [X] T075 [US8] Run from step: "Run from here" starts a new run with `fromStepKey` and `seedFromRunId`, and the backend copies the seed variables. Disable it with an explanation when an earlier step's output isn't available (spec US8 scenario 2).
- [X] T076 [US8] Optional steps: a failed optional step never holds or fails the run. When a failure has happened earlier, optional steps are SKIPPED if the policy says so (spec FR on optional).
- [X] T077 [US8] Guided driver (FR-030a-c), in `relive-run.service.ts` and `proxy/relive.py`. It copies mock `guidedNext()`, `guidedArrive()`, and the guided banner in `runPanel`.
  - **Snapshot:** `driver: GUIDED` plus `projects`.
  - **Attribution:** the reverse proxy attributes inbound calls of those projects to the guided run when it is the only guided run for that project; otherwise a validation finding `GUIDED_PROJECT_BUSY` (add it to T045).
  - **Matching:** the tab receives `run-call` events for inbound calls and matches them to the next expected step with `relive-match`.
    - **Out of order:** a call matching a later step marks the steps in between as skipped.
    - **No match:** unexpected.
  - **Ending:** "End run" marks the rest NOT_CALLED.
  - **Pauses (FR-035f):** a Guided step's `pause.before`/`pause.after` actions still run through `breakpoints.py`
    exactly as in Automatic - Guided only changes how the *next* step is chosen, not whether a matched step
    pauses. The pause box (T044) opens the same way; guidance resumes matching once the pause resolves.
  - **Test:** a Guided step with `pause.after` holds the run; the pause box shows; Continue resumes guidance.

---

## Phase 13: Polish & cross-cutting

- [X] T078 [P] Write `docs/relive.md`: what it is, the call-rule model, attribution, tiers, the snapshot, the live-call log, and troubleshooting. Add a one-paragraph pointer in `CLAUDE.md` and `AGENTS.md` ("Relive Cycles" under the project map); the evaluation tiers in `docs/interception.md`; the `MATCHES_RECORDED_CALL` condition in `docs/interception.md`; and `backend-relive` in the slice list of `docs/architecture.md`.
- [X] T079 [P] Exports: the run export (.md/.json/.html) reuses `FE/shared/utils/scenario-run-export.ts`'s approach and the existing builders. **Never truncate**: add a guard test like the existing no-truncation tests (`codegraph explore "no truncation guard test"`).
- [X] T080 Performance check: SC-009 (a 200-step cycle stays usable). Generate 200 steps in a spec and assert that the step tree renders within budget with `@for` + `track step.key`. SC-005: timeline updates within 1 s of a `run-call` event (fake timers).
- [X] T081 Run the full suites once: backend `mvn -B test` (Docker, JDK 21), frontend `npm test` and `npm run build`, proxy `python -m pytest -q`. Fix regressions.
- [ ] T082 Manual end-to-end with quickstart.md, following the steps below. Record the results in `specs/003-relive-cycle/checklists/requirements.md`.
  1. `docker compose up -d --build backend proxy reverse-proxy frontend`, then `docker compose restart app-gateway`.
  2. Run quickstart.md.
  3. Replay mock walkthroughs 1-12 in the real app.
  4. SC-010: start two Relive runs from different cycles at once, plus normal unrelated traffic through the
     proxy; confirm neither run's calls leak into the other and unrelated traffic is untouched.

---

## Dependencies & execution order

- **Setup (T001-T006)** → **Foundational (T007-T021)** → user stories.
- **US1 (T022-T028)**: needs Foundational.
- **US2 (T029-T045)**: needs US1's step model and drawer (T024, T027). The proxy tasks T029-T034 can start right after Foundational, in parallel with US1.
- **US3 (T046-T056)**: needs US2 (the snapshot must be published for a run to mean anything).
- **US3b, US4, US5, US6**: need US3, and are independent of each other.
- **US6b, US7, US8**: need US3. US7's live log backend (T073) needs T050.
- **Polish**: last.

Within a story: backend model / service → controller → frontend util → component → wiring. Tests sit in the same task
as the code they cover.

## Parallel opportunities

- Phase 1: T003, T004, T005, T006 together.
- Phase 2: T009, T014, T015, T017, T018, T019 together once T007 exists. T020 and T021 are pure utilities and can run any time after T006.
- US2: the proxy stream (T029-T034) ‖ the backend stream (T035-T036) ‖ the frontend stream (T037-T044).
- After US3: US3b ‖ US4 ‖ US5 ‖ US6 (different files, except the shared `relive-run.service.ts`, so serialise T057, T060 and T066 edits to it).

## Implementation strategy

1. **MVP = US1 + US2 + US3**: build cycles, per-call call rules with the REPLAY / LIVE safety, and run with holds.
   Stop and verify with quickstart.md (SC-002: the stub supplier receives exactly one call).
2. Add US3b + US4 (debugging depth), then US5 + US6 (workflow power).
3. Add US6b, US7 (including the Live calls log), US8.
4. Polish.

Per the owner's token budget: implement **in the main session, one task at a time**. At most one subagent at a time,
only for a large self-contained task (e.g. T029-T034 proxy stream), and its prompt must name the files and forbid
whole-file reads of `styles.scss` / `interception.py`.
