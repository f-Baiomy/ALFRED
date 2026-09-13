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


REVERSE_PROXY_FLAG_FILE = os.path.join(SCRIPT_DIR, "proxy", "reverse-proxy-enabled.flag")


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


SETTINGS_FILE = os.path.join(SCRIPT_DIR, "settings.properties")
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")
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


def _service_listen_ports(services):
    """Pulls (name, listenPort) out of each "name:listenPort:upstreamPort[...]" entry in
    internal_call_services, preserving order and dropping duplicates/malformed entries - same
    format proxy/reverse-proxy-entrypoint.sh and log_and_route_reverse.py parse themselves. The
    optional 4th/5th (outbound) fields, if present, ride along inside parts[2] here (maxsplit=2)
    and are simply never looked at - this function only ever needed name+listenPort."""
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


# Internal container ports on the "proxy" service assigned to per-project outbound-attribution
# listeners start here - see _forward_proxy_assignments() below for why.
FORWARD_PROXY_INTERNAL_PORT_BASE = 20000


def _parse_service_entries(services):
    """Parses internal_call_services into structured entries, preserving order and dropping
    duplicates/malformed entries - each entry is "name:listenPort:upstreamPort" (the original,
    still fully supported format) optionally followed by ":outboundProxyHost" and then
    ":outboundProxyPort" (only meaningful if outboundProxyHost is present too; defaults to "443",
    matching the existing forward-proxy's conventional port, when the host is given but the port
    isn't). A project may freely mix 3/4/5-field entries with others in the same comma-separated
    value - each entry is parsed independently. Returns a list of dicts with keys name,
    listen_port, upstream_port, outbound_host (str or None), outbound_port (str or None)."""
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
                # Malformed port - drop the outbound config for this entry rather than the
                # whole entry, so a typo in the 5th field doesn't also cost it inbound logging.
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
    """Assigns each outbound-attribution-configured project its own internal container port on
    the "proxy" service, deterministically: FORWARD_PROXY_INTERNAL_PORT_BASE (20000) + its index
    in internal_call_services' own order - counting over ALL entries, not just the outbound-
    configured ones, so a given project's internal port doesn't shift just because some other,
    unrelated project earlier in the list gains or loses outbound config. 20000+ is comfortably
    clear of every listenPort/upstreamPort a project would plausibly use (every documented
    example is four digits) and of the forward-proxy's own default internal port (8080); even if
    a collision somehow occurred, Docker would simply fail to publish the duplicate host port and
    that failure would surface immediately in "docker compose up" output, rather than silently
    misrouting traffic. Returns a list of dicts: name, outbound_host, outbound_port,
    internal_port."""
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
    """Builds the FORWARD_PROXY_PORT_MAP env var value - "name:internalPort" pairs, comma-
    separated - consumed by proxy/forward-proxy-entrypoint.sh (turns each pair into an extra
    "--mode regular@<internalPort>" listener) and by proxy/log_and_route.py (resolves
    service_name from the internal port a flow arrived on). Independent of
    reverse_proxy_enabled - outbound attribution has no such feature flag, since the "proxy"
    service is always running regardless."""
    return ",".join(
        f'{a["name"]}:{a["internal_port"]}' for a in _forward_proxy_assignments(services)
    )


DEFAULT_INBOUND_RETENTION_ROWS = "1500"


def _inbound_retention_rows(settings):
    """settings.properties's inbound_calls_retention_rows, as a string for .env.

    Falls back to the default on anything unusable (missing, blank, non-numeric, zero or
    negative) rather than passing it through: an empty or malformed value reaching the backend
    would either fail its @Value binding at startup or, worse, bind to 0 and make the ring buffer
    discard every inbound call the instant it was written. A typo in a config file should not be
    able to silently turn off inbound logging."""
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
    """Reads reverse_proxy_enabled/internal_call_services from settings.properties and bakes
    them into .env as COMPOSE_PROFILES/REVERSE_PROXY_ENABLED/INTERNAL_CALL_SERVICES/
    FORWARD_PROXY_PORT_MAP - docker-compose.yml's reverse-proxy service only starts when the
    "inbound-logging" profile is active (Compose reads COMPOSE_PROFILES from .env automatically,
    no --profile flag needed) - many environments only ever need OUTBOUND logging (the
    always-running "proxy" service) and have no inbound project to front, so this keeps
    reverse-proxy from starting at all for them rather than starting an idle container. backend
    reads REVERSE_PROXY_ENABLED to decide whether to report the feature as available at all
    (hiding Settings' "Inbound logging" panel when it isn't), and INTERNAL_CALL_SERVICES either
    way (the "name:listenPort:upstreamPort[:outboundProxyHost[:outboundProxyPort]]" list of every
    project reverse-proxy and/or proxy fronts - both docker-compose.yml services read this same
    variable, one source of truth). FORWARD_PROXY_PORT_MAP is derived from the same list's
    optional 4th/5th fields (see _forward_proxy_assignments()) and is independent of
    reverse_proxy_enabled - the "proxy" service's per-project outbound-attribution listeners have
    no feature flag of their own, since "proxy" always runs regardless. Must run AFTER
    ensure_backend_port(), not before - that function's own "does .env already exist" check
    would otherwise see the file this creates and skip picking a free BACKEND_PORT on a fresh
    install. Merges into whatever .env already has (preserving BACKEND_PORT, etc.) rather than
    overwriting it. Deploy-time flags, re-read on every start.py/restart.py run, not live - see
    settings.properties's own comments; each project's logging on/off state (as opposed to
    whether the feature/project LIST exists at all) is separately runtime-toggleable via the
    Settings UI or toggle-wildfly-reverse-proxy.sh/.bat.

    Also (re)writes docker-compose.override.yml from the same list - see
    sync_compose_override() for why the proxy containers need an /etc/hosts entry per project
    hostname.

    Also syncs WildFly's own port-offset (see sync_wildfly_port_offset() above) BEFORE returning -
    this must happen before "docker compose up" (called right after this, in main()) ever brings
    reverse-proxy up wanting to own WildFly's usual port, or the two will fight over it."""
    settings = _parse_settings_properties()
    reverse_proxy_enabled = settings.get("reverse_proxy_enabled", "false").strip().lower() == "true"
    services = settings.get("internal_call_services", "").strip()

    # Outbound attribution (the "proxy" service's per-project forward-mode listeners) has no
    # feature flag of its own - it's independent of reverse_proxy_enabled, since "proxy" always
    # runs regardless. So unlike INTERNAL_CALL_SERVICES/sync_compose_override's reverse-proxy
    # half, this always uses the full, unfiltered services string.
    forward_proxy_port_map = _forward_proxy_port_map_env(services)

    env = _read_env_file()
    env["REVERSE_PROXY_ENABLED"] = "true" if reverse_proxy_enabled else "false"
    env["INTERNAL_CALL_SERVICES"] = services
    env["FORWARD_PROXY_PORT_MAP"] = forward_proxy_port_map
    env["INTERNAL_CALLS_RETENTION_ROWS"] = _inbound_retention_rows(settings)
    if reverse_proxy_enabled:
        env["COMPOSE_PROFILES"] = "inbound-logging"
    else:
        env.pop("COMPOSE_PROFILES", None)
    _write_env_file(env)

    print(f"Inbound logging feature: {'enabled' if reverse_proxy_enabled else 'disabled'}, "
          f"projects: {services or '(none configured)'} (settings.properties - edit and re-run to change)")
    print(f"Outbound attribution: {forward_proxy_port_map or '(none configured)'}")
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


USAGE = "Usage: python3 start.py [--wildfly-proxy [on|off]]"


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
    wildfly_action = _parse_toggle_args(sys.argv[1:])
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

    sys.exit(0)


if __name__ == "__main__":
    main()
