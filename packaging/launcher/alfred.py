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
    alfred skill install|remove|status       the /alfred-qa Claude Code skill (alfred_skill.py)

Exit codes: 0 ok, 1 error, 2 usage, 3 validation refused, 4 conflict, 5 not allowed.
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import term as termlib  # noqa: E402
from layout import WINDOWS, Layout, home_from_here  # noqa: E402

OK, ERROR, USAGE, REFUSED, CONFLICT, NOT_ALLOWED = 0, 1, 2, 3, 4, 5
SERVICE = "alfred"
START_SECONDS = 60      # how long start/restart wait for every process (contracts/cli.md: 60 s)
POLL_SECONDS = 0.3      # how often start/stop/update ask the local supervisor while they run - only while they run
STOP_SECONDS = 90       # how long stop/restart wait for a supervisor without a service to exit before killing it
INSTALL_SECONDS = 300   # how long `alfred update` waits for the new version to answer after the installer starts
# Windows: this process ran on runtime\python\python.exe, which the installer must move aside - an open CLI window
# (the panel, `alfred update` itself) locked it and the update stopped Alfred and failed. So once the installer runs,
# the CLI writes a PowerShell script that watches the rest, and exits with this code; alfred.cmd then runs the script.
HANDED_OFF = 75


def ui():
    """Colour, glyphs and live redraws for stdout, decided per call (tests redirect stdout: plain)."""
    return termlib.Term()


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
    """(exit code, what the service manager printed). Captured: its lines would tear through a live step list."""
    argv = [os.path.join(layout.home, "service", "alfred-service.exe"), action] if WINDOWS else ["systemctl", action, SERVICE]
    result = subprocess.run(argv, capture_output=True, text=True, errors="replace")
    return result.returncode, "\n".join(part for part in (result.stdout.strip(), result.stderr.strip()) if part)


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
    if not other:
        owner = port_owner(layout.ui_port(), layout)
        if owner and not owner["ours"]:
            lines.append(f"  Port {layout.ui_port()} is in use by {owner['name']} (pid {owner['pid']}).")
    lines.append("  Logs: alfred logs supervisor, alfred logs backend")
    return "\n".join(lines)


def port_owner(port, layout=None):
    """Who listens on a TCP port: {"name", "pid", "ours"} - ours when the program lives in this install - or None.
    netstat + tasklist on Windows, ss elsewhere; None when neither can tell."""
    home = os.path.normcase(os.path.realpath(layout.home)) if layout else None
    try:
        if WINDOWS:
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, errors="replace", timeout=10).stdout
            pid = next((int(cols[4]) for cols in (line.split() for line in out.splitlines())
                        if len(cols) == 5 and cols[3] == "LISTENING" and cols[1].rsplit(":", 1)[-1] == str(port)), None)
            if not pid:
                return None
            row = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                                 errors="replace", timeout=10).stdout.strip().split('","')
            name = row[0].strip('"') if row and row[0] else "a process"
            path = ""
            try:
                path = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid}).Path"],
                                      capture_output=True, text=True, timeout=10).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                pass
        else:
            out = subprocess.run(["ss", "-Hltnp", f"sport = :{port}"], capture_output=True, text=True, timeout=10).stdout
            line = out.strip().splitlines()[0] if out.strip() else ""
            match = re.search(r'\(\("([^"]+)",pid=(\d+)', line)
            if not match:
                return None
            name, pid = match.group(1), int(match.group(2))
            try:
                path = os.readlink(f"/proc/{pid}/exe")
            except OSError:
                path = ""
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None
    ours = bool(home and path and os.path.normcase(os.path.realpath(path)).startswith(home))
    return {"name": name, "pid": pid, "ours": ours}


def free_ports(start, count=3, limit=50):
    """The first `count` ports from `start` up that nothing listens on (bind test on all addresses)."""
    found = []
    for port in range(start, start + limit):
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", port))
            except OSError:
                continue
        found.append(port)
        if len(found) == count:
            break
    return found


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


def listen_text(t, process):
    """The first listener as shown in a row: "0.0.0.0:3000 (UI, API, /mcp)", "8081 → 8080 (odeysys)"."""
    listeners = process.get("listeners") or []
    return listeners[0].replace(" -> ", f" {t.g['arrow']} ") if listeners else ""


def follow_processes(layout, t, steps, deadline):
    """Rows for the supervisor's processes, ticked off as each comes up (the backend when THIS install's backend
    answers); True once everything runs, False at the deadline - a row still waiting then says why."""
    rows, last = {}, {}
    while True:
        status = call_supervisor(layout, "GET", "/status", timeout=2) or {}
        healthy = own_backend(layout, timeout=1)[0]
        processes = status.get("processes", [])
        for p in processes:
            name = p["name"].lower()
            last[name] = p
            row = rows.get(name)
            if row is None:
                row = rows[name] = steps.add(name)
            listen = listen_text(t, p)
            if p["state"] == "RUNNING" and (name != "backend" or healthy):
                row.done(f"{listen} {t.g['dot']} {termlib.duration(row.elapsed())}" if listen else termlib.duration(row.elapsed()))
            elif p["state"] == "CRASHED":
                row.fail(f"{listen} crashed" + (f" - {p['detail']}" if p["detail"] else ""))
            else:
                waiting = "starting" if p["state"] in ("RUNNING", "STOPPED") else p["state"].lower()
                note = f" {t.g['dot']} {p['detail']}" if p["detail"] and p["state"] == "RESTARTING" else ""
                row.run(f"{listen}  {waiting} {t.g['dot']} {int(row.elapsed())} s{note}".strip())
        # STOPPED is not an end state here: a process the supervisor has not started YET reports it too.
        if healthy and processes and all(p["state"] == "RUNNING" for p in processes):
            return True
        if any(p["state"] == "CRASHED" for p in processes) or time.monotonic() > deadline:
            for name, row in rows.items():
                p = last[name]
                if row.state in ("wait", "run"):
                    reason = p["detail"] or ("not answering" if name == "backend" else p["state"].lower())
                    row.fail(f"{listen_text(t, p)} {reason}".strip() + f" after {START_SECONDS} s" * (not p["detail"]))
            return False
        time.sleep(POLL_SECONDS)


def start_failure_hints(layout, t):
    """What to do when start did not come up: another Alfred on the port, the logs."""
    lines = []
    _, other = own_backend(layout)
    if other:
        lines.append("  " + t.warn(f"Port {layout.ui_port()} is answered by another Alfred: {other}."))
        lines.append(f"    This install ({layout.home}) cannot listen there. Use another port: "
                     + t.cmd(f"alfred config set ALFRED_UI_PORT <port>") + ", or stop that other install.")
    lines.append("  " + t.c("Details: ", "dim") + t.cmd("alfred logs supervisor") + t.c(", ", "dim") + t.cmd("alfred logs backend"))
    return lines


def cmd_start(layout, args):
    ensure_env(layout)
    t = ui()
    if not service_installed() and control(layout) and call_supervisor(layout, "GET", "/status"):
        t.print("  " + t.ok("Alfred is already running") + t.c(f" {t.g['dot']} ", "dim") + t.url(ui_addresses(layout)[0]))
        return OK
    began = time.monotonic()
    with t.steps(f"Starting Alfred {layout.version()}", label_width=10) as steps:
        if service_installed():
            row = steps.add("service").run('asking the system to start "alfred"')
            code, output = service(layout, "start")
            if code != 0:
                row.fail(f"the service did not start (exit code {code})", output.splitlines()[-3:])
                ok = False
            else:
                row.done(f"started {t.g['dot']} {termlib.duration(row.elapsed())}")
                ok = follow_processes(layout, t, steps, began + START_SECONDS)
        else:
            row = steps.add("supervisor").run("starting it in the background")
            log_file = open(os.path.join(layout.logs, "supervisor.out"), "ab")
            kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS} if WINDOWS \
                else {"start_new_session": True}
            subprocess.Popen([sys.executable, os.path.join(HERE, "supervisor.py")], cwd=layout.home, stdin=subprocess.DEVNULL,
                             stdout=log_file, stderr=subprocess.STDOUT, env=dict(os.environ, ALFRED_HOME=layout.home), **kwargs)
            row.done("started in the background")
            ok = follow_processes(layout, t, steps, began + START_SECONDS)
    if ok:
        t.print()
        t.print("  " + t.c(t.g["ok"] + " Alfred is up", "green", "bold") + t.c(f" in {termlib.duration(time.monotonic() - began)} {t.g['dot']} ", "dim")
                + t.c(f" {t.g['dot']} ", "dim").join(t.url(a) for a in ui_addresses(layout)))
        return OK
    t.print()
    for line in start_failure_hints(layout, t):
        t.print(line)
    t.print()
    t.print("  " + t.fail(t.c("Alfred did not start", "red", "bold")) + t.c(" · exit code 1", "dim"))
    return ERROR


def _zombie(pid):
    """Exited but not reaped (its parent - a container's init shell, say - never waits): gone for our purpose."""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        return False


def supervisor_gone(layout, pid, seconds):
    """Waits until the supervisor `pid` has exited and no longer answers. True when it is gone."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        alive = False
        if not WINDOWS:
            try:
                os.kill(pid, 0)
                alive = not _zombie(pid)
            except OSError:
                pass
        if not alive and call_supervisor(layout, "GET", "/status", timeout=1) is None:
            return True
        time.sleep(POLL_SECONDS or 0.05)
    return False


def stop_alfred(layout, t, title):
    """Stops Alfred with a row per process, each ticked off as the supervisor reports it stopped. True when stopped."""
    status = call_supervisor(layout, "GET", "/status", timeout=2) or {}
    processes = [p for p in status.get("processes", []) if p["state"] != "STOPPED"]
    if not processes and not service_installed() and not control(layout):
        return None  # nothing was running
    began = time.monotonic()
    with t.steps(title, label_width=10) as steps:
        rows = {p["name"]: steps.add(p["name"].lower()).run("stopping") for p in reversed(processes)}
        result = {}

        def stop():
            if service_installed():
                result["code"], result["output"] = service(layout, "stop")
                return
            info = control(layout)
            try:
                if info and WINDOWS:
                    subprocess.run(["taskkill", "/PID", str(info["pid"]), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                elif info:
                    os.kill(info["pid"], 15)
            except OSError:
                pass
            # SIGTERM only asks: the supervisor then stops its children one by one. Returning before it is gone made
            # `alfred restart` find it still answering ("already running") - and then it exited: Alfred stayed down.
            if info and not supervisor_gone(layout, info["pid"], STOP_SECONDS):
                try:
                    os.kill(info["pid"], 9)  # Windows: TerminateProcess
                except OSError:
                    pass
                supervisor_gone(layout, info["pid"], 5)
            result["code"], result["output"] = 0, ""

        worker = threading.Thread(target=stop, daemon=True)
        worker.start()
        while worker.is_alive():
            now = call_supervisor(layout, "GET", "/status", timeout=1) or {}
            for p in now.get("processes", []):
                row = rows.get(p["name"])
                if row and p["state"] == "STOPPED":
                    row.done("stopped")
            worker.join(POLL_SECONDS)
        if result.get("code"):
            for row in rows.values():
                row.fail("still running")
            failed = steps.add("service")
            failed.fail(f"the service did not stop (exit code {result['code']})", (result.get("output") or "").splitlines()[-3:])
            return False
        for row in rows.values():
            row.done("stopped")
        if service_installed():
            steps.add("service").done("stopped")
    t.print()
    t.print("  " + t.c(t.g["ok"] + " Alfred stopped", "green", "bold") + t.c(f" in {termlib.duration(time.monotonic() - began)}", "dim"))
    return True


def cmd_stop(layout, args):
    t = ui()
    stopped = stop_alfred(layout, t, f"Stopping Alfred {layout.version()}")
    if stopped is None:
        t.print("  " + t.c(t.g["wait"], "dim") + " Alfred is not running.")
        return OK
    if stopped:
        t.print("    " + t.c("start it again: ", "dim") + t.cmd("alfred start"))
    return OK if stopped else ERROR


def restart_proxies(layout, t):
    before = {p["name"]: p for p in (call_supervisor(layout, "GET", "/status") or {}).get("processes", [])}
    if call_supervisor(layout, "POST", "/restart/proxies") is None:
        t.print("  " + t.c(t.g["wait"], "dim") + " Alfred is not running " + t.c(f"{t.g['dot']} start it: ", "dim") + t.cmd("alfred start"))
        return ERROR
    names = [n for n in ("OUTBOUND", "REVERSE") if n in before]
    deadline = time.monotonic() + START_SECONDS
    with t.steps("Restarting the proxies", label_width=10) as steps:
        rows = {n: steps.add(n.lower()).run("restarting") for n in names}
        while any(r.state == "run" for r in rows.values()):
            now = {p["name"]: p for p in (call_supervisor(layout, "GET", "/status") or {}).get("processes", [])}
            for name, row in rows.items():
                p = now.get(name)
                if not p:
                    continue
                fresh = p["startedAt"] != before[name]["startedAt"] or p["restarts"] != before[name]["restarts"]
                if p["state"] == "RUNNING" and fresh:
                    row.done(f"{listen_text(t, p)} {t.g['dot']} up again {t.g['dot']} {termlib.duration(row.elapsed())}")
                elif p["state"] == "CRASHED":
                    row.fail(p["detail"] or "crashed")
                else:
                    row.detail(f"{p['state'].lower()} {t.g['dot']} {row.elapsed():.1f} s")
            if time.monotonic() > deadline:
                for row in rows.values():
                    row.fail(f"not back after {START_SECONDS} s")
                break
            time.sleep(POLL_SECONDS)
    failed = any(r.state == "fail" for r in rows.values())
    t.print()
    if failed:
        t.print("  " + t.fail(t.c("A proxy did not come back", "red", "bold")) + t.c(" · ", "dim") + t.cmd("alfred logs outbound") + t.c(", ", "dim") + t.cmd("alfred logs reverse"))
        return ERROR
    t.print("  " + t.c(t.g["ok"] + " Proxies restarted", "green", "bold") + t.c(" · the backend and the UI stayed up", "dim"))
    return OK


def cmd_restart(layout, args):
    t = ui()
    if "--proxies" in args:
        return restart_proxies(layout, t)
    began = time.monotonic()
    if stop_alfred(layout, t, f"Restarting Alfred {layout.version()}: stopping") is False:
        return ERROR
    code = cmd_start(layout, [])
    if code == OK:
        t.print("  " + t.c(f"restarted in {termlib.duration(time.monotonic() - began)}", "dim"))
    return code


def cmd_status(layout, args):
    t = ui()
    status = call_supervisor(layout, "GET", "/status")
    if not status:
        t.print("  " + t.brand(f"Alfred {layout.version()}") + "   " + t.state("STOPPED") + t.c(f" {t.g['dot']} {layout.home}", "dim"))
        t.print("    " + t.c("start it: ", "dim") + t.cmd("alfred start") + t.c("     why it stopped: ", "dim") + t.cmd("alfred logs supervisor"))
        return ERROR
    processes = status["processes"]
    oldest = min((p["startedAt"] for p in processes if p["pid"] and p["startedAt"]), default=None)
    t.print("  " + t.brand(f"Alfred {status['version']}") + "   "
            + (t.state("RUNNING") + t.c(f" {uptime(oldest)}", "dim") if oldest else t.state("STOPPED"))
            + t.c(f"   {layout.home} {t.g['dot']} supervisor pid {status['pid']}", "dim"))
    t.print()
    t.print("   " + t.c(f"{'PROCESS':<11}{'STATE':<13}{'PID':<8}{'UP':<11}LISTENS", "dim"))
    for p in processes:
        listeners = [l.replace(" -> ", f" {t.g['arrow']} ") for l in p["listeners"]]
        line = ("   " + f"{p['name'].lower():<11}" + termlib.pad(t.state(p["state"]), 13) + t.c(f"{p['pid'] or '-':<8}", "dim")
                + f"{uptime(p['startedAt']) if p['pid'] else '-':<11}" + (listeners[0] if listeners else ""))
        if p["restarts"]:
            line += "   " + t.c(f"{t.g['retry']} restarted {p['restarts']}x", "yellow")
        t.print(line)
        for listener in listeners[1:]:
            t.print(" " * 46 + listener)
        if p["detail"]:
            t.print(" " * 14 + (t.c(p["detail"], "red") if p["state"] == "CRASHED" else t.c(p["detail"], "dim")))
    t.print()
    t.print("   " + t.c("UI      ", "dim") + t.c(f"  {t.g['dot']}  ", "dim").join(t.url(a) for a in ui_addresses(layout)))
    update = update_line(layout, t)
    if update:
        t.print()
        t.print("   " + update)
    return OK


def update_line(layout, t=None):
    """One line when the running backend knows of a newer release (or a failed/in-progress install); else None."""
    t = t or termlib.Term(env={"NO_COLOR": "1"})
    try:
        with urllib.request.urlopen(layout.local_url() + "/server/update", timeout=3) as response:
            status = json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    job = status.get("job") or {}
    if job.get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
        return t.c(f"{t.g['up']} Update: Alfred {job.get('version')} is {job['state'].lower()}", "yellow", "bold") + t.c(" - Alfred restarts when it is done.", "dim")
    if job.get("state") == "PAUSED" and job.get("totalBytes"):
        return (t.c(f"{t.g['pause']} Update to {job.get('version')} paused at {job['downloadedBytes'] * 100 // job['totalBytes']}%", "yellow", "bold")
                + t.c(f" {t.g['dot']} ", "dim") + t.cmd("alfred update") + t.c(" continues · ", "dim") + t.cmd("alfred update --cancel") + t.c(" discards", "dim"))
    if job.get("state") == "FAILED":
        error = job.get("error") or ""
        return t.fail(f"Update: {error}" if "was put back" in error else
                      f"Update: the install of {job.get('version')} failed ({error}); the previous version was kept.")
    if len(status.get("releases") or []) > 1:
        return (t.c(f"{t.g['up']} {len(status['releases'])} newer releases, newest {status['latestVersion']}", "yellow", "bold")
                + t.c(" - choose with ", "dim") + t.cmd("alfred update"))
    if status.get("available"):
        return (t.c(f"{t.g['up']} Update available: Alfred {status['latestVersion']}", "yellow", "bold")
                + t.c(" - install it with ", "dim") + t.cmd("alfred update") + t.c(" or from the Settings tab.", "dim"))
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
LOG_LEVEL = re.compile(r"\b(ERROR|FATAL|SEVERE|WARN(?:ING)?|INFO|DEBUG|TRACE)\b")
LOG_TIME = re.compile(r"^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?|\d\d:\d\d:\d\d(?:[.,]\d+)?)")


def color_log_line(t, line):
    """The line exactly as in the file, with its timestamp dimmed and its level coloured - nothing cut or removed."""
    if not t.color:
        return line
    m = LOG_TIME.match(line)
    head, rest = (line[:m.end()], line[m.end():]) if m else ("", line)
    level = LOG_LEVEL.search(rest)
    if not level:
        return t.c(head, "dim") + rest
    word = level.group(1)
    style = ("red", "bold") if word in ("ERROR", "FATAL", "SEVERE") else ("yellow", "bold") if word.startswith("WARN") else ("blue",)
    body = rest[level.end():]
    if word in ("ERROR", "FATAL", "SEVERE"):
        body = t.c(body, "red")
    return t.c(head, "dim") + rest[:level.start()] + t.c(word, *style) + body


def cmd_logs(layout, args):
    t = ui()
    follow = "-f" in args
    names = [a for a in args if not a.startswith("-")]
    name = (names[0] if names else "supervisor").lower()
    path = os.path.join(layout.logs, LOG_ALIASES.get(name, name) + ".log")
    if not os.path.exists(path):
        known = sorted(os.path.splitext(n)[0] for n in os.listdir(layout.logs) if n.endswith(".log")) if os.path.isdir(layout.logs) else []
        print(f"No log yet: {path}" + (f"\n  logs here: {', '.join(known)}" if known else ""))
        return ERROR
    if t.live:
        t.print("  " + t.brand(os.path.basename(path), f"{path} {t.g['dot']} last 200 lines" + (f", then live {t.g['dot']} Ctrl+C to stop" if follow else "")))
        t.print()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f.readlines()[-200:]:
                print(color_log_line(t, line.rstrip("\n")) if t.color else line, end="\n" if t.color else "")
            while follow:
                line = f.readline()
                if line:
                    print(color_log_line(t, line.rstrip("\n")) if t.color else line, end="\n" if t.color else "", flush=True)
                else:
                    time.sleep(0.5)
    except KeyboardInterrupt:
        print()
        t.print("  " + t.c(f"stopped following {os.path.basename(path)}", "dim"))
    return OK


def cmd_version(layout, args):
    print(layout.version())
    return OK


SKILL_USAGE = """alfred skill install [--project <folder>] [--force]   add the /alfred-qa skill to Claude Code
alfred skill remove  [--project <folder>]
alfred skill status  [--project <folder>]

Without --project the skill is installed for you in every project (~/.claude/skills); with it, only in that repo
(<folder>/.claude/skills - commit it to share it). Run it as yourself, not as Administrator/root: Claude Code reads
the skills of the account that runs it. Claude also needs Alfred's MCP server:
  claude mcp add --transport http alfred <Alfred's address>/mcp"""


def cmd_skill(layout, args):
    """The Claude Code skill shipped in app/skills (alfred_skill.py does the copying, shared with setup_mcp.py)."""
    if not args or args[0] in ("-h", "--help", "help") or args[0] not in ("install", "remove", "status"):
        print(SKILL_USAGE)
        return OK if args and args[0] in ("-h", "--help", "help") else USAGE
    action, rest = args[0], args[1:]
    project, force = None, False
    i = 0
    while i < len(rest):
        if rest[i] == "--project" and i + 1 < len(rest):
            project = rest[i + 1]
            i += 2
        elif rest[i] == "--force":
            force = True
            i += 1
        else:
            print(f"alfred skill: unknown option {rest[i]}\n\n{SKILL_USAGE}", file=sys.stderr)
            return USAGE
    if project is not None and not os.path.isdir(project):
        print(f"alfred skill: no folder {project}", file=sys.stderr)
        return USAGE
    sys.path.insert(0, layout.app)
    import alfred_skill  # noqa: E402 - lives in app/ in an install
    scope = "project" if project else "user"
    try:
        if action == "install":
            lines = alfred_skill.install(os.path.join(layout.app, "skills"), scope, project, layout.version(), force)
        elif action == "remove":
            lines = alfred_skill.remove(scope, project)
        else:
            lines = alfred_skill.status(scope, project)
    except (OSError, ValueError) as e:
        print(f"alfred skill {action}: {e}", file=sys.stderr)
        return ERROR
    for line in lines:
        print(line)
    if action == "install":
        try:
            address = ui_addresses(layout)[0]
        except (OSError, ValueError):
            address = "http://localhost:3000"  # .env unreadable for this account: the default address
        print(f"Use it in Claude Code: /alfred-qa listen <cycle> | fix | verify <cycle> | resume. "
              f"Alfred's MCP server must be registered: claude mcp add --transport http alfred {address}/mcp")
    return CONFLICT if any(line.startswith("skipped") for line in lines) else OK


def backend_json(layout, method, path, timeout=30, body=None):
    """A call to THIS install's running backend, as the OS user (the identity check of own_backend first)."""
    ok, other = own_backend(layout)
    if not ok:
        raise SystemExit("Alfred is not running here" + (f" (another Alfred answers on its port: {other})" if other else "")
                         + " - start it with 'alfred start'; updates are checked and installed by the running Alfred.")
    import getpass
    data = json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None)
    request = urllib.request.Request(layout.local_url() + path, method=method, data=data,
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


def describe_update(status, t=None):
    t = t or termlib.Term(env={"NO_COLOR": "1"})
    lines = []
    job = status.get("job") or {}
    if status.get("mode") == "OFF":
        lines.append(t.c(t.g["wait"], "dim") + " Update checks are off (ALFRED_UPDATE_MODE=off).")
    elif status.get("available"):
        size = status.get("sizeBytes") or 0
        lines.append(t.c(t.g["up"], "yellow", "bold") + " " + t.c(f"Update available: Alfred {status['latestVersion']}", "white", "bold")
                     + t.c(f" (running {status['currentVersion']}, {size // (1024 * 1024)} MB)"
                           + (f", released {status['publishedAt']}" if status.get("publishedAt") else ""), "dim"))
        if status.get("notes"):
            lines.append("  " + t.c(status["notes"].strip().replace("\n", "\n  "), "dim"))
    elif status.get("error"):
        lines.append(t.fail(f"Update check failed: {status['error']}"))
    elif status.get("latestVersion"):
        lines.append(t.ok(f"Alfred {status['currentVersion']} is up to date") + t.c(f" (newest release {status['latestVersion']}).", "dim"))
    else:
        lines.append(t.c(t.g["wait"], "dim") + " No update check has run yet.")
    if job.get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
        lines.append(t.c(f"An update to {job.get('version')} is {job['state'].lower()}"
                         + (f" ({job['downloadedBytes'] // (1024 * 1024)} of {job['totalBytes'] // (1024 * 1024)} MB)"
                            if job["state"] == "DOWNLOADING" and job.get("totalBytes") else "") + ".", "yellow"))
    elif job.get("state") == "FAILED":
        lines.append(t.fail(f"The last update ({job.get('version')}) failed: {job.get('error')}. The previous version was kept."))
    if status.get("checkedAt"):
        lines.append(t.c(f"Checked {status['checkedAt']} from {status.get('feedUrl', '')}.", "dim"))
    return "\n".join(lines)


def interactive():
    """Someone at a terminal who can answer a question (never in a pipe, CI, or the installers' capture)."""
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def ask(t, prompt, choices, default):
    """One key from `choices` (Enter = `default`); `default` when nobody can answer or input ends."""
    if not interactive():
        return default
    try:
        answer = input("    " + t.c(prompt, "dim")).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return default
    return answer if answer in choices else default


def can_hand_off():
    """True when alfred.cmd started this process and runs a follow-up script after it (see HANDED_OFF)."""
    return WINDOWS and bool(os.environ.get("ALFRED_FOLLOW_SCRIPT"))


def _ps_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def follow_script(url, version, old_version, home, seconds=INSTALL_SECONDS, reopen=False):
    """The PowerShell that follows an update after the CLI exited: waits for Alfred to go down and for the new version
    to answer on `url`, or for the old one to be back (the installer put it back - /server/update says why). With
    `reopen` it opens the panel again from the NEW install's alfred.cmd. Exit code 0 = updated, 1 = not."""
    return "\r\n".join([
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Remove-Item -LiteralPath $PSCommandPath -Force",
        f"$url = {_ps_text(url)}; $version = {_ps_text(version)}; $old = {_ps_text(old_version)}",
        f"$alfredHome = {_ps_text(home)}; $seconds = {int(seconds)}; $reopen = {'$true' if reopen else '$false'}",
        "$began = Get-Date; $down = $false; $backAt = $null; $outcome = 'timeout'; $why = ''",
        "Write-Host \"  This window let go of Alfred's files so the installer can replace them.\"",
        "while (((Get-Date) - $began).TotalSeconds -lt $seconds) {",
        "  $n = [int]((Get-Date) - $began).TotalSeconds",
        "  $status = $null",
        "  try { $status = Invoke-RestMethod -Uri \"$url/server/status\" -TimeoutSec 2 } catch { }",
        "  if ($null -eq $status) {",
        "    $down = $true",
        "    Write-Host -NoNewline \"`r  - Installing      Alfred stopped, its files are replaced - $n s   \"",
        "  } elseif ($status.version -eq $version) {",
        "    $outcome = 'ok'; break",
        "  } else {",
        "    $job = $null",
        "    try { $job = (Invoke-RestMethod -Uri \"$url/server/update\" -TimeoutSec 2).job } catch { }",
        "    if ($job -and $job.state -eq 'FAILED') { $outcome = 'failed'; $why = $job.error; break }",
        "    if ($down) {",
        "      if ($null -eq $backAt) { $backAt = Get-Date }",
        "      if (((Get-Date) - $backAt).TotalSeconds -gt 15) {",
        "        $outcome = 'failed'; $why = \"Alfred $old answers again: the installer put it back.\"; break",
        "      }",
        "    }",
        "    Write-Host -NoNewline \"`r  - Installing      waiting for the installer to stop Alfred $old - $n s   \"",
        "  }",
        "  Start-Sleep -Seconds 1",
        "}",
        "$n = [int]((Get-Date) - $began).TotalSeconds",
        "Write-Host ''",
        "if ($outcome -eq 'ok') {",
        "  Write-Host \"  + Alfred $version is running - updated in $n s - $url\" -ForegroundColor Green",
        "} elseif ($outcome -eq 'failed') {",
        "  Write-Host \"  x The update did not finish: $why\" -ForegroundColor Red",
        "  Write-Host '    what the installer did: alfred logs update'",
        "} else {",
        "  Write-Host \"  x Alfred $version did not answer within $([int]($seconds / 60)) min\" -ForegroundColor Red",
        "  Write-Host '    what the installer did: alfred logs update   start it: alfred start'",
        "}",
        "if ($reopen -and $outcome -ne 'timeout') { & (Join-Path $alfredHome 'alfred.cmd'); exit $LASTEXITCODE }",
        "if ($outcome -eq 'ok') { exit 0 } else { exit 1 }",
        "",
    ])


def hand_off(layout, version, old_version, reopen=False):
    """Writes the follow-up script where alfred.cmd looks for it; the caller then exits with HANDED_OFF."""
    with open(os.environ["ALFRED_FOLLOW_SCRIPT"], "w", encoding="utf-8-sig", newline="") as f:
        f.write(follow_script(layout.local_url(), version, old_version, layout.home, reopen=reopen))
    return HANDED_OFF


def follow_update(layout, t, version, size, old_version=None):
    """Watches the supervisor's update job to the end: download (bar, speed, time left), checksum, install, and the
    new version answering. Returns "ok", "failed" (the job failed, or the new version did not start and the old one
    was put back - the job then says why), "paused", "cancelled", or None when there is no supervisor to follow.
    Ctrl+C while downloading asks: pause (keep the pieces), cancel (delete them), or go on."""
    old_version = old_version or layout.version()
    with t.steps(f"Installing Alfred {version}", label_width=14) as steps:
        download, verify = steps.add("Downloading"), steps.add("Checksum")
        install, answer = steps.add("Installing"), steps.add(f"Alfred {version}")
        samples, deadline, seen_job = [], None, False
        while True:
            try:
                job = call_supervisor(layout, "GET", "/update", timeout=2)
                state = (job or {}).get("state")
                if job and job.get("version") not in (None, "", version) and state != "FAILED":
                    state = None if install.state == "run" else state
                if state == "IDLE" and install.state == "run":
                    state = None  # the supervisor after the installer has no job yet: not a cancel - who answers says
                seen_job = seen_job or state in ("DOWNLOADING", "VERIFYING", "INSTALLING")
                if state == "DOWNLOADING":
                    got, total = job["downloadedBytes"], job["totalBytes"] or size or 0
                    now = time.monotonic()
                    samples = [s for s in samples if now - s[0] < 5] + [(now, got)]
                    rate = (samples[-1][1] - samples[0][1]) / max(0.5, samples[-1][0] - samples[0][0])
                    left = f" {t.g['dot']} {int((total - got) / rate)} s left" if rate > 0 and total else ""
                    fraction = got / total if total else 0
                    resumed = f" {t.g['dot']} resumed at {job['resumedBytes'] // 1048576} MB" if job.get("resumedBytes") else ""
                    download.run(t.bar(fraction) + f" {fraction * 100:3.0f}%  {got // 1048576} of {total // 1048576} MB"
                                 + (f" {t.g['dot']} {rate / 1048576:.1f} MB/s" if rate > 0 else "") + left + resumed)
                elif state == "PAUSED":
                    download.warn(f"paused at {job['downloadedBytes'] // 1048576} of {(job['totalBytes'] or size) // 1048576} MB"
                                  " - the pieces are kept")
                    return "paused"
                elif state == "IDLE" and seen_job:
                    download.fail("cancelled - what was downloaded is deleted")
                    return "cancelled"
                elif state == "VERIFYING":
                    if job.get("cached"):
                        download.done(f"{t.c('already here', 'teal')} {t.g['dot']} from the download cache, no download")
                    else:
                        download.done(f"{(job.get('totalBytes') or size) // 1048576} MB {t.g['dot']} {termlib.duration(download.elapsed())}"
                                      + (f" {t.g['dot']} {job['resumedBytes'] // 1048576} MB were already here" if job.get("resumedBytes") else ""))
                    verify.run("sha256")
                elif state == "INSTALLING" or (state is None and install.state == "run"):
                    download.done(f"{(size or 0) // 1048576} MB" if not (job or {}).get("cached") else "from the download cache")
                    verify.done("matches the release")
                    if can_hand_off():
                        install.done("the installer runs - this window lets go of Alfred's files")
                        return "handoff"
                    install.run(f"Alfred stops here, its files are replaced {t.g['dot']} {int(install.elapsed())} s")
                    deadline = deadline or time.monotonic() + INSTALL_SECONDS
                    if state is None:  # the installer stopped the old Alfred; wait for the new one
                        if own_backend(layout, timeout=1)[0]:
                            if layout.version() == version:
                                install.done(termlib.duration(install.elapsed()))
                                answer.done("answers")
                                return "ok"
                            # The old version answers again: the installer put it back (failed-start.txt says why).
                            back, until = {}, time.monotonic() + 10  # its supervisor may need a moment to say why
                            while time.monotonic() < until:
                                back = call_supervisor(layout, "GET", "/update", timeout=2) or {}
                                if back.get("state") == "FAILED":
                                    break
                                time.sleep(POLL_SECONDS or 0.05)
                            if back.get("state") == "FAILED" or layout.version() == old_version:
                                install.done(termlib.duration(install.elapsed()))
                                answer.fail("did not start", [t.c(back.get("error") or
                                            f"Alfred {old_version} answers again: the installer put it back.", "dim")])
                                return "failed"
                        if time.monotonic() > deadline:
                            install.fail(f"Alfred {version} did not answer within {INSTALL_SECONDS // 60} min",
                                         [t.c("what the installer did: ", "dim") + t.cmd("alfred logs update")])
                            return "failed"
                elif state == "FAILED":
                    failed = next(s for s in (download, verify, install) if s.state != "ok")
                    failed.fail(job.get("error") or "failed", [t.c("Alfred keeps running the version it had.", "dim")])
                    return "failed"
                elif state is None and download.state == "wait":
                    return None  # no supervisor to follow (a backend without one): the caller says what happens next
                time.sleep(POLL_SECONDS)
            except KeyboardInterrupt:
                if install.state == "run":
                    install.detail("Installing can't be paused: Alfred is being replaced. About a minute.")
                    continue
                choice = halt_choice(layout, t, steps)
                if choice is None:
                    continue
                return choice


def halt_choice(layout, t, steps):
    """Ctrl+C during a download: pause (keep the pieces), cancel (delete them), or go on. None = go on."""
    if not interactive():
        backend_json(layout, "POST", "/server/update/pause")
        return "paused-asked"
    steps.stop.set()  # hold the live view still while the question is asked
    if steps.thread:
        steps.thread.join(1)
        steps.thread = None
        steps.term.stream.write("\x1b[?25h\n")
    t.print("  " + t.c("Stop the update?", "white", "bold"))
    t.print("    " + t.c("p", "white", "bold") + "  " + f"{'Pause':<9}" + t.c("stop now, keep what was downloaded · alfred update continues from there", "dim"))
    t.print("    " + t.c("c", "white", "bold") + "  " + f"{'Cancel':<9}" + t.c("stop now and delete what was downloaded · the next update starts over", "dim"))
    t.print("    " + t.c("↵" if t.unicode else "Enter", "white", "bold") + "  " + f"{'Continue':<9}" + t.c("keep downloading", "dim"))
    choice = ask(t, "choose: ", ("p", "c"), "")
    if choice == "p":
        backend_json(layout, "POST", "/server/update/pause")
        return "paused-asked"
    if choice == "c":
        backend_json(layout, "POST", "/server/update/cancel")
        return "cancelled-asked"
    # go on: a fresh live view below the question
    steps.stop.clear()
    steps.drawn = 0
    if steps.term.live:
        steps.term.stream.write("\x1b[?25l")
        steps.thread = threading.Thread(target=steps._animate, name="steps", daemon=True)
        steps.thread.start()
    return None


def wait_job(layout, *states, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        job = call_supervisor(layout, "GET", "/update", timeout=2) or {}
        if job.get("state") in states:
            return job
        time.sleep(POLL_SECONDS)
    return call_supervisor(layout, "GET", "/update", timeout=2) or {}


def choose_release(t, status, wanted):
    """Which release to install: --version, else - with more than one newer release and someone to ask - a menu,
    else the newest. A paused download is marked; choosing another release drops it."""
    releases = status.get("releases") or ([{"version": status["latestVersion"], "publishedAt": status.get("publishedAt", ""),
                                            "notes": status.get("notes", ""), "sizeBytes": status.get("sizeBytes", 0)}]
                                          if status.get("available") else [])
    if wanted:
        return wanted if any(r["version"] == wanted for r in releases) else None
    if len(releases) < 2 or not interactive():
        return releases[0]["version"] if releases else None
    job = status.get("job") or {}
    t.print()
    t.print("  " + t.c(f"{len(releases)} newer releases", "white", "bold"))
    for i, r in enumerate(releases, 1):
        note = (r.get("notes") or "").strip().split("\n")[0][:70]
        tag = t.c("  newest · recommended", "teal") if i == 1 else ""
        if job.get("state") == "PAUSED" and job.get("version") == r["version"] and job.get("totalBytes"):
            tag += t.c(f"  {t.g['pause']} paused here at {job['downloadedBytes'] * 100 // job['totalBytes']}%", "yellow")
        t.print(f"    {t.c(str(i), 'white', 'bold')}  {t.c(r['version'].ljust(8), 'white')}{t.c((r.get('publishedAt') or '')[:10].ljust(12), 'dim')}{note}{tag}")
    t.print("    " + t.c(f"Each installer brings everything up to its version: {releases[0]['version']} also contains the others.", "dim"))
    pick = ask(t, "choose [1], q = not now: ", tuple(str(i) for i in range(1, len(releases) + 1)) + ("q",), "1")
    if pick == "q":
        return ""
    return releases[int(pick) - 1]["version"]


def after_failed_start(layout, t, version):
    """The new version installed but did not start and the old one was put back. Offer: retry (the installer is in
    the cache, no download), another UI port then retry, or keep the running version."""
    if not interactive():
        t.print("  " + t.c("The installer is kept: ", "dim") + t.cmd("alfred update") + t.c(" tries again without downloading.", "dim"))
        return ERROR
    t.print()
    t.print("  " + t.c(f"{version} couldn't start. What now?", "white", "bold") + t.c("  (the installer is cached: no download needed)", "dim"))
    t.print("    " + t.c("r", "white", "bold") + "  " + f"{'Retry':<15}" + t.c("after you have fixed what it says", "dim"))
    t.print("    " + t.c("p", "white", "bold") + "  " + f"{'Another port':<15}" + t.c("pick a free UI port for Alfred, then retry", "dim"))
    t.print("    " + t.c("k", "white", "bold") + "  " + f"{'Keep ' + layout.version():<15}" + t.c("stop here · alfred update retries later from the cache", "dim"))
    choice = ask(t, "choose [k]: ", ("r", "p", "k"), "k")
    if choice == "k":
        return ERROR
    if choice == "p":
        ports = free_ports(layout.ui_port() + 1)
        t.print("    " + t.c("free ports nearby: ", "dim") + t.c(", ".join(map(str, ports)), "teal"))
        try:
            port = input("    " + t.c(f"UI port [{ports[0] if ports else ''}]: ", "dim")).strip() or (str(ports[0]) if ports else "")
        except (EOFError, KeyboardInterrupt):
            return ERROR
        if not port.isdigit():
            return ERROR
        import config_cli
        if config_cli.main(layout, "config", ["set", "ALFRED_UI_PORT", port]) != OK:
            return ERROR
        if cmd_restart(layout, []) != OK:
            return ERROR
    return cmd_update(layout, ["--version", version])


def cmd_update(layout, args):
    """alfred update [--check | --cancel | --version X]: read the feed now and say what it found; without --check also
    install it (the newest, or the one chosen). A paused download of the same release goes on where it stopped."""
    wanted, rest = None, list(args)
    from_panel = "--panel" in rest  # the panel's u key: after a handed-off install the panel opens again
    rest = [a for a in rest if a != "--panel"]
    if "--version" in rest:
        i = rest.index("--version")
        if i + 1 >= len(rest):
            print("usage: alfred update [--check | --cancel | --version X]", file=sys.stderr)
            return USAGE
        wanted = rest[i + 1]
        del rest[i:i + 2]
    if any(a not in ("--check", "--cancel") for a in rest):
        print("usage: alfred update [--check | --cancel | --version X]", file=sys.stderr)
        return USAGE
    t = ui()
    if "--cancel" in rest:
        backend_json(layout, "POST", "/server/update/cancel")
        job = wait_job(layout, "IDLE")
        t.print("  " + t.c(t.g["fail"], "white", "bold") + " " + t.c("Update cancelled", "white", "bold")
                + t.c(f" {t.g['dot']} what was downloaded is deleted {t.g['dot']} Alfred {layout.version()} keeps running", "dim")
                if job.get("state") == "IDLE" else t.fail("The update could not be cancelled: " + str(job.get("error") or job.get("state"))))
        return OK if job.get("state") == "IDLE" else ERROR
    status = backend_json(layout, "POST", "/server/update/check", timeout=60)
    t.print(describe_update(status, t))
    if "--check" in rest or not status.get("available"):
        return OK if not status.get("error") else ERROR
    if not status.get("canInstall"):
        t.print(t.fail("It cannot be installed from here right now" + (" - an update is already in progress." if (status.get("job") or {}).get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING") else ".")))
        return ERROR
    version = choose_release(t, status, wanted)
    if version == "":
        return OK
    if version is None:
        t.print(t.fail(f"Alfred {wanted} is not one of the newer releases the feed lists."))
        return ERROR
    job = status.get("job") or {}
    if job.get("state") == "PAUSED" and job.get("version") == version:
        t.print("  " + t.c(f"{t.g['pause']} Going on with the paused download", "yellow") + t.c(f" ({job['downloadedBytes'] // 1048576} MB already here)", "dim"))
    backend_json(layout, "POST", "/server/update/install", body={"version": version})
    size = next((r.get("sizeBytes", 0) for r in status.get("releases") or [] if r["version"] == version), status.get("sizeBytes") or 0)
    began, old = time.monotonic(), layout.version()
    outcome = follow_update(layout, t, version, size, old)
    if outcome == "handoff":
        return hand_off(layout, version, old, reopen=from_panel)
    if outcome == "paused-asked":
        job = wait_job(layout, "PAUSED", "IDLE")
        outcome = "paused" if job.get("state") == "PAUSED" else outcome
    if outcome == "cancelled-asked":
        job = wait_job(layout, "IDLE")
        outcome = "cancelled"
    t.print()
    if outcome is None:
        t.print(f"Installing Alfred {version}: the installer is downloaded, verified and run. Alfred stops and starts "
                "again in about a minute; 'alfred status' then shows the new version, 'alfred update --check' the outcome.")
        return OK
    if outcome == "ok":
        t.print("  " + t.c(f"{t.g['ok']} Alfred {version} is running", "green", "bold")
                + t.c(f" {t.g['dot']} updated in {termlib.duration(time.monotonic() - began)} {t.g['dot']} ", "dim") + t.url(ui_addresses(layout)[0]))
        return OK
    if outcome == "paused":
        job = call_supervisor(layout, "GET", "/update") or {}
        t.print("  " + t.c(f"{t.g['pause']} Update paused", "yellow", "bold")
                + t.c(f" at {job.get('downloadedBytes', 0) // 1048576} of {job.get('totalBytes', 0) // 1048576} MB {t.g['dot']} kept in {os.path.join(layout.data, 'updates')}", "dim"))
        t.print("    " + t.c("continue: ", "dim") + t.cmd("alfred update") + t.c("    discard: ", "dim") + t.cmd("alfred update --cancel"))
        return OK
    if outcome == "cancelled":
        t.print("  " + t.c(t.g["fail"] + " Update cancelled", "white", "bold") + t.c(f" {t.g['dot']} what was downloaded is deleted {t.g['dot']} Alfred {layout.version()} keeps running", "dim"))
        t.print("    " + t.c("the next ", "dim") + t.cmd("alfred update") + t.c(" starts from 0 MB", "dim"))
        return OK
    if layout.version() == old and own_backend(layout)[0]:
        return after_failed_start(layout, t, version)
    t.print("  " + t.fail(t.c("The update did not finish", "red", "bold")) + t.c(" · ", "dim") + t.cmd("alfred update --check") + t.c(" shows the outcome", "dim"))
    return ERROR


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


# ---------------------------------------------------------------------------------------------------------------------
# alfred doctor
# ---------------------------------------------------------------------------------------------------------------------

def tcp_answers(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except (OSError, ValueError):
        return False


def gb(n):
    return f"{n / 1073741824:.1f} GB"


def size_text(n):
    return gb(n) if n >= 1073741824 else f"{n / 1048576:.0f} MB"


def folder_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def doctor_checks(layout, t):
    """Each check: (label, "ok" | "warn" | "fail", detail, [fix hints]). Every one is read-only and quick; a check that
    cannot look says so (warn), it never guesses ok."""
    dot = t.g["dot"]
    checks = []
    status = call_supervisor(layout, "GET", "/status", timeout=3)
    running = bool(status)

    # 1. the processes
    if not status:
        checks.append(("Alfred runs", "fail", "no supervisor answers - Alfred is stopped",
                       [t.c("start it: ", "dim") + t.cmd("alfred start") + t.c("   why it stopped: ", "dim") + t.cmd("alfred logs supervisor")]))
    else:
        processes = status.get("processes", [])
        bad = [p for p in processes if p["state"] != "RUNNING"]
        oldest = min((p["startedAt"] for p in processes if p.get("pid") and p.get("startedAt")), default=None)
        if bad:
            checks.append(("Alfred runs", "fail", ", ".join(f"{p['name'].lower()} {p['state'].lower()}" + (f" ({p['detail']})" if p["detail"] else "") for p in bad),
                           [t.c("details: ", "dim") + t.cmd(f"alfred logs {bad[0]['name'].lower()}")]))
        else:
            restarts = sum(p.get("restarts", 0) for p in processes)
            checks.append(("Alfred runs", "warn" if restarts > 3 else "ok",
                           f"{len(processes)} process{'es' if len(processes) != 1 else ''} {dot} up {uptime(oldest)}" + (f" {dot} {restarts} restarts" if restarts else ""),
                           [t.c("why they restarted: ", "dim") + t.cmd("alfred logs supervisor")] if restarts > 3 else []))

    # 2. the UI port
    port = layout.ui_port()
    ok, other = own_backend(layout, timeout=2)
    if ok:
        checks.append((f"UI port {port}", "ok", "answered by this install", []))
    elif other:
        checks.append((f"UI port {port}", "fail", f"answered by another Alfred: {other}",
                       [t.c("use another port: ", "dim") + t.cmd("alfred config set ALFRED_UI_PORT <port>") + t.c(", or stop that install", "dim")]))
    else:
        owner = port_owner(port, layout)
        if owner and not owner["ours"]:
            checks.append((f"UI port {port}", "fail", f"in use by {owner['name']} (pid {owner['pid']})",
                           [t.c("stop it, or move Alfred: ", "dim") + t.cmd(f"alfred config set ALFRED_UI_PORT {(free_ports(port + 1, 1) or [port + 1])[0]}")]))
        else:
            checks.append((f"UI port {port}", "fail" if running else "warn", "nothing answers", [t.c("logs: ", "dim") + t.cmd("alfred logs backend")]))

    settings = {}
    try:
        settings = layout.settings()
    except Exception:  # noqa: BLE001 - a broken .env is reported by the Settings check, not as a traceback
        pass
    import alfred_settings

    # 3. the outbound proxy
    listen = settings.get("ALFRED_OUTBOUND_PROXY_LISTEN") or "127.0.0.2:443"
    try:
        host, proxy_port = alfred_settings.split_listen(listen)
    except ValueError:
        host, proxy_port = "127.0.0.2", 443
    if tcp_answers(host, proxy_port):
        checks.append((f"Outbound :{proxy_port}", "ok", f"listening on {host} {dot} Java apps reach it as http.proxyHost/https.proxyHost", []))
    elif running:
        owner = port_owner(proxy_port, layout)
        checks.append((f"Outbound :{proxy_port}", "fail", f"not listening on {host}" + (f" - {owner['name']} (pid {owner['pid']}) holds the port" if owner and not owner["ours"] else ""),
                       [t.c("move it: ", "dim") + t.cmd(f"alfred config set ALFRED_OUTBOUND_PROXY_LISTEN {host}:8443") + t.c(" · logs: ", "dim") + t.cmd("alfred logs outbound")]))

    # 4. each project's reverse proxy and its app
    projects = alfred_settings.parse_service_entries(settings.get("INTERNAL_CALL_SERVICES", ""))
    inbound_on = (settings.get("REVERSE_PROXY_ENABLED") or "false").lower() == "true"
    for p in projects:
        label = f"Reverse :{p['listen_port']}"
        app_up = tcp_answers("127.0.0.1", p["upstream_port"])
        proxy_up = tcp_answers("127.0.0.1", p["listen_port"])
        if not app_up:
            checks.append((label, "fail", f"{t.g['arrow']} {p['name']} :{p['upstream_port']}: nothing answers",
                           [t.c(f"start {p['name']}, or stop routing to it: ", "dim") + t.cmd(f"alfred project remove {p['name']}")]))
        elif not proxy_up and running and inbound_on:
            checks.append((label, "warn", f"{t.g['arrow']} {p['name']} :{p['upstream_port']} answers, but nothing listens on :{p['listen_port']}",
                           [t.c("logs: ", "dim") + t.cmd("alfred logs reverse")]))
        else:
            checks.append((label, "ok", f"{t.g['arrow']} {p['name']} :{p['upstream_port']} answers", []))

    # 5. the agent in each project's app
    agents = call_supervisor(layout, "GET", "/agents", timeout=3) if running else None
    for a in (agents if isinstance(agents, list) else (agents or {}).get("agents", []) if agents else []):
        name, state = a.get("project", "?"), a.get("state", "")
        if state == "ATTACHED":
            checks.append((f"Agent {name}", "ok", f"pid {a.get('pid')} {dot} {a.get('features') or 'loaded'}", []))
        elif state in ("FAILED", "NOT_A_JVM", "ELSEWHERE"):
            checks.append((f"Agent {name}", "warn", f"{state.lower().replace('_', ' ')}" + (f": {a['detail']}" if a.get("detail") else ""),
                           [t.c("try again: ", "dim") + t.cmd("alfred jvms") + t.c(", then ", "dim") + t.cmd("alfred attach <pid>")]))

    # 6. disk
    try:
        usage = shutil.disk_usage(layout.data)
        free_share = usage.free / usage.total if usage.total else 1
        data_size = folder_bytes(layout.data)
        detail = f"{gb(usage.free)} free ({free_share * 100:.0f}%) {dot} Alfred's data uses {size_text(data_size)}"
        if usage.free < 2 * 1073741824 or free_share < 0.05:
            checks.append(("Disk", "fail", detail, [t.c("lower a storage cap: ", "dim") + t.cmd("alfred config set ALFRED_CALLS_MAX_SIZE_BYTES 5GB")]))
        elif usage.free < 10 * 1073741824 or free_share < 0.10:
            checks.append(("Disk", "warn", detail, [t.c("lower a storage cap: ", "dim") + t.cmd("alfred config set ALFRED_CALLS_MAX_SIZE_BYTES 5GB")]))
        else:
            checks.append(("Disk", "ok", detail, []))
    except OSError as e:
        checks.append(("Disk", "warn", f"could not be read: {e}", []))

    # 7. storage, as the backend counts it
    if ok:
        try:
            stats = backend_json(layout, "GET", "/database/stats", timeout=10)
            files = stats.get("files", [])
            total = sum(f.get("sizeBytes", 0) for f in files)
            biggest = sorted(files, key=lambda f: f.get("sizeBytes", 0), reverse=True)[:3]
            checks.append(("Storage", "ok", f"{size_text(total)} in {len(files)} store{'s' if len(files) != 1 else ''} {dot} "
                           + ", ".join(f"{f['name']} {size_text(f.get('sizeBytes', 0))}" for f in biggest), []))
        except SystemExit as e:
            checks.append(("Storage", "warn", f"the backend did not say ({e})", []))

    # 8. updates
    if ok:
        try:
            update = backend_json(layout, "GET", "/server/update", timeout=10)
            job = update.get("job") or {}
            cache = os.path.join(layout.data, "updates")
            cached = folder_bytes(cache) if os.path.isdir(cache) else 0
            tail = f" {dot} download cache {size_text(cached)}" if cached else ""
            if job.get("state") == "FAILED":
                checks.append(("Updates", "warn", job.get("error") or "the last update failed", [t.c("try again: ", "dim") + t.cmd("alfred update")]))
            elif job.get("state") == "PAUSED":
                checks.append(("Updates", "ok", f"update to {job.get('version')} paused{tail}", [t.c("continue: ", "dim") + t.cmd("alfred update")]))
            elif update.get("error"):
                checks.append(("Updates", "warn", update["error"], []))
            elif update.get("available"):
                checks.append(("Updates", "ok", f"running {update.get('currentVersion')} {dot} {t.c(update.get('latestVersion', '') + ' available', 'yellow')}{tail}", []))
            else:
                checks.append(("Updates", "ok", f"running {update.get('currentVersion')}" + (" - the newest" if update.get("latestVersion") else " - not checked yet") + tail, []))
        except SystemExit as e:
            checks.append(("Updates", "warn", f"the backend did not say ({e})", []))

    # 9. settings
    problem = access_problem(layout, "doctor")
    if problem:
        checks.append(("Settings", "fail", problem.splitlines()[0], problem.splitlines()[1:]))
    else:
        edit_from = settings.get("ALFRED_SETTINGS_EDIT_FROM", "local")
        checks.append(("Settings", "ok", f".env readable {dot} {len(projects)} project{'s' if len(projects) != 1 else ''} {dot} edits allowed from: {edit_from}", []))
    return checks


def cmd_panel(layout, args):
    """The live control panel (packaging/launcher/panel.py); None when stdout is not a terminal."""
    import panel
    return panel.run(layout, sys.modules[__name__])


def cmd_doctor(layout, args):
    """alfred doctor [--json]: checks this install and machine, says what is wrong and how to fix it. Exit 1 when a
    check failed (warnings alone are 0)."""
    if any(a != "--json" for a in args):
        print("usage: alfred doctor [--json]", file=sys.stderr)
        return USAGE
    t = ui() if "--json" not in args else termlib.Term(env={"NO_COLOR": "1"})
    if "--json" in args:
        checks = doctor_checks(layout, t)
        print(json.dumps([{"check": label, "status": state, "detail": termlib.ANSI.sub("", detail),
                           "fix": [termlib.ANSI.sub("", h) for h in hints]} for label, state, detail, hints in checks], indent=2))
        return ERROR if any(c[1] == "fail" for c in checks) else OK
    with t.steps("Alfred doctor", label_width=16) as steps:
        row = steps.add("checking").run("processes, ports, projects, agent, disk, storage, updates, settings")
        checks = doctor_checks(layout, t)
        row.label = "checked"
        row.done(f"{len(checks)} checks")
        for label, state, detail, hints in checks:
            step = steps.add(label)
            {"ok": lambda: step.done(detail), "warn": lambda: step.warn(detail, hints), "fail": lambda: step.fail(detail, hints)}[state]()
    counts = {s: sum(1 for c in checks if c[1] == s) for s in ("ok", "warn", "fail")}
    t.print()
    t.print("  " + t.c(f"{counts['ok']} ok", "green") + t.c(" · ", "dim") + t.c(f"{counts['warn']} warning{'s' if counts['warn'] != 1 else ''}", "yellow")
            + t.c(" · ", "dim") + t.c(f"{counts['fail']} problem{'s' if counts['fail'] != 1 else ''}", "red")
            + t.c(f"   exit code {1 if counts['fail'] else 0} · ", "dim") + t.cmd("alfred doctor --json") + t.c(" for scripts", "dim"))
    return ERROR if counts["fail"] else OK


COMMANDS = {
    "run": cmd_run, "start": cmd_start, "stop": cmd_stop, "restart": cmd_restart, "status": cmd_status,
    "logs": cmd_logs, "version": cmd_version, "update": cmd_update, "uninstall": cmd_uninstall, "_init-env": cmd_init_env,
    "doctor": cmd_doctor, "panel": lambda layout, args: cmd_panel(layout, args) or USAGE,
    "_wait-health": cmd_wait_health, "_record-upgrade": cmd_record_upgrade, "skill": cmd_skill,
}


# Commands that work without reading data/ or .env. Every other one needs the account that may read them.
NO_DATA_NEEDED = {"version", "jvms", "skill"}


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


EXIT_CODES = "Exit codes: 0 ok, 1 error, 2 usage, 3 validation refused, 4 conflict, 5 not allowed."
HELP_GROUPS = [
    ("Run Alfred", [("panel", "", "the live control panel (also: just alfred, in a terminal)"),
                    ("start", "", "start Alfred (the service, when installed)"),
                    ("stop", "", "stop it"),
                    ("restart", "[--proxies]", "restart everything, or only the two proxies"),
                    ("status", "", "what runs, since when, the UI addresses"),
                    ("logs", "[name] [-f]", "backend, outbound, reverse, mcp, log_agent, supervisor (proxy = outbound)")]),
    ("Connect Java apps", [("jvms", "", "list the Java apps on this machine"),
                           ("attach", "<pid> [--db-capture on]", "log one app's calls, statements and log lines"),
                           ("detach", "<pid>", "let it go")]),
    ("Settings", [("config", "list | get | set <KEY> <value>", "settings in .env"),
                  ("project", "list | add | remove ...", "the projects the reverse proxy fronts")]),
    ("Claude", [("skill", "install | remove | status [--project F]", "the /alfred-qa QA skill for Claude Code")]),
    ("Look after it", [("doctor", "[--json]", "check processes, ports, projects, agent, disk, storage, updates"),
                       ("update", "[--check | --cancel | --version X]", "install a new release · Ctrl+C pauses or cancels"),
                       ("version", "", "the version here"),
                       ("uninstall", "[--keep-data]", "remove Alfred"),
                       ("run", "", "the supervisor in the foreground (what the service runs)")]),
]
PUBLIC_COMMANDS = [name for _, rows in HELP_GROUPS for name, _, _ in rows]


def render_help(layout):
    t = ui()
    info = control(layout)
    running = bool(info) and call_supervisor(layout, "GET", "/status", timeout=1) is not None
    head = "  " + t.brand(f"Alfred {layout.version()}") + "   " + (t.state("RUNNING") + t.c(f" {t.g['dot']} ", "dim") + t.url(ui_addresses(layout)[0])
                                                              if running else t.state("STOPPED"))
    lines = ["", head]
    for title, rows in HELP_GROUPS:
        lines += ["", "  " + t.c(title, "white", "bold")]
        lines += ["    " + t.c(f"{name:<10}", "white") + t.c(f"{usage:<34}", "teal") + t.c(what, "dim") for name, usage, what in rows]
    lines += ["", "  " + t.c("More: ", "dim") + t.cmd("alfred <command> --help") + t.c(f" {t.g['dot']} exit codes: ", "dim") + t.cmd("alfred help --codes"), ""]
    return "\n".join(lines)


def unknown_command(name):
    import difflib
    t = ui()
    close = difflib.get_close_matches(name, PUBLIC_COMMANDS, n=1, cutoff=0.6)
    print("  " + t.fail(f"No command {t.c(name, 'white', 'bold')}." + (f" Did you mean {t.c(close[0], 'teal', 'bold')}?" if close else "")))
    print("    " + (t.c("run: ", "dim") + t.cmd(f"alfred {close[0]}") + "     " if close else "") + t.c("all commands: ", "dim") + t.cmd("alfred help"))
    return USAGE


def main(argv):
    layout = Layout(home_from_here())
    if not argv and interactive() and access_problem(layout, "panel") is None:
        code = cmd_panel(layout, [])
        if code is not None:
            return code
    if not argv or argv[0] in ("-h", "--help", "help"):
        if argv[1:2] == ["--codes"]:
            print(EXIT_CODES)
            return OK
        print(render_help(layout))
        return OK if argv else USAGE
    name, args = argv[0], argv[1:]
    if name not in COMMANDS and name not in ("config", "project", "jvms", "attach", "detach"):
        return unknown_command(name)
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
    command = COMMANDS[name]
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
