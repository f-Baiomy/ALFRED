# Contract: `alfred` command line

The same commands on Linux (`/opt/alfred/alfred`, linked as `/usr/local/bin/alfred`) and Windows
(`C:\alfred\alfred.cmd`, added to the machine `PATH`). Exit codes: `0` ok, `1` error, `2` usage error,
`3` validation refused, `4` conflict, `5` not allowed (not root / Administrator or the service account).

## Lifecycle

| Command | Does |
|---|---|
| `alfred start` / `stop` / `restart` | through the service manager when installed as a service, else in the foreground |
| `alfred restart --proxies` | supervisor `POST /restart/proxies` |
| `alfred status` | backend, proxies and MCP: state, pid, uptime, UI addresses |
| `alfred run` | the supervisor itself, in the foreground (what the service runs) |
| `alfred logs [backend\|proxy\|reverse\|supervisor] [-f]` | tail `data/log/*` |
| `alfred version` | version and commit |
| `alfred uninstall [--keep-data]` | remove service and program; asks before deleting `data/` |

## Settings (`alfred config`)

When the backend is running, every command goes through `/server/settings` on `127.0.0.1`. When it is
stopped, it goes through `ServerConfigCli` (research R7). The output is identical either way.

| Command | Example output |
|---|---|
| `config list [--changed]` | table KEY · VALUE · FROM (`.env`/default) · APPLIES, then the count of missing keys |
| `config get KEY` | the value |
| `config set KEY VALUE` | `✓ .env: KEY old → new   applied live` / `proxies restarted (2.1 s)` / `restart needed: run 'alfred restart'` |
| `config reset KEY` | removes the line; reports the default now used |
| `config add KEY ITEM` / `config remove KEY ITEM` | list settings: `INTERNAL_CALL_SERVICES`, `ALFRED_LOGS_WATCH_DIRS`, `ALFRED_SETTINGS_EDIT_FROM` |
| `project add NAME LISTEN APP [--outbound HOST[:PORT]]` / `project remove NAME` | shortcuts for the above |
| `config add-missing` | writes missing keys with defaults |
| `config check` | every check; ✓ / ⚠ / ✗ lines; exit `3` if any ✗ |
| `config diff` | values that differ from the defaults |
| `config history` | id, when, change, by |
| `config revert ID` | shows the diff, asks `[y/N]`, then saves |
| `config import FILE` | per value: shows, validates, asks `take? [y/N]` |

Sizes accept `500MB`, `2GB`, or raw bytes. Errors print the same message the UI shows, e.g.
`✗ ALFRED_UI_PORT: port 8080 is in use by java (pid 3120). Nothing saved.`

### Internal (used by the installer and launcher, not documented for users)

`ServerConfigCli init` (create `.env` from defaults plus a random `WEBHOOK_SECRET`),
`merge-docker-env <file>` (Docker import), `check-env` (print unknown or malformed lines at start).
These are the only native code paths that write `.env` outside the settings API.

HTTP calls made by `alfred config` carry `X-Alfred-Cli-User: <OS user>`. The backend trusts it only
from a loopback peer and records the history source as `CLI`.

## Java apps

| Command | Does |
|---|---|
| `alfred jvms` | PID · NAME (main class or WildFly home) · USER · ALFRED (features on) · NOTE (e.g. "custom trust manager: HTTPS may fail") |
| `alfred attach PID [--proxy] [--db] [--logs] [--redis] [--project NAME]` | loads or updates the agent; no flags = `--proxy`; `--db/--logs/--redis` need `--project` unless exactly one project exists |
| `alfred detach PID [--proxy] [--db] [--logs] [--redis]` | turns features off; no flags = all |

Runs as root / Administrator (the service default). For a JVM owned by another user, the attach step switches to that user automatically on Linux (research R16). On Windows a JVM in another session may need `alfred attach` run from that session; the error says so (exit `5`).
