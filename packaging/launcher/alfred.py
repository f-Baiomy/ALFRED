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
INSTALL_SECONDS = 300   # how long `alfred update` waits for the new version to answer after the installer starts


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
    if job.get("state") == "FAILED":
        return t.fail(f"Update: the install of {job.get('version')} failed ({job.get('error')}); the previous version was kept.")
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


def follow_update(layout, t, version, size):
    """Watches the supervisor's update job to the end: download (bar, speed, time left), checksum, install, and the
    new version answering. True when it runs; False when the job failed or the new version never answered."""
    with t.steps(f"Installing Alfred {version}", label_width=14) as steps:
        download, verify = steps.add("Downloading"), steps.add("Checksum")
        install, answer = steps.add("Installing"), steps.add(f"Alfred {version}")
        samples, deadline = [], None
        while True:
            job = call_supervisor(layout, "GET", "/update", timeout=2)
            state = (job or {}).get("state")
            if state == "DOWNLOADING":
                got, total = job["downloadedBytes"], job["totalBytes"] or size or 0
                now = time.monotonic()
                samples = [s for s in samples if now - s[0] < 5] + [(now, got)]
                rate = (samples[-1][1] - samples[0][1]) / max(0.5, samples[-1][0] - samples[0][0])
                left = f" {t.g['dot']} {int((total - got) / rate)} s left" if rate > 0 and total else ""
                fraction = got / total if total else 0
                download.run(t.bar(fraction) + f" {fraction * 100:3.0f}%  {got // 1048576} of {total // 1048576} MB"
                             + (f" {t.g['dot']} {rate / 1048576:.1f} MB/s" if rate > 0 else "") + left)
            elif state == "VERIFYING":
                download.done(f"{(job.get('totalBytes') or size) // 1048576} MB {t.g['dot']} {termlib.duration(download.elapsed())}")
                verify.run("sha256")
            elif state == "INSTALLING" or (state is None and install.state == "run"):
                download.done(f"{(size or 0) // 1048576} MB")
                verify.done("matches the release")
                install.run(f"Alfred stops here, its files are replaced {t.g['dot']} {int(install.elapsed())} s")
                deadline = deadline or time.monotonic() + INSTALL_SECONDS
                if state is None:  # the installer stopped the old Alfred; wait for the new one
                    if own_backend(layout, timeout=1)[0] and layout.version() == version:
                        install.done(termlib.duration(install.elapsed()))
                        answer.done("answers")
                        return True
                    if time.monotonic() > deadline:
                        install.fail(f"Alfred {version} did not answer within {INSTALL_SECONDS // 60} min",
                                     [t.c("what the installer did: ", "dim") + t.cmd("alfred logs update")])
                        return False
            elif state == "FAILED":
                failed = next(s for s in (download, verify, install) if s.state != "ok")
                failed.fail(job.get("error") or "failed", [t.c("Alfred keeps running the version it had.", "dim")])
                return False
            elif state is None and download.state == "wait":
                return None  # no supervisor to follow (a backend without one): the caller says what happens next
            time.sleep(POLL_SECONDS)


def cmd_update(layout, args):
    """alfred update [--check]: read the feed now and say what it found; without --check also install it."""
    if any(a not in ("--check",) for a in args):
        print("usage: alfred update [--check]", file=sys.stderr)
        return USAGE
    t = ui()
    status = backend_json(layout, "POST", "/server/update/check", timeout=60)
    t.print(describe_update(status, t))
    if "--check" in args or not status.get("available"):
        return OK if not status.get("error") else ERROR
    if not status.get("canInstall"):
        t.print(t.fail("It cannot be installed from here right now" + (" - an update is already in progress." if (status.get("job") or {}).get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING") else ".")))
        return ERROR
    backend_json(layout, "POST", "/server/update/install")
    version, began = status["latestVersion"], time.monotonic()
    try:
        outcome = follow_update(layout, t, version, status.get("sizeBytes") or 0)
    except KeyboardInterrupt:
        t.print()
        t.print("  " + t.c("Stopped watching; the update keeps going. ", "dim") + t.cmd("alfred status") + t.c(" shows how far it is.", "dim"))
        return OK
    t.print()
    if outcome is None:
        t.print(f"Installing Alfred {version}: the installer is downloaded, verified and run. Alfred stops and starts "
                "again in about a minute; 'alfred status' then shows the new version, 'alfred update --check' the outcome.")
        return OK
    if outcome:
        t.print("  " + t.c(f"{t.g['ok']} Alfred {version} is running", "green", "bold")
                + t.c(f" {t.g['dot']} updated in {termlib.duration(time.monotonic() - began)} {t.g['dot']} ", "dim") + t.url(ui_addresses(layout)[0]))
        return OK
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


EXIT_CODES = "Exit codes: 0 ok, 1 error, 2 usage, 3 validation refused, 4 conflict, 5 not allowed."
HELP_GROUPS = [
    ("Run Alfred", [("start", "", "start Alfred (the service, when installed)"),
                    ("stop", "", "stop it"),
                    ("restart", "[--proxies]", "restart everything, or only the two proxies"),
                    ("status", "", "what runs, since when, the UI addresses"),
                    ("logs", "[name] [-f]", "backend, outbound, reverse, mcp, log_agent, supervisor (proxy = outbound)")]),
    ("Connect Java apps", [("jvms", "", "list the Java apps on this machine"),
                           ("attach", "<pid> [--db-capture on]", "log one app's calls, statements and log lines"),
                           ("detach", "<pid>", "let it go")]),
    ("Settings", [("config", "list | get | set <KEY> <value>", "settings in .env"),
                  ("project", "list | add | remove ...", "the projects the reverse proxy fronts")]),
    ("Look after it", [("update", "[--check]", "check for a new release; without --check, install it"),
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
        lines += ["    " + t.c(f"{name:<10}", "white") + t.c(f"{usage:<31}", "teal") + t.c(what, "dim") for name, usage, what in rows]
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
