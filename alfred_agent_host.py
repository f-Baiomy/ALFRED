#!/usr/bin/env python3
"""
alfred_agent_host.py - attaches Alfred's agent for the DOCKER install, the way the native install's supervisor does.

A container cannot reach a JVM on the host, so the Docker install had no automatic attach: the app got only start.py's
one-shot proxy-on step, and nothing when it restarted while Docker ran. This runs on the host next to the Docker stack
(start.py/restart.py start it in the background, stop.py stops it) and reuses the supervisor's own AgentAttacher and
AppWatcher (packaging/launcher/supervisor.py):

- it watches every project's upstream port (INTERNAL_CALL_SERVICES in this folder's .env) and tells the Docker
  backend when an app appears or restarts - the backend decides by the project's attach mode, as natively;
- it serves the two control calls the backend makes to attach (GET /status, POST /agents/attach), on
  ALFRED_AGENT_HOST_PORT with the token ALFRED_AGENT_HOST_TOKEN from .env - the backend reaches it at
  host.docker.internal;
- the agent reports to the Docker Alfred (ALFRED_ATTACH_URL, default http://localhost:3000) with its secret.

The first Alfred keeps the agent: a JVM whose agent reports to another running Alfred (the native install) is left
alone until that one stops and its agent stands down; then this one attaches.

Needs the agent and attach-cli jars (start.py builds them with Docker Maven into build/agent-host/app) and a JDK 21+
on the host to run attach-cli (found by find_java()).

Usage: python alfred_agent_host.py [--foreground]     (start.py runs it detached)
       python alfred_agent_host.py --stop
"""

import glob
import json
import logging
import logging.handlers
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(SCRIPT_DIR, "packaging", "launcher"))

import alfred_settings  # noqa: E402

HOME = os.path.join(SCRIPT_DIR, "build", "agent-host")
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")
RUN_FILE = os.path.join(HOME, "run.json")
DEFAULT_PORT = 3098
# The Docker Alfred unreachable this long (after it answered once) means it was stopped without stop.py: exit.
GONE_SECONDS = 300

log = logging.getLogger("agent-host")


def java_major(java):
    try:
        out = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return 0
    match = re.search(r'version "(\d+)(?:\.(\d+))?', out.stderr + out.stdout)
    if not match:
        return 0
    major = int(match.group(1))
    return int(match.group(2) or 0) if major == 1 else major


def find_java(minimum=21):
    """A java (JDK 21+, attach-cli's target) on this machine: ALFRED_ATTACH_JAVA, the native install's bundled one,
    JAVA_HOME, then the usual JDK folders. None when there is none."""
    exe = "java.exe" if os.name == "nt" else "java"
    candidates = [os.environ.get("ALFRED_ATTACH_JAVA", "")]
    alfred_home = os.environ.get("ALFRED_HOME") or (r"C:\alfred" if os.name == "nt" else "/opt/alfred")
    candidates.append(os.path.join(alfred_home, "runtime", "java", "bin", exe))
    if os.environ.get("JAVA_HOME"):
        candidates.append(os.path.join(os.environ["JAVA_HOME"], "bin", exe))
    patterns = [os.path.join(os.path.expanduser("~"), ".jdks", "*", "bin", exe)]
    if os.name == "nt":
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", "")):
            if root:
                patterns += [os.path.join(root, vendor, "*", "bin", exe)
                             for vendor in ("Java", "Eclipse Adoptium", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft")]
    else:
        patterns += ["/usr/lib/jvm/*/bin/java", "/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java"]
    for pattern in patterns:
        candidates += sorted(glob.glob(pattern), reverse=True)
    for java in candidates:
        if java and os.path.isfile(java) and java_major(java) >= minimum:
            return java
    return None


class DockerLayout:
    """What attach_cli and the supervisor's attacher need from an install, for the Docker one: the jars start.py
    built, a JDK found on the host, the Docker proxy's CA, and the Docker .env as the settings."""

    def __init__(self, java):
        self.home = HOME
        self.app = os.path.join(HOME, "app")
        self.certs = os.path.join(SCRIPT_DIR, "proxy", "certs")
        self.java = java

    def settings(self):
        env = alfred_settings.read_env_file(ENV_FILE) if os.path.exists(ENV_FILE) else {}
        env.setdefault("WEBHOOK_SECRET", alfred_settings.DOCKER_WEBHOOK_SECRET)
        return env

    def local_url(self, settings=None):
        return os.environ["ALFRED_ATTACH_URL"]

    def version(self):
        return "docker"


class Host:
    """The supervisor as AgentAttacher and AppWatcher see it: layout, settings, events to the backend, stopping."""

    def __init__(self, layout):
        import supervisor
        self.layout = layout
        self.settings = layout.settings()
        self.stopping = threading.Event()
        self.agents = supervisor.AgentAttacher(self)
        self.apps = supervisor.AppWatcher(self)
        self.reached_at = 0.0
        self.reached_once = False

    def changed_agents(self):
        if not self.stopping.is_set():
            self._post_event({"name": "AGENTS", "state": "CHANGED", "at": _now()})

    def _post_event(self, payload):
        request = urllib.request.Request(os.environ["ALFRED_ATTACH_URL"] + "/server/supervisor-events",
                                         data=json.dumps(payload).encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "X-Webhook-Secret": os.environ["ALFRED_ATTACH_SECRET"]})

        def send():
            try:
                urllib.request.urlopen(request, timeout=3).close()
            except Exception:  # noqa: BLE001 - the backend may be starting; it asks for every project once ready
                pass

        threading.Thread(target=send, daemon=True).start()

    def backend_answers(self):
        try:
            urllib.request.urlopen(os.environ["ALFRED_ATTACH_URL"] + "/health", timeout=3).close()
            return True
        except urllib.error.HTTPError:
            return True  # something answered: the gateway and backend are up
        except Exception:  # noqa: BLE001
            return False


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def handler_for(host, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug("control: " + fmt, *args)

        def _reply(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _allowed(self):
            if not token or self.headers.get("X-Alfred-Control-Token") != token:
                self._reply(401, {"error": "token"})
                return False
            return True

        def do_GET(self):  # noqa: N802
            if not self._allowed():
                return
            if self.path == "/status":
                self._reply(200, {"processes": [], "agents": host.agents.status(), "apps": host.apps.status(),
                                  "version": "docker", "home": SCRIPT_DIR, "pid": os.getpid()})
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if not self._allowed():
                return
            if self.path != "/agents/attach":
                self._reply(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except ValueError:
                self._reply(400, {"error": "bad json"})
                return
            project = str(body.get("project") or "")
            features = [str(f) for f in body.get("features") or ["db", "logs", "redis"]]
            if not project or any(f not in ("proxy", "db", "logs", "redis") for f in features):
                self._reply(400, {"error": "project and features (proxy, db, logs, redis) are required"})
                return
            host.settings = host.layout.settings()
            self._reply(202, {"accepted": host.agents.ask(project, features, bool(body.get("force")))})

    return Handler


def read_run():
    try:
        with open(RUN_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def stop_running():
    """Stops the helper a previous start left running (its pid is in build/agent-host/run.json)."""
    pid = read_run().get("pid")
    if not pid or pid == os.getpid():
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
        else:
            os.kill(int(pid), signal.SIGTERM)
    except OSError:
        pass
    try:
        os.remove(RUN_FILE)
    except OSError:
        pass


def ensure_env(env_file=ENV_FILE):
    """Adds the agent host's port and token to .env when missing, before docker compose reads it - the backend gets
    them from there (docker-compose.yml) and so does the agent host."""
    import secrets
    env = alfred_settings.read_env_file(env_file) if os.path.exists(env_file) else {}
    lines = []
    if not env.get("ALFRED_AGENT_HOST_TOKEN"):
        lines.append(f"ALFRED_AGENT_HOST_TOKEN={secrets.token_hex(24)}")
    if not env.get("ALFRED_AGENT_HOST_PORT"):
        lines.append(f"ALFRED_AGENT_HOST_PORT={DEFAULT_PORT}")
    if lines:
        with open(env_file, "a", encoding="utf-8") as f:
            f.write("\n# The agent host (alfred_agent_host.py) - written by start.py\n" + "\n".join(lines) + "\n")


# (module, built jar, name in build/agent-host/app)
JARS = (("db-agent", "alfred-agent.jar", "alfred-agent.jar"), ("attach-cli", "attach-cli.jar", "attach-cli.jar"))


def _newest(folder):
    newest = 0.0
    for root, _, files in os.walk(folder):
        for name in files:
            newest = max(newest, os.path.getmtime(os.path.join(root, name)))
    return newest


def build_jars():
    """Builds the agent and attach-cli with Docker Maven (JDK 21, no JDK needed on the host for this) when a jar is
    missing or older than its sources, and copies them into build/agent-host/app. Returns False when a build failed."""
    import shutil
    app = os.path.join(HOME, "app")
    os.makedirs(app, exist_ok=True)
    ok = True
    for module, built, name in JARS:
        target = os.path.join(app, name)
        sources = max(_newest(os.path.join(SCRIPT_DIR, module, "src", "main")),
                      os.path.getmtime(os.path.join(SCRIPT_DIR, module, "pom.xml")))
        if os.path.isfile(target) and os.path.getmtime(target) >= sources:
            continue
        print(f"Building {name} with Docker Maven (about a minute the first time)...")
        command = ["docker", "run", "--rm", "-v", f"{SCRIPT_DIR}:/repo", "-v", "alfred-m2:/root/.m2",
                   "-w", f"/repo/{module}", "maven:3.9-eclipse-temurin-21", "mvn", "-B", "-q", "package", "-DskipTests"]
        env = dict(os.environ, MSYS_NO_PATHCONV="1")
        result = subprocess.run(command, env=env)
        jar = os.path.join(SCRIPT_DIR, module, "target", built)
        if result.returncode != 0 or not os.path.isfile(jar):
            print(f"Could not build {name} - the agent host cannot attach until it is built.")
            ok = False
            continue
        shutil.copyfile(jar, target)
    return ok


def running():
    """True when the agent host recorded in build/agent-host/run.json is still alive."""
    pid = read_run().get("pid")
    if not pid:
        return False
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def start_detached():
    """Starts the helper in the background (start.py/restart.py), replacing one already running."""
    stop_running()
    os.makedirs(HOME, exist_ok=True)
    out = open(os.path.join(HOME, "agent-host.out"), "ab")
    argv = [sys.executable, os.path.abspath(__file__), "--foreground"]
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        subprocess.Popen(argv, stdout=out, stderr=out, stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    else:
        subprocess.Popen(argv, stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True)
    print(f"Agent host started in the background (log: {os.path.join(HOME, 'agent-host.log')}).")


def run():
    os.makedirs(HOME, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(os.path.join(HOME, "agent-host.log"), maxBytes=1_000_000,
                                                   backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[handler, logging.StreamHandler(sys.stdout)])
    env = alfred_settings.docker_attach_env(ENV_FILE)
    os.environ["ALFRED_ATTACH_URL"] = env["ALFRED_ATTACH_URL"]
    os.environ["ALFRED_ATTACH_SECRET"] = env["ALFRED_ATTACH_SECRET"]
    docker_env = alfred_settings.read_env_file(ENV_FILE) if os.path.exists(ENV_FILE) else {}
    token = docker_env.get("ALFRED_AGENT_HOST_TOKEN", "")
    port = int(docker_env.get("ALFRED_AGENT_HOST_PORT") or DEFAULT_PORT)
    if not token:
        log.error("ALFRED_AGENT_HOST_TOKEN is not in .env - run start.py or restart.py, which add it")
        return 1
    java = find_java()
    if java is None:
        log.error("No JDK 21 or newer found to run attach-cli - install one, or set ALFRED_ATTACH_JAVA to its java")
    layout = DockerLayout(java or "java")
    for jar in ("attach-cli.jar", "alfred-agent.jar"):
        if not os.path.isfile(os.path.join(layout.app, jar)):
            log.error("%s is missing in %s - run start.py or restart.py, which build it", jar, layout.app)
            return 1

    host = Host(layout)
    # Docker Desktop (Windows, Mac) delivers host.docker.internal to the host's loopback, so 127.0.0.1 is enough and
    # nothing else on the network sees the port. On Linux host-gateway is the docker0 bridge address, which a
    # loopback listener does not answer: every interface there. Every call needs the token either way.
    bind = "0.0.0.0" if sys.platform.startswith("linux") else "127.0.0.1"
    server = ThreadingHTTPServer((bind, port), handler_for(host, token))
    threading.Thread(target=server.serve_forever, name="control", daemon=True).start()
    with open(RUN_FILE, "w", encoding="utf-8") as f:
        json.dump({"pid": os.getpid(), "port": port}, f)
    log.info("Agent host (pid %s) on port %s for the Docker Alfred at %s, java %s",
             os.getpid(), port, os.environ["ALFRED_ATTACH_URL"], java)

    def on_signal(signum, frame):
        host.stopping.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    last_seen = time.monotonic()
    next_check = 0.0
    while not host.stopping.wait(1):
        host.settings = layout.settings()
        if host.apps.due():
            host.apps.tick()
        if time.monotonic() >= next_check:
            next_check = time.monotonic() + 15
            if host.backend_answers():
                host.reached_once = True
                last_seen = time.monotonic()
            elif host.reached_once and time.monotonic() - last_seen > GONE_SECONDS:
                log.info("The Docker Alfred has not answered for %s s - stopping", GONE_SECONDS)
                break
    server.shutdown()
    if read_run().get("pid") == os.getpid():
        os.remove(RUN_FILE)
    return 0


def main(argv):
    if "--stop" in argv:
        stop_running()
        return 0
    if "--foreground" in argv:
        return run()
    start_detached()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
