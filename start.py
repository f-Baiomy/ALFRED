#!/usr/bin/env python3
"""
start.py - cross-platform entry point.

Detects the OS and runs the matching script (start.sh on Linux/macOS,
start.ps1 on Windows), which updates the hosts file from suppliers.txt
and then runs "docker compose up -d".

Usage (same command on any OS):
    python3 start.py       (Linux/macOS - will re-exec itself with sudo if needed)
    python start.py        (Windows - run from an Administrator terminal)
"""

import os
import platform
import socket
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _port_is_free(port):
    # Deliberately no SO_REUSEADDR - on Windows that lets a socket bind right over another one
    # that's actively listening (unlike Linux, where it only allows reusing a TIME_WAIT socket),
    # which would make this always report "free" even with a real conflict (confirmed live).
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _backend_container_running():
    try:
        result = subprocess.run(
            ["docker", "compose", "ps", "-q", "backend"],
            cwd=SCRIPT_DIR, capture_output=True, text=True,
        )
    except FileNotFoundError:
        return False
    return bool(result.stdout.strip())


def ensure_backend_port():
    """Auto-picks a free BACKEND_PORT and writes .env if the default 5000 is already taken by
    something outside this project (confirmed live: gunicorn already listening on one deployment
    target) - skips entirely if a .env already exists (respects whatever port was chosen there,
    manually or by a prior run of this function) or if this project's own backend container is
    already up (its own binding would otherwise look like a false-positive conflict on an
    ordinary restart)."""
    env_file = os.path.join(SCRIPT_DIR, ".env")
    if os.path.exists(env_file) or _backend_container_running() or _port_is_free(5000):
        return

    port = 5000
    while not _port_is_free(port):
        port += 50
        if port > 5500:
            print("Port 5000 is in use and no free port was found nearby - set BACKEND_PORT manually in a .env file.")
            return

    with open(env_file, "w", encoding="utf-8") as f:
        f.write(f"BACKEND_PORT={port}\n")
    print(f"Port 5000 is already in use on this host - wrote .env with BACKEND_PORT={port}.")


def main():
    ensure_backend_port()
    system = platform.system()

    if system == "Windows":
        script = os.path.join(SCRIPT_DIR, "start.ps1")
        print(f"Detected Windows -> running {script}")
        print("(This must be run from an Administrator PowerShell/terminal.)")
        result = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", script]
        )
        sys.exit(result.returncode)

    elif system in ("Linux", "Darwin"):
        script = os.path.join(SCRIPT_DIR, "start.sh")
        print(f"Detected {system} -> running {script}")

        if os.geteuid() != 0:
            print("Root is required to edit /etc/hosts - re-running with sudo ...")
            result = subprocess.run(["sudo", "bash", script])
        else:
            result = subprocess.run(["bash", script])
        sys.exit(result.returncode)

    else:
        print(f"Unsupported OS: {system}")
        sys.exit(1)


if __name__ == "__main__":
    main()
