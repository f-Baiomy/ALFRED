# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

Alfred is a forward-proxy (mitmproxy) setup that intercepts and logs every HTTP/HTTPS request/response made by any client pointed at it (e.g. a Java app configured with `http.proxyHost`/`https.proxyHost`) — no code changes needed in the client itself, only that it's proxy-aware. Three Docker services: **proxy** (mitmproxy in regular/forward mode, POSTs each finished call to a webhook, persists nothing), **backend** (Spring Boot multi-module Maven reactor, port 5000, owns all persistence — calls, comments, session-cycles, profiles), **frontend** (Angular/nginx, port 3000, Live Calls + Session Cycles + Profiles tabs).

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
- **Persistence is flat files, deliberately swappable** per slice via `@ConditionalOnProperty`, all in `/appdata`, each with an in-memory cache validated by file size+mtime — don't bypass the cache helpers when editing an adapter.
- **The proxy persists nothing**; backend is the sole system of record. Its request/response logging and webhook POST live in `proxy/log_and_route.py` — see docs/supplier-integrations.md before touching it.
- **Frontend is standalone Angular + signals, no NgModules/NgRx.** Several components are shared via DI tokens, not forked — check docs/frontend-architecture.md before duplicating one.
- **Exports never truncate/summarize call data** (.md/.json/.html/cURL) — hard requirement, guarded by tests.
- **`RECENT_CALLS.log` is a capped ring buffer; session-cycle captured-calls files are not.**
- **No polling anywhere** — every list is fetch-on-demand, driven by a WebSocket signaling "something changed." New list features follow this shape, not a `timer()`.
- Docker cannot touch the host — hosts-file/cert-store changes only happen via `start.py`/`start.sh`/`start.ps1`, never in-container.

## Detailed docs (read only when relevant)
- docs/architecture.md — backend module/slice design, persistence/caching, pagination
- docs/frontend-architecture.md — frontend state, WebSocket-driven fetch-on-demand, component-sharing patterns
- docs/supplier-integrations.md — proxy routing, cert trust, host-side setup scripts
- docs/testing.md — test strategy per layer, ArchUnit enforcement, no-truncation guard tests
