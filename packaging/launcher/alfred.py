"""
alfred.py - the "alfred" command of a native install (specs/012-server-program contracts/cli.md).

    alfred start | stop | restart            through the system service when installed, else a background supervisor
    alfred restart --proxies                 restart only the two proxies (the backend and the UI stay up)
    alfred status                            what runs, since when, and the UI addresses
    alfred run                               the supervisor in the foreground (what the service runs)
    alfred logs [backend|outbound|reverse|mcp|log_agent|supervisor] [-f]   (proxy = outbound)
    alfred version
    alfred update [--check]                  check the release feed; without --check, install the update
    alfred uninstall [--keep-data]
    alfred config ... / project ...          settings (see config_cli.py)
    alfred jvms / attach / detach            Java apps (see attach_cli.py)

Exit codes: 0 ok, 1 error, 2 usage, 3 validation refused, 4 conflict, 5 not allowed.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

from layout import WINDOWS, Layout, home_from_here  # noqa: E402

OK, ERROR, USAGE, REFUSED, CONFLICT, NOT_ALLOWED = 0, 1, 2, 3, 4, 5
SERVICE = "alfred"


# ---------------------------------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------------------------------

def server_config_cli(layout, *args, capture=False):
    """The Java settings engine (research R7) - the only native writer of .env."""
    command = layout.config_cli(*args)
    if capture:
        return subprocess.run(command, capture_output=True, text=True)
    return subprocess.run(command)


def ensure_env(layout):
    """First start: .env with every setting at its default (FR-011), written by ServerConfigCli init."""
    layout.make_dirs()
    if not os.path.exists(layout.env_file):
        result = server_config_cli(layout, "init", capture=True)
        output = "\n".join(part for part in (result.stdout.strip(), result.stderr.strip()) if part)
        if result.returncode != 0:
            # Both streams and the file: "error: null" on its own once hid a whole failed first start.
            print(f"Could not create {layout.env_file}:\n{output or '(no output)'}", file=sys.stderr)
            raise SystemExit(ERROR)
        print(output)


def control(layout):
    """data/run/control.json of the running supervisor, or None."""
    try:
        with open(layout.control_file, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def call_supervisor(layout, method, path, timeout=10):
    info = control(layout)
    if not info:
        return None
    request = urllib.request.Request(f"http://127.0.0.1:{info['port']}{path}", method=method,
                                     headers={"X-Alfred-Control-Token": info["token"]})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def service_installed():
    if WINDOWS:
        return subprocess.run(["sc", "query", SERVICE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    return os.path.exists(f"/etc/systemd/system/{SERVICE}.service")


def service(layout, action):
    if WINDOWS:
        return subprocess.run([os.path.join(layout.home, "service", "alfred-service.exe"), action]).returncode
    return subprocess.run(["systemctl", action, SERVICE]).returncode


def ui_addresses(layout):
    port = layout.ui_port()
    addresses = [f"http://localhost:{port}"]
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and f"http://{ip}:{port}" not in addresses:
                addresses.append(f"http://{ip}:{port}")
    except OSError:
        pass
    return addresses


def own_backend(layout, timeout=2):
    """Who answers on this install's UI port: (True, None) when THIS install's backend does, (False, folder) when
    another Alfred does - its install folder -, (False, None) when nothing answers.

    /health alone was the check before, and another Alfred on the same machine (the Docker one, a second native
    install) answers it the same way: `alfred start` then printed "UI at ..." while this install's backend had
    crashed on the port the other one holds."""
    try:
        with urllib.request.urlopen(layout.local_url() + "/server/status", timeout=timeout) as response:
            status = json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return False, None
    other = status.get("installDir") or ""
    if other and os.path.normcase(os.path.realpath(other)) == os.path.normcase(os.path.realpath(layout.home)):
        return True, None
    return False, other or "an install that does not say where it is (Docker?)"


def wait_for_health(layout, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if own_backend(layout)[0]:
            return True
        time.sleep(1)
    return False


def explain_not_answering(layout):
    """Why this install's backend is not answering, as far as can be told from outside: another Alfred on the port,
    and the supervisor's own account of each process."""
    lines = []
    _, other = own_backend(layout)
    if other:
        lines.append(f"  Port {layout.ui_port()} is answered by another Alfred: {other}. This install ({layout.home}) "
                     "cannot listen there - change ALFRED_UI_PORT or stop that other install.")
    status = call_supervisor(layout, "GET", "/status")
    for p in (status or {}).get("processes", []):
        if p["state"] != "RUNNING" or p["detail"]:
            lines.append(f"  {p['name']}: {p['state'].lower()}" + (f" - {p['detail']}" if p["detail"] else ""))
    lines.append("  Logs: alfred logs supervisor, alfred logs backend")
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------------------------------------------------

def cmd_init_env(layout, args):
    """Used by the installers: create .env with defaults when missing (never overwrites)."""
    ensure_env(layout)
    return OK


def cmd_record_upgrade(layout, args):
    """Used by the installers after an upgrade: `_record-upgrade OLD NEW` adds one UPGRADE entry to the settings
    history (ServerConfigCli record-upgrade)."""
    if len(args) != 2:
        print("usage: alfred _record-upgrade OLD_VERSION NEW_VERSION", file=sys.stderr)
        return USAGE
    return server_config_cli(layout, "record-upgrade", *args).returncode


def cmd_wait_health(layout, args):
    """Used by the Windows installer after starting the service: wait up to 60 s for /health, print the UI
    addresses (the Linux installer does the same inline). Exit 1 when Alfred did not answer."""
    if wait_for_health(layout):
        print("UI at " + " · ".join(ui_addresses(layout)))
        return OK
    print("Alfred did not answer within 60 s.\n" + explain_not_answering(layout), file=sys.stderr)
    return ERROR


def cmd_run(layout, args):
    ensure_env(layout)
    import supervisor
    return supervisor.main(layout.home)


def cmd_start(layout, args):
    ensure_env(layout)
    if service_installed():
        code = service(layout, "start")
    elif control(layout) and call_supervisor(layout, "GET", "/status"):
        print("Alfred is already running.")
        return OK
    else:
        log_file = open(os.path.join(layout.logs, "supervisor.out"), "ab")
        kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS} if WINDOWS \
            else {"start_new_session": True}
        subprocess.Popen([sys.executable, os.path.join(HERE, "supervisor.py")], cwd=layout.home, stdin=subprocess.DEVNULL,
                         stdout=log_file, stderr=subprocess.STDOUT, env=dict(os.environ, ALFRED_HOME=layout.home), **kwargs)
        code = OK
    if code != OK:
        return ERROR
    if wait_for_health(layout):
        print("Starting Alfred... UI at " + " · ".join(ui_addresses(layout)))
        return OK
    # Say WHY when it can be told (a port in use names the setting to change), not only where the logs are.
    print("Starting Alfred... it did not answer within 60 s.")
    print(explain_not_answering(layout))
    return ERROR


def cmd_stop(layout, args):
    if service_installed():
        return OK if service(layout, "stop") == 0 else ERROR
    info = control(layout)
    if not info:
        print("Alfred is not running.")
        return OK
    try:
        if WINDOWS:
            subprocess.run(["taskkill", "/PID", str(info["pid"]), "/T", "/F"], stdout=subprocess.DEVNULL)
        else:
            os.kill(info["pid"], 15)
    except OSError:
        pass
    print("Stopping Alfred... done")
    return OK


def cmd_restart(layout, args):
    if "--proxies" in args:
        if call_supervisor(layout, "POST", "/restart/proxies") is None:
            print("Alfred is not running.")
            return ERROR
        print("Restarting proxies...")
        return OK
    if service_installed():
        code = service(layout, "restart")
        if code == OK and wait_for_health(layout):
            print("Alfred restarted. UI at " + " · ".join(ui_addresses(layout)))
        return OK if code == 0 else ERROR
    cmd_stop(layout, [])
    time.sleep(2)
    return cmd_start(layout, [])


def cmd_status(layout, args):
    status = call_supervisor(layout, "GET", "/status")
    if not status:
        print(f"Alfred {layout.version()} is not running (home {layout.home}).")
        return ERROR
    print(f"Alfred {status['version']}  ·  supervisor pid {status['pid']}  ·  {layout.home}")
    for p in status["processes"]:
        line = f"  {p['name']:<10} {p['state']:<10} pid {p['pid'] or '-':<7} up {uptime(p['startedAt']) if p['pid'] else '-':<8}"
        if p["restarts"]:
            line += f"  restarts {p['restarts']}"
        print(line)
        for listener in p["listeners"]:
            print(f"             {listener}")
        if p["detail"]:
            print(f"             {p['detail']}")
    print("UI: " + " · ".join(ui_addresses(layout)))
    update = update_line(layout)
    if update:
        print(update)
    return OK


def update_line(layout):
    """One line when the running backend knows of a newer release (or a failed/in-progress install); else None."""
    try:
        with urllib.request.urlopen(layout.local_url() + "/server/update", timeout=3) as response:
            status = json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    job = status.get("job") or {}
    if job.get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
        return f"Update: Alfred {job.get('version')} is {job['state'].lower()} - Alfred restarts when it is done."
    if job.get("state") == "FAILED":
        return f"Update: the install of {job.get('version')} failed ({job.get('error')}); the previous version was kept."
    if status.get("available"):
        return f"Update available: Alfred {status['latestVersion']} - install it with 'alfred update' or from the Settings tab."
    return None


def uptime(started_at):
    """"3d 02:15:07" / "02:15:07" from the supervisor's ISO start time (contracts/cli.md: status shows uptime)."""
    if not started_at:
        return "-"
    try:
        from datetime import datetime, timezone
        seconds = int((datetime.now(timezone.utc) - datetime.fromisoformat(started_at)).total_seconds())
    except ValueError:
        return "-"
    days, rest = divmod(max(seconds, 0), 86400)
    clock = f"{rest // 3600:02d}:{rest % 3600 // 60:02d}:{rest % 60:02d}"
    return f"{days}d {clock}" if days else clock


# contracts/cli.md names the outbound proxy's log "proxy"; the file is outbound.log. Both names work.
LOG_ALIASES = {"proxy": "outbound", "log-agent": "log_agent"}


def cmd_logs(layout, args):
    follow = "-f" in args
    names = [a for a in args if not a.startswith("-")]
    name = (names[0] if names else "supervisor").lower()
    path = os.path.join(layout.logs, LOG_ALIASES.get(name, name) + ".log")
    if not os.path.exists(path):
        print(f"No log yet: {path}")
        return ERROR
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f.readlines()[-200:]:
            print(line, end="")
        while follow:
            line = f.readline()
            if line:
                print(line, end="", flush=True)
            else:
                time.sleep(0.5)
    return OK


def cmd_version(layout, args):
    print(layout.version())
    return OK


def backend_json(layout, method, path, timeout=30):
    """A call to THIS install's running backend, as the OS user (the identity check of own_backend first)."""
    ok, other = own_backend(layout)
    if not ok:
        raise SystemExit("Alfred is not running here" + (f" (another Alfred answers on its port: {other})" if other else "")
                         + " - start it with 'alfred start'; updates are checked and installed by the running Alfred.")
    import getpass
    request = urllib.request.Request(layout.local_url() + path, method=method, data=b"{}" if method == "POST" else None,
                                     headers={"Content-Type": "application/json", "X-Alfred-Cli-User": getpass.getuser()})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8", "replace")).get("message") or f"HTTP {e.code}"
        except ValueError:
            detail = f"HTTP {e.code}"
        raise SystemExit(f"error: {detail}")


def describe_update(status):
    lines = []
    job = status.get("job") or {}
    if status.get("mode") == "OFF":
        lines.append("Update checks are off (ALFRED_UPDATE_MODE=off).")
    elif status.get("available"):
        size = status.get("sizeBytes") or 0
        lines.append(f"Update available: Alfred {status['latestVersion']} (running {status['currentVersion']}, "
                     f"{size // (1024 * 1024)} MB)" + (f", released {status['publishedAt']}" if status.get("publishedAt") else ""))
        if status.get("notes"):
            lines.append("  " + status["notes"].strip().replace("\n", "\n  "))
    elif status.get("error"):
        lines.append(f"Update check failed: {status['error']}")
    elif status.get("latestVersion"):
        lines.append(f"Alfred {status['currentVersion']} is up to date (newest release {status['latestVersion']}).")
    else:
        lines.append("No update check has run yet.")
    if job.get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
        lines.append(f"An update to {job.get('version')} is {job['state'].lower()}"
                     + (f" ({job['downloadedBytes'] // (1024 * 1024)} of {job['totalBytes'] // (1024 * 1024)} MB)"
                        if job["state"] == "DOWNLOADING" and job.get("totalBytes") else "") + ".")
    elif job.get("state") == "FAILED":
        lines.append(f"The last update ({job.get('version')}) failed: {job.get('error')}. The previous version was kept.")
    if status.get("checkedAt"):
        lines.append(f"Checked {status['checkedAt']} from {status.get('feedUrl', '')}.")
    return "\n".join(lines)


def cmd_update(layout, args):
    """alfred update [--check]: read the feed now and say what it found; without --check also install it."""
    if any(a not in ("--check",) for a in args):
        print("usage: alfred update [--check]", file=sys.stderr)
        return USAGE
    status = backend_json(layout, "POST", "/server/update/check", timeout=60)
    print(describe_update(status))
    if "--check" in args or not status.get("available"):
        return OK if not status.get("error") else ERROR
    if not status.get("canInstall"):
        print("It cannot be installed from here right now" + (" - an update is already in progress." if (status.get("job") or {}).get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING") else "."))
        return ERROR
    backend_json(layout, "POST", "/server/update/install")
    print(f"Installing Alfred {status['latestVersion']}: the installer is downloaded, verified and run. Alfred stops and starts "
          "again in about a minute; 'alfred status' then shows the new version, 'alfred update --check' the outcome.")
    return OK


def cmd_uninstall(layout, args):
    if WINDOWS:
        uninstaller = os.path.join(layout.home, "uninstall.exe")
        if not os.path.exists(uninstaller):
            print(f"error: {uninstaller} is missing - remove Alfred from Settings > Apps instead.", file=sys.stderr)
            return ERROR
        # The uninstaller asks about data/ in its own dialog; silent mode keeps it, which is what --keep-data means.
        return subprocess.run([uninstaller] + (["/S"] if "--keep-data" in args else [])).returncode
    if not is_admin():
        print("Run as root: sudo alfred uninstall")
        return NOT_ALLOWED
    keep = "--keep-data" in args
    if not keep:
        answer = input(f"Also delete everything Alfred recorded ({layout.data})? [y/N] ").strip().lower()
        keep = answer not in ("y", "yes")
    subprocess.run(["systemctl", "disable", "--now", SERVICE])
    for path in (f"/etc/systemd/system/{SERVICE}.service", "/usr/local/bin/alfred"):
        if os.path.lexists(path):
            os.remove(path)
    subprocess.run(["systemctl", "daemon-reload"])
    for folder in ("runtime", "app", "service", "agents"):
        shutil.rmtree(os.path.join(layout.home, folder), ignore_errors=True)
    for name in ("alfred", "settings.properties"):
        path = os.path.join(layout.home, name)
        if os.path.exists(path):
            os.remove(path)
    if not keep:
        shutil.rmtree(layout.data, ignore_errors=True)
        if os.path.exists(layout.env_file):
            os.remove(layout.env_file)
    print("Alfred removed." + (f" Kept {layout.data} and .env." if keep else ""))
    return OK


COMMANDS = {
    "run": cmd_run, "start": cmd_start, "stop": cmd_stop, "restart": cmd_restart, "status": cmd_status,
    "logs": cmd_logs, "version": cmd_version, "update": cmd_update, "uninstall": cmd_uninstall, "_init-env": cmd_init_env,
    "_wait-health": cmd_wait_health, "_record-upgrade": cmd_record_upgrade,
}


# Commands that work without reading data/ or .env. Every other one needs the account that may read them.
NO_DATA_NEEDED = {"version", "jvms"}


def is_admin():
    """Windows: an elevated (Run as administrator) prompt. Elsewhere: root."""
    if not WINDOWS:
        return os.geteuid() == 0
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def owner_name(path):
    try:
        import pwd
        return pwd.getpwuid(os.stat(path).st_uid).pw_name
    except (ImportError, KeyError, OSError):
        return "root"


def access_problem(layout, name):
    """Why this account cannot run `alfred <name>`, or None.

    data/ and .env are readable only by the service account and root / Administrators (the installers set that, the
    token in data/run/control.json can restart Alfred and .env holds secrets). Without that check every command gave
    a WRONG answer instead of a refusal: status said "not running" while Alfred ran, logs said "No log yet", and start
    failed with "FileExistsError ... data\\appdata" - Windows hides a locked folder's contents, so creating a folder that
    is already there looks like it is missing."""
    blocked = None
    for path in (layout.data, layout.env_file):
        try:
            if os.path.isdir(path):
                os.listdir(path)
            elif os.path.exists(path):
                open(path, "rb").close()
        except PermissionError:
            blocked = path
            break
    if blocked is None:
        return None
    if WINDOWS:
        return (f"alfred {name} needs an Administrator prompt: {blocked} is readable only by Administrators and the "
                "Alfred service.\nOpen Command Prompt or PowerShell with 'Run as administrator' and run it again.")
    owner = owner_name(blocked)
    hint = "sudo alfred " + name if owner == "root" else f"sudo alfred {name}  (or as {owner}: sudo -u {owner} alfred {name})"
    return f"alfred {name} needs root: {blocked} is readable only by {owner}.\nRun: {hint}"


def main(argv):
    layout = Layout(home_from_here())
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return OK if argv else USAGE
    name, args = argv[0], argv[1:]
    if name not in NO_DATA_NEEDED and not (args and args[0] in ("-h", "--help", "help")):
        problem = access_problem(layout, name)
        if problem:
            print(problem, file=sys.stderr)
            return NOT_ALLOWED
    if name in ("config", "project"):
        import config_cli
        return config_cli.main(layout, name, args)
    if name in ("jvms", "attach", "detach"):
        import attach_cli
        return attach_cli.main(layout, name, args)
    command = COMMANDS.get(name)
    if not command:
        print(f"Unknown command: {name}\n")
        print(__doc__.strip())
        return USAGE
    try:
        return command(layout, args)
    except PermissionError as e:
        # A file the check above did not look at (a log, a database) - still a refusal, not a traceback.
        print(f"alfred {name}: not allowed to use {e.filename}. "
              + ("Run it from an Administrator prompt." if WINDOWS else "Run it with sudo."), file=sys.stderr)
        return NOT_ALLOWED


if __name__ == "__main__":
    # Output may be piped (the installer captures it) in the ANSI code page: never let a "·" or "✓" raise.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    sys.exit(main(sys.argv[1:]))
