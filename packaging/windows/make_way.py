"""
make_way.py - run by the Windows installer on an upgrade, after it stopped the service and before it moves the old
runtime\\ and app\\ aside: stops every process still running one of the install's own programs (runtime\\java,
runtime\\python, runtime\\node), except itself.

Why: a process outside the service's tree outlived the service stop and kept app\\ busy - attach-cli, which the
supervisor starts as the app's owner with its working directory in app\\ (a process's working directory locks that
folder against a move). Attaching to a JVM paused in a debugger (WildFly with suspend=y) can wait for good. The
installer then could not move app\\, gave up with Alfred stopped, and nothing started it again (3.0.6 -> 3.0.7,
2026-10-09). An alfred window still open on the old runtime goes too: the files under it are being replaced.

The installer extracts this file to its own temporary folder and runs it with the OLD install's python, so it works
for an upgrade from any version. Standard library only. Prints one line per process it stopped; exit code 0 always -
the installer's move, with its retries, is the real check.

    python make_way.py <install folder>
"""

import os
import subprocess
import sys

LIST = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }"


def processes():
    """(pid, executable path) of every process whose path Windows reports."""
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", LIST],
                            capture_output=True, text=True, errors="replace", timeout=60,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    rows = []
    for line in result.stdout.splitlines():
        pid, _, path = line.partition("\t")
        if pid.strip().isdigit() and path.strip():
            rows.append((int(pid), path.strip()))
    return rows


def in_the_way(rows, home, me):
    """The processes running a program from <home>\\runtime or <home>\\app - never `me`."""
    folders = [os.path.normcase(os.path.join(os.path.abspath(home), d)) + os.sep for d in ("runtime", "app")]
    return [(pid, path) for pid, path in rows
            if pid != me and any(os.path.normcase(os.path.abspath(path)).startswith(f) for f in folders)]


def main(argv):
    if len(argv) != 1:
        print("usage: make_way.py <install folder>")
        return 0
    try:
        found = in_the_way(processes(), argv[0], os.getpid())
    except (OSError, subprocess.SubprocessError) as e:
        print(f"could not list the processes: {e}")
        return 0
    for pid, path in found:
        result = subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True, errors="replace")
        print(f"stopped pid {pid} ({path})" if result.returncode == 0 else
              f"could not stop pid {pid} ({path}): {(result.stdout + result.stderr).strip()}")
    if not found:
        print("nothing else runs the install's programs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
