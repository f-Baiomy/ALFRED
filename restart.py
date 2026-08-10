#!/usr/bin/env python3
"""
restart.py - rebuild and restart the Alfred stack (or a single service).

Runs "docker compose down" followed by "docker compose up -d --build" from
this project's folder. Does NOT touch the hosts file or certificate trust -
use start.py for that. Safe to run any time containers are running or
stopped.

If you changed proxy's port/IP mapping in docker-compose.yml (the "ports:"
line), this alone is NOT enough - your hosts file's "-proxy" entries still
point at whatever address they had before, and won't match the new one
until you re-run start.py (which fixes stale entries in place, not just
adds missing ones).

Usage:
    python3 restart.py                 restart every service (proxy, backend, frontend)
    python3 restart.py backend      restart/rebuild just one service
    python3 restart.py frontend backend  restart/rebuild multiple named services
"""

import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COMPOSE_FILE = os.path.join(SCRIPT_DIR, "docker-compose.yml")
SUPPLIERS_FILE = os.path.join(SCRIPT_DIR, "suppliers.txt")
HOSTS_FILE = (
    r"C:\Windows\System32\drivers\etc\hosts" if os.name == "nt" else "/etc/hosts"
)


def run(cmd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def _proxy_bind_ip():
    """Best-effort scrape of proxy's host-side bind IP from the "ports:" mapping
    in docker-compose.yml, e.g. "127.0.0.2:443:8080" -> "127.0.0.2". A plain
    "8444:8080" (no IP) means it's bound to all interfaces - nothing to check
    against a specific IP in that case. Returns None if it can't be determined -
    this check is a convenience, not something worth failing a restart over."""
    try:
        with open(COMPOSE_FILE, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None

    proxy_block = re.search(r"^\s*proxy:.*?(?=^\s{2}\S|\Z)", text, re.MULTILINE | re.DOTALL)
    if not proxy_block:
        return None

    port_line = re.search(r'-\s*"(\d+\.\d+\.\d+\.\d+):\d+:\d+"', proxy_block.group(0))
    return port_line.group(1) if port_line else None


def warn_if_hosts_entries_are_stale():
    """Flags (never fixes - that's start.py's job) any "-proxy" hosts entry whose
    IP doesn't match proxy's current docker-compose.yml bind IP. This is exactly
    the failure mode of changing proxy's port/IP mapping without re-running
    start.py afterward: requests silently go nowhere instead of erroring loudly."""
    target_ip = _proxy_bind_ip()
    if not target_ip or not os.path.isfile(SUPPLIERS_FILE) or not os.path.isfile(HOSTS_FILE):
        return

    with open(SUPPLIERS_FILE, encoding="utf-8") as f:
        domains = [line.split("#", 1)[0].strip() for line in f]
    proxy_hosts = [f"{d}-proxy" for d in domains if d]

    with open(HOSTS_FILE, encoding="utf-8") as f:
        hosts_lines = f.readlines()

    stale = []
    for proxy_host in proxy_hosts:
        for line in hosts_lines:
            match = re.match(r"\s*(\S+)\s+" + re.escape(proxy_host) + r"\s*$", line)
            if match and match.group(1) != target_ip:
                stale.append((proxy_host, match.group(1)))
                break

    if stale:
        print()
        print(f"WARNING: proxy is configured to bind {target_ip}, but your hosts file still")
        print("points these \"-proxy\" entries somewhere else - requests to them will silently")
        print("fail to reach proxy:")
        for proxy_host, current_ip in stale:
            print(f"  {current_ip}  {proxy_host}  (expected {target_ip})")
        print("Re-run start.py (as Administrator/root) to fix these in place.")
        print()


def main():
    services = sys.argv[1:]

    if services:
        print(f"Restarting: {', '.join(services)}")
        run(["docker", "compose", "up", "-d", "--build"] + services)
    else:
        print("Restarting all services (down, then up --build)")
        run(["docker", "compose", "down"])
        run(["docker", "compose", "up", "-d", "--build"])

    warn_if_hosts_entries_are_stale()
    print("Done.")


if __name__ == "__main__":
    main()
