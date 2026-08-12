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
    python3 restart.py --wildfly-proxy [on|off]   also toggle an already-running WildFly JVM's
                                                   proxy - defaults to "on" if the on|off value
                                                   is omitted; see wildfly-proxy-toggle/README.md;
                                                   requires WILDFLY_HOME set in the environment.
                                                   Combinable with the above, e.g.:
                                                 python3 restart.py backend --wildfly-proxy on
"""

import os
import platform
import re
import socket
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COMPOSE_FILE = os.path.join(SCRIPT_DIR, "docker-compose.yml")
SUPPLIERS_FILE = os.path.join(SCRIPT_DIR, "suppliers.txt")
HOSTS_FILE = (
    r"C:\Windows\System32\drivers\etc\hosts" if os.name == "nt" else "/etc/hosts"
)


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
    """Same self-healing check as start.py - see its docstring. Also needed here (not just in
    start.py) since restart.py is a valid entry point on its own for rebuilding an already-running
    stack, and may run before start.py ever has on a fresh host."""
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


def _parse_args(argv):
    """Splits service names (positional) from the optional --wildfly-proxy [on|off] flag - a
    small hand-rolled parser rather than argparse, matching this script's existing plain
    sys.argv[1:] handling for service names. The on|off value is itself optional - bare
    "--wildfly-proxy" defaults to "on" - so a following token is only consumed as that value
    when it's actually "on"/"off"; anything else (e.g. a service name) is left for the
    positional branch below."""
    services = []
    wildfly_action = None
    i = 0
    while i < len(argv):
        if argv[i] == "--wildfly-proxy":
            if i + 1 < len(argv) and argv[i + 1] in ("on", "off"):
                wildfly_action = argv[i + 1]
                i += 2
            else:
                wildfly_action = "on"
                i += 1
        else:
            services.append(argv[i])
            i += 1
    return services, wildfly_action


def toggle_wildfly_proxy(action):
    """Invokes wildfly-proxy-toggle's proxy-on/proxy-off script for this OS (see its README) -
    this is a thin wrapper, not a reimplementation: WILDFLY_HOME (and optional CONTROLLER/
    PROXY_HOST/PROXY_PORT) must already be set in the environment this script itself runs in,
    since subprocess.run inherits it automatically; the underlying script validates and reports
    a clear error if it's missing rather than this wrapper duplicating that check."""
    toggle_dir = os.path.join(SCRIPT_DIR, "wildfly-proxy-toggle")
    if platform.system() == "Windows":
        cmd = [os.path.join(toggle_dir, f"proxy-{action}.bat")]
    else:
        cmd = ["bash", os.path.join(toggle_dir, f"proxy-{action}.sh")]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=toggle_dir)
    if result.returncode != 0:
        sys.exit(result.returncode)


def main():
    ensure_backend_port()
    services, wildfly_action = _parse_args(sys.argv[1:])

    if services:
        print(f"Restarting: {', '.join(services)}")
        run(["docker", "compose", "up", "-d", "--build"] + services)
    else:
        print("Restarting all services (down, then up --build)")
        run(["docker", "compose", "down"])
        run(["docker", "compose", "up", "-d", "--build"])

    warn_if_hosts_entries_are_stale()

    if wildfly_action:
        toggle_wildfly_proxy(wildfly_action)

    print("Done.")


if __name__ == "__main__":
    main()
