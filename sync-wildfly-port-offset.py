#!/usr/bin/env python3
"""
sync-wildfly-port-offset.py - adds or removes WildFly's -Djboss.socket.binding.port-offset=1
VM option in bin/standalone.conf(.bat) - the one host-level step inbound (frontend->WildFly)
logging depends on (see docker-compose.yml's wildfly-proxy service, which needs to own
WildFly's usual HTTP port). This MUST run before "docker compose up" brings wildfly-proxy up,
or it will fight WildFly itself for the same port - start.py/restart.py both run this
automatically as their very first step, before touching docker at all.

It's its own script (not just inlined into start.py/restart.py) so it's independently
runnable - to check/redo this step on its own, e.g. right after hand-editing
settings.properties on an already-running deployment, or to run it as a separate step ahead
of "docker compose up" in a CI/deploy pipeline instead of relying on start.py's ordering.

Reads inbound_logging_enabled from settings.properties to decide whether to add the offset
(true) or remove it (false); wildfly_home also comes from settings.properties, falling back to
the WILDFLY_HOME environment variable. Pass --disable to unconditionally remove the offset
regardless of what settings.properties currently says - stop.py uses this for its teardown,
since stopping means undoing this live effect entirely, not just respecting the config.

If it can't read/write WildFly's own config - most commonly "Permission denied", since
WildFly is often installed system-wide under another user/service account - this prints the
exact manual edit to make yourself instead of failing silently, tailored to Windows vs
Linux/macOS.

Usage:
    python3 sync-wildfly-port-offset.py             sync to settings.properties' current value
    python3 sync-wildfly-port-offset.py --disable   unconditionally remove the offset
"""

import os
import platform
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
OFFSET_LINE = {
    True: 'set "JAVA_OPTS=%JAVA_OPTS% -Djboss.socket.binding.port-offset=1"',
    False: 'JAVA_OPTS="$JAVA_OPTS -Djboss.socket.binding.port-offset=1"',
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


def _print_manual_steps(conf_path, is_windows, enabled):
    """Printed whenever this script can't edit WildFly's config itself (most often a permissions
    problem) - so a failed automatic step never leaves the user with nothing to act on."""
    begin_marker = WILDFLY_PORT_OFFSET_BEGIN[is_windows]
    end_marker = WILDFLY_PORT_OFFSET_END[is_windows]

    print()
    print("Couldn't edit it automatically - do this by hand instead:")
    if is_windows:
        print(f"  1. Open {conf_path} as Administrator (right-click your editor -> Run as administrator,")
        print("     or run it from an elevated terminal) - it's likely write-protected otherwise.")
    else:
        print(f"  1. Open {conf_path} with elevated permissions if needed, e.g.:")
        print(f"       sudo nano {conf_path}")
    print()
    if enabled:
        print("  2. Add these lines at the very end of the file:")
        print()
        print(f"     {begin_marker}")
        print(f"     {OFFSET_LINE[is_windows]}")
        print(f"     {end_marker}")
    else:
        print("  2. Delete the block between (and including) these two lines, if present:")
        print()
        print(f"     {begin_marker}")
        print("     ...")
        print(f"     {end_marker}")
    print()
    print("  3. Restart WildFly for the change to take effect.")
    print()


def sync_wildfly_port_offset(settings, enabled):
    """Adds/removes a marked -Djboss.socket.binding.port-offset=1 append to WildFly's own
    JAVA_OPTS, in bin/standalone.conf(.bat) under wildfly_home - the offset wildfly-proxy assumes
    (see docker-compose.yml's wildfly-proxy service) so it can take over WildFly's usual port.
    Appended at the very end of the file (after any existing JAVA_OPTS-building logic, including
    an if/else that only fires when JAVA_OPTS *isn't* already set in the environment) so it always
    applies to whatever JAVA_OPTS ends up being, regardless of how WildFly is actually launched -
    confirmed live against a setup where an IDE sets JAVA_OPTS directly in the environment before
    invoking standalone.bat (which still calls standalone.conf.bat first, so an append at the end
    of that file still runs).

    Idempotent either way: always strips any previously-managed block first, then re-adds it only
    if enabled - so toggling on twice never duplicates the line, and toggling off cleanly removes
    it. Silently skipped (with a warning) if wildfly_home/WILDFLY_HOME isn't set or doesn't point
    at a real WildFly install - this is a convenience, not something that should block whatever
    called this. Requires restarting WildFly itself to take effect either way.
    """
    wildfly_home = _wildfly_home(settings)
    if not wildfly_home:
        if enabled:
            print("No wildfly_home set in settings.properties (or WILDFLY_HOME env var) - skipping "
                  "WildFly's port-offset setup. Add one of those, or set "
                  "-Djboss.socket.binding.port-offset=1 on WildFly's own VM options yourself.")
        return

    conf_path, is_windows = _standalone_conf_path(wildfly_home)
    if not os.path.exists(conf_path):
        print(f"WildFly config not found at {conf_path} - skipping port-offset setup. Check wildfly_home/WILDFLY_HOME.")
        return

    begin_marker = WILDFLY_PORT_OFFSET_BEGIN[is_windows]
    end_marker = WILDFLY_PORT_OFFSET_END[is_windows]

    try:
        with open(conf_path, encoding="utf-8") as f:
            original_content = f.read()
    except OSError as e:
        print(f"Could not read {conf_path}: {e}")
        _print_manual_steps(conf_path, is_windows, enabled)
        return

    content = original_content
    if begin_marker in content and end_marker in content:
        start = content.index(begin_marker)
        end = content.index(end_marker) + len(end_marker)
        content = content[:start].rstrip("\n") + "\n" + content[end:].lstrip("\n")

    if enabled:
        content = content.rstrip("\n") + f"\n\n{begin_marker}\n{OFFSET_LINE[is_windows]}\n{end_marker}\n"

    if content == original_content:
        # Already in the desired state - skip the write entirely rather than touching a file
        # (possibly a real, shared WildFly install) that doesn't actually need to change.
        print(f"WildFly's port-offset in {conf_path} already matches settings.properties ({'enabled' if enabled else 'disabled'}) - nothing to do.")
        return

    try:
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        print(f"Could not write {conf_path}: {e}")
        _print_manual_steps(conf_path, is_windows, enabled)
        return

    action = "Added" if enabled else "Removed"
    print(f"{action} WildFly's port-offset in {conf_path} - restart WildFly for this to take effect.")


def main():
    settings = _parse_settings_properties()
    force_disable = "--disable" in sys.argv[1:]
    enabled = False if force_disable else settings.get("inbound_logging_enabled", "false").strip().lower() == "true"
    sync_wildfly_port_offset(settings, enabled)


if __name__ == "__main__":
    main()
