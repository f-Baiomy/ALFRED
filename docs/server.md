# Alfred as a program (native install)

Alfred can run without Docker: one installer per OS puts everything it needs on the server (Python, Java and Node
included), and an `alfred` command plus a system service run it. This is the usual setup on a staging server you
reach over SSH. The Docker install (`start.py`, `docker-compose.yml`) keeps working as before. Design: specs/012-server-program.

## Install

**From a published release, one command** (the machine needs nothing else; `install.sh` / `install.ps1` at the repo
root read `releases/latest/download/latest.json`, download the target's installer, check its sha256 and run it
unattended - `ALFRED_RELEASE_URL` points them at another `latest.json`):

```bash
curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh                 # Linux x86_64
curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh -s -- --ui-port 3017
```

```powershell
irm https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.ps1 | iex     # Windows, administrator PowerShell
$env:ALFRED_INSTALL_ARGS = '/DIR=D:\alfred /UIPORT=3017'; irm https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.ps1 | iex
```

**Building the installers yourself:** on the developer machine, build both installers from the current code (needs only Docker and Python):

```bash
python build_dist.py                       # dist/alfred-setup-<version>-linux-x64.run and -windows-x64.exe, SHA256SUMS
python build_dist.py --target linux --skip-tests --dns 8.8.8.8
```

Every download is pinned with its sha256 in `build-versions.json` and done inside a container (the host's DNS is not
needed); the Java runtime is a `jlink` image of JDK 21, Python is python-build-standalone with mitmproxy installed by
`uv`, Node runs the bundled MCP server. Linux: about 240 MB.

On the server, nothing else is needed:

```bash
sudo sh alfred-setup-<version>-linux-x64.run [--dir /opt/alfred] [--user root] [--ui-port 3000] [--import-docker <folder> | --no-import] [--unattended]
```

```bat
alfred-setup-<version>-windows-x64.exe          (wizard)
alfred-setup-<version>-windows-x64.exe /S [/DIR=C:\alfred] [/UIPORT=3000] [/SERVICEUSER=LocalSystem] [/IMPORTDOCKER=<folder>]
```

The installer extracts to a temp folder first (an interrupted install never touches the existing one), keeps `.env`
and `data/` on upgrade, refuses a downgrade unless asked, rolls back on failure, creates `.env` on a first install,
offers to import an existing Docker install, and registers the service: systemd `alfred.service` on Linux (without
systemd it says so - start it with `alfred start`), WinSW on Windows. **The service runs as root / LocalSystem by
default**, because the Java apps Alfred attaches to usually do; `--user` / `/SERVICEUSER=` picks another account.

**Same machine as a Docker install?** The Docker install holds `3000` and `127.0.0.2:443` too. Either import it
(below - its containers are stopped), stop it (`docker compose stop` in its folder), or give the native install
other addresses: `--ui-port 3017` at install, then `alfred config set ALFRED_OUTBOUND_PROXY_LISTEN 127.0.0.3:443`
and `alfred restart`. A clash is reported by `alfred start` / `alfred status` with the setting to change.

**Windows firewall:** the installer changes nothing system-wide, so the UI is reachable from the LAN only after
the firewall allows `runtime\java\bin\java.exe` (Windows Defender Firewall > Allow an app); localhost and SSH
tunnels work without it.

### Importing a Docker install

`--import-docker <repo folder>` (or the wizard's question) stops the Docker containers, copies their recorded data
(calls, cycles, settings, certificates), merges the Docker `.env` into the new one (keys only Docker uses are listed
and skipped), and moves any existing native `data/` aside. If anything fails, the copied files are removed and the
Docker install is left as it was.

## Settings: `.env` and `settings.properties`

- `<install>/.env` holds the settings and is created on the first start with **every setting at its default**, each
  with a comment. It is yours: upgrades never change it. It is readable only by its owner (0600 on Linux).
- A key missing from `.env` uses its default from `settings.properties` (replaced on upgrade, so new settings arrive
  with their defaults). The Server section shows such a key as "default, not in .env" and offers to add them.
- Only two things write `.env`: the settings engine (Server section and `alfred config`, both through the same
  service, with a history of every change) and the installer's first-start/import step. A hand edit is detected and
  recorded in the history as "edited by hand".

## The Server section (Settings tab)

Every deploy-time setting with its value, where it came from, and what a change needs:

| Applies | Meaning |
|---|---|
| live | applied at once by the backend (retention, storage caps, watched folders, edit access, ...) |
| proxies restart | the supervisor restarts the two proxies (about 2 s); the UI and the backend stay up |
| restart | waits for "Restart Alfred" (memory, UI port, ...); listed as pending until then |

Values are checked as you type (format, plus the machine: a port in use and by which process, a folder that does
not exist, a size above the free disk, memory above the free RAM). "Check everything" runs every check. A save
shows the exact `.env` lines before and after; it is refused if `.env` changed meanwhile. **History** lists the last
50 changes and can put the old values back in the form. **Download .env** (secrets hidden) and **Upload .env**
copy settings between servers: uploaded values are checked and only the picked, valid ones go into the form.
**Restart** restarts the backend, or only the proxies; the page follows over `/ws/server` and reconnects.

### Who may change settings

`ALFRED_SETTINGS_EDIT_FROM` (default `local,lan`): `local` is this machine, `lan` private network addresses, plus any
addresses or CIDR ranges. The backend decides from the TCP peer address (never `X-Forwarded-For`). **Requests through
the Cloudflare tunnel are always read-only**, recognised by its headers. Everyone else sees the section read-only with
a note on how to get edit rights (an SSH tunnel: `ssh -L 3000:localhost:3000 staging`, then `http://localhost:3000`).

Residual risk, accepted: anyone on the LAN who can open the UI can change settings while `lan` is listed, and `/mcp`
(Claude's tools) is open wherever the UI is - including the tunnel. Remove `lan` on a shared network.

In the Docker install the section is read-only and explains how to change `.env` there.

## The `alfred` command

```bash
alfred start | stop | restart [--proxies] | status | run | logs [backend|outbound|reverse|mcp|supervisor] [-f] | version
alfred update [--check]          read the release feed now; without --check, install the update (Alfred restarts)
alfred config list [--changed] | get KEY | set KEY VALUE | reset KEY | add KEY ITEM | remove KEY ITEM
alfred config add-missing | check | diff | history | revert ID [--yes] | import FILE [--yes]
alfred project add NAME LISTEN_PORT APP_PORT [--outbound HOST[:PORT]] | project remove NAME
alfred jvms | attach PID [--proxy] [--db] [--logs] [--redis] [--project NAME] | detach PID [flags]
alfred uninstall [--keep-data]
```

**Run every command except `version` and `jvms` as root (`sudo alfred ...`) or from an Administrator prompt on
Windows** - `status` and `logs` included. `data/` and `.env` are readable only by the service account and root /
Administrators, so another account cannot even see whether Alfred runs. Such a command is refused with exit code 5
and says how to run it; it used to answer wrongly instead ("not running", "No log yet", or on Windows a
`FileExistsError` on `data\appdata`, because Windows hides a locked folder's contents).

`alfred config` goes through the running backend (the change applies live, exactly as from the UI, and the history
records it as a CLI change by your OS user); with Alfred stopped it writes `.env` itself and the change takes effect
at the next start. Exit codes: 0 ok, 1 error, 2 usage, 3 a value refused, 4 `.env` changed meanwhile, 5 not allowed
(not root / the service account).

## What runs

`alfred run` (what the service runs) is a small supervisor (`packaging/launcher/supervisor.py`) that starts the
backend (which also serves the UI on the UI port), the outbound proxy, the reverse proxy when inbound logging is on,
the MCP server on 127.0.0.1 behind `/mcp`, and on Windows the log agent. It restarts a crashed child with back-off and
gives up after 5 crashes in 5 minutes. Its control API listens on 127.0.0.1 with a token in `data/run/control.json`.
Logs are in `data/log/`.

## Java apps: `alfred jvms`, `attach`, `detach`

`alfred jvms` lists the Java processes on the machine (PID, name - WildFly by its home -, user, what Alfred does in
it). `alfred attach PID` loads `alfred-agent.jar` into a running app through the Attach API, without a restart:

- `--proxy` (the default): routes the app's outbound HTTP/HTTPS through Alfred (`http(s).proxyHost`), and **trusts
  Alfred's CA inside that JVM**, so no restart for certificate trust is needed (spike S3: JDK 8, 11, 17, 21;
  HttpsURLConnection, Apache HttpClient 4 and the JDK HttpClient, even clients created before the attach).
- `--db`, `--logs`, `--redis`: database, log and Redis capture for a project (`--project`, unless exactly one exists).

Attaching again changes the features; `detach` turns them off (an agent cannot be unloaded; off is a switch). The
webhook secret and the CA are passed in the environment, never on a command line. On Linux a JVM owned by another user
is attached as that user (`runuser`): a direct cross-user attach fails and makes the app dump its threads. On Windows
the service runs as LocalSystem while a developer's app (WildFly from the IDE) runs as them, and a JVM lists and accepts
attaches only from its own user: the service borrows the app process's own token and runs attach-cli as its owner, in
the owner's environment plus the `ALFRED_AGENT_*` values (`packaging/launcher/win_runas.py`, no password, nothing
logged on). Unprivileged callers still may not attach to another user's app; the supervisor's detail - shown on the
Server card and in the ◆ popover - then names both users.

### The agent attaches itself

Nobody has to run `alfred attach` for a project's capture to work: **a project's app is the JVM listening on its
upstream port** (`internal_call_services` = `name:listenPort:upstreamPort`), so the supervisor finds it by itself.
Each project has an **attach mode** (Settings → Database capture → Agent, and the same picker in the ◆ popover of
the Sources bar on Live Calls - one setting, two places; both share `shared/utils/attach-features.ts`):

- **When asked** (the default): the backend asks the supervisor (`POST /agents/attach` on the control API, through
  `backend-app/agentbridge/AgentAutoAttachBridge`) when Alfred starts, whenever an inbound call arrives for a
  project whose agent has not reported in 30 s (one ask per project per 30 s), and when a mode is picked or "Attach
  now" is clicked.
- **Automatic**: all of the above, and the supervisor **watches the project's upstream port** (a TCP connect probe
  every 2 s, the pid re-read every 15 s): the moment the app's port opens, or its pid changes (a restart), it tells
  the backend (`APP` event) and the agent is loaded within seconds - before the app's first call, forced past the
  retry window. For an app that starts after Alfred, or restarts often.
- **Off**: never by itself; `alfred attach` still works.

The supervisor looks up the pid on the port, checks it is a
Java process, loads `alfred-agent.jar` with the features the project's settings say (`db,logs,redis`, plus `proxy`
when "route its outbound calls through Alfred" is on - the default), as the app's owner on Linux. The outcome per
project is on the Server card (`attached by itself` / `no app to attach to` / `attach failed: <why>` with an
"Attach again"), pushed as a supervisor event named `AGENTS`. A pid that failed is not retried for 5 minutes unless
forced. Both settings are per project (`attachMode`, `attachProxy` in the project's capture settings; the proxy
feature on by default); Docker installs have no supervisor and keep `start.py --db-capture on`.

Independently of who attached it, the agent reports to the Alfred whose reverse proxy delivers its calls
(`alfred=`/`key=` in `X-Alfred-Call`, docs/db-capture.md), so a stale `-javaagent` line can no longer send captures
to a port nothing listens on.

### Attach limits

- An app with its own `X509TrustManager` or certificate pinning does not use the JDK's trust manager; it needs
  Alfred's CA in its trust store (`-Djavax.net.ssl.trustStore`, or `start.py`'s `jdks.txt` route).
- Clients that ignore the proxy properties (a JDK `HttpClient` built without a `ProxySelector`, Apache clients without
  `useSystemProperties`, OkHttp with its own proxy) are not routed. Check with one test call.
- On Windows, a JVM running in another session may need `alfred attach` run from that session as Administrator.
  The service attaches as LocalSystem (which holds the debug privilege the Attach API needs); if that fails for an
  app in an interactive session, the Server card says so and `alfred attach` from that session is the fallback.
- JDK 21 prints a warning when an agent is loaded dynamically; `-XX:+EnableDynamicAgentLoading` silences it.

`wildfly-proxy-toggle/*.sh|bat` hand over to these commands when a native install is found.

## Updates

A release is a git tag. `python release.py` cuts one: it shows the latest release and the commits since, suggests
the next version (patch; type a minor or major one), asks for release notes, refuses from a branch other than
master, with uncommitted changes or with master out of sync with GitHub, then tags `vX.Y.Z` and pushes (`--here` builds and
publishes from your machine with `gh` instead). Installers for your own use come from `python build.py`, which asks
Windows / Linux / both, tests or not, and the build DNS (remembered in `.env`). The `release` workflow
(`.github/workflows/release.yml`) builds both installers with `build_dist.py`, tests included, and publishes them
with `SHA256SUMS` and **`latest.json`** as a GitHub Release. `latest.json` names the version, the tag's annotation
as release notes, and per target the installer's URL, sha256 and size. Untagged builds are named by commit hash and
are never offered as updates.

Each native install reads `ALFRED_UPDATE_URL` (default: this repository's
`releases/latest/download/latest.json`) a minute after it starts and once a day after that - one small HTTPS GET,
no installer is downloaded. The result is in the Server card's **Updates** row, in `alfred status`'s neighbour
`alfred update --check`, and is pushed to open pages over `/ws/server`. Settings, all live (Settings tab > Updates,
or `alfred config set`):

| Setting | Default | Meaning |
|---|---|---|
| `ALFRED_UPDATE_MODE` | `check` | `off`: never look. `check`: look and show. `auto`: look and install, inside the window. |
| `ALFRED_UPDATE_URL` | GitHub Releases | The `latest.json` to read. A `file://` URL to a folder on a share serves servers without internet: copy the release's files there. |
| `ALFRED_UPDATE_WINDOW` | `02:00-04:00` | When an automatic install may stop and start Alfred (server time zone, may wrap midnight; empty = any time). |

**Installing** (the card's *Install update*, or `alfred update`) is a settings write: allowed from the machine and
the LAN, never through the tunnel. The backend asks the supervisor; the supervisor downloads the installer into
`data/updates/`, verifies its sha256 against `latest.json` (a mismatch or a missing checksum is refused), and runs
it detached from Alfred - Windows: silently, outside the job object; Linux: as a transient `systemd-run` unit - so
stopping the service does not kill the installer. The installer does what it always does: stop, replace the program
files, keep `.env` and `data/`, start, record `UPGRADE` in the history; a failure puts the previous version back.
The page reconnects by itself and reports the running version; `data/log/update.log` has the installer's output.
In Docker mode the row shows the release and points at `python3 deploy.py`; nothing is downloaded.

## Claude (MCP) on another machine

```bash
claude mcp add --transport http alfred http://localhost:3000/mcp
```

Use whatever address you open the UI on. Exports come back as `/mcp-exports/<name>` downloads. See docs/mcp.md.

## Uninstall

`alfred uninstall` removes the service and the program and asks before deleting `data/`; `--keep-data` keeps it.
