# Architecture

## Backend (Maven multi-module, hexagonal per slice)

```
backend-platform          cross-cutting: CORS config, GlobalExceptionHandler, HealthController
backend-calls             CallRecord domain, CallLogPort, webhook + GET /calls
backend-comments          line-scoped comments, flat JSON store
backend-export            depends on backend-calls (extracts ExportMetadata)
backend-session-cycles    depends on backend-calls (implements its NewCallObserverPort)
backend-profiles          leaf slice, no deps either direction
backend-app               composition root, owns spring-boot-maven-plugin repackage
backend-architecture-test test-only, holds the ArchUnit suite (see docs/testing.md)
```

Each slice: `domain.model` / `application.port.in|out` / `application.service` / `adapter.in.web` / `adapter.out.*`. Only two cross-slice deps exist, both one-directional: `export→calls`, `session-cycles→calls`. Maven module boundaries make any other cross-slice import a compile error; ArchUnit enforces intra-slice layering direction and domain purity (no Spring; Jackson is allowed).

**DTO vs. reusing the domain type directly:** reuse the domain record (`CallRecord`, `Comment`, `ExportMetadata`) when the wire shape matches exactly. Add a `dto` type only when the boundary needs something the domain type shouldn't carry (e.g. `CommentRequestDto`'s Bean Validation annotations).

**Adding a slice:** new `backend-<name>` module, same internal package shape, add to aggregator `<modules>`, to `backend-app`'s deps (for component scan), to `backend-architecture-test`'s deps + a new isolation rule, and a test-only `@SpringBootApplication` if it needs `@WebMvcTest`.

**Persistence is file-based, deliberately swappable per slice.** Every adapter is `@ConditionalOnProperty(prefix="alfred.storage.<slice>", name="type", havingValue="file", matchIfMissing=true)`. Moving one slice to Redis/MySQL later = new `adapter.out.*` class implementing the same port + new `havingValue` + flip the property — services/controllers/ArchUnit rules don't change.

**Every file adapter caches its parsed file in memory**, revalidated on every read against size+mtime (`FileCallLogAdapter`, `JsonFile{Comments,SessionCycleMetadata,CapturedCalls,Profile}StoreAdapter`). Safe because: each adapter is the sole writer of its file, it re-stats on every read (so out-of-band edits/restores are picked up), and the cache is per-instance/never static. `FileCallLogAdapter` additionally caches each line's raw text alongside its parsed record so a malformed line still round-trips to disk untouched.

**`RECENT_CALLS.log` is a ring buffer** capped at `alfred.calls.max-limit` (env `RECENT_CALLS_MAX_LIMIT`, default 200) — `save()` does a synchronized read-modify-write, trimming from the front. `GET /calls?limit=` is clamped server-side to the same range. **Session-cycles' captured-calls files have no such cap** — one JSON array per cycle, unbounded growth is intentional (a cycle is a bounded manual recording, not an ambient log).

**Session-cycles captures calls without `backend-calls` knowing session-cycles exists**: `NewCallObserverPort` (owned by `backend-calls`, `CallsService` takes `List<NewCallObserverPort>` — empty list if the module isn't on the classpath) is implemented by `SessionCycleCaptureAdapter`, which appends to every currently-`RECORDING` cycle's file per webhook call and returns the ids that captured it — those ride along in the `/ws/calls` broadcast so an open cycle-detail page can filter the same socket.

**Profiles** (`Profile(id, name, createdAt, avatar)`, avatar = single emoji) is a leaf slice; session-cycles' `assignedTo` only stores a profile id as a plain string — no compile-time coupling.

**Response bodies are gzip-compressed** (`server.compression.enabled=true`, `application.properties`, min size 1KB, `application/json`+`text/plain`). `GET /calls` and `GET /session-cycles/{id}/calls` return full request/response bodies for every call, which uncompressed routinely ran to 1MB+ for a few dozen calls (confirmed live: a 28-call `/calls` response dropped from ~1.07MB to a fraction of that, and a same-payload local benchmark went 269KB→31.7KB). Negotiated automatically off the client's `Accept-Encoding`.

**`GET /calls` and `GET /session-cycles/{id}/calls` are fully server-paginated, sorted, and filtered** - `search`/`supplier`/`sort`/`offset`/`limit` query params, response shape `{calls, total}` (`CallsPage`/`CapturedCallsPage`). `CallListSupport` (`backend-calls`' `application.service` package) holds the shared filter/sort/paginate logic - both `CallsService.getCalls` and `SessionCyclesService.listCalls` call it via a `Function<T, CallRecord>` extractor (`Function.identity()` for calls, `CapturedCall::call` for captured calls), so a call ranks/searches/sorts identically regardless of which endpoint serves it. `sort` mirrors the frontend's `SortMode` values exactly except `"custom"` (drag-and-drop order), which the backend doesn't know about - the frontend never sends it. `"oldest"`/`"newest"` are relative to the *source* list's natural order (oldest-first/insertion order for both `RECENT_CALLS.log` and a cycle's captured-calls file), not a field on `CallRecord` - `"oldest-call"`/`"newest-call"` sort by parsed `timestamp` instead, accepting both Java's `Instant.toString()` format and the proxy's Python `isoformat()` offset format (`OffsetDateTime` fallback). `offset`/`limit` are clamped the same way the old `limit`-only param was (`alfred.calls.max-limit`, default 200).

**Security posture:** DTOs validated via `@Valid` + `GlobalExceptionHandler`; `GET /calls?limit=` clamped; deletes return 404/204/409 (`409` = session-cycle still recording, must pause first) via explicit outcome enums, not re-derived checks; CORS origins and webhook secret (`X-Webhook-Secret` vs `alfred.webhook.secret`/`WEBHOOK_SECRET`) are env-configurable, default permissive; adapters never swallow file I/O errors silently (SLF4J WARN/ERROR) and check writability at `@PostConstruct`.

## Frontend (Angular, standalone components + signals, no NgModules/NgRx)

**There is no polling anywhere in the calls/session-cycles data path - `createCallListView` (`core/state/call-list-view.ts`) fetches from the backend on demand only:** once on construction, again whenever search/sort/supplier-filter/page-size changes (offset reset to 0), on `loadMore()` (next page, appended), and on `refresh()` (re-fetches offset 0 through however many are currently loaded, replacing them wholesale). `CallsStateService`/`SessionCycleDetailStateService` call `refresh()` the instant their WebSocket receives a push, instead of a 5s timer eventually picking it up - a call arriving during a reconnect gap is only surfaced by the next push or a manual refresh, which is an accepted trade-off (no periodic fallback). A small `liveCalls` buffer per state service still shows a just-pushed call instantly (deduped by `callKey` against what's loaded) while that `refresh()` is in flight. `matchingCalls`/`stats`/`supplierOptions`/`groupedCalls`/"select all" are therefore scoped to *what's been loaded so far*, not the true backend total - `remainingCount` (`total - loaded`) is what drives the "Load N more" button and is the only place the true total is known. `SessionCycleDetailStateService` additionally keeps a `capturedByKey` map (content-keyed by `callKey`) alongside every fetched page, since a live WebSocket push only carries the bare `CallRecord` - removal needs the wrapper `CapturedCall`'s real backend id, which only exists once a fetch has confirmed it.

**Six components are shared verbatim between the dashboard and session-cycle detail pages via DI tokens**, not forked: `CallCardComponent`, `BulkActionsBarComponent`, `HeaderComponent`, `StatsBarComponent`, `CallListComponent`, `JsonPanelComponent`. `core/state/call-selection.tokens.ts` defines the four interfaces (`CallSelectionState`, `BulkSelectionState`, `CallListControlsState`, `CallRemovalState`); `appConfig.ts` points the first three at `CallsStateService` app-wide, `SessionCycleDetailComponent` overrides all four locally via component `providers`.

**Backend URL is resolved per-deployment** (`AppConfigService` reads `window.BACKEND_URL`, generated into `env.js` at container start from `BACKEND_PORT`) — never hardcode `localhost:5000`, since that means the *viewer's* machine, not the server's.

**Four hot-path derivations are memoized in `WeakMap`s** keyed by the (immutable, `readonly`-field) `CallRecord` object in `shared/utils/call-utils.ts`: `callKey`, `supplierOf`, `callTime`, and the search haystack behind `matchesSearch`. Safe because every poll parses fresh objects and a `WeakMap` entry is reclaimed once that poll's object is dropped — no eviction logic needed.

**JSON is never rendered via `innerHTML`** — tokenized (`shared/utils/json-tokenizer.ts`) and rendered through template interpolation or the recursive `json-tree` component.

**Comments** are identified by `(callId, block, lineIndex)` against the *unfiltered* pretty-printed text, so "Lines only" filtering can never shift a comment onto the wrong line. They sync live across tabs via `BroadcastChannel` (incoming broadcasts never re-broadcast, or tabs would echo forever).

**Theming** is one `data-theme` attribute + one CSS variable block per theme (`ThemeService`, `localStorage['alfred-theme']`) — no component branches on theme. Custom popovers (`EmojiPickerComponent`, `SelectPickerComponent`) use `position: fixed` computed via `shared/utils/popover-position.ts`'s `computeFixedPanelPosition()`, which walks up for the nearest CSS-Transforms-spec containing-block ancestor (`backdrop-filter`/`transform`/etc.) rather than assuming the viewport — needed because `header`/`.tab-nav` set `backdrop-filter` for glass themes.

**No export path (`.md`/`.json`/`.html`/cURL) ever truncates or summarizes call data** — a hard correctness requirement; test coverage in `*-builder.spec.ts` asserts on large generated bodies specifically to guard this.

**Every clipboard copy goes through `shared/utils/clipboard.ts`'s `copyToClipboard()`**, not `navigator.clipboard.writeText` directly — that API requires a secure context, which a plain-HTTP LAN deployment isn't; it falls back to `document.execCommand('copy')`.
