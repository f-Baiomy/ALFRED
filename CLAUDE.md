# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Alfred is a reverse-mode mitmproxy setup that transparently intercepts and logs every HTTPS request/response a Java app sends to any supplier whose configured hostname ends in `-proxy`. It requires zero configuration changes in the Java app itself — no proxy settings, no code changes. Instead, a hosts-file redirect plus a trusted CA cert make the app think it's talking directly to the real supplier.

Three Docker services (see `docker-compose.yml`):
- **alfred** (mitmproxy, port 8444->8080) — intercepts, dynamically routes `*-proxy` hostnames to their real backend by stripping the suffix, and logs full request/response data as JSON lines to `proxy/logs/calls.log`.
- **pennyworth** (Spring Boot backend, port 5000) — reads `calls.log` and serves it over a small HTTP API (`GET /calls`, `GET /health`), plus a small comments API (`GET/POST /comments`, `DELETE /comments/{id}`) backed by a flat JSON file (`backend/data/comments.json`, writable volume — see docker-compose.yml).
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

There is no test suite, linter, or build step for `alfred`/`pennyworth` beyond the Docker builds themselves. The `manor` frontend does have a Karma/Jasmine unit test suite:

```bash
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

## manor (frontend) architecture notes

- Standalone Angular components + signals throughout (no NgModules, no NgRx) — `frontend/src/app/core/state/calls-state.service.ts` is the single facade: it polls pennyworth on a 5s timer, and every filtered/sorted/paginated/grouped view of the data is a `computed()` signal derived from it. Components inject it directly rather than receiving props through a parent chain.
- **JSON rendering never uses `innerHTML`.** Pretty-printed JSON is tokenized into `{text, cls}` pieces (`shared/utils/json-tokenizer.ts`) and rendered via template interpolation (`shared/components/json-tokens`); the collapsible tree view (`components/json-tree`) is a genuinely recursive component, not a string-built HTML tree. There is nothing here for an XSS payload in a supplier's response body to attach to.
- **Per-block search/filter/view-mode state lives directly on `JsonPanelComponent`, with no external persistence map.** Because the call list's `@for` uses `trackByCallKey` (a stable id derived from timestamp+method+url, not array index), Angular keeps the same component instances alive across every 5s poll instead of destroying and recreating them — so a component's own signals (search query, flat/tree mode, scroll position via the native DOM node) survive automatically. A prior vanilla-JS version of this dashboard had to manually re-apply that state from lookup Maps after every re-render; that entire category of bug is structurally impossible here.
- The one exception is the global "Collapse/Expand all" button: it needs to reach into already-existing panels, so `CallsStateService.collapseAllVersion` is a bump counter each `JsonPanelComponent` watches via an `effect()` — it force-syncs on a version change but otherwise leaves the panel's own toggle alone.
- **Comments are line-scoped and Flat-view-only.** A comment's identity is `(callId, block, lineIndex)` against the *unfiltered* pretty-printed text — `JsonPanelComponent.allLines` computes every line unconditionally and "Lines only" filtering only ever hides indices from `visibleLineIndices`, never renumbers them, so a comment can't silently attach to the wrong line when the filter is toggled. `CommentsStore` caches per-call comment lists so the four panels of a call and its export dialog all read the same fetched data instead of each making their own request.
- **"Open in new tab" reuses `JsonPanelComponent` verbatim - it is not a second implementation.** Routing (`app.routes.ts`: `''` → `DashboardComponent`, `view` → `JsonViewPageComponent`; `AppComponent` itself is now just a `<router-outlet>`) exists only so `JsonViewPageComponent` can seed that same component's `[rawValue]/[label]/[callId]/[block]` inputs inside a bigger page layout (a plain CSS override on `.scrollable`, not a component fork). Any feature added to `JsonPanelComponent` therefore shows up in both places automatically - there is deliberately no editing capability anywhere; the JSON is always read-only. `nginx.conf` needs `try_files ... /index.html` because `/view` is opened via `window.open` as a fresh HTTP request, not an in-app navigation, so without the SPA fallback nginx would 404 it. The panel's starting data rides into the new tab via `sessionStorage` keyed by `(callId, block)` (`shared/utils/panel-view-bridge.ts`), which the browser clones into any same-origin tab opened via `window.open` - no backend round-trip needed just to seed the view.
- **Comments sync live across every open tab, not just within one.** `CommentsStore` posts the full updated list for a `callId` over a `BroadcastChannel` on every local add/delete, and any other tab that already has that `callId` cached (dashboard or a "view in new tab" page) applies the update reactively - applying an *incoming* broadcast never re-broadcasts, or tabs would echo the same update back and forth forever. A tab that never loaded that call's comments ignores the broadcast entirely rather than speculatively caching it.
