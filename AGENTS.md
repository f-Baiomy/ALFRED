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

**Native install** (no Docker, specs/012-server-program, `docs/server.md`): the same pieces run as processes under a
supervisor (`packaging/launcher/supervisor.py`, run by `alfred run` / the system service): the backend serves the UI
itself on `ALFRED_UI_PORT` (no gateway), the two proxies run on bundled Python, the MCP server runs on 127.0.0.1 behind
`/mcp`. Installers come from `python build_dist.py` (`packaging/linux`, `packaging/windows`, `build-versions.json`).

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
| `backend-interception` | Traffic interception/fault-injection rules, the paused-call registry, and stored answers (recorded-call or uploaded-file, for the ANSWER_WITH_*/REPLACE_WITH_RECORDED_RESPONSE actions) |
| `backend-resend` | Resends a previously-logged call (outbound or inbound, optionally edited) back through the appropriate mitmproxy service; a leaf slice reached only through `backend-app`'s `resendbridge` |
| `backend-logs` | Logs Explorer: loads JSON-per-line logs of any structure (upload, server file, followed file), per-source SQLite tables with per-field and trigram indexes, grouping levels, patterns, comments; a leaf slice, see `docs/logs.md` |
| `backend-db-capture` | Database Capture: stores the statements the `db-agent` records inside the app, tied to their inbound call; summaries, flags, paged rows, sandboxed queries over recorded data, failed statements indexed per call; and the Redis commands each call sent (⬢, specs/011: store-generic tables, structural value decoding, its own 2 GB budget); a leaf slice, see `docs/db-capture.md` |
| `backend-triage` | Triage: the saved, indexed "needs attention" mark of every call (status, error inside a 2xx, failing supplier calls, failed statements, priority 1-6), kept current as calls arrive by `backend-app/triagebridge`; a leaf slice with its own `triage.db`, see `docs/mcp.md` "Triage" |
| `backend-relive` | Relive Cycle: builds and runs a controlled replay workflow from recorded calls (LIVE/REPLAY per outbound child, cycle-scoped variables/rules, run history, Live calls log); a leaf slice reached only through `backend-app`'s `relivebridge` |
| `backend-server` | The native install's settings engine: reads and writes `.env` (comments kept, owner-only, conflict by hash), validation and machine checks, history and revert, the edit-access rule, restart through the supervisor's control API, `/server/**` and `/ws/server`; also run without Spring as `ServerConfigCli` (`alfred config`, the installer). Isolated; `backend-app/serverbridge` applies live settings to other slices. See `docs/server.md` |
| `backend-app` | Composition root: main class, `DatabaseStatsController`, migrations, `interceptionbridge`/`resendbridge`/`relivebridge`/`serverbridge`, `mcpbridge` (the `/mcp` relay and `/mcp-exports`), `web/SpaPageFilter` (serves the SPA natively) |
| `backend-architecture-test` | Test-only, holds the ArchUnit suite |

Isolation rules currently enforced: `calls`, `internal-calls`, `comments`, `profiles`, `settings`, `interception`, `resend` and `relive` are each fully isolated from every other slice (including from each other). The only allowed edges are `export→calls`, `session-cycles→calls`, `session-cycles→internal-calls`. → `docs/architecture.md`

## Frontend routes (`frontend/src/app/`, standalone Angular + signals, no NgModules/NgRx)

Live Calls (`''`, with an outbound/inbound/both source filter), Session Cycles (`cycles`, `cycles/:id`), Profiles (`profiles`), Settings (`settings`), Relive Cycles (`relive`, `relive/:id` — build and run a controlled replay workflow from recorded calls, see `docs/relive.md`), Logs (`logs`, `logs/new`, `logs/:id`, `logs/:id/structure` — load and explore JSON-per-line logs, see `docs/logs.md`), and `view` (pop-out JSON viewer, outside the tab layout). No separate "Internal Calls" tab — inbound traffic is a filter inside Live Calls, reusing the same components. → `docs/frontend-architecture.md`

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

- **Persistence is per-slice-swappable; SQLite is the shipped default, not flat files.** Every slice keeps its old file adapter working (`type=file` opt-out) alongside a new SQLite one (`type=sqlite`, default), with a one-time migration from the legacy file on first boot. `backend-internal-calls` joined them in specs/013-inbound-calls-store (`internal-calls.db`, count + size retention, prepare/complete as order-independent upserts); its file store remains the opt-out (`INTERNAL_CALLS_STORAGE=file`). File adapters cache-by-mtime; SQLite adapters don't cache at all — don't assume one adapter's behavior for the other. → `docs/architecture.md`
- **Native mode: `.env` in the install folder is the one source of settings**; a key missing from it uses its default in `settings.properties`, which the UI and `alfred config` never write. Only `backend-server` (and its `ServerConfigCli`) write `.env`. `alfred attach` loads `alfred-agent.jar` (the db-agent, renamed) with `features=proxy,db,logs,redis` applied on every load; on Linux it never attaches across users (it re-runs as the app's owner). → `docs/server.md`
- **Two proxy directions, easy to conflate.** `wildfly-proxy-toggle/` (Attach-API, Java) controls WildFly's *outbound* calls routing through `proxy`. `toggle-wildfly-reverse-proxy.sh`/`.bat` (shell, or the Settings UI) controls whether `reverse-proxy` *logs* inbound calls — forwarding never stops either way. Same word "proxy," opposite directions, unrelated mechanisms. → `docs/supplier-integrations.md`
- **`reverse-proxy` is one container with one listener PER PROJECT, routed by arrival port, opt-in.** `settings.properties`'s `reverse_proxy_enabled` (false by default) controls whether it starts at all — many deployments only need outbound logging. `REVERSE_PROXY_PORT_MAP`/`INTERNAL_CALL_SERVICES` (same env var, two services) is a comma-separated list of `name:listenPort:upstreamPort` triples: Alfred listens on `listenPort` and forwards to the project's own unchanged `upstreamPort`, so callers just swap `localhost:<upstreamPort>` for `localhost:<listenPort>`. `proxy/reverse-proxy-entrypoint.sh` turns each triple into its own `--mode reverse:` flag, so **mitmproxy does the routing and the addon only labels flows** (by `client_conn.sockname`) for logging and the per-name toggle. **Logging is toggled per name independently** (Settings UI or `toggle-wildfly-reverse-proxy.sh/.bat <name>`) — there's no single global switch. → `docs/supplier-integrations.md`
- **Staying on `localhost` (port-based, not hostname-based) is a deliberate constraint — don't "improve" it into per-project hostnames.** A hostname like `core-service.local` makes every browser API call *cross-site* relative to a dev server on `localhost`, so Chrome drops `SameSite=Lax` session cookies and logins break in every project (diagnosed live: `Set-Cookie` landed, no `Cookie` came back, app returned "Session has been expired"). Hostname routing also hit two Docker/mitmproxy traps: mitmproxy rewrites the `Host` header *before* addon hooks run, and Docker Desktop leaks the host's hosts file into container DNS so `*.local` resolves to `127.0.0.1` = the container itself. Port-based routing avoids all three. `keep_host_header=true` is still set so upstreams don't emit `host.docker.internal` links in redirects. → `docs/supplier-integrations.md`
- **Neither proxy service persists anything — with one deliberate exception**: a `GLOBAL`-scoped capture promotes its value into `variables.json` (`_save_global`, atomic temp-file-plus-rename), which is why the shared `./proxy/interception` mount is `:rw` while every script mount stays `:ro`. Backend is otherwise the sole system of record. Addon code: `proxy/log_and_route.py` (outbound), `proxy/log_and_route_reverse.py` (inbound). → `docs/supplier-integrations.md`
- **Frontend is standalone Angular + signals, no NgModules/NgRx.** Six components are shared between the dashboard and session-cycle pages via DI tokens, not forked. → `docs/frontend-architecture.md`
- **No polling anywhere** — every list is fetch-on-demand, driven by a WebSocket signaling "something changed." New list features follow this shape, not a `timer()`.
- **Exports never truncate or summarize call data** (`.md`/`.json`/`.html`/cURL) — hard requirement, guarded by tests asserting on large generated bodies.
- **Docker cannot touch the host** — hosts-file/cert-store/WildFly-run-config changes only happen via `start.py`/`start.sh`/`start.ps1`/`sync-wildfly-port-offset.py`, never in-container.
- **A `regex: true` interception pattern runs in its own persistent `multiprocessing` worker process** (`proxy/regex_worker.py`), never on the addon's own event loop, with a timeout that kills and restarts the worker — CPython's `re` holds the GIL for the duration of a match, so a pathological pattern in-process would freeze every connection the proxy is carrying. → `docs/interception.md`
- **Stored answers come in two kinds** — `RECORDED` (copied from a logged call, outbound or inbound, with a keep/strip-secrets decision when the response carries sensitive headers or cookies) and `FILE` (uploaded through the editor) — backing the `ANSWER_WITH_RECORDED_CALL`/`ANSWER_WITH_FILE`/`REPLACE_WITH_RECORDED_RESPONSE` actions. No total cap on how many exist; an answer is deleted only once nothing references it. → `docs/interception.md`

## Deeper docs (follow the pointer, don't re-derive)

- `docs/architecture.md` — backend module/slice design, persistence + caching (file vs. SQLite), pagination
- `docs/frontend-architecture.md` — frontend state, WebSocket-driven fetch-on-demand, component-sharing, Settings/source-filter
- `docs/supplier-integrations.md` — both proxy addons, cert trust, host-side setup scripts, inbound/outbound toggles
- `docs/testing.md` — test strategy per layer, ArchUnit enforcement, no-truncation guard tests
- `docs/relive.md` — Relive Cycle: the call-rule model, attribution, evaluation tiers, the snapshot, run history, the Live calls log
- `docs/logs.md` — Logs Explorer: ingest pipeline, storage, LogQuery, settings, measured throughput
- `docs/db-capture.md` — Database Capture: db-agent, proxy headers, switch flag file, storage, Relive-ready seams
- `docs/mcp.md` — Using Alfred from Claude: `mcp-server/` is a local stdio MCP server (TypeScript, not a container or compose service) over the existing HTTP API; it imports the frontend's pure utils (findings, exports, masking, spacer layout) rather than re-implementing them
- `docs/server.md` — the native install: installers, `.env` and defaults, the Server section and its access rule, the supervisor, `alfred` CLI, `alfred attach` and its limits
- `wildfly-proxy-toggle/README.md` — the outbound Attach-API tool in full
- `README.md` — human-facing setup/usage walkthrough
