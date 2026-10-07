# Research: Alfred as a Server Program

Phase 0 output for `plan.md`. Each entry: Decision, Rationale, Alternatives considered. Items marked
**SPIKE** must be proven on real Linux and Windows machines before the tasks that depend on them start.

---

## R1. What runs on the server: processes and who supervises whom

**Decision**: Four processes, one supervisor.

| Process | Runtime | Started by |
|---|---|---|
| `alfred run` (supervisor) | bundled Python | the system service (systemd / WinSW), or the user in a terminal |
| backend (API + UI + `/mcp` proxy) | bundled Java 21 | supervisor |
| outbound proxy (`mitmdump -s log_and_route.py`) | bundled Python | supervisor |
| reverse proxy (`mitmdump -s log_and_route_reverse.py`), only when `REVERSE_PROXY_ENABLED=true` and projects exist | bundled Python | supervisor |
| MCP server (stdio server switched to Streamable HTTP, bound to 127.0.0.1) | bundled Node | supervisor |
| log agent (`log-agent/agent.py`), Windows only, only when watched folders exist | bundled Python | supervisor |

The supervisor, not the backend, owns the children. Restarting the backend (the "Restart Alfred"
button) leaves both proxies running, so the user's apps keep working (spec US4 scenario 2). The
backend asks the supervisor to act through a local control API (R6).

**Rationale**: If the backend supervised the proxies, a backend restart would kill them, which
contradicts what the restart confirmation promises. Python is bundled anyway, and every rule that turns
`.env` into proxy command lines already exists in Python (`start.py` `_parse_service_entries`,
`_forward_proxy_assignments`, and the two `*-entrypoint.sh` scripts). Moving those into one shared module
keeps one implementation for the Docker path and the native path (Constitution V).

**Alternatives considered**:
- Backend supervises everything: rejected, because a backend restart would drop the proxies.
- The OS service manager supervises each process as its own unit: rejected. That means 3 to 5 units per
  OS, two different service managers to keep in sync, and no single place that turns `.env` into
  processes.

---

## R2. Bundled runtimes

**Decision**:
- **Python**: python-build-standalone ("install_only" builds) 3.12.x for `x86_64-unknown-linux-gnu`
  and `x86_64-pc-windows-msvc`. mitmproxy and its dependencies are installed into the bundled
  interpreter's `site-packages` **at build time**, using
  `pip install --target --platform <tag> --python-version 3.12 --only-binary=:all:`. Nothing is
  downloaded on the server. Windows also gets `watchdog`, for the log agent.
- **Java**: a trimmed runtime made with `jlink` from Temurin JDK 21 (same exact release for both
  targets). Modules come from `jdeps` on `alfred.jar` plus `jdk.attach` (attach CLI),
  `jdk.crypto.ec`, `jdk.management` and `jdk.unsupported`. Built inside the Linux Docker builder,
  using the Linux JDK's `jlink` with `--module-path` pointing at each target's `jmods`.
- **Node**: the official Node 22 LTS binary per OS. The MCP server is bundled with `esbuild` into one
  `mcp-server.mjs`, including the `frontend/src` code it imports, so no `node_modules` ship.

**Rationale**: The earlier worry about a frozen `mitmdump` binary (`multiprocessing` in
`regex_worker.py`) does not apply. python-build-standalone is a normal, complete CPython, so
`multiprocessing` spawn works as it does under any Python. Fixing the Python version to 3.12 means one
set of wheels per OS. A `jlink` image is about 60 MB against about 190 MB for a full JDK, and unlike a
Temurin JRE it can include `jdk.attach`.

**Alternatives considered**:
- Python as a prerequisite: rejected by the owner (clarification 2026-10-07).
- PyInstaller-frozen `mitmdump`: rejected because `multiprocessing` and addon loading are fragile frozen.
- Rewriting the MCP server in Java: rejected. `mcp-server/src/frontend.ts` imports the frontend's export
  builders, redaction and analysis code on purpose, so Claude and the UI never disagree. A Java port
  would duplicate all of that (Constitution V; CLAUDE.md "exports never truncate", import/export
  parity).
- Temurin JRE download: rejected because it has no `jdk.attach`.

**SPIKE S1**: On Windows Server 2019/2022 and Ubuntu 22.04, run bundled `mitmdump` with both addons,
including a `regex: true` interception rule hitting the worker timeout. Expected: same behavior as in
Docker.

---

## R3. Installers

**Decision**:
- **Linux**: a self-extracting `alfred-setup-<ver>-linux-x64.run` (a POSIX `sh` header plus a
  `tar.gz` payload). The build script writes it from Python with `tarfile`, setting `0755` on
  launchers and keeping LF endings. Run as root:
  - creates the install folder (default `/opt/alfred`) and service account (default `root`, because the Java apps on staging usually run as root
    and attaching needs the same user; `--user` picks another),
  - installs a systemd unit `alfred.service` with `Restart=always` and
    `AmbientCapabilities=CAP_NET_BIND_SERVICE`, so the proxy can bind `127.0.0.2:443` without root,
  - starts the service and prints the UI addresses.
- **Windows**: `alfred-setup-<ver>-windows-x64.exe`, built with NSIS (`makensis`). The build script
  downloads a portable NSIS. It shows a wizard, or runs silently with `/S /DIR=...`, and registers a
  Windows service through WinSW (bundled `alfred-service.exe` plus XML with `onfailure restart`).
- **Both**:
  - Upgrade: detect an existing install, stop the service, replace `runtime/`, `app/` and
    `settings.properties`, keep `.env` and `data/`, start again.
  - Uninstall: `alfred uninstall` on Linux, or "Programs and Features" on Windows. Asks before deleting
    `data/`.
  - Downgrade: refused without `--allow-downgrade`.
  - Docker import (FR-002d): detects a Docker-based Alfred (running `backend` container or `--import-docker <repo folder>`).
    On yes it copies `.env`, `backend/data/`, `proxy/*.flag`, `proxy/interception/`, `proxy/certs/` and the named
    volumes `logs-db`/`db-capture-db` (exported with `docker run --rm -v <vol>:/v alpine tar`), into a temp folder
    first, then moves them into `data/`; then `docker compose stop`. Windows: service account default LocalSystem.
  - No admin rights: stops before any change.
  - Payload extraction goes to a temp folder first, then one move. An interrupted install leaves the
    old install intact.

**Rationale**: NSIS can be built from Windows or Linux, so a later CI build on Linux stays possible,
and it supports silent installs. A `.run` file needs nothing on the server but `sh` and `tar`, which
every distribution has. WinSW is a single exe with no install.

**Alternatives considered**:
- Inno Setup: its compiler is Windows-only.
- MSI/WiX: heavier, for no gain here.
- `.deb`/`.rpm`: two Linux formats instead of one.
- AppImage: aimed at desktop apps and needs FUSE.

---

## R4. Build pipeline (`build_dist.py`)

**Decision**: One Python script at the repo root. Its steps, each cached where possible:
1. Version from `git describe --tags --always --dirty`.
2. Frontend: `npm ci && npm run build`, output copied into the backend's `static/`.
3. Backend plus db-agent plus attach CLI: Maven inside the `maven:3.9-eclipse-temurin-21` container
   (avoids the JDK 8 trap on the developer's PATH, see memory "bare mvn silently runs JDK 8"). Tests run
   unless `--skip-tests`.
4. MCP server: `esbuild` bundle.
5. Runtimes: download and verify sha256 of Temurin JDK 21 (both OS), python-build-standalone (both),
   Node (both), WinSW, NSIS, then `jlink` and the `pip --target` installs. Cache in `build-cache/`.
6. Assemble `build/stage/<target>/`, write `.run` and `.exe`, and `dist/SHA256SUMS`.

Flags: `--target linux|windows|all` (default `all`), `--skip-tests`, `--clean`.
Prerequisites on the developer machine: Python 3.10+, Node 22, Docker.

**Rationale**: It matches how the repo already automates things (Python scripts at the root). Pinned
versions and checksums keep builds reproducible (Constitution I, pinned dependencies).

**Alternatives considered**: Maven-only packaging (awkward for Node, Python and NSIS); a Makefile (not
native on Windows); GitHub Actions only (the owner wants to build locally).

---

## R5. Serving the UI from the backend (native mode)

**Decision**:
- The Angular build ships inside `alfred.jar` under `static/`.
- A `SpaPageFilter` in `backend-app` sends HTML page loads that are not API calls to `index.html`. It
  applies the same rules as `gateway/nginx.conf`: the API prefix list, plus the `$spa_page` exception
  for `/profiles`, `/interception`, `/settings` and `/logs/**` when `Accept: text/html`.
- The prefix list is a constant in one class. A test parses `gateway/nginx.conf` and fails if the two
  lists differ, so the Docker path and the native path cannot drift apart.
- Docker keeps nginx exactly as it is.

**Rationale**: One port (FR-004) without nginx on the server. The test keeps CLAUDE.md's rule ("a new
backend route prefix must be added to the gateway's regex") enforceable in both modes.

**Alternatives considered**:
- Bundling nginx: one more runtime per OS.
- Serving the SPA from the supervisor: that would put Python on every UI request.

---

## R6. Supervisor control API

**Decision**:
- The supervisor listens on `127.0.0.1:<random port>`. On each start it writes
  `data/run/control.json` (`{port, token, pid}`), readable only by the service account (`0600` on Linux,
  an owner-only ACL on Windows).
- Endpoints: `GET /status`, `POST /restart/backend`, `POST /restart/proxies`, `POST /reload` (re-read
  `.env`, restart only what changed). Each request carries the `X-Alfred-Control-Token` header.
- The backend reads `control.json` when it needs one of these actions.

**Rationale**: Localhost-only plus a token known only to the service account, so nothing else on the
machine or network can restart Alfred. No polling: the backend calls on demand, and the supervisor
pushes status changes such as a crashed and restarted proxy with
`POST {backend}/server/supervisor-events`. Those arrive with the webhook secret, and the backend
forwards them as a WebSocket signal.

**Alternatives considered**:
- A backend exit code meaning "restart me": that works only for the backend, not the proxies.
- Unix sockets or named pipes: two code paths.

---

## R7. `.env` handling: one engine for the UI and the CLI

**Decision**: The settings logic lives in a new backend slice, `backend-server`:
- the setting catalog,
- the `.env` document model that keeps comments, order and unknown lines,
- validation rules,
- the diff against defaults,
- history.

The domain and application layers stay free of Spring (as Constitution III already requires for the
domain). The CLI (`alfred config ...`) is a thin client:
- **Backend running**: the CLI calls the backend's `/server/settings` API on `127.0.0.1`. That always
  passes the access rule, and the same code validates and applies.
- **Backend stopped**: the CLI runs `java -cp app/alfred.jar ...ServerConfigCli` (plain `main`, no
  Spring context, about 0.3 s). It builds the same service with file adapters, so validation and
  writing are the same code. Changes then take effect on the next start.

**Writes**: one domain operation produces the new document; the adapter writes a temp file in the same
folder, `fsync`s it, then moves it into place. Before overwriting, the adapter compares the file's
content hash with the one the editor loaded. A mismatch is a conflict (FR-036).

**History**: each save appends one JSON line to `data/env-history.jsonl` and copies the previous `.env`
to `data/env-history/<timestamp>.env`. The last 50 are kept, older ones are deleted (FR-034, Constitution
II retention). A hand edit is detected when the stored hash differs from the file at the next read; it
is recorded as source `HAND_EDIT`, with the diff computed against the last snapshot.

**Rationale**: Validation in Python for the CLI and in Java for the UI would be two implementations
that drift (Constitution V).

**Alternatives considered**:
- Python engine, backend calls Python: puts Python on the backend's request path.
- CLI only through the backend: then the CLI could not fix a setting that stops the backend from
  starting (a bad port, too much memory), which is exactly when it matters most.

---

## R8. Applying settings live

**Decision**: Each catalog entry declares how it applies: `LIVE`, `PROXIES` or `RESTART`. A setting is
`LIVE` only when the owning slice offers a use case to change it at runtime. `backend-app/serverbridge`
implements `backend-server`'s `LiveSettingsPort` and calls those use cases. That adds no new
cross-slice edge (Constitution III).

| Setting | Applies | Owning slice / mechanism |
|---|---|---|
| `INTERNAL_CALLS_RETENTION_ROWS` | LIVE | backend-internal-calls: new `SetRetentionUseCase` |
| `ALFRED_CALLS_MAX_SIZE_BYTES` | LIVE | backend-calls: new `SetStorageBudgetUseCase` (SQLite size check already runs every N saves) |
| `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES`, `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES` | LIVE | backend-db-capture: new budget use case |
| `ALFRED_LOGS_WATCH_DIRS` | LIVE | backend-logs: `LocalWatchFolders` gains a replace-folders operation; `WatchServiceEvents` re-registers |
| `ALFRED_SETTINGS_EDIT_FROM` | LIVE | backend-server itself |
| `REVERSE_PROXY_ENABLED`, `INTERNAL_CALL_SERVICES`, `ALFRED_OUTBOUND_PROXY_LISTEN` | PROXIES | supervisor `POST /reload`; backend-internal-calls also refreshes its project list (existing `INTERNAL_CALL_SERVICES` reader gains a reload) |
| `ALFRED_UI_PORT`, `ALFRED_MEMORY`, `WEBHOOK_SECRET`, `ALFRED_LOGS_AGENT_SECRET` | RESTART | read once at process start |
| `ALFRED_LOGS_DIR` | RESTART | the logs slice reads it at startup |
| `ALFRED_LOGS_WATCH_MODE` | RESTART | `WatchServiceEvents` is chosen with `@ConditionalOnProperty` at startup |
| `WILDFLY_PORT_OFFSET_ENABLED`, `WILDFLY_HOME` | RESTART | applied by the supervisor at start (same logic as `sync-wildfly-port-offset.py`) |

**Corrections to the mock**: the mock shows `ALFRED_LOGS_DIR`, `ALFRED_LOGS_WATCH_MODE` and the WildFly
settings as "applies live". The real code reads them at startup, so they show "restart needed". Calling
them live would mean reworking bean selection for little gain (YAGNI).

---

## R9. Who may change settings

**Decision**: An `EditAccessFilter` in `backend-server`'s `adapter.in.web` guards every write under
`/server/**`: PUT/POST/DELETE for settings, restart, revert and upload. It allows a write when **all**
of these hold:
1. The request has none of `Cf-Connecting-IP`, `Cf-Ray`, `Cdn-Loop: cloudflare`. Cloudflare always adds
   these and a client cannot remove them. `cloudflared` connects from 127.0.0.1, so the address alone
   proves nothing.
2. The TCP peer address (never `X-Forwarded-For`, which is spoofable) matches
   `ALFRED_SETTINGS_EDIT_FROM`:
   - `local` = loopback, plus the machine's own interface addresses,
   - `lan` = RFC 1918 ranges plus IPv6 ULA `fc00::/7`,
   - explicit addresses and CIDR ranges.
3. Docker mode (FR-054): writes are always refused (`DOCKER_MODE`), whatever the address. In Docker
   the repo's `.env` is not mounted into the backend container, so the Server section shows each
   setting's **effective value from the container's environment** (source `PROCESS_ENV`) with its
   default, read-only, plus the how-to text "edit `.env` in the Alfred folder, then run
   `python3 restart.py`". The Server card shows container status read from the same environment; the
   restart buttons are hidden. Checks still run (read-only probes are harmless) so a Docker user can
   see a busy port or a missing folder. Native mode is the only mode that writes.

A refused write returns `403` with a JSON reason, which the UI shows. `GET /server/access` tells the UI
whether to render read-only and why.

**Rationale**: FR-050 to FR-053. The server enforces it, not the UI (SC-005).

**Residual risk** (document in `docs/server.md`): anyone on an allowed LAN can change settings. Settings
include folder paths, and the checks reveal whether a folder exists and how many files it has. They
never reveal file contents. The default `lan` was the owner's choice.

---

## R10. Checks (ports, folders, disk, memory, app health)

**Decision**: `backend-server` out-ports with plain-JDK adapters:
- `PortProbePort`: bind-test the port. When it is taken, name the process holding it:
  - Linux: `/proc/net/tcp` plus `/proc/*/fd` (processes visible to the service account), or `ss -ltnp`
    when present.
  - Windows: `netstat -ano` plus `tasklist /fi "PID eq n"`.
  - When the owner cannot be found: "in use (process unknown)".
- `FolderProbePort`: exists, readable, count of `*.log`/`*.json` files at depth 1, newest
  modification time. Never reads file content.
- `DiskProbePort`: `FileStore.getUsableSpace()` of the data folder.
- `MemoryProbePort`: total and free RAM through `com.sun.management.OperatingSystemMXBean`.
- `AppHealthPort`: `HEAD http://127.0.0.1:<upstreamPort>/` with a 1 s timeout. Any HTTP response
  means "answering"; a refused connection means "not answering".
- `StorageUsagePort` and `TrafficRatePort`: implemented in `backend-app/serverbridge` over the
  calls, internal-calls and db-capture slices' existing size and count queries (windowed, indexed,
  `COUNT` over the last hour, Constitution II).

Checks run when the UI asks: debounced while typing, one request per field change, and once for
"Check everything". There is no polling. Every probe has a timeout, and the whole check request is
capped at 5 s.

---

## R11. Restart from the UI

**Decision**:
- **Restart Alfred**: backend → supervisor `POST /restart/backend`. The supervisor stops the backend
  gracefully (SIGTERM, or `CTRL_BREAK` on Windows, 20 s timeout, then kill) and starts it with the
  current `.env`.
- **Restart proxies**: backend → supervisor `POST /restart/proxies`.
- **Page behavior**: the UI shows progress and waits on the existing `reconnectingSocket` back-off.
  That is a reconnect delay, which the Constitution allows; it is not polling. When the socket is
  back, it reloads the server status.
- **Port changed** (`ALFRED_UI_PORT`): the confirmation names the new address. After the restart the
  page navigates to it.
- **Pending restart**: the list is kept in `data/pending-restart.json`. The backend clears it at start
  by comparing the effective values with the recorded ones, so a restart by any route (UI, CLI,
  service manager) clears it.

---

## R12. One Java agent, attach CLI, certificate trust

**Decision**:
- Extend `db-agent` (Java 8 bytecode, ByteBuddy, already has `Agent-Class`) into the single agent,
  published as `alfred-agent.jar`. The module keeps its name to avoid churn. New packages:
  - `proxy`: sets and clears `http(s).proxyHost/Port` in the target JVM (logic moved from
    `wildfly-proxy-toggle/WildFlyProxyAgent.java`).
  - `trust`: see below.
- Features are switched per attach through agent args (`features=proxy,db,logs,redis`, added to the
  existing `alfredUrl=...;project=...;secretFile=...` format). A repeat attach changes switches without
  re-instrumenting.
- New module `attach-cli` (Java 21, uses `jdk.attach`), with logic moved from
  `wildfly-proxy-toggle/WildFlyProxyController.java`:
  - `jvms` lists Java processes: pid, main class or `jboss.home.dir`, owner, attached features (read
    through `VirtualMachine.getSystemProperties()`, where the agent publishes `alfred.agent.features`).
  - `attach <pid> --proxy --db --logs --redis` and `detach <pid>`.
  - The `alfred` launcher delegates to it.

**Certificate trust** (FR-072): when `trust` is on (implied by `--proxy`), the agent retransforms the
JDK's default JSSE trust manager (`sun.security.ssl.X509TrustManagerImpl` `checkServerTrusted`
overloads). When the default check throws `CertificateException`, the advice re-checks the chain's
signature against Alfred's CA (read from `data/certs/mitmproxy-ca-cert.pem`, path passed in the agent
args). It accepts only if that check passes, so any other untrusted chain still fails. This covers
HTTPS clients that already exist, because their `SSLContext` still calls the same trust manager
class. It does **not** cover apps with their own custom `X509TrustManager` or certificate pinning;
`alfred jvms` warns about that, and docs list it.

**Rationale**: It reuses the agent's existing instrumentation framework (`Instrumenter`, `advice/`)
and the attach logic that already works.

**Alternatives considered**:
- `SSLContext.setDefault`: misses clients created before the attach.
- Writing to `cacerts`: the spec forbids it (FR-072) and the JVM would not reload it anyway.

**SPIKE S2**: bundled JDK 21 `jdk.attach` attaching to running JDK 8, 11 and 17 HotSpot JVMs (WildFly
26) on Linux and Windows. Fallback if a combination fails: run `attach-cli` with the target's own
`java` (found from the process command line) plus its `tools.jar` on JDK 8.

**SPIKE S3**: the trust advice on JDK 8, 11, 17 and 21, with `HttpURLConnection`, Apache HttpClient 4
(system properties) and the JDK 11+ `HttpClient` already created before the attach.

**Limitation (unchanged from today)**: clients that do not read the proxy system properties, such as
Apache HttpClient without `useSystemProperties()`, are not proxied. `docs/server.md` says so.

---

## R13. Claude tools (MCP) over the network

**Decision**:
- `mcp-server/src/index.ts` chooses its transport from an environment variable: stdio as today, or
  Streamable HTTP (`@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`) on
  `127.0.0.1:<internal port>`.
- The backend exposes `/mcp` and relays to it, streaming (`HttpClient` `ofInputStream`, copy with
  flush per chunk, for SSE responses). `/mcp` is added to the API prefix list (R5) and to the gateway
  regex.
- **Exports** requested through Claude (FR-081) go to `data/exports/`. The tool result includes
  `http(s)://<host>/mcp-exports/<name>`, served by the backend with
  `Content-Disposition: attachment`. Files older than 7 days are removed at start (retention,
  Constitution II).
- **Access (FR-082)**: `/mcp` and `/mcp-exports/**` are reachable wherever the UI is: this machine, the
  LAN and the Cloudflare tunnel. `EditAccessFilter` applies only to `/server/**` writes. This is the
  owner's decision (clarification 2026-10-07). It matches today's exposure, since the UI and its API
  already let anyone with the tunnel URL read calls and change comments and capture switches.
  `docs/server.md` states it plainly: whoever has the tunnel URL can drive Claude's tools.
- The stdio mode stays for local use (`setup_mcp.py`).

**Alternatives considered**: the MCP server on its own port (breaks FR-004); a Java rewrite (see R2).

---

## R14. Native path differences from Docker

| Concern | Docker today | Native |
|---|---|---|
| Upstream host for reverse proxy | `host.docker.internal` | `127.0.0.1` |
| Webhook URL | `http://backend:5000/...` | `http://127.0.0.1:${ALFRED_UI_PORT}/...` |
| `BACKEND_HOST` (resend trust) | `backend` | `127.0.0.1` |
| Outbound attribution listener | container port 20000+i, published at `outboundHost:outboundPort` | binds `outboundHost:outboundPort` directly |
| Flag files, interception snapshot, CA | bind mounts under `proxy/` | `data/proxy/`, `data/proxy/interception/`, `data/certs/` |
| Watched log folders | bind mounts, `name:hostPath` mapped to `/logs/...` | host paths used directly by `LocalWatchFolders` (new native path mapping) |
| Windows file-change events for open files | host log agent | same log agent, run by the supervisor |
| Webhook secret | `change-me-in-production` | random 32-byte value written to `.env` at install (`WEBHOOK_SECRET`, marked secret) |
| Hosts-file entries | `start.py` | not needed |
| OS/JDK certificate trust | `start.ps1`/`start.sh` + `jdks.txt` | the agent's in-JVM trust (R12); no system change |

User settings reach each process through one map, `settings-env-map.json` (data-model), not through hand-written lists in the supervisor. Internal paths (database files, flags, upload folders) are not user settings. The supervisor passes them
to the backend as the same environment variables `docker-compose.yml` uses today, pointing under
`data/`.

---

## R15. Watched folders and projects carry more than the mock showed

`ALFRED_LOGS_WATCH_DIRS` is `name:path,...` (see `LocalWatchFolders`), not bare paths. Each watched
folder row in the UI therefore has **Name** and **Path**. On Windows a path contains `:` (`C:\logs`),
and parsing splits on the first `:` only.

`INTERNAL_CALL_SERVICES` entries may carry optional outbound attribution
(`name:listen:upstream[:outboundHost[:outboundPort]]`, `start.py` `_parse_service_entries`). The
projects table gets an optional **Outbound address** column, collapsed by default.

Both are small mock adjustments. They are reflected in `data-model.md`, and the mock should be updated
before UI work starts.

---

## R16. Service account: root / LocalSystem by default

**Decision**: The service runs as `root` on Linux and `LocalSystem` on Windows by default, because the
Java apps on staging usually run as root or Administrator, and attaching needs the same user
(clarification 2026-10-07). `--user` (Linux) or the wizard's account page (`/SERVICEUSER=`, Windows)
picks another account.

**Consequences**:
- **Linux, root service**:
  - All children inherit root: backend, proxies, MCP and the log agent.
  - `CAP_NET_BIND_SERVICE` is only needed when another account is chosen.
  - `.env`, `data/run/control.json` and `data/` are `0600`/`0700`, owned by the service account, so
    other local users cannot read secrets or the control token.
- **Attaching to an app owned by a different user**: `alfred attach` running as root switches to the
  target's owner for the attach step (`setuid` through `runuser -u <owner>` when present, else
  `su -s /bin/sh <owner> -c`). HotSpot refuses an attach from a different effective uid.
- **Windows**: `LocalSystem` can open any process. Attaching to a JVM run by an interactive
  Administrator session is added to **SPIKE S2**. If it fails, the attach CLI uses the target's own
  `java` with `tools.jar`/`jdk.attach` under the app's session, which needs the user to run
  `alfred attach` from that session. Docs then say so.
- **Reduced exposure while running as root**:
  - Probes read no file contents.
  - The control API is localhost and token only.
  - The proxies bind only the configured addresses.
  - `/mcp` is reachable through the tunnel (R13) but acts only through Alfred's own HTTP API, never
    on the file system or a shell. The one exception is `export_calls`, which writes into
    `data/exports/` only: in HTTP mode the MCP server's `exportFolder` is pinned there, and paths that
    resolve outside it are refused.

**Alternatives considered**: a dedicated `alfred` user (cannot attach to root-owned apps without extra
sudo rules); asking at install time with no default (the owner chose the default).

---

## R17. Importing an existing Docker install (FR-002d)

**Decision**:
- **Detection**: a running `backend` container whose compose project label points to a folder
  containing `docker-compose.yml` and `start.py`, or `--import-docker <folder>` given explicitly.
  Interactive installs ask "Import settings and data from <folder>? [Y/n]". Unattended installs import
  only with `--import-docker`.
- **What is copied, into `data/.import-tmp/` first**:

| From (Docker) | To (native) |
|---|---|
| `<repo>/.env` | merged into `.env`: user keys copied, Docker-only keys (`BACKEND_PORT`, `BACKEND_DEBUG_PORT`, `COMPOSE_PROFILES`, `FORWARD_PROXY_PORT_MAP`, `ALFRED_LOGS_WATCH_MODE_RESOLVED`) dropped and listed |
| `<repo>/backend/data/**` | `data/appdata/` |
| named volumes `logs-db`, `db-capture-db` | `data/` (`logs.db`, `db-capture.db`), exported through `docker run --rm -v <project>_<vol>:/v:ro alpine tar -C /v -c .` |
| `<repo>/proxy/*.flag`, `proxy/interception/**` | `data/proxy/` |
| `<repo>/proxy/certs/**` | `data/certs/` (same CA, so apps that already trust it keep working) |

- **Order**:
  1. Check free disk against the total size first.
  2. Copy everything into the temp folder.
  3. `docker compose stop` (backend writes stop).
  4. Copy again only what changed during the copy, by size and mtime.
  5. Move into `data/`, and record an `IMPORT` history entry.
- **Failure handling**: any failure deletes the temp folder and runs `docker compose start`, leaving
  the Docker install running. The native install then starts empty, and the installer says what
  failed.
- **Never touched**: the Docker folder and volumes are never modified or deleted.
- **Settings paths**: Docker-mapped paths (`ALFRED_LOGS_DIR=./logs-drop`, relative to the repo) are
  rewritten to absolute paths of the same folders, so log sources keep pointing where they did.

**Rationale**: Copy, not move, so a failed or abandoned native install never costs the user their
recorded data.
