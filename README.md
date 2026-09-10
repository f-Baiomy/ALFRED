# Alfred

Alfred logs every HTTP/HTTPS request and response around a Java app running on WildFly, in both directions, and shows them in a live dashboard — no code changes in the app itself.

- **Outbound** (WildFly → suppliers/external APIs): a forward proxy any client can be pointed at, either normally (`http.proxyHost`/`https.proxyHost`) or injected into an already-running JVM without a restart.
- **Inbound** (frontend/anyone → WildFly): an optional reverse proxy that sits in front of WildFly and logs calls before forwarding them on, unchanged.

See [AGENTS.md](AGENTS.md) for the full architecture map (services, backend modules, frontend structure) — this file only covers day-to-day setup and usage. Agents (Claude Code or otherwise) should start at `AGENTS.md`, not here.

## Quick start

```bash
python3 start.py          # one-time+idempotent: WildFly port-offset (if inbound logging is on),
                           # docker compose up, CA cert trust (OS + every JDK in jdks.txt)
```

Then open the dashboard: **http://localhost:3000**

Safe to re-run any time — already-done steps are skipped. Requires an Administrator/root terminal (writes to the OS cert store).

## The four services (`docker-compose.yml`)

| Service | Mode | Port | Purpose |
|---|---|---|---|
| `proxy` | forward | `127.0.0.2:443` | Logs outbound calls from any proxy-aware client |
| `reverse-proxy` | reverse | one `127.0.0.1` port per project | Logs inbound calls into any number of named projects (opt-in, see below) |
| `backend` | — | `5000` | Spring Boot API; owns all persistence (SQLite) |
| `frontend` | — | `3000` | Angular dashboard |

Neither proxy persists anything — both POST what they see to `backend`, which is the sole system of record.

## Outbound logging (WildFly → suppliers)

Point your Java client at the `proxy` service the normal way (`http.proxyHost=127.0.0.2`, `http.proxyPort=443`, same for `https.*`), or — if WildFly is already running and you don't want to restart it — use `wildfly-proxy-toggle/` to inject those system properties into the live JVM via the Java Attach API:

```bash
wildfly-proxy-toggle/proxy-on.bat      # Windows
./wildfly-proxy-toggle/proxy-on.sh     # Linux/macOS
```

See [wildfly-proxy-toggle/README.md](wildfly-proxy-toggle/README.md) for prerequisites (needs a JDK 8 install for the Attach API) and the `off`/`status` variants. Also wired into `start.py`/`restart.py --wildfly-proxy [on|off]`.

**Before this works**, the JDK your WildFly instance runs under must trust Alfred's CA — list its `JAVA_HOME` in `jdks.txt` and run `python3 start.py` (see "Trusting the CA" below). A running JVM doesn't pick up a truststore change live, so import the cert *before* starting WildFly, or restart it once after adding it to `jdks.txt`.

## Inbound logging (frontend/other clients → WildFly or any other local project)

Off by default — many environments only need outbound logging and have no inbound project to front. Turn it on by setting `reverse_proxy_enabled=true` in `settings.properties`, then `python3 start.py`.

Once enabled, `reverse-proxy` fronts as many projects as you like from one container — **one listener per project, each on its own new port, forwarding to that project's own unchanged port**. Two steps:

1. List each project as a `name:listenPort:upstreamPort` triple in `settings.properties`'s `internal_call_services` (comma-separated, no spaces), then `python3 start.py`:
   ```
   internal_call_services=odeysys:9001:8080,core-service:9002:8083
   ```
2. Point whatever calls each project at its `listenPort` instead of its own port — e.g. `http://localhost:9001/...` instead of `http://localhost:8080/...`. Nothing about the project changes; Alfred just adds a logged front door in front of it.

Routing is by **which port a request arrived on**, so there are no hostnames and no hosts-file entries involved. Staying on `localhost` is deliberate and important: a per-project hostname would make every browser API call *cross-site*, and browsers drop `SameSite=Lax` session cookies there — logging in would break in every project. Same-host, different-port keeps cookies (and your existing CORS setup) working exactly as before.

`start.py`/`restart.py` also generate a gitignored `docker-compose.override.yml` from that same list, publishing each project's `listenPort` on `127.0.0.1` (Compose can't expand a variable-length port list from an env var). It's automatic; don't edit it by hand.

(This replaces the older `-Djboss.socket.binding.port-offset` dance for WildFly specifically — since nothing needs to move off its own port anymore, `sync-wildfly-port-offset.py`/`wildfly_home`/`wildfly_port_offset_enabled` in `settings.properties` are optional now, only relevant if you still want WildFly reachable on its *original* port number unproxied for some other reason.)

Whether calls actually get *recorded* is a **separate, live-toggleable switch per project** — logging one project off never affects any other, and forwarding itself never stops for any of them:

```bash
./toggle-wildfly-reverse-proxy.sh odeysys on|off|status        # Linux/macOS
toggle-wildfly-reverse-proxy.bat core-service on|off|status    # Windows
```

Or from the dashboard's **Settings → Inbound logging** panel, which lists every configured project (plus a reserved `unknown` entry for any request that matched none of them) with its own Enable/Disable button.

## Trusting the CA (needed for HTTPS outbound logging)

`python3 start.py` re-syncs Alfred's CA (generated fresh in `proxy/certs/` on first container start) into:
1. The OS certificate store (Windows cert store via `certutil`, or `update-ca-certificates`/Keychain on Linux/macOS).
2. Every JDK listed in `jdks.txt` (one `JAVA_HOME` path per line) plus the current `JAVA_HOME`.

```
C:\Program Files\Java\jdk1.8.0_191
C:\work\java-upgrade\jdk-11.0.0.2
```

Only one Alfred project folder's CA can be trusted under the "mitmproxy" friendly name at a time — re-run `start.py` from whichever folder you're currently testing, and restart any already-running JVM after its cert import (truststore changes aren't picked up live).

## Everyday commands

```bash
python3 restart.py                    # rebuild/restart every service
python3 restart.py backend            # rebuild/restart just one (or more) named services
python3 deploy.py                     # on an already-set-up server: git pull + restart.py
python3 stop.py                       # tear everything down cleanly
docker compose up -d --build          # manual rebuild, skips the hosts/cert/port-offset steps
python3 docker_storage_report.py      # diagnose/clean up Docker's own disk usage (never touches volumes)
```

## Folder contents

```
Alfred/
  docker-compose.yml          orchestrates all four services
  settings.properties         deploy-time config (reverse_proxy_enabled, internal_call_services, wildfly_home)
  jdks.txt                    JAVA_HOME paths needing cert trust
  proxy/
    log_and_route.py            outbound (forward-mode) logging addon
    log_and_route_reverse.py    inbound (reverse-mode) logging addon
    certs/                      CA certificate, generated on first run
  wildfly-proxy-toggle/       Attach-API tool: inject outbound proxy settings into a live WildFly JVM
  toggle-wildfly-reverse-proxy.sh/.bat   live on/off switch for inbound logging
  sync-wildfly-port-offset.py  applies/removes WildFly's port-offset for inbound logging
  backend/                    Spring Boot API (hexagonal-per-slice Maven reactor)
  frontend/                   Angular dashboard
  start.py / restart.py / deploy.py / stop.py    setup and lifecycle scripts
  docker_storage_report.py    Docker disk-usage diagnostic/cleanup
  AGENTS.md                   full architecture map — read this for anything beyond setup
  docs/                        architecture, frontend-architecture, supplier-integrations, testing
```

## Further reading

- [AGENTS.md](AGENTS.md) — start here for architecture
- [docs/architecture.md](docs/architecture.md) — backend modules, persistence, pagination
- [docs/frontend-architecture.md](docs/frontend-architecture.md) — frontend state, components, routes
- [docs/supplier-integrations.md](docs/supplier-integrations.md) — both proxy addons, cert trust, host scripts
- [docs/testing.md](docs/testing.md) — test strategy, ArchUnit enforcement
