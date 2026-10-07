"""
supervisor.py - "alfred run": the one long-running process of a native install (specs/012-server-program research R1).

It starts and watches the children, built from .env every time they start:

    BACKEND     bundled Java, alfred.jar (API, UI, /mcp relay)
    OUTBOUND    bundled Python, mitmdump + proxy/log_and_route.py
    REVERSE     bundled Python, mitmdump + proxy/log_and_route_reverse.py (only with inbound logging on and projects)
    MCP         bundled Node, mcp-server.mjs over Streamable HTTP on 127.0.0.1 (the backend relays /mcp to it)
    LOG_AGENT   bundled Python, log-agent/agent.py (Windows only, only when watched folders exist)

The supervisor - not the backend - owns the proxies, so "Restart Alfred" restarts the backend while the proxies keep
serving the user's apps (US4). The backend asks for restarts through a small control API on 127.0.0.1 guarded by a
token only the service account can read (data/run/control.json). There is no polling: one thread per child blocks in
wait(), and state changes are pushed to the backend.

A crashed child is restarted after 1, 2, 5, 10, then 30 seconds; after 5 crashes within 5 minutes it stays CRASHED
until a restart is asked for, so a child that can never start (a port in use, a bad setting) does not loop forever.
"""

import json
import logging
import logging.handlers
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # app/ (alfred_settings.py)

from layout import WINDOWS, Layout  # noqa: E402

log = logging.getLogger("alfred.supervisor")

BACKOFF_SECONDS = [1, 2, 5, 10, 30]
CRASH_WINDOW_SECONDS = 300
MAX_CRASHES_IN_WINDOW = 5
STOP_TIMEOUT_SECONDS = 20
LOG_BYTES = 10 * 1024 * 1024
LOG_FILES = 3
MCP_PORT_DEFAULT = 3009
MITMDUMP_PROGRAM = "from mitmproxy.tools.main import mitmdump; mitmdump()"
BIND_FAILURES = ("address already in use", "permission denied", "only one usage of each socket address",
                 "cannot assign requested address", "an attempt was made to access a socket")

# The backend's own files, under data/appdata unless noted: the same files docker-compose.yml points at /appdata.
APPDATA_FILES = {
    "RECENT_CALLS_FILE": "RECENT_CALLS.log", "COMMENTS_FILE": "comments.json",
    "SESSION_CYCLES_FILE": os.path.join("session-cycles", "session-cycles.json"), "SESSION_CYCLES_DIR": "session-cycles",
    "PROFILES_FILE": "profiles.json", "FILTER_SETTINGS_FILE": "filter-settings.json", "CALLS_DB_FILE": "calls.db",
    "SESSION_CYCLES_DB_FILE": "session-cycles.db", "PROFILES_DB_FILE": "profiles.db", "COMMENTS_DB_FILE": "comments.db",
    "FILTER_SETTINGS_DB_FILE": "settings.db", "TRIAGE_DB_FILE": "triage.db", "INTERNAL_CALLS_FILE": "internal-calls.log",
    "INTERCEPTION_DB_FILE": "interception.db", "SCENARIOS_DB_FILE": "scenarios.db", "LOGS_DB_LEGACY_FILE": "logs.db",
    "LOGS_UPLOAD_DIR": os.path.join("logs", "uploads"), "REDACTIONS_DB_FILE": "redactions.db",
    "REDACTIONS_FILE": "redactions.json", "RELIVE_DB_FILE": "relive.db", "INTERCEPTION_ANSWERS_DIR": "interception-answers",
    "INTERCEPTION_RULES_STORE_FILE": "interception-rules-store.json",
    "INTERNAL_SESSION_CYCLES_DIR": "session-cycles-internal",
}
# Shared with the proxies (Docker bind-mounts these from ./proxy).
FLAG_FILES = {
    "REVERSE_PROXY_TOGGLE_FILE": "reverse-proxy-enabled.flag", "DB_CAPTURE_TOGGLE_FILE": "db-capture-enabled.flag",
    "LOG_LINK_TOGGLE_FILE": "log-link-enabled.flag", "REDIS_CAPTURE_TOGGLE_FILE": "redis-capture-enabled.flag",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------------------------------------------------
# What to run (pure functions of the layout and the effective settings - tested without starting anything)
# ---------------------------------------------------------------------------------------------------------------------

def resolve_watch_mode(mode):
    """auto -> agent on Windows (the OS does not report writes to a file its writer keeps open), events elsewhere."""
    mode = (mode or "auto").strip().lower()
    if mode in ("events", "agent"):
        return mode
    return "agent" if WINDOWS else "events"


def mapped_backend_env(layout, settings, env_map):
    """Every user setting the backend reads, through settings-env-map.json (analysis U1)."""
    import alfred_settings
    env = {}
    for key, spec in env_map.items():
        value = settings.get(key, "")
        transform = spec.get("transform")
        if transform == "absolutePath":
            value = value if os.path.isabs(value) else os.path.normpath(os.path.join(layout.home, value or "."))
        elif transform == "resolveWatchMode":
            value = resolve_watch_mode(value)
        elif transform == "listenPortAndHost":
            host, port = alfred_settings.split_listen(value or "127.0.0.2:443")
            env["FORWARD_PROXY_DEFAULT_PORT"] = str(port)
            env["ALFRED_RESEND_FORWARD_PROXY_HOST"] = host
            continue
        for variable in spec.get("backendEnv", []):
            env[variable] = value
    return env


def backend_spec(layout, settings, env_map, mcp_port):
    env = {name: os.path.join(layout.appdata, rel) for name, rel in APPDATA_FILES.items()}
    env.update({name: os.path.join(layout.proxy_data, rel) for name, rel in FLAG_FILES.items()})
    env.update({
        "INTERCEPTION_RULES_FILE": os.path.join(layout.interception, "rules.json"),
        "INTERCEPTION_VARIABLES_FILE": os.path.join(layout.interception, "variables.json"),
        "LOGS_DB_FILE": os.path.join(layout.data, "logs.db"),
        "DB_CAPTURE_DB_FILE": os.path.join(layout.data, "db-capture.db"),
        "LOGS_WATCH_ROOT": "",
        "RECENT_CALLS_MAX_LIMIT": "200",
        "INTERCEPTION_MAX_ANSWER_BYTES": "10485760",
        "ALFRED_RESEND_REVERSE_PROXY_HOST": "127.0.0.1",
        "ALFRED_RESEND_MITM_CA_FILE": os.path.join(layout.certs, "mitmproxy-ca-cert.pem"),
        "ALFRED_RUNTIME": "native",
        "ALFRED_HOME": layout.home,
        "ALFRED_ENV_FILE": layout.env_file,
        "ALFRED_SETTINGS_DEFAULTS_FILE": layout.defaults_file,
        "ALFRED_CONTROL_FILE": layout.control_file,
        "ALFRED_DATA_DIR": layout.data,
        "ALFRED_EXPORT_DIR": layout.exports,
        "ALFRED_MCP_PORT": str(mcp_port),
        "ALFRED_VERSION": layout.version(),
    })
    env.update(mapped_backend_env(layout, settings, env_map))
    memory = (settings.get("ALFRED_MEMORY") or "2g").strip()
    argv = [layout.java, f"-Xmx{memory}", "-Djdk.httpclient.allowRestrictedHeaders=host", "-jar", layout.jar]
    return {"argv": argv, "env": env, "listeners": [f"0.0.0.0:{layout.ui_port(settings)} (UI, API, /mcp)"]}


def free_port(preferred):
    """The preferred loopback port when it is free, else any free one (chosen once per supervisor run)."""
    import socket
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return probe.getsockname()[1]
            except OSError:
                continue
    return preferred


def proxy_env(layout, settings, kind):
    """The variables docker-compose.yml gives each proxy container, with native values (research R14)."""
    import alfred_settings
    base = layout.local_url(settings)
    env = {
        "WEBHOOK_SECRET": settings.get("WEBHOOK_SECRET", ""),
        "INTERCEPTION_RULES_FILE": os.path.join(layout.interception, "rules.json"),
        "INTERCEPTION_VARIABLES_FILE": os.path.join(layout.interception, "variables.json"),
        "INTERCEPTION_API_URL": base,
        "INTERCEPTION_REGEX_TIMEOUT_MS": "2000",
        "INTERCEPTION_ANSWER_CACHE_BYTES": "33554432",
        "BACKEND_HOST": "127.0.0.1",
        "PYTHONUNBUFFERED": "1",
    }
    if kind == "OUTBOUND":
        env["WEBHOOK_URL"] = base + "/calls/webhook"
        env["FORWARD_PROXY_PORT_MAP"] = alfred_settings.native_forward_proxy_port_map(settings.get("INTERNAL_CALL_SERVICES", ""))
    else:
        env["WEBHOOK_URL"] = base + "/internal-calls/webhook"
        env["REVERSE_PROXY_PORT_MAP"] = settings.get("INTERNAL_CALL_SERVICES", "")
        env["REVERSE_PROXY_UPSTREAM_HOST"] = "127.0.0.1"
        env["TOGGLE_FILE"] = os.path.join(layout.proxy_data, FLAG_FILES["REVERSE_PROXY_TOGGLE_FILE"])
        env["DB_CAPTURE_TOGGLE_FILE"] = os.path.join(layout.proxy_data, FLAG_FILES["DB_CAPTURE_TOGGLE_FILE"])
        env["LOG_LINK_TOGGLE_FILE"] = os.path.join(layout.proxy_data, FLAG_FILES["LOG_LINK_TOGGLE_FILE"])
        env["REDIS_CAPTURE_TOGGLE_FILE"] = os.path.join(layout.proxy_data, FLAG_FILES["REDIS_CAPTURE_TOGGLE_FILE"])
    return env


def process_specs(layout, settings, env_map, mcp_port=MCP_PORT_DEFAULT):
    """{name: {"argv", "env", "listeners"} or None} - None means "should not run with these settings"."""
    import alfred_settings
    mitmdump = [layout.python, "-c", MITMDUMP_PROGRAM]
    lines = alfred_settings.proxy_command_lines(settings, mitmdump, os.path.join(layout.app, "proxy"), layout.certs)
    entries = alfred_settings.parse_service_entries(settings.get("INTERNAL_CALL_SERVICES", ""))
    outbound_listeners = [settings.get("ALFRED_OUTBOUND_PROXY_LISTEN") or "127.0.0.2:443"]
    outbound_listeners += [f'{e["outbound_host"]}:{e["outbound_port"]} ({e["name"]})' for e in entries if e["outbound_host"]]

    specs = {
        "BACKEND": backend_spec(layout, settings, env_map, mcp_port),
        "OUTBOUND": {"argv": lines["OUTBOUND"], "env": proxy_env(layout, settings, "OUTBOUND"), "listeners": outbound_listeners},
        "REVERSE": None,
        "MCP": {
            "argv": [layout.node, os.path.join(layout.app, "mcp", "dist", "mcp-server.mjs")],
            "env": {"ALFRED_MCP_TRANSPORT": "http", "ALFRED_MCP_PORT": str(mcp_port),
                    "ALFRED_URL": layout.local_url(settings), "ALFRED_EXPORT_DIR": layout.exports},
            "listeners": [f"127.0.0.1:{mcp_port} (behind /mcp)"],
        },
        "LOG_AGENT": None,
    }
    if lines["REVERSE"]:
        specs["REVERSE"] = {"argv": lines["REVERSE"], "env": proxy_env(layout, settings, "REVERSE"),
                            "listeners": [f'{e["listen_port"]} -> {e["upstream_port"]} ({e["name"]})' for e in entries]}
    watch_dirs = alfred_settings.parse_watch_dirs(settings.get("ALFRED_LOGS_WATCH_DIRS", ""), warn=lambda m: None)
    if watch_dirs and resolve_watch_mode(settings.get("ALFRED_LOGS_WATCH_MODE")) == "agent":
        specs["LOG_AGENT"] = {
            "argv": [layout.python, os.path.join(layout.app, "log-agent", "agent.py")],
            "env": {"ALFRED_LOGS_WATCH_DIRS": settings.get("ALFRED_LOGS_WATCH_DIRS", ""),
                    "ALFRED_LOGS_AGENT_SECRET": settings.get("ALFRED_LOGS_AGENT_SECRET", ""),
                    "BACKEND_PORT": str(layout.ui_port(settings)), "PYTHONUNBUFFERED": "1"},
            "listeners": [],
        }
    return specs


# ---------------------------------------------------------------------------------------------------------------------
# Running children
# ---------------------------------------------------------------------------------------------------------------------

class Child:
    """One supervised process. A thread blocks in wait() and decides what to do when it exits."""

    def __init__(self, name, supervisor):
        self.name = name
        self.supervisor = supervisor
        self.spec = None
        self.proc = None
        self.state = "STOPPED"
        self.started_at = None
        self.restarts = 0
        self.crashes = []
        self.detail = ""
        self.wanted = False
        self.lock = threading.RLock()
        self.tail = []
        self.output = self._logger()

    def _logger(self):
        logger = logging.getLogger(f"alfred.child.{self.name}")
        logger.propagate = False
        if not logger.handlers:
            handler = logging.handlers.RotatingFileHandler(
                os.path.join(self.supervisor.layout.logs, f"{self.name.lower()}.log"),
                maxBytes=LOG_BYTES, backupCount=LOG_FILES, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
        return logger

    def start(self, spec):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            self.spec = spec
            self.wanted = True
            self.tail = []
            env = dict(os.environ)
            env.update(spec["env"])
            flags = subprocess.CREATE_NEW_PROCESS_GROUP if WINDOWS else 0
            try:
                self.proc = subprocess.Popen(spec["argv"], env=env, cwd=self.supervisor.layout.home,
                                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                             creationflags=flags)
            except OSError as e:
                self.state = "CRASHED"
                self.detail = f"cannot start: {e}"
                log.error("%s: %s", self.name, self.detail)
                self.supervisor.changed(self)
                return
            self.state = "RUNNING"
            self.detail = ""
            self.started_at = now_iso()
            log.info("%s started (pid %s)", self.name, self.proc.pid)
            proc = self.proc
            threading.Thread(target=self._pump, args=(proc,), name=f"{self.name}-out", daemon=True).start()
            threading.Thread(target=self._wait, args=(proc,), name=f"{self.name}-wait", daemon=True).start()
            self.supervisor.changed(self)

    def _pump(self, proc):
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            self.output.info(line)
            self.tail.append(line)
            del self.tail[:-40]

    def stop(self):
        with self.lock:
            self.wanted = False
            proc = self.proc
        if not proc or proc.poll() is not None:
            with self.lock:
                self.state = "STOPPED"
            return
        log.info("%s stopping (pid %s)", self.name, proc.pid)
        try:
            if WINDOWS:
                # Windows has no SIGTERM for another console process; TerminateProcess is immediate. Every store
                # Alfred writes is crash-safe (SQLite transactions, temp file + atomic move), so this loses nothing
                # that a graceful stop would have kept.
                proc.terminate()
            else:
                proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            log.warning("%s did not stop in %ss - killing it", self.name, STOP_TIMEOUT_SECONDS)
            proc.kill()
            proc.wait()
        with self.lock:
            self.state = "STOPPED"
        self.supervisor.changed(self)

    def _wait(self, proc):
        code = proc.wait()
        with self.lock:
            if proc is not self.proc or not self.wanted:
                return
            text = "\n".join(self.tail).lower()
            if any(marker in text for marker in BIND_FAILURES):
                listen = ", ".join(self.spec.get("listeners") or [])
                self.detail = (f"cannot listen on {listen}: address in use or not permitted. "
                               "Change ALFRED_OUTBOUND_PROXY_LISTEN or the project's ports.")
            else:
                self.detail = f"exited with code {code}"
            now = time.monotonic()
            self.crashes = [t for t in self.crashes if now - t < CRASH_WINDOW_SECONDS] + [now]
            if len(self.crashes) >= MAX_CRASHES_IN_WINDOW:
                self.state = "CRASHED"
                log.error("%s crashed %s times in %ss - not restarting it (%s)", self.name, len(self.crashes),
                          CRASH_WINDOW_SECONDS, self.detail)
                self.supervisor.changed(self)
                return
            delay = BACKOFF_SECONDS[min(len(self.crashes) - 1, len(BACKOFF_SECONDS) - 1)]
            self.state = "RESTARTING"
            log.warning("%s %s - restarting in %ss", self.name, self.detail, delay)
            self.supervisor.changed(self)
        if self.supervisor.stopping.wait(delay):
            return
        with self.lock:
            if not self.wanted or self.proc is not proc:
                return
            self.restarts += 1
            self.proc = None
        self.start(self.supervisor.spec_for(self.name) or self.spec)

    def status(self):
        with self.lock:
            return {"name": self.name, "state": self.state,
                    "pid": self.proc.pid if self.proc and self.proc.poll() is None else 0,
                    "startedAt": self.started_at, "restarts": self.restarts,
                    "listeners": (self.spec or {}).get("listeners", []), "detail": self.detail}


class Supervisor:

    ORDER = ["BACKEND", "OUTBOUND", "REVERSE", "MCP", "LOG_AGENT"]

    def __init__(self, layout):
        self.layout = layout
        self.stopping = threading.Event()
        self.lock = threading.RLock()
        self.children = {}
        self.token = secrets.token_hex(32)
        self.server = None
        self.specs = {}
        self.mcp_port = free_port(MCP_PORT_DEFAULT)

    def spec_for(self, name):
        return self.specs.get(name)

    def refresh_specs(self):
        settings = self.layout.settings()
        self.specs = process_specs(self.layout, settings, self.layout.env_map(), self.mcp_port)
        self.settings = settings
        return self.specs

    def child(self, name):
        with self.lock:
            if name not in self.children:
                self.children[name] = Child(name, self)
            return self.children[name]

    def start_all(self):
        self.refresh_specs()
        for name in self.ORDER:
            spec = self.specs.get(name)
            if spec:
                self.child(name).start(spec)

    def stop_all(self):
        self.stopping.set()
        for name in reversed(self.ORDER):
            if name in self.children:
                self.children[name].stop()

    def restart(self, names):
        self.refresh_specs()
        for name in names:
            child = self.child(name)
            child.stop()
            child.crashes = []
            if self.specs.get(name):
                child.restarts += 1
                child.start(self.specs[name])

    def reload(self):
        """Re-read .env; restart only the non-backend children whose command or environment changed."""
        old = dict(self.specs)
        new = self.refresh_specs()
        restarted = []
        for name in self.ORDER[1:]:
            before, after = old.get(name), new.get(name)
            if before == after:
                continue
            child = self.child(name)
            child.stop()
            child.crashes = []
            if after:
                child.start(after)
            restarted.append(name)
        return restarted

    def status(self):
        with self.lock:
            return {"processes": [self.children[n].status() for n in self.ORDER if n in self.children],
                    "version": self.layout.version(), "home": self.layout.home, "pid": os.getpid()}

    def changed(self, child):
        """Tell the backend a child changed state (it re-broadcasts it as a server-status-changed signal)."""
        if child.name == "BACKEND" or self.stopping.is_set():
            return
        settings = getattr(self, "settings", None) or {}
        body = json.dumps(dict(child.status(), at=now_iso())).encode("utf-8")
        request = urllib.request.Request(self.layout.local_url(settings) + "/server/supervisor-events", data=body,
                                         method="POST", headers={"Content-Type": "application/json",
                                                                 "X-Webhook-Secret": settings.get("WEBHOOK_SECRET", "")})

        def send():
            try:
                urllib.request.urlopen(request, timeout=3).close()
            except Exception:  # noqa: BLE001 - the backend may be restarting; status is also served on request
                pass
        threading.Thread(target=send, daemon=True).start()

    # -- control API --------------------------------------------------------------------------------------------------

    def serve_control(self):
        supervisor = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                log.debug("control: " + fmt, *args)

            def _reply(self, code, payload):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self):
                given = self.headers.get("X-Alfred-Control-Token", "")
                if secrets.compare_digest(given, supervisor.token):
                    return True
                self._reply(401, {"error": "missing or wrong control token"})
                return False

            def do_GET(self):
                if not self._authorized():
                    return
                if self.path == "/status":
                    self._reply(200, supervisor.status())
                else:
                    self._reply(404, {"error": "not found"})

            def do_POST(self):
                if not self._authorized():
                    return
                if self.path == "/restart/backend":
                    threading.Thread(target=supervisor.restart, args=(["BACKEND"],), daemon=True).start()
                    self._reply(202, {"accepted": True})
                elif self.path == "/restart/proxies":
                    threading.Thread(target=supervisor.restart, args=(["OUTBOUND", "REVERSE"],), daemon=True).start()
                    self._reply(202, {"accepted": True})
                elif self.path == "/reload":
                    self._reply(200, {"restarted": supervisor.reload()})
                else:
                    self._reply(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        write_control_file(self.layout.control_file, self.server.server_address[1], self.token)
        threading.Thread(target=self.server.serve_forever, name="control", daemon=True).start()
        return self.server.server_address[1]


def write_control_file(path, port, token):
    """data/run/control.json, readable by the service account only (the token can restart Alfred)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    if os.path.exists(temp):
        os.remove(temp)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"port": port, "token": token, "pid": os.getpid()}, f)
    os.replace(temp, path)
    if WINDOWS:
        user = os.environ.get("USERNAME", "")
        # Owner-only ACL: drop inherited entries, grant the running account (LocalSystem by default) and Administrators.
        subprocess.run(["icacls", path, "/inheritance:r", "/grant:r", f"{user}:F", "/grant:r", "*S-1-5-32-544:F",
                        "/grant:r", "*S-1-5-18:F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check_env(layout):
    """Print .env lines that are not used (FR-016), through the Java settings engine - Python never parses .env
    rules on its own beyond reading values."""
    try:
        result = subprocess.run(layout.config_cli("check-env"), capture_output=True, text=True, timeout=60)
        for line in (result.stdout + result.stderr).splitlines():
            if line.strip():
                log.warning("%s", line)
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("Could not check .env: %s", e)


def main(home):
    layout = Layout(home)
    layout.make_dirs()
    handler = logging.handlers.RotatingFileHandler(os.path.join(layout.logs, "supervisor.log"), maxBytes=LOG_BYTES,
                                                   backupCount=LOG_FILES, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[handler, logging.StreamHandler(sys.stdout)])
    supervisor = Supervisor(layout)
    done = threading.Event()

    def on_signal(signum, frame):
        log.info("Stopping (signal %s)", signum)
        done.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    if WINDOWS and hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, on_signal)

    check_env(layout)
    port = supervisor.serve_control()
    log.info("Alfred %s supervisor (pid %s, control port %s, home %s)", layout.version(), os.getpid(), port, layout.home)
    supervisor.start_all()
    settings = supervisor.settings
    log.info("UI: %s", layout.local_url(settings).replace("127.0.0.1", "localhost"))
    # A short wait so Ctrl+C and service stop requests are seen promptly on Windows too, where a long Event.wait
    # cannot be interrupted by a signal. Nothing is checked on each wake-up.
    while not done.wait(1):
        pass
    supervisor.stop_all()
    if supervisor.server:
        supervisor.server.shutdown()
    try:
        os.remove(layout.control_file)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    from layout import home_from_here
    sys.exit(main(home_from_here()))
