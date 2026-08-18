#!/usr/bin/env python3
"""
stop.py - stops everything start.py/restart.py brought up, and undoes their live,
host-level side effects - the opposite of start.py.

In order:
  1. Detaches the OUTBOUND JVM Attach-API proxy (wildfly-proxy-toggle) from any WildFly
     instance it's currently attached to - same as start.py/restart.py's
     "--wildfly-proxy off", but always run here regardless of any flag.
  2. Removes WildFly's port-offset from bin/standalone.conf(.bat) under wildfly_home (see
     settings.properties) - the same marked block start.py/restart.py add when
     inbound_logging_enabled=true - regardless of what settings.properties currently
     says, since stopping means undoing this live effect entirely, not just respecting
     whatever the config happens to say right now.
  3. "docker compose down --remove-orphans" - stops and removes every container this
     project created (proxy, wildfly-proxy, backend, frontend), including one left
     behind from a profile that's no longer active.

Does NOT touch certificate trust (that's a one-time host setup, not something starting
should undo) or .env/settings.properties themselves - re-running start.py/restart.py
afterward re-derives everything from those as usual.

Usage:
    python3 stop.py
"""

import os
import platform
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def remove_wildfly_port_offset():
    """Unconditionally removes WildFly's port-offset via sync-wildfly-port-offset.py --disable
    (see its own docstring) - regardless of what settings.properties currently says, since
    stopping means undoing this live effect entirely, not just respecting the config. Delegated
    rather than reimplemented here so there's exactly one place that knows how to edit WildFly's
    config (and how to fall back to manual instructions if it can't)."""
    script = os.path.join(SCRIPT_DIR, "sync-wildfly-port-offset.py")
    cmd = [sys.executable, script, "--disable"]
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print("WildFly port-offset removal failed (see above) - continuing anyway, since this is a")
        print("convenience step, not required for the rest of stop.py to succeed.")


def toggle_wildfly_proxy_off():
    """Detaches the outbound JVM Attach-API proxy from whatever WildFly instance it's currently
    attached to - see wildfly-proxy-toggle/README.md. Deliberately non-fatal: a machine with no
    WildFly running (or never attached in the first place) shouldn't fail an otherwise-successful
    stop.py run."""
    toggle_dir = os.path.join(SCRIPT_DIR, "wildfly-proxy-toggle")
    if platform.system() == "Windows":
        cmd = [os.path.join(toggle_dir, "proxy-off.bat")]
    else:
        cmd = ["bash", os.path.join(toggle_dir, "proxy-off.sh")]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=toggle_dir)
    if result.returncode != 0:
        print("WildFly proxy detach failed (see above) - continuing anyway, since this is a")
        print("convenience step, not required for the rest of stop.py to succeed.")


def stop_docker_compose():
    cmd = ["docker", "compose", "down", "--remove-orphans"]
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def main():
    print("=== Step: WildFly proxy (outbound, JVM Attach API) - detaching ===")
    toggle_wildfly_proxy_off()

    print()
    print("=== Step: WildFly port-offset - removing ===")
    remove_wildfly_port_offset()

    print()
    print("=== Step: docker compose down ===")
    stop_docker_compose()

    print()
    print("Done. Alfred's stack is stopped; WildFly and host settings are back to normal.")


if __name__ == "__main__":
    main()
