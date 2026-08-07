# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Alfred is a reverse-mode mitmproxy setup that transparently intercepts and logs every HTTPS request/response a Java app sends to any supplier whose configured hostname ends in `-proxy`. It requires zero configuration changes in the Java app itself — no proxy settings, no code changes. Instead, a hosts-file redirect plus a trusted CA cert make the app think it's talking directly to the real supplier.

Three Docker services (see `docker-compose.yml`):
- **alfred** (mitmproxy, port 8444->8080) — intercepts, dynamically routes `*-proxy` hostnames to their real backend by stripping the suffix, and POSTs each finished call to pennyworth's webhook - it persists nothing itself (see "Real-time updates" below).
- **pennyworth** (Spring Boot backend, port 5000; multi-module Maven reactor - one module per vertical slice, hexagonal internally, see below) — owns all persistence: recent calls (`backend/data/RECENT_CALLS.log`, written after each webhook call) served over a small HTTP API (`GET /calls`, `GET /health`), a small comments API (`GET/POST /comments`, `DELETE /comments/{id}`) backed by a flat JSON file (`backend/data/comments.json`) - both in the same writable volume, see docker-compose.yml - a webhook (`POST /calls/webhook`) the proxy calls on every finished request, and a WebSocket endpoint (`/ws/calls`) that relays those calls to connected dashboards live.
- **manor** (Angular dashboard, built and served via nginx, port 3000) — polls pennyworth every 5s (a resilience fallback) and also listens on pennyworth's WebSocket for near-instant updates, displaying recent calls with syntax-highlighted flat/tree JSON views, per-block search, sort/pagination, pinning, supplier grouping, cURL/JSON export, and GitHub-style line comments for flagging issues to hand off to a support team.

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

Watch logs live (recent calls now live in pennyworth's own file, not the proxy's):

```bash
Get-Content .\backend\data\RECENT_CALLS.log -Wait -Tail 20 | jq .
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
- Payload shape the proxy sends (see README for the full example) always includes both `original_url` (the `-proxy` URL the app called) and `url` (the real forwarded URL), plus method, headers, body, timestamp, duration_ms, and response - identical to the `CallRecord` domain type `pennyworth-calls` persists.
- **The proxy does not persist anything - it only calls the webhook, off a background thread, never inline in a hook.** `response()`/`error()` run synchronously on mitmproxy's asyncio event loop - a blocking HTTP call inside either would stall every concurrent connection being proxied. `_write()` is now just a non-blocking `queue.put_nowait()` (only if `WEBHOOK_URL` is set); a single daemon thread drains that queue and does the actual `urllib.request` POST, swallowing and logging (not raising) any failure. This means `WEBHOOK_URL` is load-bearing, not optional: if it's unset or the webhook is consistently failing, that call is proxied correctly but never recorded anywhere, since pennyworth is now the only thing that writes it down. Stdlib only (`queue`, `threading`, `urllib.request`) deliberately, since `alfred` runs the stock `mitmproxy/mitmproxy` image with no Dockerfile/pip install step.

## pennyworth (backend) architecture notes

`backend` is a Maven multi-module reactor: **one module per vertical slice** (business feature), each internally following hexagonal (ports & adapters) layering. **Every new backend feature or fix must follow this same shape** - this is a binding convention, enforced two different ways (see below), not a one-time cleanup.

```
backend/
├── pom.xml                        packaging=pom, parent=spring-boot-starter-parent, <modules> list
├── pennyworth-platform/            cross-cutting, no feature dependencies
│   └── com.alfred.pennyworth.platform.{config.CorsConfig, web.GlobalExceptionHandler, web.HealthController}
├── pennyworth-calls/                vertical slice
│   └── com.alfred.pennyworth.calls.{domain.model.*, application.port.in/out, application.service, adapter.in.web, adapter.out.filelog}
├── pennyworth-comments/             vertical slice
│   └── com.alfred.pennyworth.comments.{domain.model.*, application.port.in/out, application.service, adapter.in.web(+dto), adapter.out.commentstore}
├── pennyworth-export/               vertical slice - depends on pennyworth-calls (needs CallRecord as input)
│   └── com.alfred.pennyworth.export.{domain.model.ExportMetadata, application.port.in, application.service, adapter.in.web}
├── pennyworth-app/                  composition root: depends on all 4 modules above, owns spring-boot-maven-plugin repackage
│   └── com.alfred.pennyworth.PennyworthApplication + application.properties
└── pennyworth-architecture-test/    test-only module, depends on everything, holds the ArchUnit suite
```

**Why modules, not just packages:** a single-module hexagonal layout only enforces its rules by convention - nothing stops a `comments` class from importing a `calls` internal, or a controller from reaching straight into a service. Splitting into one Maven module per slice makes that a *compile error*: a slice's code simply isn't on another slice's classpath unless declared as a dependency. `pennyworth-export → pennyworth-calls` is the **one intentional exception** (export receives a full logged call and extracts metadata from it) - one-directional, no cycle back. Every other cross-slice access is impossible to even attempt, let alone merge.

**Two enforcement mechanisms, two different jobs:**
1. **Maven module boundaries** enforce slice isolation - `calls` cannot depend on `comments` or `export` because there is no `<dependency>` declaring it, full stop.
2. **`pennyworth-architecture-test`'s ArchUnit suite** (`HexagonalArchitectureTest`) enforces everything modules can't: the *direction* of dependencies **within** a slice (domain → application → adapter, never reversed), that domain stays free of `org.springframework` (Jackson is explicitly allowed - see below), that inbound adapters depend on ports and never reach past them into a service class or into an outbound adapter, and that `calls`/`comments` never depend on each other or on `export`. A violation fails `mvn test` - it does not wait for a review comment. (Verified live while building this: temporarily annotating a domain record with `@Component` made exactly one rule fail with a precise message, then reverted.)

**When to add a web DTO vs. reuse the domain type directly:** reuse the domain record across the HTTP boundary when the wire shape and constraints are identical - `CallRecord`, `Comment`, and `ExportMetadata` all qualify today, which is why they're serialized/deserialized directly with no mapping layer in between (mapping code that does nothing but rename fields 1:1 is not "clean," it's noise; this is also why `CallRecord` keeps its `@JsonProperty` annotations and the ArchUnit domain-purity rule explicitly allows Jackson while forbidding Spring). Introduce a distinct `adapter.in.web.dto` type only when the boundary genuinely needs something the domain type doesn't - the one case that exists today is `CommentRequestDto`, which carries Bean Validation annotations (`@NotBlank`, `@PositiveOrZero`) that are a transport concern and don't belong on the domain `NewComment` command.

**Adding a new slice:** create a new `pennyworth-<name>` module (own `pom.xml`, parent = the aggregator), give it the same internal package shape, add it to the aggregator's `<modules>` and to `pennyworth-app`'s dependencies so its beans get component-scanned, and add it to `pennyworth-architecture-test`'s dependencies plus a slice-isolation rule in `HexagonalArchitectureTest` for it. If it needs `@WebMvcTest` coverage, it needs its own tiny test-only `@SpringBootApplication` class (see `pennyworth-comments`' `TestApplication`) - bare `@SpringBootConfiguration` alone does not imply component scanning, only `@SpringBootApplication`/`@ComponentScan` does.

**Persistence is file-based today, and deliberately swappable.** `FileCallLogAdapter` (`RECENT_CALLS.log`) and `JsonFileCommentsStoreAdapter` (flat `comments.json`) are plain outbound-port implementations - `CallsService`/`CommentsService` only ever see `CallLogPort`/`CommentsStorePort`, never the file I/O behind them. Both files live in the same writable `/appdata` volume (`./backend/data`) - pennyworth is the sole owner and writer of each, nothing else on the host or in another container touches them. Each file adapter carries `@ConditionalOnProperty(prefix = "alfred.storage.calls"/"alfred.storage.comments", name = "type", havingValue = "file", matchIfMissing = true)`, so:
- **Today**: unset (or explicit `file`) means the existing file adapters register, unchanged behavior.
- **Moving to Redis or MySQL later**: write a new adapter class in a new `adapter.out.redis`/`adapter.out.jpa` package implementing the same port, give it `havingValue = "redis"`/`"mysql"`, add the driver dependency to that slice's `pom.xml`, and flip `alfred.storage.calls.type`/`alfred.storage.comments.type` in `application.properties` (or the env equivalent). `CallsService`, `CommentsService`, every controller, and the ArchUnit rules all stay exactly as they are - a new adapter is just another class in `adapter.out.*`, which every existing rule already permits.
- The two slices can move independently and at different times (e.g. comments to MySQL while calls stays on files) since each has its own property and its own port.

**Security posture:**
- All inbound web DTOs are validated with Jakarta Bean Validation (`@Valid` in the controller); `GlobalExceptionHandler` (`@RestControllerAdvice`, in `pennyworth-platform`) turns validation failures into a clean `400 {"error": "..."}` body and any unexpected exception into a generic `500` - internal detail (stack traces, file paths) is logged server-side via SLF4J and never sent to the client.
- `GET /calls?limit=` is clamped server-side to `[1, CallsService.MAX_LIMIT]` regardless of what's requested, so a request can't force an unbounded read.
- `DELETE /comments/{id}` returns `404` when the id doesn't exist and `204` when it does - use the boolean a port already returns instead of always answering `200`.
- CORS origins come from `alfred.cors.allowed-origins` (env `ALFRED_CORS_ALLOWED_ORIGINS`), not a hardcoded `"*"` - defaults permissive for the current single-team deployment, but tightening for a real deployment is a one-line env change, not a code change.
- Adapters never swallow failures silently: malformed lines and file read/write errors are logged via SLF4J (WARN/ERROR) instead of silently disappearing. Both file adapters check their storage directory is writable at startup (`@PostConstruct`) so a misconfigured volume fails loudly immediately instead of confusingly on the first webhook call or `POST /comments`.
- `POST /calls/webhook` validates `X-Webhook-Secret` against `alfred.webhook.secret` (env `WEBHOOK_SECRET`, shared with the proxy's matching env var) and returns `401` on a mismatch - blank/unset (the default) means open, same permissive-default-tighten-later posture as CORS above, since this port is exposed to the host (`5000:5000`) as well as the docker network.

**The proxy no longer persists anything - pennyworth owns `RECENT_CALLS.log` end to end.** `CallsService.receiveNewCall` (implementing `ReceiveNewCallUseCase`) does `callLogPort.save(call)` *then* `notificationPort.notifyNewCall(call)` - saved before broadcast, so a dashboard that reacts to the WebSocket push and immediately re-fetches `GET /calls` always finds the record already there. `FileCallLogAdapter` is now both reader and writer of `CallLogPort` (`readAll()` for `GET /calls`, `save()` for the webhook path) - the same file, same class, same never-swallow-failures posture as `JsonFileCommentsStoreAdapter`. `WebSocketCallNotificationAdapter` (`adapter.out.websocket`) is the other half of `receiveNewCall`: it serializes the `CallRecord` and broadcasts it to every session `CallEventsWebSocketHandler` (registered at `/ws/calls` by `WebSocketConfig`) is tracking. `CallsWebhookController` (`POST /calls/webhook`) is the one inbound adapter that calls `ReceiveNewCallUseCase` - the proxy is the only caller, and it always sends the exact `CallRecord` shape it used to write to `calls.log` itself, reused directly per the DTO-vs-domain-reuse rule above. This adds no new ArchUnit exceptions (confirmed by running the suite after adding it).

**Testing convention:** application services are unit-tested against fake/mocked ports (`CallsServiceTest`, `CommentsServiceTest`, `ExportMetadataServiceTest`) - no Spring context, no filesystem, because the ports interface is exactly what makes that possible. Adapters get focused tests against a real temp directory (`@TempDir`) rather than mocks, since their whole job is file I/O (`FileCallLogAdapterTest`, `JsonFileCommentsStoreAdapterTest`). Controllers get thin `@WebMvcTest` coverage for HTTP-level concerns only - status codes, validation - with the use cases mocked (`CommentsControllerTest`). `mvn test` at the aggregator (`backend/`) runs the entire reactor including the ArchUnit suite; `docker compose up -d --build pennyworth` uses `-DskipTests` for the image build itself, matching the existing convention of running tests separately from the Docker build.

## manor (frontend) architecture notes

- Standalone Angular components + signals throughout (no NgModules, no NgRx) — `frontend/src/app/core/state/calls-state.service.ts` is the single facade: it polls pennyworth on a 5s timer, and every filtered/sorted/paginated/grouped view of the data is a `computed()` signal derived from it. Components inject it directly rather than receiving props through a parent chain.
- **Live updates from pennyworth's WebSocket are additive, never a replacement for polling.** `CallsStateService` opens `rxjs/webSocket` against `${backendUrl}/ws/calls` in its constructor (`retry({ delay: () => timer(3000) })` on disconnect - verified this actually reconnects by restarting the `pennyworth` container mid-session), and pushes each received `CallRecord` into a private `liveCalls` signal. The public `calls` signal is `mergeLiveCalls(liveCalls(), polledCalls())` (`shared/utils/call-utils.ts`) - live-only entries first so they render the instant they arrive, deduped by `callKey` against whatever the poll already returned. A separate `effect()` prunes `liveCalls` down to `unconfirmedLiveCalls(...)` every time a new poll lands, so it can't grow forever; the 5s poll itself is untouched and keeps the dashboard eventually-correct even if the socket never reconnects. Both merge/prune functions are pure and unit-tested directly (`call-utils.spec.ts`) rather than through the service, since exercising a real `WebSocket` in Karma is unreliable.
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
