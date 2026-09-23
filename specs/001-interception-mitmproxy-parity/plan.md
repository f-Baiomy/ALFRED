# Implementation Plan: Interception Rule Actions at Parity with mitmproxy

**Branch**: `001-interception-mitmproxy-parity` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-interception-mitmproxy-parity/spec.md`

## Summary

This plan adds:
- 26 rule actions;
- header, query and cookie matchers;
- stored answers (recorded calls and uploaded files);
- resending logged calls through Alfred;
- WebSocket message recording and editing;
- trailers.

Everything follows the existing interception design. Rules are authored and validated in
`backend-interception` and published as a file snapshot. They are evaluated only inside the two
mitmproxy addons, with no backend work on the request path.

Five structural changes carry the feature:
1. **The engine becomes `async`.** Only regex work is offloaded, to a pre-emptible worker
   process (research R1).
2. **Stored answers** are a new aggregate in `backend-interception`, published beside
   `rules.json` (R8). They are copied from call logs through a `backend-app` bridge (R9).
3. **The inbound slice gains the interception record** it has always dropped (R15). This is a
   prerequisite for FR-020 and FR-021.
4. **A new leaf slice, `backend-resend`,** sends calls back through the proxies with a
   resend-only trust context (R12).
5. **WebSocket hooks** are added to both addons, with batched delivery and capped storage in
   both call slices (R14).

## Technical Context

**Language/Version**:
- Python 3.14 (stock `mitmproxy/mitmproxy` 12.2.3 image, no pip step);
- Java 21 (Spring Boot, Maven reactor);
- TypeScript (Angular standalone + signals).

**Primary Dependencies**:
- mitmproxy addon API: `request`, `response`, `websocket_*` hooks and `http.Headers`. `brotli`
  and `zstandard` are bundled; this was verified in the running container.
- Spring Web (multipart is new), `java.net.http.HttpClient` (new, resend only), Jackson, JDBC on
  SQLite.
- RxJS / Angular.

**Storage**:
- `interception.db`: new tables `stored_answers` and `stored_answer_bodies`.
- `calls.db`: new `call_ws_message` table, plus ALTER columns `resend_of`, `resend_edits`,
  `ws_message_count` and `ws_dropped`.
- Inbound NDJSON: additive keys, plus the new `internal-ws-messages.log`.
- Published files: `proxy/interception/answers/*`.

**Testing**:
- proxy: stdlib `unittest`, with fakes and no mitmproxy import, migrated to
  `IsolatedAsyncioTestCase`.
- backend: JUnit 5, Mockito, AssertJ, ArchUnit.
- frontend: Karma/Jasmine.

**Target Platform**: Docker Compose on a developer or test host. Both proxies have
`mem_limit 256m`; the backend has 2g.

**Project Type**: a multi-service web application (proxy addons, a hexagonal Maven backend, an
Angular SPA behind an nginx gateway).

**Performance Goals**:
- No added latency for calls that match no rule (SC-002).
- A regex match never delays other calls (SC-003); regex timeout 2 s.
- Stored-answer responses in the mock latency class, about 10 ms (SC-004).
- 100 WebSocket messages per second recorded with no added latency elsewhere (SC-009).

**Constraints**:
- No blocking on the event loop.
- Every regex compiled once, when rules load.
- A body that no action changed stays byte-identical.
- Bodies are never inlined into the snapshot.
- The proxy answer cache is capped at 32 MB.
- No polling.
- No truncation in exports.

**Scale/Scope**:
- Rules: ≤ 20 actions each (existing cap).
- Stored answers: ≤ 10 MB each, no total cap.
- WebSocket: ≤ 1,000 recorded messages per connection.
- Size of the change: roughly 26 action types, 3 matcher kinds, 1 new slice and about 9
  frontend areas.

No NEEDS CLARIFICATION items remain; all are resolved in [research.md](research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Security**:
  - Inputs validated with `@Valid` and `RuleValidator`, which now has an explicit `default`.
  - Pattern length is capped, and nested quantifiers and cross-engine constructs are rejected.
  - Multipart uploads are size-capped before buffering.
  - Secrets:
    - one secret-name list, owned by the backend and published to the proxies (R7);
    - masking in the interception record, including the two existing leaks: snapshots and
      `SET_QUERY_PARAM`;
    - keep or strip decided at save time for recorded answers (FR-026).
  - Resend:
    - its trust store is scoped to the resend client only;
    - the `X-Alfred-*` control headers are honoured only from the backend's address, and
      stripped from everyone else.
  - Webhook secret checks on the new ws-messages endpoint.
  - Allowing internal targets for `REWRITE_URL` is an **accepted risk** (Clarification Q1). The
    self-target guard is enforced at save time and at run time.
- [x] **II. Performance**:
  - The no-rule path is unchanged; the new matcher tests run last.
  - Regex runs in a pre-emptible worker process, and literal matching is linear.
  - The answer cache is bounded.
  - WebSocket messages are batched, and their tables are capped and indexed.
  - The "current session" lookup is windowed SQL with a LIMIT (R13).
  - List endpoints return summaries, and answer and message bodies are fetched on demand.
  - No polling: new events reuse the existing sockets.
  - Retention:
    - stored answers are deleted with their last referencing rule, and orphans are swept after
      1 h;
    - WebSocket messages are capped per connection.
    - Justified exception: stored answers have no total cap (see Complexity Tracking).
- [x] **III. Architecture**:
  - `backend-interception` stays a leaf. Cross-slice reads go through `backend-app` bridges
    (`RecordedCallLookupPort`, `SessionValueLookupPort`).
  - The new `backend-resend` slice follows "Adding a slice", including a new ArchUnit isolation
    rule. It has no new direct cross-slice edge.
  - Both storage types are supported: stored answers get SQLite and file adapters, and WebSocket
    messages go to SQLite (outbound) or NDJSON (inbound, whose slice is file-only).
  - Frontend:
    - the new UI uses signals and standalone components;
    - the message list and Resend dialog are shared between the dashboard and session-cycle
      pages through the existing `CALL_LIST_CONTROLS_STATE` token;
    - terminal and phase data come from the backend, removing three duplicated terminal lists.
- [x] **IV. Style**:
  - naming: `*UseCase`, `*Port`, `Sqlite*Adapter`, `JsonFile*Adapter`, `*RequestDto`;
  - records and constructor injection;
  - one field-block component per action family;
  - comments explain why, in the voice of the existing docs.
- [x] **V. Clean code**:
  - Reused:
    - `_parse_path` / `isValidPath` for field removal;
    - the snapshot / finalize capture;
    - `failure_plan`'s split between the engine and the addon;
    - `StatusPickerComponent`;
    - `buildHttpDiff`;
    - `reconnectingSocket`;
    - the atomic-publish helper;
    - `CallListSupport` clamping.
  - One pattern engine serves body, URL and message replace (`_Pattern`, research R1).
  - Nothing is built beyond the spec.
- [x] **VI. Verification**:
  - Every new action goes in `EveryActionIsCoveredTest.SAMPLES` and in the help coverage spec.
  - `RuleValidatorTest` covers every rejection.
  - Adapter tests use `@TempDir` or an in-memory SQLite.
  - An ArchUnit rule is added for `resend`.
  - Fixtures are realistic: 5 MB bodies, gzip, br and zstd.
  - Every fix of an existing masking leak comes with a failing-first test.
- [x] **Invariants**:
  - Exports are not truncated; calls-export messages round-trip through `import-parser`.
  - Interception stays in the addons.
  - `/resend` is added to the gateway regex.
  - Docs are updated: `docs/interception.md`, `docs/architecture.md`,
    `docs/frontend-architecture.md` and `docs/supplier-integrations.md`.

**Post-design re-check (after Phase 1)**: pass. The violations listed in Complexity Tracking
are justified.

## Project Structure

### Documentation (this feature)

```text
specs/001-interception-mitmproxy-parity/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md
│   ├── proxy-webhooks.md
│   └── rules-snapshot-and-file.md
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
proxy/
├── interception.py            # async apply_*, new actions, Match tests, _Pattern, _AnswerCache,
│                              #   masking, MESSAGE phase, skipped/refused records
├── regex_worker.py            # NEW: persistent worker process + timeout/restart (R1)
├── log_and_route.py           # await engine; websocket_* hooks; resend headers; ws batch queue
├── log_and_route_reverse.py   # same for inbound
├── test_interception.py       # async migration + new action/matcher/masking tests
└── test_regex_worker.py       # NEW
docker-compose.yml             # mount regex_worker.py; certs ro into backend; JAVA_TOOL_OPTIONS;
                               #   INTERCEPTION_* limits
gateway/nginx.conf             # add `resend` to the API prefix regex

backend/
├── pom.xml                                  # + backend-resend module
├── backend-interception/…/interception/
│   ├── domain/model/{ActionType,RuleAction,RuleMatch,MatchTest,UrlTarget,CookieAttributes,
│   │                 StoredAnswer,SensitiveHeaders,PatternSafety,RuleValidator}.java
│   ├── application/port/in/{ManageStoredAnswersUseCase}.java
│   ├── application/port/out/{StoredAnswersStorePort,RecordedCallLookupPort}.java
│   ├── application/service/{StoredAnswersService,InterceptionRulesService}.java
│   ├── adapter/in/web/{StoredAnswersController,InterceptionRulesController(export/import v2)}
│   └── adapter/out/{sqlite/SqliteStoredAnswers*,filestore/JsonFileStoredAnswers*,
│                    rulesfile/FileRulesPublisherAdapter (answers + snapshot keys)}
├── backend-calls/…/calls/          # CallRecord resendOf/resendEdits/ws*; ws-messages webhook+query;
│                                   #   FindRecentRequestHeadersUseCase; SqliteCallsRepository schema
├── backend-internal-calls/…/       # interception + resend + ws fields; ws-messages NDJSON adapter
├── backend-session-cycles/…/       # carry interception for internal captures; resend fields
├── backend-resend/                 # NEW slice: domain(ResendRequest, ResendEdits), port.in(ResendCallUseCase),
│                                   #   port.out(CallSourcePort, SessionValueLookupPort, CallSenderPort),
│                                   #   service, adapter.in.web(ResendController), adapter.out.http(JdkHttpCallSender)
├── backend-app/…/interceptionbridge/RecordedCallLookupAdapter.java     # NEW bridge
├── backend-app/…/resendbridge/{CallSourceAdapter,SessionValueLookupAdapter}.java  # NEW bridges
└── backend-architecture-test/…/HexagonalArchitectureTest.java          # + resend isolation rule

frontend/src/app/
├── core/models/{interception.model.ts, call.model.ts, ws-message.model.ts (NEW)}
├── core/services/{interception-api.service.ts, calls-api.service.ts, resend-api.service.ts (NEW)}
├── core/state/{interception-state.service.ts (isTerminal/phaseOf), calls-state.service.ts, session-cycle-detail-state.service.ts}
├── components/rule-editor/           # match tests rows; MESSAGE lane; defaultsFor
├── components/rule-action-card/      # field blocks per action family
├── components/answer-picker/         # NEW: pick recorded call / upload file / keep-strip prompt
├── components/resend-dialog/         # NEW: edit + current-session option (shared via token)
├── components/ws-messages/           # NEW: lazy windowed message list
├── components/call-actions/, bulk-actions-bar/  # Resend entry points
├── shared/utils/{interception-help.ts, interception-rules-file.ts (v2), bulk-json-builder.ts,
│                 import-parser.ts, markdown-builder.ts, html-builder.ts (ws messages)}
└── pages/interception/               # export via backend endpoint
```

**Structure Decision**: this plan keeps the existing multi-service layout. It adds one backend
slice (`backend-resend`), two `backend-app` bridge packages, and one proxy module
(`regex_worker.py`). No existing module moves.

## Build order (maps to spec priorities; /speckit-tasks expands each)

- **A. Foundation**, which blocks everything else:
  - make the engine async;
  - add `_Pattern` and `regex_worker`;
  - FR-015 skip records, including recording unknown actions as skipped;
  - one masking list, and the fix for the existing masking leaks;
  - take phase and terminal flags from the backend in the frontend;
  - the `default` case in `RuleValidator`;
  - the inbound interception record (R15).
- **B. P1 actions**: body replace, set request body, remove JSON field, rewrite URL with the
  self guard, set method.
- **C. P2**: cookies, forms, disable cache and compression, set response encoding, and the
  matchers (US11).
- **D. Stored answers**: the aggregate, uploads, copying from a call through the bridge, the
  keep/strip prompt, publishing and the proxy cache, rules file version 2 export and import.
  Then the recorded-call and file actions (US6, US7).
- **E. Resend** (US8): the new slice, the trust mount, header stripping, linkage, the dialog,
  bulk resend and the current-session option.
- **F. WebSocket** (US9): hooks, batching, both stores, the message UI, the MESSAGE actions,
  and messages in the calls export and import.
- **G. Trailers** (US10).
- **H. Docs and live verification**: the quickstart checks, with the measurements recorded in
  `docs/interception.md`.

Each block ends green: proxy unittest, `mvn test` and `ng test` plus `ng build`.

## Scope notes surfaced during planning

- **Session cycles capture the WebSocket handshake call, but not its messages.** The spec asks
  for recording in Live Calls. Cycle message capture would duplicate the capped message store
  per cycle, so it is left for later and noted in the docs.
- **FR-023 masking covers the interception record.** Raw call headers keep today's logging and
  the existing redaction feature (R7). This is the spec's own wording, and it is stated
  explicitly here so that review does not read it as a gap.
- **Resending an inbound call needs the `inbound-logging` profile to be running.** When it is
  off, the endpoint answers `409 reverse-proxy-not-running`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| No total cap on stored answers (constitution II requires a retention policy for every store) | Clarification Q5: the user chose a per-answer cap only | A total cap was offered (option B) and declined. Retention is still bounded by the rule lifecycle plus the 1 h orphan sweep. |
| A proxy addon strips `X-Alfred-Resend-*` headers (a new pattern; the addons strip no header today) | A resend must be linked to its original, and the control headers must not reach suppliers | A backend-side correlation (matching the next call by URL and time) is racy under concurrent traffic. A side-channel to the addon would need an HTTP server in the addon, which was already rejected in docs/interception.md. |
| JVM-wide `-Djdk.httpclient.allowRestrictedHeaders=host` | Inbound resends must carry `Host: localhost:<port>` so that `original_url` matches live traffic | Changing the reverse addon to rebuild `original_url` from another header would change live inbound logging for every call. The property affects only `java.net.http`, and resend is its only user. |
| A second process per proxy container (the regex worker) | CPython `re` holds the GIL, so only a process can be pre-empted (R1) | A thread pool cannot pre-empt a match, and literal-only matching was declined in Clarification Q3. |
| `CallInterception` shape duplicated in backend-internal-calls | That slice deliberately mirrors backend-calls without sharing code (docs/architecture.md) | A shared module would be a new cross-slice edge, forbidden by the ArchUnit isolation rules. |
