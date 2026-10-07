"""
alfred.py - the "alfred" command of a native install (specs/012-server-program contracts/cli.md).

    alfred start | stop | restart            through the system service when installed, else a background supervisor
    alfred restart --proxies                 restart only the two proxies (the backend and the UI stay up)
    alfred status                            what runs, since when, and the UI addresses
    alfred run                               the supervisor in the foreground (what the service runs)
    alfred logs [backend|outbound|reverse|mcp|log_agent|supervisor] [-f]
    alfred version
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
        print(result.stdout.strip() or result.stderr.strip())
        if result.returncode != 0:
            raise SystemExit(ERROR)


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


def wait_for_health(layout, seconds=60):
    deadline = time.monotonic() + seconds
    url = layout.local_url() + "/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(1)
    return False


# ---------------------------------------------------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------------------------------------------------

def cmd_init_env(layout, args):
    """Used by the installers: create .env with defaults when missing (never overwrites)."""
    ensure_env(layout)
    return OK


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
    print("Starting Alfred...", "UI at " + " · ".join(ui_addresses(layout)) if wait_for_health(layout) else
          "it did not answer within 60 s - see `alfred logs supervisor`")
    return OK


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
        line = f"  {p['name']:<10} {p['state']:<10} pid {p['pid'] or '-':<7} since {p['startedAt'] or '-'}"
        if p["restarts"]:
            line += f"  restarts {p['restarts']}"
        print(line)
        for listener in p["listeners"]:
            print(f"             {listener}")
        if p["detail"]:
            print(f"             {p['detail']}")
    print("UI: " + " · ".join(ui_addresses(layout)))
    return OK


def cmd_logs(layout, args):
    follow = "-f" in args
    names = [a for a in args if not a.startswith("-")]
    path = os.path.join(layout.logs, (names[0] if names else "supervisor").lower() + ".log")
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


def cmd_uninstall(layout, args):
    if WINDOWS:
        uninstaller = os.path.join(layout.home, "uninstall.exe")
        return subprocess.run([uninstaller]).returncode if os.path.exists(uninstaller) else ERROR
    if os.geteuid() != 0:
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
    for folder in ("runtime", "app", "service"):
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
    "logs": cmd_logs, "version": cmd_version, "uninstall": cmd_uninstall, "_init-env": cmd_init_env,
}


def main(argv):
    layout = Layout(home_from_here())
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return OK if argv else USAGE
    name, args = argv[0], argv[1:]
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
    return command(layout, args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
