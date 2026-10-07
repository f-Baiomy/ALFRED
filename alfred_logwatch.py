"""Watched log folders for the Logs Explorer - shared by start.py, restart.py and stop.py.

settings.properties:
    logs_watch_dirs=name:path,name:path   folders Alfred listens on live (Logs > Watch a folder)
    logs_watch_mode=auto|events|agent     how changes are noticed

Both are overridable in .env (ALFRED_LOGS_WATCH_DIRS / ALFRED_LOGS_WATCH_MODE); like every other setting,
settings.properties only fills a gap in .env.

Each folder is mounted read-only into backend at /watch/<name> through docker-compose.override.yml.
How changes reach the backend - no timer either way:
  events  the backend is notified by the kernel (inotify). Linux hosts, or a log writer sharing a Docker volume.
  agent   Docker Desktop (Windows/macOS) passes no host change events into containers, so a small host
          program (log-agent/agent.py) receives the OS notifications and reports "file X changed" to the
          backend, which then reads the new bytes from its own mount. Started/stopped by these scripts.
  auto    agent on Windows/macOS, events on Linux.
"""

import os
import platform
import re
import secrets
import signal
import subprocess
import sys

import alfred_settings

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(SCRIPT_DIR, "log-agent", "agent.py")
AGENT_PID = os.path.join(SCRIPT_DIR, "log-agent", "agent.pid")
AGENT_LOG = os.path.join(SCRIPT_DIR, "log-agent", "agent.log")


def parse_dirs(value):
    """'name:path,name:path' -> [(name, path)] - see alfred_settings.parse_watch_dirs (shared with the native install)."""
    return alfred_settings.parse_watch_dirs(value)


def sync_env(env, settings):
    """Adopts the settings into .env (setdefault, like every other setting) and derives the effective mode."""
    env.setdefault("ALFRED_LOGS_WATCH_DIRS", settings.get("logs_watch_dirs", "").strip())
    env.setdefault("ALFRED_LOGS_WATCH_MODE", (settings.get("logs_watch_mode", "") or "auto").strip() or "auto")
    # The agent's shared secret: generated once, kept in .env (never committed).
    env.setdefault("ALFRED_LOGS_AGENT_SECRET", secrets.token_hex(24))
    # Derived every run (not adopted): what backend actually uses.
    env["ALFRED_LOGS_WATCH_MODE_RESOLVED"] = resolved_mode(env.get("ALFRED_LOGS_WATCH_MODE", "auto"))
    dirs = parse_dirs(env.get("ALFRED_LOGS_WATCH_DIRS", ""))
    if dirs:
        print(f"Watched log folders: {', '.join(f'{n} -> {p}' for n, p in dirs)} "
              f"(notified by: {env['ALFRED_LOGS_WATCH_MODE_RESOLVED']})")


def resolved_mode(mode):
    mode = (mode or "auto").strip().lower()
    if mode in ("events", "agent"):
        return mode
    return "events" if platform.system() == "Linux" else "agent"


def _selinux():
    return platform.system() == "Linux" and os.path.exists("/sys/fs/selinux/enforce")


def override_lines(env):
    """docker-compose.override.yml lines mounting each watched folder into backend (read-only)."""
    dirs = parse_dirs(env.get("ALFRED_LOGS_WATCH_DIRS", ""))
    if not dirs:
        return []
    lines = []
    for name, path in dirs:
        source = path if os.path.isabs(path) or re.match(r"^[A-Za-z]:[\\/]", path) else os.path.normpath(os.path.join(SCRIPT_DIR, path))
        if not os.path.isdir(source):
            # Compose refuses a bind mount whose source is missing - and would not start backend at all.
            print(f"Watched log folder '{name}' does not exist: {source} - not mounted (create it, then run restart.py)")
            continue
        lines += [
            "      - type: bind\n",
            f"        source: '{source.replace(chr(39), chr(39) * 2)}'\n",
            f"        target: /watch/{name}\n",
            "        read_only: true\n",
        ]
        if _selinux():
            # SELinux (RHEL/Fedora/CentOS) blocks container reads of host folders without a shared label.
            lines += ["        bind:\n", "          selinux: z\n"]
    return ["  backend:\n", "    volumes:\n"] + lines if lines else []


# ---------------------------------------------------------------- host agent

def _agent_pid():
    try:
        with open(AGENT_PID, encoding="utf-8") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def stop_agent():
    pid = _agent_pid()
    if pid is None:
        return
    try:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
        else:
            os.kill(pid, signal.SIGTERM)
        print(f"Stopped the log agent (pid {pid})")
    except OSError:
        pass
    try:
        os.remove(AGENT_PID)
    except OSError:
        pass


def _ensure_watchdog():
    try:
        import watchdog  # noqa: F401
        return True
    except ImportError:
        print("Installing the 'watchdog' package for the log agent (OS file-change notifications) ...")
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--user", "--quiet", "watchdog"])
        return r.returncode == 0


def ensure_agent(env):
    """Starts (or restarts) the host agent when the effective mode is 'agent' and folders are configured."""
    stop_agent()
    if env.get("ALFRED_LOGS_WATCH_MODE_RESOLVED") != "agent" or not parse_dirs(env.get("ALFRED_LOGS_WATCH_DIRS", "")):
        return
    if not _ensure_watchdog():
        print("Could not install 'watchdog' - watched folders will not update live. Install it with: "
              f"{sys.executable} -m pip install watchdog")
        return
    python = sys.executable
    if platform.system() == "Windows":
        pythonw = os.path.join(os.path.dirname(python), "pythonw.exe")
        python = pythonw if os.path.exists(pythonw) else python
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        proc = subprocess.Popen([python, AGENT], cwd=SCRIPT_DIR, creationflags=flags, close_fds=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc = subprocess.Popen([python, AGENT], cwd=SCRIPT_DIR, start_new_session=True, close_fds=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(AGENT_PID, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    print(f"Started the log agent (pid {proc.pid}) - OS change notifications for the watched folders. Log: {AGENT_LOG}")
