---
description: "Task list for 012-server-program"
---

# Tasks: Alfred as a Server Program

**Input**: `specs/012-server-program/` (plan.md, spec.md, research.md R1–R17, data-model.md, contracts/, quickstart.md)
**Tests**: included, because Constitution VI requires tests per layer (services against fake ports, file adapters on `@TempDir`, thin `@WebMvcTest`, ArchUnit, pure TS utils, pytest for Python).
**Approved UI**: `mockups/server-settings-mock.html` v4. Before UI work it needs two changes from research R15: a Name field on each watched folder, and an optional Outbound address column for projects.

## Path aliases (used below, expand literally)

- `SRV` = `backend/backend-server/src/main/java/com/fathy/alfred/backend/server`
- `SRVT` = `backend/backend-server/src/test/java/com/fathy/alfred/backend/server`
- `APP` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`
- `APPT` = `backend/backend-app/src/test/java/com/fathy/alfred/backend`
- `FE` = `frontend/src/app`
- `AGENT` = `db-agent/src/main/java/com/fathy/alfred/dbagent`

## Format: `- [ ] [ID] [P?] [Story] Description`

- **[P]**: the task can run in parallel with others (different files, no dependency on an unfinished task)
- **[USn]**: user story from spec.md

## Working rules (CLAUDE.md, apply to every task)

- Find code with `codegraph explore` first. Never read `styles.scss` or `proxy/interception.py` whole.
- Run Maven in Docker with JDK 21 (CLAUDE.md "Single tests"), never bare `mvn`.
- Run tests targeted per task (`mvn -pl <module> -am test -Dtest=...`, `ng test --include=...`, `pytest <file>`). Full suites run once, in the Polish phase.
- No subagents unless the owner agrees. Phase 10 (US9) is the only candidate.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: spikes that gate later phases, plus the shared scaffolding.

- [X] T001 SPIKE S1: on Ubuntu 22.04 and Windows Server 2022, unpack python-build-standalone 3.12, `pip install --target` mitmproxy (version pinned as in `docker-compose.yml`'s image), and run `mitmdump -s proxy/log_and_route.py` plus a `regex: true` interception rule that hits `INTERCEPTION_REGEX_TIMEOUT_MS`. Record versions, commands and results in `specs/012-server-program/spikes/S1-mitmdump.md`.
- [X] T002 [P] SPIKE S2: with a jlink'd JDK 21 that includes `jdk.attach`, attach to running HotSpot JDK 8, 11 and 17 (WildFly 26) on Linux (as root, to a root-owned app and to an app run by another user via `runuser`) and on Windows (as LocalSystem, to an app run in an interactive Administrator session). Record which combinations work in `specs/012-server-program/spikes/S2-attach.md`.
- [X] T003 [P] SPIKE S3: prototype the trust advice on `sun.security.ssl.X509TrustManagerImpl.checkServerTrusted` (research R12) on JDK 8, 11, 17 and 21, with `HttpURLConnection`, Apache HttpClient 4 (`useSystemProperties`) and JDK `HttpClient` created BEFORE the attach. Record results in `specs/012-server-program/spikes/S3-trust.md`.
- [X] T004 Create `build-versions.json` at the repo root: pinned URL plus sha256 for Temurin JDK 21 (linux-x64, windows-x64), python-build-standalone 3.12 (both), Node 22 (both), esbuild, NSIS portable, WinSW, and the mitmproxy version. Use the versions proven in T001.
- [X] T005 [P] Add `build-cache/`, `build/` and `dist/` to `.gitignore`. Add `*.sh text eol=lf` and `packaging/linux/* text eol=lf` to `.gitattributes`.
- [X] T006 [P] Create the empty layout from the plan: `packaging/launcher/`, `packaging/linux/`, `packaging/windows/`, `attach-cli/` (Maven module, Java 21, `pom.xml` only), and `specs/012-server-program/fixtures/`.
- [X] T007 Propose constitution amendment 1.0.1 in `.specify/memory/constitution.md` (plan Complexity Tracking row 1): the invariant "host changes only via start.py/start.sh/start.ps1" also allows the native installers and `alfred` launcher under `packaging/`. Update the Sync Impact Report and version. **Gate**: the owner approves before T043/T046 start; applied in this task once approved.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared settings grammar, the native runtime wiring, and the `backend-server` slice skeleton. Every story depends on these.

### Shared settings grammar (one source for Python and Java)

- [X] T008 Write the test vectors `specs/012-server-program/fixtures/services-grammar.json`: `INTERNAL_CALL_SERVICES` entries (3, 4 and 5 fields, malformed, duplicate listen ports, bad outbound port), and `ALFRED_LOGS_WATCH_DIRS` entries (`name:path`, Windows `C:\...` paths, duplicates). Each vector has its expected parse result. Take the cases from `start.py` `_parse_service_entries` / `_service_listen_ports` and `LocalWatchFolders`.
- [X] T009 Create `alfred_settings.py` at the repo root. Move `_parse_settings_properties`, `_resolve_placeholders`, `_read_env_file`, `_write_env_file`, `_parse_service_entries`, `_service_listen_ports`, `_forward_proxy_assignments` and `_inbound_retention_rows` out of `start.py` into it (public names, same behavior). Add `parse_watch_dirs(value)` (split on the first `:` only) and `proxy_command_lines(env, native_paths)`, which builds the OUTBOUND and REVERSE argument lists of `contracts/supervisor-and-agent.md`.
- [X] T010 Make `start.py` and `restart.py` import from `alfred_settings.py` and delete their duplicated copies. `alfred_dbcapture.py` and `alfred_logwatch.py` use it too where they parse `.env`. Docker behavior must stay byte-identical: the generated `docker-compose.override.yml` and `.env` are the same before and after.
- [X] T011 [P] Add `tests/python/test_alfred_settings.py` (pytest): runs every vector in `fixtures/services-grammar.json`, plus the `proxy_command_lines` output for 0, 1 and 3 projects, with and without outbound attribution.

### backend-server slice skeleton

- [X] T012 Create the Maven module `backend/backend-server/pom.xml` (depends on `backend-platform` only). Add it to `<modules>` in `backend/pom.xml`, as a dependency in `backend/backend-app/pom.xml`, and in `backend/backend-architecture-test/pom.xml`. Add the slice to the module list in `docs/architecture.md` in the same change.
- [X] T013 Add the backend-server isolation rule (no dependency on any other feature slice) to `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture/HexagonalArchitectureTest.java`.
- [X] T014 [P] Create the domain records and enums in `SRV/domain/model/`: `SettingGroup`, `SettingKind`, `ApplyMode`, `Source` (`ENV_FILE`, `DEFAULT`, `PROCESS_ENV`), `SettingDefinition`, `SettingValue`, `ValidationResult` (level `ERROR`/`WARNING`/`OK`), `Project`, `WatchedFolder`, `HistoryEntry`, `PendingRestart`, `EditAccess`, `ServerStatus` (fields per data-model.md).
- [X] T015 Create `SRV/domain/model/SettingCatalog.java`: every setting in research R8 plus `WEBHOOK_SECRET` and `ALFRED_LOGS_AGENT_SECRET` (kind `SECRET`), with group, label, help text (from the mock), kind, `ApplyMode`, enum values and min/max. Defaults are NOT stored here: they come from `DefaultsPort`.
- [X] T016 Create `SRV/domain/model/ServicesGrammar.java`, the Java port of the project and watched-folder grammar (`Project.parseList`, `WatchedFolder.parseList`, `serialize`).
- [X] T017 [P] Add `SRVT/domain/model/ServicesGrammarTest.java`: loads `specs/012-server-program/fixtures/services-grammar.json` and asserts the same results as the pytest in T011.

### `.env` engine (shared by installer, launcher, UI and CLI)

- [X] T018 Rewrite `settings.properties` so it holds a `key=${ENV:default}` line for EVERY catalog key, with the comment layout of the mock. Shipped defaults are neutral: `REVERSE_PROXY_ENABLED=false`, `INTERNAL_CALL_SERVICES=` empty (the owner's projects stay in their own `.env`), `ALFRED_CALLS_MAX_SIZE_BYTES=10737418240` (10 GB, what Docker runs today), `ALFRED_DB_CAPTURE_MAX_SIZE_BYTES=4294967296`, `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES=2147483648`, `ALFRED_UI_PORT=3000`, `ALFRED_OUTBOUND_PROXY_LISTEN=127.0.0.2:443`, `ALFRED_MEMORY=2g`, `ALFRED_SETTINGS_EDIT_FROM=local,lan`, and secrets empty. Docker's `sync_env_from_settings` keeps its behavior: an existing `.env` is unchanged by `python3 start.py` (check before and after). In the same change, update the CLAUDE.md rule "`settings.properties` only fills a gap in `.env`" with the new keys and the native meaning.
- [X] T019 Create `SRV/domain/model/EnvDocument.java`: lines `Comment`/`Blank`/`Entry`/`Unknown`; `parse`, `set` (in place, or append under the group header and create the header if missing), `remove`, `render` (untouched lines byte-identical), `contentHash` (SHA-256).
- [X] T020 [P] Add `SRVT/domain/model/EnvDocumentTest.java`: an unchanged round trip is byte-identical (CRLF and LF), set on an existing key, set of a new key under its header, remove, unknown lines kept, hash changes on edit.
- [X] T021 Create out-ports `SRV/application/port/out/EnvFilePort.java` (`read() → EnvDocument`, `write(EnvDocument, expectedHash)` throwing a conflict on mismatch) and `DefaultsPort.java`. Adapters: `SRV/adapter/out/envfile/EnvFileAdapter.java` (temp file + fsync + atomic move, writability checked at `@PostConstruct`, SLF4J WARN/ERROR on failure, owner-only permissions kept) and `SRV/adapter/out/envfile/SettingsPropertiesDefaultsAdapter.java`.
- [X] T022 [P] Add `SRVT/adapter/out/envfile/EnvFileAdapterTest.java` on `@TempDir`: atomic write, hash conflict refused, permissions kept (POSIX only), read-only file gives a clear error.
- [X] T023 Create the key-to-variable map `backend/backend-server/src/main/resources/settings-env-map.json` (data-model "Setting → process variable map"): for each catalog key, the backend variable(s), the proxy variable(s) or arguments, and the Docker source. Copy it into `app/` in `build_dist.py` so `packaging/launcher/supervisor.py` uses the same file. Add `SRVT/domain/model/SettingsEnvMapTest.java` (every catalog key is mapped; every backend `@Value` name in the map exists in the code, found by scanning `backend/**/src/main/java`). In `docker-compose.yml`, change the backend's `ALFRED_CALLS_MAX_SIZE_BYTES=10737418240` to `${ALFRED_CALLS_MAX_SIZE_BYTES:-10737418240}` so `.env` applies in Docker too (same default).
- [X] T024 Create `backend/backend-server/src/main/java/com/fathy/alfred/backend/server/cli/ServerConfigCli.java` (a composition root like backend-app, so not under `adapter.in`, which ArchUnit forbids from building services and outbound adapters; plain `main`, no Spring) with the internal commands used by the installer and launcher: `init` (write a new `.env` from `settings.properties` defaults with group comments, plus a random 32-byte `WEBHOOK_SECRET`), `merge-docker-env <file>` (copy user keys, drop Docker-only keys, make relative paths absolute, list what was dropped), `check-env` (print unknown or malformed lines with their line number, exit 0). It wires the catalog, `EnvDocument`, `EnvFileAdapter` and `SettingsPropertiesDefaultsAdapter`; this is the one `.env` writer in native mode.
- [X] T025 [P] Add `SRVT/cli/ServerConfigCliInitTest.java` (`@TempDir`): `init` writes every key once under its group, `merge-docker-env` drops `BACKEND_PORT`/`BACKEND_DEBUG_PORT`/`COMPOSE_PROFILES`/`FORWARD_PROXY_PORT_MAP`/`ALFRED_LOGS_WATCH_MODE_RESOLVED` and rewrites `./logs-drop`, `check-env` reports line numbers.

### Native runtime wiring (backend runs without Docker)

- [X] T026 Add `ALFRED_RUNTIME` (`native` | `docker`, default `docker`) to the backend config. Create `SRV/domain/model/RuntimeMode.java` and read it in `SRV/adapter/out/runtime/RuntimeModeAdapter.java`.
- [X] T027 Create `APP/web/SpaPageFilter.java` (active only when `ALFRED_RUNTIME=native`). It holds one constant list of API prefixes (the gateway regex list plus `server`, `mcp`, `mcp-exports`) and the `$spa_page` rule for `/profiles`, `/interception`, `/settings` and `/logs/**` with `Accept: text/html`. Everything else that is not a static file is forwarded to `/index.html`.
- [X] T028 Add `server|mcp|mcp-exports` to the location regex in `gateway/nginx.conf`. In the same change, add the three prefixes to the gateway prefix list in `CLAUDE.md` and `AGENTS.md`, and note there that `SpaPageFilter` must stay in step (native mode).
- [X] T029 [P] Add `APPT/web/SpaPageFilterTest.java`: parses `gateway/nginx.conf` and fails if its prefix list or `$spa_page` patterns differ from `SpaPageFilter`'s constants. Also checks page loads vs API calls for `/settings`, `/logs/x`, `/calls`, and `/` with an unknown deep link.
- [X] T030 Make `backend/backend-logs/src/main/java/com/fathy/alfred/backend/logs/adapter/out/input/LocalWatchFolders.java` use host paths directly when `ALFRED_RUNTIME=native` (research R14), and keep the Docker `/logs` mapping otherwise. Add a test in `backend/backend-logs/src/test/java/com/fathy/alfred/backend/logs/adapter/out/input/LocalWatchFoldersTest.java`. Update `docs/logs.md` (watched folders in native mode) in the same change.
- [X] T031 Package the Angular build into the jar: a `frontend-dist` resource copy into `backend/backend-app/target/classes/static/`, driven by a property set by `build_dist.py`. A normal `mvn test` must not need a frontend build. Configure it in `backend/backend-app/pom.xml`.

**Checkpoint**: the grammar is shared and tested, the slice compiles and ArchUnit passes, and the backend can serve the UI in native mode.

---

## Phase 3: User Story 1 — Install and run without Docker (P1) 🎯 MVP

**Goal**: one installer per OS sets up and starts Alfred, with nothing pre-installed on the server.
**Independent test**: quickstart §1–§3 and the US1 rows: clean Linux and Windows Server VMs, no internet, installer, UI through an SSH tunnel, an outbound and an inbound call logged, reboot survives, upgrade keeps data, Docker import works.

### Supervisor and launcher

- [X] T032 [US1] Create `packaging/launcher/supervisor.py` (`alfred run`). It starts the BACKEND (bundled `runtime/java/bin/java -Xmx<ALFRED_MEMORY> -jar app/alfred.jar`, with the environment built from `app/settings-env-map.json` (T023) plus research R14: every path variable from `docker-compose.yml`'s backend service pointing under `data/`, plus `ALFRED_RUNTIME=native` and `SERVER_PORT=<ALFRED_UI_PORT>`), OUTBOUND, REVERSE (only when enabled and projects exist), MCP (`runtime/node node app/mcp-server.mjs` with `ALFRED_MCP_TRANSPORT=http`) and LOG_AGENT (Windows, only when watched folders exist). Command lines come from `alfred_settings.proxy_command_lines`. Crash back-off is 1 s, 2 s, 5 s, 10 s, 30 s, giving up after 5 crashes in 5 minutes. Logs rotate at 10 MB × 3 under `data/log/`. Before starting children, run `ServerConfigCli check-env` and print its report. When a proxy cannot bind its address (e.g. port 443 without the right), log and report `CRASHED` with "cannot listen on <addr>: <reason>; change ALFRED_OUTBOUND_PROXY_LISTEN".
- [X] T033 [US1] In `packaging/launcher/supervisor.py`, add the control API of `contracts/supervisor-and-agent.md` (`GET /status`, `POST /restart/backend`, `/restart/proxies`, `/reload`) on `127.0.0.1:<random>`. It writes `data/run/control.json` (`0600` on Linux, owner-only ACL on Windows) and posts state changes to `{backend}/server/supervisor-events` with `X-Webhook-Secret`. Graceful stop is SIGTERM, or CTRL_BREAK on Windows, with 20 s before kill.
- [X] T034 [US1] Create `packaging/launcher/alfred.py`: `start`, `stop`, `restart`, `restart --proxies`, `status`, `run`, `logs`, `version` and `uninstall` per `contracts/cli.md`, going through systemd or WinSW when installed as a service, else running in the foreground. Exit codes as in the contract.
- [X] T035 [P] [US1] Add `packaging/linux/alfred` (sh) and `packaging/windows/alfred.cmd`: thin wrappers that run `runtime/python` on `app/launcher/alfred.py`.
- [X] T036 [P] [US1] Add `tests/python/test_supervisor.py` (pytest, fake child processes): start order, back-off, give-up after 5 crashes, `/restart/proxies` leaves the backend running, a request without the token gets 401, `/reload` restarts only what changed.
- [X] T037 [US1] First start in `packaging/launcher/alfred.py`: when `.env` is missing, run `runtime/java -cp app/alfred.jar ...ServerConfigCli init` (T024). Python never writes `.env`. Create the `data/` subfolders.

### Native path for the proxies and the MCP server

- [X] T038 [US1] Make `proxy/log_and_route.py` and `proxy/log_and_route_reverse.py` take every path and host from their existing environment variables only: no `/home/mitmproxy` literal and no `host.docker.internal` default when `REVERSE_PROXY_UPSTREAM_HOST` is set. Verify the Docker path is unchanged with the existing `proxy/test_*.py`.
- [X] T039 [US1] Add `ALFRED_MCP_TRANSPORT=http` to `mcp-server/src/index.ts`: `StreamableHTTPServerTransport` on `127.0.0.1:${ALFRED_MCP_PORT}`. Stdio stays the default. Document the HTTP transport in `docs/mcp.md` in the same change.
- [X] T040 [US1] Add an esbuild bundle script `mcp-server/scripts/bundle.mjs` that produces one `mcp-server.mjs`, including the imported `frontend/src` code. Add a `bundle` npm script to `mcp-server/package.json`.

### Build script and installers

- [X] T041 [US1] Create `build_dist.py` with the steps of research R4 and `contracts/installer-and-build.md`: git version, frontend build, Maven in Docker (backend with `static/`, db-agent, attach-cli), MCP bundle, runtime downloads with sha256 checks into `build-cache/`, jlink per target (modules from `jdeps` plus `jdk.attach`, `jdk.crypto.ec`, `jdk.management`, `jdk.unsupported`), and `pip install --target` of mitmproxy (plus `watchdog` on Windows) into each bundled Python. Flags: `--target`, `--skip-tests`, `--clean`. Writes through `dist/.tmp`.
- [X] T042 [US1] Assemble the stage folder in `build_dist.py`: `build/stage/<target>/{runtime/{java,python,node},app/{alfred.jar,alfred-agent.jar,attach-cli.jar,mcp-server.mjs,proxy/*.py,launcher/*.py,alfred_settings.py,log-agent/agent.py,VERSION},settings.properties,service/,alfred|alfred.cmd}`.
- [X] T043 [US1] Create `packaging/linux/installer-header.sh` (POSIX sh) with the steps and flags of `contracts/installer-and-build.md`. It extracts to a temp folder and moves into place, handles upgrade by `app/VERSION` (keeps `.env` and `data/`, refuses a downgrade without `--allow-downgrade`), defaults the service account to `root` (`--user`), creates owner-only permissions, installs `/usr/local/bin/alfred`, runs `systemctl enable --now`, waits for `/health`, and prints the addresses. `uninstall` asks before deleting `data/`.
- [X] T044 [P] [US1] Create `packaging/linux/alfred.service`: `ExecStart=<dir>/alfred run`, `Restart=always`, `User=` from the installer, and `AmbientCapabilities=CAP_NET_BIND_SERVICE` when the account is not root.
- [X] T045 [US1] In `build_dist.py`, write the `.run` file: header plus `tar.gz` built with Python `tarfile`, `0755` on the launchers and `installer-header.sh`, LF endings checked.
- [X] T046 [P] [US1] Create `packaging/windows/installer.nsi`: wizard (folder, port, service account, default LocalSystem) and silent `/S /DIR= /UIPORT= /SERVICEUSER= /IMPORTDOCKER=`. Same steps as Linux, an uninstaller entry, and `alfred.cmd` added to the machine `PATH`. Needs admin; silent mode exits `5` without it.
- [X] T047 [P] [US1] Create `packaging/windows/alfred-service.xml` (WinSW): runs `alfred.cmd run`, `onfailure restart`, logs to `data/log`.
- [X] T048 [US1] In `build_dist.py`, run `makensis` (from `build-cache/`) to produce the `.exe`, then write `dist/SHA256SUMS`.
- [X] T049 [P] [US1] Add `tests/python/test_build_dist.py`: from a fake stage folder, the `.run` tar has `0755` launchers and LF line endings, the version string comes from git, and a failure leaves no file in `dist/`.

### Docker import (FR-002d, research R17)

- [X] T050 [US1] Create `packaging/launcher/docker_import.py`. It detects a Docker install (a running `backend` container's compose label, or a given folder). It copies into `data/.import-tmp/`: `.env` merged through `ServerConfigCli merge-docker-env` (T024; Python never writes `.env`), `backend/data/**`, the `logs-db` and `db-capture-db` volumes through `docker run --rm -v ...:ro alpine tar`, `proxy/*.flag`, `proxy/interception/**` and `proxy/certs/**`. Then it checks disk, runs `docker compose stop`, copies again what changed, moves into `data/`, and records an `IMPORT` history line. On failure it removes the temp folder and runs `docker compose start`.
- [X] T051 [US1] Call `docker_import.py` from `packaging/linux/installer-header.sh` (`--import-docker`, `--no-import`, interactive prompt) and from `packaging/windows/installer.nsi` (`/IMPORTDOCKER=`).
- [X] T052 [P] [US1] Add `tests/python/test_docker_import.py` (fake repo folder, `docker` command stubbed): `.env` merge rules, path rewriting, a failure restores the original state, and the source folder is untouched (checksum before and after).

**Checkpoint**: `python build_dist.py` produces both installers, and quickstart US1 passes on clean VMs. This is the MVP.

---

## Phase 4: User Story 2 — One settings file with defaults (P1)

**Goal**: `.env` is the single source, defaults come from `settings.properties`, and the file is read and written without losing comments.
**Independent test**: delete `.env`, start, and it is created with all keys. Remove one line: the key reports `DEFAULT`. A malformed line is reported with its line number.

- [X] T053 [US2] Create `SRV/application/port/in/GetSettingsUseCase.java` and implement it in `SRV/application/service/ServerSettingsService.java`: effective value per key (`.env`, else default; `PROCESS_ENV` in Docker mode), `differsFromDefault`, `missingFromEnv`, `unknownLines`, secrets masked.
- [X] T054 [P] [US2] Add `SRVT/application/service/ServerSettingsServiceGetTest.java` with fake ports: missing key gives DEFAULT, unknown line reported, secret never returned, Docker mode gives PROCESS_ENV.
- [X] T055 [US2] Create `SRV/adapter/in/web/ServerSettingsController.java` with `GET /server/settings` (contract shape), plus a thin `SRVT/adapter/in/web/ServerSettingsControllerGetTest.java` (`@WebMvcTest`).

**Checkpoint**: settings are readable through the API in native and Docker mode.

---

## Phase 5: User Story 5 — Who may change settings (P1)

**Goal**: writes allowed from local and LAN only, never through the Cloudflare tunnel, never in Docker mode, enforced by the server.
**Independent test**: quickstart US5. A `curl -X PUT` through the tunnel or with Cloudflare headers gets `403 TUNNEL`; from a LAN address it is allowed; Docker mode gets `403 DOCKER_MODE`.

- [X] T056 [US5] Create `SRV/domain/model/AccessRule.java`: parses `ALFRED_SETTINGS_EDIT_FROM` (`local`, `lan`, IPv4/IPv6 addresses, CIDR) and `decide(peerAddress, headers, localAddresses, runtimeMode) → EditAccess`. Cloudflare headers (`Cf-Connecting-IP`, `Cf-Ray`, `Cdn-Loop: cloudflare`) mean TUNNEL. `X-Forwarded-For` is ignored.
- [X] T057 [P] [US5] Add `SRVT/domain/model/AccessRuleTest.java`: loopback, own interface address, 10/172.16/192.168 ranges, `fc00::/7`, explicit CIDR, tunnel headers on loopback refused, XFF spoofing ignored, Docker mode always refused, invalid token rejected.
- [X] T058 [US5] Create `SRV/application/port/in/EditAccessUseCase.java` and `SRV/adapter/in/web/EditAccessFilter.java`: guards every non-GET under `/server/**` except `/server/supervisor-events` (webhook secret instead), returns `403 {reason, howToEdit}` through `GlobalExceptionHandler`, and serves `GET /server/access`. The rule reloads live when `ALFRED_SETTINGS_EDIT_FROM` changes.
- [X] T059 [P] [US5] Add `SRVT/adapter/in/web/EditAccessFilterTest.java` (`@WebMvcTest`): PUT with Cloudflare headers gets 403 TUNNEL, PUT from a non-listed address gets 403 NOT_LISTED, GET is always allowed, `/server/access` has the right shape.

---

## Phase 6: User Story 3 — Change settings from the Settings tab (P1)

**Goal**: the Server section of the mock: edit, review, save to `.env`, live / proxy / restart effects.
**Independent test**: quickstart US3. Add a project and a watched folder, review the diff, save; `.env` changes with comments kept, the reverse proxy starts, and calls are logged on the new port.

### Backend

- [X] T060 [US3] Create `SRV/domain/model/SettingsValidator.java`: format rules per `SettingKind` (data-model "Validation rules by kind"), min/max, enum values, list grammar through `ServicesGrammar`, cross-field rules (listen port ≠ upstream port, duplicate names and ports). Probe-based rules are added in US7.
- [X] T061 [P] [US3] Add `SRVT/domain/model/SettingsValidatorTest.java`: one case per kind and rule; sizes `500MB`/`2GB`/raw bytes normalised to bytes; memory `2g`/`1536m`.
- [X] T062 [US3] Create `SRV/application/port/in/PreviewSettingsUseCase.java` and `SaveSettingsUseCase.java` in `ServerSettingsService`. Preview returns the diff lines and effects without writing. Save: validate (refuse on ERROR, 422), write with `baseHash` (409 with changed keys on mismatch), append history (US7 port, no-op fake until then), apply by `ApplyMode` through `LiveSettingsPort` (LIVE) or `SupervisorPort.reload()` (PROXIES), record `PendingRestart` (RESTART). Edits are capped at 64.
- [X] T063 [P] [US3] Add `SRVT/application/service/ServerSettingsServiceSaveTest.java`: 422 writes nothing, 409 on hash mismatch, reset removes the line, a LIVE key calls `LiveSettingsPort`, a PROXIES key calls reload once per save, a RESTART key records pending, and `settings.properties` is byte-identical after every save and reset (FR-013).
- [X] T064 [US3] Add `PUT /server/settings`, `POST /server/settings/preview` and `POST /server/settings/add-missing` to `SRV/adapter/in/web/ServerSettingsController.java`, with `@Valid` request DTOs in `SRV/adapter/in/web/dto/`, plus a `@WebMvcTest` in `SRVT/adapter/in/web/ServerSettingsControllerWriteTest.java`.
- [X] T065 [US3] Create `SRV/application/port/out/LiveSettingsPort.java` and `SupervisorPort.java`. Adapter `SRV/adapter/out/supervisor/SupervisorControlAdapter.java` reads `data/run/control.json` and calls the control API with the token. In Docker mode it is a no-op that reports `DOCKER_MODE`.
- [X] T066 [P] [US3] Add `SetRetentionUseCase` to `backend/backend-internal-calls/src/main/java/com/fathy/alfred/backend/internalcalls/application/port/in/SetRetentionUseCase.java` (implemented by its retention-owning service, used by `InternalCallsFileLogAdapter` on the next save) and a reload of the `INTERNAL_CALL_SERVICES` project list. Add tests in that slice.
- [X] T067 [P] [US3] Add `SetStorageBudgetUseCase` to `backend/backend-calls` (max size used by `SqliteCallsRepository`'s periodic size check) with a test.
- [X] T068 [P] [US3] Add a storage budget use case to `backend/backend-db-capture` (database and Redis caps) with a test.
- [X] T069 [P] [US3] Add a replace-watch-folders use case to `backend/backend-logs` (`LocalWatchFolders` plus `WatchServiceEvents` re-registration) with a test.
- [X] T070 [US3] Create `APP/serverbridge/LiveSettingsBridge.java`, implementing `LiveSettingsPort` by calling the use cases from T066–T069. Add `APPT/serverbridge/LiveSettingsBridgeTest.java`.

### Frontend

- [X] T071 [US3] Update `mockups/server-settings-mock.html` per research R15 (Name field per watched folder; optional Outbound address column for projects) and per R8 (`ALFRED_LOGS_DIR`, `ALFRED_LOGS_WATCH_MODE` and the WildFly settings show "restart needed"). Also show the neutral defaults of T018 (calls cap 10 GB; reverse proxy off; no projects) in its ".env + defaults" tab. Get the owner's OK before T073.
- [X] T072 [P] [US3] Create `FE/core/models/server-settings.model.ts` (types matching `contracts/server-api.md`) and `FE/core/services/server-settings.service.ts` (GET/PUT/preview/add-missing/access, using `inject()`).
- [X] T073 [P] [US3] Create `FE/shared/utils/server-settings.ts` (pure): parse and format sizes, memory, project list, folder list; build the review diff from the preview response; dirty tracking against loaded values. Add `FE/shared/utils/server-settings.spec.ts`.
- [X] T074 [US3] Create the standalone component `FE/pages/settings/server-settings/server-settings.component.{ts,html}`, using signals: grouped cards (Projects, Network, Storage, Logs, WildFly) as in the mock, source badges, apply badges, help (?) texts, reset to default, projects table with add/remove, watched folders as name+path rows with add/remove, the "new settings not in .env" banner, the sticky save bar, and the review dialog → PUT. Styles go in the existing `frontend/src/styles.scss` section for settings (find it with Grep, do not read the file whole).
- [X] T075 [US3] Mount the Server section in `FE/pages/settings.component.html` / `settings.component.ts`, and hide every edit control when `GET /server/access` says not allowed (show the read-only banner with `howToEdit`).
- [X] T076 [P] [US3] Add `FE/pages/settings/server-settings/server-settings.component.spec.ts`, for DOM-only behavior: save disabled with no changes, review dialog shows the diff, read-only mode hides controls.

**Checkpoint**: the P1 stories are done. Native installs are configurable from the UI, safely.

---

## Phase 7: User Story 4 — Restart from the Settings tab (P2)

**Goal**: the Server card with status, "Restart proxies" and "Restart Alfred"; the page reconnects by itself; the pending-restart banner.
**Independent test**: quickstart US4.

- [X] T077 [US4] Create `SRV/application/port/in/RestartUseCase.java` and `ServerStatusUseCase.java` in `SRV/application/service/ServerRuntimeService.java`: restart through `SupervisorPort` (409 in Docker mode); status merges supervisor `/status` with heap figures and version (`app/VERSION`). In Docker mode, status is read-only: version, mode `DOCKER`, backend heap, and proxy listeners from the container environment. A restart request waits for a save in progress to finish (one lock shared with `SaveSettingsUseCase`).
- [X] T078 [US4] Create `SRV/application/port/out/PendingRestartPort.java` and adapter `SRV/adapter/out/history/PendingRestartFileAdapter.java` (`data/pending-restart.json`). At backend start, clear the entries whose `after` value is now in effect.
- [X] T079 [US4] Create `SRV/adapter/in/web/ServerRestartController.java` (`POST /server/restart`, `GET /server/status`) and `SRV/adapter/in/web/SupervisorEventsController.java` (`POST /server/supervisor-events`, `X-Webhook-Secret` checked like the existing webhooks).
- [X] T080 [US4] Create `SRV/adapter/out/websocket/ServerEventsWebSocketHandler.java` on `/ws/server`, sending `server-status-changed` (same pattern as `CallEventsWebSocketHandler`), and register it in the backend's WebSocket config.
- [X] T081 [P] [US4] Add tests: `SRVT/application/service/ServerRuntimeServiceTest.java` (Docker mode refused; pending cleared on start) and `SRVT/adapter/in/web/SupervisorEventsControllerTest.java` (bad secret gets 401).
- [X] T082 [US4] Frontend: Server card and restart dialogs in `FE/pages/settings/server-settings/server-card.component.{ts,html}`. Status is fetched on `/ws/server` signals through a socket service `FE/core/services/server-socket.service.ts` using `reconnectingSocket` (no `interval`/`timer` polling). Restart progress steps follow the mock. After a backend restart the page waits for the socket to reconnect, then reloads status. A changed `ALFRED_UI_PORT` navigates to the new address. Add the pending-restart banner. The restart confirmation states that apps keep working through the proxies and that calls made while the backend is down are not logged (FR-042). In Docker mode the card shows status only, with no restart buttons.
- [X] T083 [P] [US4] Add `FE/core/services/server-socket.service.spec.ts`: no recurring timer is created; it re-fetches on `server-status-changed`.

---

## Phase 8: User Story 7 — Checks, history, conflicts (P2)

**Goal**: checks as you type, check everything, history with revert, external-edit detection.
**Independent test**: quickstart US7. Also: a busy port is refused with the process named, and a storage limit below what is stored warns how much will be removed.

- [X] T084 [US7] Create probe out-ports in `SRV/application/port/out/`: `PortProbePort`, `FolderProbePort`, `DiskProbePort`, `MemoryProbePort`, `AppHealthPort`, `StorageUsagePort`, `TrafficRatePort`.
- [X] T085 [P] [US7] Create `SRV/adapter/out/probe/PortProbeAdapter.java`: bind test, then the process owner from `/proc/net/tcp` + `/proc/*/fd` on Linux or `netstat -ano` + `tasklist` on Windows; "process unknown" fallback; timeout.
- [X] T086 [P] [US7] Create `SRV/adapter/out/probe/FolderProbeAdapter.java` (exists, readable, count of `*.log`/`*.json` at depth 1, newest mtime; never reads content), `DiskProbeAdapter.java`, `MemoryProbeAdapter.java` and `AppHealthAdapter.java` (`HEAD` with a 1 s timeout).
- [X] T087 [P] [US7] Add `SRVT/adapter/out/probe/FolderProbeAdapterTest.java` and `PortProbeAdapterTest.java` (`@TempDir`; bind a real socket and check it is reported busy).
- [X] T088 [US7] Create `APP/serverbridge/StorageUsageBridge.java` (calls DB size, db-capture and Redis sizes, through those slices' existing size queries) and `APP/serverbridge/TrafficRateBridge.java` (inbound and outbound COUNT in the last hour, windowed and indexed). Add tests in `APPT/serverbridge/`.
- [X] T089 [US7] Create `SRV/application/port/in/CheckSettingsUseCase.java` in `ServerSettingsService`. It runs `SettingsValidator` plus the probe rules of data-model (busy ports named, folder checks, size vs stored and vs free disk, memory vs free RAM, retention hours and memory estimate, app health as WARNING), caps the whole request at 5 s and at 64 edits, and makes PUT re-run the probe rules before saving. Add `POST /server/settings/check` to the controller.
- [X] T090 [P] [US7] Add `SRVT/application/service/CheckSettingsTest.java` with fake probes: ERROR blocks save, WARNING does not, a timed-out probe gives a WARNING, retention estimate arithmetic.
- [X] T091 [US7] Create `SRV/application/port/out/HistoryPort.java` and adapter `SRV/adapter/out/history/EnvHistoryFileAdapter.java`: append to `data/env-history.jsonl` and snapshot to `data/env-history/<ts>.env`, keep the last 50 (delete older), record secrets as set/changed only. Detect a hand edit when the stored hash differs from the file on read and record `HAND_EDIT` with the diff. A save carrying `X-Alfred-Cli-User` from a loopback peer is recorded as source `CLI` with that OS user; the header is ignored from any other peer.
- [X] T092 [P] [US7] Add `SRVT/adapter/out/history/EnvHistoryFileAdapterTest.java` (`@TempDir`): retention of 50, secrets never written, hand edit detected once.
- [X] T093 [US7] Create `SettingsHistoryUseCase` (list with `limit` clamped to 1..50; revert returns edits and does not write). Add `GET /server/settings/history` and `POST /server/settings/history/{id}/revert`. A `.env` file watcher in `SRV/adapter/in/watch/EnvFileWatcher.java` sends `server-status-changed` when `.env` changes on disk.
- [X] T094 [US7] Frontend in `FE/pages/settings/server-settings/`: debounced check calls per changed field showing hints and meters as in the mock, the "Check everything" button with a summary toast, the History dialog with Revert (puts the values in the form), and the conflict banner on a 409 or on a `.env` change signal ("Load server values, keep my edits").
- [X] T095 [P] [US7] Extend `FE/shared/utils/server-settings.spec.ts` with the merge "server values + my edits" and the retention text formatting.

---

## Phase 9: User Story 6 — CLI (P2)

**Goal**: `alfred config ...` with the same results as the UI, whether the backend runs or not.
**Independent test**: quickstart US6.

- [X] T096 [US6] Extend `SRV/adapter/in/cli/ServerConfigCli.java` (created in T024). It wires `ServerSettingsService` with the file adapters and local probes, and implements list/get/set/reset/add/remove/add-missing/check/diff/history/revert/import with the output and exit codes of `contracts/cli.md`.
- [X] T097 [US6] In `packaging/launcher/alfred.py`, add `config ...` and `project add/remove`. When the backend answers on `127.0.0.1`, call `/server/settings*`; else run `runtime/java -cp app/alfred.jar ...ServerConfigCli`. Prompts (`[y/N]`) for revert and import happen in Python. HTTP calls send `X-Alfred-Cli-User: <OS user>`. *(As built: `packaging/launcher/config_cli.py` passes `--backend http://127.0.0.1:<ui port>` and `--user`; ServerConfigCli itself picks the HTTP path (`HttpSettingsClient`) when the backend answers, else the files (`LocalSettingsClient`), and asks the `[y/N]` prompts, so both paths share one implementation.)*
- [X] T098 [P] [US6] Add `SRVT/adapter/in/cli/ServerConfigCliTest.java` (`@TempDir` install folder): set a valid value, refuse an invalid one (exit 3), reset, add/remove a list item, diff output, and the same messages as the API, and `settings.properties` is unchanged after every command.
- [X] T099 [P] [US6] Add `tests/python/test_config_cli.py` *(as built; the HTTP/files choice is tested in `HttpSettingsClientTest`)*: the HTTP path is used when the backend is up and the Java path when it is down (both stubbed), and arguments pass through.

---

## Phase 10: User Story 9 — Attach with one command (P2)

**Goal**: one agent with proxy, trust, db, logs and redis; `alfred jvms/attach/detach`; no JDK `cacerts` or startup changes.
**Independent test**: quickstart US9. **Gate**: spikes S2 and S3 passed (T002, T003).

- [X] T100 [US9] Move `WildFlyProxyAgent`'s proxy property logic into `AGENT/proxy/ProxySwitch.java` (set and clear `http(s).proxyHost/Port`; remember and restore the previous values).
- [X] T101 [US9] Create `AGENT/trust/AlfredCaTrust.java` and `AGENT/advice/TrustManagerAdvice.java` (ByteBuddy retransform of `sun.security.ssl.X509TrustManagerImpl.checkServerTrusted` overloads). On `CertificateException`, accept only a chain that verifies against the CA from `caFile`; otherwise rethrow. The advice is switchable without re-transforming.
- [X] T102 [US9] Extend `AGENT/AgentConfig.java` with `features`, `proxy` and `caFile` (contract format), and `AGENT/AlfredDbAgent.java` `agentmain`/`premain` to apply the feature set idempotently on each attach and publish `alfred.agent.features` and `alfred.agent.version` as system properties.
- [X] T103 [P] [US9] Add `db-agent/src/test/java/com/fathy/alfred/dbagent/TrustAdviceIT.java` (an HTTPS server with a cert signed by a test CA: refused before, accepted after the advice, a chain from another CA still refused) and `ProxySwitchTest.java`.
- [X] T104 [US9] Rename the agent artifact to `alfred-agent` in `db-agent/pom.xml` (`<finalName>`) and update every reference (`wildfly-proxy-toggle/*.sh|*.bat`, `alfred_dbcapture.py`, `docs/db-capture.md`).
- [X] T105 [US9] Create the `attach-cli` module: `attach-cli/src/main/java/com/fathy/alfred/attach/AttachCli.java` with `jvms`, `attach` and `detach` (logic moved from `wildfly-proxy-toggle/WildFlyProxyController.java`; WildFly detection by `jboss.home.dir`; reads `alfred.agent.features`; a NOTE when a custom trust manager or pinning is detected). Add `attach-cli/pom.xml` to the build in `build_dist.py`.
- [X] T106 [US9] In `packaging/launcher/alfred.py`, add `jvms`, `attach` and `detach`, running the bundled `runtime/java -jar app/attach-cli.jar`. On Linux, when the target's owner differs from the caller, run it through `runuser -u <owner>` (or `su`). Agent args come from `.env` (`ALFRED_UI_PORT`, `ALFRED_OUTBOUND_PROXY_LISTEN`, `secretFile=<install>/.env`, `caFile=<install>/data/certs/mitmproxy-ca-cert.pem`).
- [X] T107 [US9] Turn `wildfly-proxy-toggle/proxy-*.sh|bat` and `db-capture-*.sh|bat` into thin wrappers over `attach-cli.jar` where a bundled runtime exists, keeping their current behavior on the Docker path. Delete the moved classes. *(As built: `native.sh`/`native.bat` hand over to `alfred attach/detach/jvms` when a native install is found; `WildFlyProxyController`/`WildFlyProxyAgent` are kept because the Docker path still compiles and runs them on JDK 8.)*
- [X] T108 [P] [US9] Add `attach-cli/src/test/java/com/fathy/alfred/attach/AttachCliIT.java`: start a child JVM, `jvms` lists it, `attach --proxy` sets the properties, `detach` restores them.

---

## Phase 11: User Story 8 — Search, filter, copy between servers (P3)

**Goal**: search, the "only changed from default" filter, `.env` download and upload.
**Independent test**: quickstart US8.

- [X] T109 [US8] Add `GET /server/settings/env-file` (secrets replaced by `<set on server>`, attachment, allowed only when access allows) and `POST /server/settings/import` (multipart, 64 KB max, per-value validation, secrets excluded, unknown keys listed, nothing written) to `ServerSettingsController` through new `ImportEnvUseCase`. Add a `@WebMvcTest`.
- [X] T110 [P] [US8] Add `filterSettings(settings, query, changedOnly)` to `FE/shared/utils/server-settings.ts` (matches label, key or value; hides empty groups) with spec cases.
- [X] T111 [US8] Frontend: search box, the "Only changed from default" checkbox, the Download button, and the Upload dialog (per-value checkboxes, invalid values unselected and flagged, "Put N values in the form") in `FE/pages/settings/server-settings/`.

---

## Phase 12: User Story 10 — Claude tools over the network (P3)

**Goal**: `/mcp` on the UI port, reachable wherever the UI is; exports downloadable.
**Independent test**: quickstart US10.

- [X] T112 [US10] Create `APP/mcpbridge/McpRelayController.java`: relays `/mcp` (GET/POST/DELETE) to `127.0.0.1:${ALFRED_MCP_PORT}`, streaming with flush per chunk for SSE, passing the MCP session headers both ways, and 502 with a clear message when the MCP process is down. No `EditAccessFilter` on this path (FR-082). Cap the relayed request body at 10 MB (413 above it). Update `docs/mcp.md` (remote use, export links, open wherever the UI is) in the same change.
- [X] T113 [US10] Add `GET /mcp-exports/{name}` to `APP/mcpbridge/McpExportsController.java`: the name is validated as a single path segment and served from `data/exports/` as an attachment. Delete files older than 7 days at start.
- [X] T114 [US10] In `mcp-server/src/session.ts` and `mcp-server/src/tools/export.ts`, in HTTP mode pin `exportFolder` to `ALFRED_EXPORT_DIR` (`data/exports`), refuse paths that resolve outside it, and return the `/mcp-exports/<name>` download URL in the tool result.
- [X] T115 [P] [US10] Add `APPT/mcpbridge/McpRelayControllerTest.java` (fake upstream: streaming passes chunks in order; down gives 502) and `McpExportsControllerTest.java` (`../` refused, attachment header). Run the whole existing `mcp-server/test/*.test.ts` suite a second time in HTTP mode (an `ALFRED_MCP_TRANSPORT=http` run added to `mcp-server/package.json` as `test:http`), so every tool is covered (SC-008).

---

## Phase 13: Polish & Cross-Cutting Concerns

- [X] T116 [P] Write `docs/server.md`: native install, `.env` and defaults, Server section, access rule and its residual risk (LAN users can edit; `/mcp` open wherever the UI is), root/LocalSystem default, Docker import, restart, CLI, attach limits (custom trust managers, clients that ignore proxy properties), and building the installers.
- [X] T117 [P] Final docs check: `CLAUDE.md` and `AGENTS.md` describe the native mode, the supervisor, the `backend-server` slice and the `.env`/`settings.properties` rule as built (each was updated in its own task: T028, T018); fix anything that drifted.
- [X] T118 [P] Final docs check of `docs/architecture.md` (serverbridge, mcpbridge), `docs/mcp.md`, `docs/logs.md`, `docs/supplier-integrations.md` (in-JVM trust in native mode) and `docs/db-capture.md` (agent args, `alfred-agent.jar`) against the code.
- [ ] T119 Run the full suites once: `mvn test` (Docker JDK 21, from the repo root mount), `cd frontend && npm test && npm run build`, `cd mcp-server && npm test && npm run typecheck`, `pytest tests/python proxy`. Fix any failure.
- [ ] T120 Run quickstart §1–§5 end to end: `python build_dist.py`, then install on a clean Ubuntu 22.04 VM and a clean Windows Server 2022 VM (no internet), every story row, a Docker import on a VM running the Docker install, and the Docker regression. Record results in `specs/012-server-program/spikes/E2E-results.md`.
- [ ] T121 Measure and record the success criteria in `specs/012-server-program/spikes/E2E-results.md`: SC-001 (install to first call time), SC-004 (live apply ≤ 2 s, proxy restart ≤ 5 s, full restart and reconnect ≤ 30 s), installer sizes.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001–T007)**: start immediately. T001 (S1) gates Phase 3. T007 (constitution amendment) must be approved before T043/T046.
- **Foundational**: after Setup. Blocks all stories. It includes the `.env` engine, the key-to-variable map and `ServerConfigCli init` that US1 needs.
- **US1 (Phase 3)**: after Foundational and S1. This is the MVP.
- **US2 (Phase 4)**: after Foundational. Can run alongside US1, but its native verification needs US1's installer.
- **US5 (Phase 5)**: after US2 (it reads settings), and must be done before US3's writes ship.
- **US3 (Phase 6)**: after US2 and US5. T071 (mock update) needs the owner's OK before T074.
- **US4 (Phase 7)**: after US3 (pending restart comes from saves) and US1 (supervisor).
- **US7 (Phase 8)**: after US3 (it extends validation and save).
- **US6 (Phase 9)**: after US7 (the CLI exposes check, history and revert).
- **US9 (Phase 10)**: after US1, and after spikes S2/S3. Independent of US2–US7.
- **US8 (Phase 11)**: after US3.
- **US10 (Phase 12)**: after US1 (supervisor runs the MCP server; the bundle comes from T040).
- **Polish (Phase 13)**: after the stories being shipped.

### Story graph

```
Setup ─► Foundational ─┬─► US1 (MVP) ─┬─► US9 (needs S2,S3)
                       │              ├─► US10
                       │              └─► US4 ◄─┐
                       └─► US2 ─► US5 ─► US3 ───┼─► US7 ─► US6
                                                └─► US8
```

### Within each story

Domain and tests → ports and services → adapters → controllers → frontend. Every `[P]` test task can be written before its implementation task and fail first.

## Parallel examples

- **Setup**: T002 and T003 (spikes on other machines) alongside T004–T006.
- **Foundational**: T011, T014 and T017 together. T027–T029 alongside T030.
- **US1**: T035, T036, T044, T046, T047, T049 and T052 together once T032–T034 exist.
- **US3**: the slice use cases T066, T067, T068 and T069 in parallel (different slices). T072 and T073 in parallel with the backend work.
- **US7**: probe adapters T085 and T086 together. T087 and T090 tests together.
- **US9**: T103 and T108 tests in parallel with T105.

## Implementation strategy

1. **MVP = Setup + Foundational + US1.** Both installers, native run, Docker import. Settings are edited by hand in `.env` at this stage. Demo on clean VMs, then stop for the owner's review.
2. **Configurable**: US2, then US5, then US3. The P1 set is complete: the Server section works safely.
3. **Operable**: US4 (restart), US7 (checks, history), US6 (CLI).
4. **Attach**: US9, after spikes S2/S3. This is the one chunk that could go to a single subagent if the owner agrees.
5. **Extras**: US8 and US10.
6. **Polish**: final docs check (each doc was already updated in the task that changed its behavior), full suites, VM end to end, SC measurements.

Commit after each task or logical group. Stop at each checkpoint for the owner's review.
