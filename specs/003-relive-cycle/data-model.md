# Data Model: Relive Cycle

**Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Wire and domain shapes. Java records in `backend-relive` (`domain.model`); the TypeScript mirror lives in
`frontend/src/app/shared/utils/relive-types.ts`. Names in `code` are the wire names.

## ReliveCycle

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | server-assigned |
| `name` | string | 1-120 chars, required |
| `description` | string | ≤ 2 000 chars |
| `steps` | `Step[]` | ordered; ≤ 500 top-level steps including children (clamped server-side) |
| `variables` | `CycleVariable[]` | names unique, `[A-Za-z_][A-Za-z0-9_]*`, ≤ 200 |
| `cycleRules` | `CycleRule[]` | ≤ 200 |
| `globalRules` | `{ mode: 'NONE' \| 'ALL' \| 'SELECTED', selectedIds: string[] }` | `selectedIds` only for `SELECTED` |
| `settings` | `{ inboundMode: 'LIVE' \| 'REPLAY', onFailure: 'HOLD' \| 'CONTINUE', onDifferences: 'CONTINUE' \| 'HOLD', defaultDriver: 'AUTOMATIC' \| 'GUIDED' }` | defaults `LIVE`, `HOLD`, `CONTINUE`, `AUTOMATIC` (FR-034) |
| `noise` | `NoiseRule[]` | cycle-wide ignore list (FR-041b/c) |
| `unexpectedCalls` | `{ policy: 'BLOCK' \| 'SEND_REAL' \| 'RULES', rules: CycleRule[], fallback: 'BLOCK' \| 'SEND_REAL' }` | default `BLOCK`, `[]`, `BLOCK` (FR-014f) |
| `createdAt`, `updatedAt` | ISO | server |
| `transient` | boolean | `true` for a "Relive now" quick run until saved; hidden from the list, deleted with its run unless saved |
| `lastRun` | `RunSummary \| null` | list view only |

Validation on save: unique step keys; every `parentKey` resolves to an inbound step; variable names unique; rule
documents pass the existing interception `RuleValidator`. Pre-run validation (FR-017) is a separate, richer pass
(see `ValidationFinding`).

## Step

| Field | Type | Rules |
|---|---|---|
| `key` | string | stable within the cycle (UUID); survives reordering; a duplicate gets a new key |
| `parentKey` | string \| null | set for an outbound child of an inbound step |
| `label` | string | defaults to `METHOD path`; editable |
| `enabled`, `optional` | boolean | defaults `true`, `false` |
| `direction` | `'inbound' \| 'outbound'` | from the recording |
| `serviceName` | string \| null | inbound project, or the calling project for an outbound child |
| `callRule` | `CycleRule` | the step's one call rule (FR-010a). Default built from the recording: children get a request-phase `MOCK_RESPONSE` {status, headers, body}; inbound gets one when the cycle's inbound mode is REPLAY. Actions carry `enabled` so a turned-off mock keeps its data |
| `mode` | derived, never stored | `REPLAY` when an enabled `MOCK_RESPONSE` (or a request-match `IF_REQUEST` leading to it) answers; `LIVE_MOCKED` when the host is reached and an enabled `REPLACE_RESPONSE` answers; else `LIVE` |
| `unattributed` | `'BLOCK' \| 'REPLAY_ANYWAY' \| 'SEND_REAL'` | REPLAY children only; default `BLOCK` (FR-049a) |
| `recording` | `FrozenCall` | full copy of the recorded call (D7) |
| `source` | `{ callId, cycleId: string \| null, direction }` | "open original"; may no longer exist |
| `extract` | existing `ExtractRule[]` | into cycle variables |
| `assertions` | existing `Assertion[]` | FR-034a |
| `noise` | `NoiseRule[]` | step-only ignore list |

Derived, never stored: `ordinal` (a child's position among siblings with the same match key), `external` (mode LIVE
and outbound, or inbound LIVE sent by ALFRED), `modified` (the call rule differs from its default), `checkpoint` (from the call rule's `PAUSE_REQUEST` /
`PAUSE_RESPONSE`), `onRequestChanged: 'FAIL' | 'ASK' | 'REPLAY' | 'LIVE'` (from the call rule's
`IF_REQUEST … MATCHES_RECORDED_CALL` else-branch: a `MOCK_RESPONSE` 502 = `FAIL` (the default for new REPLAY
children), `PAUSE_REQUEST` with a failure default = `ASK`, `SEND_TO_HOST` = `LIVE`; no condition = `REPLAY`). Request edits, response overrides,
the match and faults are all inside `callRule`; there are no separate fields for them.

## LiveCall

`{ id, cycleId, runId, stepKey | null, reason: 'LIVE' | 'LIVE_MOCKED' | 'CALL_LIVE' | 'ASK_SENT' | 'UNEXPECTED' | 'UNATTRIBUTED',
loggedCallId, request, response, status, durationMs, at }`. Full bodies; masked in the frontend (contracts/rest-api.md, masking note). Stored in
`relive_live_calls`, **not** subject to run retention (newest-50 / size cap); deleted only by the user (FR-015b).

## CycleVersion

`{ cycleId, version, savedAt, reason: 'REBUILD_REFRESH' | 'REBUILD_RECORDING' | 'REBUILD_START_OVER' | 'REPLACE_STEPS', definition }`,
the newest 10 per cycle, for undo (FR-007c). Not shown in the run history.

## FrozenCall

The recorded call as ALFRED already serves it in call detail: `method`, `url`, `requestHeaders`, `requestBody`,
`status`, `responseHeaders`, `responseBody`, `timestamp`, `durationMs`, `sessionId`, `operationId`, `serviceName`,
`source`. Bodies stored in full (never truncated); displayed masked per redaction rules.

## CycleVariable

`name`, `value` (initial, may be empty), `secret: boolean`, `note`. The run's variable timeline records every change
(`{ name, value, stepKey | null, at }`).

## CycleRule

An interception rule document in the existing model (`match`, `actions`, `priority`, `stopProcessing`,
`enabled`, `name`) plus `copiedFrom: { ruleId, name, copiedAt } | null`. Never written to the global rules store.
The same shape is used for cycle rules, each step's call rule (`Step.callRule`) and unexpected-call rules.
`actions[].type` is any type in the server's action catalog (`GET /interception/action-types`) - Relive keeps no
list of its own. Stored answers that actions refer to are copied into the cycle (`relive_answers`) so the cycle
does not depend on a global answer that may be deleted.

## NoiseRule

`{ part: 'status' | 'header' | 'body' | 'query', path: string, auto: boolean, count: boolean }` - `count: true`
overrides an automatic noise decision (FR-041c). `path` is the existing JSON-path syntax of `json-path-input`, or a
header name.

## Run

| Field | Type |
|---|---|
| `id`, `cycleId` | UUID |
| `driver` | `'AUTOMATIC' \| 'GUIDED'` |
| `status` | `'RUNNING' \| 'COMPLETED' \| 'COMPLETED_WITH_DIFFERENCES' \| 'FAILED' \| 'STOPPED' \| 'INTERRUPTED'` |
| `startedAt`, `finishedAt` | ISO |
| `definition` | full `ReliveCycle` snapshot as run (FR-044/045) |
| `fromStepKey` | string \| null | set for "Run from step" |
| `seedVariables` | `{ name, value }[]` | copied from the earlier run for "Run from step" |
| `variableTimeline` | changes as above |
| `summary` | `{ total, completed, different, failed, skipped, notCalled, cancelled, live, replayed, unattributed }` |
| `hold` | `{ stepKey, reason: 'FAILED' \| 'DIFFERENCES', since } \| null` | set while the run holds (FR-034); status stays `RUNNING` |
| `resumed` | `{ at, afterStepKey }[]` | each "Continue with the rest" of an ended run (FR-034d) |
| `log` | `LogEntry[]` | `{ at, stepKey, kind, message }` - kinds: `SENT`, `MATCHED`, `REPLAYED`, `FORWARDED_LIVE`, `BLOCKED`, `RULE_APPLIED`, `VARIABLE_SET`, `UNEXPECTED_CALL`, `AMBIGUOUS_BLOCKED`, `REQUEST_CHANGED`, `HELD`, `CONTINUED`, `RESUMED`, `ERROR` |

Retention: newest 50 runs per cycle and `alfred.relive.runs.max-size-bytes` total (default 500 MB), oldest first.

### Run state transitions

```
RUNNING ─┬─> COMPLETED | COMPLETED_WITH_DIFFERENCES | FAILED   (last step settled)
   ▲     ├─> STOPPED        (user Stop, or "End run here" while holding)
   │     └─> INTERRUPTED    (lease lost: tab gone > 15 s, or backend restart)
   │
   └── FAILED | STOPPED | INTERRUPTED  ("Continue with the rest", FR-034d - same run id)
```

While `RUNNING`, `hold` may be set (a failed step, or differences when the cycle holds on them); it clears on
Retry / Edit & retry / Continue with next calls, or the run ends on End run here.

## StepResult (one per step per attempt)

| Field | Type |
|---|---|
| `runId`, `stepKey`, `attempt` | attempt starts at 1; retries add rows (FR-035) |
| `state` | `PENDING`, `WAITING`, `PAUSED`, `RUNNING`, `REPLAYED`, `LIVE`, `INTERCEPTED`, `COMPLETED`, `COMPLETED_WITH_DIFFERENCES`, `FAILED`, `SKIPPED`, `NOT_CALLED`, `CANCELLED` |
| `mode` | `LIVE` / `REPLAY` actually applied |
| `attribution` | `'HEADER' \| 'OPERATION_ID' \| 'INFLIGHT' \| 'UNATTRIBUTED'` + applied choice |
| `effectiveRequest` | after substitution and rules, as ALFRED intended it |
| `actualRequest`, `actualResponse` | as logged by the proxy (the logged call's id is kept too) |
| `differences` | `{ part, path, recorded, actual, kind: 'EXPECTED' \| 'NOISE_AUTO' \| 'NOISE_USER' \| 'UNEXPECTED', cause }[]` |
| `rulesApplied` | `{ ruleId, name, tier: 'STEP' \| 'CYCLE' \| 'GLOBAL', actions: string[] }[]` |
| `variablesUsed`, `variablesProduced` | `{ name, value }[]` (stored and returned in full; the frontend masks names in `secrets`) |
| `assertions` | existing `AssertionResult[]` |
| `startedAt`, `finishedAt`, `durationMs`, `error` | |
| `unexpectedCalls` | `{ callId, method, url, handledBy: 'BLOCK' \| 'SEND_REAL' \| { ruleId, name }, reachedExternal }[]` made during this step that matched no child (FR-014f) |
| `requestChanged` | `{ part, path, recorded, actual }[]` + `decision: 'REPLAY' \| 'SEND_REAL' \| 'EDIT_REPLAY' \| 'FAIL' \| 'TIMEOUT'` (REPLAY children, FR-014d) |
| `pauses` | `{ at: 'BEFORE' \| 'AFTER', since, resolvedAt, choice: 'CONTINUE' \| 'REPLAY' \| 'EDIT_REPLAY' \| 'SKIP' \| 'STOP' \| 'TIMEOUT', breakpointId? }[]` |
| `editsApplied` | run-only edits made at a checkpoint before this attempt (diffable against the definition) |

### Step state transitions

```
PENDING ─> WAITING ─> RUNNING ─┬─> REPLAYED ─┬─> COMPLETED
   │                           ├─> LIVE ─────┼─> COMPLETED_WITH_DIFFERENCES
   │                           └─> INTERCEPTED┘   (outcome rule FR-034a)
   │                                         └─> FAILED
   ├─> SKIPPED     (disabled; optional after an earlier failure; or needs a variable a failed step never produced - `skipReason: MISSING_VARIABLE`)
   ├─> NOT_CALLED  (child never requested / Guided step never reached)
   └─> CANCELLED   (run stopped or interrupted before it started)
```

A checkpoint adds **`PAUSED`** (before sending, or after settling). From `PAUSED` the user's choice leads to
`RUNNING` (continue / replay / edit & replay, where a replay opens attempt n+1), `SKIPPED`, or ends the run
(`STOPPED`). A held outbound child that times out resumes as if continued, recording `TIMEOUT`.

`REPLAYED` / `LIVE` / `INTERCEPTED` are the in-flight states a user sees while the proxy handles the call; the
settled state replaces them.

## ValidationFinding

`{ severity: 'BLOCK' \| 'WARN', code, stepKey \| null, message }` - codes: `UNRESOLVED_VARIABLE`,
`MISSING_RECORDING`, `DUPLICATE_STEP`, `GLOBAL_RULE_GONE`, `RULE_OVERLAP`, `NOTHING_TO_RUN`, `MAY_BE_UNATTRIBUTED`,
`LIVE_EXTERNAL`, `UNUSED_VARIABLE`, `ORDER_DEPENDENCY` (a step uses a variable only extracted by a later step).

## Proxy run snapshot (`proxy/interception/relive/<runId>.json`)

See [contracts/proxy-snapshot.md](./contracts/proxy-snapshot.md).
