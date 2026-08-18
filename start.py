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

Separately (and not to be confused with the above), also flips the REVERSE
proxy's live logging toggle - see toggle-wildfly-reverse-proxy.sh/.bat and
proxy/log_and_route_reverse.py. That reverse proxy (docker-compose.yml's
wildfly-proxy service) is itself already started by "docker compose up"
like any other service; this step only controls whether it logs. Requires
WildFly's own port to be offset by +1 (e.g. -Djboss.socket.binding.port-
offset=1 in its run config) so wildfly-proxy can own WildFly's usual port -
a one-time manual step on WildFly's side, not something this script does.

Usage (same command on any OS):
    python3 start.py       (Linux/macOS - will re-exec itself with sudo if needed)
    python start.py        (Windows - run from an Administrator terminal)
    python3 start.py --wildfly-proxy off            turn the OUTBOUND JVM Attach-API proxy off
    python3 start.py --wildfly-reverse-proxy off    turn OFF logging of frontend->WildFly calls
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


SETTINGS_FILE = os.path.join(SCRIPT_DIR, "settings.properties")
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")


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


def _read_env_file():
    env = {}
    if not os.path.exists(ENV_FILE):
        return env
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def _write_env_file(env):
    with open(ENV_FILE, "w", encoding="utf-8") as f:
        for key, value in env.items():
            f.write(f"{key}={value}\n")


def sync_env_from_settings():
    """Reads inbound_logging_enabled from settings.properties and bakes it into .env as
    COMPOSE_PROFILES/INBOUND_LOGGING_ENABLED - docker-compose.yml's wildfly-proxy service only
    starts when the "inbound-logging" profile is active (Compose reads COMPOSE_PROFILES from .env
    automatically, no --profile flag needed), and backend reads INBOUND_LOGGING_ENABLED to decide
    whether to report the feature as available at all (hiding Settings' "Inbound logging" panel
    when it isn't). Must run AFTER ensure_backend_port(), not before - that function's own "does
    .env already exist" check would otherwise see the file this creates and skip picking a free
    BACKEND_PORT on a fresh install. Merges into whatever .env already has (preserving
    BACKEND_PORT, etc.) rather than overwriting it. A deploy-time flag, re-read on every
    start.py/restart.py run, not live - see settings.properties's own comments."""
    settings = _parse_settings_properties()
    enabled = settings.get("inbound_logging_enabled", "false").strip().lower() == "true"

    env = _read_env_file()
    env["INBOUND_LOGGING_ENABLED"] = "true" if enabled else "false"
    if enabled:
        env["COMPOSE_PROFILES"] = "inbound-logging"
    else:
        env.pop("COMPOSE_PROFILES", None)
    _write_env_file(env)

    print(f"Inbound logging feature: {'enabled' if enabled else 'disabled'} (settings.properties - edit and re-run to change)")

    if not enabled:
        # "docker compose up" alone never stops an already-running container that's fallen out of
        # profile scope - it only skips (re)creating it. Without this, flipping the flag off on an
        # already-running deployment would leave a stale wildfly-proxy container up despite the
        # feature supposedly being disabled. Best-effort/non-fatal: harmless if the container was
        # never running, and shouldn't block the rest of this script over it.
        subprocess.run(["docker", "compose", "stop", "wildfly-proxy"], cwd=SCRIPT_DIR)

    sync_wildfly_port_offset(settings, enabled)


WILDFLY_PORT_OFFSET_BEGIN = {
    True: "REM --- BEGIN alfred-inbound-logging (managed by Alfred - do not edit by hand) ---",
    False: "# --- BEGIN alfred-inbound-logging (managed by Alfred - do not edit by hand) ---",
}
WILDFLY_PORT_OFFSET_END = {
    True: "REM --- END alfred-inbound-logging ---",
    False: "# --- END alfred-inbound-logging ---",
}


def _wildfly_home(settings):
    """settings.properties' wildfly_home wins if set; otherwise falls back to the WILDFLY_HOME
    environment variable (see settings.properties' own doc)."""
    return settings.get("wildfly_home", "").strip() or os.environ.get("WILDFLY_HOME", "").strip()


def _standalone_conf_path(wildfly_home):
    is_windows = platform.system() == "Windows"
    filename = "standalone.conf.bat" if is_windows else "standalone.conf"
    return os.path.join(wildfly_home, "bin", filename), is_windows


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
    at a real WildFly install - this is a convenience, not something that should block the rest of
    this script. Requires restarting WildFly itself to take effect either way.
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
            content = f.read()
    except OSError as e:
        print(f"Could not read {conf_path}, skipping port-offset setup: {e}")
        return

    if begin_marker in content and end_marker in content:
        start = content.index(begin_marker)
        end = content.index(end_marker) + len(end_marker)
        content = content[:start].rstrip("\n") + "\n" + content[end:].lstrip("\n")

    if enabled:
        offset_line = ('set "JAVA_OPTS=%JAVA_OPTS% -Djboss.socket.binding.port-offset=1"' if is_windows
                        else 'JAVA_OPTS="$JAVA_OPTS -Djboss.socket.binding.port-offset=1"')
        content = content.rstrip("\n") + f"\n\n{begin_marker}\n{offset_line}\n{end_marker}\n"

    try:
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        print(f"Could not write {conf_path}, skipping port-offset setup: {e}")
        return

    action = "Added" if enabled else "Removed"
    print(f"{action} WildFly's port-offset in {conf_path} - restart WildFly for this to take effect.")


USAGE = ("Usage: python3 start.py [--wildfly-proxy [on|off]] "
         "[--wildfly-reverse-proxy [on|off]]")


def _parse_toggle_args(args):
    """Parses the two independent, unrelated toggle flags this script accepts, in any order -
    --wildfly-proxy (the OUTBOUND JVM Attach-API proxy, wildfly-proxy-toggle/) and
    --wildfly-reverse-proxy (the INBOUND reverse-proxy call logger, toggle-wildfly-reverse-
    proxy.sh/.bat). Both default to "on" even with no flags at all, since both toggles now run
    automatically as a step on every start."""
    wildfly_proxy = "on"
    wildfly_reverse_proxy = "on"
    i = 0
    while i < len(args):
        flag = args[i]
        if flag not in ("--wildfly-proxy", "--wildfly-reverse-proxy"):
            print(USAGE)
            sys.exit(1)
        value = "on"
        if i + 1 < len(args) and args[i + 1] in ("on", "off"):
            value = args[i + 1]
            i += 1
        if flag == "--wildfly-proxy":
            wildfly_proxy = value
        else:
            wildfly_reverse_proxy = value
        i += 1
    return wildfly_proxy, wildfly_reverse_proxy


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


def toggle_wildfly_reverse_proxy(action):
    """Flips proxy/reverse-proxy-enabled.flag via toggle-wildfly-reverse-proxy.sh/.bat - live,
    no container restart (see proxy/log_and_route_reverse.py). Unrelated to
    toggle_wildfly_proxy() above: that one injects proxy settings into a running WildFly JVM for
    its OUTBOUND calls; this one only controls whether docker-compose.yml's wildfly-proxy service
    (already brought up by "docker compose up" like any other service) logs the frontend's
    INBOUND calls to WildFly. Deliberately non-fatal, same rationale as toggle_wildfly_proxy."""
    if platform.system() == "Windows":
        cmd = [os.path.join(SCRIPT_DIR, "toggle-wildfly-reverse-proxy.bat"), action]
    else:
        cmd = ["bash", os.path.join(SCRIPT_DIR, "toggle-wildfly-reverse-proxy.sh"), action]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print("WildFly reverse-proxy toggle failed (see above) - continuing anyway, since this")
        print("is a convenience step, not required for Alfred's own stack to be up.")
    print("(Requires WildFly's own port offset by +1, e.g. -Djboss.socket.binding.port-offset=1")
    print(" in its run config, so wildfly-proxy can own WildFly's usual port - a one-time manual")
    print(" step on WildFly's side; see docker-compose.yml's wildfly-proxy service.)")


def main():
    ensure_backend_port()
    sync_env_from_settings()
    wildfly_action, wildfly_reverse_action = _parse_toggle_args(sys.argv[1:])
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
    print("=== Step: WildFly proxy (outbound, JVM Attach API) ===")
    toggle_wildfly_proxy(wildfly_action)

    print()
    print("=== Step: WildFly reverse-proxy (inbound, frontend call logging) ===")
    toggle_wildfly_reverse_proxy(wildfly_reverse_action)

    sys.exit(0)


if __name__ == "__main__":
    main()
