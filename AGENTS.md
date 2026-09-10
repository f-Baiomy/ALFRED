# AGENTS.md

Entry point for any coding agent (Claude Code, Codex, Cursor, or otherwise) working in this repo. Read this first. It is a map, not the territory — for anything beyond the summary below, follow the pointer into `docs/` rather than guessing from this file alone.

## What this is

Alfred logs HTTP/HTTPS traffic around a Java app on WildFly, in **both directions**, via two independent mitmproxy services that persist nothing themselves — a Spring Boot backend is the sole system of record, and an Angular frontend is the dashboard.

```
outbound (WildFly → suppliers)          inbound (frontend/anyone → WildFly)
──────────────────────────────          ───────────────────────────────────
WildFly (proxy-aware client)            frontend / any client
        │ http(s).proxyHost                     │
        ▼                                        ▼
   proxy (forward mode, :443)          reverse-proxy (reverse mode, :8080)
        │                                        │
        ├─── POST prepare/complete ──────┐  ┌─── POST prepare/complete
        ▼                                 ▼  ▼
   real supplier                          backend (:5000, SQLite)
                                                │
                                                ▼
                                          frontend (:3000)
```

`reverse-proxy` only runs when opted into (`settings.properties`'s `reverse_proxy_enabled` → the `inbound-logging` Compose profile) — many deployments only need outbound logging and have no inbound project to front. `proxy` always runs regardless.

## Services (`docker-compose.yml`)

| Service | Mode | Port | Owns |
|---|---|---|---|
| `proxy` | mitmproxy forward | `127.0.0.2:443` | Nothing — POSTs to `backend`'s `/calls/webhook` |
| `reverse-proxy` | mitmproxy reverse | one `127.0.0.1:<listenPort>` per project | Nothing — POSTs to `backend`'s `/internal-calls/webhook`; opt-in, one listener per project from `REVERSE_PROXY_PORT_MAP`, each independently toggleable |
| `backend` | Spring Boot | `5000` | All persistence (SQLite by default) |
| `frontend` | Angular/nginx | `3000` | The dashboard UI |

## Backend modules (`backend/`, Maven reactor, hexagonal-per-slice)

One module per feature. Maven module boundaries make an undeclared cross-slice import a compile error; an ArchUnit suite (`backend-architecture-test`) enforces intra-slice layering and the isolation list below.

| Module | Owns |
|---|---|
| `backend-platform` | Cross-cutting: CORS, `GlobalExceptionHandler`, health check |
| `backend-calls` | **Outbound** call log/query/webhook — the `proxy` service's data |
| `backend-internal-calls` | **Inbound** call log/query/webhook, mirroring `backend-calls` — the `reverse-proxy` service's data; also the logging on/off toggle |
| `backend-comments` | Line-scoped comments on calls |
| `backend-export` | Export-metadata extraction (depends on `backend-calls`) |
| `backend-session-cycles` | Manual recording sessions that capture calls (depends on `backend-calls` **and** `backend-internal-calls`) |
| `backend-profiles` | Leaf slice, standalone profile store |
| `backend-settings` | Call-filter whitelist/blacklist/mode — which *outbound* calls get logged at all |
| `backend-app` | Composition root: main class, `DatabaseStatsController`, migrations |
| `backend-architecture-test` | Test-only, holds the ArchUnit suite |

Isolation rules currently enforced: `calls`, `internal-calls`, `comments`, `profiles`, `settings` are each fully isolated from every other slice. The only allowed edges are `export→calls`, `session-cycles→calls`, `session-cycles→internal-calls`. → `docs/architecture.md`

## Frontend routes (`frontend/src/app/`, standalone Angular + signals, no NgModules/NgRx)

Five routes: Live Calls (`''`, with an outbound/inbound/both source filter), Session Cycles (`cycles`, `cycles/:id`), Profiles (`profiles`), Settings (`settings`), and `view` (pop-out JSON viewer, outside the tab layout). No separate "Internal Calls" tab — inbound traffic is a filter inside Live Calls, reusing the same components. → `docs/frontend-architecture.md`

## Commands

```bash
python3 start.py                          # one-time+idempotent: port-offset sync, docker compose up, CA cert trust
docker compose up -d --build              # rebuild without redoing hosts/certs/port-offset
python3 restart.py [service...]           # rebuild/restart everything or named services
python3 deploy.py [service...]            # on a set-up server: git pull + restart.py
python3 stop.py                           # clean teardown
cd backend && mvn test                    # JUnit5/Mockito/AssertJ + ArchUnit
cd frontend && npm test && npm run build  # Karma/Jasmine; ng build
```

`start.py`/`restart.py`/`deploy.py` accept `--wildfly-proxy [on|off]` (outbound Attach-API toggle, default `on`). There's no equivalent inbound flag anymore — whether `reverse-proxy` runs at all is `settings.properties`'s `reverse_proxy_enabled` (deploy-time), and each configured project's logging is toggled independently at runtime via the Settings UI or `toggle-wildfly-reverse-proxy.sh/.bat <name> [on|off]`, not on every start.

## Non-obvious rules

- **Persistence is per-slice-swappable; SQLite is the shipped default, not flat files.** Every slice keeps its old file adapter working (`type=file` opt-out) alongside a new SQLite one (`type=sqlite`, default), with a one-time migration from the legacy file on first boot. **`backend-internal-calls` is the one exception — it has no SQLite adapter, file-only by design.** File adapters cache-by-mtime; SQLite adapters don't cache at all — don't assume one adapter's behavior for the other. → `docs/architecture.md`
- **Two proxy directions, easy to conflate.** `wildfly-proxy-toggle/` (Attach-API, Java) controls WildFly's *outbound* calls routing through `proxy`. `toggle-wildfly-reverse-proxy.sh`/`.bat` (shell, or the Settings UI) controls whether `reverse-proxy` *logs* inbound calls — forwarding never stops either way. Same word "proxy," opposite directions, unrelated mechanisms. → `docs/supplier-integrations.md`
- **`reverse-proxy` is one container with one listener PER PROJECT, routed by arrival port, opt-in.** `settings.properties`'s `reverse_proxy_enabled` (false by default) controls whether it starts at all — many deployments only need outbound logging. `REVERSE_PROXY_PORT_MAP`/`INTERNAL_CALL_SERVICES` (same env var, two services) is a comma-separated list of `name:listenPort:upstreamPort` triples: Alfred listens on `listenPort` and forwards to the project's own unchanged `upstreamPort`, so callers just swap `localhost:<upstreamPort>` for `localhost:<listenPort>`. `proxy/reverse-proxy-entrypoint.sh` turns each triple into its own `--mode reverse:` flag, so **mitmproxy does the routing and the addon only labels flows** (by `client_conn.sockname`) for logging and the per-name toggle. **Logging is toggled per name independently** (Settings UI or `toggle-wildfly-reverse-proxy.sh/.bat <name>`) — there's no single global switch. → `docs/supplier-integrations.md`
- **Staying on `localhost` (port-based, not hostname-based) is a deliberate constraint — don't "improve" it into per-project hostnames.** A hostname like `core-service.local` makes every browser API call *cross-site* relative to a dev server on `localhost`, so Chrome drops `SameSite=Lax` session cookies and logins break in every project (diagnosed live: `Set-Cookie` landed, no `Cookie` came back, app returned "Session has been expired"). Hostname routing also hit two Docker/mitmproxy traps: mitmproxy rewrites the `Host` header *before* addon hooks run, and Docker Desktop leaks the host's hosts file into container DNS so `*.local` resolves to `127.0.0.1` = the container itself. Port-based routing avoids all three. `keep_host_header=true` is still set so upstreams don't emit `host.docker.internal` links in redirects. → `docs/supplier-integrations.md`
- **Neither proxy service persists anything**; backend is the sole system of record. Addon code: `proxy/log_and_route.py` (outbound), `proxy/log_and_route_reverse.py` (inbound). → `docs/supplier-integrations.md`
- **Frontend is standalone Angular + signals, no NgModules/NgRx.** Six components are shared between the dashboard and session-cycle pages via DI tokens, not forked. → `docs/frontend-architecture.md`
- **No polling anywhere** — every list is fetch-on-demand, driven by a WebSocket signaling "something changed." New list features follow this shape, not a `timer()`.
- **Exports never truncate or summarize call data** (`.md`/`.json`/`.html`/cURL) — hard requirement, guarded by tests asserting on large generated bodies.
- **Docker cannot touch the host** — hosts-file/cert-store/WildFly-run-config changes only happen via `start.py`/`start.sh`/`start.ps1`/`sync-wildfly-port-offset.py`, never in-container.

## Deeper docs (follow the pointer, don't re-derive)

- `docs/architecture.md` — backend module/slice design, persistence + caching (file vs. SQLite), pagination
- `docs/frontend-architecture.md` — frontend state, WebSocket-driven fetch-on-demand, component-sharing, Settings/source-filter
- `docs/supplier-integrations.md` — both proxy addons, cert trust, host-side setup scripts, inbound/outbound toggles
- `docs/testing.md` — test strategy per layer, ArchUnit enforcement, no-truncation guard tests
- `wildfly-proxy-toggle/README.md` — the outbound Attach-API tool in full
- `README.md` — human-facing setup/usage walkthrough
