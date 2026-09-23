# Tasks: Interception Rule Actions at Parity with mitmproxy

**Input**: design documents in `specs/001-interception-mitmproxy-parity/`: plan.md, spec.md,
research.md, data-model.md, contracts/ and quickstart.md.

**Tests are included.** Constitution principle VI requires them, and the spec's acceptance
criteria depend on them:
- `EveryActionIsCoveredTest.SAMPLES` must list every new action;
- the help coverage spec must cover every new action;
- `RuleValidatorTest` must cover every new rejection.

Write each test task before the implementation task it covers, and watch it fail first.

## Path aliases (used in every task below)

| Alias | Path |
|---|---|
| `PX/` | `proxy/` |
| `BI/` | `backend/backend-interception/src/main/java/com/fathy/alfred/backend/interception/` |
| `BIT/` | `backend/backend-interception/src/test/java/com/fathy/alfred/backend/interception/` |
| `BC/` | `backend/backend-calls/src/main/java/com/fathy/alfred/backend/calls/` |
| `BCT/` | `backend/backend-calls/src/test/java/com/fathy/alfred/backend/calls/` |
| `BIC/` | `backend/backend-internal-calls/src/main/java/com/fathy/alfred/backend/internalcalls/` |
| `BICT/` | `backend/backend-internal-calls/src/test/java/com/fathy/alfred/backend/internalcalls/` |
| `BSC/` | `backend/backend-session-cycles/src/main/java/com/fathy/alfred/backend/sessioncycles/` |
| `BR/` | `backend/backend-resend/src/main/java/com/fathy/alfred/backend/resend/` |
| `BRT/` | `backend/backend-resend/src/test/java/com/fathy/alfred/backend/resend/` |
| `BA/` | `backend/backend-app/src/main/java/com/fathy/alfred/backend/` |
| `FE/` | `frontend/src/app/` |

## Rules that apply to every action task (from docs/interception.md "Adding an action")

Adding one action means all of the following:
- the `ActionType` constant, in the correct `Phase`, with its name matching the proxy string
  exactly;
- a case in `RuleValidator.validateAction`;
- the kind added to `REQUEST_ACTIONS`, `RESPONSE_ACTIONS` or `MESSAGE_ACTIONS`, plus a handler
  in `PX/interception.py`;
- a `SAMPLES` entry in `EveryActionIsCoveredTest`, or a `NO_CHANGE` entry with its reason;
- in `FE/core/models/interception.model.ts`: the TS `ActionType` union, `ACTION_LABELS` and a
  `describeAction` case;
- `defaultsFor()` in `FE/components/rule-editor/rule-editor.component.ts`;
- a field block in `FE/components/rule-action-card/rule-action-card.component.html`;
- an `ACTION_HELP` entry in `FE/shared/utils/interception-help.ts` whose `what` is longer than
  40 characters.

Also:
- An action that finds nothing to change must record `skipped - <reason>`.
- A secret value must never appear in a `detail`.
- Never write before/after capture code: capture is generic (docs/interception.md "Before and
  after").

---

## Phase 1: Setup

- [X] T000 **Gate (constitution: Development Workflow).** Build static HTML mocks in `mockups/`,
  in the style of `mockups/interception-mock.html`, for:
  - `mockups/answer-picker-mock.html`: the recorded-call picker (outbound/inbound), the upload
    mode, and the keep/strip secrets dialog;
  - `mockups/resend-dialog-mock.html`: the edit form, the "resend with current session" option,
    the result panel, and bulk-resend progress;
  - `mockups/ws-messages-mock.html`: the message list on a call card, with the edited/dropped
    badges and the "N earlier messages not recorded" line;
  - `mockups/rule-editor-matchers-mock.html`: the "Only when…" match-test rows and the new
    Messages lane.

  Show the mocks to the user and wait for an explicit "start". **No frontend task (any task
  touching `FE/`) may begin before this approval.**
- [X] T001 Create module `backend/backend-resend/`:
  - `pom.xml`: copy the shape of `backend/backend-profiles/pom.xml`, with artifactId
    `backend-resend` and dependencies spring-boot-starter-web, spring-boot-starter-validation
    and backend-platform.
  - `src/main/java/com/fathy/alfred/backend/resend/` with the empty package tree
    `domain/model`, `application/port/in`, `application/port/out`, `application/service`,
    `adapter/in/web` and `adapter/out/http`.
  - Register it in `backend/pom.xml` `<modules>`, and as a dependency in
    `backend/backend-app/pom.xml` and `backend/backend-architecture-test/pom.xml`.
- [X] T002 [P] In
  `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java`:
  - add `resendSliceMustNotDependOnOtherSlices`, forbidding `..backend.resend..` from depending
    on calls, internalcalls, comments, export, sessioncycles, profiles, settings, interception,
    calloverlap and redactions;
  - add `..backend.resend..` to every other slice's forbidden list, next to the existing
    `..backend.interception..` entries (:74, 90, 101, 119, 133, 147, 162, 177).
- [X] T003 [P] Edit `docker-compose.yml`:
  - **proxy and reverse-proxy**:
    - mount `./proxy/regex_worker.py` and `./proxy/ws_messages.py` read-only into
      `/home/mitmproxy/`, next to the existing `interception.py` mounts;
    - add env `INTERCEPTION_REGEX_TIMEOUT_MS=2000` and
      `INTERCEPTION_ANSWER_CACHE_BYTES=33554432`;
    - add env `BACKEND_HOST=backend`.
  - **backend**:
    - mount `./proxy/certs:/appdata/mitm-certs:ro`;
    - append `-Djdk.httpclient.allowRestrictedHeaders=host` to `JAVA_TOOL_OPTIONS`;
    - add env `INTERCEPTION_MAX_ANSWER_BYTES=10485760`.
- [X] T004 [P] Add `resend` to the API prefix alternation in `gateway/nginx.conf:33`: `(calls|…|health)` becomes `(calls|…|health|resend)`.
- [X] T005 [P] Add these keys, each with a one-line why-comment in the file's existing style, to
  `backend/backend-app/src/main/resources/application.properties`:
  - `alfred.interception.max-answer-bytes=${INTERCEPTION_MAX_ANSWER_BYTES:10485760}`
  - `spring.servlet.multipart.max-file-size=${INTERCEPTION_MAX_ANSWER_BYTES:10485760}`
  - `spring.servlet.multipart.max-request-size=10551296`
  - `alfred.calls.ws-max-messages=1000`
  - `alfred.internal-calls.ws-max-messages=1000`
  - `alfred.resend.timeout-ms=120000`
  - `alfred.resend.forward-proxy=proxy:8080`
  - `alfred.resend.reverse-proxy-host=reverse-proxy`
  - `alfred.resend.mitm-ca-file=/appdata/mitm-certs/mitmproxy-ca-cert.pem`

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: an async engine, the pattern engine, skip records, a single masking list, phase and
terminal flags from the backend, and the inbound interception record.

### Proxy engine

- [X] T006 [P] Write `PX/test_regex_worker.py` (stdlib unittest, `IsolatedAsyncioTestCase`),
  covering:
  - `sub` replaces all matches, and respects `count`;
  - `search` returns match presence;
  - a pathological pattern `(a+)+$` against `'a'*40+'b'` returns `timed_out=True` within
    timeout + 500 ms;
  - after a timeout, the next call succeeds (the worker restarted);
  - 4 concurrent `sub` calls all complete.
- [X] T007 Create `PX/regex_worker.py`:
  - one persistent `multiprocessing` worker process (context `forkserver`), with a duplex
    `Pipe`;
  - `async def sub(pattern, flags, repl, text, count, timeout_ms)` returns
    `(text_or_None, n, timed_out)`, and `async def search(pattern, flags, text, timeout_ms)`
    returns `(bool, timed_out)`;
  - requests are serialised through an `asyncio.Lock`. The pipe wait runs on a dedicated
    single-thread `ThreadPoolExecutor`, never on the default executor;
  - on timeout: `terminate()`, then `join(1)`, then start a new worker;
  - the worker keeps an LRU of 64 compiled patterns;
  - the timeout default is read from `INTERCEPTION_REGEX_TIMEOUT_MS`;
  - the module docstring explains why a process: CPython `re` holds the GIL (research R1).
- [X] T008 Add class `_Pattern` to `PX/interception.py`, built once in `_prepare_actions` from an
  action's `pattern`, `replacement`, `regex`, `caseSensitive` and `maxReplacements`:
  - **literal and case-sensitive**: uses `str.count` / `str.replace` in-process;
  - **literal and case-insensitive**: `re.escape` + `re.IGNORECASE` in-process (linear, so
    safe);
  - **regex**: delegates to `regex_worker`;
  - exposes `async def replace(text) -> (new_text_or_None, n, reason)`, where `reason` is
    `'no match'` or `'pattern timed out after N ms'`;
  - rejects patterns longer than `limits.maxPatternLength` (default 500) at load time, and
    records the action as skipped.
- [X] T009 Make these `async def` in `PX/interception.py`:
  - `InterceptionEngine.apply_request` (:933)
  - `apply_response` (:1132)
  - `_apply_request_action` (:958)
  - `_apply_response_action` (:1153)
  - `_run_conditional` (:1082)
  - `_run_branch` (:1114)

  The existing handlers keep their synchronous bodies. Only the dispatch chain awaits.
- [X] T010 Await the engine in both addons:
  - `PX/log_and_route.py:160`, `:326`
  - `PX/log_and_route_reverse.py:158`, `:295`
- [X] T011 Migrate every engine-calling test class in `PX/test_interception.py` to
  `unittest.IsolatedAsyncioTestCase`, through one `run = lambda coro: …` helper, or by making
  the test methods async. The whole existing suite must pass unchanged in meaning.
- [X] T012 Add `_skip(verdict, rule, kind, reason)` to `PX/interception.py`. It records
  `f'skipped - {reason}'`. Use it in three places:
  - for an unknown kind in the request, response and message dispatch, with reason
    `unknown action <TYPE>` (FR-022);
  - for the existing silent no-ops, with reasons `no such header`, `no such parameter` and
    `path not found`:
    - REMOVE_REQUEST_HEADER (:985)
    - REMOVE_QUERY_PARAM (:999)
    - SET_REQUEST_JSON_FIELD (:1008)
    - REMOVE_RESPONSE_HEADER
    - SET_RESPONSE_JSON_FIELD
  - update the affected assertions in `PX/test_interception.py`.
- [X] T013 Write the failing tests first, in `BeforeAfterTest` in `PX/test_interception.py`:
  - an `Authorization` header in `original_request`/`final_request` is written as
    `(value not logged · N chars)`;
  - `SET_QUERY_PARAM api_key=secret` does not show `secret` in `detail`.
- [X] T014 Implement masking in `PX/interception.py`:
  - `RuleSet` reads `sensitiveHeaders`, `selfTargets` and `limits` from the snapshot
    (`_RulesCache._load`, :273-305), falling back to `SENSITIVE_HEADERS` (:87-90);
  - add `mask_value(value)`, which returns `f'(value not logged · {len(value)} chars)'`;
  - `_snapshot` (:97-120) masks sensitive header values;
  - SET_QUERY_PARAM (:994) masks when the parameter name is in the sensitive list;
  - T013 passes.

### Backend foundation

- [X] T015 [P] Create `BI/domain/model/SensitiveHeaders.java` with
  `public static final Set<String> NAMES`, holding the same eight names as
  `PX/interception.py:87-90`. The Javadoc says the list is published to the proxies in the
  snapshot, so it is the single source of truth.
- [X] T016 [P] Write the failing corpus test `BIT/domain/PatternSafetyTest.java`:
  - **accept**: `EUR`, `\d{4}-\d{2}`, `(foo|bar)`, `<Token>(.*?)</Token>`;
  - **reject**:
    - nested quantifiers: `(a+)+`, `(a*)*`, `(a|aa)+`, `(\w+\s?)*`;
    - named groups: `(?<n>x)`, `(?P<n>x)`;
    - `(?<=x)`, `a++`, `(?>x)`;
    - a pattern of 501 characters;
    - a pattern that does not compile.
- [X] T017 [P] Create `BI/domain/model/PatternSafety.java`, with
  `static List<String> problems(String pattern, boolean regex)`:
  - checks the length is 1..500;
  - when `regex` is true: `Pattern.compile` must succeed; named-group, lookbehind,
    possessive/atomic and nested-quantifier constructs are rejected;
  - the nested-quantifier check is a character scanner that tracks group depth and whether a
    quantifier appeared inside a group that is itself quantified. It is not a regex.
  - T016 passes.
- [X] T018 Change the `switch` in `RuleValidator.validateAction`
  (`BI/domain/model/RuleValidator.java:122-219`) to have
  `default -> problems.add("Unknown action type " + action.type())`. Add a `RuleValidatorTest`
  case for it (`BIT/domain/RuleValidatorTest.java`).
- [X] T019 Add `MESSAGE` to `ActionType.Phase` (`BI/domain/model/ActionType.java`). Update the
  Javadoc about phases.
- [X] T020 Create `BI/domain/model/SelfTargets.java`, a record holding `Set<String> hosts` and
  `Set<String> hostPorts`, with `boolean includes(String host, Integer port)`. Then create
  `BI/adapter/out/rulesfile/SelfTargetsConfig.java`, a `@Configuration` that builds a
  `SelfTargets` bean from:
  - the service names backend, app-gateway, proxy, reverse-proxy and frontend;
  - `localhost`/`127.0.0.1`/`host.docker.internal` combined with:
    - `${BACKEND_PORT:5000}`
    - `3000`, as a literal constant with a comment that it mirrors the `app-gateway` port
      mapping in `docker-compose.yml` (`3000:80`). No environment variable exists for it.
    - `8080`
    - every `listenPort` in `${INTERNAL_CALL_SERVICES:}`
  - `127.0.0.2:443`.
- [X] T021 Extend `FileRulesPublisherAdapter.publish` (`BI/adapter/out/rulesfile/FileRulesPublisherAdapter.java:54-58`) to write:
  - `sensitiveHeaders`, from `SensitiveHeaders.NAMES`;
  - `selfTargets`, as a flat list of `host` and `host:port` strings;
  - `limits`: `{maxPatternLength:500, regexTimeoutMs:${INTERCEPTION_REGEX_TIMEOUT_MS:2000}}`.

  Update
  `BIT/adapter/out/rulesfile/FileRulesPublisherAdapterTest.java` to assert the three keys.
  Also add `GET /interception/sensitive-headers`, which returns `{names:[…]}` from
  `SensitiveHeaders.NAMES`, to `BI/adapter/in/web/InterceptionRulesController.java`. This is
  the frontend's only source for the list (contracts/rest-api.md).

### Inbound interception record (research R15)

- [X] T022 [P] Create `BIC/domain/model/CallInterception.java`, copying the shape of
  `BC/domain/model/CallInterception.java:28-88`: `Applied`, `Http` and `isEmpty()` with
  `@JsonIgnore`. The Javadoc says the duplication is deliberate: the slice mirrors
  backend-calls and has no shared code.
- [X] T023 Add `CallInterception interception` as the last component of
  `BIC/domain/model/CallRecord.java:35-49`. Add a constructor overload without it, following the
  `RuleAction` precedent, and update the positional call sites.
- [X] T024 Add `CallInterception interception` to
  `BIC/adapter/in/web/dto/CompleteInternalCallRequestDto.java:10-14`, and pass it through
  `InternalCallsWebhookController` → `InternalCallsService.complete` →
  `InternalCallsFileLogAdapter`'s merge-and-append (lines 248+), so it is written into the
  NDJSON line.
- [X] T025 [P] In `BICT/adapter/out/filelog/InternalCallsFileLogAdapterTest.java`, add:
  - `interception` round-trips through append, compaction and re-read;
  - a line written without the key reads as `null`.
- [X] T026 Expose `interception` on the list DTO returned by `GET /internal-calls` and on the
  detail. The controller is `BIC/adapter/in/web/InternalCallsController.java`; mirror how
  backend-calls' `CallSummaryDto` carries it. In `BSC/`, make the internal-call capture keep
  `interception` on the captured copy, and add the field to the captured-call record and JSON
  file / SQLite column if one is missing.
- [X] T027 [P] Check that `toCallRecord` (`FE/shared/utils/call-utils.ts:21-43`, which maps
  `interception` at :40) maps inbound summaries too. Add a spec case to
  `FE/shared/utils/call-utils.spec.ts` for an `internal` source with an interception record.
  Also add export guard specs (FR-021) in `FE/shared/utils/markdown-builder.spec.ts`,
  `html-builder.spec.ts` and `bulk-json-builder.spec.ts`, for an **inbound** call that carries
  an interception record with an `applied` entry, a `skipped - …` entry and a large before/after
  body:
  - the record is rendered in full, with nothing truncated;
  - the `.json` export round-trips through `parseImportedCalls` with the record intact.

  The fixtures must be built with `buildBulkExportPayload`, never by hand (CLAUDE.md). Every
  later story that adds an action relies on these specs and adds one sample of its own action
  to the fixture.

### Frontend foundation

- [X] T028 In `FE/core/state/interception-state.service.ts`, add `phaseOf(type)` and
  `isTerminal(type)`, both computed from the `actionTypes` signal (:130-136).
  - Add `'MESSAGE'` to `ActionPhase` in `FE/core/models/interception.model.ts:13`.
  - Make `actionPhase` (:590) a fallback that is used only before action types load.
  - Replace the hardcoded terminal and phase logic with calls to these two methods:
    - `alwaysShortCircuits` in `FE/components/rule-editor/rule-editor.component.ts:264`
    - `conflictHint` (:375-385)
    - the import preview's `terminal` flag in
      `FE/components/import-rules-dialog/import-rules-dialog.component.ts:74-75`, which fixes
      the missing SIMULATE_FAILURE
    - the phase filter in `FE/components/interception-panel/interception-panel.component.ts:126-133`
- [X] T029 [P] Add spec cases for `phaseOf` and `isTerminal` in
  `FE/core/state/interception-state.service.spec.ts`. They include `MOCK_RESPONSE`, which is
  REQUEST-phase, and a stubbed `ANSWER_WITH_RECORDED_CALL`, which is REQUEST-phase and terminal.

**Checkpoint**: the proxy unittest, `mvn test` and `ng test` all pass. Behaviour is unchanged
except for the skip records and the masking.

---

## Phase 3: User Story 1 — Find and replace text in any body (P1) 🎯 MVP

**Goal**: literal find/replace by default, with opt-in regex, in request and response bodies.

**Independent Test**: quickstart checks 1 and 2.

- [X] T030 [P] [US1] Add class `ReplaceInBodyTest` to `PX/test_interception.py`, covering:
  - a literal replaces all matches;
  - `maxReplacements=1`;
  - case-insensitive matching;
  - a regex with `\1`;
  - no match leaves the text identical (`is` the same object) and records
    `skipped - no match`;
  - a body with `stream=True` records `skipped - body was streamed, not buffered`;
  - `regex_worker.sub` patched to return `timed_out` records `skipped - pattern timed out…`.

  Add SAMPLES entries for REPLACE_IN_REQUEST_BODY and REPLACE_IN_RESPONSE_BODY (:1203-1232).
  Also add:
  - **inside a branch (FR-014)**: a `ConditionalActionTest` case in which an `IF_RESPONSE`
    branch holds REPLACE_IN_RESPONSE_BODY and applies it only when the condition holds;
  - **realistic size (SC-006, constitution VI)**: a 5 MB generated SOAP-like body with 10,000
    occurrences is fully replaced, and the result length is exact;
  - **compressed body (FR-017)**: give `FakeMessage` an optional `content_encoding` whose
    `text` setter records a re-encode, and assert that an edit on a `gzip` body goes through
    the setter, so the encoding is preserved. The real decoding is verified by quickstart
    check 1.
- [X] T031 [P] [US1] Add `RuleValidatorTest` cases in `BIT/domain/RuleValidatorTest.java`:
  - a missing pattern;
  - a nested-quantifier regex rejected only when `regex=true`;
  - `maxReplacements` of 0 and of 10001 rejected;
  - a literal `$10.00` accepted.
- [X] T032 [US1] Add `REPLACE_IN_REQUEST_BODY(Phase.REQUEST)` and
  `REPLACE_IN_RESPONSE_BODY(Phase.RESPONSE)` to `BI/domain/model/ActionType.java`. Add the
  fields `pattern`, `replacement`, `regex` (Boolean), `caseSensitive` (Boolean) and
  `maxReplacements` (Integer) to `BI/domain/model/RuleAction.java`:
  - keep the existing 13- and 14-arg constructors delegating to the new canonical one;
  - update `of()`;
  - `caseSensitive` defaults to true in the compact constructor.
- [X] T033 [US1] Add a case for both types to `RuleValidator.validateAction`: the pattern is
  required, `PatternSafety.problems(pattern, regex)` is applied, and `maxReplacements` must be
  1..10000.
- [X] T034 [US1] In `PX/interception.py`:
  - add both kinds to the action sets;
  - `_prepare_actions` stores `action['__pattern'] = _Pattern(action, limits)`;
  - the handlers `await pattern.replace(message.text)`, assign `message.text` only when the
    result is not None, and record `f'{n} replacement(s)'`;
  - there is a stream guard (`getattr(message, 'stream', False)` or `raw_content is None`).
- [X] T035 [US1] Frontend model, in `FE/core/models/interception.model.ts`: add both types to
  `ActionType`; add `pattern`, `replacement`, `regex`, `caseSensitive` and `maxReplacements` to
  `RuleAction`; add `ACTION_LABELS` ("Find & replace in request body" / "…response body"); add
  `describeAction`, as ``replace "EUR" → "USD" (all)``, with a regex shown as `/…/`.
- [X] T036 [US1] Rule editor:
  - add `isBodyReplace(type)` to `FE/components/rule-editor/rule-editor.component.ts`, next to
    :860-904;
  - extend `onText` to accept `pattern` and `replacement`, and add `onToggle(path, field)` for
    `regex` and `caseSensitive`;
  - `onNumber` accepts `maxReplacements`;
  - `defaultsFor` returns `{pattern:'', replacement:'', regex:false, caseSensitive:true}`;
  - add a field block in `FE/components/rule-action-card/rule-action-card.component.html`, with
    a pattern input, a replacement input, a "Regex" checkbox with a hint about `\1`, a
    "Match case" checkbox and an optional max count.
- [X] T037 [P] [US1] Add `ACTION_HELP` entries in `FE/shared/utils/interception-help.ts`:
  - worked examples on a SOAP body (`<Currency>EUR</Currency>`) and on a plain-text date;
  - a `warning` explaining literal versus regex and the timeout.

**Checkpoint**: US1 works on its own, both outbound and inbound.

---

## Phase 4: User Story 2 — Re-route a call or change its method (P1)

**Independent Test**: quickstart check 3.

- [X] T038 [P] [US2] In `PX/test_interception.py`:
  - extend `FakeRequest` (:67-83) with `scheme`, `port`, `host_header`, a `url` setter and a
    `pretty_url` recompute;
  - add `RewriteUrlTest`, covering:
    - a structured host swap sets `host_header` unless `keepHostHeader`;
    - a path-only rewrite keeps the scheme, host, port and query;
    - a pattern rewrite of `/v1/` to `/v2/`;
    - a result host in the snapshot's `selfTargets` records
      `refused - target is Alfred itself` and leaves the request unchanged;
  - add `SetMethodTest`;
  - add SAMPLES entries.
- [X] T039 [P] [US2] Add `RuleValidatorTest` cases:
  - no target part and no pattern;
  - a bad scheme, or a port of 0 or 65536;
  - a path without a leading `/`;
  - a host of `backend`, or `localhost:5000`, rejected through a supplied `SelfTargets`;
  - `SET_METHOD` with a value of `GE T`.
- [X] T040 [US2] Create `BI/domain/model/UrlTarget.java`, a record
  `(String scheme, String host, Integer port, String path)` with `@JsonInclude(NON_NULL)`. Add
  the RuleAction fields `target`, `keepHostHeader` and `method`. Add
  `REWRITE_URL(Phase.REQUEST)` and `SET_METHOD(Phase.REQUEST)` to `ActionType`.
- [X] T041 [US2] Add the overload `RuleValidator.validate(InterceptionRule, SelfTargets)`, which
  keeps `validate(rule)` delegating with an empty `SelfTargets`, and add the REWRITE_URL and
  SET_METHOD cases. `BI/application/service/InterceptionRulesService.java` injects
  `SelfTargets` and calls the overload in create, update and import (:226-231).
- [X] T042 [US2] Add handlers in `PX/interception.py`:
  - **REWRITE_URL**: the structured form assigns the parts that are set; the pattern form uses
    `_Pattern` on `request.pretty_url` and then assigns `request.url`. The final
    `host`/`host:port` is checked against the ruleset's `self_targets` and refused on a match.
    Unless `keepHostHeader`, `request.host_header` is set to the new authority. The record is
    `f'{old_url} → {new_url}'`.
  - **SET_METHOD**: upper-cases the method, and records `f'{old} → {new}'`.
- [X] T043 [US2] Frontend:
  - add the types, fields, labels and a `describeAction` case in `FE/core/models/interception.model.ts`;
  - add an `isRewrite` predicate and handlers in `rule-editor.component.ts`;
  - add a field block in `rule-action-card.component.html`:
    - a Structured/Pattern mode toggle;
    - scheme select, host, port and path inputs;
    - a "Keep original Host header" checkbox;
    - the pattern inputs, reusing the US1 inputs;
    - a method select for SET_METHOD (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, or custom).
- [X] T044 [P] [US2] Add help entries for REWRITE_URL (production → staging supplier) and
  SET_METHOD in `FE/shared/utils/interception-help.ts`. The warning names the self-target
  refusal.

---

## Phase 5: User Story 3 — Remove a JSON field, or replace the request body (P1)

**Independent Test**: quickstart check 4.

- [X] T045 [P] [US3] Add tests to `PX/test_interception.py`:
  - `RemoveJsonFieldTest`: `segments[*].cabin` removed from 3 segments, other fields untouched;
    `items[1]` removes the element; a missing path records `skipped - path not found` with the
    text identical;
  - a JsonPathTest-style unit test for the new `remove_json_field`;
  - SET_REQUEST_BODY sets the body, and sets `content-type` when it is given.

  Add SAMPLES entries for all three actions. Also add:
  - **inside a branch (FR-014)**: a `ConditionalActionTest` case with an `IF_REQUEST` branch
    holding REMOVE_REQUEST_JSON_FIELD;
  - **realistic size (SC-006)**: removing `segments[*].cabin` from a 5 MB generated itinerary
    with 20,000 segments leaves every other field intact.
- [X] T046 [P] [US3] Add `RuleValidatorTest` cases: a remove path ending in `[*]` is rejected;
  an invalid path is rejected; SET_REQUEST_BODY with a null body is rejected.
- [X] T047 [US3] Add `REMOVE_REQUEST_JSON_FIELD`, `REMOVE_RESPONSE_JSON_FIELD` and
  `SET_REQUEST_BODY` to `ActionType`. Add the `contentType` field to `RuleAction`. Add the
  validator cases, reusing `isValidPath` (`RuleValidator.java:353-377`).
- [X] T048 [US3] In `PX/interception.py`:
  - add `remove_json_field(text, path)` next to `set_json_field` (:819-840), reusing
    `_parse_path`. It returns None when nothing was removed;
  - add the handlers, which assign `.text` only on change.
- [X] T049 [US3] Frontend:
  - add the types, labels and `describeAction` cases;
  - reuse the JSON path input: an `isJsonPathOnly` predicate for the remove types;
  - extend `isBodyOnly` to SET_REQUEST_BODY, with an optional content-type input;
  - add `defaultsFor` entries;
  - edit the card html.
- [X] T050 [P] [US3] Add help entries: "field missing vs null", on an itinerary payload.

**Checkpoint**: MVP scope (US1 to US3) is complete. Stop, validate and demo here.

---

## Phase 6: User Story 4 — Edit cookies and form fields (P2)

**Independent Test**: quickstart check 5.

- [X] T051 [P] [US4] Add tests to `PX/test_interception.py`:
  - `edit_cookie_header('session=a; consent=b; theme=c', 'consent', None)` returns
    `'session=a; theme=c'` exactly; set replaces a value; set appends a new cookie;
  - Set-Cookie set replaces the entry with the same name and keeps the others; remove; expire
    (`Max-Age=0`); attribute rendering;
  - forms: urlencoded set and remove; a multipart text field; a multipart file part left
    untouched; a JSON body records `skipped - not a form`;
  - no cookie value appears in any `detail`.

  Extend `FakeRequest` / `FakeHeaders` with `get_all`/`set_all`, `urlencoded_form` and
  `multipart_form`. Add SAMPLES entries for all six actions.
- [X] T052 [P] [US4] Add `RuleValidatorTest` cases: a cookie name that is not a token is
  rejected; `sameSite=Foo` is rejected; `SameSite=None` without `secure` is rejected.
- [X] T053 [US4] Create `BI/domain/model/CookieAttributes.java`, a record
  `(path, domain, Integer maxAge, Boolean secure, Boolean httpOnly, String sameSite)`. Add the
  RuleAction field `cookieAttributes`. Add six ActionTypes:
  - `SET_REQUEST_COOKIE`, `REMOVE_REQUEST_COOKIE`
  - `SET_RESPONSE_COOKIE`, `REMOVE_RESPONSE_COOKIE`
  - `SET_FORM_FIELD`, `REMOVE_FORM_FIELD`

  Add their validator cases.
- [X] T054 [US4] In `PX/interception.py`, add `edit_cookie_header`, a token-level edit that
  preserves the separators and spacing of the other cookies, plus a `set_cookie_line` builder
  and handlers for all six actions. Form edits go through `request.urlencoded_form` /
  `request.multipart_form`; parts with a filename are skipped. The detail names the cookie or
  field and uses `mask_value` for the value.
- [X] T055 [US4] Frontend: add the types, labels and `describeAction` cases, masking cookie
  values. Add card blocks:
  - a cookie name and value;
  - an attributes sub-block for SET_RESPONSE_COOKIE (path, domain, max-age, secure, http-only,
    same-site select);
  - a form field name and value.

  Add `defaultsFor` entries.
- [X] T056 [P] [US4] Add help entries: expiring a session, dropping a consent cookie, changing a
  form `amount`.

---

## Phase 7: User Story 5 — Control caching and compression (P2)

**Independent Test**: quickstart check 6.

- [X] T057 [P] [US5] Add tests to `PX/test_interception.py`:
  - DISABLE_CACHE records the header names it removed (`if-none-match, if-modified-since`), or
    `skipped - no conditional headers`;
  - DISABLE_COMPRESSION sets `accept-encoding: identity`;
  - SET_RESPONSE_ENCODING calls decode, then `encode(enc)` (the fake records the calls);
    `identity` only decodes; a body already in that encoding records a skip.

  Add SAMPLES entries.
- [X] T058 [P] [US5] Add a `RuleValidatorTest` case: an encoding of `lzma` is rejected.
- [X] T059 [US5] Add `DISABLE_CACHE`, `DISABLE_COMPRESSION` and `SET_RESPONSE_ENCODING` to
  `ActionType`. Add the RuleAction field `encoding`. The validator allows gzip, deflate, br,
  zstd and identity.
- [X] T060 [US5] Add handlers in `PX/interception.py`. DISABLE_CACHE pops the headers explicitly
  so it can record their names; it does not call `anticache()`.
- [X] T061 [US5] Frontend:
  - the DISABLE_* actions render through `isBare` with an explanatory else-text (card html
    :348-356);
  - SET_RESPONSE_ENCODING uses an `app-select-picker` with the five encodings;
  - add labels, `describeAction` cases and `defaultsFor` entries.
- [X] T062 [P] [US5] Add help entries.

---

## Phase 8: User Story 11 — Match rules on headers, query parameters and cookies (P2)

**Independent Test**: quickstart check 12.

- [X] T063 [P] [US11] Add tests to `MatchingTest` in `PX/test_interception.py`:
  - header EXISTS, NOT_EXISTS and EQUALS (case-insensitive name);
  - query EQUALS;
  - cookie CONTAINS;
  - MATCHES compiles once (patch `re.compile` and count the calls);
  - a rule with `stopProcessing` and a header test does not stop a later rule when the header
    is absent;
  - the tests are evaluated after a failing host check (assert the header was never read).
- [X] T064 [P] [US11] Add `RuleValidatorTest` cases: a missing name; an EQUALS test without a
  value; a MATCHES test that fails `PatternSafety`.
- [X] T065 [US11] Create `BI/domain/model/MatchTest.java`, a record
  `(String name, Operator operator, String value, Boolean caseSensitive)` with
  `enum Operator {EXISTS, NOT_EXISTS, EQUALS, CONTAINS, MATCHES}`. Add the `headers`, `query`
  and `cookies` lists to `BI/domain/model/RuleMatch.java`; the compact constructor turns null
  into `List.of()`. Extend `validateMatch` (`RuleValidator.java:98-120`).
- [X] T066 [US11] In `PX/interception.py`:
  - `Match.__init__` parses the three lists and pre-compiles the MATCHES regexes;
  - change `matches` to `matches(self, source, service_name, request)`, evaluating the new
    tests after the existing checks;
  - update the caller `_matching` (:914-931) and the MatchingTest call sites.
- [X] T067 [US11] Frontend:
  - add `MatchTest` and the three lists to `RuleMatch` in `FE/core/models/interception.model.ts`;
  - `describeMatch` (:514-525) states the tests, and masks the value when the name is in the
    sensitive list. The frontend gets that list **only** from `GET
    /interception/sensitive-headers`, through a `sensitiveHeaders` signal in
    `interception-state.service.ts` with `shareReplay(1)`. This keeps `SensitiveHeaders.NAMES`
    as the single source of truth (research R7), and no copy of the list exists in the
    frontend;
  - rule editor:
    - add signals (:345-350) and loading (:433-446);
    - add a "Only when…" section with a row per test: kind (Header / Query / Cookie), name,
      operator select, value, and remove;
    - save it in `save()` (:938-962).
- [X] T068 [P] [US11] Add a `MATCH_TEST_HELP` entry in `FE/shared/utils/interception-help.ts`
  that explains the `stopProcessing` precedence advantage over conditions. Extend
  `interception-help.spec.ts` to require it.

---

## Phase 9: User Story 6 — Answer with a recorded call (P3)

**Goal**: the stored-answers foundation, which US7 re-uses, plus the recorded-call actions,
including inbound sources and the keep/strip prompt.

**Independent Test**: quickstart check 7.

### Tests first

- [X] T069 [P] [US6] `BIT/application/service/StoredAnswersServiceTest.java`, with fake ports,
  covering:
  - a copy over the cap is refused with `limitBytes` and `sizeBytes`;
  - a response with `set-cookie` and no `keepSecrets` gives `SecretsDecisionRequired` with
    `secretNames`;
  - `keepSecrets=false` strips the headers, and the Set-Cookie cookies with them;
  - `keepSecrets=true` keeps them and records `secretsKept=true`;
  - no secrets gives `secretsKept=null`;
  - `retainReferenced` deletes unreferenced answers;
  - the orphan sweep deletes unreferenced answers older than 1 h and keeps newer ones.
- [X] T070 [P] [US6] `BIT/adapter/out/sqlite/SqliteStoredAnswersStoreAdapterTest.java`, against
  a `@TempDir` DB file: save, find the metadata without the body, find the body, delete
  (cascade).
- [X] T071 [P] [US6] Extend `BIT/adapter/out/rulesfile/FileRulesPublisherAdapterTest.java`:
  - answers are written as `answers/<id>.meta.json` and `.body`;
  - they are written before `rules.json`, checked by write order through a spy or by mtime;
  - unreferenced files are deleted.
- [X] T072 [P] [US6] Add `RuleValidatorTest` cases: an `answerId` of `../rules` or
  `a/b`, rejected as not a UUID; an `answerId` that does not exist; a FILE
  answer used by ANSWER_WITH_RECORDED_CALL; two terminals (ANSWER_WITH_RECORDED_CALL plus
  MOCK_RESPONSE); SEND_TO_HOST plus ANSWER_WITH_RECORDED_CALL.
- [X] T073 [P] [US6] Extend `BIT/application/service/InterceptionRulesServiceTest.java`: export
  version 2 embeds the answers with `answerRef`; importing version 2 creates new answer ids and
  rewrites the references; importing version 1 still works.
- [X] T074 [P] [US6] In `PX/test_interception.py`, add `StoredAnswerTest`, using `_AnswerCache`
  on a tmpdir:
  - ANSWER_WITH_RECORDED_CALL is terminal and short-circuits with the recorded status, headers
    and body;
  - an earlier SEND_TO_HOST latch records the skip, matching `:1037-1053`;
  - a missing answer records `skipped - stored answer <id> not found`;
  - an `answerId` of `../rules` records `skipped - invalid stored answer id`, and no file
    outside `answers/` is opened (assert through a patched `open`);
  - REPLACE_WITH_RECORDED_RESPONSE replaces the response;
  - `refreshDates` sets the verdict flag;
  - the cache evicts above the byte cap.

  Add SAMPLES entries.

### Implementation

- [X] T075 [US6] Create `BI/domain/model/StoredAnswer.java`, a record per data-model §4, with
  `enum Kind {RECORDED, FILE}`. Add `ANSWER_WITH_RECORDED_CALL(Phase.REQUEST)` and
  `REPLACE_WITH_RECORDED_RESPONSE(Phase.RESPONSE)` to `ActionType`, and add
  ANSWER_WITH_RECORDED_CALL to `isTerminal()` (:91-93). Add the RuleAction fields `answerId`
  and `refreshDates`.
- [X] T076 [US6] Create the ports:
  - `BI/application/port/out/StoredAnswersStorePort.java`: `save(StoredAnswer, byte[])`,
    `findMeta(id)`, `findBody(id)`, `listMeta()`, `delete(id)`;
  - `BI/application/port/out/RecordedCallLookupPort.java`:
    `Optional<RecordedResponse> find(String direction, String callId, String cycleId)`, with a
    nested record `RecordedResponse(int status, Map<String,String> headers, byte[] body,
    String recordedAt)`;
  - `BI/application/port/in/ManageStoredAnswersUseCase.java`: `copyFromCall(...)`, which
    returns a sealed result `Created | SecretsDecisionRequired(List<String>) | NotFound |
    TooLarge(limit, size)`, plus `upload(...)` (used in US7), `get(id)` and `body(id)`.
- [X] T077 [US6] Add the stored-answer tables (data-model §4) to the schema bootstrap of
  `BI/adapter/out/sqlite/SqliteInterceptionRulesRepository.java` (:74-88). Create
  `BI/adapter/out/sqlite/SqliteStoredAnswersStoreAdapter.java`, which re-uses that repository's
  pool through a package-private accessor, is annotated `@ConditionalOnProperty(prefix =
  "alfred.storage.interception", name = "type", havingValue = "sqlite", matchIfMissing = true)`,
  and never selects the body in `listMeta`.
- [X] T078 [P] [US6] Create `BI/adapter/out/filestore/JsonFileStoredAnswersStoreAdapter.java`
  (`havingValue = "file"`). It keeps the metadata in
  `${INTERCEPTION_ANSWERS_DIR:/appdata/interception-answers}/index.json` and the bodies as
  `<id>.body`, and writes atomically with a temp file and a move.
- [X] T079 [US6] Create `BI/application/service/StoredAnswersService.java`:
  - `@Value("${alfred.interception.max-answer-bytes}")`;
  - secret detection over `SensitiveHeaders.NAMES`;
  - a strip path;
  - `retainReferenced(Set<String> ids)`;
  - `@Scheduled(fixedDelay = 600_000)` orphan sweep with a 1 h grace period.

  In `InterceptionRulesService.persist` (:234-239), collect the answer ids of every rule, call
  `retainReferenced`, and then publish.
- [X] T080 [US6] Change `RulesPublisherPort.publish` (`BI/application/port/out/RulesPublisherPort.java:28`) to
  `publish(boolean enabled, List<InterceptionRule> rules, List<PublishedAnswer> answers)`.
  `FileRulesPublisherAdapter` then writes each answer's meta and body atomically into
  `answers/` **before** `rules.json`, and deletes answer files that are no longer referenced.
  Update `RecordingPublisher` in `InterceptionRulesServiceTest`.
- [X] T081 [US6] Extend `RuleValidator`: add the parameter
  `Function<String, Optional<StoredAnswer.Kind>> answerKinds` to the overload from T041.
  `answerId` must match the UUID pattern (data-model §9) before it is looked up.
  ANSWER_WITH_RECORDED_CALL and REPLACE_WITH_RECORDED_RESPONSE require RECORDED; add them to
  the terminal and SEND_TO_HOST conflict counting (:55-94).
- [X] T082 [US6] Create `BI/adapter/in/web/StoredAnswersController.java` with these routes, per
  contracts/rest-api.md:
  - `POST /interception/answers/from-call`
  - `GET /interception/answers/{id}`
  - `GET /interception/answers/{id}/body`

  The DTO `BI/adapter/in/web/dto/CopyAnswerRequestDto.java` is validated with `@Valid`. The
  sealed result maps to 201 / 409 / 404 / 413.
- [X] T083 [US6] Create the bridge `BA/interceptionbridge/RecordedCallLookupAdapter.java`
  (`@Component implements RecordedCallLookupPort`). It resolves:
  - `outbound` through backend-calls' detail use case;
  - `inbound` through backend-internal-calls' `GetCallDetailUseCase` (`BIC/application/port/in/GetCallDetailUseCase.java:10`);
  - a `cycleId` through backend-session-cycles' detail use case.

  Follow the `BA/filtering/CallFilterAdapter.java` pattern. Add a test in
  `backend/backend-app/src/test/java/com/fathy/alfred/backend/interceptionbridge/RecordedCallLookupAdapterTest.java`
  with mocked use cases.
- [X] T084 [US6] Rules export and import, version 2: add `GET /interception/rules/export?ids=`
  to `BI/adapter/in/web/InterceptionRulesController.java`, and extend
  `InterceptionRulesService.importRules` (:176-205) and `ImportRequestDto` (:94) to accept
  `answers[]`, per contracts/rules-snapshot-and-file.md §3.
- [X] T085 [US6] In `PX/interception.py`:
  - add `_AnswerCache`: mtime-checked per file, and an LRU capped by
    `INTERCEPTION_ANSWER_CACHE_BYTES`. It accepts only ids that fully match the UUID pattern
    in data-model §9 before joining them onto the answers directory (the FR-024 path-traversal
    guard);
  - add the ANSWER_WITH_RECORDED_CALL handler: it respects `must_reach_host`, sets
    `verdict.mock = {status, headers, body_bytes}` and `verdict.terminal`, and records
    `recorded answer <id>, upstream never contacted`;
  - add the REPLACE_WITH_RECORDED_RESPONSE handler;
  - set `verdict.refresh_dates`.

  In both addons' `_decide` (`PX/log_and_route.py:238-242`, `PX/log_and_route_reverse.py`),
  accept `body_bytes`, and call `flow.response.refresh()` when `refresh_dates` is set. Also call
  it after a response-phase replace, in the `response` hook.
- [X] T086 [US6] Frontend services and state:
  - add `StoredAnswer` / `SecretsDecisionRequired` types in `FE/core/models/interception.model.ts`;
  - add `copyAnswerFromCall`, `getAnswer`, `exportRules(ids)` and a version-2 `importRules` in
    `FE/core/services/interception-api.service.ts`.
- [X] T087 [US6] Create `FE/components/answer-picker/answer-picker.component.{ts,html}`, a
  standalone component using signals:
  - a direction toggle (Outbound / Inbound) and a search box that calls
    `CallsApiService.getCalls(source, …)`;
  - picking a call calls `copyAnswerFromCall`. On a 409 it shows the keep/strip dialog, listing
    `secretNames` and warning that "kept secrets travel with exported rules". It then retries
    with the choice;
  - once an answer exists, it shows its metadata (status, size, source, secretsKept badge).

  `rule-action-card` renders it for the answer actions.
- [X] T088 [US6] Rules file version 2:
  - in `FE/shared/utils/interception-rules-file.ts`, `parseRulesFile` accepts versions 1 and 2;
  - `FE/pages/interception/interception.component.ts:70-83` exports through
    `exportRules(ids)`, then `downloadJson`;
  - `import-rules-dialog` posts the version-2 answers;
  - duplicate keeps `answerId`, which `interception-state.service.ts:251-261` already does.
- [X] T089 [P] [US6] Frontend specs:
  - `FE/shared/utils/interception-rules-file.spec.ts`: version-1 and version-2 parsing, and a
    calls export still rejected;
  - `FE/components/answer-picker/answer-picker.component.spec.ts`: a 409 leads to the prompt,
    and the retry carries `keepSecrets`.
- [X] T090 [P] [US6] Add labels, `describeAction` cases and help entries for both actions, with a
  worked example of reproducing yesterday's bug. The warning covers kept secrets.

**Implementation notes (US6)**:
- `retainReferenced(ids)` became `release(before, after)`: an answer is deleted only when a save
  stops a rule referring to it, plus the 1 h orphan sweep. Deleting every unreferenced answer on
  each save would delete one just picked in an open editor whenever another rule was saved.
- The version-2 file transform (`answerId` to `answerRef` and back) lives in
  `InterceptionRulesController`, since it is a file-format concern; the service still does the import.
- `recordedAt` is the recorded response's `Date` header. `refreshDates` shifts through mitmproxy's
  own `Response.refresh()`, measured from that time.

---

## Implementer guide for the remaining tasks (T091-T132)

Phases 10-14 below are written so they can be carried out one task at a time without further
design work. Read this section once before starting any of them.

**State of the branch**: Setup, Foundational, US1-US6 are done (commits `6042e82`, `a2b9383`,
`8f87b43`). The code those phases added is the pattern to follow: stored answers
(`StoredAnswersService`, `answer-picker`), match tests (`MatchTest`, `_MatchTest`), cookies and
forms (`edit_cookie_header`, `edit_multipart`). When a task says "like X", open X and copy its
structure.

**Path abbreviations** (same as the rest of this file): `BI` / `BIT` = backend-interception
main / test Java root (`backend/backend-interception/src/{main,test}/java/com/fathy/alfred/backend/interception`),
`PX` = `proxy`, `FE` = `frontend/src/app`. Phase 11 defines a few more at its top.

**Rules that apply to every task**:
1. Follow `.specify/memory/constitution.md`: hexagonal slices (domain has no Spring imports;
   adapters depend on ports, never on services; slices never import each other — cross-slice
   reads go through a bridge in `backend-app`), no polling in the frontend, no `time.sleep` in
   the proxy (always `await asyncio.sleep`), exports never truncate.
2. Match the surrounding code: comments explain *why*, in full sentences, as the existing ones
   do; names are full words; no new dependencies (Maven, npm or pip) unless the task says so.
3. Secret values (the names in `SensitiveHeaders.NAMES`: authorization, proxy-authorization,
   cookie, set-cookie, x-api-key, api-key, x-auth-token, authentication) never go into a log line,
   an interception record detail, a resend-edits summary or an error message.
4. Line numbers in the tasks are where the code was when the task was written. If a number is
   off, search for the quoted code instead; never edit a line just because of its number.
5. Do not commit unless the user asks. Do not start, stop or rebuild the user's Docker stack
   (`docker compose …`) — only T132 does that, and only after the user says yes. Running
   throwaway containers (`docker run --rm …`) for Maven or the proxy tests is fine.
6. A task is done when its own tests pass and the suites listed below still pass. Mark it `[X]`
   in this file.

**Commands** (Git Bash on Windows; run from the directory named):
- Proxy (`proxy/`): `python -m unittest discover -s . -p "test_*.py"`
- Proxy in the real mitmproxy image (`proxy/`):
  `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/scripts" -w /scripts --entrypoint python3 mitmproxy/mitmproxy:latest -m unittest discover -s . -p "test_*.py"`
- Backend, one module (`backend/`; local Maven is JDK 8, so Maven always runs in Docker):
  `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app" -v alfred-m2:/root/.m2 -w //app maven:3.9-eclipse-temurin-21 mvn -B -q -pl <module> -am test`
  (`-q` prints nothing on success; failures print `[ERROR]` lines.)
- Backend, everything including ArchUnit: the same without `-pl <module> -am`.
- Frontend (`frontend/`): `npx ng test --watch=false --browsers=ChromeHeadless`, then
  `npx ng build`. The build prints a pre-existing "bundle initial exceeded maximum budget"
  warning; that is expected. One spec only: add
  `--include=src/app/<path>/<name>.spec.ts`.

**Editing tips**: on this machine, Bash heredocs mangle backslashes and quotes. For multi-line
edits use the editor tool, or write a small Python script to a temp file that does exact
`str.replace` with an `assert text.count(old) == 1` guard, and run it.

**Frontend gate**: T000 (mocks) is done and approved; the mocks are in `mockups/`. Every
frontend task must match its mock.

---

## Phase 10: User Story 7 — Answer with an uploaded file (P3)

**Depends on**: Phase 9 (stored answers), done in commit 8f87b43. Read these first; every
task below extends them rather than adding a parallel path:
- `BI/domain/model/StoredAnswer.java` (record, `Kind {RECORDED, FILE}`, `isValidId`)
- `BI/application/port/in/ManageStoredAnswersUseCase.java` (sealed `CopyResult`)
- `BI/application/service/StoredAnswersService.java`
- `BI/adapter/in/web/StoredAnswersController.java`
- `PX/interception.py`: `_AnswerCache`, `answer_parts`, and the `ANSWER_WITH_RECORDED_CALL` handler
- `FE/components/answer-picker/answer-picker.component.{ts,html}`

**Independent Test**: quickstart check 8.

- [ ] T091 [P] [US7] Write the backend tests for the upload.

  **(a) New file** `BIT/adapter/in/web/StoredAnswersControllerTest.java`. Copy the shape of
  `backend/backend-comments/src/test/java/com/fathy/alfred/backend/comments/adapter/in/web/CommentsControllerTest.java`:
  `@WebMvcTest(StoredAnswersController.class)`, `@Autowired MockMvc mockMvc`,
  `@MockBean ManageStoredAnswersUseCase answers`. The module's `TestApplication`
  (`BIT/TestApplication.java`) already exists; do not add another. Use
  `org.springframework.mock.web.MockMultipartFile` and `MockMvcRequestBuilders.multipart`.
  Four tests:
  1. `anUploadReturns201WithTheAnswer`: stub `answers.upload(eq("application/json"), eq(200), eq(2L), any())`
     to return `new UploadResult.Created(answer)`, where `answer` is a FILE `StoredAnswer` with
     id `3f2504e0-4f89-41d3-9a0c-0305e82c3301`. Perform
     `multipart("/interception/answers").file(new MockMultipartFile("file", "a.json", "application/json", "{}".getBytes())).param("contentType", "application/json").param("status", "200")`.
     Expect status 201 and `jsonPath("$.id").value(<id>)`, `jsonPath("$.kind").value("FILE")`.
  2. `anUploadOverTheCapReturns413WithBothSizes`: stub `upload` to return
     `new UploadResult.TooLarge(10, 11)`. Expect 413,
     `jsonPath("$.error").value("answer-too-large")`, `jsonPath("$.limitBytes").value(10)`,
     `jsonPath("$.sizeBytes").value(11)`.
  3. `anUploadWithNoContentTypeReturns415`: stub `upload` to return
     `new UploadResult.MissingContentType()`. Send the file with content type
     `MockMultipartFile("file", "a.bin", null, bytes)` and no `contentType` param. Expect 415
     and `jsonPath("$.error").value("content-type-required")`.
  4. `anUploadWithNoFilePartIs400`: perform `multipart("/interception/answers")` with no file.
     Expect 400. `verifyNoInteractions(answers)`.

  **(b) Extend** `BIT/application/service/StoredAnswersServiceTest.java` (the service is built
  in `setUp()` with a cap of 100 bytes and a fixed clock `NOW`). Add:
  1. `anUploadIsStoredAsAFileAnswerWithOnlyItsContentType`:
     `service.upload("text/csv", 201, 3, () -> "a,b".getBytes(UTF_8))` returns `Created`; the
     answer has `kind() == FILE`, `status() == 201`, `headers()` equal to
     `Map.of("content-type", "text/csv")`, `contentType() == "text/csv"`, `sizeBytes() == 3`,
     `secretsKept() == null`, `sourceDirection() == null`, `createdAt()` equal to
     `NOW.toString()`, and `store.bodies` holds the three bytes.
  2. `anUploadOverTheCapIsRefusedBeforeItsBytesAreRead`: pass a declared size of 101 and a
     body supplier that throws `AssertionError("read")`. The result equals
     `new UploadResult.TooLarge(100, 101)` and `store.meta` is empty.
  3. `anUploadWithABlankContentTypeIsRefused`: `upload("  ", null, 1, ...)` returns
     `MissingContentType`.
  4. `aMissingStatusDefaultsTo200`: `upload("text/plain", null, 1, ...)` gives `status() == 200`.
  5. `aDeclaredSizeThatLiesIsCheckedAgainstTheRealBytes`: declared size 1, supplier returns
     101 bytes. The result is `TooLarge(100, 101)`.

- [ ] T092 [P] [US7] Add proxy tests in `PX/test_interception.py`.

  - In `EveryActionIsCoveredTest.SAMPLES` (the dict around the `'ANSWER_WITH_RECORDED_CALL'`
    entry) add
    `'ANSWER_WITH_FILE': {'type': 'ANSWER_WITH_FILE', 'answerId': ANSWER, 'status': 201},`.
    `setUp` already calls `write_answer(self.tmp.name)`, so the answer exists.
  - Add a class at the end of the file, before `if __name__ == '__main__':`, named
    `FileAnswerTest(unittest.TestCase)`, with the same `setUp` (a `tempfile.TemporaryDirectory`
    and `addCleanup`) and `engine(*actions, rules=None)` helper as `StoredAnswerTest`. Tests:
    1. `test_the_exact_bytes_are_served_with_the_actions_status`:
       `write_answer(self.tmp.name, status=200, headers={'content-type': 'application/pdf'}, body=b'%PDF-\x00\xff')`,
       then apply `{'type': 'ANSWER_WITH_FILE', 'answerId': ANSWER, 'status': 201}`. Assert
       `verdict.terminal == 'MOCK_RESPONSE'`, `verdict.mock['status'] == 201`,
       `verdict.mock['body_bytes'] == b'%PDF-\x00\xff'`,
       `verdict.mock['headers'] == {'content-type': 'application/pdf'}`, and the detail
       contains `'file answer'` and `'upstream never contacted'`.
    2. `test_without_a_status_the_stored_one_is_used`: status 200 stored, no action status,
       expect 200.
    3. `test_an_earlier_send_to_host_wins`: copy
       `StoredAnswerTest.test_an_earlier_send_to_host_wins` with the action type changed.
    4. `test_a_missing_file_answer_lets_the_call_through`: no `write_answer`. Expect
       `verdict.terminal is None` and the detail
       `f'skipped - stored answer {ANSWER} not found'`.
  - Run `python -m unittest test_interception test_regex_worker` from `proxy/`. The new tests
    must FAIL (unknown action) until T095.

- [ ] T093 [US7] Add the action type and its validation in backend-interception.
  1. `BI/domain/model/ActionType.java`: directly after `ANSWER_WITH_RECORDED_CALL(Phase.REQUEST),`
     add
     ```java
     /**
      * Answers with an uploaded file - its bytes exactly, with the status the action sets or the
      * one given at upload - and never contacts the host. For large or binary fixtures.
      */
     ANSWER_WITH_FILE(Phase.REQUEST),
     ```
  2. Same file, `isTerminal()`: add `|| this == ANSWER_WITH_FILE`.
  3. Same file, `answerKind()`: add the case
     `case ANSWER_WITH_FILE -> StoredAnswer.Kind.FILE;` before `default`.
  4. `BI/domain/model/RuleValidator.java` line ~332: change
     `case ANSWER_WITH_RECORDED_CALL, REPLACE_WITH_RECORDED_RESPONSE -> {` to
     `case ANSWER_WITH_RECORDED_CALL, REPLACE_WITH_RECORDED_RESPONSE, ANSWER_WITH_FILE -> {`.
     Nothing else changes: `validateAnswer` already checks the UUID, the existence and that
     the kind equals `action.type().answerKind()`, and the status check is already in that case.
  5. `BIT/domain/RuleValidatorTest.java`: add
     `aFileAnswerActionNeedsAFileAnswer()`, using the existing `answerProblems(fields, kind)`
     helper and `ANSWER` constant:
     - `{"type":"ANSWER_WITH_FILE","answerId":ANSWER}` with kind `FILE` gives no problems;
     - with kind `RECORDED` gives a problem containing `"needs a file answer, not a recorded one"`;
     - with `"status", 99` gives a problem containing `"between 100 and 599"`.
     And `aFileAnswerEndsTheRequestLikeAMock()`: `ANSWER_WITH_FILE` plus `MOCK_RESPONSE` in one
     rule gives `"only end a request once"`.
  6. Run `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app" -v alfred-m2:/root/.m2 -w //app maven:3.9-eclipse-temurin-21 mvn -B -q -pl backend-interception -am test`
     from `backend/`. Only T091's upload tests may still fail.

- [ ] T094 [US7] Add the upload use case, service method and route.
  1. `BI/application/port/in/ManageStoredAnswersUseCase.java`: add
     ```java
     /**
      * Stores an uploaded file as a FILE answer. {@code sizeBytes} is the size the upload
      * declares, checked BEFORE {@code body} is read, so an oversized file is never buffered.
      * The real length is checked again after reading.
      */
     UploadResult upload(String contentType, Integer status, long sizeBytes, BodySource body);

     /** The upload's bytes, read on demand. */
     @FunctionalInterface
     interface BodySource {
         byte[] read() throws java.io.IOException;
     }

     sealed interface UploadResult {
         record Created(StoredAnswer answer) implements UploadResult {
         }

         record TooLarge(long limitBytes, long sizeBytes) implements UploadResult {
         }

         record MissingContentType() implements UploadResult {
         }
     }
     ```
  2. `BI/application/service/StoredAnswersService.java`: implement it.
     ```java
     @Override
     public UploadResult upload(String contentType, Integer status, long sizeBytes, BodySource body) {
         if (contentType == null || contentType.isBlank()) {
             return new UploadResult.MissingContentType();
         }
         if (sizeBytes > maxAnswerBytes) {
             return new UploadResult.TooLarge(maxAnswerBytes, sizeBytes);
         }
         byte[] bytes;
         try {
             bytes = body.read();
         } catch (java.io.IOException e) {
             throw new java.io.UncheckedIOException("Could not read the uploaded file", e);
         }
         if (bytes.length > maxAnswerBytes) {
             return new UploadResult.TooLarge(maxAnswerBytes, bytes.length);
         }
         String type = contentType.strip();
         StoredAnswer answer = new StoredAnswer(UUID.randomUUID().toString(), StoredAnswer.Kind.FILE,
                 status == null ? 200 : status, Map.of("content-type", type), type, bytes.length,
                 null, List.of(), null, null, null, null, Instant.now(clock).toString());
         store.save(answer, bytes);
         return new UploadResult.Created(answer);
     }
     ```
     Place it directly after `copyFromCall`. Add the import
     `ManageStoredAnswersUseCase.UploadResult` only if the compiler asks for it (the class
     implements the interface, so the nested types resolve by simple name).
  3. `BI/adapter/in/web/StoredAnswersController.java`: add, above `@GetMapping("/{id}")`:
     ```java
     /**
      * Uploads a file as a FILE answer. Spring's multipart limit
      * (spring.servlet.multipart.max-file-size, set to the same cap) rejects an oversized request
      * before the controller runs; the use case checks again for a limit configured differently.
      */
     @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
     public ResponseEntity<Object> upload(@RequestPart("file") MultipartFile file,
                                          @RequestParam(value = "contentType", required = false) String contentType,
                                          @RequestParam(value = "status", required = false) Integer status) {
         if (status != null && (status < 100 || status > 599)) {
             return ResponseEntity.badRequest().body(Map.of("error", "invalid-request",
                     "problems", List.of("status must be between 100 and 599")));
         }
         String type = contentType != null && !contentType.isBlank() ? contentType : file.getContentType();
         UploadResult result = answers.upload(type, status, file.getSize(), file::getBytes);
         return switch (result) {
             case UploadResult.Created created ->
                     ResponseEntity.status(HttpStatus.CREATED).body(StoredAnswerDto.of(created.answer(), List.of()));
             case UploadResult.TooLarge tooLarge -> ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                     .body(Map.of("error", "answer-too-large", "limitBytes", tooLarge.limitBytes(),
                             "sizeBytes", tooLarge.sizeBytes()));
             case UploadResult.MissingContentType missing -> ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                     .body(Map.of("error", "content-type-required"));
         };
     }

     /** Spring's own multipart cap, hit before the controller runs - same 413 shape as the use case's. */
     @ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
     public ResponseEntity<Map<String, Object>> tooLarge(org.springframework.web.multipart.MaxUploadSizeExceededException e,
                                                         jakarta.servlet.http.HttpServletRequest request) {
         return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(Map.of("error", "answer-too-large",
                 "limitBytes", e.getMaxUploadSize(), "sizeBytes", request.getContentLengthLong()));
     }
     ```
     Imports to add: `ManageStoredAnswersUseCase.UploadResult`,
     `org.springframework.web.bind.annotation.RequestPart`, `RequestParam`, `ExceptionHandler`,
     `org.springframework.web.multipart.MultipartFile`. Replace the fully qualified names in the
     handler with imports.
  4. Run the backend-interception tests (command in T093). All of T091 now passes.

- [ ] T095 [US7] Add the proxy handler in `PX/interception.py`.
  1. `REQUEST_ACTIONS` (around line 66): add `'ANSWER_WITH_FILE'` after
     `'ANSWER_WITH_RECORDED_CALL'`.
  2. `TERMINAL_REQUEST_ACTIONS`: add `'ANSWER_WITH_FILE'`.
  3. In `InterceptionEngine._apply_request_action`, change the line
     `if kind == 'ANSWER_WITH_RECORDED_CALL':` (around line 1888) to
     `if kind in ('ANSWER_WITH_RECORDED_CALL', 'ANSWER_WITH_FILE'):`. Inside that block:
     - leave the `must_reach_host` check, the `_AnswerCache.load` call and `answer_parts` as
       they are;
     - only set `verdict.refresh_from` when `kind == 'ANSWER_WITH_RECORDED_CALL'` (an uploaded
       file has no recording time);
     - change the recorded detail to
       ```python
       what = 'recorded answer' if kind == 'ANSWER_WITH_RECORDED_CALL' else 'file answer'
       verdict.record(rule, kind, f'{what} {meta.get("id", "")}, {status}, upstream never contacted')
       ```
  4. Run the proxy tests (command in T092). Everything passes, including SAMPLES coverage.

- [ ] T096 [US7] Add the frontend upload mode.
  1. `FE/core/models/interception.model.ts`:
     - in `ActionType`, add `| 'ANSWER_WITH_FILE'` after `| 'ANSWER_WITH_RECORDED_CALL'`;
     - in `ACTION_LABELS`, add `ANSWER_WITH_FILE: 'Answer with a file (never contact upstream)',`
       after the recorded-call label;
     - in `describeAction`, add
       ```ts
       case 'ANSWER_WITH_FILE':
         return action.answerId || action.answerRef
           ? `Answer with a file${action.status ? ` as ${action.status}` : ''} — host never called`
           : 'Answer with a file — none uploaded yet';
       ```
     - `usesStoredAnswer` (around line 843): add `|| type === 'ANSWER_WITH_FILE'`;
     - add, directly under `usesStoredAnswer`:
       ```ts
       /** Which kind of stored answer an action serves - the picker shows a search or an upload. */
       export function answerKindOf(type: ActionType): 'RECORDED' | 'FILE' {
         return type === 'ANSWER_WITH_FILE' ? 'FILE' : 'RECORDED';
       }
       ```
     - `FALLBACK_TERMINALS` already lists `'ANSWER_WITH_FILE'`; leave it.
  2. `FE/core/services/interception-api.service.ts`: add, after `copyAnswerFromCall`:
     ```ts
     /** multipart/form-data: `file`, optional `contentType` and `status`. 413 carries limitBytes and sizeBytes. */
     uploadAnswer(file: File, contentType: string, status: number | null): Observable<StoredAnswer> {
       const form = new FormData();
       form.append('file', file, file.name);
       if (contentType) form.append('contentType', contentType);
       if (status != null) form.append('status', String(status));
       return this.http.post<StoredAnswer>(`${this.baseUrl}/answers`, form);
     }
     ```
     Do not set a Content-Type header: the browser adds the multipart boundary.
  3. `FE/components/answer-picker/answer-picker.component.ts`:
     - add the input `readonly kind = input<'RECORDED' | 'FILE'>('RECORDED');`;
     - add the signals `readonly uploadType = signal('');` and `readonly uploading = signal(false);`;
     - in `ngOnInit`, run the first search only when `this.kind() === 'RECORDED' && this.showPicker()`;
     - in `startChange()`, call `this.runSearch()` only when `this.kind() === 'RECORDED'`;
     - add the methods below. `onFile` defaults the type from the file, `upload` sends, and the
       error branches reuse the `413` message shape from `copy`:
       ```ts
       onFile(event: Event): void {
         const file = (event.target as HTMLInputElement).files?.[0] ?? null;
         this.selectedFile = file;
         this.uploadType.set(file?.type || '');
         this.error.set(null);
       }

       onUploadType(event: Event): void {
         this.uploadType.set((event.target as HTMLInputElement).value);
       }

       upload(status: number | null): void {
         const file = this.selectedFile;
         if (!file) return;
         if (!this.uploadType().trim()) {
           this.error.set('Say what content type the file is served as, e.g. application/json.');
           return;
         }
         this.uploading.set(true);
         this.error.set(null);
         this.api
           .uploadAnswer(file, this.uploadType().trim(), status)
           .pipe(takeUntilDestroyed(this.destroyRef))
           .subscribe({
             next: (answer) => {
               this.uploading.set(false);
               this.changing.set(false);
               this.answer.set(answer);
               this.answerChange.emit(answer.id);
             },
             error: (failure: HttpErrorResponse) => {
               this.uploading.set(false);
               if (failure.status === 413) {
                 const body = failure.error as { limitBytes?: number; sizeBytes?: number };
                 this.error.set(
                   `That file is ${formatBytes(body?.sizeBytes ?? file.size)}; a stored answer can be at most ${formatBytes(body?.limitBytes ?? 0)}.`
                 );
               } else if (failure.status === 415) {
                 this.error.set('Say what content type the file is served as, e.g. application/json.');
               } else {
                 this.error.set('Could not upload that file. Try again.');
               }
             },
           });
       }
       ```
       and the field `private selectedFile: File | null = null;`.
     - add a second input `readonly status = input<number | null | undefined>(null);` so
       the upload sends the action's current status.
  4. `FE/components/answer-picker/answer-picker.component.html`: inside the `@if (showPicker())`
     branch, wrap the existing search markup (the `answer-picker-bar` div, the `small`, and
     the `ul`) in `@if (kind() === 'RECORDED') { ... } @else { ...upload... }`. The upload
     branch:
     ```html
     <div class="answer-picker-bar">
       <input type="file" (change)="onFile($event)" />
       <input type="text" class="answer-search" placeholder="Content type, e.g. application/json" [value]="uploadType()" (input)="onUploadType($event)" />
       <button type="button" class="pill" [disabled]="uploading()" (click)="upload(status() ?? null)">Upload</button>
       @if (changing()) {
         <button type="button" class="pill" (click)="cancelChange()">Keep the current answer</button>
       }
     </div>
     <small class="muted">Served byte for byte. At most 10 MB.</small>
     ```
     In the attached-answer card, show `from {{ stored.sourceDirection }} call …` only when
     `stored.kind === 'RECORDED'` (it is already guarded by `stored.sourceDirection`; keep that).
  5. `FE/components/rule-action-card/rule-action-card.component.html`: in the
     `@if (editor.usesAnswer(step.action.type))` block (added in US6):
     - pass the new inputs:
       `<app-answer-picker [answerId]="step.action.answerId" [kind]="editor.answerKind(step.action.type)" [status]="step.action.status" (answerChange)="editor.onAnswer(step.path, $event)" />`;
     - show the "Refresh dates" checkbox only when
       `step.action.type !== 'ANSWER_WITH_FILE'`;
     - for `ANSWER_WITH_FILE`, add a status row, copied from the `editor.isStatus` block:
       ```html
       @if (step.action.type === 'ANSWER_WITH_FILE') {
         <div class="inline-field">
           <span>Status</span>
           <app-status-picker [value]="step.action.status ?? 200" (valueChange)="editor.onStatusChange(step.path, $event)" />
         </div>
       }
       ```
  6. `FE/components/rule-editor/rule-editor.component.ts`:
     - import `answerKindOf` from the model;
     - add `answerKind(type: ActionType): 'RECORDED' | 'FILE' { return answerKindOf(type); }`
       next to `usesAnswer`;
     - in `defaultsFor`, add `case 'ANSWER_WITH_FILE': return { type, answerId: null, status: 200 };`
       next to the recorded-call cases.
  7. `FE/shared/utils/interception-help.ts`: add an `ANSWER_WITH_FILE` entry after
     `ANSWER_WITH_RECORDED_CALL`, with `code: 'ANSWER_WITH_FILE'`, a `what` longer than 40
     characters ("Answers the call with a file you upload - served byte for byte, with the status
     you choose - and never contacts the host. For large or binary fixtures: a PDF, an image, a
     200 KB JSON payload."), two examples (`{ from: 'upload fares.json · 200', to: 'every
     matching call gets that file' }`, `{ from: 'a 12 MB file', to: 'refused: stored answers are
     at most 10 MB' }`) and a warning ("The content type you give is the one served, whatever the
     file's extension says.").
  8. `FE/components/answer-picker/answer-picker.component.spec.ts`: add
     `it('uploads a file with its content type and status, then emits the new id', fakeAsync(...))`:
     set inputs `kind` = `'FILE'` and `status` = `201`, call
     `component.onFile({ target: { files: [new File(['{}'], 'a.json', { type: 'application/json' })] } } as unknown as Event)`,
     then `component.upload(201)`. Expect one `POST ${BACKEND}/interception/answers` whose body
     is a `FormData` with `get('contentType') === 'application/json'` and `get('status') === '201'`;
     flush a FILE answer with status 201 and check `emitted` holds its id. No calls search is
     requested (so `http.verify()` passes without flushing `/calls`).
  9. Run `npx ng test --watch=false --browsers=ChromeHeadless` then `npx ng build` in
     `frontend/`. Both must pass (the existing bundle-size warning is expected).

---

## Phase 11: User Story 8 — Resend a logged call through Alfred (P3)

**Independent Test**: quickstart check 9.

**What already exists (do not re-create)**:
- `docker-compose.yml`:
  - both proxies have `BACKEND_HOST=backend`;
  - the backend has `JAVA_TOOL_OPTIONS=... -Djdk.httpclient.allowRestrictedHeaders=host` (line ~228), `FORWARD_PROXY_DEFAULT_PORT=8080` and `FORWARD_PROXY_PORT_MAP=${FORWARD_PROXY_PORT_MAP:-}` (~304-305), `INTERNAL_CALL_SERVICES=${INTERNAL_CALL_SERVICES:-}` (~286), and the mount `./proxy/certs:/appdata/mitm-certs:ro` (~313).
- `backend/backend-app/src/main/resources/application.properties:100-105`:
  - `alfred.resend.timeout-ms`, `alfred.resend.forward-proxy-host` (default `proxy`), `alfred.resend.reverse-proxy-host` (default `reverse-proxy`), `alfred.resend.mitm-ca-file` (default `/appdata/mitm-certs/mitmproxy-ca-cert.pem`);
  - `alfred.interception.max-answer-bytes` (the body limit reused here).
- `gateway/nginx.conf:33` already routes `resend`.
- `backend/backend-resend/pom.xml` (deps: spring-boot-starter-web, -validation, -test) with an empty package tree under `backend/backend-resend/src/main/java/com/fathy/alfred/backend/resend/`: `adapter/in/web/dto`, `adapter/out/http`, `application/port/in`, `application/port/out`, `application/service`, `domain/model`. The module is already in `backend/pom.xml` and a dependency of `backend-app`.
- `HexagonalArchitectureTest.resendSliceMustNotDependOnOtherSlices` (lines 203-215) with a temporary `.allowEmptyShould(true)`.
- A mock of the dialog: `mockups/resend-dialog-mock.html`.

**Path abbreviations used below** (in addition to those at the top of this file):
- `BC` = `backend/backend-calls/src/main/java/com/fathy/alfred/backend/calls`, `BCT` = its `src/test/java/...` twin
- `BIC` = `backend/backend-internal-calls/src/main/java/com/fathy/alfred/backend/internalcalls`
- `BSC` = `backend/backend-session-cycles/src/main/java/com/fathy/alfred/backend/sessioncycles`
- `BR` = `backend/backend-resend/src/main/java/com/fathy/alfred/backend/resend`, `BRT` = `backend/backend-resend/src/test/java/com/fathy/alfred/backend/resend`
- `BA` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`

**Shape of the linkage fields** (data-model §7): `resend_of` is the original call's id (string).
`resend_edits` is a JSON object
`{"method":{"from":"POST","to":"PUT"}?, "url":{"from":…,"to":…}?, "headers":["x-a", …]?, "body":true?, "session":[{"name":"cookie","fromCallId":"…"}]?}`.
It never contains a header value. In Java both are `String` fields: `resendEdits` holds the JSON
text and is emitted as a raw JSON object with `@JsonRawValue`. Because a raw value is written into
responses verbatim, **every place that accepts `resend_edits` from outside must re-parse it with
Jackson and store the re-serialised text, or null if it does not parse** (helper in T097 step 2).

### Linkage in the call slices

- [ ] T097 [US8] Add the resend linkage to backend-calls.
  1. `BC/domain/model/CallRecord.java` (canonical record at lines 35-51, 15 components ending
     `CallTiming timing, CallInterception interception`): append two components
     ```java
     /** The call this one resends, or null. Set from the proxy's X-Alfred-Resend-Of header. */
     @JsonProperty("resend_of") @JsonInclude(JsonInclude.Include.NON_NULL) String resendOf,
     /** What the resend changed, as JSON text - header NAMES only (data-model §7). */
     @JsonProperty("resend_edits") @JsonInclude(JsonInclude.Include.NON_NULL) @JsonRawValue String resendEdits
     ```
     - Add a 15-argument overload with the old canonical parameter list that calls
       `this(..., timing, interception, null, null)`. Every existing overload (lines 57-93) keeps
       compiling because it delegates down to a shorter one; change the one that currently calls
       the canonical constructor with 15 arguments so it calls the new 17-argument one with
       `null, null` appended.
     - Add `public CallRecord withResend(String of, String edits)` returning a copy with those
       two fields.
     - `withDerivedStateIfMissing` (lines 106-114) rebuilds with the 13-arg constructor and
       loses `timing`, `interception` and now the resend fields. Change it to use the 17-arg
       constructor and pass every field through.
     - Deserialising `@JsonRawValue` needs a raw-object reader: add
       `@JsonDeserialize(using = RawJsonDeserializer.class)` on `resendEdits` and create
       `BC/domain/model/RawJsonDeserializer.java`:
       ```java
       /** Reads any JSON value as its compact text, so a raw-value field round-trips through the file log. */
       public class RawJsonDeserializer extends JsonDeserializer<String> {
           @Override
           public String deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
               return p.getCodec().readTree(p).toString();
           }
       }
       ```
       (Jackson classes are allowed in the domain; only Spring is not.)
  2. Create `BC/domain/model/ResendEdits.java`, a final utility class:
     ```java
     /** Normalises resend_edits text from outside: compact JSON object text, or null. */
     public final class ResendEdits {
         private static final ObjectMapper MAPPER = new ObjectMapper();
         private ResendEdits() {}
         public static String normalise(Object raw) {
             if (raw == null) return null;
             try {
                 JsonNode node = raw instanceof String s ? MAPPER.readTree(s) : MAPPER.valueToTree(raw);
                 return node != null && node.isObject() ? MAPPER.writeValueAsString(node) : null;
             } catch (JsonProcessingException | IllegalArgumentException e) {
                 return null;
             }
         }
     }
     ```
  3. `BC/adapter/in/web/dto/PrepareCallRequestDto.java`: add two components at the end,
     `@JsonProperty("resend_of") String resendOf, @JsonProperty("resend_edits") JsonNode resendEdits`.
  4. `BC/adapter/in/web/CallsWebhookController.java:69-82` (`prepare`): after building `partial`
     with the 13-arg constructor, add
     `partial = partial.withResend(blankToNull(body.resendOf()), ResendEdits.normalise(body.resendEdits()));`
     where `blankToNull` is a private static helper (`s == null || s.isBlank() ? null : s.strip()`)
     that also caps the id at 200 characters (return null when longer).
  5. `BC/application/service/CallsService.java:133-147` (`receivePreparedCall`): the rebuilt
     `prepared` uses the 13-arg constructor. Append `.withResend(partial.resendOf(), partial.resendEdits())`
     to that expression.
  6. `BC/adapter/out/filelog/FileCallLogAdapter.java` `complete` (lines 170-188) rebuilds the
     record with 15 arguments from `partial`. Use the 17-arg constructor and pass
     `partial.resendOf(), partial.resendEdits()`.
  7. `BC/adapter/out/sqlite/SqliteCallsRepository.java`:
     - add, next to `addServiceNameColumnIfMissing` (lines 290-296) and in the same style,
       `addResendColumnsIfMissing()` that adds `resend_of TEXT` and `resend_edits TEXT` to
       `call_metadata` when `PRAGMA table_info(call_metadata)` lacks them; call it from
       `createSchema()` after `addTimingColumnsIfMissing();` (line ~238);
     - `INSERT_METADATA_SQL` (426-431): append `, resend_of, resend_edits` to the column list and
       `,?,?` to `VALUES`; in `bindMetadata` (438-474) add `ps.setString(19, normalized.resendOf());`
       and `ps.setString(20, normalized.resendEdits());`;
     - `SUMMARY_SQL` (685-686): append `, resend_of, resend_edits` after `interception`;
     - `DETAIL_SQL` (888-898): append `, cm.resend_of, cm.resend_edits` after `cm.interception`;
     - `readAll()` (913-925) lists the same columns inline: append the same two, exactly as in
       `DETAIL_SQL` (its comment says it must stay in sync with `ROW_MAPPER`);
     - `ROW_MAPPER` (1055-1086) and `OVERLAP_ROW_MAPPER` (1137-1159): switch to the 17-arg
       constructor with `rs.getString("resend_of"), rs.getString("resend_edits")`. Check the
       overlap query's SELECT: if it does not select the two columns, pass `null, null` instead
       (a `rs.getString` on a missing column throws);
     - `LEGACY_ROW_MAPPER` (1089-1119) stays on the 13-arg constructor;
     - `SUMMARY_ROW_MAPPER` (1161-1183): pass the two columns to the new `CallSummary`
       constructor (step 8).
     - `UPDATE_METADATA_SQL` (complete) is unchanged: the linkage is set once, at prepare.
  8. `BC/domain/model/CallSummary.java` (the list DTO; canonical record at file lines 22-39):
     append the same two annotated components; add a 15-arg overload for the old list that
     passes `null, null`; `CallSummary.of(CallRecord)` (lines 75-79) passes
     `call.resendOf(), call.resendEdits()`.
  9. Compile: `mvn -B -q -pl backend-calls -am test` in Docker (command at the top of this
     file). Fix every call site the compiler reports; do not change behaviour elsewhere.

- [ ] T098 [P] [US8] Test the round trip in
  `BCT/adapter/out/sqlite/SqliteCallsRepositoryTest.java` (uses `repositoryFor(tempDir.resolve("calls.db"), Long.MAX_VALUE)`
  from lines 33-64). Add `aResendLinkRoundTripsThroughEveryReadPath()`:
  - build a `CallRecord` with the 13-arg constructor (id `"resent-1"`, url
    `"https://api.test/x"`, state `IN_PROGRESS`), then `.withResend("orig-1", "{\"headers\":[\"x-a\"]}")`;
  - `repository.save(call)`, then wait for the batch writer the same way the existing tests do
    (find a test that saves then reads, and copy its wait/flush call);
  - assert `resendOf()` and `resendEdits()` equal the inputs via `findById("resent-1")`, via
    `readAll()`, and via the summary from `query("", "", "newest", 0, 10, true)`;
  - also assert that `new ObjectMapper().writeValueAsString(summary)` contains
    `"resend_edits":{"headers":["x-a"]}` (raw object, not a quoted string).
  Add a `CallsWebhookControllerTest` case (`BCT/adapter/in/web/CallsWebhookControllerTest.java`,
  pattern at lines 27-75): posting a prepare with `"resend_of":"o1","resend_edits":"not json"`
  calls `receivePreparedCall` with a record whose `resendEdits()` is null (use an
  `ArgumentCaptor<CallRecord>`).

- [ ] T099 [US8] Add the same linkage to backend-internal-calls and to session-cycle captures.
  1. `BIC/domain/model/CallRecord.java` (14 components, lines 36-55, ending `interception`):
     append `resendOf` and `resendEdits` exactly as in T097 step 1 (same annotations; create
     `BIC/domain/model/RawJsonDeserializer.java` and `BIC/domain/model/ResendEdits.java` as
     copies — slices may not share code). Keep a 14-arg overload. Update `withInterception`
     (65-68) and `withDerivedStateIfMissing` (98-107) to carry the two fields; add `withResend`.
  2. `BIC/adapter/in/web/dto/PrepareInternalCallRequestDto.java:15-26`: add the two components
     as in T097 step 3. `BIC/adapter/in/web/InternalCallsWebhookController.java:47-56`: apply
     `.withResend(...)` as in T097 step 4.
  3. `BIC/application/service/InternalCallsService.java:106-114` (`receivePreparedCall`): if it
     rebuilds the record, carry the fields through with `.withResend(...)`.
  4. `BIC/adapter/out/filelog/InternalCallsFileLogAdapter.java` `complete` (254-275): the
     13-arg rebuild must carry `partial.resendOf(), partial.resendEdits()`. The NDJSON line is
     the record serialised by Jackson, so the fields appear as `resend_of` / `resend_edits`
     automatically and read back through the deserializer.
  5. `BIC/domain/model/CallSummary.java:17-33`: append the two components, keep a 14-arg
     overload, update `of(CallRecord)` (64-68).
  6. Session cycles (`BSC/adapter/out/sqlite/SqliteSessionCyclesRepository.java`): captured
     calls wrap the whole `CallRecord` (`CapturedCall(id, capturedAt, call)`), but SQLite copies
     fields one by one:
     - add `resend_of TEXT` and `resend_edits TEXT` to `captured_call_metadata` with the ALTER
       pattern used at lines 286-290 (for `interception`);
     - add them to `INSERT_METADATA_SQL` (522-529) and `bindMetadata` (536+);
     - add them to the SELECTs used by `CAPTURED_ROW_MAPPER` (907-929) and `SUMMARY_ROW_MAPPER`
       (931-951), and pass them into the 17-arg `CallRecord` constructor (those mappers build
       backend-calls records);
     - do the same for the internal captured-call table and mappers in the same file (search for
       `captured_internal_call` and the internal-calls `CallRecord` construction).
     `service_name` is not stored for captured outbound calls (the mapper passes `null`); leave
     that as it is.
  7. Tests: extend `BIC`'s `InternalCallsFileLogAdapterTest` with a prepare + complete that
     keeps `resendOf`/`resendEdits` after a reload of the file; extend the session-cycles
     SQLite repository test with one captured call carrying both fields, read back through the
     captured-call detail. Run `mvn -B -q -pl backend-internal-calls,backend-session-cycles -am test`.

### Proxy

- [ ] T100 [P] [US8] Add `ResendHeadersTest` at the end of `PX/test_interception.py` (before
  `if __name__ == '__main__':`). Use a small fake for the client connection:
  ```python
  class FakeClientConn:
      def __init__(self, peer_ip):
          self.peername = (peer_ip, 51234)
  ```
  Set `flow.client_conn = FakeClientConn(...)` on a `FakeFlow(FakeRequest(headers={...}))`. Tests:
  1. `test_the_backend_peer_hands_over_both_values`:
     headers `{'X-Alfred-Resend-Of': 'orig-1', 'X-Alfred-Resend-Edits': '{"headers":["x-a"]}', 'X-A': '1'}`,
     peer `'172.18.0.5'`, `interception.take_resend_headers(flow, {'172.18.0.5'})` returns
     `('orig-1', '{"headers":["x-a"]}')`, and neither header is left in `flow.request.headers`;
     `X-A` is still there.
  2. `test_any_other_peer_is_ignored_but_the_headers_are_still_removed`: peer `'10.0.0.9'`,
     returns `(None, None)`, both headers gone.
  3. `test_invalid_edits_json_is_dropped`: edits `'not json'` from the backend peer returns
     `('orig-1', None)`.
  4. `test_an_oversized_value_is_dropped`: a resend-of longer than 200 characters returns
     `(None, None)`; edits longer than 16384 characters give `edits=None`.
  5. `test_a_rule_matching_on_the_header_never_sees_it`: write a rule matching
     `{'headers': [{'name': 'X-Alfred-Resend-Of', 'operator': 'EXISTS'}]}` with a
     `SET_REQUEST_HEADER` action; call `take_resend_headers` first, then
     `run(engine.apply_request(flow))`; assert `verdict.applied == []`.
  6. `test_no_client_connection_is_treated_as_not_the_backend`: a flow without
     `client_conn` returns `(None, None)` and does not raise.

- [ ] T101 [US8] Implement the header hand-over in the proxy.
  1. `PX/interception.py`, near the other module constants, add:
     ```python
     RESEND_OF_HEADER = 'X-Alfred-Resend-Of'
     RESEND_EDITS_HEADER = 'X-Alfred-Resend-Edits'
     MAX_RESEND_ID = 200
     MAX_RESEND_EDITS = 16384
     ```
     and the function (next to `answer_parts`):
     ```python
     def take_resend_headers(flow, backend_addresses):
         """(resend_of, resend_edits) for a call the backend is resending, and always removes both
         headers - before any rule sees the request, and before the request leaves the proxy.

         Honoured only when the peer is the backend itself: any other client could otherwise mark
         its calls as resends of calls it never saw."""
         headers = flow.request.headers
         resend_of = headers.get(RESEND_OF_HEADER)
         edits = headers.get(RESEND_EDITS_HEADER)
         for name in (RESEND_OF_HEADER, RESEND_EDITS_HEADER):
             if name in headers:
                 del headers[name]
         conn = getattr(flow, 'client_conn', None)
         peer = getattr(conn, 'peername', None) if conn is not None else None
         if not peer or peer[0] not in backend_addresses:
             return None, None
         if not resend_of or len(resend_of) > MAX_RESEND_ID:
             return None, None
         if edits is not None:
             try:
                 parsed = json.loads(edits) if len(edits) <= MAX_RESEND_EDITS else None
             except ValueError:
                 parsed = None
             edits = json.dumps(parsed, separators=(',', ':')) if isinstance(parsed, dict) else None
         return resend_of.strip(), edits
     ```
     and a resolver that caches the backend's addresses after the first success (Docker's DNS
     may not answer at import time, so do not resolve at import):
     ```python
     _backend_addresses = None

     def backend_addresses():
         """The IPs BACKEND_HOST resolves to, resolved once and cached. Empty until it resolves."""
         global _backend_addresses
         if _backend_addresses is None:
             host = os.environ.get('BACKEND_HOST', '').strip()
             if not host:
                 return frozenset()
             try:
                 _backend_addresses = frozenset(socket.gethostbyname_ex(host)[2])
             except OSError:
                 return frozenset()
         return _backend_addresses
     ```
     Add `import socket` to the imports (alphabetical order).
  2. `PX/log_and_route.py` `request` hook (lines 144-213): as the FIRST statement that touches
     the request, before `verdict = await ENGINE.apply_request(flow, service_name)` (line ~160),
     add `resend_of, resend_edits = interception.take_resend_headers(flow, interception.backend_addresses())`.
     Where the payload `call_log` is extended (after `if service_name: call_log['service_name'] = service_name`,
     lines ~204-205), add
     ```python
     if resend_of:
         call_log['resend_of'] = resend_of
         if resend_edits:
             call_log['resend_edits'] = json.loads(resend_edits)
     ```
     (`json` is already imported there; check and add if not.)
  3. `PX/log_and_route_reverse.py` `request` hook (143-202): the same two changes, the call
     before `ENGINE.apply_request(flow, name)` (line ~158) and the payload lines after the
     `service_name` entry of the dict built at 175-196. The early return for a disabled project
     (161-163) comes after the header removal, so the headers are removed even when logging is
     off.
  4. Run the proxy tests (command at the top of this file).

### New slice backend-resend

- [ ] T102 [US8] Create the domain and remove the ArchUnit placeholder.
  1. `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java`
     lines 211-213: delete the comment and the `.allowEmptyShould(true)` line.
  2. Create these records in `BR/domain/model/` (package
     `com.fathy.alfred.backend.resend.domain.model`, no Spring imports):
     ```java
     /** The fields of a logged call a resend needs. originalUrl is what the client asked for. */
     public record StoredCall(String direction, String id, String method, String originalUrl,
                              Map<String, String> headers, String body, String serviceName) {
         public StoredCall { headers = headers == null ? Map.of() : Map.copyOf(headers); }
     }

     /** What the user changed. A null header value removes that header. Null fields keep the original. */
     public record ResendEdits(String method, String url, Map<String, String> headers, String body) {
         public static final ResendEdits NONE = new ResendEdits(null, null, null, null);
         public ResendEdits { headers = headers == null ? Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(headers)); }
     }
     ```
     (`Map.copyOf` rejects null values, and null means "remove", hence the LinkedHashMap copy.)
     ```java
     public record ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                                 boolean useCurrentSession) {
         public ResendRequest { edits = edits == null ? ResendEdits.NONE : edits; }
     }

     /** A session header value found on a newer call - the value never leaves the backend. */
     public record SessionValue(String name, String value, String fromCallId) {}

     /** Reported to the user: which header came from which call. No value. */
     public record SessionValueUse(String name, String fromCallId) {}

     /** What is actually sent. */
     public record OutgoingCall(String direction, String method, String url, Map<String, String> headers,
                                String body, String serviceName) {}

     public record ResendResult(String newCallId, int status, long durationMs, List<SessionValueUse> sessionValuesUsed) {
         public ResendResult { sessionValuesUsed = List.copyOf(sessionValuesUsed); }
     }

     public sealed interface SendOutcome {
         record Sent(int status, long durationMs) implements SendOutcome {}
         record ReverseProxyNotRunning() implements SendOutcome {}
         record Failed(String message) implements SendOutcome {}
     }
     ```
     Put each top-level type in its own file named after it.

- [ ] T103 [US8] Create the ports.
  1. `BR/application/port/in/ResendCallUseCase.java`:
     ```java
     public interface ResendCallUseCase {
         ResendOutcome resend(ResendRequest request);

         sealed interface ResendOutcome {
             record Done(ResendResult result) implements ResendOutcome {}
             record NotFound() implements ResendOutcome {}
             record ReverseProxyNotRunning() implements ResendOutcome {}
             record SendFailed(String message) implements ResendOutcome {}
         }
     }
     ```
  2. `BR/application/port/out/CallSourcePort.java`:
     `Optional<StoredCall> load(String direction, String callId, String cycleId);` — `cycleId`
     null means the live log.
  3. `BR/application/port/out/SessionValueLookupPort.java`:
     ```java
     /**
      * The newest value of each named request header on LIVE calls to the same host, newest first,
      * skipping {@code excludeCallId}. "Current session" means current: a session cycle's captured
      * calls are older than the live log by construction, so they are not searched.
      */
     List<SessionValue> newest(String direction, String authority, Set<String> headerNames, String excludeCallId);
     ```
     (This replaces the `cycleId` parameter of the earlier plan: a cycle's calls are the old
     session, not the current one.)
  4. `BR/application/port/out/CallSenderPort.java`: `SendOutcome send(OutgoingCall call);`

- [ ] T104 [P] [US8] Write `BRT/application/service/ResendServiceTest.java` (plain JUnit 5 +
  AssertJ, no Spring). Fakes: a `CallSourcePort` lambda returning a fixed `StoredCall`
  (direction `outbound`, id `orig-1`, method `POST`, originalUrl
  `https://api.supplier.test/v1/fares?x=1`, headers
  `{"Content-Type":"application/json","X-Request-Id":"orig-1","Cookie":"session=old","Content-Length":"9","Host":"api.supplier.test"}`,
  body `{"a":1}`, serviceName `odeysys`); a `CallSenderPort` that records the `OutgoingCall`
  and returns `new Sent(201, 42)`; a `SessionValueLookupPort` returning a configurable list.
  Tests:
  1. `anUneditedResendSendsTheCallAsItWas`: method, url and body unchanged;
     `Content-Length` and `Host` are not sent (the client sets them); `Cookie` is sent.
  2. `theRequestIdIsReplacedAndReturned`: the sent `X-Request-Id` is a UUID different from
     `orig-1` (`UUID.fromString` does not throw), and `Done.result().newCallId()` equals it.
  3. `theLinkHeadersAreAdded`: `X-Alfred-Resend-Of` is `orig-1`; `X-Alfred-Resend-Edits` parses
     as JSON.
  4. `editsAreAppliedAndOnlyNamesAreRecorded`: edits `method=PUT`, headers
     `{"X-Api-Key":"s3cret","Cookie":null}`, body `{"a":2}`. The sent call has method `PUT`,
     `X-Api-Key: s3cret`, no `Cookie`, body `{"a":2}`. The edits header JSON equals
     `{"method":{"from":"POST","to":"PUT"},"headers":["cookie","x-api-key"],"body":true}` and does
     not contain `s3cret`.
  5. `aHeaderEditMatchesTheOriginalCaseInsensitively`: edit `content-type` to `text/plain`; the
     sent call has exactly one content type header, with the new value.
  6. `currentSessionSubstitutesTheNewestValueAndReportsWhereItCameFrom`: `useCurrentSession=true`,
     lookup returns `[new SessionValue("cookie", "session=new", "c-9")]`. The sent `Cookie` is
     `session=new`; `sessionValuesUsed` equals `[new SessionValueUse("cookie", "c-9")]`; the edits
     JSON has `"session":[{"name":"cookie","fromCallId":"c-9"}]`; neither value appears in it.
     Also assert the lookup was called with authority `api.supplier.test`, names
     `{"authorization","cookie"}` and exclude id `orig-1`.
  7. `withNothingNewerTheOriginalsAreKept`: lookup returns `[]`; `Cookie` stays `session=old`;
     `sessionValuesUsed` is empty.
  8. `anUnknownCallIsNotFound`: the source returns empty; the outcome is `NotFound` and the
     sender is never called.
  9. `senderOutcomesMapThrough`: `ReverseProxyNotRunning` and `Failed("x")` from the sender
     become `ResendOutcome.ReverseProxyNotRunning` and `SendFailed("x")`.

- [ ] T105 [US8] Implement `BR/application/service/ResendService.java`
  (`@Service public class ResendService implements ResendCallUseCase`, constructor-injected
  `CallSourcePort`, `SessionValueLookupPort`, `CallSenderPort`). Behaviour, in this order:
  1. `load(direction, callId, cycleId)`; empty → `new NotFound()`.
  2. Start from a case-insensitive copy of the stored headers:
     `Map<String, String> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER); headers.putAll(call.headers());`.
  3. Remove the headers the HTTP client sets itself or that must not be replayed:
     `content-length`, `host`, `connection`, `transfer-encoding`, `keep-alive`, `upgrade`,
     `expect`, `x-alfred-resend-of`, `x-alfred-resend-edits`.
  4. Apply the edits:
     - `method`: when non-blank and different from the original (compared upper-case), use it
       upper-cased and record `"method": {"from": original, "to": new}`;
     - `url`: when non-blank and different, use it and record `"url": {"from", "to"}`;
     - `headers`: for each entry, a null value removes the header, anything else sets it; record
       the lower-cased name in a sorted set `"headers"`;
     - `body`: when non-null and different, use it and record `"body": true`.
  5. When `useCurrentSession`: define locally
     ```java
     // The session-carrying names. The full secret list lives in backend-interception's
     // SensitiveHeaders; slices may not share code, so only the two a session needs are here.
     private static final Set<String> SESSION_HEADERS = Set.of("authorization", "cookie");
     ```
     Ask `sessionValues.newest(direction, authorityOf(url), SESSION_HEADERS, call.id())`. For each
     returned value whose name is not already edited explicitly, set that header and add a
     `SessionValueUse(name, fromCallId)`. Record them under `"session"` as
     `[{"name","fromCallId"}]`.
     `authorityOf(url)` is `URI.create(url).getRawAuthority()`, lower-cased; a URL that does not
     parse is a `SendFailed("That URL is not valid.")`.
  6. `String newId = UUID.randomUUID().toString(); headers.put("X-Request-Id", newId);`
     then `headers.put("X-Alfred-Resend-Of", call.id());` and, when the edits map is not empty,
     `headers.put("X-Alfred-Resend-Edits", <compact JSON of the edits map>)`. Build the JSON with
     a local `ObjectMapper` over a `LinkedHashMap` in the key order method, url, headers, body,
     session.
  7. `sender.send(new OutgoingCall(direction, method, url, headers, body, call.serviceName()))`
     and map: `Sent` → `Done(new ResendResult(newId, status, durationMs, uses))`,
     `ReverseProxyNotRunning` → `ResendOutcome.ReverseProxyNotRunning`, `Failed` → `SendFailed`.
  Run `mvn -B -q -pl backend-resend -am test`; T104 passes.

- [ ] T106 [US8] Implement `BR/adapter/out/http/JdkHttpCallSender.java`
  (`@Component public class JdkHttpCallSender implements CallSenderPort`).
  1. Constructor parameters, all `@Value`:
     `${alfred.resend.forward-proxy-host:proxy}` forwardProxyHost,
     `${alfred.resend.reverse-proxy-host:reverse-proxy}` reverseProxyHost,
     `${alfred.resend.mitm-ca-file:/appdata/mitm-certs/mitmproxy-ca-cert.pem}` caFile,
     `${alfred.resend.timeout-ms:120000}` long timeoutMs,
     `${FORWARD_PROXY_PORT_MAP:}` forwardPortMap,
     `${FORWARD_PROXY_DEFAULT_PORT:8080}` int defaultForwardPort,
     `${INTERNAL_CALL_SERVICES:}` internalCallServices.
     Parse the maps once in the constructor:
     - `FORWARD_PROXY_PORT_MAP` is comma-separated `name:internalPort` pairs → `Map<String,Integer>`
       (skip malformed pairs);
     - `INTERNAL_CALL_SERVICES` is comma-separated `name:listenPort:upstreamPort` triples →
       `Map<String,Integer>` name → listenPort (skip malformed).
     Build the `SSLContext` once: read `caFile` with
     `CertificateFactory.getInstance("X.509").generateCertificate(in)`, put it in an empty
     `KeyStore.getInstance(KeyStore.getDefaultType())` (`load(null, null)`,
     `setCertificateEntry("mitmproxy", cert)`), init a `TrustManagerFactory` with it and
     `SSLContext.getInstance("TLS").init(null, tmf.getTrustManagers(), null)`. If the file is
     missing or unreadable, log a warning and fall back to `SSLContext.getDefault()` (resends of
     https calls will then fail with a clear `Failed` message). The JVM's default truststore is
     never modified.
  2. Package-private helpers (tested directly):
     - `int forwardPortFor(String serviceName)`: the mapped port, else `defaultForwardPort`;
     - `Optional<Integer> listenPortFor(String serviceName)`.
  3. `send(OutgoingCall call)`:
     - **outbound**: `HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).sslContext(ssl)
       .connectTimeout(Duration.ofMillis(timeoutMs)).proxy(ProxySelector.of(new InetSocketAddress(forwardProxyHost, forwardPortFor(call.serviceName()))))
       .followRedirects(HttpClient.Redirect.NEVER).build()`. Cache one client per port in a
       `ConcurrentHashMap<Integer, HttpClient>`. The target URI is `call.url()`.
     - **inbound**: `listenPortFor(serviceName)`; empty →
       `new Failed("Project " + serviceName + " is not fronted by the reverse proxy.")`. URI is
       `"http://" + reverseProxyHost + ":" + port + pathAndQuery(call.url())` where
       `pathAndQuery` is the raw path (default `/`) plus `?` raw query when present. Add header
       `Host: localhost:<port>` (allowed because of `-Djdk.httpclient.allowRestrictedHeaders=host`).
       One cached client without a proxy.
     - build `HttpRequest.newBuilder(uri).timeout(Duration.ofMillis(timeoutMs))
       .method(call.method(), body == null || body.isEmpty() ? BodyPublishers.noBody() : BodyPublishers.ofString(body))`
       and add every header with `.setHeader(name, value)`; skip (do not throw on) any header
       the client still refuses (`IllegalArgumentException`).
     - `long start = System.nanoTime(); HttpResponse<Void> r = client.send(request, BodyHandlers.discarding());`
       → `new Sent(r.statusCode(), (System.nanoTime() - start) / 1_000_000)`.
     - `ConnectException` on inbound → `new ReverseProxyNotRunning()`; any other `IOException` →
       `new Failed(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())`;
       `InterruptedException` → restore the interrupt flag and return `Failed("interrupted")`.
  4. `BRT/adapter/out/http/JdkHttpCallSenderTest.java`:
     - `forwardPortFor`: with map `"odeysys:8081,core:8082"`, `odeysys` → 8081, `null` → 8080,
       `gone` → 8080;
     - an inbound send against a `com.sun.net.httpserver.HttpServer` bound to `127.0.0.1:0`:
       construct the sender with reverseProxyHost `127.0.0.1` and INTERNAL_CALL_SERVICES
       `"proj:<serverPort>:9999"`; send `new OutgoingCall("inbound", "POST",
       "http://localhost:<serverPort>/api/x?y=1", {"X-A":"1","X-Request-Id":"n1"}, "{}", "proj")`;
       the handler records the request; assert the path `/api/x`, query `y=1`, header `Host`
       equals `localhost:<serverPort>`, `X-A` equals `1`, the body `{}`, and the outcome
       `Sent(204, …)` when the handler replies 204. The JVM running the test needs
       `-Djdk.httpclient.allowRestrictedHeaders=host`: add
       `<argLine>-Djdk.httpclient.allowRestrictedHeaders=host</argLine>` to a
       `maven-surefire-plugin` `<configuration>` in `backend/backend-resend/pom.xml`;
     - inbound to a closed port (bind a `ServerSocket`, read its port, close it) →
       `ReverseProxyNotRunning`;
     - an unknown project → `Failed` mentioning the project.
     - the CA file missing → constructing the sender does not throw.

- [ ] T107 [US8] Add `POST /resend`.
  1. `BR/adapter/in/web/dto/ResendRequestDto.java`:
     ```java
     public record ResendRequestDto(
             @NotBlank @Pattern(regexp = "outbound|inbound", message = "direction must be outbound or inbound") String direction,
             @NotBlank @Size(max = 200) String callId,
             @Size(max = 200) String cycleId,
             @Valid EditsDto edits,
             Boolean useCurrentSession) {

         public record EditsDto(
                 @Size(max = 16) @Pattern(regexp = "[A-Za-z]+", message = "method must be letters only") String method,
                 @Size(max = 8192, message = "url is at most 8 KB") String url,
                 @Size(max = 100, message = "at most 100 header edits") Map<String, String> headers,
                 String body) {
         }
     }
     ```
  2. `BR/adapter/in/web/ResendController.java` (`@RestController @RequestMapping("/resend")`,
     constructor-injected `ResendCallUseCase` and `@Value("${alfred.interception.max-answer-bytes:10485760}") long maxBodyBytes`):
     - `@PostMapping public ResponseEntity<Object> resend(@Valid @RequestBody ResendRequestDto body)`;
     - manual limits, collected into `List<String> problems`: each header value longer than
       8,192 characters → `"header <name> is over 8 KB"`; a header name that is blank or contains
       `\r`, `\n` or `:` → `"header name <name> is not valid"`;
       `edits.body().getBytes(UTF_8).length > maxBodyBytes` → `"body is over <n> bytes"`. Non-empty
       → `400 {"error":"invalid-request","problems":[…]}`;
     - build `ResendRequest` (edits null → `ResendEdits.NONE`, `useCurrentSession` null → false)
       and switch on the outcome: `Done` → 200 with
       `{"newCallId","status","durationMs","sessionValuesUsed":[{"name","fromCallId"}]}`;
       `NotFound` → 404 `{"error":"call-not-found"}`; `ReverseProxyNotRunning` → 409
       `{"error":"reverse-proxy-not-running"}`; `SendFailed` → 502
       `{"error":"send-failed","message":…}`.
  3. `BRT/TestApplication.java`: copy `backend/backend-calls/src/test/java/com/fathy/alfred/backend/calls/TestApplication.java`
     with package `com.fathy.alfred.backend.resend`.
  4. `BRT/adapter/in/web/ResendControllerTest.java`: `@WebMvcTest(ResendController.class)`,
     `@MockBean ResendCallUseCase`, pattern as `CallsWebhookControllerTest`. Cases: 200 with the
     mapped body; 404; 409; 502; a missing `callId` → 400; `direction: "sideways"` → 400; 101
     header edits → 400; a header value of 8,193 characters → 400 with the problem text; a body
     over the limit (set `@TestPropertySource(properties = "alfred.interception.max-answer-bytes=10")`
     and send an 11-character body) → 400; `verifyNoInteractions` on the use case for every 400.

- [ ] T108 [US8] Add the recent-headers lookups to the two call slices.
  1. `BC/application/port/in/FindRecentRequestHeadersUseCase.java`:
     ```java
     /** Request headers of the newest calls to one host - never bodies. Backs "resend with current session". */
     public interface FindRecentRequestHeadersUseCase {
         int MAX_LIMIT = 200;

         /** @param authority host[:port], lower-case; newest first; at most min(limit, MAX_LIMIT) rows */
         List<RecentRequestHeaders> findRecent(String authority, int limit);

         record RecentRequestHeaders(String callId, String timestamp, Map<String, String> headers) {}
     }
     ```
  2. `BC/application/port/out/CallLogPort.java`: add
     `default List<FindRecentRequestHeadersUseCase.RecentRequestHeaders> recentRequestHeaders(String authority, int limit) { return List.of(); }`
     only if the ports are allowed to reference an in-port type in this slice (check an existing
     out-port signature; if not, put the `RecentRequestHeaders` record in `BC/domain/model/` and
     refer to it from both). Prefer the domain-model record.
  3. `CallsService` implements the use case: clamp `limit` to 1..200 and delegate.
  4. SQLite (`SqliteCallsRepository` + `SqliteCallLogAdapter` delegation):
     ```sql
     SELECT cm.id, cm.timestamp, cr.headers FROM (
         SELECT id, timestamp, timestamp_millis FROM call_metadata
         WHERE url LIKE ? ESCAPE '\' OR url LIKE ? ESCAPE '\' OR url LIKE ? ESCAPE '\'
         ORDER BY timestamp_millis DESC LIMIT ?
     ) cm LEFT JOIN call_request cr ON cr.call_id = cm.id
     ORDER BY cm.timestamp_millis DESC
     ```
     with the three patterns `%://<a>/%`, `%://<a>?%`, `%://<a>` where `<a>` is the authority with
     `\`, `%` and `_` escaped by a preceding `\`. Parse `headers` with the repository's existing
     `fromJson`. This never touches `call_response` or `body`.
  5. File adapter (`FileCallLogAdapter`): scan `cachedLines` from newest to oldest, keep calls
     whose `URI.create(url).getRawAuthority()` equals the authority (ignore unparsable), stop at
     `limit`.
  6. backend-internal-calls: the same use case interface in `BIC/application/port/in/`, the
     record in `BIC/domain/model/`, implemented by `InternalCallsService` over
     `InternalCallsFileLogAdapter`'s in-memory `cachedLines` (newest first, compare the
     authority of `url` — the upstream URL — and of `originalUrl`, accepting either).
  7. Tests: in `SqliteCallsRepositoryTest` save 3 calls to `api.a.test` and 1 to `api.b.test`
     with different timestamps; `recentRequestHeaders("api.a.test", 2)` returns the two newest
     `a` calls, newest first, with their headers; `api.a.test:8443` matches nothing; an authority
     containing `%` matches nothing. Add an equivalent file-adapter test in backend-internal-calls.

- [ ] T109 [US8] Add the bridges in backend-app, package `com.fathy.alfred.backend.resendbridge`
  (`BA/resendbridge/`). Copy the style of `BA/interceptionbridge/RecordedCallLookupAdapter.java`
  (fully qualified names for the two `GetCallDetailUseCase`s and the two `CallDetail`s).
  1. `CallSourceAdapter implements CallSourcePort`: inject the calls and internal-calls
     `GetCallDetailUseCase`s, `GetCapturedCallDetailUseCase` and
     `GetCapturedInternalCallDetailUseCase`. The detail use cases return only request/response,
     but a resend also needs `method`, `original_url` and `service_name`. Inject as well the calls
     slice's `GetCallsUseCase` and the internal one, OR add a small in-port per call slice
     `FindCallUseCase { Optional<CallRecord> find(String id); }` implemented by the service via
     `callLogPort.findById(id)` — **do the latter** (it is one query, not a list scan). For
     captured calls, add `Optional<CapturedCall> findCaptured(String cycleId, String callId)` to
     session-cycles as a new in-port `FindCapturedCallUseCase` (and its internal twin),
     implemented by the session-cycles service from its repository's existing detail lookup
     (read how `GetCapturedCallDetailUseCase` is implemented and reuse the same repository
     method). Map the record to `StoredCall(direction, record.id(), record.method(),
     record.originalUrl() != null ? record.originalUrl() : record.url(), request headers, request
     body, record.serviceName())`.
  2. `SessionValueLookupAdapter implements SessionValueLookupPort`: for `outbound` call the
     calls slice's `FindRecentRequestHeadersUseCase.findRecent(authority, 200)`, for `inbound`
     the internal one. Walk the rows newest first, skip `excludeCallId`, and for each wanted
     name take the first row that has that header (case-insensitive name); return
     `SessionValue(lowerCaseName, value, callId)`. Stop once every name is found.
  3. Tests in `backend/backend-app/src/test/java/com/fathy/alfred/backend/resendbridge/` with
     Mockito mocks (pattern: `RecordedCallLookupAdapterTest` in `interceptionbridge`): the source
     adapter picks the captured lookup when `cycleId` is set; the lookup adapter returns the
     newest value per name, skips the excluded call, and matches names case-insensitively.
  4. Run the whole backend reactor including ArchUnit (command at the top of this file). The
     resend slice rule now has classes and must pass without `allowEmptyShould`. Then run the
     boot check from T131 step 4: the new beans must wire.

### Frontend

Read `mockups/resend-dialog-mock.html` before T111-T112; the UI must match it.

- [ ] T110 [US8] Add the API service and the model fields.
  1. `FE/core/models/call.model.ts`: add to `CallSummaryDto` (lines 110-128)
     `readonly resend_of?: string | null; readonly resend_edits?: ResendEditsSummary | null;`
     and to `CallRecord` (45-93) `readonly resendOf?: string | null; readonly resendEdits?: ResendEditsSummary | null;`.
     Add the type:
     ```ts
     /** What a resend changed - names only, never values (data-model §7). */
     export interface ResendEditsSummary {
       readonly method?: { readonly from: string; readonly to: string };
       readonly url?: { readonly from: string; readonly to: string };
       readonly headers?: readonly string[];
       readonly body?: boolean;
       readonly session?: readonly { readonly name: string; readonly fromCallId: string }[];
     }
     ```
  2. `FE/shared/utils/call-utils.ts` `toCallRecord` (21-43): add
     `resendOf: dto.resend_of ?? null, resendEdits: dto.resend_edits ?? null,` before `source`.
  3. Create `FE/core/services/resend-api.service.ts`, copying the shape of
     `interception-api.service.ts:18-41`:
     ```ts
     export interface ResendRequest {
       readonly direction: 'outbound' | 'inbound';
       readonly callId: string;
       readonly cycleId?: string | null;
       readonly edits?: {
         readonly method?: string;
         readonly url?: string;
         readonly headers?: Readonly<Record<string, string | null>>;
         readonly body?: string;
       };
       readonly useCurrentSession?: boolean;
     }

     export interface ResendResult {
       readonly newCallId: string;
       readonly status: number;
       readonly durationMs: number;
       readonly sessionValuesUsed: readonly { readonly name: string; readonly fromCallId: string }[];
     }

     @Injectable({ providedIn: 'root' })
     export class ResendApiService {
       private readonly http = inject(HttpClient);
       private readonly config = inject(AppConfigService);

       resend(request: ResendRequest): Observable<ResendResult> {
         return this.http.post<ResendResult>(`${this.config.backendUrl}/resend`, request);
       }
     }
     ```
     `direction` from a `CallRecord`: `call.source === 'internal' ? 'inbound' : 'outbound'`.

- [ ] T111 [US8] Create the dialog.
  1. `FE/core/services/resend-dialog.service.ts`, same pattern as `export-dialog.service.ts`:
     `readonly state = signal<{ call: CallRecord; cycleId: string | null } | null>(null)`,
     `open(call: CallRecord, cycleId: string | null = null)`, `close()`.
  2. `FE/components/resend-dialog/resend-dialog.component.{ts,html}`
     (`selector: 'app-resend-dialog'`, standalone, reads `ResendDialogService.state`), mounted
     next to `<app-export-dialog />` in `FE/pages/dashboard/dashboard.component.html` (line ~17)
     and `FE/pages/session-cycle-detail/session-cycle-detail.component.html` (line ~63); the
     session-cycle page opens it with its cycle id.
     - On open, hydrate the call the way `call-actions.component.ts:105-107` does
       (`controlsState.getCallDetail(call.id, call.source)` merged into the call) and fill the
       form signals: `method`, `url` (from `original_url`), `headerRows: {name, value, original: boolean, removed: boolean}[]`
       (from `request.headers`), `body` (from `request.body`), `useCurrentSession = false`.
       Hide `content-length` and `host` rows (the backend drops them anyway) with a note.
     - Header rows: edit value, remove (strikes the row, sends `null`), add a new row. Secret
       names (use `InterceptionStateService.sensitiveNames()`, null = treat every value as
       secret) show their value masked until a "show" toggle is clicked; the masked text is
       never sent unless edited.
     - `buildRequest()` (public, tested): include `edits.method` only when it differs from the
       original, `edits.url` only when different, `edits.headers` only for rows changed, added
       or removed (removed → `null`), `edits.body` only when different; omit `edits` when empty.
     - Send button → `ResendApiService.resend(buildRequest())`; show a spinner; on success show
       the result block: `status`, `durationMs`, a link "Open the new call" that selects
       `newCallId` in the list (the call arrives through the normal WebSocket push; if the page
       has a "scroll to call" helper use it, else just show the id with a copy chip like
       `call-card.component.html:39-48`), and "Session values used: cookie from call c-9"
       (names and call ids only). 409 → "The reverse proxy is not running - turn on inbound
       logging in Settings first."; 404 → "That call is no longer in the log."; 502 → the
       `message`; 400 → the `problems` list.
     - Style with the existing dialog classes (`dialog-backdrop`, `dialog-card`, `dialog-sub`,
       `dialog-actions`, `dialog-btn primary|secondary`) from `export-dialog.component.html`.

- [ ] T112 [US8] Add the entry points.
  1. `FE/components/call-actions/call-actions.component.html` (Export menu, lines 9-19): add a
     fourth `<button type="button" class="filter-option-item" title="Send this call again through Alfred" (click)="openResend()">Resend…</button>`;
     in the component, inject `ResendDialogService` and add `openResend(): void { this.resendDialog.open(this.call()); }`.
     (The session-cycle page provides the cycle id: add an optional `CYCLE_ID` injection token
     only if one does not already exist — search `core/state/` for a token the cycle page
     provides; otherwise pass `null`.)
  2. `FE/components/bulk-actions-bar/bulk-actions-bar.component.{ts,html}`: in the Export menu
     (html 19-32) add "Resend selected". In the TS add signals `resendProgress = signal<{done: number; total: number} | null>(null)`
     and a method `resendSelected()` that takes `this.state.selectedCalls()` (already in display
     order), then sends them **one at a time**: use `from(calls).pipe(concatMap(call => this.resendApi.resend({direction, callId: call.id})))`
     — never `forkJoin`/`merge`, which would send them concurrently. Update the progress after
     each; on the first error with status 409 stop (`takeWhile` or complete the stream) and
     show "Stopped at call N of M: the reverse proxy is not running."; show "Resent M calls"
     at the end. Bulk resend sends no edits.
  3. `FE/components/call-card/call-card.component.html` (badge row 158-198): before
     `<app-call-actions [call]="call()" />` (line ~179) add
     ```html
     @if (call().resendOf; as original) {
       <span class="badge resend-badge" [title]="resendTooltip()">↻ resend of {{ original.slice(0, 8) }}</span>
     }
     ```
     and in the TS `readonly resendTooltip = computed(() => describeResendEdits(this.call().resendEdits))`
     where `describeResendEdits` (new, in `FE/shared/utils/call-utils.ts`) returns e.g.
     `"Changed: method POST → PUT · headers x-api-key, cookie · body · session cookie from c-9"`,
     or `"Sent unchanged"` for null. Add a `.resend-badge` style next to `.intercept-badge` in
     `FE/styles.scss` (search for `.intercept-badge` and copy its block with a different colour
     variable, e.g. `var(--cyan)`).

- [ ] T113 [P] [US8] Add the frontend specs.
  1. `FE/components/bulk-actions-bar/bulk-actions-bar.component.spec.ts` (create it if it does
     not exist; provide `BULK_SELECTION_STATE`, `CALL_LIST_CONTROLS_STATE` and
     `CALL_REMOVAL_STATE` stubs and `provideHttpClientTesting`): with three selected calls
     `a, b, c`, `resendSelected()` issues the first `POST /resend` for `a` only; after flushing it,
     the second for `b`; after `b`, `c`. A 409 on `b` means no request for `c`, and the progress
     message says it stopped at 2 of 3.
  2. `FE/components/resend-dialog/resend-dialog.component.spec.ts`: open the dialog on a call
     with method `POST`, url `https://api.test/x`, headers `{A: '1', Cookie: 's=1'}`, body `{}`;
     flush the detail request; unchanged form → `buildRequest()` has no `edits`; change method to
     `PUT`, remove `Cookie`, add `X-B: 2` → `edits` equals
     `{ method: 'PUT', headers: { Cookie: null, 'X-B': '2' } }`; a 409 response shows the
     reverse-proxy message.
  3. `FE/shared/utils/call-utils.spec.ts`: `toCallRecord` maps `resend_of`/`resend_edits`;
     `describeResendEdits` output for a full summary and for null.
  4. Run the frontend tests and build (commands at the top of this file).

---

## Phase 12: User Story 9 — View and edit WebSocket messages (P4)

**Independent Test**: quickstart check 10.

**Read first**: `specs/001-interception-mitmproxy-parity/data-model.md` §8 (table, cap,
retention), `contracts/proxy-webhooks.md:29-47` (the batch payload), `contracts/rest-api.md:38-48`
(the read API and the push event), research R14, and `mockups/ws-messages-mock.html` (the UI).

**Known traps, found while planning — each is handled in a task below**:
- `FE/core/state/calls-state.service.ts:249-254` treats ANY socket message without a `call` key
  as "calls cleared" and empties the list. A `ws-messages-appended` event would wipe the live
  list unless that branch switches on `type` first (T121 step 4).
- `RuleValidator.validateNestedActions` (`:440-459`) already refuses a nested action whose phase
  differs from the parent's, so a MESSAGE action inside `IF_*` is already rejected, with the
  generic phase message. T115 adds a specific message.
- No code in the repo uses mitmproxy's WebSocket API yet. The API used below is mitmproxy's
  current one: hooks `websocket_start(flow)`, `websocket_message(flow)` (may be `async`),
  `websocket_end(flow)`; the newest message is `flow.websocket.messages[-1]`, a
  `WebSocketMessage` with `.from_client` (bool), `.is_text` (bool), `.text` / `.content`
  (settable), `.timestamp` (float seconds) and `.drop()`; the close code is
  `flow.websocket.close_code`. The handshake is an ordinary HTTP flow (status 101) that has
  already gone through `request` and `response`, so `flow.metadata['call_id']` is set when
  logging is on.
- backend-calls' `FileCallLogAdapter.save` rewrites its file in place; only
  `InternalCallsFileLogAdapter.writeAllLines` (`:217-231`) does temp-file + atomic move. Copy that
  one for every message-file compaction.

**Message record** (one shape everywhere — proxy payload, storage, REST, exports):
`{seq:int, direction:'client'|'server', tsMillis:int, type:'text'|'binary', content?:string,
contentBase64?:string, originalContent?:string, action?:string, ruleId?:string, ruleName?:string}`.
`content` for text, `contentBase64` for binary, never both. `originalContent` only when a rule
edited it (base64 for binary). `action` is `edited`, `dropped` or `delayed:<ms>`, or absent.

### Proxy

- [ ] T114 [P] [US9] Write the proxy tests.
  1. Create `PX/test_ws_messages.py` (stdlib `unittest` only, same header docstring style as
     `test_interception.py`). A fake clock:
     ```python
     class FakeClock:
         def __init__(self): self.now = 100.0
         def __call__(self): return self.now
     ```
     and a sink list `sent = []` passed as `send=lambda payload: sent.append(payload)`. Tests
     for `ws_messages.WsBatcher` (T117):
     - `test_nothing_is_sent_before_fifty_messages_or_half_a_second`: add 49 records at the same
       clock time → `sent == []`;
     - `test_the_fiftieth_message_flushes_the_batch`: add 50 → one payload with 50 messages,
       `closed` False, `closeCode` None;
     - `test_a_message_half_a_second_after_the_first_flushes`: add 1, advance the clock 0.5, add 1
       → one payload with 2 messages;
     - `test_flush_if_due_sends_an_old_batch_without_a_new_message`: add 1, advance 0.6, call
       `flush_if_due()` → sent; calling it again sends nothing;
     - `test_close_sends_whatever_is_left_marked_closed`: add 3, `close(1000)` → one payload,
       `closed` True, `closeCode` 1000; `close` with an empty batch still sends
       `{messages: [], closed: True, closeCode: …}`;
     - `test_seq_increases_per_connection`: `next_seq()` on one batcher gives 0, 1, 2; a second
       batcher starts at 0 again.
  2. In `PX/test_interception.py`, add a fake message:
     ```python
     class FakeWsMessage:
         def __init__(self, text=None, content=None, from_client=True):
             self.is_text = text is not None
             self.text = text
             self.content = content if content is not None else (text or '').encode('utf-8')
             self.from_client = from_client
             self.dropped = False
         def drop(self):
             self.dropped = True
     ```
     and a class `MessageActionsTest(unittest.TestCase)` with a `setUp` tempdir and a helper
     `rules(*actions, match=None)` that writes one rule and returns
     `engine.match_for_websocket(FakeFlow(FakeRequest()), None)`. Tests (all `run(...)` the async
     `apply_message`):
     - `test_replace_edits_only_the_configured_direction`: action
       `{'type': 'REPLACE_IN_MESSAGE', 'messageDirection': 'server', 'pattern': 'EUR', 'replacement': 'USD'}`;
       a client message `'EUR'` → `verdict.edited is False`, text unchanged; a server message
       `'1 EUR'` → `verdict.edited is True`, `verdict.new_text == '1 USD'`,
       `verdict.original == '1 EUR'`, `verdict.action == 'edited'`, `verdict.rule_id == 'r1'`;
     - `test_drop_with_contains_drops_only_matching_messages`: `DROP_MESSAGE`,
       `messageDirection: 'both'`, `contains: 'ping'` → message `'{"op":"ping"}'` gives
       `verdict.dropped is True`, `action == 'dropped'`; `'{"op":"data"}'` does not;
     - `test_delay_returns_a_delay_and_does_not_sleep`: `DELAY_MESSAGE`, `durationMs: 2000`,
       `messageDirection: 'both'` → `verdict.delay_ms == 2000`, `action == 'delayed:2000'`, and
       the call returns immediately (no `asyncio.sleep` in the engine);
     - `test_a_delay_over_the_ceiling_is_clamped`: `durationMs: 999999999` → `MAX_DELAY_MS`;
     - `test_an_unknown_message_kind_is_recorded_as_skipped`: an action `{'type': 'SHOUT_MESSAGE'}`
       → `verdict.applied[0].detail == 'skipped - unknown action SHOUT_MESSAGE'`;
     - `test_rules_without_message_actions_are_not_returned`: a rule with only
       `SET_REQUEST_HEADER` → `match_for_websocket` returns `[]` (so a plain connection costs
       nothing per message);
     - `test_a_binary_message_is_matched_on_its_bytes_decoded_as_utf8_with_replacement`: a
       `FakeWsMessage(content=b'\xffEUR')` with a replace EUR→USD edits `new_content` to
       `b'\xffUSD'` — or, if binary replace is out of scope in T116, assert it is skipped with
       `'skipped - binary message'`. **Choose the skip** (simpler, and a binary protocol edit
       by text pattern is rarely right).
  3. Add to `EveryActionIsCoveredTest`: this suite only walks `REQUEST_ACTIONS` and
     `RESPONSE_ACTIONS`, so MESSAGE actions need their own coverage check. Add a test
     `test_every_message_action_has_a_message_test` asserting
     `interception.MESSAGE_ACTIONS == {'REPLACE_IN_MESSAGE', 'DROP_MESSAGE', 'DELAY_MESSAGE'}`
     (a new message action then fails the build until someone writes its tests).

- [ ] T115 [US9] Add the three actions to backend-interception.
  1. `BI/domain/model/ActionType.java`: after `IF_RESPONSE(Phase.RESPONSE)` change its `;` to
     `,` and add:
     ```java
     /** Find/replace in one WebSocket message (the US1 pattern fields), for the chosen direction. */
     REPLACE_IN_MESSAGE(Phase.MESSAGE),
     /** Drops a WebSocket message - every message in the direction, or only those containing {@code contains}. */
     DROP_MESSAGE(Phase.MESSAGE),
     /** Holds each message in the direction for {@code durationMs} - only that connection waits. */
     DELAY_MESSAGE(Phase.MESSAGE);
     ```
  2. `BI/domain/model/RuleValidator.java`, `validateAction` switch before `default`:
     ```java
     case REPLACE_IN_MESSAGE -> {
         requireDirection(action, problems);
         validateReplacement(action, problems);
     }
     case DROP_MESSAGE -> {
         requireDirection(action, problems);
         if (action.contains() != null && action.contains().length() > PatternSafety.MAX_PATTERN_LENGTH) {
             problems.add("DROP_MESSAGE's text to look for is at most " + PatternSafety.MAX_PATTERN_LENGTH + " characters.");
         }
     }
     case DELAY_MESSAGE -> {
         requireDirection(action, problems);
         if (action.durationMs() == null || action.durationMs() < 0) {
             problems.add("DELAY_MESSAGE needs a duration of 0 ms or more.");
         } else if (action.durationMs() > MAX_DELAY_MS) {
             problems.add("DELAY_MESSAGE is capped at " + MAX_DELAY_MS + " ms.");
         }
     }
     ```
     and the helper
     ```java
     private static void requireDirection(RuleAction action, List<String> problems) {
         String direction = action.messageDirection();
         if (direction == null || !List.of("client", "server", "both").contains(direction)) {
             problems.add(action.type() + " needs a direction: client, server or both.");
         }
     }
     ```
  3. `validateNestedActions` (`:440-459`): before the existing phase check add
     ```java
     if (nested.type().phase() == ActionType.Phase.MESSAGE) {
         problems.add(nested.type() + " runs on WebSocket messages and cannot go inside a condition.");
         continue;
     }
     ```
  4. `BIT/domain/RuleValidatorTest.java`, using `problemsOf(Map.of(...))`:
     - `messageActionsNeedADirection`: each of the three without `messageDirection` →
       `"needs a direction"`; with `"sideways"` → the same;
     - `aMessageDelayIsCapped`: `DELAY_MESSAGE` with 120001 → `"capped at 120000 ms"`; 0 → valid;
     - `aMessageReplaceGetsThePatternChecks`: `REPLACE_IN_MESSAGE` with `"(a+)+"`, `regex:true`
       → `"repeats a group"`;
     - `aMessageActionCannotGoInsideACondition`: an `IF_REQUEST` whose branch holds a
       `DELAY_MESSAGE` → `"cannot go inside a condition"`.
  5. Run the backend-interception tests.

- [ ] T116 [US9] Add message evaluation to `PX/interception.py`.
  1. After `RESPONSE_ACTIONS` add
     `MESSAGE_ACTIONS = {'REPLACE_IN_MESSAGE', 'DROP_MESSAGE', 'DELAY_MESSAGE'}` and change
     `_known_action` to `return kind in REQUEST_ACTIONS or kind in RESPONSE_ACTIONS or kind in MESSAGE_ACTIONS`.
     Also: `apply_request` records `unknown action` for kinds not in any set; MESSAGE kinds are
     known, so the request and response phases now skip them silently — correct.
  2. Add the class (next to `Verdict`):
     ```python
     class MessageVerdict:
         """What the rules did to one WebSocket message. At most one action is reported per message
         (the first that changed it), because the message record has one `action` field."""

         __slots__ = ('delay_ms', 'dropped', 'edited', 'new_text', 'original', 'action',
                      'rule_id', 'rule_name', 'applied')

         def __init__(self):
             self.delay_ms = 0
             self.dropped = False
             self.edited = False
             self.new_text = None
             self.original = None
             self.action = None
             self.rule_id = None
             self.rule_name = None
             self.applied = []

         def mark(self, rule, action):
             if self.action is None:
                 self.action, self.rule_id, self.rule_name = action, rule.id, rule.name
     ```
  3. Add to `InterceptionEngine`:
     ```python
     def match_for_websocket(self, flow, service_name):
         """The rules that matched the handshake and have at least one MESSAGE action, cached by the
         addon at websocket_start. Evaluated once per connection, never per message."""
         ruleset = self._cache.current()
         return [rule for rule in self._matching(flow, service_name, ruleset)
                 if any(action.get('type') in MESSAGE_ACTIONS or
                        (str(action.get('type') or '').endswith('_MESSAGE') and not _known_action(action.get('type')))
                        for action in rule.actions)]

     async def apply_message(self, rules, message, from_client):
         verdict = MessageVerdict()
         direction = 'client' if from_client else 'server'
         for rule in rules:
             for action in rule.actions:
                 kind = action.get('type')
                 if kind not in MESSAGE_ACTIONS:
                     if kind and kind.endswith('_MESSAGE') and not _known_action(kind):
                         verdict.applied.append(Applied(rule.id, rule.name, kind, f'skipped - unknown action {kind}'))
                     continue
                 wanted = action.get('messageDirection') or 'both'
                 if wanted != 'both' and wanted != direction:
                     continue
                 if kind == 'DELAY_MESSAGE':
                     ms = _clamp_delay(action.get('durationMs'))
                     if ms:
                         verdict.delay_ms += ms
                         verdict.mark(rule, f'delayed:{ms}')
                     continue
                 if not message.is_text:
                     verdict.applied.append(Applied(rule.id, rule.name, kind, 'skipped - binary message'))
                     continue
                 text = verdict.new_text if verdict.edited else message.text
                 if kind == 'DROP_MESSAGE':
                     needle = action.get('contains')
                     if needle is None or needle == '' or needle in (text or ''):
                         verdict.dropped = True
                         verdict.action = None  # a drop wins over an earlier edit or delay
                         verdict.mark(rule, 'dropped')
                         return verdict
                     continue
                 if kind == 'REPLACE_IN_MESSAGE':
                     pattern = action.get('__pattern') or _Pattern(action)
                     new_text, _n, _reason = await pattern.replace(text or '')
                     if new_text is not None and new_text != text:
                         if not verdict.edited:
                             verdict.original = message.text
                         verdict.edited = True
                         verdict.new_text = new_text
                         verdict.mark(rule, 'edited')
         if verdict.delay_ms:
             verdict.delay_ms = min(verdict.delay_ms, MAX_DELAY_MS)
         return verdict
     ```
     `_prepare_actions` already builds `__pattern` for any action with a `pattern`, so
     `REPLACE_IN_MESSAGE` gets its compiled pattern at load time.
  4. Run the proxy tests; T114's `MessageActionsTest` passes.

- [ ] T117 [US9] Create the batcher and the addon hooks.
  1. Replace the one-line `PX/ws_messages.py` with:
     ```python
     """WebSocket message batching for both addons.

     Messages are never posted one at a time: a busy socket would put one webhook per frame on the
     single worker queue both phases of every call share. A batch goes out at 50 messages, when a
     message arrives half a second after the batch's first one, when the addon's half-second timer
     fires, or at close. Content is never truncated here - the backend enforces the per-connection cap.
     """

     import time

     MAX_BATCH = 50
     MAX_AGE_SECONDS = 0.5


     class WsBatcher:
         def __init__(self, send, clock=time.monotonic):
             self._send = send
             self._clock = clock
             self._batch = []
             self._first_at = None
             self._seq = 0

         def next_seq(self):
             seq = self._seq
             self._seq += 1
             return seq

         def add(self, record):
             """Queues one message record; returns True when this call sent a batch."""
             if not self._batch:
                 self._first_at = self._clock()
             self._batch.append(record)
             if len(self._batch) >= MAX_BATCH or self._clock() - self._first_at >= MAX_AGE_SECONDS:
                 self._flush(closed=False, close_code=None)
                 return True
             return False

         def pending(self):
             return bool(self._batch)

         def flush_if_due(self):
             if self._batch and self._clock() - self._first_at >= MAX_AGE_SECONDS:
                 self._flush(closed=False, close_code=None)

         def close(self, close_code):
             self._flush(closed=True, close_code=close_code)

         def _flush(self, closed, close_code):
             payload = {'messages': self._batch, 'closed': closed, 'closeCode': close_code}
             self._batch = []
             self._first_at = None
             self._send(payload)


     def message_record(seq, message, verdict):
         """One message as the backend stores it (see the message record in tasks.md, Phase 12)."""
         import base64
         record = {
             'seq': seq,
             'direction': 'client' if message.from_client else 'server',
             'tsMillis': int((getattr(message, 'timestamp', None) or time.time()) * 1000),
             'type': 'text' if message.is_text else 'binary',
         }
         if message.is_text:
             record['content'] = verdict.new_text if verdict.edited else message.text
             if verdict.edited:
                 record['originalContent'] = verdict.original
         else:
             record['contentBase64'] = base64.b64encode(message.content or b'').decode('ascii')
         if verdict.action:
             record['action'] = verdict.action
             record['ruleId'] = verdict.rule_id
             record['ruleName'] = verdict.rule_name
         return record
     ```
     Move `import base64` to the top of the module (imports belong at the top; it is inline here
     only to keep the snippet readable).
  2. Both addons (`PX/log_and_route.py` and `PX/log_and_route_reverse.py`):
     - `import ws_messages` next to `import interception`;
     - the webhook worker (`log_and_route.py:108-132`, `log_and_route_reverse.py:80-97`) builds the
       URL from `phase`. Replace that line with
       ```python
       if phase == 'prepare':
           url = f'{WEBHOOK_URL}/prepare'
       elif phase == 'ws':
           url = f'{WEBHOOK_URL}/{call_id}/ws-messages'
       else:
           url = f'{WEBHOOK_URL}/{call_id}/complete'
       ```
       and update the queue comment (`log_and_route.py:103-104`) to list `('ws', call_id, data)`;
       use `WEBHOOK_TIMEOUT_SECONDS` for `ws`;
     - add three methods to the addon class (`RouteAndLog` in the forward addon, and the reverse
       addon's class):
       ```python
       def websocket_start(self, flow):
           call_id = flow.metadata.get('call_id')
           rules = ENGINE.match_for_websocket(flow, flow.metadata.get('service_name'))
           state = {'rules': rules, 'batcher': None}
           if WEBHOOK_URL and call_id:
               state['batcher'] = ws_messages.WsBatcher(
                   lambda payload, cid=call_id: _webhook_queue.put_nowait(('ws', cid, payload)))
           flow.metadata['ws'] = state

       async def websocket_message(self, flow):
           state = flow.metadata.get('ws')
           if state is None:
               return
           message = flow.websocket.messages[-1]
           verdict = interception.MessageVerdict()
           if state['rules']:
               verdict = await ENGINE.apply_message(state['rules'], message, message.from_client)
               if verdict.delay_ms:
                   # This connection's messages are handled in order, so later ones on it wait;
                   # other connections are not affected (asyncio.sleep, never time.sleep).
                   await asyncio.sleep(verdict.delay_ms / 1000.0)
               if verdict.dropped:
                   message.drop()
               elif verdict.edited:
                   message.text = verdict.new_text
           batcher = state['batcher']
           if batcher is not None:
               if not batcher.add(ws_messages.message_record(batcher.next_seq(), message, verdict)) and batcher.pending():
                   asyncio.get_running_loop().call_later(ws_messages.MAX_AGE_SECONDS, batcher.flush_if_due)

       def websocket_end(self, flow):
           state = flow.metadata.get('ws')
           if state and state['batcher'] is not None:
               state['batcher'].close(getattr(flow.websocket, 'close_code', None))
       ```
       Check that `asyncio` is imported in both files (it is used for delays already).
       In the reverse addon, `call_id` is only set when that project's logging is on, so a
       disabled project records nothing but rules still apply — the intended behaviour.
  3. `docker-compose.yml` already mounts `ws_messages.py` into both proxies (lines ~96 and ~182).
  4. Run the proxy tests. Then, in the real image, check the hook names import cleanly:
     `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/scripts" -w /scripts --entrypoint python3 mitmproxy/mitmproxy:latest -c "import sys; sys.path.insert(0,'.'); import log_and_route, log_and_route_reverse; print('ok')"`
     from `proxy/` (set `WEBHOOK_URL=` empty so no worker thread starts: prefix the python
     command's environment with `-e WEBHOOK_URL=` on `docker run`).

### Backend

- [ ] T118 [P] [US9] Write the backend tests (they fail until T119/T120).
  1. `BCT/adapter/out/sqlite/SqliteCallsRepositoryTest.java` (setup `repositoryFor(...)`,
     lines 33-64; set `wsMaxMessages` through the same `setField` helper, value 5):
     - `wsMessagesAreStoredInOrderAndPaged`: save a call `c1`, append 3 messages seq 0-2, then
       `wsMessages("c1", 1, 10)` returns seq 1-2, `total == 3`, `dropped == 0`;
     - `theCapDropsTheOldestAndCountsThem`: append 7 messages to `c1` (cap 5) in two batches (4,
       then 3) → `total == 5`, the first returned seq is 2, `dropped == 2`;
     - `appendingToAnUnknownCallIsRefused`: returns false, no rows;
     - `deletingTheCallDeletesItsMessages`: `deleteAll()` then `wsMessages` total 0.
  2. `BCT/adapter/in/web/CallsWebhookControllerTest.java` (pattern at lines 27-75,
     `@TestPropertySource(properties = "alfred.webhook.secret=correct-secret")`): a ws-messages
     POST without the secret → 401; with it and the use case returning false → 404; returning
     true → 204 and the use case got the messages.
  3. `BCT/adapter/in/web/CallsControllerTest.java` (create if absent, `@WebMvcTest(CallsController.class)`
     with `@MockBean` for every use case the controller injects): `GET /calls/c1/ws-messages?offset=0&limit=9999`
     calls the use case with limit 500; `limit=0` → 1; unknown call → 404.
  4. backend-internal-calls: `InternalWsMessagesFileAdapterTest` (`@TempDir`, cap 5): append,
     page, cap + dropped, and **retention** — construct it with a "retained call ids" supplier
     returning `{c2}`, append messages for `c1` and `c2`, call `compact()`, assert no line for
     `c1` remains in the file and `c2`'s are intact.
  5. backend-calls file mode: `FileWsMessagesStoreTest` with the same four cases as step 4.

- [ ] T119 [US9] Implement message storage in backend-calls.
  1. Domain, `BC/domain/model/`:
     ```java
     @JsonInclude(JsonInclude.Include.NON_NULL)
     public record WsMessage(long seq, String direction, long tsMillis, String type, String content,
                             String contentBase64, String originalContent, String action,
                             String ruleId, String ruleName) {}

     public record WsMessagesPage(List<WsMessage> messages, long total, long dropped) {}
     ```
  2. In-ports, `BC/application/port/in/`:
     `AppendWsMessagesUseCase { boolean append(String callId, List<WsMessage> messages, boolean closed, Integer closeCode); }`
     and `GetWsMessagesUseCase { Optional<WsMessagesPage> page(String callId, int offset, int limit); }`
     (empty = unknown call). `CallsService` implements both: `page` clamps
     `limit` to 1..500 and `offset` to ≥0; `append` delegates to the port and, when it returns
     true, calls `notificationPort.notifyWsMessagesAppended(callId)`.
  3. `BC/application/port/out/CallLogPort.java`: add
     `default boolean appendWsMessages(String callId, List<WsMessage> messages, boolean closed, Integer closeCode) { return false; }`
     and `default Optional<WsMessagesPage> wsMessages(String callId, int offset, int limit) { return Optional.empty(); }`.
     `CallNotificationPort`: add `default void notifyWsMessagesAppended(String callId) { }`.
  4. SQLite (`SqliteCallsRepository`, delegated from `SqliteCallLogAdapter` like `deleteAll`
     at `:154-156`):
     - field `@Value("${alfred.calls.ws-max-messages:1000}") private int wsMaxMessages;`;
     - in `createSchema()`, after the `call_response` table, the table from data-model §8
       (verbatim) plus `CREATE INDEX IF NOT EXISTS idx_call_ws_message_call ON call_ws_message(call_id, seq)`;
       an `addWsColumnsIfMissing()` in the ALTER style (`ws_message_count INTEGER`,
       `ws_dropped INTEGER`) called with the other `add*IfMissing()` calls. The JDBC URL already
       has `foreign_keys=true` (line 131), so `ON DELETE CASCADE` works — including for
       `enforceRetention()` and `deleteAll()`;
     - `appendWsMessages`: one transaction on one connection:
       ```java
       public boolean appendWsMessages(String callId, List<WsMessage> messages) {
           return Boolean.TRUE.equals(jdbcTemplate.execute((ConnectionCallback<Boolean>) con -> {
               boolean autoCommit = con.getAutoCommit();
               con.setAutoCommit(false);
               try {
                   try (PreparedStatement exists = con.prepareStatement("SELECT 1 FROM call_metadata WHERE id = ?")) {
                       exists.setString(1, callId);
                       try (ResultSet rs = exists.executeQuery()) {
                           if (!rs.next()) { con.rollback(); return false; }
                       }
                   }
                   try (PreparedStatement insert = con.prepareStatement(
                           "INSERT OR IGNORE INTO call_ws_message (call_id, seq, direction, ts_millis, type, content, content_base64, original_content, action) VALUES (?,?,?,?,?,?,?,?,?)")) {
                       for (WsMessage m : messages) {
                           insert.setString(1, callId); insert.setLong(2, m.seq()); insert.setString(3, m.direction());
                           insert.setLong(4, m.tsMillis()); insert.setString(5, m.type()); insert.setString(6, m.content());
                           insert.setString(7, m.contentBase64()); insert.setString(8, m.originalContent());
                           insert.setString(9, actionColumn(m));
                           insert.addBatch();
                       }
                       insert.executeBatch();
                   }
                   long count = countWsMessages(con, callId);
                   long over = Math.max(0, count - wsMaxMessages);
                   if (over > 0) {
                       try (PreparedStatement trim = con.prepareStatement(
                               "DELETE FROM call_ws_message WHERE call_id = ? AND seq IN (SELECT seq FROM call_ws_message WHERE call_id = ? ORDER BY seq LIMIT ?)")) {
                           trim.setString(1, callId); trim.setString(2, callId); trim.setLong(3, over);
                           trim.executeUpdate();
                       }
                   }
                   try (PreparedStatement update = con.prepareStatement(
                           "UPDATE call_metadata SET ws_message_count = ?, ws_dropped = COALESCE(ws_dropped, 0) + ? WHERE id = ?")) {
                       update.setLong(1, count - over); update.setLong(2, over); update.setString(3, callId);
                       update.executeUpdate();
                   }
                   con.commit();
                   return true;
               } catch (SQLException e) {
                   con.rollback();
                   throw e;
               } finally {
                   con.setAutoCommit(autoCommit);
               }
           }));
       }
       ```
       `actionColumn(m)` stores `action`, and when `ruleId` is set appends a JSON suffix:
       `action + " " + {"ruleId":…,"ruleName":…}` serialised with the repository's
       `objectMapper`; the row mapper splits it back at the first space followed by `{`.
       `countWsMessages` is `SELECT COUNT(*) FROM call_ws_message WHERE call_id = ?`.
     - `wsMessages(callId, offset, limit)`: empty `Optional` when the call does not exist;
       otherwise `SELECT seq, direction, ts_millis, type, content, content_base64, original_content, action FROM call_ws_message WHERE call_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
       `total` = `COUNT(*)`, `dropped` = `COALESCE(ws_dropped, 0)` from `call_metadata`.
     - `closed`/`closeCode` are not stored (nothing reads them yet); accept them in the port and
       ignore them in the adapters.
  5. File mode (`type=file`): create `BC/adapter/out/filelog/FileWsMessagesStore.java`, a plain
     class (not a Spring bean) owned by `FileCallLogAdapter`:
     - file `${RECENT_CALLS_FILE}` with `.ws.log` appended to its file name, NDJSON, one line per
       message: the `WsMessage` fields plus `callId`;
     - in-memory index `Map<String, CallMessages>` (per call: `List<WsMessage>` and a dropped
       counter), loaded lazily from the file on first use;
     - `append(callId, messages)`: add, trim each call to the cap (count the trimmed as dropped),
       append the new lines to the file; when lines on disk exceed
       `totalMessages + max(totalMessages / 2, 50)`, compact;
     - `compact(Set<String> retainedCallIds)`: drop every call not in the set, rewrite the file
       with temp + atomic move exactly like `InternalCallsFileLogAdapter.writeAllLines`
       (`:217-231`), and persist dropped counts as a line
       `{"callId":…,"dropped":N}` per call (read back on load);
     - `clear()`: delete the file and the index.
     `FileCallLogAdapter`: `appendWsMessages` returns false when the call id is not in
     `cachedLines`/`pendingById`, else delegates; after `save` trims the ring (the
     `next.subList(...)` at `:135-160`), call `wsStore.compact(<ids still in next>)` when any
     line was dropped; `deleteAll` (`:330-339`) calls `wsStore.clear()`.
  6. Routes:
     - `CallsWebhookController`: `@PostMapping("/calls/webhook/{id}/ws-messages")` with the same
       `X-Webhook-Secret` check as `complete` (`:85-96`, `secretMatches` at `:98-99`), body
       `WsMessagesBatchDto(List<WsMessage> messages, Boolean closed, Integer closeCode)` in
       `BC/adapter/in/web/dto/`; 401 / 404 / 204.
     - `CallsController`: `@GetMapping("/calls/{id}/ws-messages")` with
       `@RequestParam(defaultValue = "0") int offset, @RequestParam(defaultValue = "200") int limit`
       → 200 page or 404.
  7. Push: `WebSocketCallNotificationAdapter` (`BC/adapter/out/websocket/`) implements
     `notifyWsMessagesAppended(callId)` as
     `handler.broadcast(objectMapper.writeValueAsString(Map.of("type", "ws-messages-appended", "callId", callId)))`.
  8. Run `mvn -B -q -pl backend-calls -am test`; T118 steps 1-3 and 5 pass.

- [ ] T120 [US9] Implement message storage in backend-internal-calls.
  1. Copy `WsMessage` and `WsMessagesPage` into `BIC/domain/model/` (slices share no code),
     the two use cases into `BIC/application/port/in/`, the two default port methods into
     `BIC/application/port/out/CallLogPort.java`, and `notifyWsMessagesAppended` into its
     `CallNotificationPort`. `InternalCallsService` implements the use cases exactly as in
     T119 step 2.
  2. Create `BIC/adapter/out/filelog/InternalWsMessagesFileAdapter.java` (`@Component`), the
     same design as `FileWsMessagesStore` (T119 step 5) with:
     - `@Value("${INTERNAL_WS_MESSAGES_FILE:/appdata/internal-ws-messages.log}")` and
       `@Value("${alfred.internal-calls.ws-max-messages:1000}")`;
     - `compact(Set<String> retainedCallIds)` public, called by `InternalCallsFileLogAdapter`.
  3. `InternalCallsFileLogAdapter`: inject `InternalWsMessagesFileAdapter`; implement
     `appendWsMessages` (false when the id is neither in the retained lines nor in `pendingById`,
     else delegate) and `wsMessages` (empty when the call is unknown); in `save` (`:170-201`),
     when the ring was trimmed (`next.size() > retentionRows` branch), call
     `wsMessages.compact(<ids of next>)`; in `deleteAll` (`:437-446`), call its `clear()`.
  4. Routes on `InternalCallsWebhookController` (`/internal-calls/webhook/{id}/ws-messages`,
     same secret check, `:77-78`) and `InternalCallsController`
     (`/internal-calls/{id}/ws-messages`), as in T119 step 6.
  5. Push from `InternalWebSocketCallNotificationAdapter` on `/ws/internal-calls`, as in T119
     step 7.
  6. Run `mvn -B -q -pl backend-internal-calls -am test`, then the whole reactor and the boot
     check (T131 steps 3-4).

### Frontend

- [ ] T121 [US9] Show the messages on the call card.
  1. Create `FE/core/models/ws-message.model.ts`:
     ```ts
     export interface WsMessage {
       readonly seq: number;
       readonly direction: 'client' | 'server';
       readonly tsMillis: number;
       readonly type: 'text' | 'binary';
       readonly content?: string;
       readonly contentBase64?: string;
       readonly originalContent?: string;
       readonly action?: string;
       readonly ruleId?: string;
       readonly ruleName?: string;
     }

     export interface WsMessagesPage {
       readonly messages: readonly WsMessage[];
       readonly total: number;
       readonly dropped: number;
     }

     export interface WsMessagesAppendedEvent {
       readonly type: 'ws-messages-appended';
       readonly callId: string;
     }
     ```
     Add `WsMessagesAppendedEvent` to the `CallsWsMessage` and `InternalCallsWsMessage` unions
     in `FE/core/models/call.model.ts` (`:147`, `:166`).
  2. `FE/core/services/calls-api.service.ts`: add
     ```ts
     getWsMessages(callId: string, source: CallEndpointSource = 'external', offset = 0, limit = 200): Observable<WsMessagesPage> {
       const params = new HttpParams().set('offset', offset).set('limit', limit);
       return this.http.get<WsMessagesPage>(`${this.config.backendUrl}/${endpointFor(source)}/${callId}/ws-messages`, { params });
     }

     /** Every recorded message of one call, in order - for exports. At most the per-connection cap (1,000) = 2 pages. */
     getAllWsMessages(callId: string, source: CallEndpointSource = 'external'): Observable<WsMessagesPage> {
       return this.getWsMessages(callId, source, 0, 500).pipe(
         switchMap((first) =>
           first.total <= first.messages.length
             ? of(first)
             : this.getWsMessages(callId, source, 500, 500).pipe(
                 map((second) => ({ ...first, messages: [...first.messages, ...second.messages] }))
               )
         )
       );
     }
     ```
  3. Create `FE/components/ws-messages/ws-messages.component.{ts,html}` (standalone, signals,
     `selector: 'app-ws-messages'`), inputs `callId` and `source`, following
     `mockups/ws-messages-mock.html`:
     - loads page 0 (limit 200) on init; a "Load more" button loads the next page (no timer);
     - public `reload()` re-fetches the pages already loaded;
     - each row: an arrow (`→` client, `←` server), the time (`HH:mm:ss.SSS` from `tsMillis`),
       the type, the content (text, or `binary · N bytes`), and a badge for `action`
       (`edited`, `dropped`, `delayed 2000 ms`) whose tooltip names the rule; an edited row has a
       "show original" toggle that reveals `originalContent`;
     - when `dropped > 0`, a first line "N earlier messages were not recorded (cap 1,000 per connection)";
     - render at most the loaded messages (paging is the windowing); long content wraps and is
       never cut.
  4. `FE/core/state/calls-state.service.ts` `handleWsMessage` (`:249-266`): change the first
     branch to
     ```ts
     if ('type' in message && message.type === 'ws-messages-appended') {
       this.wsMessagesAppended.next(message.callId);
       return;
     }
     if (!('call' in message)) {
       this.liveCalls.set([]);
       this.view.refresh();
       return;
     }
     ```
     with `readonly wsMessagesAppended = new Subject<string>();` on the service. Only
     `CallsStateService` receives socket events; the session-cycle page does not need this.
  5. `FE/components/call-card/call-card.component.{ts,html}`:
     - `readonly isWebSocket = computed(() => this.call().response?.status === 101);`
     - in the badge row (after the method badge), `@if (isWebSocket()) { <span class="badge ws-badge">WebSocket</span> }`;
     - in the expanded card, after `<ng-container [ngTemplateOutlet]="blocksStrip" />` (`:338`),
       a toggle chip "Messages" styled like the block chips; when opened, render
       `<app-ws-messages #wsList [callId]="call().id" [source]="call().source ?? 'external'" />`
       (created only when opened, so nothing loads until then);
     - subscribe (in the constructor, `takeUntilDestroyed`) to `wsMessagesAppended` when the
       injected `CALL_LIST_CONTROLS_STATE` is a `CallsStateService` (inject
       `CallsStateService` with `{ optional: true }`); when the id equals `call().id` and the
       messages panel is open, call `wsList.reload()` (use `viewChild('wsList')`).
     - add `.ws-badge` next to `.intercept-badge` in `FE/styles.scss`.
  6. Spec `FE/components/ws-messages/ws-messages.component.spec.ts`: loads page 0 once; "load
     more" requests offset 200; `dropped: 3` shows the "3 earlier messages" line; an edited row
     shows its original after the toggle. And a spec in `calls-state.service.spec.ts`: a
     `ws-messages-appended` socket message does NOT clear `liveCalls`.

- [ ] T122 [US9] Add messages to the calls exports (never truncated).
  1. `FE/core/models/call.model.ts` `CallRecord`: add `readonly wsMessages?: WsMessagesPage | null;`.
  2. Hydration: every place that hydrates calls for an export also fetches messages for
     status-101 calls:
     - `FE/components/bulk-actions-bar/bulk-actions-bar.component.ts` `hydrateAll` (`:173-176`);
     - `FE/components/call-actions/call-actions.component.ts` `hydrated` (`:105-107`).
     Pattern: after merging the detail, `call.response?.status === 101 ? callsApi.getAllWsMessages(call.id, call.source).pipe(map((page) => ({ ...merged, wsMessages: page })), catchError(() => of(merged))) : of(merged)`.
     (Session-cycle exports are out of scope: cycles do not capture messages.)
  3. `FE/shared/utils/bulk-json-builder.ts`: add `wsMessages?: WsMessagesPage` to
     `BulkExportCallEvent` (`:45-82`) and, in `eventsForCall` (`:237-292`), set
     `wsMessages: call.wsMessages ?? undefined` next to `interception` on the call event
     (`:254-256`) — and on the split request event (`:277-279`), since that is the event that
     carries the request side of a split call.
  4. `FE/shared/utils/import-parser.ts`: add `wsMessages?: WsMessagesPage` to `Partial_`
     (`:17-34`); in `fill` (`:186-225`), next to the interception block (`:210-213`):
     ```ts
     const ws = raw['wsMessages'];
     if (ws && typeof ws === 'object' && Array.isArray((ws as WsMessagesPage).messages)) {
       set('wsMessages', ws as WsMessagesPage);
     }
     ```
     and pass `wsMessages: partial.wsMessages` in `mergeEvents` (`:175`).
  5. `FE/shared/utils/markdown-builder.ts`: add `wsMessagesSection(call, level)` next to
     `interceptionSection` (`:169-184`): heading `` `${hashes} 🔌 WebSocket messages (${n}${dropped ? `, ${dropped} earlier not recorded` : ''})` ``,
     then one line per message
     `` `${seq} ${arrow} ${iso time} ${type}${action ? ` [${action}]` : ''}` `` followed by
     `codeBlock('', content ?? contentBase64 ?? '', [])` (`codeBlock` at `:129` never
     truncates); when edited, a second `codeBlock` labelled "original". Call it after the
     response interception section in the single export (`:267`) and in `renderBlockBody`
     (`:514`).
  6. `FE/shared/utils/html-builder.ts`: `wsMessagesPartHtml(call, idPrefix)` next to
     `interceptionPartHtml` (`:702-725`), rendering the same content with `<pre>` blocks
     (escape with the builder's existing escape helper); call it from `responsePartHtml` (`:773`).
  7. Specs:
     - `import-parser.spec.ts`: a round trip through `roundTrip(calls)` (`:42`) keeps
       `wsMessages` deep-equal;
     - `markdown-builder.spec.ts` and `html-builder.spec.ts`: a call with one 50,000-character
       text message → the output contains the whole content (copy the guard at
       `markdown-builder.spec.ts:591-625`);
     - `bulk-json-builder.spec.ts`: `wsMessages` on the call event.

- [ ] T123 [US9] Add the Messages lane to the rule editor.
  1. `FE/core/models/interception.model.ts`:
     - `ActionType`: add `| 'REPLACE_IN_MESSAGE' | 'DROP_MESSAGE' | 'DELAY_MESSAGE'` at the end;
     - `ACTION_LABELS`: `REPLACE_IN_MESSAGE: 'Find & replace in a message'`,
       `DROP_MESSAGE: 'Drop a message'`, `DELAY_MESSAGE: 'Delay each message'`;
     - `describeAction`: `REPLACE_IN_MESSAGE` like the body replace case but "In
       <direction> messages, replace …"; `DROP_MESSAGE` →
       `` `Drop ${dir} messages${action.contains ? ` containing "${action.contains}"` : ''}` ``;
       `DELAY_MESSAGE` → `` `Delay ${dir} messages ${ms.toLocaleString()} ms` `` where `dir` is
       `client`, `server` or `all` for `both`.
  2. `FE/components/rule-editor/rule-editor.component.ts`:
     - `TOP_MESSAGE_LIST = 'top:message'` beside `TOP_REQUEST_LIST` (`:198-199`); `laneListId`
       (`:201-203`) returns it for `'message'`; `onActionDropped` (`:618`, phase at `:628`) maps
       it to `'message'`; add it to `dropListIds()`;
     - `messageActionTypes` like `requestActionTypes` (`:379-388`) with `t.phase === 'message'`;
     - `messageSteps` like `requestSteps` (`:408-418`) with `actionPhase(...) === 'message'`;
     - `phaseOf` (`:910-912`) returns `'Messages'` for `'message'`;
     - `nestableTypes(path)` (`:757-763`) must never offer message types inside a condition;
     - `defaultsFor`: `REPLACE_IN_MESSAGE` → `{ type, messageDirection: 'server', pattern: '', replacement: '', regex: false, caseSensitive: true }`;
       `DROP_MESSAGE` → `{ type, messageDirection: 'both', contains: '' }`;
       `DELAY_MESSAGE` → `{ type, messageDirection: 'both', durationMs: 1000 }`;
     - `isBodyReplace` also returns true for `REPLACE_IN_MESSAGE` (reuses the pattern fields);
       `isDelay` also for `DELAY_MESSAGE`;
     - `readonly messageDirectionOptions: readonly SelectOption[] = [{value:'client',label:'client → server'},{value:'server',label:'server → client'},{value:'both',label:'both'}];`
       and `onDirection(path, value)` → `patchAt(path, { messageDirection: value as 'client' | 'server' | 'both' })`;
       `isMessageAction(type)` → `actionPhase(type) === 'message'`.
  3. `rule-editor.component.html`: after the response lane closes (`:212`, before the
     `</div>` of `.pipeline` at `:213`), add a third lane copied from the response lane
     (`:190-212`) with head `3 Messages — each WebSocket message after the handshake`,
     `laneListId('message')`, `messageSteps()`, `messageActionTypes()`, and an `@empty` text
     "No message actions. They apply to WebSocket connections this rule matches."
     Show the lane only when `messageActionTypes().length > 0`.
  4. `rule-action-card.component.html`: for `editor.isMessageAction(step.action.type)` add a
     direction select (`app-select-picker` with `messageDirectionOptions`, `onDirection`) at the
     top of the fields; for `DROP_MESSAGE` a text input bound to `contains` (`onText(path, 'contains', $event)` —
     `contains` is already in `onText`'s union) with the hint "Leave empty to drop every message
     in that direction.".
  5. `FE/shared/utils/interception-help.ts`: three entries (codes = keys, `what` over 40
     characters), e.g. `DELAY_MESSAGE`: "Holds each WebSocket message in the chosen direction for
     the given time before passing it on. Only that connection waits - other connections, and
     the rest of the proxy, carry on.", with an example and a warning that a delay over the
     client's heartbeat interval may make it reconnect.
  6. Specs: `rule-editor.component.spec.ts` — a rule with a `DELAY_MESSAGE` lands in
     `messageSteps()` and not in the other two; `nestableTypes` of a condition path contains no
     message type. Run the frontend tests and build.

---

## Phase 13: User Story 10 — Edit HTTP trailers (P4)

**Independent Test**: quickstart check 11.

mitmproxy exposes trailers as `message.trailers`: a `Headers` object, or `None` when the
message has none. Research R6: set replaces or adds, remove deletes, and a message with no
trailers is never given any (that would need chunked encoding).

- [ ] T124 [P] [US10] Add proxy tests in `PX/test_interception.py`.
  1. `FakeMessage.__init__` (around line 85): add a parameter `trailers=None` and set
     `self.trailers = None if trailers is None else FakeHeaders(trailers)`. Every existing call
     site keeps working because the parameter is optional.
  2. `EveryActionIsCoveredTest.flow()` builds `FakeRequest(...)` and `CodecMessage(...)`. After
     it builds them, set `request.trailers = FakeHeaders({'x-checksum': 'a'})` on the request
     and, for the response phase, `response.trailers = FakeHeaders({'x-checksum': 'a'})`, so the
     remove samples have something to remove. (Build the objects into local variables first,
     then return `FakeFlow(request, response)`.)
  3. Add to `SAMPLES`:
     ```python
     'SET_REQUEST_TRAILER': {'type': 'SET_REQUEST_TRAILER', 'name': 'x-checksum', 'value': 'b'},
     'REMOVE_REQUEST_TRAILER': {'type': 'REMOVE_REQUEST_TRAILER', 'name': 'x-checksum'},
     'SET_RESPONSE_TRAILER': {'type': 'SET_RESPONSE_TRAILER', 'name': 'x-checksum', 'value': 'b'},
     'REMOVE_RESPONSE_TRAILER': {'type': 'REMOVE_RESPONSE_TRAILER', 'name': 'x-checksum'},
     ```
     The snapshot does not include trailers, so the coverage test cannot see a trailer change.
     Add all four keys to `NO_CHANGE` with the reason
     `'trailers are not part of the before/after snapshot'`.
  4. Add a class `TrailerTest(unittest.TestCase)` at the end of the file (before
     `if __name__ == '__main__':`), with `setUp` (tempdir) and an `engine(action)` helper like
     `CacheAndCompressionTest`. Tests:
     - `test_setting_a_request_trailer_replaces_it`: request with
       `trailers={'x-checksum': 'a', 'x-other': '1'}`; after SET, `request.trailers['x-checksum'] == 'b'`,
       `request.trailers['x-other'] == '1'`, detail `'x-checksum=b'`;
     - `test_removing_a_response_trailer`: response with `trailers={'x-checksum': 'a'}`; after
       REMOVE, `'x-checksum' not in response.trailers`, detail `'x-checksum'`;
     - `test_a_message_with_no_trailers_is_never_given_any`: SET on a request with
       `trailers=None`; `request.trailers is None` and the detail is `'skipped - no trailers'`;
     - `test_removing_a_trailer_that_is_not_there_is_recorded`: detail
       `'skipped - no such trailer'`;
     - `test_a_secret_trailer_value_is_not_recorded`: SET `authorization` to `s3cret`; the
       detail does not contain `s3cret`.
     `FakeRequest` passes its keyword arguments to `FakeMessage.__init__` only for `text` and
     `headers`, so set `request.trailers = FakeHeaders({...})` after constructing it.

- [ ] T125 [US10] Add the actions to the backend and the proxy.
  1. `BI/domain/model/ActionType.java`: add `SET_REQUEST_TRAILER(Phase.REQUEST),` and
     `REMOVE_REQUEST_TRAILER(Phase.REQUEST),` after `DISABLE_COMPRESSION`, and
     `SET_RESPONSE_TRAILER(Phase.RESPONSE),` and `REMOVE_RESPONSE_TRAILER(Phase.RESPONSE),`
     after `SET_RESPONSE_ENCODING`, with one javadoc above the request pair:
     `/** Sets or removes one HTTP trailer. A message that has no trailers is left without any. */`.
  2. `BI/domain/model/RuleValidator.java`, in `validateAction`'s switch, before the `default`:
     ```java
     case SET_REQUEST_TRAILER, SET_RESPONSE_TRAILER -> {
         requireName(action, problems);
         if (action.value() == null) {
             problems.add(action.type() + " needs a value.");
         }
     }
     case REMOVE_REQUEST_TRAILER, REMOVE_RESPONSE_TRAILER -> requireName(action, problems);
     ```
  3. `BIT/domain/RuleValidatorTest.java`: add `trailerActionsNeedANameAndSetNeedsAValue()`,
     using `problemsOf(Map.of(...))`: set with name and value gives none; set without a value
     gives `"needs a value"`; remove without a name gives `"needs a name"`.
  4. `PX/interception.py`:
     - `REQUEST_ACTIONS`: add `'SET_REQUEST_TRAILER', 'REMOVE_REQUEST_TRAILER'`;
       `RESPONSE_ACTIONS`: add `'SET_RESPONSE_TRAILER', 'REMOVE_RESPONSE_TRAILER'`;
     - add this module-level function directly above `def _positive_int(value):`:
       ```python
       def _edit_trailer(message, rule, action, kind, verdict):
           """SET_*_TRAILER / REMOVE_*_TRAILER. A message without trailers is never given any:
           adding them would need chunked encoding for a gain nobody has asked for (research R6)."""
           name = str(action.get('name') or '').strip()
           if not name:
               verdict.skip(rule, kind, 'no trailer name')
               return
           trailers = getattr(message, 'trailers', None)
           if trailers is None:
               verdict.skip(rule, kind, 'no trailers')
               return
           if kind.startswith('REMOVE_'):
               if name not in trailers:
                   verdict.skip(rule, kind, 'no such trailer')
                   return
               del trailers[name]
               verdict.record(rule, kind, name)
               return
           value = str(action.get('value', ''))
           trailers[name] = value
           verdict.record(rule, kind, verdict.named(name, value))
       ```
     - in `_apply_request_action`, before the `if kind == 'SET_METHOD':` block:
       ```python
       if kind in ('SET_REQUEST_TRAILER', 'REMOVE_REQUEST_TRAILER'):
           _edit_trailer(request, rule, action, kind, verdict)
           return
       ```
     - in `_apply_response_action`, before `if kind == 'SET_RESPONSE_BODY':`:
       ```python
       if kind in ('SET_RESPONSE_TRAILER', 'REMOVE_RESPONSE_TRAILER'):
           _edit_trailer(response, rule, action, kind, verdict)
           return
       ```
  5. Run the proxy tests and the backend-interception tests (commands in T092 and T093).

- [ ] T126 [US10] Add the frontend part.
  1. `FE/core/models/interception.model.ts`:
     - `ActionType`: add `| 'SET_REQUEST_TRAILER' | 'REMOVE_REQUEST_TRAILER'` after
       `| 'DISABLE_COMPRESSION'`, and `| 'SET_RESPONSE_TRAILER' | 'REMOVE_RESPONSE_TRAILER'` after
       `| 'SET_RESPONSE_ENCODING'`;
     - `ACTION_LABELS`: `SET_REQUEST_TRAILER: 'Set request trailer'`,
       `REMOVE_REQUEST_TRAILER: 'Remove request trailer'`,
       `SET_RESPONSE_TRAILER: 'Set response trailer'`,
       `REMOVE_RESPONSE_TRAILER: 'Remove response trailer'`;
     - `describeAction`: add the four types to the existing group that returns
       `` `${label} ${action.name}` `` (the `SET_REQUEST_HEADER` / `REMOVE_REQUEST_HEADER` cases).
  2. `FE/components/rule-editor/rule-editor.component.ts`:
     - `isHeaderSet`: add `type === 'SET_REQUEST_TRAILER' || type === 'SET_RESPONSE_TRAILER'`;
     - `isNameOnly`: add `type === 'REMOVE_REQUEST_TRAILER' || type === 'REMOVE_RESPONSE_TRAILER'`;
     - `nameLabel`: add `if (type.endsWith('_TRAILER')) return 'Trailer';` before the final return;
     - `defaultsFor`: `case 'SET_REQUEST_TRAILER': case 'SET_RESPONSE_TRAILER': return { type, name: '', value: '' };`
       and `case 'REMOVE_REQUEST_TRAILER': case 'REMOVE_RESPONSE_TRAILER': return { type, name: '' };`.
  3. `FE/shared/utils/interception-help.ts`: four entries (codes equal to their keys, `what`
     over 40 characters). Request pair, e.g. SET_REQUEST_TRAILER: "Changes or adds one trailer -
     a header sent after the body, used by gRPC and chunked uploads for checksums and status - on
     a request that already carries trailers." Example
     `{ from: 'x-checksum = abc', to: 'the trailer arrives with the new value' }`; warning
     "A message sent without trailers is left without them - adding trailers would need chunked
     encoding." Mirror the wording for the other three.
  4. Run the frontend tests and build (commands in T096 step 9). The help spec
     (`interception-help.spec.ts`) fails until every new action has an entry.

---

## Phase 14: Polish and cross-cutting

Documentation style in this repo: plain prose, bold-lead paragraphs, reasons given ("because
…"), no marketing words. Measured results are written as a capitalised sentence starting
"Measured …:", as at `docs/interception.md:217-218` and `:318-319`. Do not rewrite sections
this task does not name.

- [ ] T127 [P] Update `docs/interception.md` (1,059 lines; headings at: 60 `## Matchers`,
  90 `## Actions`, 110 `### Where the explanations live`, 745 `## API`, 775 `## Logging
  integration`, 817 `### Before and after`, 967 `## Safety`, 997 `## Tests`, 1014 `### Adding an
  action`, 1038 `### Adding a matcher`, 1046 `## Intentionally left for later`). Line numbers
  move as you edit; work from the bottom of the file up so earlier anchors stay valid.
  1. **Intentionally left for later (1046-1059)**:
     - delete the bullet at 1057-1059 (`backend-internal-calls stores no interception record
       yet …`): inbound calls now carry the record;
     - replace the bullet at 1049 (`Header / body / query matchers …`) with
       `- **Body matchers** and response-status matching. Header, query and cookie match tests exist (see [Matchers](#matchers)); a body matcher would invite an expression grammar.`;
     - add `- **WebSocket messages in session cycles.** A cycle captures the handshake call only; its messages stay in the live log.`
  2. **Adding a matcher (1038)**: add one sentence at the end: `A header, query or cookie test is a `MatchTest` in one of `RuleMatch`'s three lists, evaluated after the cheap checks in `Match.matches` - add an operator to `MatchTest.Operator`, `_MatchTest.OPERATORS` and `MATCH_TEST_OPERATOR_LABELS` together.`
  3. **Adding an action (1016-1036)**: replace step 1's last sentence and add three steps, so
     the list reads (keep the existing wording of steps 2-8, renumber after inserting):
     - step 1 gains: `The phase and terminal flags reach the frontend through GET /interception/action-types, so the editor's lane and "ends the request" badge follow the enum - do not add a name-based rule in the frontend.`;
     - new step after step 2: `The validator's switch ends in a `default` case that reports "Unknown action type", so a constant with no case fails RuleValidatorTest instead of saving unvalidated.`;
     - new step after step 3: `If the action records a header, cookie or query value, go through `verdict.named(name, value)` or `mask_value(value)` so a secret name keeps its value out of the record.`;
     - new step at the end: `If the action finds text, use `_Pattern` (literal by default, regex opt-in, run in the regex worker with its timeout) and validate the pattern with `PatternSafety` - never call `re` on a body in the event loop.`
  4. **Tests (997-1010)**: update the counts in the table rows to what the suites report after
     T131 (run them; do not guess). Row 1001 names `proxy/test_interception.py`; add a row
     `| `proxy/test_regex_worker.py` | the regex worker process: substitution, timeout, restart |`
     and, once US9 is done, `| `proxy/test_ws_messages.py` | WebSocket message batching |`.
  5. **Safety (967)**: append three bold-lead paragraphs:
     - `**Regex runs in a separate process.**` Explain: patterns are literal by default; regex is
       opt-in and checked at save by `PatternSafety` (length ≤ 500, no named groups, no
       lookbehind/possessive/atomic constructs, no nested quantifiers); at run time a regex
       substitution runs in `proxy/regex_worker.py`'s worker process with a
       `INTERCEPTION_REGEX_TIMEOUT_MS` (default 2000) budget, because Python's GIL means a thread
       could not be stopped; a timed-out match is recorded as `skipped - pattern timed out`, the
       body is left as it was, and the worker is restarted.
     - `**Secret values never enter the interception record.**` The names in
       `SensitiveHeaders.NAMES` (published in the snapshot as `sensitiveHeaders`) have their values
       replaced by `(value not logged · N chars)` in `applied[].detail` and in the before/after
       snapshots (`Verdict.as_log`); cookie values are always masked; the working snapshots are
       compared unmasked, so a secret swapped for one of the same length is still detected.
     - `**REWRITE_URL cannot target Alfred.**` The backend refuses a structured target in
       `SelfTargets` at save; the proxy re-checks a pattern rewrite's result at run time and
       records `refused - target … is Alfred itself`.
  6. **API (745)**: add rows or lines, in the section's existing format, for:
     `GET /interception/sensitive-headers`, `GET /interception/rules/export?ids=`,
     `POST /interception/answers` (multipart), `POST /interception/answers/from-call`,
     `GET /interception/answers/{id}`, `GET /interception/answers/{id}/body`, and `POST /resend`.
     Copy each route's request and response shape from
     `specs/001-interception-mitmproxy-parity/contracts/rest-api.md`.
  7. **Moving rules around (678)**: under `### Import` (710) add a paragraph: the rules file is
     version 2 when written by the backend's export; it embeds each stored answer a rule uses as
     `answers[]` (base64 body) referred to by `answerRef`; import gives each answer a fresh id and
     rewrites the refs; version 1 still imports; kept secrets travel in the file in plain text.
  8. **Actions (90-108)**: extend the table. Keep its two-column format
     (`| Request phase | Response phase |`, names in backticks joined by ` / `). Add rows:
     - `` `REPLACE_IN_REQUEST_BODY` `` | `` `REPLACE_IN_RESPONSE_BODY` ``
     - `` `REMOVE_REQUEST_JSON_FIELD` / `SET_REQUEST_BODY` `` | `` `REMOVE_RESPONSE_JSON_FIELD` ``
     - `` `REWRITE_URL` / `SET_METHOD` `` | (empty)
     - `` `SET_REQUEST_COOKIE` / `REMOVE_REQUEST_COOKIE` `` | `` `SET_RESPONSE_COOKIE` / `REMOVE_RESPONSE_COOKIE` ``
     - `` `SET_FORM_FIELD` / `REMOVE_FORM_FIELD` `` | `` `SET_RESPONSE_ENCODING` ``
     - `` `DISABLE_CACHE` / `DISABLE_COMPRESSION` `` | (empty)
     - `` `ANSWER_WITH_RECORDED_CALL`, `ANSWER_WITH_FILE` `` | `` `REPLACE_WITH_RECORDED_RESPONSE` ``
     - `` `SET_REQUEST_TRAILER` / `REMOVE_REQUEST_TRAILER` `` | `` `SET_RESPONSE_TRAILER` / `REMOVE_RESPONSE_TRAILER` ``

     Then add a sentence below the table: `A third lane, **Messages**, holds `REPLACE_IN_MESSAGE`, `DROP_MESSAGE` and `DELAY_MESSAGE`: they run once per WebSocket message after the handshake (ActionType.Phase.MESSAGE) and are not allowed inside a condition.` Then add three `###` subsections before `### Where the explanations live`:
     - `### Stored answers` - what a stored answer is (RECORDED from a logged call, FILE from an
       upload), the 10 MB per-answer cap and **no total cap** (an answer lives only as long as a
       rule uses it, so the total is bounded by the rules), the keep/strip question for secret
       headers (409 until answered; no default), publication as
       `proxy/interception/answers/<id>.meta.json` + `.body` written before `rules.json`, the
       UUID check that guards the file name, deletion when the last rule stops using it plus the
       1-hour sweep for answers nothing ever used, and `refreshDates`.
     - `### Find and replace` - literal by default, regex opt-in, case sensitivity, max
       replacements, `\1` group references, the worker timeout.
     - `### Resend` - the "Resend…" action, the `X-Alfred-Resend-Of` / `X-Alfred-Resend-Edits`
       headers the backend adds and the proxies strip (honoured only from the backend's own
       address), rules applying to the resent call, and "resend with current session" (newest
       cookie/authorization from the same host, reported by name and source call only).
  9. **Matchers (60)**: add a paragraph on match tests - header / query / cookie, operators
     EXISTS, NOT_EXISTS, EQUALS, CONTAINS, MATCHES, all must hold, evaluated after direction,
     project, method, host and path so a call those rule out never has its headers read, and the
     precedence note: a failed test means the rule did not match, so its `stopProcessing` does not
     fire (the reason to prefer a match test over a condition when stop processing is on).
  10. **Logging integration (775)**: add a short paragraph: inbound calls now carry the
      interception record too (`backend-internal-calls`' `CallRecord.interception`), and the
      .md/.html/.json exports render it under "Changed by Alfred"; the import parser reads it back.

- [ ] T128 [P] Update `docs/architecture.md` (66 lines, one heading; everything after is a
  module-list code block at lines 5-28 and bold-lead paragraphs).
  1. In the module-list code block, after the `backend-interception` entry (lines 20-24), add
     an entry aligned the same way (26-character name column):
     ```
     backend-resend            resends a logged call through the proxy it first went through, with optional
                               edits. Leaf slice: reads calls and session values only through its own out-ports
                               (CallSourcePort, SessionValueLookupPort), which backend-app's resendbridge implements.
     ```
     Also append to the `backend-interception` entry: `Stored answers (the responses a rule can answer with) live here too, in interception.db.`
  2. Change the `backend-app` entry (lines 25-26) to also list `the interceptionbridge
     (RecordedCallLookupAdapter) and resendbridge (CallSourceAdapter, SessionValueLookupAdapter)
     packages`.
  3. Line 30 (isolation rules): add `, and `resend` is isolated from every slice` inside the
     parenthesis that already says `interception` is isolated.
  4. Add a bold-lead paragraph after the `**Adding a slice:**` paragraph (line 34):
     `**Cross-slice reads go through a bridge in backend-app.**` Explain: a slice that needs data
     another slice owns declares an out-port in its own `application/port/out`, and backend-app
     implements it by calling the other slice's in-port use case - as `CallFilterAdapter`,
     `RecordedCallLookupAdapter`, `CallSourceAdapter` and `SessionValueLookupAdapter` do - so no
     slice imports another.
  5. Add a bold-lead paragraph after the ring-buffers paragraph (line 48):
     `**WebSocket messages are capped per call.**` Describe the `call_ws_message` table (SQLite)
     and the sibling NDJSON files (file mode, inbound), the per-call cap
     (`alfred.calls.ws-max-messages`, default 1,000) with the lowest `seq` dropped and counted in
     `ws_dropped`, and that compaction drops the messages of calls the call log has evicted.
  6. Add one sentence to the summary/detail paragraph (line 58): `FindRecentRequestHeadersUseCase reads at most the newest 200 rows for one host and joins only their request headers, never bodies - it backs "resend with current session", which must stay cheap however large the log is.`
  7. Add one sentence to the paragraph on `CallRecord.id` (line 60) or right after it: `Inbound calls carry the same `interception` record as outbound ones, written by the completion webhook.`

- [ ] T129 [P] Update `docs/frontend-architecture.md` and `docs/supplier-integrations.md`.
  1. `docs/frontend-architecture.md` (100 lines, bold-lead paragraphs):
     - fix line 47 (`**Four top-level routes/tabs**`) to five, naming Interception, and remove
       the contradiction at line 54 (json-view is a sixth, auxiliary route);
     - after the Interception paragraph (line 45), add bold-lead paragraphs:
       `**Action lanes and terminal badges come from the backend.**` (the registry filled from
       `GET /interception/action-types` by `InterceptionStateService`, `registerActionTypes`,
       `actionPhase`/`isTerminalAction` falling back to name rules only until it loads);
       `**The answer picker.**` (`components/answer-picker`: searches calls on demand, never on a
       timer; copies on pick; the 409 keep/strip prompt; the upload mode);
       `**The resend dialog.**` (`components/resend-dialog`, opened by `ResendDialogService`
       like `ExportDialogService`; bulk resend is sequential);
       `**WebSocket messages.**` (`components/ws-messages`, a windowed list loaded on expand and
       re-fetched only for an open panel on `ws-messages-appended`);
       `**Secret names come from the backend.**` (`sensitiveNames` from
       `GET /interception/sensitive-headers`; null until loaded, which masks every value).
  2. `docs/supplier-integrations.md` (38 lines):
     - line 20 (`**Neither addon rewrites a flow's destination.**`) is no longer true: rewrite it
       to say the addons do not route on their own, but a `REWRITE_URL` interception rule can
       change a flow's destination, and never to Alfred itself;
     - after line 24 add bullets: the `X-Alfred-Resend-Of` / `X-Alfred-Resend-Edits` headers
       (read only when the peer is the backend, always removed before rules run); the resend path
       (the backend sends through `proxy:<internalPort>` for outbound, trusting the mitmproxy CA
       mounted from `./proxy/certs`, and `reverse-proxy:<listenPort>` for inbound); the WebSocket
       hooks (`websocket_start`, `websocket_message`, `websocket_end`) and the batching in
       `proxy/ws_messages.py`; `proxy/regex_worker.py`, the regex worker process both addons
       mount.

- [ ] T130 [P] Update `CLAUDE.md`, `AGENTS.md` and the feature request.
  1. `CLAUDE.md` line 7: add Interception to the tab list ("five tabs: Live Calls …, Session
     Cycles, Interception, Profiles, Settings") and "interception rules and stored answers" to
     what the backend owns. Line 43 (the interception paragraph): append two sentences: `Regex find/replace runs in a separate worker process with a timeout (proxy/regex_worker.py), never in the event loop. Stored answers are published beside rules.json as answers/<id>.meta.json + .body, and an answer id must be a UUID before it becomes a file name.`
  2. `AGENTS.md`:
     - in the backend modules table (lines 40-51), add rows before `backend-app`:
       `| `backend-interception` | Interception rules, breakpoints and stored answers; publishes the snapshot the proxies read |`
       and `| `backend-resend` | Resends a logged call through the proxy, with edits |`;
     - change the `backend-app` row to mention the `filtering`, `interceptionbridge` and
       `resendbridge` bridge packages;
     - line 53 (isolation rules): add that `interception` and `resend` are isolated from every
       slice;
     - line 57: add Interception to the routes;
     - in the services table (27-34) add an `app-gateway` row (nginx, host port 3000, routes the
       backend prefixes and `/ws/` to `backend:5000`, the rest to `frontend:80`; a new backend
       prefix must be added to its regex in `gateway/nginx.conf`);
     - in the deeper-docs list (85-92) add `docs/interception.md`.
  3. `docs/feature-requests/interception-mitmproxy-parity.md`: insert after line 1 a blank line
     and `> **Superseded** by specs/001-interception-mitmproxy-parity/ (spec.md, plan.md, tasks.md). Kept as the original input; do not edit it to match the implementation.`

- [ ] T131 Run every suite and fix what fails.
  1. Proxy: `cd proxy && python -m unittest discover -s . -p "test_*.py"`.
  2. Proxy in the real image (catches differences between the fakes and mitmproxy):
     `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/scripts" -w /scripts --entrypoint python3 mitmproxy/mitmproxy:latest -m unittest discover -s . -p "test_*.py"`
     from `proxy/`.
  3. Backend, whole reactor including ArchUnit:
     `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app" -v alfred-m2:/root/.m2 -w //app maven:3.9-eclipse-temurin-21 mvn -B -q test`
     from `backend/`. With `-q`, success prints nothing; count results with
     `cat */target/surefire-reports/*.xml | grep -o '<testsuite [^>]*' | sed -E 's/.*tests="([0-9]+)".*errors="([0-9]+)".*failures="([0-9]+)".*/\1 \2 \3/' | awk '{t+=$1;e+=$2;f+=$3} END {print t, e, f}'`.
     One `ERROR … SqliteCallsRepository … retention target` log line is expected output of a
     test, not a failure.
  4. Backend boots (Spring wiring is not covered by any test, because no module has a
     `@SpringBootTest`): from `backend/`,
     `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app" -v alfred-m2:/root/.m2 -w //app maven:3.9-eclipse-temurin-21 sh -c 'mvn -B -q -pl backend-app -am package -DskipTests >/dev/null 2>&1; mkdir -p /appdata; (timeout 90 java -jar backend-app/target/*.jar > /tmp/boot.log 2>&1 &); for i in $(seq 1 80); do sleep 1; grep -q "Started BackendApplication\|APPLICATION FAILED" /tmp/boot.log && break; done; grep -E "Started BackendApplication|APPLICATION FAILED|required a bean" -A3 /tmp/boot.log'`.
     It must print `Started BackendApplication`.
  5. Frontend: `cd frontend && npx ng test --watch=false --browsers=ChromeHeadless`, then
     `npx ng build`. The "bundle initial exceeded maximum budget" warning is pre-existing; any
     `ERROR` is not.
  6. Fix each failure in the code under test, not by weakening the test. Record the final counts
     for T127 step 4.

- [ ] T132 Run the live checks. **This rebuilds and restarts the user's running Docker stack:
  ask the user first and wait for an explicit yes.**
  1. `docker compose up -d --build backend proxy reverse-proxy frontend`, then
     `docker compose restart app-gateway` (the gateway otherwise keeps the old backend IP and
     returns 502).
  2. Run `specs/001-interception-mitmproxy-parity/quickstart.md` checks 1-13 in order, each as
     written there. For each, note the observed result next to the expected one.
  3. Write each measured result into `docs/interception.md` in the section about that feature,
     as a sentence starting "Measured …:" (for example `Measured on a 5 MB fixture: served
     byte-exact in 31 ms.`). Numbers must be what was observed; if a check could not be run
     (for example no HTTP/2 echo endpoint for check 11), say so in the final report instead of
     writing a number.
  4. Report every check that did not match its expected result to the user, with the command
     and the output.

---

## Dependencies and execution order

- **T000 (mocks and approval)** comes before every task touching `FE/`. Backend and proxy tasks
  may start before it.
- **Setup (T001–T005)**, then **Foundational (T006–T029)**, then the user stories.
- **Within Foundational**:
  - T006 → T007 → T008;
  - T009 → T010 → T011 → T012 → T013 → T014;
  - T015–T021 can run in parallel with the proxy chain;
  - T022 → T023 → T024 → T026, with T025 and T027 in parallel;
  - T028 → T029.
- **User stories**:
  - US1, US2, US3, US4, US5 and US11 each depend on Foundational only, and are independent of
    each other. They all edit `ActionType.java`, `RuleAction.java`, `RuleValidator.java`,
    `interception.py`, `interception.model.ts` and `rule-action-card.component.html`, so
    **stories that touch the same file must be merged one at a time**.
  - US6 depends on Foundational.
  - **US7 depends on US6**: stored answers, the answer picker and `_AnswerCache`.
  - US8 depends on Foundational, and is independent of US1–US7. It shares the SQLite schema
    file with US9.
  - US9 depends on Foundational and on US1's `_Pattern` (T008 lives in Foundational, so this is
    satisfied).
  - US10 depends on Foundational.
  - Within US8: T097-T099 (call slices) come before T108-T109 (bridges); T102-T107 (the resend
    slice) can run alongside the call-slice work; T110-T113 (frontend) come last.
  - Within US9: T115 and T116 before T117; T118 before T119 and T120; T121 before T122.
- **Polish (T127–T132)** comes after every story that is in scope.

## Parallel opportunities

- Setup: T002, T003, T004 and T005 in parallel after T001.
- Foundational: the Java tasks T015–T021, the proxy chain T006–T014, the inbound slice
  T022–T027 and the frontend tasks T028–T029 are four parallel streams.
- In each story, every task marked [P] can start together. For example, for US1: T030, T031 and
  T037 in parallel, then T032 → T033, T034, then T035 → T036.
- Across stories: US8 (backend-resend, call slices, resend UI) can be built by a second
  developer alongside US1–US5, because it touches few of the same files.

## Implementation strategy

1. **MVP**: Setup, Foundational and US1. Validate quickstart checks 1–2, then demo.
2. **Complete P1**: US2 and US3 (checks 3–4).
3. **P2**: US4, US5 and US11 (checks 5, 6 and 12).
4. **P3**: US6, then US7 (checks 7–8); US8 (check 9).
5. **P4**: US9 and US10 (checks 10–11).
6. **Polish**: docs and the full live verification (T127–T132).

Each block ends green on all three suites before the next starts, as the plan's build order
requires.

**Gate**: T000 (the UI mocks, plus the user's explicit "start") must be complete before any
frontend task starts. This is required by the constitution's Development Workflow and by the
saved project preference.
