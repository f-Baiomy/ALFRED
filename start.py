#!/usr/bin/env python3
"""
start.py - cross-platform entry point.

Detects the OS and runs the matching script (start.sh on Linux/macOS,
start.ps1 on Windows), which runs "docker compose up -d" and syncs the
proxy's CA cert into the OS/JDK trust stores.

Also runs wildfly-proxy-toggle's proxy-on step automatically (on either OS)
- routes an already-running WildFly JVM's HTTP/HTTPS traffic through the proxy
via the Java Attach API, auto-detecting the running instance. Non-fatal if
it fails (e.g. no WildFly running) - a convenience step, not required for
Alfred's own stack to be up. See wildfly-proxy-toggle/README.md.

docker-compose.yml's reverse-proxy service (INBOUND call logging - a single
container holding one listener per NAMED project, each on its own listenPort
and forwarding to that project's own unchanged port, per
REVERSE_PROXY_PORT_MAP - see docs/supplier-integrations.md) only runs when
settings.properties's
reverse_proxy_enabled=true - many environments only ever need OUTBOUND
logging (the "proxy" service, always running regardless of this flag) and
have no inbound project to front. When enabled, each configured project's
logging is toggled independently, live, from the Settings UI or
toggle-wildfly-reverse-proxy.sh/.bat <name> [on|off] - not from this script;
there's no per-start switch for that, only the top-level enabled/disabled
flag. sync-wildfly-port-offset.py (run automatically here, BEFORE "docker
compose up") is legacy/optional even when reverse_proxy_enabled=true, since
routing is by hostname rather than by claiming a project's own port - only
relevant if you specifically want WildFly reachable on its original port
both proxied and unproxied at once; skipped with a printed note if
wildfly_home/WILDFLY_HOME isn't set.

Usage (same command on any OS):
    python3 start.py       (Linux/macOS - will re-exec itself with sudo if needed)
    python start.py        (Windows - run from an Administrator terminal)
    python3 start.py --wildfly-proxy off            turn the OUTBOUND JVM Attach-API proxy off
    python3 start.py --db-capture on [project]      load the database capture agent into WildFly and
                                                    switch capture on (off: switch it off) - docs/db-capture.md
"""

import os
import platform
import re
import socket
import subprocess

import alfred_dbcapture
import alfred_settings
import alfred_logwatch
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


REVERSE_PROXY_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "reverse-proxy-enabled.flag")
# Database capture's per-project switch - same bind-mount trap as above, but empty by default: a project
# with no line is OFF (see docs/db-capture.md).
DB_CAPTURE_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "db-capture-enabled.flag")
# The per-project ▤ Logs switch (specs/008-logs-call-link): same bind-mount trap, empty = every project off.
LOG_LINK_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "log-link-enabled.flag")
# The per-project ⬢ Redis switch (specs/011-redis-capture): same bind-mount trap, empty = every project off.
REDIS_CAPTURE_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "redis-capture-enabled.flag")


def ensure_reverse_proxy_flag_file():
    """Docker creates a DIRECTORY at a bind-mount's host path if it doesn't already exist as a
    plain file the first time "docker compose up" runs (confirmed live: a fresh clone doesn't have
    this gitignored runtime-state file, so reverse-proxy/backend's bind mounts of
    ./proxy/reverse-proxy-enabled.flag - see docker-compose.yml - each silently turned it into a
    directory instead, breaking toggle-wildfly-reverse-proxy.sh/.bat's plain "echo on > file" the
    first time anyone used it, with "Is a directory"). Must run BEFORE "docker compose up" - fixing
    it after the fact doesn't undo an already-wrong bind mount inside a running container (that
    needs a restart of those containers anyway, which happens naturally on the next "docker compose
    up" once this is a file again).

    Also self-heals a host that already hit this bug (removes the wrongly-created directory first)
    - toggle-wildfly-reverse-proxy.sh/.bat do the same check for anyone running them standalone
    without going through start.py/restart.py first."""
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
    if os.path.isdir(DB_CAPTURE_FLAG_FILE):
        try:
            os.rmdir(DB_CAPTURE_FLAG_FILE)
        except OSError as e:
            print(f"Could not remove the directory {DB_CAPTURE_FLAG_FILE}: {e} - remove it by hand, then re-run.")
            return
    if not os.path.exists(DB_CAPTURE_FLAG_FILE):
        with open(DB_CAPTURE_FLAG_FILE, "w", encoding="utf-8") as f:
            f.write("")
    if os.path.isdir(LOG_LINK_FLAG_FILE):
        try:
            os.rmdir(LOG_LINK_FLAG_FILE)
        except OSError as e:
            print(f"Could not remove the directory {LOG_LINK_FLAG_FILE}: {e} - remove it by hand, then re-run.")
            return
    if not os.path.exists(LOG_LINK_FLAG_FILE):
        with open(LOG_LINK_FLAG_FILE, "w", encoding="utf-8") as f:
            f.write("")
    if os.path.isdir(REDIS_CAPTURE_FLAG_FILE):
        try:
            os.rmdir(REDIS_CAPTURE_FLAG_FILE)
        except OSError as e:
            print(f"Could not remove the directory {REDIS_CAPTURE_FLAG_FILE}: {e} - remove it by hand, then re-run.")
            return
    if not os.path.exists(REDIS_CAPTURE_FLAG_FILE):
        with open(REDIS_CAPTURE_FLAG_FILE, "w", encoding="utf-8") as f:
            f.write("")


SETTINGS_FILE = os.path.join(SCRIPT_DIR, "settings.properties")
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")

# The settings grammar lives in alfred_settings.py (shared with the native install's supervisor,
# specs/012-server-program); these names stay so the rest of this script reads as before.
FORWARD_PROXY_INTERNAL_PORT_BASE = alfred_settings.FORWARD_PROXY_INTERNAL_PORT_BASE
DEFAULT_INBOUND_RETENTION_ROWS = alfred_settings.DEFAULT_INBOUND_RETENTION_ROWS
_service_listen_ports = alfred_settings.service_listen_ports
_parse_service_entries = alfred_settings.parse_service_entries
_forward_proxy_assignments = alfred_settings.forward_proxy_assignments
_forward_proxy_port_map_env = alfred_settings.forward_proxy_port_map_env
_inbound_retention_rows = alfred_settings.inbound_retention_rows
_resolve_placeholders = alfred_settings.resolve_placeholders


def _parse_settings_properties():
    return alfred_settings.parse_settings_properties(SETTINGS_FILE)


def _read_env_file():
    return alfred_settings.read_env_file(ENV_FILE)


def _write_env_file(env):
    alfred_settings.write_env_file(ENV_FILE, env)
COMPOSE_OVERRIDE_FILE = os.path.join(SCRIPT_DIR, "docker-compose.override.yml")

# Header of the generated docker-compose.override.yml - see sync_compose_override() below.
COMPOSE_OVERRIDE_HEADER = """\
# GENERATED by start.py/restart.py from settings.properties's internal_call_services -
# do not edit by hand, it is rewritten on every run. Delete it and re-run to regenerate.
#
# Why this file exists: inbound logging gives each project its own listenPort, which the
# reverse-proxy container has to publish to the host so callers can reach it. That list is
# variable-length and lives in settings.properties, and Compose can't expand a list of ports
# from an environment variable - so the port publishes are generated here instead of being
# hardcoded in docker-compose.yml. Bound to 127.0.0.1 only, same as every other Alfred port.
"""


def sync_compose_override(services, reverse_proxy_enabled=True):
    """Writes docker-compose.override.yml (auto-loaded by Compose, no -f flag needed) publishing:
    - one host port per configured project on reverse-proxy, so callers reach that project's
      Alfred INBOUND listener on 127.0.0.1:<listenPort> - only when reverse_proxy_enabled (that
      container doesn't even run otherwise);
    - one host address per project that opted into OUTBOUND attribution (internal_call_services'
      optional 4th/5th fields) on proxy, publishing <outboundProxyHost>:<outboundProxyPort or
      443> to that project's own dedicated internal port (see _forward_proxy_assignments()) -
      unconditionally, since outbound attribution has no feature flag of its own and "proxy"
      always runs.
    See COMPOSE_OVERRIDE_HEADER above for why this is generated rather than hardcoded. Removed
    entirely when neither list has anything to publish, so a deployment using neither feature
    never carries a stale override."""
    ports = _service_listen_ports(services) if reverse_proxy_enabled else []
    forward_assignments = _forward_proxy_assignments(services)
    # Logs Explorer watched folders (logs_watch_dirs): one read-only mount each, at /watch/<name>.
    watch_mounts = alfred_logwatch.override_lines(_read_env_file())
    if not ports and not forward_assignments and not watch_mounts:
        if os.path.exists(COMPOSE_OVERRIDE_FILE):
            os.remove(COMPOSE_OVERRIDE_FILE)
            print("Removed docker-compose.override.yml (no inbound-logging or outbound-attribution projects configured)")
        return

    lines = [COMPOSE_OVERRIDE_HEADER, "\nservices:\n"]

    if ports:
        lines += ["  reverse-proxy:\n", "    ports:\n"]
        for name, listen_port in ports:
            lines.append(f'      - "127.0.0.1:{listen_port}:{listen_port}"   # {name}\n')

    if forward_assignments:
        lines += ["  proxy:\n", "    ports:\n"]
        for assignment in forward_assignments:
            lines.append(
                f'      - "{assignment["outbound_host"]}:{assignment["outbound_port"]}:'
                f'{assignment["internal_port"]}"   # {assignment["name"]} (outbound attribution)\n'
            )

    lines += watch_mounts

    with open(COMPOSE_OVERRIDE_FILE, "w", encoding="utf-8") as f:
        f.writelines(lines)

    published = []
    if ports:
        published += [f"{name} (inbound) -> localhost:{port}" for name, port in ports]
    if forward_assignments:
        published += [
            f'{a["name"]} (outbound) -> {a["outbound_host"]}:{a["outbound_port"]}'
            for a in forward_assignments
        ]
    print(f"Wrote docker-compose.override.yml publishing {', '.join(published)}")


def sync_wildfly_port_offset():
    """Delegates to sync-wildfly-port-offset.py (see its own docstring) - kept as a separate,
    independently-runnable script rather than inlined here so WildFly's port-offset can be synced
    on its own (e.g. right after hand-editing settings.properties, or ahead of "docker compose up"
    in a deploy pipeline) without going through the rest of start.py. Deliberately non-fatal here:
    a failure printed its own manual-steps fallback already, and shouldn't block the rest of this
    script over what is otherwise just a WildFly-side convenience."""
    script = os.path.join(SCRIPT_DIR, "sync-wildfly-port-offset.py")
    result = subprocess.run([sys.executable, script], cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print("WildFly port-offset sync failed (see above) - continuing anyway.")


def sync_env_from_settings():
    """Bakes reverse_proxy_enabled/internal_call_services into .env as COMPOSE_PROFILES/
    REVERSE_PROXY_ENABLED/INTERNAL_CALL_SERVICES/FORWARD_PROXY_PORT_MAP -
    docker-compose.yml's reverse-proxy service only starts when the "inbound-logging" profile
    is active (Compose reads COMPOSE_PROFILES from .env automatically, no --profile flag
    needed) - many environments only ever need OUTBOUND logging (the always-running "proxy"
    service) and have no inbound project to front, so this keeps reverse-proxy from starting at
    all for them rather than starting an idle container. backend reads REVERSE_PROXY_ENABLED to
    decide whether to report the feature as available at all (hiding Settings' "Inbound
    logging" panel when it isn't), and INTERNAL_CALL_SERVICES either way (the
    "name:listenPort:upstreamPort[:outboundProxyHost[:outboundProxyPort]]" list of every
    project reverse-proxy and/or proxy fronts - both docker-compose.yml services read this same
    variable, one source of truth). FORWARD_PROXY_PORT_MAP is derived from the same list's
    optional 4th/5th fields (see _forward_proxy_assignments()) and is independent of
    reverse_proxy_enabled - the "proxy" service's per-project outbound-attribution listeners have
    no feature flag of their own, since "proxy" always runs regardless. Must run AFTER
    ensure_backend_port(), not before - that function's own "does .env already exist" check
    would otherwise see the file this creates and skip picking a free BACKEND_PORT on a fresh
    install.

    Each of these settings is only ever taken from settings.properties to fill in a key .env
    doesn't already have (env.setdefault, below) - .env, not settings.properties, is what's
    actually running. This is what lets settings.properties be safely reset back to whatever's
    committed (e.g. by "python3 deploy.py"'s "git reset --hard origin/<branch>", which discards
    any local edits the same way it discards any other tracked file) without that reset ever
    reverting an already-deployed setting: nothing already in .env gets overwritten, and a
    setting added to settings.properties in a newer commit still gets adopted the first time
    this deployment sees it (it isn't in .env yet, so its settings.properties default is used).
    The flip side: to deliberately CHANGE a setting that's already running, edit .env directly,
    or delete just that line from .env and re-run this script so it re-derives it from
    settings.properties - editing settings.properties alone no longer does it for a setting
    that's already been adopted once. See settings.properties's own header.

    Also (re)writes docker-compose.override.yml from the effective list - see
    sync_compose_override() for why the proxy containers need an /etc/hosts entry per project
    hostname.

    Also syncs WildFly's own port-offset (see sync_wildfly_port_offset() above) BEFORE returning -
    this must happen before "docker compose up" (called right after this, in main()) ever brings
    reverse-proxy up wanting to own WildFly's usual port, or the two will fight over it."""
    settings = _parse_settings_properties()
    env = _read_env_file()

    env.setdefault(
        "REVERSE_PROXY_ENABLED",
        "true" if settings.get("reverse_proxy_enabled", "false").strip().lower() == "true" else "false",
    )
    env.setdefault("INTERNAL_CALL_SERVICES", settings.get("internal_call_services", "").strip())
    # Outbound attribution (the "proxy" service's per-project forward-mode listeners) has no
    # feature flag of its own - it's independent of reverse_proxy_enabled, since "proxy" always
    # runs regardless. Derived from the EFFECTIVE (post-setdefault) services list, not
    # settings.properties's raw one, so it never drifts from whichever list actually won above.
    env.setdefault("FORWARD_PROXY_PORT_MAP", _forward_proxy_port_map_env(env["INTERNAL_CALL_SERVICES"]))
    env.setdefault("INTERNAL_CALLS_RETENTION_ROWS", _inbound_retention_rows(settings))
    # Host folder mounted read-only at /logs for the Logs Explorer's server-file inputs.
    env.setdefault("ALFRED_LOGS_DIR", settings.get("logs_drop_dir", "").strip() or "./logs-drop")
    # Folders listened on live (logs_watch_dirs / logs_watch_mode) and the log agent's secret.
    alfred_logwatch.sync_env(env, settings)

    reverse_proxy_enabled = env["REVERSE_PROXY_ENABLED"].strip().lower() == "true"
    services = env["INTERNAL_CALL_SERVICES"]

    if reverse_proxy_enabled:
        env["COMPOSE_PROFILES"] = "inbound-logging"
    else:
        env.pop("COMPOSE_PROFILES", None)
    _write_env_file(env)

    print(f"Inbound logging feature: {'enabled' if reverse_proxy_enabled else 'disabled'}, "
          f"projects: {services or '(none configured)'} (from .env - delete its line there, or edit .env directly, to change an already-adopted setting)")
    print(f"Outbound attribution: {env['FORWARD_PROXY_PORT_MAP'] or '(none configured)'}")
    print(f"Inbound call retention: {env['INTERNAL_CALLS_RETENTION_ROWS']} calls kept in the live list")

    sync_compose_override(services, reverse_proxy_enabled)

    if not reverse_proxy_enabled:
        # "docker compose up" alone never stops an already-running container that's fallen out of
        # profile scope - it only skips (re)creating it. Without this, flipping the flag off on an
        # already-running deployment would leave a stale reverse-proxy container up despite the
        # feature supposedly being disabled. Best-effort/non-fatal: harmless if the container was
        # never running, and shouldn't block the rest of this script over it.
        subprocess.run(["docker", "compose", "stop", "reverse-proxy"], cwd=SCRIPT_DIR)

    sync_wildfly_port_offset()


USAGE = "Usage: python3 start.py [--wildfly-proxy [on|off]] [--db-capture [on|off] [project]]"


def _parse_toggle_args(args):
    """Parses the one toggle flag this script still accepts - --wildfly-proxy (the OUTBOUND
    JVM Attach-API proxy, wildfly-proxy-toggle/). Defaults to "on" even with no flags at all,
    since it runs automatically as a step on every start. (The old --wildfly-reverse-proxy flag
    is gone - INBOUND logging is now per-project and toggled live via the Settings UI or
    toggle-wildfly-reverse-proxy.sh/.bat <name>, not on every start.py run.)"""
    wildfly_proxy = "on"
    i = 0
    while i < len(args):
        flag = args[i]
        if flag != "--wildfly-proxy":
            print(USAGE)
            sys.exit(1)
        value = "on"
        if i + 1 < len(args) and args[i + 1] in ("on", "off"):
            value = args[i + 1]
            i += 1
        wildfly_proxy = value
        i += 1
    return wildfly_proxy


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
    ensure_reverse_proxy_flag_file()
    sync_env_from_settings()
    args, db_capture_action, db_capture_project = alfred_dbcapture.take_flag(sys.argv[1:])
    wildfly_action = _parse_toggle_args(args)
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
    print("=== Step: log agent (watched log folders, Docker Desktop only) ===")
    alfred_logwatch.ensure_agent(_read_env_file())

    print()
    print("=== Step: WildFly proxy (outbound, JVM Attach API) ===")
    toggle_wildfly_proxy(wildfly_action)

    if db_capture_action:
        print()
        print("=== Step: database capture agent (JVM Attach API) ===")
        alfred_dbcapture.toggle(db_capture_action, db_capture_project)

    sys.exit(0)


if __name__ == "__main__":
    main()
