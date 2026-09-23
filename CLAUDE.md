# CLAUDE.md

Guidance for Claude Code working in this repo. See [AGENTS.md](AGENTS.md) for the full, tool-agnostic project map — this file only adds Claude-Code-specific notes on top of it.

## What this is

Alfred logs HTTP/HTTPS traffic in **both directions** around a Java app, via two mitmproxy services. **proxy** (forward mode, port 443, always running) logs *outbound* calls from any proxy-aware client (e.g. a Java app with `http.proxyHost`/`https.proxyHost` set, including live-injected via `wildfly-proxy-toggle/`'s Attach-API tool). **reverse-proxy** (reverse mode, one listener + published port PER PROJECT, opt-in via `settings.properties`'s `reverse_proxy_enabled` — many deployments only need outbound logging) logs *inbound* calls into any number of NAMED projects it fronts, routed by which `listenPort` a request arrived on (`REVERSE_PROXY_PORT_MAP`/`INTERNAL_CALL_SERVICES` = `name:listenPort:upstreamPort` triples, from `settings.properties`'s `internal_call_services`); callers stay on `localhost` so browser session cookies keep working. Each project's logging toggles independently, live. Neither persists anything — both POST to **backend** (Spring Boot multi-module Maven reactor, port 5000), which owns all persistence: outbound calls, inbound calls, comments, session-cycles, profiles, call-filter settings. **frontend** (Angular/nginx) has four tabs: Live Calls (with an outbound/inbound/both source filter), Session Cycles, Profiles, Settings. It is served through **app-gateway** (nginx, `gateway/nginx.conf`, the only thing publishing host port 3000): the backend's API prefixes and `/ws/` go to `backend:5000`, everything else to `frontend:80`, so the browser talks to one origin (`window.BACKEND_URL = window.location.origin`, no CORS) and one Cloudflare Tunnel URL covers the whole app. A new backend route prefix must be added to the gateway's regex or it will be served the SPA.

## Commands

```bash
python3 start.py          # one-time+idempotent: hosts entries, docker compose up, CA cert trust (OS+JDKs)
docker compose up -d --build   # rebuild without redoing hosts/certs
python3 deploy.py [service]    # on a set-up server: git pull + rebuild
cd backend && mvn test          # JUnit5/Mockito/AssertJ + ArchUnit
cd frontend && npm test && npm run build   # Karma/Jasmine; ng build
```

Single tests / environment quirks:

```bash
# Backend needs JDK 21 (text blocks). If `mvn -version` shows an older JAVA_HOME, run Maven in Docker (Git Bash):
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/backend:/app" -v alfred-m2:/root/.m2 -w //app maven:3.9-eclipse-temurin-21 \
  mvn -B -pl backend-session-cycles -am test -Dtest=SessionCyclesServiceTest -Dsurefire.failIfNoSpecifiedTests=false
# Frontend, one spec, headless:
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/shared/utils/spacer-gap-controller.spec.ts
```

After `docker compose up -d --build backend`, the gateway may keep the old container IP (502s) until `docker compose restart app-gateway`.

**Code search: use CodeGraph first when `.codegraph/` exists** (a local, gitignored index - not every clone has one). `codegraph_explore` (MCP) or `codegraph explore "<symbols or question>"` (shell) returns a symbol's current source plus its callers/blast radius in one call - e.g. `layoutSpacers` shows the three views and both export builders that depend on it. Fall back to Grep/Read for non-code files and literal text searches.

## Non-obvious rules

- **`backend` is a hexagonal-per-vertical-slice Maven reactor** — one module per feature, enforced by Maven module boundaries (compile error) and an ArchUnit suite (`backend-architecture-test`). New features must follow this shape — see docs/architecture.md first.
- **Persistence is per-slice-swappable; SQLite is the shipped default, flat files are a legacy fallback** — `@ConditionalOnProperty`-selected, still fully working via `type=file`, and still what `backend-internal-calls` uses exclusively (it has no SQLite adapter). File adapters cache-by-mtime; SQLite adapters don't cache at all. Don't assume one behavior applies to both — see docs/architecture.md before touching an adapter.
- **Neither proxy service persists anything**; backend is the sole system of record. `proxy/log_and_route.py` (outbound) and `proxy/log_and_route_reverse.py` (inbound) — see docs/supplier-integrations.md before touching either.
- **Frontend is standalone Angular + signals, no NgModules/NgRx.** Several components are shared via DI tokens, not forked — check docs/frontend-architecture.md before duplicating one.
- **Exports never truncate/summarize call data** (.md/.json/.html/cURL) — hard requirement, guarded by tests. The .md/.html/.json exports additionally open with an auto-generated "About This Document" section (`shared/utils/export-narrative.ts`) explaining the capture's direction, topology and comments to a reader who wasn't there — shared across those three builders rather than mirrored, and deliberately absent from Discord/cURL/Postman. **The .json export is also the re-import format** (`import-parser.ts` is the exact inverse of `bulk-json-builder.ts`) - it emits `events`, not `calls`, and a resolved internal call is TWO events sharing a `callId`, so a reader must `groupBy(callId)` and merge. Import fixtures must be built by `buildBulkExportPayload`, never by hand: the original importer's hand-written fixtures used a shape no export has ever produced, so its tests passed while it could not read a single real file. See docs/frontend-architecture.md.
- **Outbound and inbound are both capped; session-cycle capture is not** — outbound file mode caps by row count, SQLite mode by total size (`ALFRED_CALLS_MAX_SIZE_BYTES`). **Inbound is a ring buffer** in a flat file, `alfred.internal-calls.retention-rows` (default 1500) — deliberately separate from `alfred.internal-calls.max-limit`, which is only the largest page the API serves. While those were one property, inbound could never hold more calls than a single page (200), so calls silently vanished from the live list within minutes on busy traffic. **A new inbound call APPENDS one line; the file is only rewritten when it outgrows the cap plus slack** (`InternalCallsFileLogAdapter.save`, streamed via a temp file + atomic move, never materialized as one String). It used to rebuild the whole file in memory per call — at 1500 rows × ~28 KB that is 150–250 MB of transient allocation to record ONE call, and under concurrent inbound traffic the backend threw `OutOfMemoryError` inside the webhook handler and dropped calls **silently** (the proxy delivered every webhook; nothing logged a failure). Measured: 60 concurrent inbound calls stored 4, with 504 OOMs; after the fix, 80/80 with zero. Note this slice keeps its whole retained window resident in memory (it is the one slice with no SQLite adapter), which is why `backend`'s `mem_limit` is 2g — five figures of retention still wants a database, not a bigger flat file. Session-cycle captured-calls storage is deliberately unbounded (a cycle is a bounded manual recording).
- **`settings.properties` only fills a gap in `.env`, it never overwrites one already there** — `sync_env_from_settings()` in `start.py`/`restart.py` uses `env.setdefault()` for every deploy-time setting, so `.env` (gitignored, untouched by git) is what's actually running once a setting has been adopted once; `settings.properties` (tracked in git, reset by `python3 deploy.py`'s `git reset --hard`) only supplies the default the first time a deployment sees that key. To change an already-running setting, edit `.env` directly or delete that one line from it and re-run `start.py`/`restart.py` — editing `settings.properties` alone no longer does it once a setting has a real value.
- **No polling anywhere** — every list is fetch-on-demand, driven by a WebSocket signaling "something changed." New list features follow this shape, not a `timer()`.
- **Interception rules are evaluated inside the mitmproxy addons, never in the backend** - against a JSON snapshot backend publishes into `proxy/interception/` (the same mtime-cached flag-file pattern `reverse-proxy-enabled.flag` already uses), so no proxied request ever costs a backend round trip or a database query and rules keep applying while backend is down. **A delay must be `await asyncio.sleep()` in an `async def` hook, never `time.sleep()`** - mitmproxy runs one event loop for every connection it is proxying, so a blocking sleep freezes all of them. The one exception to the no-backend-on-the-request-path rule is a PAUSED call, where waiting is the feature; every pause carries a timeout and a default action so a caller can never be held forever. See docs/interception.md.
- **Session-cycle spacers anchor to the call ABOVE them** (`afterCallId` + that call's `anchorTimestamp`), never the call below: calls hidden when a spacer was added (OPTIONS preflights are hidden by default, plus search/filters) must land *below* it when revealed, and a spacer added at the end of a recording cycle must stay put as new calls arrive - with nothing re-pinned on capture. Every place that renders spacers (flat/nested/waterfall views AND the .md/.html export builders) goes through one `layoutSpacers` in `shared/utils/spacer-gap-controller.ts`; don't add a second placement. Spacers stored in the older "before this call" form are converted lazily on first `listSpacers` (`LegacySpacerAnchors`).
- Docker cannot touch the host — hosts-file/cert-store changes only happen via `start.py`/`start.sh`/`start.ps1`, never in-container.

## Detailed docs (read only when relevant)
- docs/architecture.md — backend module/slice design, persistence/caching, pagination
- docs/frontend-architecture.md — frontend state, WebSocket-driven fetch-on-demand, component-sharing patterns
- docs/supplier-integrations.md — proxy routing, cert trust, host-side setup scripts
- docs/testing.md — test strategy per layer, ArchUnit enforcement, no-truncation guard tests
- docs/interception.md — traffic interception/fault injection: rule model, actions, breakpoints, how to add an action
