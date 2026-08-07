#!/usr/bin/env python3
"""
restart.py - rebuild and restart the Alfred stack (or a single service).

Runs "docker compose down" followed by "docker compose up -d --build" from
this project's folder. Does NOT touch the hosts file or certificate trust -
use start.py for that. Safe to run any time containers are running or
stopped.

Usage:
    python3 restart.py                 restart every service (alfred, pennyworth, manor)
    python3 restart.py pennyworth      restart/rebuild just one service
    python3 restart.py manor pennyworth  restart/rebuild multiple named services
"""

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def main():
    services = sys.argv[1:]

    if services:
        print(f"Restarting: {', '.join(services)}")
        run(["docker", "compose", "up", "-d", "--build"] + services)
    else:
        print("Restarting all services (down, then up --build)")
        run(["docker", "compose", "down"])
        run(["docker", "compose", "up", "-d", "--build"])

    print("Done.")


if __name__ == "__main__":
    main()
