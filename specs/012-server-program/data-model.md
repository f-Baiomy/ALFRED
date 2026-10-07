# Data Model: Alfred as a Server Program

Domain types of the new `backend-server` slice (pure Java records and enums, no Spring), plus the
files the native install keeps on disk. Validation rules map to FR-030 and FR-031.

## Domain types

### SettingDefinition (catalog entry, static)

| Field | Type | Notes |
|---|---|---|
| key | String | `.env` name, e.g. `INTERNAL_CALLS_RETENTION_ROWS` |
| group | SettingGroup | `PROJECTS`, `NETWORK`, `STORAGE`, `LOGS`, `WILDFLY`, `SECRETS` |
| label, help | String | UI text |
| kind | SettingKind | `BOOLEAN`, `INTEGER`, `SIZE_BYTES`, `MEMORY`, `PORT`, `HOST_PORT`, `PATH`, `ENUM`, `PROJECT_LIST`, `FOLDER_LIST`, `ACCESS_LIST`, `SECRET` |
| defaultValue | String | read from `settings.properties` at start, never hard-coded twice |
| applies | ApplyMode | `LIVE`, `PROXIES`, `RESTART` (see research R8) |
| enumValues | List<String> | for `ENUM` |
| min, max | Long | for numbers and sizes, e.g. retention 100..1,000,000 |

The catalog is one Java class. `settings.properties` holds only defaults, in its existing
`key=${ENV:default}` format, so the catalog never repeats a default value.

### SettingValue (what the UI and CLI show)

| Field | Type | Notes |
|---|---|---|
| key | String | |
| value | String | effective value; `"••••"` for `SECRET` unless the caller only asks whether it is set |
| source | Source | `ENV_FILE`, `DEFAULT`; `PROCESS_ENV` in Docker mode (read-only, FR-054) |
| differsFromDefault | boolean | drives "only changed from default" |
| pending | PendingRestart? | present when saved but not yet in effect |

### EnvDocument (`.env` model)

An ordered list of lines: `Comment`, `Blank`, `Entry(key, rawValue)`, `Unknown(text, lineNo)`.
- `set(key, value)`: replaces the entry in place, or appends it under its group's header comment
  (headers are created when missing).
- `remove(key)`: deletes the entry line only.
- `render()`: returns the exact original text for every line not touched. A round trip of an unchanged
  file gives the same bytes.
- `contentHash`: SHA-256 of the file as read, used for conflict detection.

### SettingsChange (one save request)

`baseHash` (hash the editor loaded) plus a list of `Edit(key, newValue | RESET)`.

Validation produces `ValidationResult(key, level ERROR|WARNING, message)`. Save is refused if any
result is `ERROR` (FR-031).

### Validation rules by kind

| Kind | ERROR when | WARNING when |
|---|---|---|
| PORT | not 1..65535; in use by another process (named); duplicates another listen port | none |
| HOST_PORT | malformed; port in use by a process other than Alfred | the address is not local to this machine |
| SIZE_BYTES | not a positive size; below 10 MB | below what is stored now (states how much is removed); limits total more than free disk |
| MEMORY | not `<n>g` or `<n>m`; below 512m | above free RAM; below 1g |
| INTEGER | outside min..max | retention memory estimate above 50% of `ALFRED_MEMORY` |
| PATH | not absolute (`./` relative to the install folder allowed); not found; not readable | empty folder |
| ENUM | not in `enumValues` | none |
| PROJECT_LIST | entry malformed; duplicate name or listen port; listen port in use; listen port equals upstream port | app not answering on its upstream port |
| FOLDER_LIST | entry not `name:path`; duplicate name or path; path invalid (as PATH) | none |
| ACCESS_LIST | token not `local`, `lan`, an IP, or a CIDR | the list does not include `local` (could lock out the machine itself; the CLI can still change it) |

### Project (element of PROJECT_LIST)

`name` (`[A-Za-z0-9_-]{1,40}`), `listenPort`, `upstreamPort`, optional `outboundHost` and
`outboundPort` (port defaults to 443). Serialised as
`name:listen:upstream[:outboundHost[:outboundPort]]`, comma-separated. That is the same grammar as
`start.py` `_parse_service_entries`, ported once to Java for the slice and kept in the shared Python
module for the supervisor and `start.py`.

Health (not stored): `ANSWERING` with status and latency, or `NOT_ANSWERING` with a reason.

### WatchedFolder (element of FOLDER_LIST)

`name` (`[A-Za-z0-9_-]{1,40}`) and `path`. Split on the first `:` only, because Windows paths contain
`:`.

### HistoryEntry

| Field | Type |
|---|---|
| id | long, increasing |
| at | Instant |
| source | `UI` (with client address), `CLI` (with OS user), `HAND_EDIT`, `INSTALL`, `UPGRADE`, `IMPORT` (with the Docker folder), `REVERT` (with the reverted id) |
| changes | List<(key, before, after)>; secret values recorded as `set`/`changed`, never the value |
| snapshotFile | name of the `.env` copy taken before this change |

Retention: the last 50 entries and their snapshots. Older ones are deleted on append.

### PendingRestart

`key`, `before`, `after`, `savedAt`. Kept until the backend starts with `after` in effect.

### ServerStatus (Server card)

`version`, `installDir`, `mode` (`NATIVE` | `DOCKER`), `startedAt`, `backend` (pid, heap used/max),
`proxies[]` (`OUTBOUND` | `REVERSE`, state `RUNNING` | `STOPPED` | `RESTARTING` | `CRASHED`, pid,
listeners, calls in last hour), `mcp` (state).

### EditAccess

`allowed` (boolean), `reason` (`LOCAL`, `LAN`, `LISTED`, `TUNNEL`, `NOT_LISTED`, `DOCKER_MODE`),
`clientAddress`, `howToEdit` (text for read-only viewers).

### State transitions

Proxy process:
```
STOPPED --start--> RUNNING --crash--> CRASHED --auto restart (back-off 1s,2s,5s,max 30s)--> RUNNING
RUNNING --restart request--> RESTARTING --> RUNNING
```

Setting value:
```
DEFAULT --set--> ENV_FILE (+pending if RESTART) --restart--> ENV_FILE (in effect)
ENV_FILE --reset--> DEFAULT
```

## Setting → process variable map (`settings-env-map.json`)

One JSON file read by the backend slice (Docker-mode effective values, tests) and by the supervisor
(native environment). A test fails if a catalog key is missing or names a variable no code reads.

| `.env` key | Backend variable (native) | Proxies / other | Docker source today |
|---|---|---|---|
| `REVERSE_PROXY_ENABLED` | `REVERSE_PROXY_ENABLED` | supervisor starts/stops REVERSE | same name |
| `INTERNAL_CALL_SERVICES` | `INTERNAL_CALL_SERVICES` | REVERSE `--mode` args; OUTBOUND extra listeners (`FORWARD_PROXY_PORT_MAP` derived) | same name |
| `INTERNAL_CALLS_RETENTION_ROWS` | `INTERNAL_CALLS_RETENTION_ROWS` | | same name |
| `ALFRED_CALLS_MAX_SIZE_BYTES` | `ALFRED_CALLS_MAX_SIZE_BYTES` | | was hard-coded `10737418240` in compose; now `${ALFRED_CALLS_MAX_SIZE_BYTES:-10737418240}` |
| `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES` | same | | same |
| `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES` | same | | same |
| `ALFRED_LOGS_DIR` | `LOGS_ROOT_DIR` (absolute path) | | bind-mounted at `/logs` |
| `ALFRED_LOGS_WATCH_DIRS` | `LOGS_WATCH_DIRS` (host paths; `LOGS_WATCH_ROOT` empty) | LOG_AGENT `ALFRED_LOGS_WATCH_DIRS` (Windows) | `LOGS_WATCH_DIRS` with container mounts |
| `ALFRED_LOGS_WATCH_MODE` | `LOGS_WATCH_MODE` (`auto` → `events`) | Windows: LOG_AGENT runs when folders exist | `ALFRED_LOGS_WATCH_MODE_RESOLVED` |
| `ALFRED_LOGS_AGENT_SECRET` | `LOGS_AGENT_SECRET` | LOG_AGENT | same |
| `WEBHOOK_SECRET` | `WEBHOOK_SECRET` | OUTBOUND, REVERSE `WEBHOOK_SECRET`; agent `secretFile` | compose literal `change-me-in-production` |
| `ALFRED_UI_PORT` | `SERVER_PORT` | proxies `WEBHOOK_URL`, `INTERCEPTION_API_URL`; MCP `ALFRED_URL` | gateway `3000:80` |
| `ALFRED_MEMORY` | `-Xmx` | | `mem_limit: 2g` |
| `ALFRED_OUTBOUND_PROXY_LISTEN` | `FORWARD_PROXY_DEFAULT_PORT` (port part) | OUTBOUND `--mode regular@<addr>` | `127.0.0.2:443:8080` publish |
| `ALFRED_SETTINGS_EDIT_FROM` | same | | n/a (Docker is read-only) |
| `WILDFLY_PORT_OFFSET_ENABLED`, `WILDFLY_HOME` | n/a | supervisor at start | `start.py` |

## Files on disk (native install)

```
<install>/                      default /opt/alfred or C:\alfred
├── alfred, alfred.cmd          launcher (calls runtime/python ... launcher/alfred.py)
├── .env                        user settings (owned by the service account, root by default; 0600 on Linux)
├── settings.properties         defaults (replaced on upgrade)
├── runtime/{java,python,node}  bundled runtimes (replaced on upgrade)
├── app/                        alfred.jar, alfred-agent.jar, attach-cli.jar, mcp-server.mjs,
│                               proxy/*.py, launcher/*.py, log-agent/agent.py, VERSION
├── service/                    alfred.service (Linux) or alfred-service.exe + .xml (Windows)
└── data/                       never touched by upgrade
    ├── appdata/                *.db, uploads (same files Docker keeps in backend/data)
    ├── logs.db, db-capture.db
    ├── proxy/                  *.flag files, interception/ (rules.json, variables.json, answers/)
    ├── certs/                  mitmproxy CA (created on first proxy start)
    ├── logs-drop/
    ├── exports/                MCP exports (7-day retention)
    ├── env-history.jsonl, env-history/<ts>.env
    ├── pending-restart.json
    ├── run/control.json        supervisor port and token (0600)
    └── log/                    supervisor, backend, proxy logs (rotated 10 MB × 3, as compose does)
```
