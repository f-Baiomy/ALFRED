# Backend architecture

Maven multi-module, hexagonal per slice. See docs/frontend-architecture.md for the Angular side.

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

**Pagination itself is a property-driven toggle, `alfred.calls.pagination-enabled` (env `ALFRED_PAGINATION_ENABLED`), disabled by default.** `CallListSupport.apply`'s `paginationEnabled` param controls it: when `false`, `offset` is ignored (always 0) *and* the effective limit is forced to `maxLimit` regardless of what the caller requested - not the caller's small `limit`, which would make every "Load more" click re-fetch and re-append the exact same first N items forever, since offset is also being ignored (this exact bug was caught live before shipping). Disabled reproduces the pre-pagination "everything up to maxLimit in one response" behavior byte-for-byte - the frontend needs zero changes either way, since "Load more" simply finds nothing left to load (`remainingCount` is `total - loaded`, and `total` already equals everything).

**Security posture:** DTOs validated via `@Valid` + `GlobalExceptionHandler`; `GET /calls?limit=` clamped; deletes return 404/204/409 (`409` = session-cycle still recording, must pause first) via explicit outcome enums, not re-derived checks; CORS origins and webhook secret (`X-Webhook-Secret` vs `alfred.webhook.secret`/`WEBHOOK_SECRET`) are env-configurable, default permissive; adapters never swallow file I/O errors silently (SLF4J WARN/ERROR) and check writability at `@PostConstruct`.
