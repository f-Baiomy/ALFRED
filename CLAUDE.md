# CLAUDE.md

Guidance for Claude Code working in this repo. See [AGENTS.md](AGENTS.md) for the full, tool-agnostic project map — this file only adds Claude-Code-specific notes on top of it.

## What this is

Alfred logs HTTP/HTTPS traffic in **both directions** around a Java app, via two mitmproxy services. **proxy** (forward mode, port 443, always running) logs *outbound* calls from any proxy-aware client (e.g. a Java app with `http.proxyHost`/`https.proxyHost` set, including live-injected via `wildfly-proxy-toggle/`'s Attach-API tool). **reverse-proxy** (reverse mode, one listener + published port PER PROJECT, opt-in via `settings.properties`'s `reverse_proxy_enabled` — many deployments only need outbound logging) logs *inbound* calls into any number of NAMED projects it fronts, routed by which `listenPort` a request arrived on (`REVERSE_PROXY_PORT_MAP`/`INTERNAL_CALL_SERVICES` = `name:listenPort:upstreamPort` triples, from `settings.properties`'s `internal_call_services`); callers stay on `localhost` so browser session cookies keep working. Each project's logging toggles independently, live. Neither persists anything — both POST to **backend** (Spring Boot multi-module Maven reactor, port 5000), which owns all persistence: outbound calls, inbound calls, comments, session-cycles, profiles, call-filter settings. **frontend** (Angular/nginx, port 3000) has four tabs: Live Calls (with an outbound/inbound/both source filter), Session Cycles, Profiles, Settings.

## Commands

```bash
python3 start.py          # one-time+idempotent: hosts entries, docker compose up, CA cert trust (OS+JDKs)
docker compose up -d --build   # rebuild without redoing hosts/certs
python3 deploy.py [service]    # on a set-up server: git pull + rebuild
cd backend && mvn test          # JUnit5/Mockito/AssertJ + ArchUnit
cd frontend && npm test && npm run build   # Karma/Jasmine; ng build
```

## Non-obvious rules

- **`backend` is a hexagonal-per-vertical-slice Maven reactor** — one module per feature, enforced by Maven module boundaries (compile error) and an ArchUnit suite (`backend-architecture-test`). New features must follow this shape — see docs/architecture.md first.
- **Persistence is per-slice-swappable; SQLite is the shipped default, flat files are a legacy fallback** — `@ConditionalOnProperty`-selected, still fully working via `type=file`, and still what `backend-internal-calls` uses exclusively (it has no SQLite adapter). File adapters cache-by-mtime; SQLite adapters don't cache at all. Don't assume one behavior applies to both — see docs/architecture.md before touching an adapter.
- **Neither proxy service persists anything**; backend is the sole system of record. `proxy/log_and_route.py` (outbound) and `proxy/log_and_route_reverse.py` (inbound) — see docs/supplier-integrations.md before touching either.
- **Frontend is standalone Angular + signals, no NgModules/NgRx.** Several components are shared via DI tokens, not forked — check docs/frontend-architecture.md before duplicating one.
- **Exports never truncate/summarize call data** (.md/.json/.html/cURL) — hard requirement, guarded by tests.
- **Outbound-call retention is capped either way, inbound/session-cycle capture is not** — file mode caps by row count, SQLite mode by total size (`ALFRED_CALLS_MAX_SIZE_BYTES`); session-cycle captured-calls storage is deliberately unbounded (a cycle is a bounded manual recording).
- **No polling anywhere** — every list is fetch-on-demand, driven by a WebSocket signaling "something changed." New list features follow this shape, not a `timer()`.
- Docker cannot touch the host — hosts-file/cert-store changes only happen via `start.py`/`start.sh`/`start.ps1`, never in-container.

## Detailed docs (read only when relevant)
- docs/architecture.md — backend module/slice design, persistence/caching, pagination
- docs/frontend-architecture.md — frontend state, WebSocket-driven fetch-on-demand, component-sharing patterns
- docs/supplier-integrations.md — proxy routing, cert trust, host-side setup scripts
- docs/testing.md — test strategy per layer, ArchUnit enforcement, no-truncation guard tests
