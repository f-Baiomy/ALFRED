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
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def main():
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
