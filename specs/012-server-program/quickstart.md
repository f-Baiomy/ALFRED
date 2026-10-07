# Quickstart: build, install and verify

## 1. Build both installers (developer machine)

Prerequisites: Python 3.10+, Node 22, Docker.

```bash
python build_dist.py
```
Expect `dist/alfred-setup-<version>-linux-x64.run`, `dist/alfred-setup-<version>-windows-x64.exe`
and `dist/SHA256SUMS`. A second run with nothing changed should reuse `build-cache/` and only redo
the assembly.

## 2. Install on a clean Linux server (no internet)

The cleanest test: `docker run -it --network none ubuntu:22.04` with systemd, or a fresh VM with its
network cut after copying the file.

```bash
scp dist/alfred-setup-*-linux-x64.run staging:
ssh staging
sudo ./alfred-setup-*-linux-x64.run --unattended
alfred status
```
Expect: backend, outbound proxy and MCP `RUNNING`, and the UI addresses printed. There is no reverse
proxy until a project exists.

From the laptop:
```bash
ssh -L 3000:localhost:3000 staging
```
Then open `http://localhost:3000`.

## 3. Install on Windows Server

Copy the `.exe`, then either run the wizard or:
```
alfred-setup-<version>-windows-x64.exe /S
alfred status
```

## 4. Verify the stories

| Story | Check |
|---|---|
| US1 | Reboot the server; `alfred status` shows everything running. Run the same installer again: "already installed, same version". Run a newer one: upgrade keeps `.env` and data. |
| US2 | `.env` exists with every key and comment. Delete a line, `alfred restart`: `alfred config list` shows that key as `default`. |
| US3 | Settings → Server: add project `demo 9001 → 8080`, review, save. The reverse proxy starts. `curl localhost:9001/` shows up in Live Calls. |
| US4 | Set `ALFRED_MEMORY` to `3g`, save, "Restart Alfred now". The page reconnects by itself. `alfred status` shows heap max 3 GB. During the restart, `curl` through `127.0.0.2:443` still works. |
| US5 | Open from a LAN address: editable. Open through the Cloudflare tunnel: read-only. `curl -X PUT` through the tunnel returns `403 TUNNEL`. |
| US6 | `alfred config set ALFRED_UI_PORT 22`: refused, sshd named. `alfred stop; alfred config set INTERNAL_CALLS_RETENTION_ROWS 3000`: works while stopped. |
| US7 | Edit `.env` by hand with the page open: conflict banner, save blocked. History shows `HAND_EDIT`. Revert works. |
| US8 | Search "port". Upload another server's `.env`: invalid folders flagged and unselected. |
| US9 | Start a Java 8 or 17 app without Alfred flags. `alfred jvms`, then `alfred attach <pid>`. An HTTPS call from the app is logged with no certificate error. `alfred detach <pid>`: calls go direct again. |
| US1 (import) | On a server running Alfred with Docker, run the installer and answer yes to import: the same calls, cycles, rules and logs appear in the native UI, the Docker containers are stopped, and the Docker folder is unchanged. |
| US10 | On the laptop, `claude mcp add --transport http alfred http://localhost:3000/mcp` (through the tunnel). `list_projects` works, also through the Cloudflare tunnel URL. `export_calls` returns a download link; an export path outside `data/exports/` is refused. |

## 5. Regression (Docker path unchanged)

```bash
python3 start.py
```
Same behavior as before. The Server section shows every setting read-only with its container value and the how-to note; `curl -X PUT /server/settings` returns `403 DOCKER_MODE`.
