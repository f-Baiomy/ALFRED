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
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
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
                 "cannot assign requested address", "an attempt was made to access a socket",
                 # Spring Boot's own wording for the UI port ("Port 3000 was already in use").
                 "was already in use", "failed to bind", "eaddrinuse")
# What to change when a child cannot listen - the setting, not a generic hint. The Docker install on the same
# machine is the common cause: it holds 3000 and 127.0.0.2:443 too.
BIND_HINTS = {
    "BACKEND": "Change ALFRED_UI_PORT (alfred config set ALFRED_UI_PORT <port>), or stop whatever holds the port - "
               "an Alfred Docker install on this machine does.",
    "OUTBOUND": "Change ALFRED_OUTBOUND_PROXY_LISTEN (e.g. 127.0.0.3:443) or a project's outbound address, or stop "
                "whatever holds the port - an Alfred Docker install on this machine does.",
    "REVERSE": "Change the project's listen port (alfred project add NAME LISTEN_PORT APP_PORT).",
    "MCP": "The MCP port is chosen by the supervisor; restart Alfred to pick another.",
}

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


def job_object():
    """Windows: a job every child is assigned to, set to kill its processes when the job's last handle closes - that
    is, when the supervisor itself dies, however it dies (killed, crashed, the service stopped hard). Without it a
    java/python/node left behind keeps the UI and proxy ports, and the next start crashes on every one of them.
    Children of children (the regex worker mitmproxy spawns) are in the job too. None where it cannot be made."""
    if not WINDOWS:
        return None
    try:
        import ctypes
        import ctypes.wintypes as wintypes
        kernel32 = ctypes.windll.kernel32
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                             "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        job_object_extended_limit_information = 9
        if not kernel32.SetInformationJobObject(job, job_object_extended_limit_information, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel32.CloseHandle(job)
            return None
        return job
    except (AttributeError, OSError):
        return None


def assign_to_job(job, proc):
    """Puts a just-started child into the job. A failure is logged, not fatal: the child runs as before."""
    if job is None:
        return
    import ctypes
    if not ctypes.windll.kernel32.AssignProcessToJobObject(job, ctypes.c_void_p(int(proc._handle))):
        log.debug("could not assign pid %s to the job object (error %s)", proc.pid, ctypes.GetLastError())


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
        # The addon folder on the import path for the whole process, not only while mitmproxy loads the script
        # (it restores sys.path afterwards). The regex worker is a separate process started later (spawn on
        # Windows, forkserver on Linux) that imports regex_worker by name: Docker finds it through the working
        # directory, natively the working directory is the install folder, so a regex rule's first use failed
        # with ModuleNotFoundError.
        "PYTHONPATH": os.path.join(layout.app, "proxy"),
    }
    if kind == "OUTBOUND":
        env["WEBHOOK_URL"] = base + "/calls/webhook"
        env["FORWARD_PROXY_PORT_MAP"] = alfred_settings.native_forward_proxy_port_map(settings.get("INTERNAL_CALL_SERVICES", ""))
    else:
        env["WEBHOOK_URL"] = base + "/internal-calls/webhook"
        env["REVERSE_PROXY_PORT_MAP"] = settings.get("INTERNAL_CALL_SERVICES", "")
        env["REVERSE_PROXY_UPSTREAM_HOST"] = "127.0.0.1"
        # stamped into X-Alfred-Call so the db-agent reports to THIS Alfred whatever its own arguments say
        env["ALFRED_AGENT_URL"] = base
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
            assign_to_job(self.supervisor.job, self.proc)
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
                               + BIND_HINTS.get(self.name, "Change the port setting."))
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


class UpdateJob:
    """One update the backend asked for (POST /update): download the installer into data/updates, verify its sha256,
    run it detached from Alfred. Detached matters: the installer stops the service - this very process and, on
    Windows, the job object every child dies with - so it must not be a child of the supervisor, or it would be
    killed before it could replace anything. Progress is served on GET /update and pushed as a supervisor event.
    One job at a time; a finished one stays readable until the next start (the installer restarts Alfred anyway)."""

    STATES = ("IDLE", "DOWNLOADING", "VERIFYING", "INSTALLING", "FAILED")
    PROGRESS_EVERY = 0.5  # seconds between download-progress events

    def __init__(self, supervisor):
        self.supervisor = supervisor
        self.lock = threading.Lock()
        self.state = "IDLE"
        self.version = ""
        self.downloaded = 0
        self.total = 0
        self.error = ""

    def status(self):
        with self.lock:
            return {"state": self.state, "version": self.version, "downloadedBytes": self.downloaded,
                    "totalBytes": self.total, "error": self.error}

    def busy(self):
        with self.lock:
            return self.state in ("DOWNLOADING", "VERIFYING", "INSTALLING")

    def start(self, version, url, sha256_hex, size):
        """False when a job is already running. Otherwise the work happens on its own thread."""
        with self.lock:
            if self.state in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
                return False
            self.state, self.version, self.downloaded, self.total, self.error = "DOWNLOADING", version, 0, int(size or 0), ""
        threading.Thread(target=self._run, args=(url, sha256_hex), name="update", daemon=True).start()
        return True

    def _set(self, state, error=""):
        with self.lock:
            self.state, self.error = state, error
        log.info("update %s: %s%s", self.version, state.lower(), f" - {error}" if error else "")
        self.supervisor.changed_update()

    def _run(self, url, sha256_hex):
        import hashlib
        layout = self.supervisor.layout
        folder = os.path.join(layout.data, "updates")
        os.makedirs(folder, exist_ok=True)
        name = os.path.basename(urllib.parse.urlparse(url).path) or f"alfred-setup-{self.version}"
        target = os.path.join(folder, name)
        part = target + ".part"
        try:
            self._download(url, part)
            self._set("VERIFYING")
            digest = hashlib.sha256()
            with open(part, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest().lower() != (sha256_hex or "").strip().lower():
                os.remove(part)
                self._set("FAILED", f"the downloaded installer's checksum is {digest.hexdigest()[:12]}…, "
                                    f"the release says {(sha256_hex or '')[:12]}… - not running it")
                return
            os.replace(part, target)
            self._set("INSTALLING")
            launch_installer(target, layout.home, os.path.join(layout.logs, "update.log"))
        except Exception as e:  # noqa: BLE001 - every failure must end in the status, never in a dead thread
            try:
                if os.path.exists(part):
                    os.remove(part)
            except OSError:
                pass
            self._set("FAILED", f"{type(e).__name__}: {e}")

    def _download(self, url, part):
        request = urllib.request.Request(url, headers={"User-Agent": "alfred-update"})
        with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as out:
            length = response.headers.get("Content-Length")
            if length and length.isdigit():
                with self.lock:
                    self.total = int(length)
            told = 0.0
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                with self.lock:
                    self.downloaded += len(chunk)
                # The Server card's download bar re-fetches on each event: a few a second, not one per chunk.
                if time.monotonic() - told >= self.PROGRESS_EVERY:
                    told = time.monotonic()
                    self.supervisor.changed_update()


def launch_installer(path, home, log_path):
    """Runs the downloaded installer unattended, outside Alfred's process tree. Windows: a detached process that
    breaks away from the job object (it would die with the supervisor otherwise); the NSIS installer stops the
    service itself. Linux: a transient systemd unit where there is systemd (stopping alfred.service would kill a
    plain child in the service's cgroup, KillMode=mixed or not), else a new session."""
    with open(log_path, "ab") as log_file:
        if WINDOWS:
            argv = [path, "/S", f"/DIR={home}"]
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            try:
                subprocess.Popen(argv, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True,
                                 stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT)
            except PermissionError:
                # The supervisor itself sits in a job that forbids breaking away (a terminal's, a test harness's, some
                # service managers'): Windows answers "Access is denied" to the flag. Without it the installer is still
                # a detached process outside Alfred's own job object - it only shares whatever job the supervisor is in.
                log.info("update: the installer could not break away from the supervisor's job - launched detached without it")
                subprocess.Popen(argv, creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL,
                                 stdout=log_file, stderr=subprocess.STDOUT)
            return
        os.chmod(path, 0o755)
        command = ["sh", path, "--unattended", "--dir", home]
        if shutil.which("systemd-run") and os.path.isdir("/run/systemd/system"):
            unit = f"alfred-update-{int(time.time())}"
            subprocess.Popen(["systemd-run", "--unit", unit, "--collect", "--quiet", "--property=StandardOutput=append:" + log_path,
                              "--property=StandardError=append:" + log_path, *command], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        subprocess.Popen(command, start_new_session=True, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT)


class AgentAttacher:
    """Attaches Alfred's agent to a project's application by itself (docs/server.md "The agent attaches itself"):
    a project's app is the JVM listening on its upstream port, so no pid, no -javaagent line and no project name
    is ever typed. Backend asks (POST /agents/attach) when it sees calls for a project whose agent is not reporting,
    at its start, and when the Settings switch is turned on; one attempt per project at a time, a failed pid is not
    retried for RETRY_SECONDS unless forced. Every outcome is kept per project for the Server card and pushed as a
    supervisor event named AGENTS."""

    STATES = ("ATTACHED", "ATTACHING", "NO_JVM", "NOT_A_JVM", "FAILED", "NO_PROJECT")
    RETRY_SECONDS = 300

    def __init__(self, supervisor):
        self.supervisor = supervisor
        self.lock = threading.Lock()
        self.projects = {}
        self.busy = set()

    def status(self):
        with self.lock:
            return [dict(v, project=k) for k, v in sorted(self.projects.items())]

    def _set(self, project, **fields):
        with self.lock:
            entry = self.projects.setdefault(project, {"port": 0, "pid": 0, "state": "NO_JVM", "detail": "", "at": None, "features": ""})
            entry.update(fields, at=now_iso())
        log.info("agent %s: %s%s", project, fields.get("state", "").lower(), f" - {fields['detail']}" if fields.get("detail") else "")
        self.supervisor.changed_agents()

    def ask(self, project, features, force=False):
        """False when the same pid failed recently (and not forced) or an attempt is already running."""
        import attach_cli
        settings = getattr(self.supervisor, "settings", None) or self.supervisor.layout.settings()
        entry = next((p for p in attach_cli.projects(settings) if p["name"] == project), None)
        if entry is None:
            self._set(project, state="NO_PROJECT", detail=f"no project named {project} in INTERNAL_CALL_SERVICES")
            return False
        with self.lock:
            if project in self.busy:
                return False
            self.busy.add(project)
        threading.Thread(target=self._run, args=(project, int(entry["upstream_port"]), list(features), force, settings),
                         name=f"attach-{project}", daemon=True).start()
        return True

    def _run(self, project, port, features, force, settings):
        import attach_cli
        try:
            pid = attach_cli.listening_pid(port)
            if not pid:
                self._set(project, port=port, pid=0, state="NO_JVM", detail=f"nothing listens on port {port}", features="")
                return
            with self.lock:
                known = self.projects.get(project) or {}
            if not force and known.get("pid") == pid and known.get("state") in ("ATTACHED", "FAILED", "NOT_A_JVM") \
                    and ",".join(features) == known.get("features", "") and known.get("at") \
                    and (time.time() - _iso_to_epoch(known["at"])) < self.RETRY_SECONDS:
                return
            if attach_cli.visible_jvm(self.supervisor.layout, pid) is False:
                self._set(project, port=port, pid=pid, state="NOT_A_JVM", features="", detail=_not_a_jvm(pid, port))
                return
            self._set(project, port=port, pid=pid, state="ATTACHING", detail="", features=",".join(features))
            ok, detail = attach_cli.attach_pid(self.supervisor.layout, settings, pid, {"name": project, **_project_fields(settings, project)},
                                               features)
            self._set(project, port=port, pid=pid, state="ATTACHED" if ok else "FAILED", detail="" if ok else detail,
                      features=",".join(features))
        except Exception as e:  # noqa: BLE001 - an attach must never take the supervisor down
            self._set(project, port=port, pid=0, state="FAILED", detail=f"{type(e).__name__}: {e}", features="")
        finally:
            with self.lock:
                self.busy.discard(project)


def _not_a_jvm(pid, port):
    """Why {pid} cannot be attached to, naming both users when they differ - the usual cause on Windows is Alfred's
    service and the app running as different users without Alfred being allowed to act as the app's owner."""
    import attach_cli
    owner, me = attach_cli.owner_of(pid), attach_cli.current_user()
    if owner and me and owner != me and not attach_cli.privileged():
        return f"pid {pid} on port {port} runs as {owner}, Alfred as {me}: run Alfred as {owner} or as a service"
    if owner is None and me:
        return f"pid {pid} on port {port} is not a Java process {me} can see (another user's, or not Java)"
    return f"pid {pid} on port {port} is not a Java process"


class AppWatcher:
    """Watches every project's upstream port, so an app that starts (or restarts) is noticed within seconds - the
    AUTOMATIC attach mode (docs/server.md "The agent attaches itself"). A TCP connect to 127.0.0.1:<upstreamPort> every
    PROBE_SECONDS says whether something listens (milliseconds, no netstat); on not-listening -> listening the pid is
    looked up and an APP event is posted to the backend, which decides by the project's mode. While listening the pid
    is re-read every PID_SECONDS: a new pid is a restarted app, posted again. The watcher never attaches by itself and
    knows nothing about modes - watching is cheap, deciding is the backend's."""

    PROBE_SECONDS = 2
    PID_SECONDS = 15

    def __init__(self, supervisor, probe=None, pid_of=None):
        self.supervisor = supervisor
        self.probe = probe or _port_listening
        self.pid_of = pid_of
        self.lock = threading.Lock()
        self.apps = {}       # project -> {"port", "listening", "pid", "since", "pidCheckedAt"}
        self._last_tick = 0.0

    def status(self):
        with self.lock:
            return [dict(v, project=k) for k, v in sorted(self.apps.items())]

    def due(self, now=None):
        now = time.monotonic() if now is None else now
        return now - self._last_tick >= self.PROBE_SECONDS

    def tick(self, now=None):
        """One pass over the projects. Returns the events it posted (for tests)."""
        import attach_cli
        now = time.monotonic() if now is None else now
        self._last_tick = now
        settings = getattr(self.supervisor, "settings", None) or {}
        projects = {p["name"]: int(p["upstream_port"]) for p in attach_cli.projects(settings)}
        pid_of = self.pid_of or attach_cli.listening_pid
        events = []
        with self.lock:
            for gone in [name for name in self.apps if name not in projects]:
                del self.apps[gone]
        for name, port in projects.items():
            listening = bool(self.probe(port))
            with self.lock:
                app = self.apps.setdefault(name, {"port": port, "listening": False, "pid": 0, "since": None, "pidCheckedAt": 0.0})
                app["port"] = port
                was = app["listening"]
                old_pid = app["pid"]
            if listening and (not was or now - app["pidCheckedAt"] >= self.PID_SECONDS):
                pid = pid_of(port) or 0
                with self.lock:
                    app["pidCheckedAt"] = now
                if not was or (pid and old_pid and pid != old_pid):
                    with self.lock:
                        app.update(listening=True, pid=pid, since=now_iso())
                    events.append({"name": "APP", "state": "LISTENING", "project": name, "port": port, "pid": pid, "at": now_iso()})
                elif pid and not old_pid:
                    with self.lock:
                        app["pid"] = pid
            elif not listening and was:
                with self.lock:
                    app.update(listening=False, pid=0, since=now_iso())
                events.append({"name": "APP", "state": "GONE", "project": name, "port": port, "pid": 0, "at": now_iso()})
        for event in events:
            log.info("app %s: %s on port %s%s", event["project"], event["state"].lower(), event["port"],
                     f" (pid {event['pid']})" if event["pid"] else "")
            self.supervisor._post_event(event)
        return events


def _port_listening(port, timeout=0.3):
    import socket
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _iso_to_epoch(text):
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return 0


def _project_fields(settings, project):
    import attach_cli
    return next((p for p in attach_cli.projects(settings) if p["name"] == project), {})


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
        self.job = job_object()
        self.update = UpdateJob(self)
        self.agents = AgentAttacher(self)
        self.apps = AppWatcher(self)

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
                    "agents": self.agents.status(), "apps": self.apps.status(),
                    "version": self.layout.version(), "home": self.layout.home, "pid": os.getpid()}

    def changed(self, child):
        """Tell the backend a child changed state (it re-broadcasts it as a server-status-changed signal)."""
        if child.name == "BACKEND" or self.stopping.is_set():
            return
        self._post_event(dict(child.status(), at=now_iso()))

    def changed_update(self):
        """The update job moved on: the backend re-broadcasts it, the Server card re-fetches /server/update."""
        if self.stopping.is_set():
            return
        self._post_event(dict(self.update.status(), name="UPDATE", at=now_iso()))

    def changed_agents(self):
        """An attach attempt ended (or started): the Server card re-fetches /server/status."""
        if self.stopping.is_set():
            return
        self._post_event({"name": "AGENTS", "state": "CHANGED", "at": now_iso()})

    def _post_event(self, payload):
        settings = getattr(self, "settings", None) or {}
        body = json.dumps(payload).encode("utf-8")
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
                elif self.path == "/update":
                    self._reply(200, supervisor.update.status())
                elif self.path == "/agents":
                    self._reply(200, supervisor.agents.status())
                else:
                    self._reply(404, {"error": "not found"})

            def do_POST(self):
                if not self._authorized():
                    return
                if self.path == "/update":
                    try:
                        length = int(self.headers.get("Content-Length") or 0)
                        body = json.loads(self.rfile.read(length) or b"{}")
                        version, url = str(body["version"]), str(body["url"])
                        sha256_hex, size = str(body.get("sha256", "")), int(body.get("size") or 0)
                    except (ValueError, KeyError, TypeError) as e:
                        self._reply(400, {"error": f"bad request: {e}"})
                        return
                    if not url.lower().startswith(("https://", "http://", "file:")):
                        self._reply(400, {"error": "the installer URL must be http(s) or file"})
                        return
                    if not sha256_hex:
                        self._reply(400, {"error": "no checksum - the installer would run unverified"})
                        return
                    if supervisor.update.start(version, url, sha256_hex, size):
                        self._reply(202, {"accepted": True})
                    else:
                        self._reply(409, {**supervisor.update.status(), "error": "an update is already in progress"})
                elif self.path == "/restart/backend":
                    threading.Thread(target=supervisor.restart, args=(["BACKEND"],), daemon=True).start()
                    self._reply(202, {"accepted": True})
                elif self.path == "/restart/proxies":
                    threading.Thread(target=supervisor.restart, args=(["OUTBOUND", "REVERSE"],), daemon=True).start()
                    self._reply(202, {"accepted": True})
                elif self.path == "/reload":
                    self._reply(200, {"restarted": supervisor.reload()})
                elif self.path == "/agents/attach":
                    try:
                        length = int(self.headers.get("Content-Length") or 0)
                        body = json.loads(self.rfile.read(length) or b"{}")
                        project = str(body["project"])
                        features = [str(f) for f in body.get("features") or ["db", "logs", "redis"]]
                        force = bool(body.get("force"))
                    except (ValueError, KeyError, TypeError) as e:
                        self._reply(400, {"error": f"bad request: {e}"})
                        return
                    if not project or any(f not in ("proxy", "db", "logs", "redis") for f in features):
                        self._reply(400, {"error": "project and features (proxy, db, logs, redis) are required"})
                        return
                    self._reply(202, {"accepted": supervisor.agents.ask(project, features, force)})
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
        # Owner-only ACL: drop inherited entries, grant the file's owner (the running account), Administrators and
        # LocalSystem. By SID: the account was named from %USERNAME% before, which under LocalSystem is "MACHINE$" -
        # icacls refused it, and the refusal was thrown away.
        result = subprocess.run(["icacls", path, "/inheritance:r", "/grant:r", "*S-1-3-4:F", "/grant:r",
                                 "*S-1-5-32-544:F", "/grant:r", "*S-1-5-18:F"], capture_output=True, text=True)
        if result.returncode != 0:
            log.warning("Could not restrict %s to its owner and Administrators: %s", path,
                        (result.stdout + result.stderr).strip())


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
    # Under the Windows service stdout is a pipe in the ANSI code page; a character outside it (a check mark from
    # a tool's output) must not become a logging error. Replaced, not fatal.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
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
    # cannot be interrupted by a signal. The only work per wake-up is the app watcher's probe, every PROBE_SECONDS.
    while not done.wait(1):
        if supervisor.apps.due():
            try:
                supervisor.apps.tick()
            except Exception as e:  # noqa: BLE001 - watching must never take the supervisor down
                log.warning("app watcher: %s", e)
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
