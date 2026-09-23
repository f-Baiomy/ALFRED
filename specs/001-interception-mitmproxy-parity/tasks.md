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

- [ ] T051 [P] [US4] Add tests to `PX/test_interception.py`:
  - `edit_cookie_header('session=a; consent=b; theme=c', 'consent', None)` returns
    `'session=a; theme=c'` exactly; set replaces a value; set appends a new cookie;
  - Set-Cookie set replaces the entry with the same name and keeps the others; remove; expire
    (`Max-Age=0`); attribute rendering;
  - forms: urlencoded set and remove; a multipart text field; a multipart file part left
    untouched; a JSON body records `skipped - not a form`;
  - no cookie value appears in any `detail`.

  Extend `FakeRequest` / `FakeHeaders` with `get_all`/`set_all`, `urlencoded_form` and
  `multipart_form`. Add SAMPLES entries for all six actions.
- [ ] T052 [P] [US4] Add `RuleValidatorTest` cases: a cookie name that is not a token is
  rejected; `sameSite=Foo` is rejected; `SameSite=None` without `secure` is rejected.
- [ ] T053 [US4] Create `BI/domain/model/CookieAttributes.java`, a record
  `(path, domain, Integer maxAge, Boolean secure, Boolean httpOnly, String sameSite)`. Add the
  RuleAction field `cookieAttributes`. Add six ActionTypes:
  - `SET_REQUEST_COOKIE`, `REMOVE_REQUEST_COOKIE`
  - `SET_RESPONSE_COOKIE`, `REMOVE_RESPONSE_COOKIE`
  - `SET_FORM_FIELD`, `REMOVE_FORM_FIELD`

  Add their validator cases.
- [ ] T054 [US4] In `PX/interception.py`, add `edit_cookie_header`, a token-level edit that
  preserves the separators and spacing of the other cookies, plus a `set_cookie_line` builder
  and handlers for all six actions. Form edits go through `request.urlencoded_form` /
  `request.multipart_form`; parts with a filename are skipped. The detail names the cookie or
  field and uses `mask_value` for the value.
- [ ] T055 [US4] Frontend: add the types, labels and `describeAction` cases, masking cookie
  values. Add card blocks:
  - a cookie name and value;
  - an attributes sub-block for SET_RESPONSE_COOKIE (path, domain, max-age, secure, http-only,
    same-site select);
  - a form field name and value.

  Add `defaultsFor` entries.
- [ ] T056 [P] [US4] Add help entries: expiring a session, dropping a consent cookie, changing a
  form `amount`.

---

## Phase 7: User Story 5 — Control caching and compression (P2)

**Independent Test**: quickstart check 6.

- [ ] T057 [P] [US5] Add tests to `PX/test_interception.py`:
  - DISABLE_CACHE records the header names it removed (`if-none-match, if-modified-since`), or
    `skipped - no conditional headers`;
  - DISABLE_COMPRESSION sets `accept-encoding: identity`;
  - SET_RESPONSE_ENCODING calls decode, then `encode(enc)` (the fake records the calls);
    `identity` only decodes; a body already in that encoding records a skip.

  Add SAMPLES entries.
- [ ] T058 [P] [US5] Add a `RuleValidatorTest` case: an encoding of `lzma` is rejected.
- [ ] T059 [US5] Add `DISABLE_CACHE`, `DISABLE_COMPRESSION` and `SET_RESPONSE_ENCODING` to
  `ActionType`. Add the RuleAction field `encoding`. The validator allows gzip, deflate, br,
  zstd and identity.
- [ ] T060 [US5] Add handlers in `PX/interception.py`. DISABLE_CACHE pops the headers explicitly
  so it can record their names; it does not call `anticache()`.
- [ ] T061 [US5] Frontend:
  - the DISABLE_* actions render through `isBare` with an explanatory else-text (card html
    :348-356);
  - SET_RESPONSE_ENCODING uses an `app-select-picker` with the five encodings;
  - add labels, `describeAction` cases and `defaultsFor` entries.
- [ ] T062 [P] [US5] Add help entries.

---

## Phase 8: User Story 11 — Match rules on headers, query parameters and cookies (P2)

**Independent Test**: quickstart check 12.

- [ ] T063 [P] [US11] Add tests to `MatchingTest` in `PX/test_interception.py`:
  - header EXISTS, NOT_EXISTS and EQUALS (case-insensitive name);
  - query EQUALS;
  - cookie CONTAINS;
  - MATCHES compiles once (patch `re.compile` and count the calls);
  - a rule with `stopProcessing` and a header test does not stop a later rule when the header
    is absent;
  - the tests are evaluated after a failing host check (assert the header was never read).
- [ ] T064 [P] [US11] Add `RuleValidatorTest` cases: a missing name; an EQUALS test without a
  value; a MATCHES test that fails `PatternSafety`.
- [ ] T065 [US11] Create `BI/domain/model/MatchTest.java`, a record
  `(String name, Operator operator, String value, Boolean caseSensitive)` with
  `enum Operator {EXISTS, NOT_EXISTS, EQUALS, CONTAINS, MATCHES}`. Add the `headers`, `query`
  and `cookies` lists to `BI/domain/model/RuleMatch.java`; the compact constructor turns null
  into `List.of()`. Extend `validateMatch` (`RuleValidator.java:98-120`).
- [ ] T066 [US11] In `PX/interception.py`:
  - `Match.__init__` parses the three lists and pre-compiles the MATCHES regexes;
  - change `matches` to `matches(self, source, service_name, request)`, evaluating the new
    tests after the existing checks;
  - update the caller `_matching` (:914-931) and the MatchingTest call sites.
- [ ] T067 [US11] Frontend:
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
- [ ] T068 [P] [US11] Add a `MATCH_TEST_HELP` entry in `FE/shared/utils/interception-help.ts`
  that explains the `stopProcessing` precedence advantage over conditions. Extend
  `interception-help.spec.ts` to require it.

---

## Phase 9: User Story 6 — Answer with a recorded call (P3)

**Goal**: the stored-answers foundation, which US7 re-uses, plus the recorded-call actions,
including inbound sources and the keep/strip prompt.

**Independent Test**: quickstart check 7.

### Tests first

- [ ] T069 [P] [US6] `BIT/application/service/StoredAnswersServiceTest.java`, with fake ports,
  covering:
  - a copy over the cap is refused with `limitBytes` and `sizeBytes`;
  - a response with `set-cookie` and no `keepSecrets` gives `SecretsDecisionRequired` with
    `secretNames`;
  - `keepSecrets=false` strips the headers, and the Set-Cookie cookies with them;
  - `keepSecrets=true` keeps them and records `secretsKept=true`;
  - no secrets gives `secretsKept=null`;
  - `retainReferenced` deletes unreferenced answers;
  - the orphan sweep deletes unreferenced answers older than 1 h and keeps newer ones.
- [ ] T070 [P] [US6] `BIT/adapter/out/sqlite/SqliteStoredAnswersStoreAdapterTest.java`, against
  a `@TempDir` DB file: save, find the metadata without the body, find the body, delete
  (cascade).
- [ ] T071 [P] [US6] Extend `BIT/adapter/out/rulesfile/FileRulesPublisherAdapterTest.java`:
  - answers are written as `answers/<id>.meta.json` and `.body`;
  - they are written before `rules.json`, checked by write order through a spy or by mtime;
  - unreferenced files are deleted.
- [ ] T072 [P] [US6] Add `RuleValidatorTest` cases: an `answerId` of `../rules` or
  `a/b`, rejected as not a UUID; an `answerId` that does not exist; a FILE
  answer used by ANSWER_WITH_RECORDED_CALL; two terminals (ANSWER_WITH_RECORDED_CALL plus
  MOCK_RESPONSE); SEND_TO_HOST plus ANSWER_WITH_RECORDED_CALL.
- [ ] T073 [P] [US6] Extend `BIT/application/service/InterceptionRulesServiceTest.java`: export
  version 2 embeds the answers with `answerRef`; importing version 2 creates new answer ids and
  rewrites the references; importing version 1 still works.
- [ ] T074 [P] [US6] In `PX/test_interception.py`, add `StoredAnswerTest`, using `_AnswerCache`
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

- [ ] T075 [US6] Create `BI/domain/model/StoredAnswer.java`, a record per data-model §4, with
  `enum Kind {RECORDED, FILE}`. Add `ANSWER_WITH_RECORDED_CALL(Phase.REQUEST)` and
  `REPLACE_WITH_RECORDED_RESPONSE(Phase.RESPONSE)` to `ActionType`, and add
  ANSWER_WITH_RECORDED_CALL to `isTerminal()` (:91-93). Add the RuleAction fields `answerId`
  and `refreshDates`.
- [ ] T076 [US6] Create the ports:
  - `BI/application/port/out/StoredAnswersStorePort.java`: `save(StoredAnswer, byte[])`,
    `findMeta(id)`, `findBody(id)`, `listMeta()`, `delete(id)`;
  - `BI/application/port/out/RecordedCallLookupPort.java`:
    `Optional<RecordedResponse> find(String direction, String callId, String cycleId)`, with a
    nested record `RecordedResponse(int status, Map<String,String> headers, byte[] body,
    String recordedAt)`;
  - `BI/application/port/in/ManageStoredAnswersUseCase.java`: `copyFromCall(...)`, which
    returns a sealed result `Created | SecretsDecisionRequired(List<String>) | NotFound |
    TooLarge(limit, size)`, plus `upload(...)` (used in US7), `get(id)` and `body(id)`.
- [ ] T077 [US6] Add the stored-answer tables (data-model §4) to the schema bootstrap of
  `BI/adapter/out/sqlite/SqliteInterceptionRulesRepository.java` (:74-88). Create
  `BI/adapter/out/sqlite/SqliteStoredAnswersStoreAdapter.java`, which re-uses that repository's
  pool through a package-private accessor, is annotated `@ConditionalOnProperty(prefix =
  "alfred.storage.interception", name = "type", havingValue = "sqlite", matchIfMissing = true)`,
  and never selects the body in `listMeta`.
- [ ] T078 [P] [US6] Create `BI/adapter/out/filestore/JsonFileStoredAnswersStoreAdapter.java`
  (`havingValue = "file"`). It keeps the metadata in
  `${INTERCEPTION_ANSWERS_DIR:/appdata/interception-answers}/index.json` and the bodies as
  `<id>.body`, and writes atomically with a temp file and a move.
- [ ] T079 [US6] Create `BI/application/service/StoredAnswersService.java`:
  - `@Value("${alfred.interception.max-answer-bytes}")`;
  - secret detection over `SensitiveHeaders.NAMES`;
  - a strip path;
  - `retainReferenced(Set<String> ids)`;
  - `@Scheduled(fixedDelay = 600_000)` orphan sweep with a 1 h grace period.

  In `InterceptionRulesService.persist` (:234-239), collect the answer ids of every rule, call
  `retainReferenced`, and then publish.
- [ ] T080 [US6] Change `RulesPublisherPort.publish` (`BI/application/port/out/RulesPublisherPort.java:28`) to
  `publish(boolean enabled, List<InterceptionRule> rules, List<PublishedAnswer> answers)`.
  `FileRulesPublisherAdapter` then writes each answer's meta and body atomically into
  `answers/` **before** `rules.json`, and deletes answer files that are no longer referenced.
  Update `RecordingPublisher` in `InterceptionRulesServiceTest`.
- [ ] T081 [US6] Extend `RuleValidator`: add the parameter
  `Function<String, Optional<StoredAnswer.Kind>> answerKinds` to the overload from T041.
  `answerId` must match the UUID pattern (data-model §9) before it is looked up.
  ANSWER_WITH_RECORDED_CALL and REPLACE_WITH_RECORDED_RESPONSE require RECORDED; add them to
  the terminal and SEND_TO_HOST conflict counting (:55-94).
- [ ] T082 [US6] Create `BI/adapter/in/web/StoredAnswersController.java` with these routes, per
  contracts/rest-api.md:
  - `POST /interception/answers/from-call`
  - `GET /interception/answers/{id}`
  - `GET /interception/answers/{id}/body`

  The DTO `BI/adapter/in/web/dto/CopyAnswerRequestDto.java` is validated with `@Valid`. The
  sealed result maps to 201 / 409 / 404 / 413.
- [ ] T083 [US6] Create the bridge `BA/interceptionbridge/RecordedCallLookupAdapter.java`
  (`@Component implements RecordedCallLookupPort`). It resolves:
  - `outbound` through backend-calls' detail use case;
  - `inbound` through backend-internal-calls' `GetCallDetailUseCase` (`BIC/application/port/in/GetCallDetailUseCase.java:10`);
  - a `cycleId` through backend-session-cycles' detail use case.

  Follow the `BA/filtering/CallFilterAdapter.java` pattern. Add a test in
  `backend/backend-app/src/test/java/com/fathy/alfred/backend/interceptionbridge/RecordedCallLookupAdapterTest.java`
  with mocked use cases.
- [ ] T084 [US6] Rules export and import, version 2: add `GET /interception/rules/export?ids=`
  to `BI/adapter/in/web/InterceptionRulesController.java`, and extend
  `InterceptionRulesService.importRules` (:176-205) and `ImportRequestDto` (:94) to accept
  `answers[]`, per contracts/rules-snapshot-and-file.md §3.
- [ ] T085 [US6] In `PX/interception.py`:
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
- [ ] T086 [US6] Frontend services and state:
  - add `StoredAnswer` / `SecretsDecisionRequired` types in `FE/core/models/interception.model.ts`;
  - add `copyAnswerFromCall`, `getAnswer`, `exportRules(ids)` and a version-2 `importRules` in
    `FE/core/services/interception-api.service.ts`.
- [ ] T087 [US6] Create `FE/components/answer-picker/answer-picker.component.{ts,html}`, a
  standalone component using signals:
  - a direction toggle (Outbound / Inbound) and a search box that calls
    `CallsApiService.getCalls(source, …)`;
  - picking a call calls `copyAnswerFromCall`. On a 409 it shows the keep/strip dialog, listing
    `secretNames` and warning that "kept secrets travel with exported rules". It then retries
    with the choice;
  - once an answer exists, it shows its metadata (status, size, source, secretsKept badge).

  `rule-action-card` renders it for the answer actions.
- [ ] T088 [US6] Rules file version 2:
  - in `FE/shared/utils/interception-rules-file.ts`, `parseRulesFile` accepts versions 1 and 2;
  - `FE/pages/interception/interception.component.ts:70-83` exports through
    `exportRules(ids)`, then `downloadJson`;
  - `import-rules-dialog` posts the version-2 answers;
  - duplicate keeps `answerId`, which `interception-state.service.ts:251-261` already does.
- [ ] T089 [P] [US6] Frontend specs:
  - `FE/shared/utils/interception-rules-file.spec.ts`: version-1 and version-2 parsing, and a
    calls export still rejected;
  - `FE/components/answer-picker/answer-picker.component.spec.ts`: a 409 leads to the prompt,
    and the retry carries `keepSecrets`.
- [ ] T090 [P] [US6] Add labels, `describeAction` cases and help entries for both actions, with a
  worked example of reproducing yesterday's bug. The warning covers kept secrets.

---

## Phase 10: User Story 7 — Answer with an uploaded file (P3)

**Depends on**: Phase 9 (stored answers).

**Independent Test**: quickstart check 8.

- [ ] T091 [P] [US7] Create
  `BIT/adapter/in/web/StoredAnswersControllerTest.java` (`@WebMvcTest` with the existing
  `TestApplication`), covering: a multipart upload returns 201; over the cap returns 413 with
  `limitBytes`; no content type returns 415. Add upload cases to `StoredAnswersServiceTest`.
- [ ] T092 [P] [US7] Add tests to `PX/test_interception.py`: ANSWER_WITH_FILE serves the exact
  bytes with the action's status override; it is terminal and latch-aware. Add a SAMPLES entry.
- [ ] T093 [US7] Add `ANSWER_WITH_FILE(Phase.REQUEST)` to `ActionType` and to `isTerminal()`.
  The validator requires a FILE answer and a status of 100..599 when it is given.
- [ ] T094 [US7] Add `POST /interception/answers` (multipart: `file`, `contentType`, `status`)
  to `StoredAnswersController`, together with `StoredAnswersService.upload`. It checks the size
  before reading all the bytes (using `MultipartFile.getSize()`) and requires a non-blank
  content type.
- [ ] T095 [US7] Add the ANSWER_WITH_FILE handler to `PX/interception.py`, re-using the
  `_AnswerCache` and mock path from T085.
- [ ] T096 [US7] Frontend:
  - `answer-picker` gains an "Upload file" mode, with an `<input type="file">`, `FormData`
    through a new `uploadAnswer()` in `interception-api.service.ts`, and a status picker
    (`StatusPickerComponent`);
  - add labels, `describeAction` cases, `defaultsFor` entries and a help entry.

---

## Phase 11: User Story 8 — Resend a logged call through Alfred (P3)

**Independent Test**: quickstart check 9.

### Linkage in the call slices

- [ ] T097 [US8] Resend linkage in backend-calls:
  - add `resend_of` and `resend_edits` to `BC/adapter/in/web/dto/PrepareCallRequestDto.java`
    and to `BC/domain/model/CallRecord.java` (as `resendOf`, `resendEdits`), with an overload
    that keeps the positional call sites;
  - `SqliteCallsRepository`: ALTER `call_metadata` to add `resend_of TEXT` and
    `resend_edits TEXT` (following :272-288); include them in the prepare INSERT (:427-431),
    in **both** `SUMMARY_SQL` and `DETAIL_SQL`, and in both row mappers (read
    docs/architecture.md on the shared RowMapper trap);
  - `FileCallLogAdapter` passes them through;
  - expose both on `CallSummaryDto`.
- [ ] T098 [P] [US8] Add a round-trip test in
  `BCT/adapter/out/sqlite/SqliteCallsRepositoryTest.java` (or the existing SQLite test class):
  a prepare with `resend_of` reads back through `query()`, `findById()` **and** `readAll()`.
- [ ] T099 [US8] Add the same fields to backend-internal-calls:
  - `BIC/domain/model/CallRecord.java`
  - the prepare DTO
  - the NDJSON line and the list DTO

  Also add them to the session-cycles captured copies (`BSC/`).

### Proxy

- [ ] T100 [P] [US8] Add `ResendHeadersTest` to `PX/test_interception.py`:
  - with the peer equal to the backend address, `X-Alfred-Resend-Of` and `X-Alfred-Resend-Edits`
    become payload fields and are removed from the request;
  - with any other peer, both are removed and ignored;
  - a rule matching on the header never sees it.
- [ ] T101 [US8] Add `take_resend_headers(flow, backend_addresses)` to `PX/interception.py`. It
  returns `(resend_of, resend_edits)` and always deletes the headers. `backend_addresses` is
  resolved once from `BACKEND_HOST` with `socket.gethostbyname_ex`. Call it at the top of both
  addons' `request` hooks, **before** `ENGINE.apply_request`, and add the results to the
  prepare payload (`PX/log_and_route.py:188-211`, `PX/log_and_route_reverse.py:175-200`).

### New slice backend-resend

- [ ] T102 [US8] Remove the temporary `.allowEmptyShould(true)` from `resendSliceMustNotDependOnOtherSlices` in `HexagonalArchitectureTest.java` (added in T002 while the slice had no classes). Create the domain:
  - `BR/domain/model/ResendRequest.java`: `(direction, callId, cycleId, ResendEdits edits,
    boolean useCurrentSession)`;
  - `BR/domain/model/ResendEdits.java`: `(method, url, Map<String,String> headers, String body)`,
    where a null header value means remove;
  - `BR/domain/model/StoredCall.java`: `(direction, id, method, url, headers, body, host,
    serviceName)`;
  - `BR/domain/model/ResendResult.java`: `(newCallId, status, durationMs,
    List<SessionValueUse>)`.
- [ ] T103 [US8] Create the ports:
  - `BR/application/port/in/ResendCallUseCase.java`;
  - `BR/application/port/out/CallSourcePort.java`:
    `Optional<StoredCall> load(direction, callId, cycleId)`;
  - `BR/application/port/out/SessionValueLookupPort.java`:
    `List<SessionValue> newest(direction, host, Set<String> names, String cycleId)`;
  - `BR/application/port/out/CallSenderPort.java`: `SendOutcome send(OutgoingCall)`.
- [ ] T104 [P] [US8] Write `BRT/application/service/ResendServiceTest.java` (fake ports):
  - edits are applied, and `resend_edits` lists the header names but never their values;
  - the original `X-Request-Id` is replaced by a fresh UUID, which is returned as `newCallId`;
  - `X-Alfred-Resend-Of` and `X-Alfred-Resend-Edits` are added;
  - `useCurrentSession` substitutes the newest cookie or authorization value and reports
    `{name, fromCallId}`;
  - with nothing newer, the originals are kept and the result says so.
- [ ] T105 [US8] Create `BR/application/service/ResendService.java` (`@Service implements
  ResendCallUseCase`), passing T104. Session headers are the sensitive names from
  `authorization` and `cookie`, defined locally with a comment pointing at
  `SensitiveHeaders`: slices may not share code.
- [ ] T106 [US8] Create `BR/adapter/out/http/JdkHttpCallSender.java` (`implements CallSenderPort`):
  - one `HttpClient`, with an `SSLContext` built from the PEM at
    `${alfred.resend.mitm-ca-file}` and a timeout from `${alfred.resend.timeout-ms}`;
  - **outbound**: `ProxySelector.of(proxy:<port>)`, where `<port>` is the internal port mapped
    to the original call's `service_name` in `${FORWARD_PROXY_PORT_MAP:}` (`name:internalPort`
    pairs), falling back to `${FORWARD_PROXY_DEFAULT_PORT:8080}` (research R12). Add
    `FORWARD_PROXY_PORT_MAP` and `FORWARD_PROXY_DEFAULT_PORT` to the backend service's
    environment in `docker-compose.yml`, alongside T003. Test that a call with
    `service_name=odeysys` goes to its mapped port and one without goes to 8080;
  - **inbound**: `http://reverse-proxy:<listenPort><path>`, with `Host: localhost:<listenPort>`.
    `listenPort` is resolved from `${INTERNAL_CALL_SERVICES}` by `serviceName`;
  - a connection refused on inbound becomes `ReverseProxyNotRunning`.

  Test it in `BRT/adapter/out/http/JdkHttpCallSenderTest.java` against a local
  `com.sun.net.httpserver.HttpServer`, checking the headers and the Host override.
- [ ] T107 [US8] Create `BR/adapter/in/web/ResendController.java` for `POST /resend`, with
  `BR/adapter/in/web/dto/ResendRequestDto.java` (`@Valid`). It maps to 200 / 404 / 409 / 502
  per contracts/rest-api.md. It enforces the edit limits in the contract with Bean Validation
  (`@Size`) plus a check of the body's byte length, and returns 400 over a limit. The
  controller test covers each limit. Add a test-only
  `backend/backend-resend/src/test/java/com/fathy/alfred/backend/resend/TestApplication.java`
  and `BRT/adapter/in/web/ResendControllerTest.java`.
- [ ] T108 [US8] Add the in-port `BC/application/port/in/FindRecentRequestHeadersUseCase.java`,
  implemented in `CallsService`:
  - `SqliteCallsRepository` selects the newest ≤ 200 `call_metadata` rows whose `url` host
    matches, ordered by `timestamp_millis DESC`, and joins `call_request.headers` for those
    rows only. It never selects bodies, and it has a `LIMIT`;
  - the file adapter scans its in-memory list.

  Add the backend-internal-calls equivalent in `BIC/application/port/in/`, as a ring scan. Test
  both.
- [ ] T109 [US8] Create the bridges `BA/resendbridge/CallSourceAdapter.java` (calls,
  internal-calls and session-cycles detail use cases) and
  `BA/resendbridge/SessionValueLookupAdapter.java` (the two T108 use cases, plus a scan of the
  cycle's captured calls). Test them with mocks in
  `backend/backend-app/src/test/java/com/fathy/alfred/backend/resendbridge/`.

### Frontend

- [ ] T110 [US8] Add `FE/core/services/resend-api.service.ts` (`resend(req)`). Add `resendOf`
  and `resendEdits` to `CallRecord` in `FE/core/models/call.model.ts`, and map them in
  `toCallRecord`.
- [ ] T111 [US8] Create `FE/components/resend-dialog/resend-dialog.component.{ts,html}`,
  standalone and opened through a new `ResendDialogService` that follows `ExportDialogService`:
  - editable method, URL, header rows and body, pre-filled from the hydrated call;
  - a "Resend with current session" checkbox;
  - after the send, the result: a link to the new call, plus the session values used, shown as
    names and source calls only.
- [ ] T112 [US8] Add "Resend…" to the Export menu in
  `FE/components/call-actions/call-actions.component.html:9-19`, and a bulk "Resend selected" to
  `FE/components/bulk-actions-bar/bulk-actions-bar.component.{html,ts}`. Bulk resend sends the
  calls one at a time in the selection's display order, with a progress count, and stops on the
  first 409. On `FE/components/call-card/call-card.component.html`, add a "↻ resend of <id>"
  chip that links to the original, with the edits summarised in its tooltip.
- [ ] T113 [P] [US8] Frontend specs: bulk resend preserves the order and awaits each call
  (`bulk-actions-bar.component.spec.ts`); the dialog builds the edits payload correctly
  (`resend-dialog.component.spec.ts`).

---

## Phase 12: User Story 9 — View and edit WebSocket messages (P4)

**Independent Test**: quickstart check 10.

### Proxy

- [ ] T114 [P] [US9] Write `PX/test_ws_messages.py`, with a fake clock and a fake queue:
  - the batcher flushes at 50 messages or at 500 ms, whichever comes first;
  - `closed:true` is sent at the end;
  - `seq` increases per connection.

  Add `MessageActionsTest` in `PX/test_interception.py`:
  - REPLACE_IN_MESSAGE edits only the configured direction;
  - DROP_MESSAGE with `contains` drops the message and records it;
  - DELAY_MESSAGE returns a delay;
  - an unknown MESSAGE kind records a skip.

  Add SAMPLES entries under `MESSAGE_ACTIONS`.
- [ ] T115 [US9] Add `REPLACE_IN_MESSAGE`, `DROP_MESSAGE` and `DELAY_MESSAGE` with
  `Phase.MESSAGE` to `ActionType`. Add the RuleAction fields `messageDirection` and `contains`.
  The validator enforces a valid direction and `durationMs` ≤ MAX_DELAY_MS, and rejects MESSAGE
  actions inside `IF_*`. Add the matching `RuleValidatorTest` cases.
- [ ] T116 [US9] In `PX/interception.py`:
  - add `MESSAGE_ACTIONS`;
  - add `async def apply_message(self, rules, message, from_client) -> MessageVerdict`, where
    `MessageVerdict` carries `delay_ms`, `dropped`, `edited`, `original` and `applied`;
  - add `match_for_websocket(flow, service_name)`, which returns the matched rules that have
    MESSAGE actions.
- [ ] T117 [US9] Create `PX/ws_messages.py`, a per-connection batcher. Its state is in
  `flow.metadata['ws']`, and it pushes batches onto the addon's existing webhook queue with the
  URL `{WEBHOOK_URL}/{call_id}/ws-messages`. In both addons, add:
  - `websocket_start`, which caches the rules from `match_for_websocket`;
  - `async def websocket_message`, which awaits `ENGINE.apply_message`, awaits
    `asyncio.sleep` for a delay, calls `message.drop()` for a drop, assigns `message.text` or
    `.content` for an edit, and adds to the batch;
  - `websocket_end`, which does the final flush with `closeCode`.

  Mount the module in compose (T003).

### Backend

- [ ] T118 [P] [US9] Add backend tests:
  - `SqliteCallsRepository`: `call_ws_message` insert; the cap deletes the lowest `seq` rows
    and increments `ws_dropped`; the page query order;
  - `CallsWebhookControllerTest`: the ws-messages endpoint checks the secret; an unknown id
    returns 404;
  - backend-internal-calls: the NDJSON adapter with the cap and compaction (`@TempDir`);
  - **retention**, for both file adapters: after the call log evicts call X, the next
    compaction leaves no message with `callId = X`, so the file does not grow once the call
    log is full.
- [ ] T119 [US9] backend-calls:
  - add `WsMessage` and `WsMessagesPage` records in `BC/domain/model/`;
  - add port methods `appendWsMessages(callId, list, closed, closeCode)` and
    `wsMessages(callId, offset, limit)`;
  - in `SqliteCallsRepository`, add the table, the ALTER of `ws_message_count` and
    `ws_dropped`, and the cap enforced in the same transaction;
  - the file adapter uses a sibling `RECENT_CALLS.ws.log` NDJSON with the same cap. Its
    compaction drops the messages of calls no longer in `RECENT_CALLS.log`, and it is triggered
    by the call log's eviction as well as its own slack (data-model §8, Retention). Clearing
    all calls clears it;
  - add `POST /calls/webhook/{id}/ws-messages` to `CallsWebhookController` and
    `GET /calls/{id}/ws-messages` to the calls controller, with the limit clamped to 1..500;
  - the WebSocket notifier sends `{"type":"ws-messages-appended","callId"}` on `/ws/calls`.
- [ ] T120 [US9] backend-internal-calls:
  - an adapter for the same port, `BIC/adapter/out/filelog/InternalWsMessagesFileAdapter.java`,
    writing `${INTERNAL_WS_MESSAGES_FILE:/appdata/internal-ws-messages.log}` with the
    append-and-compact scheme of `InternalCallsFileLogAdapter`. Compaction drops the messages
    of calls the inbound ring has evicted, and is triggered from `InternalCallsFileLogAdapter`'s
    own compaction (data-model §8, Retention);
  - the equivalent webhook and GET routes;
  - the `/ws/internal-calls` event.

### Frontend

- [ ] T121 [US9] Create `FE/core/models/ws-message.model.ts` and add `getWsMessages(source, id,
  offset, limit)` to `FE/core/services/calls-api.service.ts`. Create
  `FE/components/ws-messages/ws-messages.component.{ts,html}`:
  - a windowed list with a direction arrow, time and type;
  - an edited or dropped badge, with the original content viewable;
  - "N earlier messages not recorded" when `dropped > 0`.

  `call-card` shows "WebSocket · N messages" for status-101 calls and embeds the component,
  loaded on expand. `calls-state.service.ts` re-fetches for open panels on
  `ws-messages-appended`, with no timer.
- [ ] T122 [US9] Add WebSocket messages to the calls exports:
  - `FE/shared/utils/bulk-json-builder.ts` adds `wsMessages` to the call's event;
  - `FE/shared/utils/import-parser.ts` reads them back, as the exact inverse;
  - `markdown-builder.ts` and `html-builder.ts` render every message untruncated.

  Add spec cases: a round trip through `buildBulkExportPayload`, then `parseImportedCalls`; and
  a large-message no-truncation guard.
- [ ] T123 [US9] Add a "Messages" lane to the rule editor, driven by `phaseOf === 'MESSAGE'`:
  - `rule-editor.component.html`, after the response lane;
  - a card block with a direction select, the pattern inputs from US1, `contains` and a
    duration;
  - labels, `describeAction` cases, `defaultsFor` entries and help entries.

---

## Phase 13: User Story 10 — Edit HTTP trailers (P4)

**Independent Test**: quickstart check 11.

- [ ] T124 [P] [US10] Add tests to `PX/test_interception.py`:
  - set and remove on existing `trailers`;
  - `trailers is None` records `skipped - no trailers`.

  Add SAMPLES entries (the fakes gain `trailers`).
- [ ] T125 [US10] Add the four actions to `ActionType`:
  - `SET_REQUEST_TRAILER`, `REMOVE_REQUEST_TRAILER`
  - `SET_RESPONSE_TRAILER`, `REMOVE_RESPONSE_TRAILER`

  Add validator cases, and handlers in `PX/interception.py`.
- [ ] T126 [US10] Frontend:
  - re-use the `isHeaderSet` / `isNameOnly` predicates by adding the trailer types to them;
  - add labels, `describeAction` cases, `defaultsFor` entries and help entries.

---

## Phase 14: Polish and cross-cutting

- [ ] T127 [P] Update `docs/interception.md`:
  - the Actions table and MESSAGE lane;
  - matcher tests and the precedence note;
  - stored answers, including the keep/strip question and the no-total-cap decision;
  - regex safety (the worker process and timeout);
  - masking;
  - resend headers;
  - the "Adding an action" checklist, which now includes `phaseOf`/`isTerminal` coming from the
    backend and the `default` validator case;
  - "Intentionally left for later": remove the inbound interception-record item, and add
    WebSocket capture in cycles.
- [ ] T128 [P] Update `docs/architecture.md`:
  - the `backend-resend` slice and its isolation rule;
  - the `interceptionbridge` / `resendbridge` packages;
  - the inbound interception record;
  - the `call_ws_message` table and cap;
  - `FindRecentRequestHeadersUseCase`, and why it is windowed.
- [ ] T129 [P] Update `docs/frontend-architecture.md` (the answer picker, resend dialog, WebSocket
  message list, and phase/terminal from the backend) and `docs/supplier-integrations.md` (the
  resend path, the certs mount, `X-Alfred-*` headers, the WebSocket hooks, and `regex_worker`).
- [ ] T130 [P] Update `CLAUDE.md` and `AGENTS.md`: the module list (`backend-resend`), the
  gateway prefix list (`resend`), and one line each on regex-in-a-process and stored answers.
  Update `docs/feature-requests/interception-mitmproxy-parity.md` with a note at the top that
  the spec supersedes it.
- [ ] T131 Run the full suites: proxy unittest, `mvn test` (including ArchUnit), then
  `npx ng test --watch=false --browsers=ChromeHeadless`, then `npm run build`. Fix any failures.
- [ ] T132 Run quickstart.md checks 1–13 against the rebuilt stack
  (`docker compose up -d --build …`, then `docker compose restart app-gateway`). Record each
  measured result in `docs/interception.md`, in the existing "measured: …" style.

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
