# Implementation Plan: Alfred as a Server Program

**Branch**: `012-server-program` | **Date**: 2026-10-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/012-server-program/spec.md`
**UI design**: `mockups/server-settings-mock.html` (v4; two adjustments in research R15)

## Summary

Alfred gets a native install path next to Docker: one self-contained installer per OS (Linux `.run`,
Windows `.exe`) that carries its own Java, Python and Node runtimes, registers a service, and needs
nothing on the server.

**Processes**: a Python supervisor (`alfred run`) starts the backend, both mitmproxy proxies, the MCP
server and, on Windows, the log agent. The backend serves the UI itself, so there is no nginx.

**Settings**: every deploy-time setting lives in `.env`, with defaults from `settings.properties`. A new
`backend-server` slice owns the setting catalog, `.env` editing (keeping comments), validation and
probes, history and conflicts, access control (local/LAN yes, Cloudflare tunnel never), and restart
requests to the supervisor. The Settings tab gets a Server section (the mock), and `alfred config` uses
the same engine.

**Agents and MCP**:
- The db-agent becomes the one agent: it adds proxy and in-JVM certificate trust to db, logs and redis.
- A Java 21 `attach-cli` lists JVMs and attaches to them.
- The MCP server runs on Streamable HTTP behind the backend's `/mcp`.

**Build**: one `build_dist.py` builds both installers from the current commit.

**Clarified 2026-10-07**:
- The service runs as root / LocalSystem by default (R16).
- The installer offers to import an existing Docker install's settings and data, copying and never
  moving (R17).
- `/mcp` is reachable wherever the UI is, including the tunnel (R13).
- In Docker mode the Server section is read-only, with a how-to (R9).

## Technical Context

**Language/Version**: Java 21 (backend, attach-cli); Java 8 bytecode (alfred-agent); Python 3.12
bundled (supervisor, launcher, proxies, CLI front); TypeScript/Angular (frontend); Node 22 bundled (MCP
server); POSIX sh (Linux installer header); NSIS script (Windows installer).
**Primary Dependencies**: Spring Boot (existing); mitmproxy (existing, pinned); ByteBuddy (existing,
agent); `@modelcontextprotocol/sdk` (existing, Streamable HTTP transport); build-time only:
python-build-standalone, Temurin JDK 21 + jlink, Node 22, esbuild, NSIS, WinSW (all pinned with sha256
in `build-versions.json`).
**Storage**: unchanged SQLite stores under `data/`; new flat files `data/env-history.jsonl`,
`data/env-history/*.env`, `data/pending-restart.json`, `data/run/control.json`.
**Testing**: JUnit5/Mockito/AssertJ + ArchUnit (backend-server slice, serverbridge, SpaPageFilter
parity with nginx.conf); Karma/Jasmine for the frontend `shared/utils` (size parsing, diff, filter) and
the server-settings component where DOM-only; pytest for the shared settings module, the supervisor
(fake children) and `build_dist.py` packaging (tar modes, LF endings); agent ITs for trust and proxy;
manual SPIKE runs S1-S3 on real Linux and Windows Server.
**Target Platform**: Linux x64 (glibc 2.17+, systemd) and Windows Server 2019/2022 x64. Docker path
unchanged.
**Project Type**: web service + supervisor + CLI + installers.
**Performance Goals**: live settings applied ≤ 2 s; proxy restart ≤ 5 s; full restart and UI
reconnect ≤ 30 s; check request ≤ 5 s; install to first logged call ≤ 10 min (SC-001, SC-004).
**Constraints**: works fully offline; installer about 150 MB; no system-wide changes except the service;
no polling; nothing new on the proxy request path.
**Scale/Scope**: about 18 settings; 1 new backend slice; 1 bridge package; 1 new Java module
(attach-cli); 1 extended module (db-agent); about 6 new frontend files; supervisor and launcher
(Python); build script; 2 installer templates.

## Constitution Check

*Gate before Phase 0: PASS with three recorded deviations (Complexity Tracking). Re-checked after Phase 1: PASS.*

- [x] **I. Security**
  - Writes under `/server/**` are guarded server-side by `EditAccessFilter`: TCP peer plus Cloudflare
    headers, never `X-Forwarded-For`.
  - Request DTOs use `@Valid`. Edits are capped at 64 per request, uploads at 64 KB, history `limit`
    is clamped to 1..50.
  - Secrets (`WEBHOOK_SECRET`, `ALFRED_LOGS_AGENT_SECRET`) are never returned, logged or written to
    history; the `.env` download masks them. `WEBHOOK_SECRET` stops defaulting to
    `change-me-in-production` natively: a random value is generated at install.
  - The supervisor control API is localhost-only, with a token file readable only by the service account.
  - The service runs as root / LocalSystem by default (clarification; R16). `.env`, the control
    token and `data/` are owner-only. `export_calls` in HTTP mode is pinned to `data/exports/`;
    nothing reachable over HTTP touches arbitrary paths.
  - `/mcp` is open wherever the UI is, including the tunnel (owner's decision, FR-082, R13); it acts
    only through Alfred's own API. Docker mode refuses every `/server/**` write (FR-054).
  - The Docker import copies and never moves or deletes the Docker install (R17).
  - Every client-supplied size is capped: 64 edits per save or check, 64 KB uploads, 10 MB `/mcp` request bodies, history `limit` 1..50.
  - Folder checks never read file content.
  - The agent accepts only chains that verify against Alfred's own CA.
  - Supervisor events use the existing `X-Webhook-Secret` check.
  - New build-time dependencies are pinned with sha256. NSIS and WinSW are build or service tools, not
    libraries in the app.
- [x] **II. Performance**
  - Nothing is added on the proxy request path.
  - No polling: the Server card is driven by a `/ws/server` signal; checks run on demand (debounced);
    the restart reconnect uses the existing `reconnectingSocket` back-off.
  - Traffic rate and storage use come from windowed, indexed COUNT and size queries.
  - History has a retention of 50 entries; MCP exports have a retention of 7 days.
  - `.env` is about 2 KB, so whole-file rewrite is fine; it is written via temp file and atomic move.
- [x] **III. Architecture**
  - New slice `backend-server`, hexagonal (`domain.model`, `application.port.in/out`,
    `application.service`, `adapter.in.web`, `adapter.in.cli`, `adapter.out.{envfile,history,probe,supervisor}`).
  - Cross-slice needs go through `backend-app/serverbridge`: `LiveSettingsPort`, `StorageUsagePort`
    and `TrafficRatePort` implementations calling other slices' use cases. No new slice-to-slice edge.
  - New use cases in the owning slices: `SetRetentionUseCase` (internal-calls),
    `SetStorageBudgetUseCase` (calls, db-capture), replace-watch-folders (logs), reload-projects
    (internal-calls).
  - "Adding a slice" checklist followed, including an ArchUnit isolation rule.
  - Frontend: standalone component plus signals, under `pages/settings`.
- [x] **IV. Style**: `*UseCase`/`*Port`/`*Service`/`*Controller`, records, constructor injection,
  SLF4J; Python follows `start.py` style; TS strict.
- [x] **V. Clean code**
  - One `.env` engine for UI, CLI, installer and launcher (R7): Python never writes `.env` in native mode; it calls `ServerConfigCli init` / `merge-docker-env`.
  - One key-to-variable map (`settings-env-map.json`) read by the backend slice and the supervisor (data-model).
  - Project and folder grammar: one Python module (`alfred_settings.py`, shared by `start.py`,
    `restart.py` and the supervisor) and one Java port of it in the slice, with a shared test-vector
    file `specs/012-server-program/fixtures/services-grammar.json` that both test suites run, so they
    cannot drift.
  - The MCP server is reused, not rewritten (R13).
  - Attach and proxy logic is moved from `wildfly-proxy-toggle`, not copied.
  - Nothing beyond the spec: no ARM, no macOS.
- [x] **VI. Verification**: tests per layer listed in Technical Context; spikes S1-S3 are gating
  tasks; realistic data for storage-limit warnings (real DB sizes in tests via `@TempDir` SQLite).
- [x] **Docs in the same change**: each task that changes documented behavior updates its doc in that task (gateway prefixes in CLAUDE.md/AGENTS.md with T019, settings rule with T044, docs/logs.md, docs/mcp.md, docs/architecture.md); the Polish phase only re-checks.
- [x] **Invariants**
  - Exports untouched; the MCP export download serves the file as built.
  - Interception stays in the addons.
  - `server` and `mcp` prefixes go into the gateway regex AND `SpaPageFilter`, with a parity test.
  - Callers stay on localhost.
  - "Docker never touches the host": still true for Docker. The native installer is a new host-side
    path (deviation 1).
  - `settings.properties` only fills gaps in `.env`: kept.
  - Docs: new `docs/server.md`; updates to CLAUDE.md, AGENTS.md, `docs/architecture.md` (new slice),
    `docs/mcp.md` (HTTP mode), `docs/supplier-integrations.md` (native cert trust),
    `docs/db-capture.md` (agent args).

## Project Structure

### Documentation (this feature)

```text
specs/012-server-program/
├── plan.md, research.md, data-model.md, quickstart.md
├── contracts/ (server-api.md, cli.md, installer-and-build.md, supervisor-and-agent.md)
├── fixtures/services-grammar.json        # shared Python/Java test vectors (Phase 2)
├── checklists/requirements.md
└── tasks.md                              # /speckit.tasks
```

### Source Code (repository root)

```text
build_dist.py                     # NEW: builds both installers
build-versions.json               # NEW: pinned runtimes/tools + sha256
alfred_settings.py                # NEW: shared .env/settings.properties/services grammar (start.py, restart.py, launcher import it)
packaging/                        # NEW
├── launcher/alfred.py            # `alfred` command: lifecycle, config (thin client), jvms/attach
├── launcher/supervisor.py        # `alfred run`: children, back-off, control API
├── linux/installer-header.sh     # .run self-extractor + install/upgrade/uninstall
├── linux/alfred.service
├── windows/installer.nsi
└── windows/alfred-service.xml    # WinSW config

backend/
├── backend-server/               # NEW slice
│   └── src/main/java/com/fathy/alfred/backend/server/
│       ├── domain/model/         # SettingDefinition, SettingCatalog, EnvDocument, SettingsChange, ValidationResult,
│       │                         # Project, WatchedFolder, HistoryEntry, PendingRestart, ServerStatus, EditAccess
│       ├── application/port/in/  # GetSettingsUseCase, CheckSettingsUseCase, PreviewSettingsUseCase, SaveSettingsUseCase,
│       │                         # SettingsHistoryUseCase, ImportEnvUseCase, RestartUseCase, ServerStatusUseCase, EditAccessUseCase
│       ├── application/port/out/ # EnvFilePort, DefaultsPort, HistoryPort, PendingRestartPort, PortProbePort, FolderProbePort,
│       │                         # DiskProbePort, MemoryProbePort, AppHealthPort, StorageUsagePort, TrafficRatePort,
│       │                         # LiveSettingsPort, SupervisorPort, ServerEventsPort
│       ├── application/service/
│       ├── adapter/in/web/       # ServerSettingsController, ServerRestartController, SupervisorEventsController, EditAccessFilter
│       ├── adapter/in/cli/       # ServerConfigCli (plain main, no Spring)
│       └── adapter/out/          # envfile/, history/, probe/, supervisor/, websocket/
├── backend-app/.../serverbridge/ # NEW: LiveSettingsBridge, StorageUsageBridge, TrafficRateBridge
├── backend-app/.../web/SpaPageFilter.java   # NEW (native only; parity test with gateway/nginx.conf)
├── backend-app/.../mcpbridge/McpRelayController.java  # NEW: /mcp streaming relay, /mcp-exports download
├── backend-internal-calls, backend-calls, backend-db-capture, backend-logs   # + small runtime-setter use cases (R8)
└── backend-architecture-test     # + backend-server isolation rule
db-agent/                         # extended into alfred-agent.jar: + proxy/, trust/ packages, features arg
attach-cli/                       # NEW Java 21 module (logic moved from wildfly-proxy-toggle/)
mcp-server/src/index.ts           # + Streamable HTTP transport by env var; export download links
frontend/src/app/
├── pages/settings/server-settings/   # NEW: Server section (cards, projects table, folder list, review, history, upload, restart dialogs)
├── core/services/server-settings.service.ts
├── core/models/server-settings.model.ts
└── shared/utils/server-settings.ts   # pure: size parse/format, filter/search, diff rendering, retention estimate text
gateway/nginx.conf                # + server|mcp|mcp-exports prefixes
docs/server.md                    # NEW
```

**Structure Decision**: The existing multi-module layout is kept. The backend work is one new hexagonal
slice plus a composition-root bridge. The packaging code lives in a new `packaging/` folder, and the
shared Python settings module sits at the root next to `start.py`, which imports it.

## Delivery phases

Spikes gate the work that depends on them. Each phase can be shipped and demonstrated on its own.

| Phase | Content | Stories | Gate |
|---|---|---|---|
| 0 | SPIKES S1 (bundled mitmdump on both OS), S2 (cross-version attach), S3 (trust advice); constitution amendment 1.0.1 proposed | (all) | S1 and the owner's approval of the amendment before phase 1; S2/S3 before phase 5 |
| 1 | `alfred_settings.py` extraction (start.py/restart.py use it, no behavior change); supervisor + launcher; SpaPageFilter + static UI; native paths (R14); `build_dist.py`; both installers (install, upgrade, uninstall, Docker import R17, root/LocalSystem service R16) | US1, US2 (file creation, defaults) | clean-VM install on Linux + Windows Server |
| 2 | `backend-server` slice: catalog, EnvDocument, settings read/check/preview/save, access filter, history, conflicts, live setters + serverbridge; Docker read-only mode (FR-054); frontend Server section | US2, US3, US5, US7 | SC-003, SC-005, SC-006 |
| 3 | Restart via supervisor, Server card status over `/ws/server`, pending-restart | US4 | SC-004 |
| 4 | `alfred config` CLI (both modes), import/download, search/filter | US6, US8 | CLI and UI give the same results |
| 5 | alfred-agent (proxy, trust, features), attach-cli, `alfred jvms/attach/detach`; retire `wildfly-proxy-toggle` scripts to thin wrappers | US9 | SC-007 |
| 6 | MCP over HTTP behind `/mcp` (open wherever the UI is), export downloads, `exportFolder` pinned to `data/exports/` | US10 | SC-008 |
| 7 | Docs, CLAUDE.md/AGENTS.md, full test suites, both installers end-to-end per quickstart | all | SC-001, SC-009, SC-010 |

**Subagent budget** (CLAUDE.md): this is done in the main session. Phase 5 (agent plus attach-cli) is
the one self-contained chunk that could go to a single subagent, if the owner agrees.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Invariant "host changes happen only via start.py/start.sh/start.ps1" (amendment proposed in Setup, approved before any installer work) | The native installer and `alfred` launcher register a service and write into the install folder: a second host-side setup path | Driving native installs through `start.py` would bring back the Python prerequisite and the Docker-centric flow the owner wants removed. **Proposed amendment (PATCH 1.0.1)**: "Host changes happen only via the host-side setup scripts (`start.py`/`start.sh`/`start.ps1` for Docker; the installers and `alfred` launcher under `packaging/` for the native install)." |
| Two implementations of the project/folder grammar (Python `alfred_settings.py` + Java in `backend-server`) | The supervisor and `start.py` need it before any JVM runs; the backend needs it for validation | One Python engine called by the backend puts Python on a request path; one Java engine called by `start.py` adds a JVM to the Docker flow. Drift is prevented by a shared test-vector file run by both suites. |
| A fourth runtime in the installer (Node) | The MCP server reuses the frontend's export, redaction and analysis code by design | A Java rewrite would duplicate the export builders that CLAUDE.md requires to be single-sourced, and would break the "Claude and the UI never disagree" guarantee. |
