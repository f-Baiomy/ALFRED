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

Both scripts show a step list that ticks off. Before downloading anything they check the machine: an install to
upgrade, free disk space, and who listens on the UI port and the outbound proxy's port. A UI port held by another
program stops the install before the download, naming the program; a busy proxy port is a warning, since the backend
still starts. The download runs over many connections (see "Updates") with a live line - bar, MB, speed, time left,
retried pieces - and, in Windows Terminal, progress on the taskbar icon. Installers are kept in a **download cache**
(`C:\ProgramData\Alfred\downloads`, `/var/cache/alfred`; the newest two): running the one-liner again, after a failed
install for example, takes the cached installer once its sha256 matches the release again. Under Linux, the `.run`
installer's own lines appear under "Installing" as they happen. The end is a box with the UI addresses; on Windows,
Enter opens the UI. Output redirected, `NO_COLOR` or `TERM=dumb`: plain lines, one per finished step, no escape codes.

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

- Inbound calls are stored in `<data>/internal-calls.db` (specs/013-inbound-calls-store): `INTERNAL_CALLS_RETENTION_ROWS`
  (count, live) and `INTERNAL_CALLS_MAX_SIZE_BYTES` (total size, restart) both apply - whichever is reached first.
  `INTERNAL_CALLS_STORAGE=file` (in `.env` only) keeps the older `internal-calls.log` store, which holds its retained
  calls in memory - the only case where the retention count is a memory question (the Server section warns then).

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
alfred update [--check | --cancel | --version X]   read the release feed now; without --check, install (Alfred restarts)
alfred doctor [--json]           check processes, ports, each project's app, the agent, disk, storage, updates, settings
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

**Output.** In a terminal every command shows its steps live, in colour: `start` ticks off each process as the
supervisor reports it up, `stop` each one as it stops, `update` follows the install to the end, `status` is a table,
`logs` colours levels (each line otherwise exactly as in the file). Piped, with `NO_COLOR` or `TERM=dumb`: plain lines,
one per finished step, no escape codes (packaging/launcher/term.py). A mistyped command suggests the closest one.

**`alfred` alone, in a terminal, opens the live panel** (`alfred panel` too; piped or as a non-administrator it prints
the help): processes with state, uptime and restarts, the Java apps and their agent, storage per store, inbound and
outbound calls in the last minute (sparklines), how many calls of the last hour need attention, the latest calls, and
one-key actions - `s` stop/start, `r` restart, `p` proxies, `l` logs, `t` the calls that need attention, `a` attach,
`u` update, `d` doctor, `o` open the UI, `q` quit. Anything that stops Alfred asks first; actions that print leave the
panel's screen, run the ordinary command, and come back on a key. It refreshes when the backend's WebSockets
(`/ws/calls`, `/ws/internal-calls`, `/ws/server`, `/ws/triage`) say something changed - no polling; the screen is
redrawn once a second for the clock and the 60 s window from what it already read. Narrow windows stack the two
columns, and a frame is never taller than the window (the oldest calls go first, the keys always stay).

**`alfred doctor`** checks, read-only: the processes (and restarts), who answers on the UI port (this install, another
Alfred, or another program - named), the outbound proxy listening, each project's reverse port and whether its app
answers on the upstream port, the agent the supervisor attached per project, free disk (warning under 10 % or 10 GB,
problem under 5 % or 2 GB), storage per store, the update state and download cache, and settings access. Each problem
comes with the command that fixes it. Exit code 1 when a check failed, 0 otherwise (warnings included); `--json` gives
`[{check, status, detail, fix}]`.

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

`alfred jvms` names, per Java app, the project whose app port it listens on. **`alfred attach` without a PID**, in a
terminal, lists the Java apps numbered and asks: a row number picks that app, any other number is taken as a PID (an
app the list does not show - another user's, say); Enter attaches nothing. The panel's `a` key does the same. Piped,
a missing PID is still a usage error.

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

### When Alfred stops, the agent lets go

Whatever attached the agent (auto-attach, "Attach now", `alfred attach`, `proxy-on`), it lets go of the app when
Alfred goes away, and everything it switched on goes off together. Before this, an app attached with `proxy` kept
sending its outbound calls to `127.0.0.2:443` after Alfred stopped, and every supplier call failed until the app
restarted.

- **How the agent knows.** It heartbeats Alfred every 10 s. A miss is retried after 2 s, and 3 misses in a row
  (about 15 s after Alfred stops) mean Alfred is gone. A miss is a connection nothing accepts, or 502-504 from a
  gateway whose backend is down. A slow answer or a 401/5xx means Alfred is there.
- **What it does** (`AgentRuntime.standDown`). The app's own proxy settings come back, so outbound calls go direct.
  Alfred's CA is no longer trusted. Database, log and Redis capture pause and the unsent queue is dropped. The
  hooks stay loaded but switched off: a JVM cannot unload an agent.
- **It comes back by itself.** While stood down the agent keeps heartbeating every 10 s. The first answer puts
  back the features of the last attach, unchanged. A new attach also resumes at once, with its own arguments.
- **`alfred jvms`** shows `stood down - Alfred unreachable at <url> (3 heartbeats missed) since HH:MM` in the NOTE
  column while it lasts (system property `alfred.agent.standby`).
- **Proxy-only attach.** The old `wildfly-proxy-toggle/WildFlyProxyAgent` (`proxy-on` without a native install) has
  no heartbeat. It checks the proxy port instead, every 5 s with a 1 s timeout: 3 refusals mean stand down, and the
  first accepted connection means resume. Its `off` now restores the proxy the JVM had before `on` instead of
  clearing it.
- **Tests.** `BatchSenderTest` covers the counting. `LateAttachIT` covers the whole cycle in a real JVM: attach with
  `proxy,db`, Alfred answers 502, the proxy properties are restored, Alfred answers 200, then the proxy and capture
  are back.

### The agent attaches itself

**Any order, no restarts.** The app may start before or after Alfred, and Alfred may be updated or reinstalled
while the app runs:
- **Never the installed file.** A JVM is never given `app/alfred-agent.jar`. The supervisor attaches a copy named by
  its content, `agents/alfred-agent-<sha256:16>.jar`. Installers replace `app/` and `runtime/` and never touch
  `agents/`, so every JVM keeps reading the copy it got.
- **What went wrong before.** On 2026-10-08 the 3.0.1 installer replaced the jar under a running WildFly. The
  agent's not-yet-loaded classes failed with `NoClassDefFoundError`, and since a JVM remembers a failed link, that
  app captured nothing until it restarted.
- **Where it lives.** `agents/` sits next to `app/`, readable by every user like `app/`, and not in `data/`,
  because the app's own user opens the file.
- **A newer build cannot replace an older one in a running JVM.** The same class names can't load twice, so the
  JVM keeps the older agent, which keeps capturing. The agent's version is `1.0.0+<digest>`; when it differs from the
  build Alfred attaches now (`jar` on the supervisor's agent entry), the ◆ popover says the current one loads on the
  app's next start.
- **Self-heal.** A hook that ever fails between its enter and exit can't mute a server thread for good: the next
  inbound call on that thread resets the agent's per-thread depths.
- **JBoss Modules first.** `Instrumenter` advises `org.jboss.modules.Module` in a pass of its own, before anything
  else, so WildFly deployments can see the bootstrap `Bridge`. Classes compiled before Java 6 have no stack maps,
  such as log4j 1.2's `Category` and c3p0 0.9's `NewProxy*`. Retransforming one runs the JVM's old verifier, which
  loads the types the inlined advice names through that class's own module loader. Before 2026-10-09, a late
  attach to WildFly rejected them with `VerifyError`, and they ran without capture until a restart.
  `ModuleVisibilityIT` loads log4j 1.2.17 through a stand-in module in another JVM, then attaches the agent.
- **Tests.** `db-agent` `LateAttachIT` covers these orders end to end, in a separate JVM over the real Attach API
  and HTTP sender: attach long after the app started, attach the moment it is up, and a newer build attached into a
  JVM that already runs one.

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
it outside Alfred's process tree - Windows: started through WMI (`Win32_Process.Create`, its parent is the WMI host),
because WinSW kills the service's whole process tree by parent pid when the service stops, and a detached child
of the supervisor died the moment the installer stopped the service; Linux: as a transient `systemd-run` unit. The
installer does what it always does: stop, replace the program files, keep `.env` and `data/`, start, record
`UPGRADE` in the history; a failure puts the previous version back. The page reconnects by itself and reports the
running version - Alfred back on the old version is reported as a failed update. `data/log/update.log` gets a line
when the installer starts and one with its exit code (0 ok, 1 failed, 5 not an administrator, 6 refused downgrade,
7 did not start - the previous version was put back).
In Docker mode the row shows the release and points at `python3 deploy.py`; nothing is downloaded.

**A new version that installs but does not start** (its port taken by another program, say) is undone too: on an
upgrade both installers keep the previous program files aside until the new version *answers*, not only until it is
copied. If it does not answer within 60 s, the previous version is put back and started (exit code 7), and
`data/updates/failed-start.txt` (the version, then the reason - `_wait-health` names the program holding the port)
lets the supervisor that starts next show the update as FAILED with that reason. `alfred update` then offers: retry,
another UI port (it lists free ones nearby, sets `ALFRED_UI_PORT`, restarts) then retry, or keep the running version.

**An update never leaves Alfred stopped (Windows).** 3.0.6 → 3.0.7 from the panel (2026-10-09): the installer
stopped the service, could not move `app\` aside, aborted - and nothing started Alfred again. What held `app\` was a
process outside the service: attach-cli, which the supervisor starts as the app's owner (`win_runas`) with its
working directory in `app\` and which can wait for good on a JVM paused in a debugger (WildFly with `suspend=y`). A
process's working directory locks that folder against a move; a running program's `.exe` and DLLs do not (measured:
a python.exe from `runtime\` running, `runtime\` still moves). Now:
- attach-cli runs with its working directory in the install folder itself, which is never moved.
- Before moving the folders the installer runs `make_way.py` (extracted next to the installer, run with the OLD
  install's python, so it works from any version): it stops every process still running a program from `runtime\`
  or `app\` - a leftover attach-cli, an old `alfred` window. Again after 5 failed tries.
- It tries the move for 30 s (15 tries, 2 s apart), putting back whichever folder had moved. If a folder stays in use
  (a terminal or an editor opened inside it - not Alfred's to stop), it starts the previous version again and writes
  `failed-start.txt` ending in `not-installed`: the update shows FAILED - "was not installed: its program folders
  were in use..." - instead of Alfred staying stopped.
- `alfred update` and the panel hand the end of an update to a script and exit, so the window that started it is not
  one of the programs `make_way.py` stops. `alfred.cmd` gives each run a follow-up script path
  (`ALFRED_FOLLOW_SCRIPT`); once the installer runs, the CLI writes there a PowerShell script that watches the rest
  (Alfred down, the new version answering, or the old one back with `/server/update`'s reason) and exits with code
  75; `alfred.cmd` then runs it. From the panel - also for an update started on the web UI - the script opens the
  panel again from the new install. The script runs inside one parenthesised block of `alfred.cmd`, which cmd parses
  whole before running it: the installer replaces `alfred.cmd` meanwhile, and cmd would read on from the old offset.

**Restart from the web UI or the terminal.** `POST /restart/backend` restarts the backend 1 s after the supervisor
answered (`BACKEND_RESTART_DELAY_SECONDS`): the backend asks from inside the Server card's request, and on Windows a
stop is TerminateProcess - the page read the cut connection as "the restart could not be started". Without a service,
`alfred stop`/`alfred restart` wait until the supervisor has exited (SIGTERM only asks); `alfred restart` used to find
it still answering, say "already running", start nothing - and Alfred stopped a moment later.

`tests/e2e/restart_update_e2e.py` checks all of it - restart and update from the terminal and the web UI, a leftover
program of the install with its working directory in `app\`, a folder held by something else - against a copy of the
staged Windows install (no service, no admin; port 3017), with a stand-in installer that moves the folders and runs
`make_way.py` the way `installer.nsi` does. In the Linux container (`tests/e2e/run_in_container.sh`) it runs after
the real installer.

**Pause, cancel, the download cache.** While the installer downloads, the card's dialog has *Pause* and *Cancel*,
and `alfred update` asks on Ctrl+C. *Pause* stops and keeps the pieces (`<installer>.part` plus `.part.json`: version,
sha256, size, the pieces that are complete); the next install of the same release - *Resume* on the card, or
`alfred update` - fetches only the missing pieces, also after Alfred restarted. *Cancel* (or `alfred update --cancel`,
or *Discard* on a paused one) deletes them, so the next update starts from 0. A verified installer stays in
`data/updates` (the newest two): installing that release again - a retry after a failed start - needs no download,
only the sha256 checked again. Installing can't be paused: by then Alfred is being replaced.

**Choosing a release.** `latest.json` also lists the ten releases before it (`releases`: version, date, the first line
of the notes, the installers), written by `build_dist.py` from the `latest.json` it replaces
(`ALFRED_PREVIOUS_MANIFEST`, set by the release workflow and `release.py --here`). A server several releases behind sees
them all: the card's dialog and `alfred update` list them newest first - the newest contains the others, and picking
it drops a paused download of an older one - and `alfred update --version X` installs one directly. Only releases
newer than the running one are offered.

## Claude (MCP) on another machine

```bash
claude mcp add --transport http alfred http://localhost:3000/mcp
```

Use whatever address you open the UI on. Exports come back as `/mcp-exports/<name>` downloads. See docs/mcp.md.

## Uninstall

`alfred uninstall` removes the service and the program and asks before deleting `data/`; `--keep-data` keeps it.
