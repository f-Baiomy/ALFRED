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
- routes an already-running WildFly JVM's HTTP/HTTPS traffic through the proxy
via the Java Attach API, auto-detecting the running instance. Non-fatal if
it fails (e.g. no WildFly running) - a convenience step, not required for
the restart itself to succeed. See wildfly-proxy-toggle/README.md.

docker-compose.yml's reverse-proxy service (INBOUND call logging - a single
container holding one listener per NAMED project, each on its own listenPort
and forwarding to that project's own unchanged port, per
REVERSE_PROXY_PORT_MAP) only runs when
settings.properties's reverse_proxy_enabled=true - many environments only
ever need OUTBOUND logging (the "proxy" service, always running regardless
of this flag) and have no inbound project to front. When enabled, each
configured project's logging is toggled independently, live, from the
Settings UI or toggle-wildfly-reverse-proxy.sh/.bat <name> [on|off] - not
from this script.

Usage:
    python3 restart.py                 restart everything (stop.py, then start.py)
    python3 restart.py backend      restart/rebuild just one service (targeted, no elevation)
    python3 restart.py frontend backend  restart/rebuild multiple named services
    python3 restart.py --wildfly-proxy off            turn the OUTBOUND JVM Attach-API proxy off -
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
COMPOSE_OVERRIDE_FILE = os.path.join(SCRIPT_DIR, "docker-compose.override.yml")

# Header of the generated docker-compose.override.yml - see start.py's sync_compose_override(),
# which this mirrors (kept in sync by hand, same as the other duplicated helpers in this script).
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


def _service_listen_ports(services):
    """Same as start.py's function of the same name - pulls (name, listenPort) out of each
    "name:listenPort:upstreamPort[...]" entry in internal_call_services. The optional 4th/5th
    (outbound) fields, if present, ride along inside parts[2] here (maxsplit=2) and are simply
    never looked at - this function only ever needed name+listenPort."""
    ports = []
    seen = set()
    for triple in services.split(","):
        triple = triple.strip()
        if not triple:
            continue
        parts = triple.split(":", 2)
        if len(parts) != 3:
            continue
        name, listen_port = parts[0].strip(), parts[1].strip()
        if not name or not listen_port.isdigit() or listen_port in seen:
            continue
        seen.add(listen_port)
        ports.append((name, listen_port))
    return ports


# Same as start.py's constant of the same name - see _forward_proxy_assignments() below.
FORWARD_PROXY_INTERNAL_PORT_BASE = 20000


def _parse_service_entries(services):
    """Same as start.py's function of the same name - parses internal_call_services into
    structured entries (name, listen_port, upstream_port, outbound_host, outbound_port), each
    entry being "name:listenPort:upstreamPort" optionally followed by ":outboundProxyHost" and
    then ":outboundProxyPort" (defaults to "443" when the host is given but the port isn't)."""
    entries = []
    seen_listen_ports = set()
    for entry in services.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = [p.strip() for p in entry.split(":")]
        if len(parts) < 3 or len(parts) > 5:
            continue
        name, listen_port, upstream_port = parts[0], parts[1], parts[2]
        if not name or not listen_port.isdigit() or not upstream_port.isdigit():
            continue
        if listen_port in seen_listen_ports:
            continue

        outbound_host = parts[3] if len(parts) >= 4 and parts[3] else None
        outbound_port = None
        if outbound_host:
            outbound_port = parts[4] if len(parts) == 5 and parts[4] else "443"
            if not outbound_port.isdigit():
                outbound_host = None
                outbound_port = None

        seen_listen_ports.add(listen_port)
        entries.append({
            "name": name,
            "listen_port": listen_port,
            "upstream_port": upstream_port,
            "outbound_host": outbound_host,
            "outbound_port": outbound_port,
        })
    return entries


def _forward_proxy_assignments(services):
    """Same as start.py's function of the same name - assigns each outbound-attribution-
    configured project its own internal container port on the "proxy" service, deterministically:
    FORWARD_PROXY_INTERNAL_PORT_BASE (20000) + its index in internal_call_services' own order
    (counted over ALL entries, not just outbound-configured ones)."""
    assignments = []
    for index, entry in enumerate(_parse_service_entries(services)):
        if not entry["outbound_host"]:
            continue
        assignments.append({
            "name": entry["name"],
            "outbound_host": entry["outbound_host"],
            "outbound_port": entry["outbound_port"],
            "internal_port": FORWARD_PROXY_INTERNAL_PORT_BASE + index,
        })
    return assignments


def sync_compose_override(services, reverse_proxy_enabled=True):
    """Same as start.py's function of the same name - see its docstring. Writes
    docker-compose.override.yml publishing each inbound project's listenPort on reverse-proxy
    (only when reverse_proxy_enabled) and each outbound-attribution-configured project's
    outboundProxyHost:outboundProxyPort on proxy (unconditionally - that feature has no flag)."""
    ports = _service_listen_ports(services) if reverse_proxy_enabled else []
    forward_assignments = _forward_proxy_assignments(services)
    if not ports and not forward_assignments:
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


def _forward_proxy_port_map_env(services):
    """Same as start.py's function of the same name - builds the FORWARD_PROXY_PORT_MAP env var
    value ("name:internalPort" pairs, comma-separated)."""
    return ",".join(
        f'{a["name"]}:{a["internal_port"]}' for a in _forward_proxy_assignments(services)
    )


DEFAULT_INBOUND_RETENTION_ROWS = "1500"


def _inbound_retention_rows(settings):
    """Same as start.py's function of the same name - see its docstring for why an unusable value
    falls back rather than being passed through."""
    raw = settings.get("inbound_calls_retention_rows", "").strip()
    try:
        rows = int(raw)
    except ValueError:
        if raw:
            print(f"  [warn] inbound_calls_retention_rows={raw!r} is not a number - using {DEFAULT_INBOUND_RETENTION_ROWS}")
        return DEFAULT_INBOUND_RETENTION_ROWS
    if rows < 1:
        print(f"  [warn] inbound_calls_retention_rows={rows} would keep nothing - using {DEFAULT_INBOUND_RETENTION_ROWS}")
        return DEFAULT_INBOUND_RETENTION_ROWS
    return str(rows)


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
    """Same as start.py's function of the same name - see its docstring, in particular why each
    setting is only ever taken from settings.properties to fill in a key .env doesn't already
    have (env.setdefault), never to overwrite one that's already running. Also needed here (not
    just in start.py) since restart.py is a valid standalone entry point, e.g. after hand-editing
    settings.properties on an already-running deployment - in which case, per that same rule,
    also delete the specific .env line(s) for whatever you just changed, or the edit won't take
    effect. Must run AFTER ensure_backend_port(). Also bakes in FORWARD_PROXY_PORT_MAP (the
    "proxy" service's per-project outbound-attribution listeners) - independent of
    reverse_proxy_enabled, since that feature has no flag of its own."""
    settings = _parse_settings_properties()
    env = _read_env_file()

    env.setdefault(
        "REVERSE_PROXY_ENABLED",
        "true" if settings.get("reverse_proxy_enabled", "false").strip().lower() == "true" else "false",
    )
    env.setdefault("INTERNAL_CALL_SERVICES", settings.get("internal_call_services", "").strip())
    # Derived from the EFFECTIVE (post-setdefault) services list, not settings.properties's raw
    # one, so it never drifts from whichever list actually won above.
    env.setdefault("FORWARD_PROXY_PORT_MAP", _forward_proxy_port_map_env(env["INTERNAL_CALL_SERVICES"]))
    env.setdefault("INTERNAL_CALLS_RETENTION_ROWS", _inbound_retention_rows(settings))

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
        # See start.py's identical step for why this is needed - "docker compose up" alone never
        # stops an already-running container that's fallen out of profile scope. Best-effort/
        # non-fatal.
        subprocess.run(["docker", "compose", "stop", "reverse-proxy"], cwd=SCRIPT_DIR)

    sync_wildfly_port_offset()


def run(cmd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def _parse_args(argv):
    """Splits service names (positional) from the one toggle flag this script still accepts -
    --wildfly-proxy (the OUTBOUND JVM Attach-API proxy, wildfly-proxy-toggle/) - a small
    hand-rolled parser rather than argparse, matching this script's existing plain
    sys.argv[1:] handling for service names. Defaults to "on" even with no flags at all, since
    it runs automatically as a step on every restart. A following token is only consumed as
    the on|off value when it's actually "on"/"off"; anything else (e.g. a service name) is left
    for the positional branch below. (The old --wildfly-reverse-proxy flag is gone - INBOUND
    logging is now per-project and toggled live via the Settings UI or
    toggle-wildfly-reverse-proxy.sh/.bat <name>, not on every restart.py run.)"""
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


def restart_everything(wildfly_action):
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
    start_cmd = [sys.executable, start_script, "--wildfly-proxy", wildfly_action]
    print(f"$ {' '.join(start_cmd)}")
    result = subprocess.run(start_cmd, cwd=SCRIPT_DIR)
    sys.exit(result.returncode)


def main():
    services, wildfly_action = _parse_args(sys.argv[1:])

    if not services:
        print("Restarting everything (stop.py, then start.py)")
        restart_everything(wildfly_action)
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

    print("Done.")


if __name__ == "__main__":
    main()
