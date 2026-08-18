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
SETTINGS_FILE = os.path.join(SCRIPT_DIR, "settings.properties")

WILDFLY_PORT_OFFSET_BEGIN = {
    True: "REM --- BEGIN alfred-inbound-logging (managed by Alfred - do not edit by hand) ---",
    False: "# --- BEGIN alfred-inbound-logging (managed by Alfred - do not edit by hand) ---",
}
WILDFLY_PORT_OFFSET_END = {
    True: "REM --- END alfred-inbound-logging ---",
    False: "# --- END alfred-inbound-logging ---",
}


def _parse_settings_properties():
    """Extracts every key=value line from settings.properties (see its own doc) - blank lines,
    lines starting with #, and anything without an "=" are ignored."""
    settings = {}
    if not os.path.exists(SETTINGS_FILE):
        return settings
    with open(SETTINGS_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line or "=" not in line:
                continue
            key, _, value = line.partition("=")
            settings[key.strip()] = value.strip()
    return settings


def _wildfly_home(settings):
    """settings.properties' wildfly_home wins if set; otherwise falls back to the WILDFLY_HOME
    environment variable (see settings.properties' own doc)."""
    return settings.get("wildfly_home", "").strip() or os.environ.get("WILDFLY_HOME", "").strip()


def _standalone_conf_path(wildfly_home):
    is_windows = platform.system() == "Windows"
    filename = "standalone.conf.bat" if is_windows else "standalone.conf"
    return os.path.join(wildfly_home, "bin", filename), is_windows


def remove_wildfly_port_offset():
    """Unconditionally strips the managed port-offset block (see start.py/restart.py's
    sync_wildfly_port_offset, which this mirrors minus the "add" branch) - a no-op if the block
    isn't present. Silently skipped if wildfly_home/WILDFLY_HOME isn't set or doesn't point at a
    real WildFly install - nothing to undo there. Non-fatal on any I/O error."""
    settings = _parse_settings_properties()
    wildfly_home = _wildfly_home(settings)
    if not wildfly_home:
        return

    conf_path, is_windows = _standalone_conf_path(wildfly_home)
    if not os.path.exists(conf_path):
        return

    begin_marker = WILDFLY_PORT_OFFSET_BEGIN[is_windows]
    end_marker = WILDFLY_PORT_OFFSET_END[is_windows]

    try:
        with open(conf_path, encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        print(f"Could not read {conf_path}, skipping port-offset cleanup: {e}")
        return

    if begin_marker not in content or end_marker not in content:
        print(f"No managed port-offset block found in {conf_path} - nothing to remove.")
        return

    start = content.index(begin_marker)
    end = content.index(end_marker) + len(end_marker)
    content = content[:start].rstrip("\n") + "\n" + content[end:].lstrip("\n")

    try:
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        print(f"Could not write {conf_path}, skipping port-offset cleanup: {e}")
        return

    print(f"Removed WildFly's port-offset from {conf_path} - restart WildFly for this to take effect.")


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
