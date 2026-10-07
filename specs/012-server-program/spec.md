# Feature Specification: Alfred as a Server Program

**Feature Branch**: `012-server-program`
**Created**: 2026-10-07
**Status**: Draft
**Input**: User description: "Today, using Alfred needs Docker, Python and manual configuration of each Java app (proxy flags, certificate trust, agents), plus a separate MCP setup. Make Alfred install and run like a program - not a desktop app, because Alfred often runs on a staging machine reached over SSH. Cover the MCP and the Java agents too. Python may stay as a prerequisite. All settings are read from one .env file, created on first start with every setting at its default; a setting missing from .env falls back to the default shown in settings.properties. The Settings tab gains a Server section that edits .env, plus an equivalent CLI. Alfred can be restarted from the Settings tab. Settings can be changed from the machine itself and from the local network (e.g. http://192.168.1.80:3000), never through the Cloudflare tunnel. Extras agreed in the mock (mockups/server-settings-mock.html): search, changed-only filter, checks as you type, project health, disk use, retention estimate, review before save, waiting-for-restart notice, history with revert, external-edit detection, download/upload .env, check everything, help per setting, watched folders as a list of fields."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install and run Alfred on a server without Docker (Priority: P1)

A developer copies one installer file to a staging server (Linux or Windows Server) and runs it, over SSH or on the desktop. The server needs nothing installed beforehand and no internet access. The installer puts every piece in place, creates the settings file, registers Alfred as a system service, starts it, and prints the UI address. Afterwards the developer can stop, start, restart and check Alfred's status with one `alfred` command.

**Why this priority**: This removes the biggest barrier today (Docker, the multi-container setup, host-side setup scripts). Without it, none of the other stories change how hard Alfred is to adopt.

**Independent Test**: On a clean Linux server and a clean Windows Server, with nothing installed and no internet access, run the installer, open the UI through an SSH tunnel, and see outbound and inbound calls being logged from a test app.

**Acceptance Scenarios**:

1. **Given** a server with no Docker, Python, Java or Node, **When** the developer runs the installer, **Then** Alfred is installed, `.env` is created with defaults, Alfred is registered as a service and started, and the UI addresses are printed.
2. **Given** the installer is run unattended (a silent flag, answers given as options), **When** it completes, **Then** the result is the same as an interactive install, using defaults for anything not given.
3. **Given** Alfred is running, **When** the developer runs the status command, **Then** they see whether the backend and both proxies are running, their process ids, uptime and the UI address.
4. **Given** Alfred is installed, **When** the server reboots, **Then** Alfred starts automatically.
5. **Given** an older Alfred install with data and settings, **When** the developer runs a newer installer, **Then** Alfred is stopped, its program files are replaced, recorded data and `.env` are kept untouched, and it starts again.
6. **Given** an installed Alfred, **When** the developer uninstalls it, **Then** the program and service are removed, and recorded data is deleted only if the developer confirms.
7. **Given** the existing Docker-based setup, **When** a team prefers it, **Then** it remains available as an alternative install path.
8. **Given** a server that already runs Alfred with Docker, **When** the developer runs the native installer, **Then** it offers to import that install's settings and recorded data; on yes it copies them into the new install, stops the Docker containers and leaves the old folder untouched; on no the native install starts empty.

---

### User Story 2 - One settings file with defaults (Priority: P1)

Every deploy-time setting (projects, ports, storage limits, memory, log folders, WildFly, who may change settings) is read from one `.env` file in the Alfred folder. On first start, if no `.env` exists, Alfred creates it with every setting at its default, grouped and commented. A setting missing from `.env` (deleted, or new in a newer version) uses its default from `settings.properties`, which ships with Alfred and is read-only for users.

**Why this priority**: Today the relationship between `settings.properties` and `.env` is confusing (one silently stops affecting the other once a value is adopted). A single, predictable source is a prerequisite for editing settings from the UI or the CLI.

**Independent Test**: Delete `.env`, start Alfred, confirm `.env` is created with all settings at defaults; remove one line, restart, confirm that setting reports its default and is marked as "not in .env".

**Acceptance Scenarios**:

1. **Given** no `.env`, **When** Alfred starts, **Then** `.env` is created containing every setting with its default value and a short comment.
2. **Given** `.env` lacks a setting, **When** Alfred starts, **Then** that setting uses the default from `settings.properties` and is reported as coming from the default.
3. **Given** `.env` contains a line Alfred does not understand, **When** Alfred starts, **Then** it reports the line number and content and continues with the remaining settings.
4. **Given** a user edits `.env` by hand, **When** they restart Alfred, **Then** the new values are used.

---

### User Story 3 - Change settings from the Settings tab (Priority: P1)

A developer opens the Settings tab and uses a Server section to view and change every deploy-time setting: inbound projects (name, listen port, app port) as an editable table, inbound retention, UI port, outbound proxy address, who may change settings, storage limits, memory, log drop folder, watched log folders (one field per folder, with add and remove), watch mode, and WildFly options. Each setting shows where its value comes from (`.env` or default), how a change takes effect (applies live, restarts the proxies, or needs a restart), a help text, and a reset-to-default action. Saving writes `.env`, keeping its comments and line order.

**Why this priority**: The main point of the request: no file editing over SSH for routine changes.

**Independent Test**: From the machine itself, change inbound retention and add a watched folder, review and save, confirm `.env` holds the new values and the change applied without a restart.

**Acceptance Scenarios**:

1. **Given** the Settings tab is open from the server itself or the local network, **When** the user changes a value, **Then** the field is marked as changed and a save bar shows the number of unsaved changes.
2. **Given** unsaved changes, **When** the user chooses to save, **Then** a review shows each `.env` line before and after, and how each change will take effect, before anything is written.
3. **Given** a saved change that applies live, **When** the save completes, **Then** Alfred uses the new value immediately.
4. **Given** a saved change to the project list or proxy address, **When** the save completes, **Then** the proxies restart by themselves and the page reports how long it took.
5. **Given** a saved change that needs a restart, **When** the save completes, **Then** a "waiting for restart" notice stays visible until Alfred restarts, naming each pending setting with old and new value.
6. **Given** a setting shown as "default, not in .env", **When** the user chooses reset to default on another setting, **Then** that setting's line is removed from `.env` and its default applies again.
7. **Given** settings new in this version are not yet in `.env`, **When** the page loads, **Then** a notice lists them and offers to add them with their defaults.
8. **Given** the watched-folders setting, **When** the user adds, edits or removes a folder, **Then** each folder is a separate field with its own check, and `.env` stores them as one list.

---

### User Story 4 - Restart Alfred and its proxies from the Settings tab (Priority: P2)

A Server card at the top of the Server section shows the status of the backend and both proxies. The user can restart the proxies only (a few seconds; the page stays up) or restart all of Alfred (about ten seconds; the page waits and reconnects by itself). A confirmation explains the effect before either restart.

**Why this priority**: Needed to apply settings that require a restart without SSH access, but settings that apply live already cover most changes.

**Independent Test**: Change memory, save, press restart in the waiting-for-restart notice, confirm the page reconnects by itself and the new memory is in effect.

**Acceptance Scenarios**:

1. **Given** Alfred is running, **When** the user confirms "Restart Alfred", **Then** Alfred stops and starts again, the page shows progress, and reconnects without a manual reload.
2. **Given** the restart confirmation, **When** it is shown, **Then** it states that the user's apps keep working through the proxies and that calls made while the backend is down are not logged.
3. **Given** the user confirms "Restart proxies", **When** the restart completes, **Then** the backend and the page stay available throughout.

---

### User Story 5 - Who may change settings (Priority: P1)

Server settings and restarts are allowed from the server itself and, by default, from the local network (private addresses). The allowed sources are a setting. Anyone who reaches Alfred through the Cloudflare tunnel sees the Server section read-only, with instructions on how to reach Alfred locally.

**Why this priority**: Settings include file paths that Alfred reads; editing them from the internet would expose the server. This must ship with the editing feature.

**Independent Test**: Open the UI from localhost (editable), from a LAN address (editable), and through the Cloudflare tunnel (read-only, save and restart refused by the server too, not just hidden).

**Acceptance Scenarios**:

1. **Given** a request from the server itself or a private network address allowed by the setting, **When** the user saves or restarts, **Then** it is accepted.
2. **Given** a request that came through the Cloudflare tunnel, **When** the user tries to save or restart by any means (UI or direct request), **Then** it is refused, even though the tunnel runs on the same machine.
3. **Given** the allowed-sources setting is narrowed to specific addresses or ranges, **When** a request comes from outside them, **Then** the Server section is read-only for it.

---

### User Story 6 - Change settings from the command line (Priority: P2)

Over SSH, the developer uses an `alfred config` command family that edits the same `.env` and gives the same answers as the UI: list all settings with value, source and how they apply; get, set, reset; add and remove items of list settings (projects, watched folders); add missing settings; check; diff against defaults; history; revert; import from another server's `.env`.

**Why this priority**: The UI covers the same needs; the CLI is for SSH-only work and scripting.

**Independent Test**: Run `alfred config set` for a live setting and for a restart setting; confirm `.env` changes and the reported effect matches the UI's.

**Acceptance Scenarios**:

1. **Given** an invalid value, **When** the user runs a set command, **Then** nothing is saved and the message says what is allowed.
2. **Given** a port already in use by another process, **When** the user sets a port setting to it, **Then** nothing is saved and the message names the process.
3. **Given** a revert of a history entry, **When** the user confirms, **Then** the old values are restored and the effect is reported.

---

### User Story 7 - Safe editing: checks, history, conflicts (Priority: P2)

While editing, every value is checked: ports (free, or which process holds them; duplicate listen ports), folders (exist, readable, how many log files), sizes and memory (format; limits below what is already stored; total limits versus free disk; memory versus free RAM), retention (estimated hours of traffic at the current rate and memory used). Save is blocked while any value is invalid. Each project shows whether its app answers on its port (a warning, not a block). A "check everything" action runs all checks at once. Every save is kept in a history (when, from where, by UI/CLI/hand edit) with revert. If `.env` changes on the server while the page is open, saving is blocked until the user loads the new values; their own unsaved edits are kept.

**Why this priority**: Prevents a bad setting from taking Alfred down on a remote server, but the editing feature works without it.

**Independent Test**: Enter a port held by another process, see save blocked with the process named; edit `.env` by hand while the page is open, see the conflict warning; revert a history entry.

**Acceptance Scenarios**:

1. **Given** a storage limit lowered below the amount already stored, **When** the user edits it, **Then** the page states how much of the oldest data will be removed on save.
2. **Given** `.env` was changed outside the page after it loaded, **When** the user tries to save, **Then** save is blocked and the page names what changed, until the user loads the server values.
3. **Given** a history entry, **When** the user reverts it, **Then** the old values are placed in the form as unsaved changes for review.

---

### User Story 8 - Search, filter, and copy settings between servers (Priority: P3)

The Server section has a search box (by name, key or value), a "only changed from default" filter, and download/upload of `.env`. Upload shows which values differ from this server, flags values invalid here (e.g. a folder that does not exist), and places the selected values in the form as unsaved changes.

**Why this priority**: Convenience once several servers run Alfred.

**Independent Test**: Search for "port" and see only port settings; upload another server's `.env`, select two values, see them in the form unsaved.

**Acceptance Scenarios**:

1. **Given** a search term, **When** typed, **Then** only matching settings and their groups are shown.
2. **Given** an uploaded `.env`, **When** a value is invalid on this server, **Then** it is flagged and not selected by default.

---

### User Story 9 - Attach Alfred to a running Java app with one command (Priority: P2)

The developer lists running Java processes on the server and attaches Alfred to one: outbound proxying, database capture, log capture and Redis capture can each be turned on or off, without restarting the app and without editing the app's startup configuration or the JDK's certificate store. Alfred's certificate is trusted by the attached app automatically. Attaching at app startup remains possible for those who prefer it.

**Why this priority**: Removes the per-app Java configuration and the three separate agents/tools. Lower than P1 because the existing attach scripts already work, just less conveniently.

**Independent Test**: Start a Java app with no Alfred configuration, attach with outbound proxying on, make an HTTPS call from the app, see it logged with no certificate error.

**Acceptance Scenarios**:

1. **Given** running Java apps, **When** the developer runs the list command, **Then** each app is shown with process id, name and whether Alfred is attached and which features are on.
2. **Given** an app with HTTPS clients already created before attaching, **When** Alfred is attached with outbound proxying, **Then** those clients' calls are logged without certificate errors.
3. **Given** an attached app, **When** the developer detaches or turns a feature off, **Then** the app continues working normally without that feature.
4. **Given** an app running on an older supported Java version, **When** attached, **Then** all features work.

---

### User Story 10 - Use Alfred's Claude tools against a remote Alfred (Priority: P3)

Alfred serves its Claude (MCP) tools from the same port as the UI. The developer registers that address in Claude on their own machine (through an SSH tunnel or the local network) without installing anything else. Exports that Claude writes can be downloaded to the developer's machine.

**Why this priority**: Today the MCP server must run on the same machine as Alfred; useful, but the rest of the feature stands without it.

**Independent Test**: With Alfred on a remote server, register its MCP address in Claude on a laptop through an SSH tunnel, run a tool such as listing projects, and get a result.

**Acceptance Scenarios**:

1. **Given** Alfred running remotely, **When** Claude is registered with Alfred's address, **Then** all existing Alfred tools work the same as with the local MCP server.
2. **Given** an export requested through Claude, **When** it completes, **Then** the developer can download the file to their own machine.

---

### User Story 11 - Check for updates and auto-update (Priority: P3, added 2026-10-08)

A release is a git tag; the repository's release workflow publishes both installers with a manifest (`latest.json`).
Each native install reads that manifest once a day and on demand, shows a newer release in the Server card and in
`alfred update --check`, and installs it on request (card button or `alfred update`) or, when set to `auto`, by
itself inside a time window. The install goes through the supervisor: download, sha256 check, the installer run
detached so that stopping Alfred does not kill it. Nothing is downloaded by a check. Docker installs are told to use
`deploy.py`. Settings: `ALFRED_UPDATE_MODE` (off | check | auto, default check), `ALFRED_UPDATE_URL` (GitHub
Releases by default; a `file://` folder for offline servers), `ALFRED_UPDATE_WINDOW` (default 02:00-04:00).

**Acceptance Scenarios**:

1. **Given** a newer tagged release, **When** the daily check runs, **Then** the Server card and `alfred status` say which version is available, without downloading it.
2. **Given** an available update, **When** an editor installs it, **Then** the installer is downloaded, its checksum verified, Alfred is replaced, restarted, `.env` and data kept, and the page reconnects showing the new version.
3. **Given** a checksum that does not match, **When** the install runs, **Then** nothing is installed and the card says why.
4. **Given** `auto` mode and a window, **When** the check finds an update outside the window, **Then** nothing happens until the window; inside it the install runs once.
5. **Given** a request through the tunnel, **When** it tries to install, **Then** it is refused like every other settings write.

- **FR-100**: A check MUST read only the manifest; an install MUST verify the installer's sha256 before running it and MUST run it detached from Alfred's processes.
- **FR-101**: Hash-named (untagged) builds MUST never be offered as updates, and a release MUST never be offered to a build newer than it.

### Edge Cases

- Port 443 (default outbound proxy address) needs elevated rights on some systems: Alfred reports clearly that it cannot listen there and suggests a different address via the setting.
- A proxy process crashes: Alfred restarts it and reports it in the Server card.
- Restart requested while a save is in progress: the save completes first.
- The UI port is changed: after restart the page cannot reconnect at the old address; the confirmation states the new address to open.
- `.env` is not writable: save fails with a clear message, nothing is partially written.
- Two users save at the same time: the second is treated as an external-edit conflict.
- Docker import fails midway (disk full, Docker volume unreadable): the native install keeps no partial data, the Docker install keeps running, and the installer says what failed.
- `.env` contains a secret value (e.g. the logs agent secret): it is shown masked in the UI and download.
- The installer fails or is interrupted midway: nothing is left half-installed, and an existing install keeps working.
- The installer is run without administrator rights: it stops with a clear message before changing anything.
- The install folder already holds a newer version: the installer refuses to downgrade unless told to explicitly.
- An attach targets a Java process owned by another OS user: on Linux Alfred switches to that user for the attach automatically; on Windows, if the process is in another session and cannot be reached, the attach is refused with a message saying to run it from that session.
- A project is removed: its already recorded calls are kept.

## Requirements *(mandatory)*

### Functional Requirements

**Install and run**

- **FR-001**: Alfred MUST be distributed as one executable installer per operating system that needs nothing pre-installed on the server (no Docker, Python, Java or Node) and no internet access.
- **FR-002**: After installation, Alfred MUST provide one `alfred` command with start, stop, restart, restart proxies only, status, and uninstall actions.
- **FR-002a**: The installer MUST support interactive and unattended use (install folder, service account and UI port given as options; the service account defaults to root on Linux and LocalSystem on Windows), register a system service (start at boot, restart on failure), start Alfred, and print the UI addresses.
- **FR-002b**: Running a newer installer over an existing install MUST upgrade it in place: stop, replace program files, keep `.env` and recorded data, start.
- **FR-002c**: Uninstall MUST remove the program and the service, and delete recorded data only after explicit confirmation.
- **FR-002d**: The installer MUST detect an existing Docker-based Alfred on the server (or accept its folder as an option) and offer to import its `.env` and all recorded data (calls, inbound calls, comments, cycles, profiles, interception rules and answers, scenarios, Relive cycles, logs, database and Redis capture, flag files, CA certificate). Import copies, never moves; it stops the Docker containers only after a successful copy; unattended mode imports only when told to.
- **FR-003**: The installer MUST carry every runtime piece Alfred needs (including its own Python and Java runtimes) inside the install folder, and change nothing system-wide except the service registration.
- **FR-004**: Alfred MUST serve the UI, the API and the Claude tools on one port.
- **FR-005**: Alfred MUST supervise both proxies, restart a crashed proxy, and report proxy status.
- **FR-007**: The Docker-based install MUST remain available as an alternative path.
- **FR-008**: Installers MUST exist for Linux x64 and Windows Server x64, with the same `alfred` commands on both.

**Settings source**

- **FR-010**: All deploy-time settings MUST be read from `.env` in the Alfred folder.
- **FR-011**: When `.env` does not exist at start, Alfred MUST create it with every setting at its default, grouped by topic, each with a comment.
- **FR-012**: A setting missing from `.env` MUST use its default from `settings.properties`, and Alfred MUST report it as coming from the default.
- **FR-013**: `settings.properties` MUST ship with Alfred, be replaced on upgrade, and never be written by the UI or CLI.
- **FR-014**: Settings MUST keep their current names (e.g. `INTERNAL_CALL_SERVICES`, `ALFRED_CALLS_MAX_SIZE_BYTES`), and Alfred MUST add `ALFRED_UI_PORT`, `ALFRED_OUTBOUND_PROXY_LISTEN`, `ALFRED_MEMORY` and `ALFRED_SETTINGS_EDIT_FROM`.
- **FR-015**: Writes to `.env` MUST keep existing comments and line order, change only the affected lines, and be atomic (never a half-written file).
- **FR-016**: Unknown or malformed `.env` lines MUST be reported with line number, and ignored.
- **FR-017**: Sizes MUST be accepted in human units (MB, GB) in the UI and CLI and stored in `.env` in the existing format.
- **FR-018**: List settings (projects, watched folders) MUST be stored as one comma-separated line in `.env`.

**Server section in the Settings tab**

- **FR-020**: The Settings tab MUST have a Server section with every deploy-time setting, grouped as: Server status, Inbound projects, Network, Storage limits, Logs, WildFly.
- **FR-021**: Each setting MUST show its key, its source (`.env` or default), how a change takes effect (live / restarts proxies / restart needed), a help text, and a reset-to-default action when it is in `.env`.
- **FR-022**: Inbound projects MUST be an editable table (name, listen port, app port, optional outbound address for outbound attribution) with add and remove, showing the address callers use and whether the app answers on its port.
- **FR-023**: Watched log folders MUST be shown as one row per folder (name and path) with add and remove, each with its own check.
- **FR-024**: Changes MUST be held as unsaved until the user reviews them; the review MUST show each affected `.env` line before and after and each change's effect.
- **FR-025**: After save, live settings MUST apply immediately, proxy settings MUST restart the proxies automatically, and restart settings MUST produce a persistent "waiting for restart" notice listing each pending change.
- **FR-026**: The section MUST offer to add settings that are new in this version and missing from `.env`, with their defaults.
- **FR-027**: The section MUST provide search by name, key or value, and an "only changed from default" filter.
- **FR-028**: The section MUST provide download of `.env` and upload of another `.env`, with per-value selection and validation, placing selected values in the form unsaved.
- **FR-029**: Secret values in `.env` MUST be masked in the UI and in downloads.

**Validation and safety**

- **FR-030**: Alfred MUST validate every value as it is entered: format; ports free or which process holds them; duplicate listen ports; folders exist and are readable; storage limits versus amount stored and free disk; memory versus free RAM.
- **FR-031**: Save MUST be blocked while any value is invalid; warnings (e.g. a project app not answering) MUST NOT block save.
- **FR-032**: Alfred MUST show, for inbound retention, the estimated time span of traffic it holds at the current rate and its memory use.
- **FR-033**: A "check everything" action MUST run all checks and summarise problems and warnings.
- **FR-034**: Every change to `.env` (UI, CLI or detected hand edit) MUST be recorded in a history with time, source (UI with client address, CLI with OS user, hand edit) and before/after values; at least the last 50 entries MUST be kept.
- **FR-035**: Reverting a history entry MUST place the old values in the form as unsaved changes (UI) or ask for confirmation (CLI).
- **FR-036**: If `.env` changed after the page loaded, Alfred MUST block save, name what changed, and let the user load the server values while keeping their own unsaved edits.

**Restart**

- **FR-040**: The Server section MUST show status of the backend and each proxy, with "Restart proxies" and "Restart Alfred" actions, each behind a confirmation that states its effect.
- **FR-041**: During a full restart, the page MUST show progress and reconnect by itself when Alfred answers again.
- **FR-042**: The restart confirmation MUST state that calls made while the backend is down are not logged.

**Access control**

- **FR-050**: Saving settings, restarting, reverting and uploading MUST be allowed only from sources listed in `ALFRED_SETTINGS_EDIT_FROM` (default: this machine and private network addresses; also specific addresses or ranges).
- **FR-051**: Requests that arrive through the Cloudflare tunnel MUST always be read-only for the Server section, regardless of their apparent source address.
- **FR-052**: The access rule MUST be enforced by the server for every write, not only by hiding UI controls.
- **FR-053**: A read-only viewer MUST see an explanation of how to reach Alfred with edit rights.
- **FR-054**: When Alfred runs the Docker way, the Server section MUST show every setting and its effective value read-only, with edit and restart disabled and a note explaining to change `.env` and run `restart.py`.

**Command line**

- **FR-060**: `alfred config` MUST offer list, get, set, reset, add, remove (for list settings), add-missing, check, diff (against defaults), history, revert, and import, all editing the same `.env` with the same validation and effect reporting as the UI.

**Java agent**

- **FR-070**: Alfred MUST provide one agent that combines outbound proxying, database capture, log capture and Redis capture, each switchable on and off.
- **FR-071**: Alfred MUST list running Java processes on the server with their attach state, and attach to or detach from one without restarting it.
- **FR-072**: An attached app MUST trust Alfred's certificate without changes to the JDK certificate store or the app's startup configuration, including HTTPS clients created before attaching.
- **FR-073**: Attaching at app startup MUST remain supported.
- **FR-074**: The agent MUST support the same oldest Java version the current agents support.

**Claude tools (MCP)**

- **FR-080**: Alfred MUST serve its Claude tools over the network from the UI port, with the same tools and behavior as the current local MCP server.
- **FR-081**: Exports produced through Claude tools MUST be downloadable to the requesting machine.
- **FR-082**: Claude's tools MUST be reachable wherever the UI is reachable (this machine, the local network and the Cloudflare tunnel), with no extra access rule beyond the UI's; the `ALFRED_SETTINGS_EDIT_FROM` rule applies only to the Server section's writes.

**Building the installers**

- **FR-090**: One build script, run from a checkout on the developer's machine (Windows or Linux), MUST produce both installers (Linux and Windows) for the current version of the code, plus a checksum file.
- **FR-091**: The installer version MUST be derived from the version control state, so every installer can be traced to the exact commit it was built from.
- **FR-092**: The build script MUST fetch the tools and runtime pieces it needs by itself (cached between builds), beyond a small documented set the developer installs once.
- **FR-093**: The build script MUST allow building one target only and skipping tests.

### Key Entities

- **Setting**: a named deploy-time value. Attributes: key, value, default, source (`.env` or default), group, how it applies (live / proxies / restart), help text, validation rule, secret flag, list or single value.
- **Settings file (`.env`)**: the user's values, with comments and order preserved; created on first start.
- **Defaults file (`settings.properties`)**: the shipped default for each setting; read-only.
- **History entry**: time, source (UI + address, CLI + OS user, hand edit), list of changed settings with before/after.
- **Pending change**: a saved setting that needs a restart, with old and new value; cleared by a restart.
- **Project**: name, listen port, app port; app health (answering / not answering).
- **Attached process**: Java process id, name, owner, attached features.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with SSH access to a clean server (nothing installed, no internet) can go from copying the installer to logging their first call in under 10 minutes.
- **SC-002**: The number of tools a user must install before using Alfred drops from four (Docker, Python, Node, a JDK for the agent tools) to zero.
- **SC-003**: 100% of deploy-time settings can be viewed and changed from the Settings tab and from the CLI, with no file editing needed.
- **SC-004**: Settings that apply live take effect within 2 seconds of saving; a proxy restart completes within 5 seconds; a full restart completes and the page reconnects within 30 seconds.
- **SC-005**: No save or restart is ever accepted from a request that came through the Cloudflare tunnel (verified by direct requests, not only the UI).
- **SC-006**: An invalid value (busy port, missing folder, malformed size) can never be saved through the UI or CLI.
- **SC-007**: A Java app can be attached and have its HTTPS calls logged without a restart and without certificate errors, in a single command.
- **SC-008**: Every Claude tool available today works unchanged against an Alfred instance on another machine.
- **SC-009**: After an upgrade (FR-002b), 100% of recorded data and `.env` values are retained.
- **SC-010**: A developer can produce both installers for the current code with one command.

## Clarifications

### Session 2026-10-07

- Q: Which server operating systems must the package run on? → A: Linux and Windows Server.
- Q: Do some staging servers lack internet access? → A: Yes, some are offline (first answered as "normal + offline packages", superseded below).
- Q: Should the installer include Python so the server needs nothing? → A: Yes, the installer carries its own Python; no prerequisites.
- Q: With a full installer, keep normal + offline variants? → A: No, one full installer per OS, which also works offline.
- Q: How is Alfred delivered and built? → A: One executable installer per OS that sets everything up; one script on the developer's machine builds both from the current code.
- Q: Which OS user runs the Java apps Alfred attaches to? → A: Usually root / Administrator; the Alfred service runs as root / LocalSystem by default (installer can choose another account).
- Q: What happens to recorded data of an existing Docker install when the native installer runs? → A: The installer offers to import it (settings and all data); old folder untouched, containers stopped after a successful copy.
- Q: Should Claude's tools (/mcp) be reachable through the Cloudflare tunnel? → A: Yes, everywhere the UI is; no separate rule.
- Q: What does the Server section do when Alfred runs the Docker way? → A: Read-only, with a how-to (edit `.env`, run `restart.py`); no edit or restart.

## Assumptions

- Shipped defaults are neutral (inbound logging off, no projects, outbound calls capped at 10 GB as Docker runs today); a team's own values live in its `.env`.
- Each installer is self-contained (expected around 150 MB) and carries full Python and Java runtimes in the install folder; nothing is installed system-wide except the service.
- Installing a system service needs administrator rights; without them the installer stops with a clear message rather than half-registering a service.
- Alfred runs on the same server as the Java apps it attaches to. Those apps usually run as root (Linux) or Administrator/LocalSystem (Windows), so the Alfred service runs as root / LocalSystem by default; the installer lets the user choose another service account. Attaching needs the same OS user as the app.
- Users reach the UI through an SSH tunnel, the local network, or the existing Cloudflare tunnel; no login system is added in this feature, so the access rule is by request source.
- Private network addresses (10.x, 172.16-31.x, 192.168.x) are trusted by default; teams on shared networks narrow `ALFRED_SETTINGS_EDIT_FROM`.
- The outbound proxy keeps its current default address (`127.0.0.2:443`). The default root / LocalSystem service can listen there; with another service account, Linux grants the bind right to the service, and a failure to listen is reported with the setting to change.
- The proxies keep their current behavior of sending each call to the backend once; calls made while the backend restarts are not logged (stated to the user, not fixed in this feature).
- Live switches (inbound logging per project, database/log/Redis capture) and app data (filters, interception, profiles, redactions, variables) already have UI and are out of scope beyond showing in the Server card.
- Existing users moving from the Docker setup bring their `.env` through the import; keys only meaningful to Docker are ignored and reported.
- The supported oldest Java version for the agent is the one the current database-capture agent supports (Java 8).
- Phasing: stories 1-5 first; the unified agent (story 9) and remote Claude tools (story 10) may ship later as separate deliveries.
- The approved UI design is `mockups/server-settings-mock.html` (v4).
