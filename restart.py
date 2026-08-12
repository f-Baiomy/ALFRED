#!/usr/bin/env python3
"""
restart.py - rebuild and restart the Alfred stack (or a single service).

Runs "docker compose down" followed by "docker compose up -d --build" from
this project's folder. Does NOT touch certificate trust - use start.py for
that. Safe to run any time containers are running or stopped.

Also runs wildfly-proxy-toggle's proxy-on step automatically (on either OS)
- routes an already-running WildFly JVM's HTTPS traffic through the proxy
via the Java Attach API, auto-detecting the running instance. Non-fatal if
it fails (e.g. no WildFly running) - a convenience step, not required for
the restart itself to succeed. See wildfly-proxy-toggle/README.md.

Usage:
    python3 restart.py                 restart every service (proxy, backend, frontend)
    python3 restart.py backend      restart/rebuild just one service
    python3 restart.py frontend backend  restart/rebuild multiple named services
    python3 restart.py --wildfly-proxy off   turn the WildFly proxy off instead of on -
                                              combinable with the above, e.g.:
                                              python3 restart.py backend --wildfly-proxy off
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


def _parse_args(argv):
    """Splits service names (positional) from the optional --wildfly-proxy [on|off] flag - a
    small hand-rolled parser rather than argparse, matching this script's existing plain
    sys.argv[1:] handling for service names. The WildFly proxy toggle now runs automatically as
    a step on every restart - defaults to "on" even with no flag at all. A following token is
    only consumed as the on|off value when it's actually "on"/"off"; anything else (e.g. a
    service name) is left for the positional branch below."""
    services = []
    wildfly_action = "on"
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
    this is a thin wrapper, not a reimplementation: it auto-detects the running WildFly instance
    itself via the Java Attach API, prompting interactively if more than one is found. Requires
    JAVA_HOME to point at a JDK 8 install (needs tools.jar) in the environment this script itself
    runs in; WILDFLY_PID/PROXY_HOST/PROXY_PORT are picked up the same way if set, since
    subprocess.run inherits the environment automatically.

    Deliberately non-fatal - this is a convenience step layered onto restart.py's main job of
    getting the stack back up, not something that should block it (e.g. a machine with no
    WildFly running at all shouldn't fail an otherwise-successful restart.py run)."""
    toggle_dir = os.path.join(SCRIPT_DIR, "wildfly-proxy-toggle")
    if platform.system() == "Windows":
        cmd = [os.path.join(toggle_dir, f"proxy-{action}.bat")]
    else:
        cmd = ["bash", os.path.join(toggle_dir, f"proxy-{action}.sh")]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=toggle_dir)
    if result.returncode != 0:
        print("WildFly proxy toggle failed (see above) - continuing anyway, since this is a")
        print("convenience step, not required for the restart itself to succeed.")


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

    print()
    print("=== Step: WildFly proxy ===")
    toggle_wildfly_proxy(wildfly_action)

    print("Done.")


if __name__ == "__main__":
    main()
