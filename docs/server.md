# Alfred as a program (native install)

Alfred can run without Docker: one installer per OS puts everything it needs on the server (Python, Java and Node
included), and an `alfred` command plus a system service run it. This is the usual setup on a staging server you
reach over SSH. The Docker install (`start.py`, `docker-compose.yml`) keeps working as before. Design: specs/012-server-program.

## Install

On the developer machine, build both installers from the current code (needs only Docker and Python):

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
alfred config list [--changed] | get KEY | set KEY VALUE | reset KEY | add KEY ITEM | remove KEY ITEM
alfred config add-missing | check | diff | history | revert ID [--yes] | import FILE [--yes]
alfred project add NAME LISTEN_PORT APP_PORT [--outbound HOST[:PORT]] | project remove NAME
alfred jvms | attach PID [--proxy] [--db] [--logs] [--redis] [--project NAME] | detach PID [flags]
alfred uninstall [--keep-data]
```

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
is attached as that user (`runuser`): a direct cross-user attach fails and makes the app dump its threads.

### Attach limits

- An app with its own `X509TrustManager` or certificate pinning does not use the JDK's trust manager; it needs
  Alfred's CA in its trust store (`-Djavax.net.ssl.trustStore`, or `start.py`'s `jdks.txt` route).
- Clients that ignore the proxy properties (a JDK `HttpClient` built without a `ProxySelector`, Apache clients without
  `useSystemProperties`, OkHttp with its own proxy) are not routed. Check with one test call.
- On Windows, a JVM running in another session may need `alfred attach` run from that session as Administrator.
- JDK 21 prints a warning when an agent is loaded dynamically; `-XX:+EnableDynamicAgentLoading` silences it.

`wildfly-proxy-toggle/*.sh|bat` hand over to these commands when a native install is found.

## Claude (MCP) on another machine

```bash
claude mcp add --transport http alfred http://localhost:3000/mcp
```

Use whatever address you open the UI on. Exports come back as `/mcp-exports/<name>` downloads. See docs/mcp.md.

## Uninstall

`alfred uninstall` removes the service and the program and asks before deleting `data/`; `--keep-data` keeps it.
