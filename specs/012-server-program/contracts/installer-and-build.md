# Contract: installers and the build script

## Installer: Linux `alfred-setup-<version>-linux-x64.run`

```
sudo ./alfred-setup-<version>-linux-x64.run [--dir /opt/alfred] [--user root] [--ui-port 3000]
                                            [--import-docker <folder> | --no-import]
                                            [--unattended] [--no-start] [--allow-downgrade]
```
- **Interactive by default**: asks for the folder, user and port, with defaults in brackets.
  `--unattended` uses the defaults or flags and asks nothing.
- **Steps**, each printed as `✓`/`✗`:
  1. Check root.
  2. Extract to a temp folder.
  3. On upgrade, stop the service.
  4. Move the program folders into place.
  5. Create `.env` if missing, with defaults plus a random `WEBHOOK_SECRET`.
  6. If an existing Docker install is found (or `--import-docker`), ask and import it (research R17).
  7. Set file ownership to the service account (default `root`), with owner-only permissions.
  8. Install `/etc/systemd/system/alfred.service` and the `/usr/local/bin/alfred` link.
  9. `systemctl enable --now alfred`.
  10. Wait up to 60 s for `/health`.
  11. Print the UI addresses and next steps.
- **Upgrade**: detected from `<dir>/app/VERSION`. Keeps `.env` and `data/`. Records an `UPGRADE`
  history entry.
- **Exit codes**: `0` ok, `1` failed (old install unchanged), `2` usage, `5` not root, `6` refused
  downgrade.

## Installer: Windows `alfred-setup-<version>-windows-x64.exe`

- A wizard (folder, port), or silent:
  `alfred-setup-<version>-windows-x64.exe /S [/DIR=C:\alfred] [/UIPORT=3000] [/SERVICEUSER=LocalSystem] [/IMPORTDOCKER=<folder>]`.
- Same steps as Linux. The service is registered with WinSW (`alfred` service, LocalSystem by default or the
  chosen account, restart on failure). `alfred.cmd` is added to the machine `PATH`. An uninstaller
  entry appears in Programs and Features.
- Needs administrator rights (UAC prompt in wizard mode; silent mode fails with exit `5`).

## Build script `build_dist.py` (repo root)

```
python build_dist.py [--target linux|windows|all] [--skip-tests] [--clean]
```
- **Developer prerequisites**: Python 3.10+, Node 22, Docker. Everything else is downloaded into
  `build-cache/` with pinned versions and sha256 checks (`build-versions.json`).
- **Output**:
  ```
  dist/alfred-setup-<version>-linux-x64.run
  dist/alfred-setup-<version>-windows-x64.exe
  dist/SHA256SUMS
  ```
- `<version>` = `git describe --tags --always --dirty`, also written to `app/VERSION` and shown by
  `alfred version` and the Server card.
- Fails loudly with the failing step's name. Never leaves a partial file in `dist/`: it writes to
  `dist/.tmp` and then moves.
- `build-cache/`, `build/` and `dist/` are gitignored.
