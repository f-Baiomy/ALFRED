"""End-to-end check that a native Alfred restarts and updates from a terminal (`alfred restart`, `alfred update`) and
from the web UI (the Server card's Restart and Install buttons) - and that an update never leaves it stopped.

Windows is where it broke (3.0.6 -> 3.0.7, 2026-10-09): a process outside the service - attach-cli, run as the app's
owner with its working directory in app\\ - kept app\\ from being moved; the installer gave up with Alfred stopped and
nothing started it again. A working directory locks a folder against a move; a running program's .exe does not.

The update's "installer" is a stand-in that does to the program files what the real one does (installer.nsi,
packaging/linux/installer-header.sh): stop Alfred, on Windows run the same make_way.py (stop what still runs the
install's programs), move runtime/ and app/ aside - trying again for 30 s and putting back what moved, like
installer.nsi -, put the "new" files in place (the same files with a new VERSION), start Alfred. When the folders
stay in use it starts the old version again and writes failed-start.txt, as installer.nsi does.

Windows (no service, no admin, ports no other Alfred on the machine uses), a copy of the staged install:
    python tests/e2e/restart_update_e2e.py [--stage build/stage/windows-x64] [--keep]
Linux, inside a container after the real installer (tests/e2e/run_in_container.sh):
    /opt/alfred/runtime/python/bin/python3 /e2e/restart_update_e2e.py --home /opt/alfred

Exit code 0 when every check passed."""

import argparse
import hashlib
import json
import locale
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

WINDOWS = os.name == "nt"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEW = "99.0.0"
ENCODING = locale.getpreferredencoding(False)
URL = "http://127.0.0.1:3000"

# Called the way the supervisor calls the real one: start "" /wait <installer> /S /DIR=<folder>. For a .cmd that is
# `cmd /K` - the window stays until `exit` (not `exit /b`) - and "=" splits arguments: /DIR is %2, the folder %3.
FAKE_INSTALLER_CMD = r"""@echo off
setlocal
set "DIR=%~3"
set "LOG=%DIR%\data\log\fake-installer.log"
set "PY=%DIR%\runtime\python\python.exe"
echo stopping Alfred>> "%LOG%"
"%PY%" "%DIR%\app\launcher\alfred.py" stop >> "%LOG%" 2>&1
"%PY%" "@@MAKEWAY@@" "%DIR%" >> "%LOG%" 2>&1
set /a TRIES=0
:again
set /a TRIES+=1
move "%DIR%\runtime" "%DIR%\runtime.previous" >nul 2>&1
move "%DIR%\app" "%DIR%\app.previous" >nul 2>&1
if not exist "%DIR%\runtime\" if not exist "%DIR%\app\" goto moved
if exist "%DIR%\runtime.previous\" if not exist "%DIR%\runtime\" move "%DIR%\runtime.previous" "%DIR%\runtime" >nul
if exist "%DIR%\app.previous\" if not exist "%DIR%\app\" move "%DIR%\app.previous" "%DIR%\app" >nul
echo try %TRIES%: in use>> "%LOG%"
if %TRIES% GEQ 15 goto inuse
if %TRIES%==5 "%PY%" "@@MAKEWAY@@" "%DIR%" >> "%LOG%" 2>&1
ping -n 3 127.0.0.1 >nul
goto again
:moved
echo moved runtime and app on try %TRIES%>> "%LOG%"
move "%DIR%\runtime.previous" "%DIR%\runtime" >nul
move "%DIR%\app.previous" "%DIR%\app" >nul
> "%DIR%\app\VERSION" echo @@NEW@@
"%PY%" "%DIR%\app\launcher\alfred.py" start >> "%LOG%" 2>&1
echo installed>> "%LOG%"
exit 0
:inuse
echo gave up: in use>> "%LOG%"
(echo @@NEW@@& echo its program files were in use - a program had its working folder inside the install.& echo not-installed)> "%DIR%\data\updates\failed-start.txt"
"%PY%" "%DIR%\app\launcher\alfred.py" start >> "%LOG%" 2>&1
exit 1
"""

# Called the way the supervisor calls the real one: sh <installer> --unattended --dir <folder>.
FAKE_INSTALLER_SH = r"""#!/bin/sh
DIR="$3"
LOG="$DIR/data/log/fake-installer.log"
echo "stopping Alfred" >> "$LOG"
"$DIR/alfred" stop >> "$LOG" 2>&1
mv "$DIR/runtime" "$DIR/runtime.previous" && mv "$DIR/app" "$DIR/app.previous" && echo "moved runtime and app on try 1" >> "$LOG"
mv "$DIR/runtime.previous" "$DIR/runtime"
mv "$DIR/app.previous" "$DIR/app"
echo "@@NEW@@" > "$DIR/app/VERSION"
"$DIR/alfred" start >> "$LOG" 2>&1
echo "installed" >> "$LOG"
"""

results = []


def step(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (" - " + str(detail)[-800:] if detail and not ok else ""), flush=True)
    results.append(bool(ok))
    return ok


def get(path, timeout=3):
    try:
        with urllib.request.urlopen(URL + path, timeout=timeout) as r:
            return json.load(r)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def post(path, body=None):
    request = urllib.request.Request(URL + path, data=json.dumps(body or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)


def wait(predicate, seconds=120):
    end = time.time() + seconds
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(1)
    return None


def version():
    return (get("/server/status") or {}).get("version")


def backend_pid():
    status = get("/server/status")
    return status and next((p["pid"] for p in status["processes"] if p["name"] == "BACKEND" and p["state"] == "RUNNING"), None)


def python(home):
    return os.path.join(home, "runtime", "python", "python.exe") if WINDOWS else os.path.join(home, "runtime", "python", "bin", "python3")


def alfred(home, *args, timeout=600, direct=False):
    """`alfred <args>` the way a user types it (alfred.cmd / the alfred script), or the bundled python on alfred.py
    directly - which on Windows is what every alfred window was before the fix: no hand-off."""
    if direct:
        argv = [python(home), os.path.join(home, "app", "launcher", "alfred.py")]
    else:
        argv = ["cmd.exe", "/c", os.path.join(home, "alfred.cmd")] if WINDOWS else [os.path.join(home, "alfred")]
    result = subprocess.run(argv + list(args), capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL,
                            cwd=tempfile.gettempdir())
    return result.returncode, (result.stdout + result.stderr).decode(ENCODING, errors="replace")


def publish_release(work):
    """A release feed (file: URL) listing NEW with the stand-in installer for this platform."""
    target = "windows-x64" if WINDOWS else "linux-x64"
    installer = os.path.join(work, f"alfred-setup-{NEW}-{target}." + ("cmd" if WINDOWS else "run"))
    with open(installer, "w", encoding="ascii", newline="\r\n" if WINDOWS else "\n") as f:
        text = FAKE_INSTALLER_CMD if WINDOWS else FAKE_INSTALLER_SH
        if WINDOWS:  # the installer extracts make_way.py next to itself; the stand-in uses the repo's copy
            make_way = os.path.join(work, "make_way.py")
            shutil.copy2(os.path.join(ROOT, "packaging", "windows", "make_way.py"), make_way)
            text = text.replace("@@MAKEWAY@@", make_way)
        f.write(text.replace("@@NEW@@", NEW))
    with open(installer, "rb") as f:
        data = f.read()
    url = "file:///" + installer.replace("\\", "/").lstrip("/")
    feed = {"version": NEW, "notes": "e2e", "publishedAt": "2026-10-09T00:00:00Z",
            "assets": {target: {"url": url, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}}}
    path = os.path.join(work, "latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(feed, f)
    return "file:///" + path.replace("\\", "/").lstrip("/")


def installer_done(home, seconds=180):
    """The stand-in installer has finished (its last line) - its own `alfred start` may still run after the new
    version answers, and the next step must not restart Alfred under it."""
    return wait(lambda: any(s in installer_log(home) for s in ("installed", "gave up")) and not installer_running(home), seconds)


def installer_running(home):
    if not WINDOWS:
        return False
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                          "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | ForEach-Object CommandLine"],
                         capture_output=True, text=True, errors="replace").stdout
    return "alfred-setup-" in out and home.lower() in out.lower()


def back_to(home, old):
    """Puts the old VERSION back and restarts, so the next update has something newer to install."""
    installer_done(home)
    with open(os.path.join(home, "app", "VERSION"), "w", encoding="utf-8") as f:
        f.write(old + "\n")
    log = os.path.join(home, "data", "log", "fake-installer.log")
    if os.path.exists(log):
        os.remove(log)
    alfred(home, "restart")
    return wait(lambda: version() == old, 120)


def installer_log(home):
    try:
        with open(os.path.join(home, "data", "log", "fake-installer.log"), encoding=ENCODING, errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def checks(home, old):
    code, out = alfred(home, "start")
    step("alfred start", code == 0 and wait(backend_pid, 120), out)

    # ---- restart from the terminal ------------------------------------------------------------------------------
    before = backend_pid()
    code, out = alfred(home, "restart")
    after = wait(backend_pid, 120)
    step("alfred restart: everything stops and comes back", code == 0 and after and after != before, out)
    code, out = alfred(home, "restart", "--proxies")
    step("alfred restart --proxies", code == 0 and "Proxies restarted" in out, out)

    # ---- restart from the web UI (the Server card's Restart button) -------------------------------------------
    before = backend_pid()
    status, body = post("/server/restart", {"what": "BACKEND"})
    after = wait(lambda: (lambda p: p if p and p != before else None)(backend_pid()), 120)
    step("web UI restart: the backend comes back with a new pid", status == 202 and after, body)

    # ---- update from the terminal ---------------------------------------------------------------------------------
    code, out = alfred(home, "update", "--version", NEW)
    installer_done(home)
    log = installer_log(home)
    step("alfred update: the installer moves runtime/ while the alfred window is open",
         "moved runtime and app on try" in log and "gave up" not in log, log)
    step(f"alfred update: Alfred {NEW} answers and the window says so",
         code == 0 and f"Alfred {NEW} is running" in out and wait(lambda: version() == NEW, 60), out)

    # ---- update from the web UI (the Server card's Install button) -----------------------------------------------
    step("back to the old version for the next update", back_to(home, old))
    post("/server/update/check")
    status, body = post("/server/update/install", {"version": NEW})
    step("web UI update accepted", status == 202, body)
    step(f"web UI update: Alfred {NEW} answers", wait(lambda: version() == NEW, 300), installer_log(home))

    if not WINDOWS:
        return
    app = os.path.join(home, "app")

    # ---- what broke 3.0.6 -> 3.0.7: one of the install's programs left running with its working folder in app/ -----
    # (attach-cli, started by the supervisor as the app's owner, waiting on a JVM paused in a debugger)
    step("back to the old version for the next update", back_to(home, old))
    hung = subprocess.Popen([python(home), "-c", "import time; time.sleep(900)"], cwd=app,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        post("/server/update/check")
        status, body = post("/server/update/install", {"version": NEW})
        installer_done(home)
        log = installer_log(home)
        step("a leftover program of the install is stopped and the folders move",
             f"stopped pid {hung.pid}" in log and "moved runtime and app on try" in log, log)
        step(f"... and Alfred {NEW} answers", wait(lambda: version() == NEW, 120), log)
    finally:
        hung.kill()

    # ---- a folder held by something that is not Alfred's: the update gives up, the old version runs again --------
    step("back to the old version for the next update", back_to(home, old))
    foreign = subprocess.Popen(["cmd.exe", "/c", "ping -n 900 127.0.0.1 >nul"], cwd=app,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        code, out = alfred(home, "update", "--version", NEW)
        installer_done(home)
        log = installer_log(home)
        step("app/ in use: the installer gives up after its tries", "gave up: in use" in log, log)
        step(f"app/ in use: Alfred {old} runs again - never left stopped", wait(lambda: version() == old, 120), out)
        job = (get("/server/update") or {}).get("job") or {}
        step("app/ in use: the update shows FAILED, with the reason",
             job.get("state") == "FAILED" and "was not installed" in (job.get("error") or ""), job)
        step("app/ in use: the alfred window says the update did not finish, and why",
             code != 0 and "was not installed" in out, f"exit {code}: {out}")
    finally:
        subprocess.run(["taskkill", "/PID", str(foreign.pid), "/T", "/F"], capture_output=True)


def main():
    global URL
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", default=os.path.join(ROOT, "build", "stage", "windows-x64"),
                        help="Windows: the staged install to copy and run")
    parser.add_argument("--home", help="an installed Alfred to use as it is (Linux container)")
    parser.add_argument("--port", type=int, default=3017 if WINDOWS else 3000)
    parser.add_argument("--keep", action="store_true", help="keep the copy of the install for a look afterwards")
    args = parser.parse_args()
    URL = f"http://127.0.0.1:{args.port}"
    work = tempfile.mkdtemp(prefix="alfred-e2e-")
    home = args.home
    if not home:
        home = os.path.join(work, "alfred")
        print(f"install copy: {home}", flush=True)
        shutil.copytree(args.stage, home)
    with open(os.path.join(home, "app", "VERSION"), encoding="utf-8") as f:
        old = f.read().strip()
    try:
        settings = [("ALFRED_UPDATE_URL", publish_release(work)), ("ALFRED_UPDATE_MODE", "check")]
        if not args.home:
            code, out = alfred(home, "_init-env", direct=True)
            assert code == 0, out
            settings += [("ALFRED_UI_PORT", str(args.port)), ("ALFRED_OUTBOUND_PROXY_LISTEN", "127.0.0.3:443")]
        for key, value in settings:
            code, out = alfred(home, "config", "set", key, value, direct=True)
            assert code == 0, out
        checks(home, old)
    finally:
        if args.home:
            back_to(home, old)
        else:
            alfred(home, "stop")
        if args.keep or args.home:
            print(f"kept: {home}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    print(f"{sum(results)}/{len(results)} passed", flush=True)
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
