# Feature Specification: Interception Rule Actions at Parity with mitmproxy

**Feature Branch**: `001-interception-mitmproxy-parity`
**Created**: 2026-09-23
**Status**: Draft
**Input**: User description: "@docs/feature-requests/interception-mitmproxy-parity.md" — add the
traffic-editing capabilities that Alfred's proxy engine supports but Alfred's interception rules do
not expose yet. Add them as new rule actions in the existing rule model.

## Context

Alfred's interception rules can already do the following to a call:
- delay it;
- set or remove request and response headers and query parameters;
- set a JSON field;
- replace a response body or status;
- mock or replace a response;
- simulate network failures;
- pause the call for a human to edit.

The proxy engine underneath can do more. Testers now use hand-written proxy scripts for those
extra cases. Those scripts bypass Alfred's rule editor, its validation, its safety controls and
its record of what a rule did to a call.

This feature closes that gap. Every new capability is a **rule action**. Each new action uses the
same matching, the same request and response lanes, the same conditions, the same per-action
on/off toggle, the same before/after record and the same pause flow as the existing actions.

## Clarifications

### Session 2026-09-23

- Q: Which targets may "rewrite URL" send a call to? → A: Any target except Alfred itself.
  Loopback, private and link-local addresses are allowed. This is an accepted risk for a tool
  that runs on a trusted network.
- Q: Which call logs can "answer with recorded call" (FR-011) pick from? → A: Both the
  outbound and the inbound call logs. Any recorded response can answer a rule of either
  direction.
- Q: What is the delivery scope of this feature? → A: All 12 capabilities (P1, P2 and P3) are
  delivered in this feature under one plan. The priorities set the build order, not the release
  boundaries.
- Q: How are find/replace patterns kept from freezing the proxy? → A: Patterns are literal text
  by default, and regex is opt-in. Save-time checks cap a pattern's length and reject nested
  quantifiers. Body edits run off the proxy's shared event loop, so a slow match delays only its
  own call.
- Q: How are secret values in a stored recorded response handled? → A: The user decides at save
  time, for each recorded call, whether to keep its secret header and cookie values. If the user
  keeps them, they are stored, served and exported with the rule verbatim. If not, they are
  stripped when the response is copied.
- Q: What storage limit applies to stored answers? → A: A cap per stored answer only,
  configurable at deploy time (default 10 MB). There is no cap on the total. Total size is
  bounded by the rule lifecycle, because an answer is deleted with the last rule that uses it.
- Q: Which previously excluded capabilities move into scope? → A: Resending logged calls
  (User Story 8, P3), WebSocket message recording and editing (User Story 9, P4) and HTTP
  trailers (User Story 10, P4).
- Q: Should rules match on headers, query parameters, cookies or the body? → A: Header, query
  and cookie matchers are added (User Story 11). There is no body matcher, because it would
  decode every body for every rule on every call. Body checks stay in conditions.
- Q: Should Alfred carry cookies or auth across calls automatically (sticky cookies/auth)? → A:
  No automatic sticky rule. Instead, Resend gets an explicit "resend with current session"
  option, scoped to the same host and session cycle (FR-040).
- Q: (from /speckit-analyze) Do WebSocket message actions work inside conditions? → A: No.
  Conditions test only request and response subjects; FR-014 is narrowed to match.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find and replace text in any body (Priority: P1)

A tester needs to change a value that is not in a JSON field. Examples: a token in an XML/SOAP
supplier payload, a date in a plain-text body, or a string repeated across a large response. The
tester adds a find/replace action to the request or the response. The action takes a pattern, a
replacement and an optional limit on how many matches to replace.

**Why this priority**: Supplier traffic is often not JSON. This is the largest single gap: with
no script, no current action can edit a non-JSON body partially.

**Independent Test**: Create a rule with a find/replace action on the response. Send a call
through Alfred. Confirm that the caller receives the edited body, that the body is still
readable when the original was compressed, and that the call log shows the before and after.

**Acceptance Scenarios**:

1. **Given** a rule that replaces the literal text `EUR` with `USD` in response bodies, **When** a matching call
   returns a compressed XML body with three occurrences, **Then** the caller receives a correctly
   decodable body with all three replaced, and the call log shows the original and edited body.
2. **Given** the same rule with a limit of 1, **When** the call returns, **Then** only the first
   occurrence is replaced.
3. **Given** a find/replace rule, **When** a call's body has no match, **Then** the body reaches
   the caller byte-for-byte unchanged, and the log records the action as skipped with the reason
   "no match".
4. **Given** a tester enters an invalid pattern, **When** they save the rule, **Then** the save is
   refused with a message that identifies the invalid pattern.

---

### User Story 2 - Re-route a call or change its method (Priority: P1)

A tester needs a call to reach a different target. Examples: the staging supplier instead of
production, another port, or a different path version. The tester may also need the call sent
with a different HTTP method, to see how the supplier reacts. The tester adds a "rewrite URL"
action (target parts or a URL pattern) or a "set method" action.

**Why this priority**: Pointing one supplier call at another environment, without redeploying
the application under test, is a frequent need. Today no rule can do it.

**Independent Test**: Create a rule that rewrites the host of one supplier call to a second
reachable host. Send the call. Confirm that the second host answered and that the log shows the
original and the rewritten target.

**Acceptance Scenarios**:

1. **Given** a rule that rewrites the host `api.supplier.com` to `staging.supplier.com`, **When**
   a matching call is made, **Then** the staging host receives it, the caller receives the staging
   host's response, and the call log shows both targets.
2. **Given** a rule that rewrites a URL by pattern (`/v1/` to `/v2/`), **When** a matching call is
   made, **Then** the path is rewritten and every other part of the URL is kept.
3. **Given** a rule that changes the method from `POST` to `PUT`, **When** a matching call is
   made, **Then** the target receives a `PUT` with the original body, and the log shows both
   methods.
4. **Given** a rewrite rule whose target is Alfred itself, **When** the tester saves it, **Then**
   the save is refused, because such a rule would loop.
5. **Given** a rewrite action with no target part and no pattern, **When** the tester saves it,
   **Then** the save is refused.

---

### User Story 3 - Remove a JSON field, or replace the whole request body (Priority: P1)

A tester needs to prove how the application handles a field that is *missing* from a supplier
reply, which differs from a field that is present with a null value. A tester may also need to
send the supplier a completely different request body. The tester adds a "remove JSON field"
action, or a "set request body" action.

**Why this priority**: Many supplier contract bugs are "field missing" bugs. The current actions
can only set a field, so this is a gap in the core data-editing feature.

**Independent Test**: Create a rule that removes `itinerary.seatsRemaining` from a response.
Send a call. Confirm that the key is absent, not null, and that nothing else changed.

**Acceptance Scenarios**:

1. **Given** a rule that removes `segments[*].cabin` from responses, **When** a matching response
   has three segments, **Then** the `cabin` key is absent from all three, and every other field is
   unchanged.
2. **Given** a remove-field rule, **When** the path does not exist in the body, **Then** the body
   is unchanged and the action is recorded as skipped.
3. **Given** a "set request body" rule, **When** a matching call is made, **Then** the target
   receives the configured body with a correct length, and the log shows both bodies.

---

### User Story 4 - Edit cookies and form fields (Priority: P2)

A tester needs to change one cookie on a request, or one `Set-Cookie` the supplier sends back.
Examples: expire a session, drop a consent cookie, or change a cookie attribute. A tester may
also need to edit one field of a submitted form. The tester adds a cookie action or a form-field
action, and no other part of the header or body changes.

**Why this priority**: Sessions and form posts are common in the projects Alfred fronts. Today,
editing them means rewriting a whole header or body by hand. This matters most for inbound
traffic.

**Independent Test**: Create a rule that removes one named request cookie. Send a call with
three cookies. Confirm that the target receives the other two cookies unchanged.

**Acceptance Scenarios**:

1. **Given** a rule that removes the request cookie `consent`, **When** a call carries `session`,
   `consent` and `theme`, **Then** the target receives `session` and `theme` byte-for-byte
   unchanged.
2. **Given** a rule that sets response cookie `session` with `Max-Age=0`, **When** a matching
   response returns, **Then** the caller receives a `Set-Cookie` that expires `session`, and any
   other `Set-Cookie` headers are kept.
3. **Given** a rule that sets form field `amount` to `0`, **When** a matching call submits a
   URL-encoded or multipart form, **Then** only that field changes.
4. **Given** a form-field rule, **When** the matching call's body is not a form, **Then** the body
   is unchanged and the action is recorded as skipped with the reason "not a form".
5. **Given** a cookie action, **When** the call is logged or exported, **Then** the cookie value
   is shown as "(value not logged)" and never in clear text.

---

### User Story 5 - Control caching and compression (Priority: P2)

A tester needs full response bodies every time, not "not modified" replies. A tester may also
need to see how the application handles a response compressed differently than usual, or not
compressed at all. The tester adds a "disable cache", "disable compression" or "set response
encoding" action.

**Why this priority**: Cached `304` replies hide the data under test. Decompression bugs are a
real class of client failure that cannot be reproduced today without a script.

**Independent Test**: Create a "disable cache" rule. Send a call that carries conditional
headers. Confirm that the target returns a full body instead of "not modified".

**Acceptance Scenarios**:

1. **Given** a "disable cache" rule, **When** a call carries conditional-request headers, **Then**
   those headers are removed before forwarding, and the log shows the removal.
2. **Given** a "disable compression" rule, **When** a call is forwarded, **Then** the target is
   asked for an uncompressed response.
3. **Given** a "set response encoding" rule set to `gzip`, **When** a plain response returns,
   **Then** the caller receives a gzip-encoded body with matching encoding headers, which decodes
   to the original content.
4. **Given** an encoding Alfred does not support, **When** the tester saves the rule, **Then** the
   save is refused.

---

### User Story 6 - Answer with a response Alfred already recorded (Priority: P3)

A tester has found a supplier response in Alfred's call log that reproduces a bug, for example
the response captured yesterday. The tester wants later calls answered with that response, either
*instead of* calling the supplier or *after* calling it. The tester picks the recorded call in the
rule editor. The tester may also ask for the response's dates and cookie expiries to be moved
forward to the present.

**Why this priority**: High value for reproducing bugs, but it depends on the stored-body
handling that P1 and P2 do not need, so it comes after them.

**Independent Test**: Choose a logged call. Create a rule that answers with its response instead
of the host. Send a matching call with the supplier unreachable. Confirm that the caller receives
the recorded response.

**Acceptance Scenarios**:

1. **Given** a rule that answers "instead of the host" with recorded call X, **When** a matching
   call is made, **Then** the caller receives X's status, headers and body, the supplier is never
   contacted, and the log states that.
2. **Given** the "after the host" variant, **When** a matching call is made, **Then** the real
   supplier call happens and is logged, and the caller receives X's response.
3. **Given** "refresh dates" is on, **When** the recorded response is served, **Then** its date,
   expiry and cookie-expiry values are shifted by the time since recording.
4. **Given** the recorded call is later deleted from the log or evicted by retention, **When** the
   rule fires, **Then** it still serves the response, because the response was copied when the
   rule was saved.
5. **Given** a rule that answers with a response recorded from an **inbound** call to a project
   Alfred fronts, **When** a matching call is made, **Then** the caller receives that response.
   This works for outbound and inbound rules.
6. **Given** the chosen recorded response carries a `Set-Cookie` session token, **When** the
   tester saves the rule, **Then** Alfred names the secret values and asks whether to keep them.
   If the tester chooses strip, the served response has no such values. If the tester chooses
   keep, the values are served, and a rule export contains them.

---

### User Story 7 - Answer with an uploaded file (Priority: P3)

A tester has a fixture file, for example a large canned supplier response, and wants matching
calls answered with it. The tester uploads the file in the rule editor and sets the status and
content type.

**Why this priority**: Useful for large or binary fixtures that are hard to paste into a mock
body. The need is less common than the stories above.

**Independent Test**: Upload a file. Create a rule that answers with it. Send a matching call.
Confirm that the caller receives the file's bytes with the configured status and content type.

**Acceptance Scenarios**:

1. **Given** an uploaded 5 MB JSON fixture and a rule that answers with it at status 200, **When**
   a matching call is made, **Then** the caller receives the exact bytes, and the supplier is
   never contacted.
2. **Given** a file larger than the per-answer size cap, **When** the tester uploads it, **Then** the
   upload is refused with the limit stated.
3. **Given** a rule that refers to a file that no longer exists, **When** the tester saves the
   rule, **Then** the save is refused.

---

### User Story 8 - Resend a logged call through Alfred (Priority: P3)

A tester finds a call in Live Calls or in a session cycle and wants to send it again. The tester
may want it unchanged, to see whether the problem repeats. The tester may instead edit it first,
changing a header, a query parameter or the body. The tester presses **Resend** on the call.
The call goes out again through Alfred, the current interception rules apply to it, and the new
exchange appears in the log linked to the original.

This is different from Alfred's existing cURL and Postman exports. Those produce commands that
the tester runs outside Alfred, straight against the real supplier. So the resent call is not
logged, no rule applies to it, and nothing links it to the original.

**Why this priority**: It completes the loop of reproducing a bug: find the call, change one
thing, send it again and compare. It reuses the log and the rules but needs a new "send" path,
so it comes after the rule actions.

**Independent Test**: Choose a logged outbound call and press Resend. Confirm that the supplier
receives the same request, that a new call appears in the log marked as a resend of the
original, and that the two responses can be compared.

**Acceptance Scenarios**:

1. **Given** a logged outbound call, **When** the tester resends it unchanged, **Then** the
   supplier receives the same method, URL, headers and body, and a new logged call is linked to
   the original.
2. **Given** the tester edits a header before resending, **When** the call is sent, **Then** the
   edited header is sent, and the new call's record shows what was edited compared with the
   original.
3. **Given** an enabled rule matches the resent call, **When** it is resent, **Then** the rule
   applies, exactly as it would to live traffic.
4. **Given** a logged inbound call to a project Alfred fronts, **When** the tester resends it,
   **Then** it goes to that project through the same listener, and it is logged as inbound.
5. **Given** the tester selects several calls, **When** they choose Resend, **Then** the calls
   are sent one at a time in their original order, and each new call is linked to its original.
6. **Given** a logged call from a session cycle whose session cookie has since expired, and a
   newer call to the same host in that cycle carrying a fresh session cookie, **When** the
   tester chooses "resend with current session", **Then** the resent call carries the fresh
   cookie, and the tester is shown which call the value came from (the value itself stays
   masked).
7. **Given** "resend with current session" is chosen, **When** no newer value exists for that
   host in the scope, **Then** the call is resent with its original values, and the tester is
   told that no newer session was found.

---

### User Story 9 - View and edit WebSocket messages (Priority: P4)

A project that Alfred fronts, or a supplier, talks over a WebSocket. Today Alfred passes that
traffic through but records nothing after the opening handshake. A tester wants to see each
message in each direction. The tester also wants rules that edit, delay or drop individual
messages.

**Why this priority**: WebSocket traffic is less common than HTTP calls in the projects Alfred
fronts. Editing messages is useless until the messages can be seen, so this story includes
recording them. That makes it the largest single addition, so it is built last.

**Independent Test**: Open a WebSocket through Alfred and exchange messages. Confirm that the
connection appears in Live Calls with its messages in order and each direction marked. Then add
a rule that replaces text in server messages, and confirm that the client receives the edited
text.

**Acceptance Scenarios**:

1. **Given** a WebSocket opened through Alfred, **When** messages flow in both directions,
   **Then** the connection appears as one entry in the log, with every message, its direction,
   its time and its type (text or binary).
2. **Given** a rule whose match covers the WebSocket's opening request, with a "replace text in
   message" action for server messages, **When** a server message contains the text, **Then**
   the client receives the edited message, and the log shows the original and the edited
   version.
3. **Given** a "drop message" action for client messages that contain `ping`, **When** the
   client sends one, **Then** the server never receives it, and the log records it as dropped.
4. **Given** a "delay message" action, **When** a matching message passes, **Then** it arrives
   late by the configured time, and other connections are not delayed.
5. **Given** a long-lived connection that exceeds the per-connection message cap, **When** more
   messages arrive, **Then** the oldest recorded messages are dropped from the log, and the log
   shows how many were dropped. The messages themselves still pass through.

---

### User Story 10 - Edit HTTP trailers (Priority: P4)

A tester working with a streaming or HTTP/2 endpoint needs to set or remove a trailer, such as a
checksum or a status sent after the body.

**Why this priority**: Suppliers rarely use trailers, but the action is cheap. It follows the
same shape as the existing header actions.

**Independent Test**: Create a rule that sets a response trailer. Call an endpoint that sends
trailers. Confirm that the client receives the edited trailer.

**Acceptance Scenarios**:

1. **Given** a rule that removes the response trailer `grpc-status`, **When** a matching
   response carries it, **Then** the client receives the response without that trailer.
2. **Given** a trailer action, **When** the message carries no trailers, **Then** the message is
   unchanged, and the action is recorded as skipped.

---

### User Story 11 - Match rules on headers, query parameters and cookies (Priority: P2)

A tester wants a rule to apply only to calls that carry a specific header, query parameter or
cookie. Examples: only calls with `x-test-scenario: timeout`, only `?mode=sandbox`, only a
session with cookie `tenant=acme`. Today this is possible only with a condition inside the rule.
A rule that has "stop processing" set then stops later rules for every call to the host, even
calls that don't carry the value. The tester adds the header, query or cookie test to the rule's
match itself.

**Why this priority**: It fixes a real precedence problem that conditions cannot fix, and it
makes rules say what they apply to. It is cheap to evaluate.

**Independent Test**: Create a rule with "stop processing" that matches the host plus header
`x-test` exists, and a second lower-priority rule on the same host. Send one call with the
header and one without. Confirm that the first rule applies only to the call with the header,
and that the second rule still applies to the call without it.

**Acceptance Scenarios**:

1. **Given** a rule matching header `x-test-scenario` equals `timeout`, **When** a call arrives
   without that header, **Then** the rule does not apply, and its "stop processing" does not
   block later rules.
2. **Given** a rule matching query parameter `mode` equals `sandbox`, **When** a call has
   `?mode=sandbox`, **Then** the rule applies.
3. **Given** a rule matching cookie `tenant` exists, **When** a call carries the cookie, **Then**
   the rule applies, and the rule's plain-language description names the cookie but never its
   value.
4. **Given** a rule with a matcher regex that is invalid or has nested quantifiers, **When** the
   tester saves it, **Then** the save is refused.

---

### Edge Cases

- **Two actions that answer the call in one rule**: for example, "answer with file" and
  "mock response". The save is refused, as for the existing terminal actions.
- **An earlier rule already chose "send to host"**: a later rule's "answer with recorded call"
  or "answer with file" (instead of the host) is refused for that call and recorded as refused.
  This matches the existing latch.
- **Streamed or very large bodies**: find/replace, remove-field and form edits on a body the
  proxy did not buffer are skipped and recorded as skipped. They are never applied partially.
- **A regex pattern that could run for a very long time** (catastrophic backtracking): refused
  at save time when it is too long or has nested quantifiers. A slow pattern that passes these
  checks delays only the call it runs on. Other calls in flight are not affected.
- **A recorded response with no secret values**: no keep/strip question is asked.
- **A recorded response larger than the per-answer cap**: the save is refused with the cap and
  the response size stated, exactly as for an oversized upload.
- **A rule with kept secrets is imported on another machine**: the values arrive with the rule,
  as the user chose at save time. The imported rule's editor shows that secrets were kept.
- **A literal pattern that contains regex characters** (for example `$10.00`): it matches as
  plain text unless the user has opted into regex.
- **An older proxy container that reads rules with new actions** (partial deploy): it skips the
  unknown actions, records them as skipped, and applies every other action normally.
- **A rewrite that changes only the path**: scheme, host, port and query are kept.
- **A rewrite that changes the host**: the tester chooses whether the original `Host` header is
  kept or follows the new target. The default is that it follows the new target.
- **Actions inside conditions**: every new request- and response-phase action works inside an
  "if request" or "if response" branch of its phase. WebSocket message actions are not allowed
  there (FR-014). Every action is skipped when its own toggle is off.
- **A call that is paused and edited by hand after these actions ran**: the edited version is
  what the caller receives. The before/after record shows the rule's change and the human edit.

## Requirements *(mandatory)*

### Functional Requirements

**New actions**

- **FR-001**: Users MUST be able to add a find/replace action to the request or the response.
  The action takes a pattern, a replacement, an optional case-sensitivity setting and an optional
  maximum number of replacements. By default the pattern matches as literal text. The user can
  opt into regex matching; only then can the replacement reuse matched groups.
- **FR-002**: Users MUST be able to add an action that replaces the whole request body.
- **FR-003**: Users MUST be able to add an action that removes a JSON field from the request or
  the response. The action uses the same field-path grammar as the existing "set JSON field"
  action, including `[index]` and `[*]`.
- **FR-004**: Users MUST be able to add a "rewrite URL" action. The action changes any
  combination of scheme, host, port and path, or applies a pattern and a replacement to the full
  URL. Any target is allowed except Alfred itself (its backend, gateway and proxy listeners).
  Loopback, private-network and link-local targets are not restricted.
- **FR-005**: Users MUST be able to add a "set method" action that changes the request's HTTP
  method.
- **FR-006**: Users MUST be able to set or remove one named cookie on the request, and one named
  `Set-Cookie` on the response. Response cookies accept these optional attributes: path, domain,
  max-age, secure, http-only and same-site.
- **FR-007**: Users MUST be able to set or remove one text field of a URL-encoded or multipart
  form request body.
- **FR-008**: Users MUST be able to add a "disable cache" action that removes the conditional
  request headers.
- **FR-009**: Users MUST be able to add a "disable compression" action that asks the target for
  an uncompressed response.
- **FR-010**: Users MUST be able to add a "set response encoding" action. The allowed values are
  `gzip`, `deflate`, `br`, `zstd` and `identity`, limited to the encodings the proxy can produce.
- **FR-011**: Users MUST be able to add an "answer with recorded call" action. The user picks a
  call from Alfred's outbound or inbound call log. The chosen response can answer a rule of
  either direction. There are two variants: "instead of the host", which ends
  the request phase, and "after the host", which replaces the real response. An optional "refresh
  dates" setting is available.
- **FR-012**: Users MUST be able to upload a file and add an "answer with file" action that
  serves it with a chosen status and content type, instead of contacting the host.

**Behaviour shared by every new action**

- **FR-013**: Each new action MUST appear in the rule editor in its correct lane (request or
  response). Each action MUST have in-editor help with a worked example on a realistic supplier
  payload.
- **FR-014**: Each new request- or response-phase action MUST work inside an "if request" or
  "if response" branch of its own phase. Every new action, including the WebSocket message
  actions, MUST honour its own on/off toggle. WebSocket message actions (FR-033) are not allowed
  inside conditions, because conditions have no message subjects to test.
- **FR-015**: Each new action that changes a call MUST appear in the call's before/after record.
  An action that finds nothing to change MUST be recorded as skipped with a reason. It MUST NOT
  fail silently or change the call partially.
- **FR-016**: A body that no action changed MUST reach its destination byte-for-byte unchanged.
- **FR-017**: A body edit on a compressed body MUST produce a body that the receiver can still
  decode, with correct length and encoding headers.
- **FR-018**: Saving a rule MUST fail, with a message that names the problem, when any of these
  is true:
  - an action lacks its required values;
  - a regex pattern is invalid, exceeds the pattern-length limit, or contains a nested
    quantifier (a repeated group that itself repeats, such as `(a+)+`);
  - a rewrite has no target;
  - a rewrite targets Alfred itself;
  - a referenced recorded call or file does not exist;
  - an encoding is unsupported;
  - two actions in one rule both answer the call.
- **FR-019**: "Answer with recorded call" (instead of the host) and "answer with file" MUST
  follow the same rules as the existing mock action. They end the request phase, they conflict
  with another terminal action in the same rule, and an earlier "send to host" latch refuses
  them.
- **FR-020**: Every new action MUST work for outbound calls (application to supplier) and for
  inbound calls (into a project Alfred fronts).
- **FR-021**: The call log and every export (Markdown, HTML, JSON) MUST show what each new
  action did, without truncating call data. A JSON export with the new records MUST still
  re-import.
- **FR-022**: From this release on, a proxy that reads rules with actions it does not know MUST
  skip those actions and record them as skipped. Proxies from earlier releases already skip them,
  but silently. Rules that use only existing actions MUST behave exactly as
  before.

**Security**

- **FR-023**: Cookie values, authorization values, and any value that a secret-bearing header or
  cookie receives MUST be shown as "(value not logged)" in call logs and exports.
- **FR-024**: Only Alfred's own upload flow can add files. Uploads MUST respect the per-answer
  size cap (FR-027) and MUST be checked for content type. A file reference MUST NOT be able to reach any file outside Alfred's
  own fixture store.
- **FR-025**: The response stored for "answer with recorded call" MUST be copied when the rule is
  saved. Later deletion or eviction of the original call MUST NOT affect the rule.
- **FR-026**: When the user saves an "answer with recorded call" action, and the chosen response
  contains secret values (`Set-Cookie`, authorization or other secret-bearing headers), Alfred
  MUST list those values by name and ask whether to keep them. There is no default: the user
  must choose.
  - **Keep**: the values are stored, served to callers, and included in rule export and
    duplicate verbatim. The prompt states that they will travel with the rule.
  - **Strip**: the values are removed when the response is copied. They never reach the
    stored answer.
  Either way, FR-023 still masks them in call logs and call exports. The choice is recorded on
  the stored answer and is shown in the rule editor.
- **FR-027**: Every stored answer, whether uploaded or copied from a recorded call, MUST be at
  most the per-answer size cap (configurable at deploy time, default 10 MB). An upload or a copy
  over the cap MUST be refused, and the message MUST state the cap and the answer's size. There
  is no cap on the total size of stored answers. The retention policy is that a stored answer is
  deleted when the last rule that refers to it is deleted.

**Resend (User Story 8)**

- **FR-028**: Users MUST be able to resend one or more logged calls (outbound or inbound) from
  Live Calls and from a session cycle. Resent calls MUST go out through the same Alfred proxy
  direction as the original, so that enabled rules apply and the new exchange is logged.
- **FR-029**: Before resending a single call, users MUST be able to edit its method, URL,
  headers and body. The new call's record MUST show what differs from the original.
- **FR-030**: Each resent call MUST be logged as a new call, marked as a resend and linked to its
  original. A selection of several calls MUST be resent one at a time in its original order.
- **FR-031**: Resending MUST be an explicit user action. Nothing resends calls automatically.
  Secret values in the original are sent as they were logged, and FR-023 masking still applies
  to the new call's log entry.

**WebSocket messages (User Story 9)**

- **FR-032**: Alfred MUST record each WebSocket connection that passes through either proxy as
  one log entry, with every message, its direction, its time and its type. Each connection MUST
  have a message cap (configurable, default 1,000 messages). Beyond the cap, the oldest recorded
  messages are dropped from the log, and a count of dropped messages is kept. Traffic is never
  held back because of the cap.
- **FR-033**: Users MUST be able to add these message actions to a rule whose match covers the
  WebSocket's opening request: replace text in a message (literal by default, regex opt-in,
  under the same save-time checks as FR-001 and FR-018), drop a message, and delay a message.
  Each action applies to client messages, server messages or both.
- **FR-034**: A WebSocket message action MUST NOT delay any other connection. A message delay
  delays only the messages after it on the same connection, in their original order.
- **FR-035**: Message logs and exports MUST follow FR-021 (no truncation), subject to the FR-032
  cap. Message content is recorded as sent, like call bodies. FR-023 masking applies to the
  rule records of message actions: a pattern or replacement that names a secret header or
  cookie is masked there.

- **FR-040**: When resending, users MUST be able to choose "resend with current session". Alfred
  then replaces the call's session cookies and authorization header with the newest values seen
  for the same host, within the same session cycle (or, for a call from Live Calls, the newest
  logged call to that host). Alfred MUST show which call each value came from, and MUST keep the
  values masked. Nothing is carried across calls automatically: this happens only on an explicit
  Resend, and never to live traffic.

**Trailers (User Story 10)**

- **FR-036**: Users MUST be able to set or remove a named trailer on the request or the
  response. A message without trailers is left unchanged, and the action is recorded as skipped.

**Matchers (User Story 11)**

- **FR-037**: A rule's match MUST support optional header, query-parameter and cookie tests.
  Each test names a key and uses one of these operators: exists, not exists, equals, contains or
  matches (regex). A rule applies only when every test in its match holds.
- **FR-038**: Matcher regexes MUST pass the same save-time checks as FR-018 and MUST be compiled
  once when rules load. The new tests MUST run after the existing cheaper match fields, so a
  rule that fails on host or path costs no more than today.
- **FR-039**: A rule's plain-language description MUST state the new tests. Cookie and
  secret-header tests MUST name the key but never show the compared value in logs or exports.
  There is no body matcher; body tests remain conditions.

### Key Entities

- **Rule action**: one step in a rule's request or response lane. It has a type, its settings
  (for example pattern, replacement, target parts, cookie name and attributes, encoding, or a
  reference to a stored answer), and an on/off toggle. The new action types extend the existing
  set. They add no new kind of rule.
- **Stored answer**: a response body that a rule refers to but that is not written into the rule
  itself. It is either a copy of a recorded call's response (status, headers, body, recording
  time, source direction, and whether secret values were kept or stripped) or an uploaded
  fixture file (bytes, content type, size). It is owned by the rule that
  refers to it and is removed when no rule refers to it.
- **Resent call**: a new logged call created by a user's Resend. It links to its original call
  and records any edits made before sending.
- **WebSocket connection record**: one log entry per WebSocket connection. It holds the opening
  request, and an ordered, capped list of messages (direction, time, type, content, and the
  original content when a rule edited or dropped the message), plus a count of dropped entries.
- **Interception record**: the existing per-call record of what each rule did (applied, skipped
  with a reason, or refused), with the before and after versions of what changed. This feature
  adds new entry kinds.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When this feature is complete, every capability in User Stories 1 to 11 (P1 to P4)
  is available. Each one can be configured and verified from Alfred's UI alone, with no
  hand-written proxy script.
- **SC-008**: A resent call appears in the log, linked to its original, within the same time as
  a live call of the same size.
- **SC-009**: A WebSocket connection carrying 100 messages per second is recorded without
  message loss up to its cap, and without added latency to other connections. Testers need no hand-written proxy script for any of them.
- **SC-002**: A call that matches no rule sees no measurable change in latency compared with
  before this feature.
- **SC-003**: Body edits add no waiting across calls: 4 concurrent calls through a find/replace
  rule each finish in about the time of one call, not 4 times as long. A deliberately slow regex
  on one call does not add measurable latency to other calls in flight at the same time.
- **SC-004**: "Answer with recorded call" and "answer with file" (instead of the host) answer in
  the same latency class as the existing mock action (tens of milliseconds, with no supplier
  contact).
- **SC-005**: 100% of new action types have in-editor help and automated coverage. A missing
  entry fails the build.
- **SC-006**: A body up to 10 MB edited by find/replace or remove-field reaches the caller intact
  and decodable, and the before/after record holds both versions in full.
- **SC-007**: Zero secret values (cookies, authorization) appear in clear text in any call log or
  call export produced by the new actions. A stored answer never holds a secret value unless the
  user explicitly chose "keep" for it.

## Assumptions

- **Users**: developers and testers using Alfred's dashboard on a trusted network. Existing
  interception safety controls apply unchanged: interception is off by default, has a master
  switch, shows an always-visible banner and warns about paused calls. Because the network is
  trusted, "rewrite URL" does not restrict internal or metadata addresses (see Clarifications).
- **Recorded calls**: "answer with recorded call" chooses from the outbound and the inbound
  call logs. Both logs keep the full response of each call. The inbound log keeps only its most
  recent calls and evicts older ones within minutes on busy traffic. Copying the response when
  the rule is saved (FR-025) is therefore what keeps an inbound-sourced rule working.
- **Size limit**: each stored answer (an upload or a copied recorded response) has a cap of
  10 MB by default, configurable at deployment time. There is deliberately no total cap (see
  Clarifications). Fixtures are text or binary; any content type is accepted if the user states
  it explicitly.
- **Stored answers**: a stored answer is deleted when the last rule that refers to it is deleted.
  Rule export and duplicate include the stored answer, so a rule moved between machines still
  works.
- **Host header on rewrite**: by default the `Host` header follows the new target. The user can
  keep the original.
- **Form edits**: only text fields change. Multipart file parts are not edited.
- **Encodings**: the set of encodings offered is limited to those the stock proxy image can
  produce. An encoding the image lacks is not offered.
- **Out of scope**:
  - **DNS and TLS faults**: the caller's handshake with Alfred has already succeeded, and an
    upstream-side failure reaches the caller as a reset or a 502, which the existing "simulate
    failure" modes already produce.
  - **Raw TCP, UDP or DNS editing**: Alfred logs HTTP, and now WebSocket, traffic only.
  - **Bandwidth throttling**: pacing a body in chunks would stall the proxy's shared event
    loop. "Delay response" remains the slow-supplier tool.
  - **Proxy upstream authentication**: this concerns chaining Alfred through another proxy,
    which Alfred never does.
  - **Automatic sticky cookies/auth**: the value would carry across calls and could leak one
    tester's session into another tester's live traffic. Replaced by the explicit "resend with
    current session" option (FR-040).
  - **Body matchers**: evaluating them would decode every body for every rule on every call.
    Body tests remain conditions.
- **Dependencies**:
  - the existing rule model, rule editor, conditions, before/after capture, rule
    export/import/duplicate, and the rules snapshot that both proxies read;
  - Alfred's outbound and inbound call logs, as the sources for recorded answers.
