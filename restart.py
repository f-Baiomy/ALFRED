#!/usr/bin/env python3
"""
restart.py - rebuild and restart the Alfred stack (or a single service).

With no service names given, this is exactly "stop.py, then start.py" (see
restart_everything()) - a full teardown (undoing WildFly's port-offset/JVM-attach
side effects too, not just stopping containers) followed by a full, from-scratch
bring-up (cert trust, port-offset, etc.). Because of that, a plain "python3
restart.py" now needs the same privileges start.py does (Administrator on Windows,
sudo on Linux/macOS) - it didn't before, when it only ran "docker compose down"/"up"
directly.

With one or more service names given, this stays a targeted, no-elevation-needed
rebuild of just those containers ("docker compose up -d --build <services>") - no
full stop/start round trip, since that would be overkill (and would needlessly touch
WildFly's port-offset/JVM attachment) just to rebuild one container.

Also runs wildfly-proxy-toggle's proxy-on step automatically (on either OS)
- routes an already-running WildFly JVM's HTTPS traffic through the proxy
via the Java Attach API, auto-detecting the running instance. Non-fatal if
it fails (e.g. no WildFly running) - a convenience step, not required for
the restart itself to succeed. See wildfly-proxy-toggle/README.md.

Separately (and not to be confused with the above), also flips the REVERSE
proxy's live logging toggle - see toggle-wildfly-reverse-proxy.sh/.bat and
proxy/log_and_route_reverse.py. That reverse proxy (docker-compose.yml's
wildfly-proxy service) is itself already restarted like any other service;
this step only controls whether it logs.

Usage:
    python3 restart.py                 restart everything (stop.py, then start.py)
    python3 restart.py backend      restart/rebuild just one service (targeted, no elevation)
    python3 restart.py frontend backend  restart/rebuild multiple named services
    python3 restart.py --wildfly-proxy off            turn the OUTBOUND JVM Attach-API proxy off -
                                                       combinable with the above, e.g.:
                                                       python3 restart.py backend --wildfly-proxy off
    python3 restart.py --wildfly-reverse-proxy off    turn OFF logging of frontend->WildFly calls
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


REVERSE_PROXY_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "reverse-proxy-enabled.flag")


def ensure_reverse_proxy_flag_file():
    """Same as start.py's function of the same name - see its docstring. Also needed here since a
    targeted "restart.py <service>" can itself be the very first "docker compose up" a fresh clone
    ever runs."""
    if os.path.isdir(REVERSE_PROXY_FLAG_FILE):
        print(f"{REVERSE_PROXY_FLAG_FILE} exists as a directory (created by an earlier 'docker "
              "compose up' before this file existed) - removing it so it can be a plain file.")
        try:
            os.rmdir(REVERSE_PROXY_FLAG_FILE)
        except OSError as e:
            print(f"Could not remove {REVERSE_PROXY_FLAG_FILE}: {e} - remove it by hand, then re-run.")
            return
    if not os.path.exists(REVERSE_PROXY_FLAG_FILE):
        os.makedirs(os.path.dirname(REVERSE_PROXY_FLAG_FILE), exist_ok=True)
        with open(REVERSE_PROXY_FLAG_FILE, "w", encoding="utf-8") as f:
            f.write("on\n")


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


def sync_wildfly_port_offset():
    """Same as start.py's function of the same name - delegates to the standalone
    sync-wildfly-port-offset.py so there's exactly one place that knows how to edit WildFly's
    config (and how to fall back to manual instructions if it can't)."""
    script = os.path.join(SCRIPT_DIR, "sync-wildfly-port-offset.py")
    result = subprocess.run([sys.executable, script], cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print("WildFly port-offset sync failed (see above) - continuing anyway.")


def sync_env_from_settings():
    """Same as start.py's function of the same name - see its docstring. Also needed here (not
    just in start.py) since restart.py is a valid standalone entry point, e.g. after hand-editing
    settings.properties on an already-running deployment. Must run AFTER ensure_backend_port()."""
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
        # See start.py's identical step for why this is needed - "docker compose up" alone never
        # stops an already-running container that's fallen out of profile scope. Best-effort/
        # non-fatal.
        subprocess.run(["docker", "compose", "stop", "wildfly-proxy"], cwd=SCRIPT_DIR)

    sync_wildfly_port_offset()


def run(cmd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def _parse_args(argv):
    """Splits service names (positional) from the two independent, unrelated toggle flags this
    script accepts - --wildfly-proxy (the OUTBOUND JVM Attach-API proxy, wildfly-proxy-toggle/)
    and --wildfly-reverse-proxy (the INBOUND reverse-proxy call logger, toggle-wildfly-reverse-
    proxy.sh/.bat) - a small hand-rolled parser rather than argparse, matching this script's
    existing plain sys.argv[1:] handling for service names. Both toggles now run automatically
    as a step on every restart - both default to "on" even with no flags at all. A following
    token is only consumed as the on|off value when it's actually "on"/"off"; anything else
    (e.g. a service name) is left for the positional branch below."""
    services = []
    wildfly_action = "on"
    wildfly_reverse_action = "on"
    i = 0
    while i < len(argv):
        if argv[i] in ("--wildfly-proxy", "--wildfly-reverse-proxy"):
            flag = argv[i]
            if i + 1 < len(argv) and argv[i + 1] in ("on", "off"):
                value = argv[i + 1]
                i += 2
            else:
                value = "on"
                i += 1
            if flag == "--wildfly-proxy":
                wildfly_action = value
            else:
                wildfly_reverse_action = value
        else:
            services.append(argv[i])
            i += 1
    return services, wildfly_action, wildfly_reverse_action


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


def toggle_wildfly_reverse_proxy(action):
    """Flips proxy/reverse-proxy-enabled.flag via toggle-wildfly-reverse-proxy.sh/.bat - live,
    no container restart (see proxy/log_and_route_reverse.py). Unrelated to
    toggle_wildfly_proxy() above: that one injects proxy settings into a running WildFly JVM for
    its OUTBOUND calls; this one only controls whether docker-compose.yml's wildfly-proxy service
    (already restarted by the "docker compose" calls in main(), like any other service) logs the
    frontend's INBOUND calls to WildFly. Deliberately non-fatal, same rationale as
    toggle_wildfly_proxy."""
    if platform.system() == "Windows":
        cmd = [os.path.join(SCRIPT_DIR, "toggle-wildfly-reverse-proxy.bat"), action]
    else:
        cmd = ["bash", os.path.join(SCRIPT_DIR, "toggle-wildfly-reverse-proxy.sh"), action]

    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print("WildFly reverse-proxy toggle failed (see above) - continuing anyway, since this")
        print("is a convenience step, not required for the restart itself to succeed.")


def restart_everything(wildfly_action, wildfly_reverse_action):
    """A full restart (no service names given) is just "stop everything, then start
    everything" - delegated to stop.py and start.py as separate processes rather than
    reimplemented here, so there's exactly one place that knows how to fully tear down
    (undoing the WildFly port-offset/JVM-attach side effects too, not just the
    containers) and exactly one place that knows how to fully bring everything back up
    (cert trust, port-offset, etc.). Note this means a plain "python3 restart.py" now
    needs whatever privileges start.py itself needs (Administrator on Windows, sudo on
    Linux/macOS, for the certificate store) - previously it didn't, since it only ever
    ran "docker compose down"/"up" directly. Targeted restarts (see main()) are
    unaffected and still don't need elevation."""
    stop_script = os.path.join(SCRIPT_DIR, "stop.py")
    print(f"$ {sys.executable} {stop_script}")
    result = subprocess.run([sys.executable, stop_script], cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)

    start_script = os.path.join(SCRIPT_DIR, "start.py")
    start_cmd = [sys.executable, start_script,
                 "--wildfly-proxy", wildfly_action,
                 "--wildfly-reverse-proxy", wildfly_reverse_action]
    print(f"$ {' '.join(start_cmd)}")
    result = subprocess.run(start_cmd, cwd=SCRIPT_DIR)
    sys.exit(result.returncode)


def main():
    services, wildfly_action, wildfly_reverse_action = _parse_args(sys.argv[1:])

    if not services:
        print("Restarting everything (stop.py, then start.py)")
        restart_everything(wildfly_action, wildfly_reverse_action)
        return  # unreachable - restart_everything always exits - kept for clarity

    # Targeted restart of specific service(s) - a full stop.py/start.py round trip would
    # be overkill (and would needlessly touch WildFly's port-offset/JVM attachment) just
    # to rebuild one container, so this path stays the original, more surgical behavior.
    ensure_backend_port()
    ensure_reverse_proxy_flag_file()
    sync_env_from_settings()

    print(f"Restarting: {', '.join(services)}")
    run(["docker", "compose", "up", "-d", "--build"] + services)

    print()
    print("=== Step: WildFly proxy (outbound, JVM Attach API) ===")
    toggle_wildfly_proxy(wildfly_action)

    print()
    print("=== Step: WildFly reverse-proxy (inbound, frontend call logging) ===")
    toggle_wildfly_reverse_proxy(wildfly_reverse_action)

    print("Done.")


if __name__ == "__main__":
    main()
