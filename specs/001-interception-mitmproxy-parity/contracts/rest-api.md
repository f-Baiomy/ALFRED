# Contract: Backend REST API additions

**Gateway**: every new route below uses a prefix the app-gateway regex already forwards
(`/interception`, `/calls`, `/internal-calls`, `/session-cycles`), except `/resend`. `/resend`
**must be added** to `gateway/nginx.conf`; otherwise the gateway serves it the SPA.

**Errors**: validation failures return `400 {"error":"invalid-rule"|"invalid-request",
"problems":[…]}` through the existing `InvalidRuleException` / `GlobalExceptionHandler` path.

## Interception: stored answers (`backend-interception`)

| Method and path | Body | Response |
|---|---|---|
| `POST /interception/answers` | `multipart/form-data`: `file`, optional `contentType`, optional `status` | `201 StoredAnswerDto`, or `413 {"error":"answer-too-large","limitBytes","sizeBytes"}`, or `415` for an empty or missing content type |
| `POST /interception/answers/from-call` | `{direction:"outbound"\|"inbound", callId, cycleId?, keepSecrets?:boolean}` | `201 StoredAnswerDto`; or `409 {"error":"secrets-decision-required","secretNames":[…]}` when secrets exist and `keepSecrets` is absent; or `404` if the call is unknown; or `413` |
| `GET /interception/answers/{id}` | none | `StoredAnswerDto` (metadata only, never the body) |
| `GET /interception/answers/{id}/body` | none | The raw bytes with their stored content type, served for the editor's preview. This returns what the rule itself would serve (FR-026 "keep" means the rule owner chose to keep it). The UI shows it as masked unless the user expands it. |

`StoredAnswerDto = {id, kind, status, contentType, sizeBytes, secretsKept, secretNames,
sourceDirection, sourceCallId, recordedAt, createdAt, referencedByRuleIds:[…]}`

**Multipart limits**:
- `spring.servlet.multipart.max-file-size` = `${INTERCEPTION_MAX_ANSWER_BYTES:10485760}`
- `max-request-size` = that value + 64 KB

Anything over the limit is rejected before it is buffered.

## Interception: rules (changed)

| Method and path | Change |
|---|---|
| `GET /interception/action-types` | Each item gains `phase: "REQUEST"\|"RESPONSE"\|"MESSAGE"`, which already exists; the frontend now treats it as authoritative. |
| `GET /interception/sensitive-headers` | **New.** Returns `{names:[…]}`, the secret header and cookie names (`SensitiveHeaders.NAMES`). This is the frontend's only source for masking; the proxies get the same list through the snapshot. |
| `GET /interception/rules/export?ids=a,b` | **New.** Returns a version-2 rules file with answers embedded as base64 (see rules-snapshot.md §3). With no `ids`, it returns all rules. |
| `POST /interception/rules/import` | Now accepts a version-1 **or** version-2 file body: `{alfredInterceptionRules, rules, answers?, enable}`. Answers get fresh ids, and each `answerRef` is rewritten. The existing `{rules, enable}` body stays accepted. |
| `POST/PUT /interception/rules` | New `RuleAction` and `RuleMatch` fields (data-model §2–3), validated per data-model §9. |

## Calls: WebSocket messages (`backend-calls`, `backend-internal-calls`)

| Method and path | Response |
|---|---|
| `GET /calls/{id}/ws-messages?offset=0&limit=200` | `{messages:[{seq, direction, tsMillis, type, content?, contentBase64?, originalContent?, action?}], total, dropped}`. `limit` is clamped to 1..500. |
| `GET /internal-calls/{id}/ws-messages?…` | Same as above. |
| `GET /session-cycles/{cycleId}/{calls\|internal-calls}/{callId}/ws-messages` | Not in scope. Cycles capture the handshake call only (see plan, Scope notes). |

**WebSocket push**: `/ws/calls` and `/ws/internal-calls` gain a payload-free
`{"type":"ws-messages-appended","callId":"…"}` event. The frontend re-fetches only when that
call's panel is open.

## Calls: resend linkage (both call slices)

`CallSummaryDto` and the call detail gain `resend_of?: string` and `resend_edits?: object`
(data-model §7). No new endpoints are added.

**New in-port** `FindRecentRequestHeadersUseCase` (backend-calls) and its inbound equivalent.
These are internal Java APIs reached through the backend-app bridge; there is no HTTP route.

## Resend (`backend-resend`, new slice)

| Method and path | Body | Response |
|---|---|---|
| `POST /resend` | `{direction:"outbound"\|"inbound", callId, cycleId?, edits?:{method?, url?, headers?:{name:value\|null}, body?}, useCurrentSession?:boolean}` | `200 {newCallId, status, durationMs, sessionValuesUsed:[{name, fromCallId}]}`, or `404` for an unknown call, or `409 {"error":"reverse-proxy-not-running"}` (inbound when the `inbound-logging` profile is off), or `502 {"error":"send-failed", message}` |

- **Limits, clamped server-side (constitution I)**:
  - `edits.body` is at most `alfred.interception.max-answer-bytes` (10 MB);
  - `edits.headers` has at most 100 entries, each value at most 8 KB;
  - `edits.url` is at most 8 KB.
  Anything over a limit returns `400 {"error":"invalid-request","problems":[…]}`.
- A single call is sent synchronously, with a client timeout of
  `alfred.resend.timeout-ms` (default 120,000).
- Bulk resend is the frontend calling this endpoint once per call, in order.
- `sessionValuesUsed` never carries a value, only the header or cookie name and the call it
  came from.
