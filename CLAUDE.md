# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Alfred is a reverse-mode mitmproxy setup that transparently intercepts and logs every HTTPS request/response a Java app sends to any supplier whose configured hostname ends in `-proxy`. It requires zero configuration changes in the Java app itself — no proxy settings, no code changes. Instead, a hosts-file redirect plus a trusted CA cert make the app think it's talking directly to the real supplier.

Three Docker services (see `docker-compose.yml`):
- **alfred** (mitmproxy, port 8444->8080) — intercepts, dynamically routes `*-proxy` hostnames to their real backend by stripping the suffix, and logs full request/response data as JSON lines to `proxy/logs/calls.log`.
- **pennyworth** (Spring Boot backend, port 5000, hexagonal/ports-&-adapters architecture — see below) — reads `calls.log` and serves it over a small HTTP API (`GET /calls`, `GET /health`), plus a small comments API (`GET/POST /comments`, `DELETE /comments/{id}`) backed by a flat JSON file (`backend/data/comments.json`, writable volume — see docker-compose.yml).
- **manor** (Angular dashboard, built and served via nginx, port 3000) — polls pennyworth every 5s and displays recent calls with syntax-highlighted flat/tree JSON views, per-block search, sort/pagination, pinning, supplier grouping, cURL/JSON export, and GitHub-style line comments for flagging issues to hand off to a support team.

## Commands

Cross-platform entry point (run from an Administrator/root terminal):

```bash
python3 start.py
```

This does all of the following, safe to re-run any time (already-done steps are skipped):
1. Adds missing `*-proxy` hosts entries from `suppliers.txt`
2. Runs `docker compose up -d --build` (generates the CA cert on first run)
3. Re-syncs the CA cert into the OS certificate store
4. Re-syncs the CA cert into every JDK listed in `jdks.txt`

It detects the OS and delegates to `start.ps1` (Windows, via `certutil`) or `start.sh` (Linux/macOS, via `update-ca-certificates`/Keychain, run with `sudo`).

To (re)start containers without redoing the hosts/cert steps:

```bash
docker compose up -d --build
```

Stop everything:

```bash
docker compose down
```

Watch logs live:

```bash
Get-Content .\proxy\logs\calls.log -Wait -Tail 20 | jq .
```

There is no test suite, linter, or build step for `alfred` beyond the Docker build itself. `pennyworth` and `manor` both have real test suites:

```bash
cd backend
mvn test            # JUnit 5 + Mockito + AssertJ - application services, file adapters, and a @WebMvcTest controller test
mvn package          # full build, produces the Spring Boot jar Docker packages

cd frontend
npm install
npm test           # ng test - Karma/Jasmine, watches by default
npm run build       # ng build - production build, output in dist/manor/browser
```

## Architecture notes

- **Routing happens in two places for a reason** (`proxy/log_and_route.py`): `server_connect` sets the actual TCP/TLS dial target using the client's TLS SNI (captured before the HTTP request is parsed), while `request()` rewrites the logical `flow.request.host`/`Host` header for logging consistency. In reverse mode, mutating `flow.request.host` alone does NOT change where mitmproxy actually connects — both hooks are required.
- **SNI, not `Host` header, is the source of truth** for the original hostname throughout the addon, since in reverse mode `flow.request.host` starts out pinned to the static placeholder (`https://placeholder.invalid`, set in the `mitmdump` command in `docker-compose.yml`).
- **Suppliers and JDKs are config, not code**: `suppliers.txt` lists real domains (no `-proxy` suffix — scripts add it), `jdks.txt` lists `JAVA_HOME` paths needing cert trust. Both support `#` comments and are re-read/re-applied idempotently on every `start.py` run.
- **Per-folder CA identity**: `proxy/certs/` holds a CA generated fresh on first container start, unique to that project folder. Only one Alfred folder's CA can be trusted under the "mitmproxy" friendly name at a time per OS/JDK truststore — running `start.py` from a different Alfred folder re-syncs trust to that folder's CA.
- **Docker cannot touch the host** (hosts file, OS cert store): this is why `start.py`/`start.sh`/`start.ps1` exist as host-side wrappers run outside any container, before/alongside `docker compose`.
- **JVM truststore caching**: a running JVM does not pick up truststore changes live — restart the Java app/server after its JDK's cert import.
- Log format written by the proxy (see README for the full example) always includes both `original_url` (the `-proxy` URL the app called) and `url` (the real forwarded URL), plus method, headers, body, timestamp, duration_ms, and response.

## pennyworth (backend) architecture notes

`backend` follows hexagonal (ports & adapters) architecture. **Every new backend feature or fix must follow this same shape** - this is a binding convention, not a one-time cleanup.

```
com.alfred.pennyworth
├── domain.model          Plain records (CallRecord, Comment, NewComment, ExportMetadata, ...).
│                         Zero Spring imports. No behavior beyond the data itself.
├── application.port.in   Use-case interfaces (GetCallsUseCase, CreateCommentUseCase, ...) -
│                         the only thing a controller is allowed to depend on.
├── application.port.out  Interfaces for what the app core needs from the outside world
│                         (CallLogPort, CommentsStorePort) - no mention of files/Spring/JSON.
├── application.service   Use-case implementations (CallsService, CommentsService, ...).
│                         Implement "in" ports, depend only on "out" ports. All business rules
│                         live here: limit clamping, id/timestamp assignment, filtering,
│                         metadata extraction.
├── adapter.in.web         Controllers + web-facing DTOs + GlobalExceptionHandler. Depend only
│                         on "in" port interfaces - never on a service class or an "out" port.
├── adapter.out.*          One package per outbound integration (filelog, commentstore, ...),
│                         each implementing exactly one "out" port. This is the only place that
│                         knows calls/comments live in flat files today.
└── config                 CorsConfig and similar cross-cutting Spring config.
```

**Dependency rule:** dependencies only point inward - `adapter` → `application` + `domain`; `application` → `domain` only; `domain` depends on nothing. A controller may only inject an inbound port interface, never a concrete service or an outbound port directly. Any new feature that talks to something external (a new file format, a future real database, an outbound HTTP call) is introduced as a new outbound port + adapter pair - never called directly from a service.

**When to add a web DTO vs. reuse the domain type directly:** reuse the domain record across the HTTP boundary when the wire shape and constraints are identical - `CallRecord`, `Comment`, and `ExportMetadata` all qualify today, which is why they're serialized/deserialized directly with no mapping layer in between (mapping code that does nothing but rename fields 1:1 is not "clean," it's noise). Introduce a distinct `adapter.in.web.dto` type only when the boundary genuinely needs something the domain type doesn't - the one case that exists today is `CommentRequestDto`, which carries Bean Validation annotations (`@NotBlank`, `@PositiveOrZero`) that are a transport concern and don't belong on the domain `NewComment` command.

**Security posture:**
- All inbound web DTOs are validated with Jakarta Bean Validation (`@Valid` in the controller); `GlobalExceptionHandler` (`@RestControllerAdvice`) turns validation failures into a clean `400 {"error": "..."}` body and any unexpected exception into a generic `500` - internal detail (stack traces, file paths) is logged server-side via SLF4J and never sent to the client.
- `GET /calls?limit=` is clamped server-side to `[1, CallsService.MAX_LIMIT]` regardless of what's requested, so a request can't force an unbounded read.
- `DELETE /comments/{id}` returns `404` when the id doesn't exist and `204` when it does - use the boolean a port already returns instead of always answering `200`.
- CORS origins come from `alfred.cors.allowed-origins` (env `ALFRED_CORS_ALLOWED_ORIGINS`), not a hardcoded `"*"` - defaults permissive for the current single-team deployment, but tightening for a real deployment is a one-line env change, not a code change.
- Adapters never swallow failures silently: malformed call-log lines and comments-file read/write errors are logged via SLF4J (WARN/ERROR) instead of silently disappearing. `JsonFileCommentsStoreAdapter` also checks its storage directory is writable at startup (`@PostConstruct`) so a misconfigured volume fails loudly immediately instead of confusingly on the first `POST /comments`.

**Testing convention:** application services are unit-tested against fake/mocked ports (`CallsServiceTest`, `CommentsServiceTest`, `ExportMetadataServiceTest`) - no Spring context, no filesystem, because the ports interface is exactly what makes that possible. Adapters get focused tests against a real temp directory (`@TempDir`) rather than mocks, since their whole job is file I/O (`FileCallLogAdapterTest`, `JsonFileCommentsStoreAdapterTest`). Controllers get thin `@WebMvcTest` coverage for HTTP-level concerns only - status codes, validation - with the use cases mocked (`CommentsControllerTest`).

## manor (frontend) architecture notes

- Standalone Angular components + signals throughout (no NgModules, no NgRx) — `frontend/src/app/core/state/calls-state.service.ts` is the single facade: it polls pennyworth on a 5s timer, and every filtered/sorted/paginated/grouped view of the data is a `computed()` signal derived from it. Components inject it directly rather than receiving props through a parent chain.
- **JSON rendering never uses `innerHTML`.** Pretty-printed JSON is tokenized into `{text, cls}` pieces (`shared/utils/json-tokenizer.ts`) and rendered via template interpolation (`shared/components/json-tokens`); the collapsible tree view (`components/json-tree`) is a genuinely recursive component, not a string-built HTML tree. There is nothing here for an XSS payload in a supplier's response body to attach to.
- **Per-block search/filter/view-mode state lives directly on `JsonPanelComponent`, with no external persistence map.** Because the call list's `@for` uses `trackByCallKey` (a stable id derived from timestamp+method+url, not array index), Angular keeps the same component instances alive across every 5s poll instead of destroying and recreating them — so a component's own signals (search query, flat/tree mode, scroll position via the native DOM node) survive automatically. A prior vanilla-JS version of this dashboard had to manually re-apply that state from lookup Maps after every re-render; that entire category of bug is structurally impossible here.
- The one exception is the global "Collapse/Expand all" button: it needs to reach into already-existing panels, so `CallsStateService.collapseAllVersion` is a bump counter each `JsonPanelComponent` watches via an `effect()` — it force-syncs on a version change but otherwise leaves the panel's own toggle alone.
- **Comments are line-scoped and Flat-view-only.** A comment's identity is `(callId, block, lineIndex)` against the *unfiltered* pretty-printed text — `JsonPanelComponent.allLines` computes every line unconditionally and "Lines only" filtering only ever hides indices from `visibleLineIndices`, never renumbers them, so a comment can't silently attach to the wrong line when the filter is toggled. `CommentsStore` caches per-call comment lists so the four panels of a call and its export dialog all read the same fetched data instead of each making their own request.
- **"Open in new tab" reuses `JsonPanelComponent` verbatim - it is not a second implementation.** Routing (`app.routes.ts`: `''` → `DashboardComponent`, `view` → `JsonViewPageComponent`; `AppComponent` itself is now just a `<router-outlet>`) exists only so `JsonViewPageComponent` can seed that same component's `[rawValue]/[label]/[callId]/[block]` inputs inside a bigger page layout (a plain CSS override on `.scrollable`, not a component fork). Any feature added to `JsonPanelComponent` therefore shows up in both places automatically - there is deliberately no editing capability anywhere; the JSON is always read-only. `nginx.conf` needs `try_files ... /index.html` because `/view` is opened via `window.open` as a fresh HTTP request, not an in-app navigation, so without the SPA fallback nginx would 404 it. The panel's starting data rides into the new tab via `sessionStorage` keyed by `(callId, block)` (`shared/utils/panel-view-bridge.ts`), which the browser clones into any same-origin tab opened via `window.open` - no backend round-trip needed just to seed the view.
- **Comments sync live across every open tab, not just within one.** `CommentsStore` posts the full updated list for a `callId` over a `BroadcastChannel` on every local add/delete, and any other tab that already has that `callId` cached (dashboard or a "view in new tab" page) applies the update reactively - applying an *incoming* broadcast never re-broadcasts, or tabs would echo the same update back and forth forever. A tab that never loaded that call's comments ignores the broadcast entirely rather than speculatively caching it.
- **Bulk export reuses the single-call export dialog rather than forking it.** `CallsStateService.selectedIds`/`selectedCalls` track a bulk selection (checkbox per `call-card`, keyed by `callKey()`, independent of sort/filter/pagination). `ExportDialogService.open()` now always takes `calls: readonly CallRecord[]` + `commentsByCallId: ReadonlyMap<string, Comment[]>` + a `format: 'markdown' | 'json'`; a single-call export (`CallActionsComponent`) is just the length-1 case of the same call. `ExportDialogComponent.confirmExport()` branches only on `calls.length` and `format` - N=1 markdown still calls the original, untouched `buildExportMarkdown`; N>1 markdown calls `buildBulkExportMarkdown` (numbered summary table with per-call anchors, metadata written once); any JSON export calls `buildBulkExportPayload`. Metadata in the form is always pre-filled from the *first* selected call in current list order, per the user's requirement that the form appear once even for a multi-call export.
- **`BulkActionsBarComponent` is always rendered, not just once something's selected** - with nothing selected it's a slim "No calls selected" + Select all; once `selectedCalls().length > 0` it grows (an animated border/background transition, not a hard show/hide) to add Deselect all and Export .md/.json/cURL. `CallsStateService.selectAll()` selects every call matching the current search/supplier filter regardless of pagination. cURL export deliberately skips the dialog entirely (`buildBulkCurlScript`/`bulkCurlFilename` in `shared/utils/curl-builder.ts`): it's a runnable replay script, not a report, so it only needs a supplier/credentials hint for its header comment, fetched from the first call, rather than the full editable metadata form.
- **No export path truncates or summarizes call data, ever** - a hard correctness requirement, since these exports get handed to another team to diagnose a bug and partial data would read as a false negative. This applies identically to single and bulk .md/.json/cURL exports; test coverage in `markdown-builder.spec.ts`/`bulk-json-builder.spec.ts`/`curl-builder.spec.ts` asserts on large generated bodies specifically to guard this.
- **The whole call-card is a selection target, not just its checkbox.** `CallCardComponent` listens for `mousedown`/`mouseenter`/`window:mouseup` on its host element: mousedown outside an interactive descendant (`SELECTION_EXEMPT_SELECTOR` in `call-card.component.ts` - buttons, links, inputs, the checkbox's own `<label>`, `.uri-value`, `app-call-actions`, `app-json-panel`) toggles that card via `CallsStateService.startDragSelect()`, and dragging from there across other cards' `mouseenter` paints the *same* resulting state onto each one via `dragSelectOver()` - so a drag that starts by selecting always keeps selecting, and one that starts by deselecting always keeps deselecting. URLs and JSON panel content stay normal, copyable text (`cursor: text`/`user-select: text` overrides in styles.scss) since those are exactly what gets copied out of this tool most often; the rest of the card is `user-select: none` so dragging across it doesn't also highlight text.
- **Every JSON block in a .md export is individually collapsible, and its label *is* the toggle.** `codeBlock()`/`headersBlock()` in `markdown-builder.ts` wrap each fenced block in a GitHub-Flavored-Markdown `<details><summary>Headers</summary>`/`<summary>Body</summary>` (collapsed by default, no `open` attribute) via the shared `collapsibleSection()` helper - there's no separate heading sitting above a generic "Show JSON" toggle. This is purely a presentation wrapper around the same never-truncated fenced content used everywhere else (single and bulk .md exports both go through this), so all the existing truncation-guard tests keep passing unchanged.
- **Bulk .md export wraps each call in its own open-by-default `<details>`, with a short identity in the summary line and the full detail repeated in the description below it.** `buildBulkExportMarkdown` renders `<summary><b>Call N</b> <code>METHOD path</code> STATUS</summary>` using `pathOnly()` (last two path segments, no ellipsis - distinct from the Summary table's `shortPath()`, which keeps the ".../" prefix) so the heading stays short and scannable; the full URL, Method, and Status are then repeated as bullets in the description alongside Timestamp/Duration, since a reader who expands a call still wants the complete identity without having to look back at the heading. The Request/Response Headers/Body blocks nest one level deeper inside that (`####`, not `##`), and `flaggedIssuesSection(comments, level)` takes an explicit heading-level parameter (`2` for the single-call export's top-level `##`, `4` once nested inside a bulk call's `<details>`) so "Flagged Issues" never outranks its sibling "Request"/"Response" headings. Metadata is a small table (`metadataTable()`) rather than a bullet list, and `formatMs()` adds thousands separators without forcing a fake ".00" on whole-number durations - both purely presentational, layered on top of the same data every export already had.
