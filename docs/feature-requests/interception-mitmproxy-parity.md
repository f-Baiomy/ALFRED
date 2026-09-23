# Feature request: interception rule actions at parity with mitmproxy

> Input for `/speckit-specify`. It describes WHAT to add and WHY, plus the constraints that
> already bind the interception feature. The HOW belongs in the plan, which must pass the
> constitution's gates (`.specify/memory/constitution.md`) and follow `docs/interception.md` →
> "Extending → Adding an action".

## Summary

Alfred's interception rules can delay, rewrite headers, query parameters and JSON fields, mock,
fail, replace and pause calls. mitmproxy, which both Alfred proxies run on, can do more to a
flow than Alfred exposes. Examples: regex body rewriting, URL re-routing (`map_remote`), serving
a stored file (`map_local`), replaying a recorded response (`server_replay`), cookie and form
editing, cache and compression stripping, and body re-encoding.

This feature adds those capabilities as new **rule actions** in the existing rule model. The
new actions use the same matchers, the request/response phase lanes, the `IF_REQUEST` /
`IF_RESPONSE` conditions, the per-action `enabled` toggle, before/after capture, and the
paused-call flow. No second mechanism is added.

## Why

- Testers need to change parts of a call that the current actions cannot reach. Examples: a
  token inside a non-JSON body, a form field, a cookie, the target host of a call, or the
  compression of a response.
- Some supplier faults can only be reproduced by redirecting or replaying traffic. Examples:
  "point this call at the staging supplier" and "answer with the exact response we captured
  yesterday".
- Today these cases need a hand-written mitmproxy script. That bypasses Alfred's logging of what
  a rule did, its UI, its validation, and its safety controls.

## Current state (inventory)

### Actions Alfred already has, and their mitmproxy equivalent

| Alfred action | Phase | mitmproxy equivalent |
|---|---|---|
| `DELAY_REQUEST` / `DELAY_RESPONSE` | req / resp | no built-in (addon `asyncio.sleep`) |
| `SET_REQUEST_HEADER` / `REMOVE_REQUEST_HEADER` | req | `modify_headers` (`~q`) |
| `SET_RESPONSE_HEADER` / `REMOVE_RESPONSE_HEADER` | resp | `modify_headers` (`~s`) |
| `SET_QUERY_PARAM` / `REMOVE_QUERY_PARAM` | req | `Request.query` |
| `SET_REQUEST_JSON_FIELD` / `SET_RESPONSE_JSON_FIELD` | req / resp | no built-in (script on `content`) |
| `SET_RESPONSE_BODY` | resp | `Response.set_text` / `content` |
| `SET_RESPONSE_STATUS` | resp | `Response.status_code` (Alfred also fixes the reason phrase) |
| `MOCK_RESPONSE` | req | `Response.make` in `request`; `block_list` with a status |
| `REPLACE_RESPONSE` | resp | `Response.make` in `response` |
| `SIMULATE_FAILURE` (`CONNECTION_RESET`, `HANG_THEN_DROP`, `HANG_UNTIL_CALLER_GIVES_UP`, `EMPTY_REPLY`, `TRUNCATED_BODY`, `GATEWAY_ERROR`) | req | `flow.kill()`; `block_list` status `444` |
| `ABORT_REQUEST` (legacy, hidden) | req | `flow.kill()` |
| `SEND_TO_HOST` (latch) | req | none (Alfred-specific) |
| `PAUSE_REQUEST` / `PAUSE_RESPONSE` | req / resp | `intercept` + `flow.intercept()` / `resume()` |
| `IF_REQUEST` / `IF_RESPONSE` | req / resp | filter expressions (`~h`, `~b`, `~s`, …), in part |

### mitmproxy capabilities Alfred does not expose yet

Source: mitmproxy docs (Features, Options, Event Hooks, `mitmproxy.http` API).

| mitmproxy capability | What it does |
|---|---|
| `modify_body` | Regex find/replace in a request or response body, with an optional replacement read from a file |
| `map_remote` | Regex rewrite of the request URL before sending, which re-routes to another scheme, host, port or path |
| `map_local` | Answers from a local file or directory instead of the upstream |
| `server_replay` (+ `server_replay_refresh`) | Answers with a previously recorded response and refreshes its date, expiry and cookie times |
| `client_replay` | Re-sends recorded requests |
| `anticache` | Strips `If-None-Match` / `If-Modified-Since` so the upstream cannot answer `304` |
| `anticomp` | Forces `Accept-Encoding: identity` |
| `Response.encode` / `decode` | Re-encodes a body as gzip, deflate, br, zstd or identity |
| `Request.method`, `url`, `host`, `port`, `scheme`, `path` | All writable |
| `Request.cookies` / response `Set-Cookie` (`Response.cookies`) | Cookie editing |
| `Request.urlencoded_form` / `multipart_form` | Form field editing |
| `Request.set_content` / `set_text` | Whole request body replacement |
| `trailers` | HTTP trailers, writable in `request` / `response` |
| `stickycookie` / `stickyauth` | Replays the last seen cookie or `Authorization` header onto later requests |
| `upstream_auth` | Adds proxy Basic auth to upstream calls |
| `stream_large_bodies` / `.stream` | Streams a body without buffering it (body edits then no longer apply) |
| WebSocket / TCP / UDP / DNS / TLS hooks | Message-level and connection-level interception for non-HTTP traffic |

## Scope: new actions to add

Priority is the order to build in. Each item states the user outcome. Field names are
suggestions for the spec. The plan decides the final names, which become the wire format.

### P1: body, URL and method edits (the most common gap)

1. **`REPLACE_IN_REQUEST_BODY` / `REPLACE_IN_RESPONSE_BODY`**: regex find/replace in the body,
   for any content type (the `modify_body` equivalent). Fields: `pattern`, `replacement`
   (supports group references), an optional `caseSensitive` flag, and an optional `maxReplacements`
   (default: all). The regex compiles once at rule load. A body with no match stays
   byte-identical. The body is decoded before the edit and re-encoded to its original
   `Content-Encoding` after it. `Content-Length` stays correct.
2. **`SET_REQUEST_BODY`**: replaces the whole outgoing request body. This mirrors `SET_RESPONSE_BODY`.
3. **`REMOVE_REQUEST_JSON_FIELD` / `REMOVE_RESPONSE_JSON_FIELD`**: deletes a key or array element
   by the existing dotted path grammar. This differs from setting a field to `null`, and many
   supplier contract bugs are "field missing" rather than "field null".
4. **`REWRITE_URL`** (the `map_remote` equivalent): sends the request to a different target.
   Two forms:
   - structured: any of `scheme`, `host`, `port`, `path`;
   - regex: `pattern` + `replacement` applied to the full URL.
   The call log records both the original and the rewritten target. Keeping the `Host` header
   is an explicit choice.
5. **`SET_METHOD`**: changes the HTTP method, for example to test how a supplier handles `PUT`
   against a `POST`-only endpoint.

### P2: cookies, forms, caching, encoding

6. **`SET_REQUEST_COOKIE` / `REMOVE_REQUEST_COOKIE`**: edits one cookie in the `Cookie` header
   without rewriting the whole header.
7. **`SET_RESPONSE_COOKIE` / `REMOVE_RESPONSE_COOKIE`**: adds, replaces or expires one
   `Set-Cookie` by name, with optional attributes (`Path`, `Domain`, `Max-Age`, `Secure`,
   `HttpOnly`, `SameSite`).
8. **`SET_FORM_FIELD` / `REMOVE_FORM_FIELD`**: edits `application/x-www-form-urlencoded` and
   `multipart/form-data` fields (text fields only). The action is skipped, and the skip is
   recorded, when the body is not a form.
9. **`DISABLE_CACHE`** (the `anticache` equivalent): strips conditional request headers, so the
   upstream always returns a full body.
10. **`DISABLE_COMPRESSION`** (the `anticomp` equivalent): forces `Accept-Encoding: identity`.
11. **`SET_RESPONSE_ENCODING`**: re-encodes the response body as `gzip`, `deflate`, `br`, `zstd`
    or `identity`, to test a client's decompression handling. The action is limited to the
    encodings the stock mitmproxy image supports.

### P3: canned and replayed answers

12. **`RESPOND_WITH_RECORDED_CALL`** (the `server_replay` equivalent, Alfred-shaped): answers
    with the response of a call Alfred already logged, chosen by call id in the editor. There
    are two variants, *instead of the host* (request phase, terminal, like `MOCK_RESPONSE`) and
    *after the host* (response phase, like `REPLACE_RESPONSE`). There is also an optional
    "refresh dates" flag, the same as `server_replay_refresh`.
13. **`RESPOND_WITH_FILE`** (the `map_local` equivalent): answers with a file the user uploaded
    through Alfred. The action sets a content type and a status.

Both P3 actions reference a stored body. Bodies MUST NOT be inlined into `rules.json`, because
the snapshot is re-read by both proxies and must stay small. The backend publishes each
referenced body as its own file beside the snapshot, written atomically in the same directory
mount. The proxy reads each file cached by mtime, the same pattern as `rules.json`.

## Out of scope (with reason)

- **DNS and TLS faults**: the caller has already completed its handshake with Alfred. See
  `docs/interception.md` → "Failures that are not a status code".
- **Raw TCP/UDP and DNS flow editing**: Alfred proxies and logs HTTP only.
- **WebSocket message editing**: Alfred does not log WebSocket frames today. Editing frames
  would need logging support first, so it is a separate feature.
- **Client replay** (re-sending a logged call): useful, but it is a user-triggered command, not
  something a rule does to a passing call. It is a separate feature.
- **`stickycookie` / `stickyauth`**: state that carries across flows. Rules are stateless per
  call. `SET_REQUEST_COOKIE` / `SET_REQUEST_HEADER` cover the deterministic cases.
- **`upstream_auth`**: already covered by `SET_REQUEST_HEADER` on `Authorization`.
- **Bandwidth throttling through streaming**: mitmproxy's `.stream` callable is synchronous and
  cannot `await`. Throttling inside it would block the event loop that serves every connection.
  `DELAY_RESPONSE` remains the supported slow-supplier tool.
- **Trailers editing**: rare in supplier traffic (HTTP/2 or gRPC only). Revisit on demand.
- **New matchers** (header, body, cookie): still deliberately absent. Conditions cover these.

## Functional requirements

- **FR-1**: Each new action is selectable in the rule editor in the correct phase lane. Each
  action has an ⓘ help entry in `interception-help.ts` with a worked example on a realistic
  supplier payload.
- **FR-2**: Each new action works inside `IF_REQUEST` / `IF_RESPONSE` branches and honours the
  per-action `enabled` flag.
- **FR-3**: Each action that changes a call produces a before/after record through the existing
  generic capture. An action that finds nothing to change (no regex match, no such cookie, a
  body that is not a form) is recorded as skipped with a reason. It never fails silently.
- **FR-4**: Backend validation rejects an incomplete action at save time. Examples: an invalid
  regex, a `REWRITE_URL` with no target part, a file or call reference that does not exist, and
  an unknown encoding.
- **FR-5**: Terminal semantics stay consistent. `RESPOND_WITH_RECORDED_CALL` (instead of host)
  and `RESPOND_WITH_FILE` are terminal. They respect the `SEND_TO_HOST` latch, and they conflict
  with another terminal in the same rule.
- **FR-6**: Actions work in both directions (`proxy` outbound and `reverse-proxy` inbound)
  through the shared engine in `proxy/interception.py`.
- **FR-7**: The call log and all exports (.md/.json/.html) show what each new action did, with
  no truncation. The .json export still re-imports.
- **FR-8**: An older proxy that reads a newer rules file skips the unknown actions and records
  them as skipped. Stored rules that use only existing actions behave exactly as before.

## Non-functional requirements (from the constitution)

- **Security**: values such as cookie values, `Authorization` values and replacement strings
  that match a secret header are masked in the interception record as `(value not logged)`.
  `RESPOND_WITH_FILE` accepts uploads only through the backend, with a size cap and a content-
  type check. It stores them under a proxy-mounted directory it owns, and it rejects path
  traversal. `REWRITE_URL` cannot target the Alfred backend or gateway itself (loop and SSRF
  guard). Regex patterns have a length cap to limit catastrophic-backtracking risk.
- **Performance**: no action blocks the event loop. Every regex and URL template compiles once
  at rule load, never per request. Body edits leave an unmatched body byte-identical and do not
  re-serialise it. Stored bodies for the P3 actions are cached by mtime and never embedded in
  the snapshot. A no-rule call keeps its current single-dict-lookup cost.
- **Architecture**: the backend changes stay in `backend-interception` (leaf slice, no new
  cross-slice edge). `RESPOND_WITH_RECORDED_CALL` copies the chosen response when the rule is
  saved, through a port implemented in `backend-app` (the composition root). This is because
  `interception` must stay isolated from `calls`. The wire names are added to `ActionType` and
  to `REQUEST_ACTIONS` / `RESPONSE_ACTIONS` together.
- **Stock image**: the proxy still runs the stock `mitmproxy/mitmproxy` image with no pip step.
  Only the standard library and mitmproxy APIs are allowed.

## Acceptance criteria

- Every new action is in `EveryActionIsCoveredTest.SAMPLES` and in the frontend help coverage
  spec. The build fails if either is missing.
- `RuleValidatorTest` covers each new action's required fields and rejection cases.
- A concurrency test shows that body and URL actions add no serialisation across concurrent
  flows.
- Live checks, recorded in `docs/interception.md` in the style of the existing measured claims:
  - a regex replace edits a gzip response and the client still decodes it;
  - `REWRITE_URL` reaches the alternative host and the log shows both targets;
  - `RESPOND_WITH_RECORDED_CALL` answers with no upstream contact and within the same latency
    class as `MOCK_RESPONSE`;
  - a cookie removal leaves the other cookies byte-identical.
- `docs/interception.md` (Actions table, Extending section) and the "Intentionally left for
  later" list are updated in the same change.
