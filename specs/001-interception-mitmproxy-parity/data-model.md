# Data Model: Interception Rule Actions at Parity with mitmproxy

Every change is additive. A rules file, a call row or an NDJSON line written before this
feature still reads, and missing fields default to absent.

## 1. ActionType (wire names)

Wire names are fixed once they ship. `ActionType` (Java), `REQUEST_ACTIONS` / `RESPONSE_ACTIONS`
/ `MESSAGE_ACTIONS` (Python) and `ActionType` (TypeScript) must change together.
`EveryActionIsCoveredTest` and `interception-help.spec.ts` fail the build when an action is
missing from either. A new phase, `MESSAGE`, is added for WebSocket actions.

| Type | Phase | Terminal | Fields used | Story |
|---|---|---|---|---|
| `REPLACE_IN_REQUEST_BODY` | REQUEST | no | `pattern`, `replacement`, `regex`, `caseSensitive`, `maxReplacements` | US1 |
| `REPLACE_IN_RESPONSE_BODY` | RESPONSE | no | same as above | US1 |
| `SET_REQUEST_BODY` | REQUEST | no | `body`, `contentType?` | US3 |
| `REMOVE_REQUEST_JSON_FIELD` | REQUEST | no | `path` | US3 |
| `REMOVE_RESPONSE_JSON_FIELD` | RESPONSE | no | `path` | US3 |
| `REWRITE_URL` | REQUEST | no | `target{scheme?,host?,port?,path?}` or `pattern`+`replacement`+`regex`, `keepHostHeader` | US2 |
| `SET_METHOD` | REQUEST | no | `method` | US2 |
| `SET_REQUEST_COOKIE` | REQUEST | no | `name`, `value` | US4 |
| `REMOVE_REQUEST_COOKIE` | REQUEST | no | `name` | US4 |
| `SET_RESPONSE_COOKIE` | RESPONSE | no | `name`, `value`, `cookieAttributes{path,domain,maxAge,secure,httpOnly,sameSite}` | US4 |
| `REMOVE_RESPONSE_COOKIE` | RESPONSE | no | `name` | US4 |
| `SET_FORM_FIELD` | REQUEST | no | `name`, `value` | US4 |
| `REMOVE_FORM_FIELD` | REQUEST | no | `name` | US4 |
| `DISABLE_CACHE` | REQUEST | no | none | US5 |
| `DISABLE_COMPRESSION` | REQUEST | no | none | US5 |
| `SET_RESPONSE_ENCODING` | RESPONSE | no | `encoding` ∈ gzip, deflate, br, zstd, identity | US5 |
| `ANSWER_WITH_RECORDED_CALL` | REQUEST | **yes** | `answerId`, `refreshDates` | US6 |
| `REPLACE_WITH_RECORDED_RESPONSE` | RESPONSE | no | `answerId`, `refreshDates` | US6 |
| `ANSWER_WITH_FILE` | REQUEST | **yes** | `answerId`, `status` (the content type is on the answer) | US7 |
| `SET_REQUEST_TRAILER` / `REMOVE_REQUEST_TRAILER` | REQUEST | no | `name`, `value?` | US10 |
| `SET_RESPONSE_TRAILER` / `REMOVE_RESPONSE_TRAILER` | RESPONSE | no | `name`, `value?` | US10 |
| `REPLACE_IN_MESSAGE` | MESSAGE | no | `pattern`, `replacement`, `regex`, `caseSensitive`, `maxReplacements`, `messageDirection` | US9 |
| `DROP_MESSAGE` | MESSAGE | no | `messageDirection`, `contains?` (literal) | US9 |
| `DELAY_MESSAGE` | MESSAGE | no | `durationMs`, `messageDirection` | US9 |

`ActionType.isTerminal()` gains `ANSWER_WITH_RECORDED_CALL` and `ANSWER_WITH_FILE`. The
`SEND_TO_HOST` latch refuses both, in the same way it refuses `MOCK_RESPONSE`
(`proxy/interception.py:1037-1053`). `IF_REQUEST` / `IF_RESPONSE` may nest any action of their
own phase. MESSAGE actions are not allowed inside conditionals in this feature.

## 2. RuleAction: new fields

These fields are added to the existing record (`RuleAction.java`) and to the TypeScript
`RuleAction`. All are nullable and use `@JsonInclude(NON_NULL)`.

| Field | Type | Notes |
|---|---|---|
| `pattern` | String | ≤ 500 characters (`MAX_PATTERN_LENGTH`) |
| `replacement` | String | `\1` / `\g<name>` are honoured only when `regex=true` |
| `regex` | Boolean | Default false, which means literal matching |
| `caseSensitive` | Boolean | Default true for body and message patterns |
| `maxReplacements` | Integer | 1..10,000; null means all |
| `target` | `UrlTarget{scheme,host,port,path}` | At least one part is set |
| `keepHostHeader` | Boolean | Default false |
| `method` | String | Letters only, upper-cased |
| `cookieAttributes` | `CookieAttributes{path,domain,maxAge,secure,httpOnly,sameSite}` | Only for `SET_RESPONSE_COOKIE` |
| `contentType` | String | `SET_REQUEST_BODY`; optional |
| `encoding` | String | See ActionType |
| `answerId` | String | Must refer to an existing StoredAnswer |
| `refreshDates` | Boolean | Default false |
| `messageDirection` | String | `client`, `server` or `both`; default `both` |
| `contains` | String | `DROP_MESSAGE` filter; literal |

The existing `name`, `value`, `path`, `body`, `status` and `durationMs` fields are reused where
they fit. No existing field changes meaning.

## 3. RuleMatch: new fields

`headers`, `query` and `cookies` are each a `List<MatchTest>`, and default to empty.

`MatchTest{ name (required, case-insensitive for headers and cookies), operator, value?,
caseSensitive? }`

- `operator` is one of EXISTS, NOT_EXISTS, EQUALS, CONTAINS, MATCHES.
- `value` is required unless the operator is EXISTS or NOT_EXISTS.
- A MATCHES regex is ≤ 500 characters and must pass the nested-quantifier check.
- All tests must hold (AND). Tests run after `source`, `serviceNames`, `methods`, `host` and
  path, in the proxy `Match.matches`.

## 4. StoredAnswer (new, owned by backend-interception)

| Field | Type | Notes |
|---|---|---|
| `id` | String (UUID) | Server-assigned |
| `kind` | `RECORDED` or `FILE` | |
| `status` | Integer | For RECORDED, the recorded status. For FILE, the default status, which the action may override. |
| `headers` | Map<String,String> | For FILE: `content-type` only. For RECORDED: the recorded headers, minus stripped secrets. |
| `contentType` | String | |
| `sizeBytes` | long | ≤ `alfred.interception.max-answer-bytes` (default 10,485,760) |
| `secretsKept` | Boolean | Null for FILE answers and for answers with no secrets; otherwise true or false (FR-026) |
| `secretNames` | List<String> | The secret header and cookie names detected at copy time; values are never shown |
| `sourceDirection` | `outbound` or `inbound` | RECORDED only |
| `sourceCallId` / `sourceCycleId` | String | RECORDED only; informational, never dereferenced again |
| `recordedAt` | ISO string | RECORDED only; used by `refreshDates` |
| `createdAt` | ISO string | |
| body | bytes | Stored separately (`stored_answer_bodies.body BLOB`) and published as `answers/<id>.body` |

**Lifecycle**: `UPLOADED/COPIED` (no rule refers to it) → `REFERENCED` (at least one rule
refers to it) → deleted.
- An answer is deleted when the last referring rule is deleted or saved without it.
- An answer that no rule has referred to within 1 hour is swept.
- Duplicating a rule adds a reference; it does not copy the answer.

**SQLite (`interception.db`)**:

```sql
CREATE TABLE IF NOT EXISTS stored_answers(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status INTEGER, headers_json TEXT NOT NULL,
  content_type TEXT, size_bytes INTEGER NOT NULL, secrets_kept INTEGER, secret_names_json TEXT,
  source_direction TEXT, source_call_id TEXT, source_cycle_id TEXT, recorded_at TEXT,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stored_answer_bodies(
  answer_id TEXT PRIMARY KEY REFERENCES stored_answers(id) ON DELETE CASCADE, body BLOB NOT NULL);
```

The list queries never select `stored_answer_bodies`.

## 5. Rules snapshot (`proxy/interception/rules.json`), additive

```json
{ "enabled": true, "publishedAt": "…", "rules": [ … ],
  "sensitiveHeaders": ["authorization", "cookie", "set-cookie", "…"],
  "selfTargets": ["backend", "backend:5000", "localhost:5000", "127.0.0.1:3000", "127.0.0.2:443", "localhost:8083", "…"],
  "limits": { "maxPatternLength": 500, "regexTimeoutMs": 2000 } }
```

Stored answers are published beside the snapshot as `answers/<id>.meta.json` (every StoredAnswer
field except the body) and `answers/<id>.body`. Both are written with a temp file and an atomic
move. Files that no published rule references are deleted after the snapshot is written.

## 6. Interception record (per call), extended

`CallInterception.applied[]` entries keep the shape `{ruleId, ruleName, action, detail}`. There
are three changes:
- The **detail vocabulary** adds `skipped - <reason>` and `refused - <reason>` for the new
  actions. Actions that do nothing must now record a skip (FR-015).
- Snapshot headers whose names are in `sensitiveHeaders` are written as
  `(value not logged · N chars)`.
- WebSocket message actions record per message, in the message record (§8), not in `applied`.

**backend-internal-calls**: `CallRecord` gains `interception` (this slice's own copy of the
`CallInterception` shape), `resendOf`, `resendEdits` and `wsDropped`.
`CompleteInternalCallRequestDto` gains `interception`, and `PrepareInternalCallRequestDto` gains
`resend_of` and `resend_edits`. NDJSON lines gain the same optional keys.

## 7. Resent call linkage (both call slices)

| Field | Where | Notes |
|---|---|---|
| `resend_of` | prepare payload, then `call_metadata.resend_of TEXT` (ALTER), inbound NDJSON `resendOf` | The id of the original call |
| `resend_edits` | prepare payload, then `call_metadata.resend_edits TEXT` (JSON) | `{method?:{from,to}, url?:{from,to}, headers?:[names], body?:true, session?:[{name, fromCallId}]}`; secret values are never included |

Both fields are also exposed on `CallSummaryDto` (TypeScript `CallRecord.resendOf`,
`resendEdits`), so a collapsed card can show "↻ resend of …".

## 8. WebSocket message record (new)

**Outbound (`calls.db`)**:

```sql
CREATE TABLE IF NOT EXISTS call_ws_message(
  call_id TEXT NOT NULL REFERENCES call_metadata(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, direction TEXT NOT NULL, ts_millis INTEGER NOT NULL,
  type TEXT NOT NULL, content TEXT, content_base64 TEXT, original_content TEXT,
  action TEXT, PRIMARY KEY(call_id, seq));
-- call_metadata gains: ws_message_count INTEGER, ws_dropped INTEGER (ALTER)
```

- `type` is `text` or `binary`. Binary content is stored base64.
- `action` is null, `edited`, `dropped` or `delayed:<ms>`, with the rule id and name in a JSON
  suffix.
- The cap is enforced on insert: when `count > alfred.calls.ws-max-messages` (default 1,000),
  the lowest `seq` rows are deleted and `ws_dropped` is incremented.
- The list query is `WHERE call_id = ? ORDER BY seq LIMIT ? OFFSET ?`, riding the primary key.

**Inbound**: `internal-ws-messages.log` is NDJSON, one message per line
(`{callId, seq, direction, tsMillis, type, content|contentBase64, originalContent, action}`).
It is append-only with compaction and uses the same cap per connection. Compaction follows
`InternalCallsFileLogAdapter`'s temp-file-plus-move scheme.

**Retention (constitution II)**: messages never outlive their call.
- **SQLite**: `ON DELETE CASCADE` removes the messages when the calls slice's size-based
  retention deletes the call.
- **Flat files** (outbound `RECENT_CALLS.ws.log` in `type=file` mode, and inbound
  `internal-ws-messages.log`):
  - Compaction drops every message whose `callId` is no longer in the slice's call log.
  - Compaction runs when the file grows past its slack threshold, and also whenever the call
    log itself compacts or evicts.
  - Total file size is therefore bounded by the call retention (200 rows outbound in file mode,
    1,500 rows inbound) × the per-connection cap.
  - "Clear all saved calls" also clears the message file.

## 9. Validation rules (RuleValidator additions)

- **Patterns** (`pattern`, `MatchTest.value` with MATCHES):
  - length is 1..500;
  - when `regex=true`, the pattern must compile with `java.util.regex`;
  - named groups are rejected in both syntaxes. Python accepts only `(?P<n>…)`, Java accepts
    only `(?<n>…)`, and the same pattern must run in both. The save message says to use
    numbered groups (`\1` in the replacement);
  - lookbehind and possessive or atomic constructs (`(?<=`, `(?<!`, `*+`, `++`, `?+`, `(?>`)
    are rejected, because their support differs between the two engines;
  - a **nested quantifier** is rejected: a quantified group whose body contains an unescaped
    quantifier, such as `(a+)+`, `(a*)*`, `(a|aa)+` or `(\w+\s?)*`. This is detected by a small
    scanner over the pattern, not by a regex.
- `maxReplacements` is 1..10,000.
- **`REWRITE_URL`**:
  - it needs `target` with at least one part, or a `pattern`;
  - `scheme` is `http` or `https`; `port` is 1..65535; `path` starts with `/`;
  - a `host`, or a `host:port`, that is in the self-target set is rejected.
- `SET_METHOD`: the method is letters only.
- Cookie actions:
  - the cookie name is an RFC 6265 token;
  - `sameSite` is Strict, Lax or None;
  - `SameSite=None` requires `secure=true`.
- `SET_RESPONSE_ENCODING`: the encoding is in the allowed set.
- `ANSWER_WITH_*` / `REPLACE_WITH_RECORDED_RESPONSE`:
  - `answerId` must be a canonical lowercase UUID (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
    and must exist. Because the id becomes a file name in `answers/`, this rule is the path
    traversal guard for FR-024. The proxy re-checks the same pattern before building any path;
  - `ANSWER_WITH_FILE` needs a FILE answer, and the two recorded-call actions need a RECORDED
    answer;
  - `status` is 100..599 when it is given.
- Trailer and form actions: `name` is required; `value` is required for set.
- `REMOVE_*_JSON_FIELD`: `path` must pass `isValidPath` and must not end in `[*]`.
- MESSAGE actions: `messageDirection` must be valid; `durationMs` is 0..MAX_DELAY_MS; these
  actions are not allowed inside `IF_*`.
- The terminal-conflict and `SEND_TO_HOST` checks count the two new terminal actions.
- `validateAction`'s switch gains an explicit `default ->` that adds "unknown action type". A
  new enum constant with no case then fails `RuleValidatorTest` instead of passing without any
  validation.
