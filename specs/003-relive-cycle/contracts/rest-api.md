# REST + WebSocket contract: `backend-relive`

Base prefix `/relive-cycles` (added to the `app-gateway` regex). Every body DTO is `@Valid`; sizes are clamped
server-side (steps ≤ 500, variables ≤ 200, cycle rules ≤ 200, run list `limit` ≤ 100). Errors use the existing
`GlobalExceptionHandler` shape.

## Cycles

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/relive-cycles` | - | `ReliveCycle[]` without `steps[].recording` bodies, newest first, each with `lastRun` |
| `GET` | `/relive-cycles/{id}` | - | `ReliveCycle` (full, bodies included - opened on demand only) |
| `POST` | `/relive-cycles` | `{ name, description?, steps?, ... }` | `ReliveCycle` 201 |
| `PUT` | `/relive-cycles/{id}` | full `ReliveCycle` minus server fields | `ReliveCycle` - optimistic: `If-Match: <updatedAt>`; 409 on a stale save |
| `POST` | `/relive-cycles/{id}/duplicate` | `{ name? }` | new `ReliveCycle` 201 |
| `DELETE` | `/relive-cycles/{id}` | - | 204; 409 while a run of it is `RUNNING` |
| `POST` | `/relive-cycles/{id}/validate` | - | `ValidationFinding[]` |
| `PUT` | `/relive-cycles/{id}?reason=REBUILD_REFRESH\|REBUILD_RECORDING\|REBUILD_START_OVER\|REPLACE_STEPS` | full cycle | same as `PUT`, and snapshots the previous definition as a version first |
| `GET` | `/relive-cycles/{id}/versions` | - | `CycleVersion[]` headers, newest first (≤ 10) |
| `POST` | `/relive-cycles/{id}/versions/{version}/restore` | - | `ReliveCycle` - undo (itself snapshots the current definition first) |
| `POST` | `/relive-cycles?transient=true` | cycle | quick-run cycle ("Relive now"); `PUT` with `transient:false` saves it |

Cycle rules, step rules and match rules are validated on save with the existing interception `RuleValidator`,
against the same action catalog as global rules (`GET /interception/action-types`); `backend-relive` has no
action-specific code. A step rule's `match` is overwritten on save with the step's own match (FR-029b).

Adding recorded calls is a client-side edit (the tab builds `FrozenCall`s from call detail it already fetches) saved
with `PUT` - no separate endpoint.

## Runs

> **Masking (FR-022/022a):** as everywhere else in ALFRED (calls, session cycles, resend), the backend returns data
> in full and the frontend masks it with `shared/utils/redact.ts` (redaction rules + Authorization/cookie headers)
> plus the names in `secrets`. The backend never masks, so a reveal needs no second request. Every response that
> carries bodies or variable values also carries `secrets`.

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/relive-cycles/{id}/runs` | `{ driver, fromStepKey?, seedFromRunId?, unattributedChoices: {stepKey: choice} }` | `Run` 201 (status `RUNNING`); publishes the proxy snapshot. 422 when validation has `BLOCK` findings |
| `GET` | `/relive-cycles/{id}/runs?limit=` | - | `Run[]` headers + summary, newest first, no bodies |
| `GET` | `/relive-cycles/{id}/runs/{runId}` | - | `Run` + `StepResult[]` (bodies and secret values in full, plus `secrets: string[]`; the frontend masks, see note) |
| `PUT` | `/relive-cycles/{id}/runs/{runId}/steps/{stepKey}/attempts/{n}` | `StepResult` | 200 - the orchestrating tab writes results as they settle |
| `POST` | `/relive-cycles/{id}/runs/{runId}/variables` | `{ name, value, stepKey }` | 204 - republishes the snapshot when the variable is used by a rule |
| `GET` | `/relive-cycles/{id}/runs/{runId}/variables` | - | 200 - current run variable values, including definitions and timeline updates; used at step boundaries |
| `POST` | `/relive-cycles/{id}/runs/{runId}/stop` | - | `Run` (`STOPPED`); unpublishes the snapshot |
| `PUT` | `/relive-cycles/{id}/runs/{runId}/definition` | `{ definition, reason }` | `Run` - applies a mid-run edit to steps not yet run and republishes the proxy snapshot (FR-044a); 409 for a step already executed |
| `PUT` | `/relive-cycles/{id}/runs/{runId}/hold` | `{ stepKey, reason } \| null` | `Run` - the orchestrating tab records a hold and its release (FR-034); logs `HELD` / `CONTINUED` |
| `POST` | `/relive-cycles/{id}/runs/{runId}/resume` | `{ afterStepKey }` | `Run` (`RUNNING` again, same id) - republishes the run's own snapshot; 409 while another tab holds its lease (FR-034d) |
| `POST` | `/relive-cycles/{id}/runs/{runId}/finish` | `{ status }` | `Run`; unpublishes the snapshot |
| `POST` | `/relive-cycles/{id}/runs/{runId}/steps/{stepKey}/save-edits` | run-only edits | `ReliveCycle` - writes checkpoint edits back to the definition (FR-035c) |
| `GET` | `/relive-cycles/{id}/live-calls?limit=` | - | `LiveCall[]` headers, newest first |
| `GET` | `/relive-cycles/{id}/live-calls/{liveId}` | - | `LiveCall` (bodies in full, plus `secrets: string[]`) |
| `DELETE` | `/relive-cycles/{id}/live-calls/{liveId}` | - | 204 |
| `POST` | `/relive-cycles/{id}/live-calls/{liveId}/use-as-recording` | `{ stepKey }` | `ReliveCycle` - snapshots a version first (undo via versions/restore) |
| `GET` | `/relive-cycles/{id}/runs/{a}/compare/{b}` | - | step-matched pair list (for `scenario-run-compare`) |

Sending inbound steps uses the existing `POST /resend` with one addition: a `relive: { runId, stepKey }` field that
makes backend-resend add `X-Alfred-Relive` and `X-Operation-Id` (research D2).

Held outbound calls are released through the existing breakpoint endpoint (`POST /interception/paused/{id}/decision`);
their paused entries carry `relive: { runId, stepKey, at }`, so the run view can show them inline.

## Proxy → backend

Logged calls gain an optional `relive: { runId, stepKey, attribution, choice, ruleIds[] }` field (backend-calls and
backend-internal-calls summaries), set by the addons, trusted like `resend_of`. `backend-relive` observes new calls
through the existing `NewCallObserverPort` / `NewInternalCallObserverPort` (wired in `backend-app`) to (a) maintain
`relive/inflight.json` while runs are active and (b) broadcast run events.

## WebSocket `/ws/relive`

Fetch-on-demand signals only (no data pushed beyond ids), plus a lease:

```json
{ "type": "relive-changed" }                                        // any cycle saved/deleted
{ "type": "run-changed", "cycleId": "…", "runId": "…" }             // run status/summary changed
{ "type": "run-call", "runId": "…", "stepKey": "…", "callId": "…",
  "direction": "outbound", "attribution": "INFLIGHT", "state": "REPLAYED" }   // proxy handled a run call
```

Lease: the orchestrating tab sends `{ "type": "lease", "runId": "…" }` on connect and every reconnect. The backend
keeps a run `RUNNING` while at least one socket holds its lease; after 15 s without one it unpublishes the snapshot
and sets `INTERRUPTED`.
