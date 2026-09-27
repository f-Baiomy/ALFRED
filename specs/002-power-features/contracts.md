# 002 - Power features: shared contracts

Single source of truth for every wire format and cross-owner interface in this batch. Several
agents build in parallel in ONE working tree; each owns specific files (see "Ownership"). Never
edit a file you do not own - if you need something from another owner, code against the contract
below and report the dependency.

Feature ids (from the design review): A design-system alignment, B1 capture preview, B2 resend
progress, B3 variables by source, B4 drawer polish, C1 resend chaining, C2 environments,
C3 scope-aware autocomplete, C4 undo + capture links, D1 scenarios, D2 cycle-to-scenario,
D3 data-driven runs, D4 dynamic tokens, D5 variable-driven rules, D6 secret variables,
F filters + waterfall markings.

---

## 1. Global variables API (backend-settings) - B3, C2, D6

All state responses return the ACTIVE environment's view plus metadata:

```jsonc
{
  "variables":  { "name": "text" },            // active environment
  "fallbacks":  { "deletedName": "text" },     // active environment
  "updatedAt":  { "name": 1727450000000 },     // active environment, epoch ms, tombstones kept
  "sources":    { "name": { "kind": "MANUAL" | "CAPTURE" | "IMPORT",
                            "ruleId": "r-1", "ruleName": "Login token" } },  // rule* only for CAPTURE
  "secrets":    ["apiKey"],                    // GLOBAL list (all environments)
  "activeEnvironment": "Default",
  "environments": ["Default", "Staging"]       // sorted, active included
}
```

Environment name: `[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}`. A legacy flat state migrates to one
environment named `Default`. Existing endpoints keep working and act on the active environment.

| Method and path | Body | Result |
|---|---|---|
| `GET /settings/variables` | - | state |
| `PUT /settings/variables` | `{variables, fallbacks}` (bulk replace of active env) | state |
| `PUT /settings/variables/{name}` | `{value}` - source becomes `MANUAL` | state |
| `DELETE /settings/variables/{name}?fallback=` | - | state |
| `POST /settings/variables/promoted` | `{name, value, ruleId?, ruleName?}` - source `CAPTURE` | state |
| `PUT /settings/variables/{name}/secret` | `{secret: boolean}` - name need not exist yet | state |
| `POST /settings/variables/environments` | `{name, copyFrom?: envName}` | state (new env NOT activated) |
| `PUT /settings/variables/environments/active` | `{name}` | state; republishes variables.json |
| `DELETE /settings/variables/environments/{name}` | - (400 if active or last) | state |
| `GET /settings/variables/environments/{name}/export` | - | `{name, variables, fallbacks}` |
| `POST /settings/variables/import` | `{environment, variables, fallbacks?, mode: "MERGE"\|"REPLACE"}` - env created if absent; imported names get source `IMPORT` | state |

Every mutation broadcasts `{"type":"variables-changed"}` on `/ws/variables` (only when state
actually changed). Limits: 1000 names per environment, 20 environments, 1,048,576 chars per value.

### variables.json (published to the proxies) - owned by the lead

```jsonc
{
  "environment": "Staging",
  "variables": {...}, "fallbacks": {...}, "updatedAt": {...},
  "secrets": ["apiKey"],
  // written by the proxy on a GLOBAL capture, preserved by the backend only until absorbed:
  "promotedAt": { "token": 1727450000000 },
  "promotedBy": { "token": { "ruleId": "r-1", "ruleName": "Login token" } }
}
```

Absorb rule (unchanged, extended): a file value is absorbed into the environment named by the
file's `environment` (else the active one) only when `promotedAt[name]` is newer than that
environment's `updatedAt[name]`; its source becomes `CAPTURE` with `promotedBy[name]`.

---

## 2. Resend API change - C1, D1, B2

`POST /resend` 200 response gains the supplier's response, so chaining and assertions need no
second fetch (the resent call reaches the call log asynchronously via webhook):

```jsonc
{ "newCallId": "...", "status": 200, "durationMs": 38.1, "sessionValuesUsed": [...],
  "response": { "status": 200, "headers": { "content-type": "application/json" }, "body": "..." } }
```

`response` is null when the send failed before a response (502 path unchanged). Body is text
(UTF-8, lossy for binary), capped at `alfred.interception.max-answer-bytes`. Header names lower-case;
repeated headers joined with `, `.

The backend also resolves D4 dynamic tokens (section 4) in method, URL, headers and body, after
global variables. `{{this.x}}` and `{{row.x}}` are NOT resolved by the backend - the frontend
substitutes them before sending (C1, D3). Unknown tokens stay literal.

---

## 3. Scenarios API (new slice `backend-scenarios`) - D1

Leaf slice, isolated like `profiles`. SQLite adapter (pattern: backend-interception's SQLite store).
Gateway regex gains `scenarios`. Definitions and results are OPAQUE JSON to the backend.

```jsonc
// Scenario
{ "id": "uuid", "name": "Book flow", "description": "", "definition": { /* ScenarioDefinition */ },
  "createdAt": "ISO", "updatedAt": "ISO", "lastRun": { /* RunSummary */ } | null }
// Run
{ "id": "uuid", "scenarioId": "uuid", "startedAt": "ISO", "finishedAt": "ISO",
  "summary": { "total": 6, "passed": 5, "failed": 1, "errored": 0 }, "results": { /* opaque */ } }
```

| Method and path | Body | Result |
|---|---|---|
| `GET /scenarios` | - | `[Scenario]` (no definition body: `definition` omitted), newest first |
| `GET /scenarios/{id}` | - | Scenario |
| `POST /scenarios` | `{name, description?, definition}` | Scenario (201) |
| `PUT /scenarios/{id}` | `{name, description?, definition}` | Scenario |
| `DELETE /scenarios/{id}` | - | 204 (deletes its runs) |
| `GET /scenarios/{id}/runs` | - | `[Run]` without `results`, newest first |
| `GET /scenarios/{id}/runs/{runId}` | - | Run |
| `POST /scenarios/{id}/runs` | Run without id/scenarioId | Run (201); keeps newest 50 runs per scenario |

Limits: name 1-80 chars; definition and results each at most 20 MB serialized (400 above).
Broadcast `{"type":"scenarios-changed"}` on `/ws/scenarios` after every mutation.

### ScenarioDefinition (frontend-owned shape, opaque to backend)

```ts
interface ScenarioDefinition {
  version: 1;
  drafts: ResendDraft[];                 // as in resend-draft.ts, incl. extract/assertions below
  groups: Record<string, ResendGroup>;   // as in resend-group.ts
  settings: { delayMs: number; stopOnFailure: boolean; useCurrentSession: boolean;
              maxParallel: number | null; retry: RetryPolicy | null };
  datasets: Record<string /*groupId*/, Dataset>;
}
```

---

## 4. Dynamic tokens - D4 (grammar owned by the lead)

Resolved per use (never at rule-load time), by proxy (Python), resend (Java) and frontend
preview (TS, `shared/utils/dynamic-tokens.ts`). All three MUST pass
`specs/002-power-features/dynamic-token-vectors.json`.

Regex: `\{\{\$([A-Za-z][A-Za-z0-9]*)((?:[+-]\d{1,6}[smhd])?)(?::([^{}]*))?\}\}`

| Token | Result |
|---|---|
| `{{$uuid}}` | random UUID v4, lower-case |
| `{{$now}}` | UTC ISO-8601 with millis: `2026-09-27T16:04:05.123Z` |
| `{{$now:epoch}}` / `{{$now:epochMs}}` | epoch seconds / milliseconds |
| `{{$now:<pattern>}}` | UTC; pattern letters `yyyy MM dd HH mm ss SSS`, every other char literal |
| `{{$now+2d}}`, `{{$now-90m:HH:mm}}` | offset (`s m h d`) applied before formatting |
| `{{$randomInt:min:max}}` | inclusive integers, `-10^12 <= min <= max <= 10^12`, else literal |
| `{{$base64:name}}` | standard Base64 (UTF-8) of variable `name` (global, or `this.x` in the proxy); unresolved = literal |

Anything else starting with `$` stays literal.

---

## 5. Interception rule additions - D5 (wire), C4

- `match.variables: MatchTest[]` - `{name: variableName, operator, value?, caseSensitive?}`, same
  operators as header tests. Evaluated in the proxy against the call's promoted overlay, then the
  published variables, then fallbacks. Absent variable = `NOT_EXISTS`.
- `rule.everyNth: number | null` - 2..1000. The rule applies to every Nth call that otherwise
  matches (counter per rule, per proxy process, reset when rules.json changes).
- Backend validates both (`RuleValidator`); `variables[].name` must match the global name rule.
- Proxy interception-log detail for a GLOBAL capture ends with ` -> {{name}}` (C4 links parse
  `-> {{([^}]+)}}$`). Captured VALUES are never logged.
- D6: an action whose authored text referenced a secret variable is logged by name only.

---

## 6. Frontend interfaces between owners

- `ResendDraft` (resend-draft.ts, owner F-RESEND) gains
  `extract?: ExtractRule[]` and `assertions?: Assertion[]`:
  ```ts
  interface ExtractRule { from: 'JSON' | 'HEADER' | 'COOKIE'; path: string; as: string;
                          missing: 'SKIP' | 'FALLBACK'; fallback?: string }
  interface Assertion { kind: 'STATUS' | 'JSON' | 'HEADER' | 'LATENCY';
                        path?: string; operator: 'EQUALS' | 'NOT_EQUALS' | 'EXISTS' | 'NOT_EXISTS'
                          | 'CONTAINS' | 'GT' | 'LT' | 'MATCHES'; value?: string }
  interface RetryPolicy { attempts: number /*0-5*/; backoffMs: number; on: ('5XX' | 'NETWORK')[] }
  interface Dataset { name: string; rows: Record<string, string>[]; onRowFailure: 'SKIP' | 'STOP' }
  ```
- `BulkResendDialogService.results: Signal<Record<draftKey, DraftResult[]>>` (owner F-RESEND):
  ```ts
  interface DraftResult { key: string; row?: number; attempt: number; status: number | null;
    durationMs: number | null; newCallId: string | null; error: string | null;
    response: { status: number; headers: Record<string, string>; body: string | null } | null;
    extracted: Record<string, string> }
  ```
  plus `runState: Signal<'idle' | 'running' | 'stopping' | 'done'>` and
  `onRunFinished: Observable<DraftResult[]>`. F-SCENARIO evaluates assertions from these.
- `GlobalVariablesService` (owner F-VARS) exposes `focusVariable(name: string): void` (opens the
  drawer scrolled to and flashing that row) and `isSecret(name): boolean`.
- Scope-aware autocomplete (C3): any input may carry
  `data-local-variables='[{"name":"token","available":true,"reason":""}]'`. The global suggestion
  popup (F-VARS) lists those as `this.<name>` first, greying out `available:false` with `reason`.
  F-RULES sets the attribute on action-card inputs.
- `shared/utils/dynamic-tokens.ts` (owner: lead) exports
  `resolveDynamicTokens(text, lookup: (name) => string | undefined, now?: Date, rng?: () => number)`.
- `shared/utils/capture-preview.ts` (owner F-RULES) - TS port of the proxy's `_capture_value`.

## Ownership

| Owner | Files |
|---|---|
| lead | `proxy/**`, `specs/002-power-features/**`, `shared/utils/dynamic-tokens.ts(+spec)`, `shared/utils/redact.ts` + export builders (D6 redaction), `docs/**` |
| BK-CORE | `backend/backend-settings/**`, `backend/backend-resend/**`, `backend/backend-interception/**`, `backend/backend-app/**` (except scenario wiring) |
| BK-SCEN | new `backend/backend-scenarios/**`, `backend/pom.xml` modules list, `backend/backend-architecture-test/**`, `gateway/nginx.conf`, backend-app pom dependency line for the new module |
| F-VARS | `components/global-variables/**`, `core/services/global-variables.service*`, the "Global variables" block of `styles.scss`, `layout/main-layout/**` |
| F-RESEND | `components/bulk-resend-dialog/**`, `core/services/bulk-resend-dialog.service*`, `core/services/resend-api.service*`, `shared/utils/resend-draft*`, `shared/utils/resend-group*`, `styles/_resend-power.scss`, the resend block of `styles.scss` |
| F-SCENARIO | new `components/scenario-*/**`, new `core/services/scenario*.ts`, new `shared/utils/scenario-*.ts`, new `shared/utils/cycle-chain-detect*.ts`, `pages/session-cycle-detail/**`, `styles/_scenarios.scss` |
| F-RULES | `components/rule-editor/**`, `components/rule-action-card/**`, `core/models/interception.model.ts`, `shared/utils/action-catalog.ts`, `shared/utils/interception-help.ts`, `shared/utils/capture-preview*`, `styles/_rules-power.scss` |
| F-LIST | `core/state/call-list-view*`, `components/stats-bar/**`, `components/call-waterfall/**`, `components/call-card/**`, `components/call-actions/**`, the Filters menu component, `styles/_call-list-power.scss` |
