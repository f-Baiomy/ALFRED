#!/usr/bin/env python3
"""
start.py - cross-platform entry point.

Detects the OS and runs the matching script (start.sh on Linux/macOS,
start.ps1 on Windows), which runs "docker compose up -d" and syncs the
proxy's CA cert into the OS/JDK trust stores.

Also runs wildfly-proxy-toggle's proxy-on step automatically (on either OS)
- routes an already-running WildFly JVM's HTTPS traffic through the proxy
via the Java Attach API, auto-detecting the running instance. Non-fatal if
it fails (e.g. no WildFly running) - a convenience step, not required for
Alfred's own stack to be up. See wildfly-proxy-toggle/README.md.

Usage (same command on any OS):
    python3 start.py       (Linux/macOS - will re-exec itself with sudo if needed)
    python start.py        (Windows - run from an Administrator terminal)
    python3 start.py --wildfly-proxy off   (turn the WildFly proxy off instead of on)
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


def _parse_wildfly_proxy_arg(args):
    """The WildFly proxy toggle now runs automatically as a step on every start - defaults to
    "on" even with no flag at all. Pass --wildfly-proxy off to turn it off instead (e.g. once
    you're done debugging); --wildfly-proxy [on] says so explicitly, same as the default."""
    if not args:
        return "on"
    if args[0] != "--wildfly-proxy":
        print("Usage: python3 start.py [--wildfly-proxy [on|off]]")
        sys.exit(1)
    if len(args) == 1:
        return "on"
    if len(args) == 2 and args[1] in ("on", "off"):
        return args[1]
    print("Usage: python3 start.py [--wildfly-proxy [on|off]]")
    sys.exit(1)


def toggle_wildfly_proxy(action):
    """Invokes wildfly-proxy-toggle's proxy-on/proxy-off script for this OS (see its README) -
    this is a thin wrapper, not a reimplementation: it auto-detects the running WildFly instance
    itself via the Java Attach API, prompting interactively if more than one is found. Requires
    JAVA_HOME to point at a JDK 8 install (needs tools.jar) in the environment this script itself
    runs in; WILDFLY_PID/PROXY_HOST/PROXY_PORT are picked up the same way if set, since
    subprocess.run inherits the environment automatically.

    Deliberately non-fatal - this is a convenience step layered onto start.py's main job of
    bringing Alfred's own stack up, not something that should block it (e.g. a machine with no
    WildFly running at all shouldn't fail an otherwise-successful start.py run)."""
    toggle_dir = os.path.join(SCRIPT_DIR, "wildfly-proxy-toggle")
    if platform.system() == "Windows":
        cmd = [os.path.join(toggle_dir, f"proxy-{action}.bat")]
    else:
        cmd = ["bash", os.path.join(toggle_dir, f"proxy-{action}.sh")]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=toggle_dir)
    if result.returncode != 0:
        print("WildFly proxy toggle failed (see above) - continuing anyway, since this is a")
        print("convenience step, not required for Alfred's own stack to be up.")


def main():
    ensure_backend_port()
    wildfly_action = _parse_wildfly_proxy_arg(sys.argv[1:])
    system = platform.system()

    if system == "Windows":
        script = os.path.join(SCRIPT_DIR, "start.ps1")
        print(f"Detected Windows -> running {script}")
        print("(This must be run from an Administrator PowerShell/terminal.)")
        result = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", script]
        )

    elif system in ("Linux", "Darwin"):
        script = os.path.join(SCRIPT_DIR, "start.sh")
        print(f"Detected {system} -> running {script}")

        if os.geteuid() != 0:
            print("Root is required for the OS certificate store - re-running with sudo ...")
            result = subprocess.run(["sudo", "bash", script])
        else:
            result = subprocess.run(["bash", script])

    else:
        print(f"Unsupported OS: {system}")
        sys.exit(1)

    if result.returncode != 0:
        sys.exit(result.returncode)

    print()
    print("=== Step: WildFly proxy ===")
    toggle_wildfly_proxy(wildfly_action)

    sys.exit(0)


if __name__ == "__main__":
    main()
