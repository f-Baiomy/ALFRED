# Research: Interception Rule Actions at Parity with mitmproxy

All facts were verified against the repository on 2026-09-23 and against the running `proxy`
container: mitmproxy 12.2.3, Python 3.14.5, `brotli` 1.2.0 and `zstandard` 0.25.0 installed, the
third-party `regex` module absent. Paths are relative to the repository root.

## R1. Running regex without freezing the proxy

- **Decision**:
  - A literal pattern (the default) runs in-process with `str.replace` / `str.count`, which
    take linear time.
  - A regex pattern runs in a **dedicated worker process** with a hard timeout (default 2 s,
    `INTERCEPTION_REGEX_TIMEOUT_MS`). The worker is created once per proxy container and kept
    alive.
  - On timeout, the worker is terminated and re-created, and the action is recorded as
    `skipped - pattern timed out after 2000 ms`. The body stays unchanged.
- **Rationale**:
  - CPython's `re` holds the GIL for the whole match, so `asyncio.to_thread` would still freeze
    the event loop that serves every connection.
  - Only a separate process can be pre-empted.
  - The image has no `regex` module with a timeout, and the constitution forbids a pip step.
- **Alternatives considered**:
  - A thread pool: rejected, because of the GIL.
  - Save-time checks alone: rejected, because they cannot prove a pattern is linear.
  - Literal only: rejected in the clarification session, where the user chose option B.
- **Consequence**: the engine's `apply_request` / `apply_response` become `async`. Every other
  action stays a synchronous helper. The existing unittest suite moves to
  `IsolatedAsyncioTestCase` through one `run()` helper.

## R2. Body decoding and re-encoding

- **Decision**:
  - Keep the existing approach: read with `get_text(strict=False)` and write with `.text`.
    mitmproxy's `.text` setter re-encodes to the current `Content-Encoding` and fixes
    `Content-Length`.
  - Assign only when the result differs from the input, so an unmatched body stays
    byte-identical. This is the same guarantee `set_json_field` gives today
    (`proxy/interception.py:819-840`).
  - `SET_RESPONSE_ENCODING` calls `response.decode(strict=False)` and then
    `response.encode(enc)`.
- **Rationale**: this matches the existing JSON-field path. All five encodings (`gzip`,
  `deflate`, `br`, `zstd`, `identity`) are available in the image.
- **Alternatives considered**: manual codec handling, rejected as a duplicate of mitmproxy's
  own codec.

## R3. Streamed or unbuffered bodies

- **Decision**: body actions check `message.stream`. When it is truthy, or when
  `raw_content is None`, they record `skipped - body was streamed, not buffered`.
- **Rationale**: no entrypoint sets `stream_large_bodies`, so this never happens today. The
  guard exists so that a future streaming change cannot turn into a half-applied edit (spec
  edge case).

## R4. "Rewrite URL" and its self-target guard

- **Decision**:
  - The structured form sets `request.scheme`, `request.host`, `request.port` and
    `request.path`.
  - The pattern form applies a pre-compiled regex (literal or opt-in regex, R1) to
    `pretty_url` and assigns `request.url`.
  - `keepHostHeader` defaults to false. When it is false the engine sets `request.host_header`
    to the new authority explicitly, instead of relying on setter side effects.
  - The self-target guard works in two places:
    1. **At save time**, `RuleValidator` rejects a structured host that is in the Alfred
       self-set. That set is published in the rules snapshot as `selfTargets`.
    2. **At run time**, the engine re-checks the final authority against `selfTargets`, because
       a regex result cannot be known at save time. A match is recorded as
       `refused - target is Alfred itself`, and the request is left unchanged.
  - The self-set has two parts:
    - **Compose service names**: backend, app-gateway, proxy, reverse-proxy, frontend.
    - **host:port pairs on loopback and `host.docker.internal`**:
      - the backend port (default 5000) and the gateway port (3000);
      - `127.0.0.2:443`;
      - every configured reverse-proxy `listenPort`.
    The backend assembles the set from properties it already has (`INTERNAL_CALL_SERVICES`,
    `BACKEND_PORT`).
- **Rationale**: this is Clarification Q1, "any target except Alfred itself". The rewrite would
  otherwise loop into the proxy, or post into the backend with the proxy's own identity.
- **Reverse mode**: mitmproxy honours a changed `request.host`/`port` in the `request` hook in
  reverse mode as well. A spike task confirms this before the implementation relies on it.

## R5. Cookies and forms without disturbing other values

- **Decision**:
  - **Request cookies** are edited at token level on the raw `Cookie` header: the header is
    split on `;` with the original spacing kept, then the named token is replaced, removed or
    appended. mitmproxy's `request.cookies` view is not used, because it re-serialises every
    cookie (acceptance scenario US4-1 requires the others to stay byte-identical).
  - **Response cookies** use `headers.get_all("set-cookie")` / `set_all`:
    - "set" replaces the entry with the same cookie name, or appends one, with the given
      attributes;
    - "remove" drops that entry;
    - "expire" is `set` with `Max-Age=0`.
  - **Forms**:
    - `multipart/form-data` text parts are edited at the byte level, part by part, on
      `request.content` (changed during implementation: `request.multipart_form`'s setter
      re-encodes every part with a bare `name=` disposition, which drops a file part's filename
      and content type). Every part except the edited one is copied through unchanged, and a
      value that contains the boundary is refused;
    - urlencoded bodies are likewise edited pair by pair, so the other pairs keep their original
      encoding;
    - a file part (one with a filename) is never edited;
    - any other content type is recorded as `skipped - not a form`.

## R6. Trailers

- **Decision**: `message.trailers` (a `Headers` object or `None`).
  - When it is `None`, the action is recorded as `skipped - no trailers`.
  - Set replaces or adds the named trailer; remove deletes it.
- **Rationale**: mitmproxy lets trailers be written in both the `request` and `response`
  hooks. Creating trailers where none exist would need chunked encoding and gains nothing, so
  it is not done.

## R7. Secret masking: one list, two languages

- **Decision**:
  - The backend owns the list of secret header and cookie names
    (`SensitiveHeaders` in the interception domain) and publishes it in the snapshot as
    `sensitiveHeaders`.
  - The proxy uses the published list, and falls back to its current built-in
    `SENSITIVE_HEADERS` (`proxy/interception.py:87-90`) only when the snapshot has none.
  - The same list drives three things:
    - the keep/strip question for recorded answers (FR-026);
    - matcher descriptions (FR-039);
    - masking inside the **interception record**.
- **Scope of FR-023**, derived from the spec's wording:
  - Masking applies to the interception record: `applied[].detail` and the before/after
    snapshots.
  - Raw call headers in the call log keep today's behaviour and the existing redaction feature
    (`backend-redactions`, `redactCall` on export). This feature does not change what Alfred
    logs about ordinary traffic.
- **Existing gaps closed** because the new cookie and header actions would otherwise leak
  through them:
  - `_snapshot` headers are unmasked (`proxy/interception.py:108`);
  - `SET_QUERY_PARAM` records `name=value` in clear text (`:994`).
  A masked value keeps a stable fingerprint, `(value not logged · 4 chars → 7 chars)`, so the
  diff can still show that the value changed.

## R8. Stored answers: storage, publishing and proxy caching

- **Decision**:
  - **Where stored answers live**: in `backend-interception`, behind a new
    `StoredAnswersStorePort`. There is a SQLite adapter (tables `stored_answers` and
    `stored_answer_bodies` in the existing `interception.db`) and a file adapter for
    `type=file` (constitution: storage is swappable per slice).
  - **Publishing**: `FileRulesPublisherAdapter` also writes `answers/<id>.meta.json` and
    `answers/<id>.body` into the directory both proxies already mount. It uses the same
    temp-file + atomic move as `rules.json`, and deletes files that no published rule
    references.
  - **Proxy side**: `_AnswerCache` reads each answer by mtime. Its bounded in-memory LRU
    defaults to 32 MB (`INTERCEPTION_ANSWER_CACHE_BYTES`); anything beyond is read from disk
    per use.
- **Rationale**:
  - Bodies must not be inlined into `rules.json` (spec).
  - Each proxy container has `mem_limit: 256m` (`docker-compose.yml`), so an unbounded cache
    of 10 MB answers would risk an OOM kill.
- **Retention**:
  - Each answer is capped by `alfred.interception.max-answer-bytes`
    (`INTERCEPTION_MAX_ANSWER_BYTES`, default 10 MB).
  - There is no total cap (Clarification Q5, recorded in Complexity Tracking).
  - An answer is deleted when no rule references it.
  - An upload that no rule has referenced within 1 hour is swept by the existing
    `@Scheduled` machinery.

## R9. Copying a recorded call across slice boundaries

- **Decision**:
  - `backend-interception` defines the out-port `RecordedCallLookupPort.find(direction,
    callId, cycleId?)`, which returns a neutral
    `RecordedResponse(status, headers, body, recordedAt)`.
  - A bridge in `backend-app` (package `com.fathy.alfred.backend.interceptionbridge`)
    implements it using:
    - backend-calls' and backend-internal-calls' existing `GetCallDetailUseCase`;
    - session-cycles' detail use case for captured calls.
  - This is the same pattern as `CallFilterAdapter`.
- **Rationale**: `HexagonalArchitectureTest.interceptionSliceMustNotDependOnOtherSlices`
  (`:187-195`) keeps interception a leaf in both directions, and `backend-app` is
  unconstrained. The copy is taken once, when the rule is saved (FR-025), so the ring-buffered
  inbound log (1,500 rows) evicting the call later does not matter.

## R10. Rule export, duplicate and import with stored answers

- **Decision**:
  - The rules file moves to version 2 (`alfredInterceptionRules: 2`), with a top-level
    `answers: [{ref, kind, status, headers, contentType, secretsKept, sourceDirection,
    recordedAt, bodyBase64}]`. A rule refers to an answer through `answerRef`.
  - A new backend endpoint, `GET /interception/rules/export?ids=`, builds the file, because
    only the backend has the bodies. The export itself remains a browser download.
  - Import posts the whole file. The backend creates fresh answer ids and rewrites each rule's
    reference.
  - Duplicate re-uses the same answer id, and the reference-based garbage collection keeps the
    answer alive.
  - Version 1 files still import.
- **Rationale**: export and duplicate are frontend-only today
  (`frontend/src/app/shared/utils/interception-rules-file.ts`), and a bare answer id would
  dangle on another machine.

## R11. Where a new action's phase comes from

- **Decision**:
  - The frontend reads each action's phase from `GET /interception/action-types`, which it
    already fetches.
  - The name heuristic in `actionPhase` (`interception.model.ts:590`, "contains RESPONSE and is
    not MOCK_RESPONSE") becomes a fallback only.
  - The hardcoded terminal lists are replaced by the `terminal` flag from the same endpoint:
    - `alwaysShortCircuits` (rule-editor `:264`);
    - `conflictHint` (`:375`);
    - the import preview (`import-rules-dialog.component.ts:74-75`), which already misses
      `SIMULATE_FAILURE`.
  - Everything reads the flag through one helper, `InterceptionStateService.isTerminal(type)`.
- **Rationale**: several new names would break the heuristic. `ANSWER_WITH_RECORDED_CALL` is a
  request action, and the WebSocket actions need a third lane, MESSAGE.

## R12. Resend path and trust

- **Decision**:
  - A new leaf slice, `backend-resend`, sends calls with the JDK's `java.net.http.HttpClient`.
    - **Outbound**: through the forward proxy as an HTTP proxy (regular mode, which accepts
      CONNECT), on **the listener port the original call arrived on**. The forward proxy runs
      one `regular@<port>` listener per `FORWARD_PROXY_PORT_MAP` pair
      (`forward-proxy-entrypoint.sh:46-49`), and it labels a call's `service_name` by that
      port. The resend client therefore looks up the original call's `service_name` in
      `FORWARD_PROXY_PORT_MAP` (`name:internalPort`) and sends through `proxy:<internalPort>`.
      It falls back to `proxy:8080` (`FORWARD_PROXY_DEFAULT_PORT`) when the call had no service
      name or the name is no longer mapped. Sending everything through 8080 would drop the
      project label, and project-scoped rules would then match differently from live traffic.
    - **Inbound**: straight to `reverse-proxy:<listenPort>`, with a `Host: localhost:<listenPort>`
      header so that `original_url` matches live traffic (`log_and_route_reverse.py:376-382`).
  - **Trust**: `./proxy/certs` is mounted read-only into `backend`. An `SSLContext` built from
    `mitmproxy-ca-cert.pem` is used **only by the resend client**; the JVM default truststore
    is not changed.
  - **Host header**: a restricted header for the JDK client. Setting
    `-Djdk.httpclient.allowRestrictedHeaders=host` in the backend's `JAVA_TOOL_OPTIONS` is
    required, and it affects only `java.net.http`. No other `java.net.http` usage exists in the
    backend.
  - **Linking a resent call to its original**:
    - The resend client adds `X-Alfred-Resend-Of: <originalId>` and `X-Alfred-Resend-Edits:
      <json>`. It **replaces** the original's `X-Request-Id` with a fresh UUID, which it returns
      as `newCallId`, because the proxy adopts that header as the new call's id.
    - The replacement is required: the proxy reuses `X-Request-Id` as the call id
      (`log_and_route.py:175-177`), and `call_metadata.id` is a plain `TEXT PRIMARY KEY` with a
      plain INSERT (`SqliteCallsRepository.java:216, 427-431`), so a reused id would collide.
    - Both addons read the two `X-Alfred-*` headers into the prepare payload (`resend_of`,
      `resend_edits`) and **strip** them before forwarding. This is a new pattern, recorded in
      Complexity Tracking.
  - **Bulk resend**: the frontend sends one call at a time, awaiting each response, which keeps
    the original order and shows progress. There is no backend job queue.
- **Alternatives considered**:
  - Sending from the browser: rejected. CORS applies, the browser has no route to `proxy:8080`,
    and no mitm trust.
  - Sending from the proxy addon: rejected, because the addon has no HTTP server (see
    `docs/interception.md`, Breakpoints).

## R13. "Resend with current session" lookups

- **Decision**:
  - A new in-port on backend-calls, `FindRecentRequestHeadersUseCase(host, headerNames,
    limit≤200)`, runs a metadata-first query:
    - the newest `call_metadata` rows for that host, filtered on `url`;
    - joined to `call_request.headers` only for those ≤200 rows;
    - `LIMIT` as a seatbelt, and bodies never selected.
  - backend-internal-calls scans its in-memory ring.
  - Session cycles scan the cycle's captured calls.
  - `backend-resend` reaches all three through a `SessionValueLookupPort` bridge in
    `backend-app`.
- **Rationale**: constitution principle II — no `readAll()` defaults, windowed SQL.

## R14. WebSocket recording

- **Decision**:
  - **Hooks**: the addons gain `websocket_start`, `websocket_message` and `websocket_end`. The
    handshake flow already produces an ordinary call (status 101), and that call id is reused.
  - **Delivery to the backend**: messages are **batched** onto the existing single webhook
    worker queue. A batch is flushed every 500 ms or 50 messages, to a new endpoint
    `POST {WEBHOOK_URL}/{callId}/ws-messages`. They are never posted one message at a time.
  - **Storage, outbound**: a new table `call_ws_message` in `calls.db`, with a per-connection
    cap (`alfred.calls.ws-max-messages`, default 1,000) and a dropped-message count on
    `call_metadata`.
  - **Storage, inbound**: a sibling NDJSON file, `internal-ws-messages.log`, with the same
    append-and-compact scheme as `internal-calls.log` and the same per-connection cap.
  - **Rules**:
    - MESSAGE-phase actions run in `websocket_message`, against the rules that matched the
      handshake. The matching rules are cached in `flow.metadata` at `websocket_start`.
    - A delay is `await asyncio.sleep` inside that connection's hook. mitmproxy handles one
      connection's messages in order, so later messages on that connection wait, and other
      connections do not.
    - "Drop" calls `message.drop()`.
  - **Frontend**: the call card shows "WebSocket · N messages". It fetches messages
    `GET /{calls|internal-calls}/{id}/ws-messages?offset&limit` on demand, and refreshes on a
    new payload-free `ws-messages-appended` event on the existing `/ws/calls` and
    `/ws/internal-calls` sockets. There is no polling.
- **Rationale**: this batching keeps the webhook worker linear, and matches the existing
  two-phase logging.

## R15. Inbound interception record (a prerequisite)

- **Decision**:
  - Add `interception` (the same shape as backend-calls' `CallInterception`, duplicated
    deliberately, as the slice already mirrors backend-calls) to:
    - backend-internal-calls' `CallRecord`;
    - `CompleteInternalCallRequestDto`;
    - its NDJSON lines (an additive field; older lines read as `null`);
    - the internal session-cycle capture.
  - `resend_of`, `resend_edits` and `ws_dropped` are added the same way.
- **Rationale**:
  - FR-020 and FR-021 require every new action to be visible on inbound calls.
  - Today the reverse addon sends `interception`, and the backend drops it
    (`dto/CompleteInternalCallRequestDto.java:10-14`). `docs/interception.md` lists this under
    "Intentionally left for later".

## R16. Matcher tests

- **Decision**:
  - `RuleMatch` gains `headers`, `query` and `cookies`: lists of `MatchTest{name, operator,
    value, caseSensitive}`, with operators `EXISTS | NOT_EXISTS | EQUALS | CONTAINS | MATCHES`.
  - In the proxy, `Match.matches` evaluates them **after** method, host and path, and every
    regex is compiled in `__init__`.
  - The signature changes from `(source, service_name, method, host, path)` to
    `(source, service_name, request)`. `InterceptionEngine._matching` is the only caller.
- **Rationale**: this fixes the `stopProcessing` precedence problem, because
  `_matching` breaks right after a match (`proxy/interception.py:926`), before any condition
  runs. It also follows docs/interception.md's "Adding a matcher" recipe, ordered by cost.
