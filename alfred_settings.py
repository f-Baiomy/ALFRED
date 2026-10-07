"""
alfred_settings.py - the settings grammar shared by every host-side script.

One implementation of: settings.properties parsing (with ${ENV:default} placeholders), .env reading,
the INTERNAL_CALL_SERVICES project grammar ("name:listenPort:upstreamPort[:outboundHost[:outboundPort]]"),
the ALFRED_LOGS_WATCH_DIRS folder grammar ("name:path", split on the FIRST colon so Windows paths
survive), and the mitmdump command lines built from them.

Used by start.py/restart.py (Docker install) and by packaging/launcher/supervisor.py (native install,
specs/012-server-program). The backend's backend-server slice has the Java port of the two grammars;
both run the same test vectors (specs/012-server-program/fixtures/services-grammar.json) so they
cannot drift. In the native install this module never WRITES .env - ServerConfigCli does (research R7);
write_env_file is the Docker path's legacy writer only.
"""

import os
import re


# Internal container ports on the "proxy" service assigned to per-project outbound-attribution
# listeners start here - see forward_proxy_assignments() below for why.
FORWARD_PROXY_INTERNAL_PORT_BASE = 20000


DEFAULT_INBOUND_RETENTION_ROWS = "1500"


PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}")


def service_listen_ports(services):
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


def parse_service_entries(services):
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


def forward_proxy_assignments(services):
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
    for index, entry in enumerate(parse_service_entries(services)):
        if not entry["outbound_host"]:
            continue
        assignments.append({
            "name": entry["name"],
            "outbound_host": entry["outbound_host"],
            "outbound_port": entry["outbound_port"],
            "internal_port": FORWARD_PROXY_INTERNAL_PORT_BASE + index,
        })
    return assignments


def forward_proxy_port_map_env(services):
    """Builds the FORWARD_PROXY_PORT_MAP env var value - "name:internalPort" pairs, comma-
    separated - consumed by proxy/forward-proxy-entrypoint.sh (turns each pair into an extra
    "--mode regular@<internalPort>" listener) and by proxy/log_and_route.py (resolves
    service_name from the internal port a flow arrived on). Independent of
    reverse_proxy_enabled - outbound attribution has no such feature flag, since the "proxy"
    service is always running regardless."""
    return ",".join(
        f'{a["name"]}:{a["internal_port"]}' for a in forward_proxy_assignments(services)
    )


def inbound_retention_rows(settings):
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


def resolve_placeholders(value):
    """Resolves ${ENV_VAR} / ${ENV_VAR:default} placeholders in a settings.properties value
    against the process environment - the same ${x:default} syntax application.properties already
    uses for Spring, so a setting here can pull from the environment (e.g. differs per machine, or
    is injected by CI) instead of a value hardcoded into the file everyone shares.

    A placeholder whose variable is unset and has no ":default" is left as the literal
    "${VAR}" text rather than resolved to an empty string, so a required-but-missing value stays
    visibly wrong (and easy to grep for) instead of silently blank."""

    def replace(match):
        var, default = match.group(1), match.group(2)
        if var in os.environ:
            return os.environ[var]
        return default if default is not None else match.group(0)

    return PLACEHOLDER_RE.sub(replace, value)


def parse_settings_properties(settings_file):
    """Extracts every key=value line from settings.properties (see its own doc) - blank lines,
    lines starting with #, and anything without an "=" are ignored. A value may reference
    ${ENV_VAR} or ${ENV_VAR:default} - see resolve_placeholders."""
    settings = {}
    if not os.path.exists(settings_file):
        return settings
    with open(settings_file, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line or "=" not in line:
                continue
            key, _, value = line.partition("=")
            settings[key.strip()] = resolve_placeholders(value.strip())
    return settings


def read_env_file(env_file):
    env = {}
    if not os.path.exists(env_file):
        return env
    with open(env_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def write_env_file(env_file, env):
    with open(env_file, "w", encoding="utf-8") as f:
        for key, value in env.items():
            f.write(f"{key}={value}\n")


WATCH_DIR_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")


def parse_watch_dirs(value, warn=print):
    """'name:path,name:path' -> [(name, path)]. Windows paths keep their drive letter (split on the
    FIRST colon). Entries with an invalid name or an empty path are skipped (and reported)."""
    out = []
    for entry in (value or "").split(","):
        entry = entry.strip()
        if ":" not in entry:
            continue
        name, path = entry.split(":", 1)
        name, path = name.strip(), path.strip()
        if not WATCH_DIR_NAME.match(name):
            warn(f"logs_watch_dirs: skipping '{entry}' - a name is letters, digits, '-' or '_' (max 40)")
            continue
        if not path:
            continue
        out.append((name, path))
    return out


def split_listen(address, default_host="127.0.0.1"):
    """'127.0.0.2:443' -> ('127.0.0.2', 443); '8443' -> (default_host, 8443); '[::1]:8443' -> ('::1', 8443)."""
    address = (address or "").strip()
    if address.startswith("["):
        host, _, port = address[1:].partition("]:")
        return host, int(port)
    if ":" in address:
        host, _, port = address.rpartition(":")
        return host, int(port)
    return default_host, int(address)


def native_forward_proxy_port_map(services):
    """FORWARD_PROXY_PORT_MAP for the native install: "name:host:port" per project with outbound attribution. Natively
    each listener binds outboundHost:outboundPort itself, and two projects may share a port on different loopback
    addresses, so log_and_route.py matches the (host, port) a flow arrived on rather than the port alone."""
    return ",".join(
        f'{e["name"]}:{e["outbound_host"]}:{e["outbound_port"]}' for e in parse_service_entries(services) if e["outbound_host"]
    )


def proxy_command_lines(env, mitmdump, addon_dir, confdir, upstream_host="127.0.0.1"):
    """The OUTBOUND and REVERSE mitmdump argument lists for the native install
    (contracts/supervisor-and-agent.md), built from the effective settings in `env`.

    `mitmdump` is the argv prefix that starts mitmdump (e.g. [python, "-c", "...mitmdump()"]).
    Returns {"OUTBOUND": [...], "REVERSE": [...] or None}. REVERSE is None when inbound logging is
    off or no project is configured - the same rule docker-compose.yml's "inbound-logging" profile
    and reverse-proxy-entrypoint.sh's idle branch implement for Docker. Outbound attribution
    listeners bind outboundHost:outboundPort directly (no container port mapping natively)."""
    services = env.get("INTERNAL_CALL_SERVICES", "")
    entries = parse_service_entries(services)

    host, port = split_listen(env.get("ALFRED_OUTBOUND_PROXY_LISTEN", "127.0.0.2:443"))
    outbound = list(mitmdump) + ["-q", "-s", os.path.join(addon_dir, "log_and_route.py"),
                                 "--mode", f"regular@{host}:{port}"]
    for entry in entries:
        if entry["outbound_host"]:
            outbound += ["--mode", f'regular@{entry["outbound_host"]}:{entry["outbound_port"]}']
    outbound += ["--set", f"confdir={confdir}", "--set", "connection_strategy=lazy"]

    reverse = None
    enabled = env.get("REVERSE_PROXY_ENABLED", "false").strip().lower() == "true"
    if enabled and entries:
        reverse = list(mitmdump) + ["-q", "-s", os.path.join(addon_dir, "log_and_route_reverse.py")]
        for entry in entries:
            reverse += ["--mode", f'reverse:http://{upstream_host}:{entry["upstream_port"]}@{entry["listen_port"]}']
        reverse += ["--set", f"confdir={confdir}", "--set", "connection_strategy=lazy",
                    "--set", "keep_host_header=true"]
    return {"OUTBOUND": outbound, "REVERSE": reverse}
