"""Alfred log agent - reports file changes in the watched log folders to Alfred's backend.

Why it exists: Docker Desktop (Windows/macOS) does not pass the host's file-change notifications into
containers, so the backend - which reads the watched folders through read-only mounts - would never be
told a log line was written. This agent receives the OS notifications (ReadDirectoryChangesW on Windows,
FSEvents on macOS, inotify on Linux, through the 'watchdog' package) and reports "this file changed" to
the backend. Only that notification crosses: the backend reads the new bytes itself. Nothing runs on a
timer: the agent sleeps until the OS wakes it.

Started and stopped by start.py / restart.py / stop.py (alfred_logwatch.py). Settings come from the repo's
.env: ALFRED_LOGS_WATCH_DIRS (name:path,...), ALFRED_LOGS_AGENT_SECRET, BACKEND_PORT.
"""

import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from alfred_logwatch import parse_dirs  # noqa: E402

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError:  # pragma: no cover - installed by start.py
    print("The log agent needs the 'watchdog' package: python -m pip install watchdog")
    sys.exit(1)

logging.basicConfig(filename=os.path.join(HERE, "agent.log"), level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("alfred-log-agent")

# A burst of writes (a busy logger) is sent as one report; this is how long a burst may gather after the
# first notification wakes the sender - it is not a polling interval: with no notification, nothing runs.
GATHER_SECONDS = 0.02
MAX_BATCH = 1000


def read_env():
    env = {}
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


class Reporter:
    """Collects changed paths and sends them as soon as the OS reports them."""

    def __init__(self, url, secret):
        self.url = url
        self.secret = secret
        self.pending = {}  # (folder, path) -> None, insertion-ordered and de-duplicated
        self.cond = threading.Condition()
        self.connected = False

    def add(self, folder, path):
        with self.cond:
            self.pending[(folder, path)] = None
            self.cond.notify()

    def post(self, endpoint, body):
        req = urllib.request.Request(self.url + endpoint, data=json.dumps(body).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "X-Agent-Secret": self.secret})
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()

    def hello(self):
        """Tells the backend the agent is (back) up; it then re-checks every watched file, so nothing
        written while the agent or the backend was down is missed."""
        while True:
            try:
                self.post("/logs/agent/hello", {})
                self.connected = True
                log.info("Connected to %s", self.url)
                return
            except (urllib.error.URLError, OSError) as e:
                log.info("Backend not reachable yet (%s) - retrying in 3 s", e)
                time.sleep(3)  # only while the backend is down

    def run(self):
        self.hello()
        while True:
            with self.cond:
                while not self.pending:
                    self.cond.wait()  # sleeps until the OS reports a change
            time.sleep(GATHER_SECONDS)
            with self.cond:
                batch = list(self.pending.keys())[:MAX_BATCH]
                for k in batch:
                    self.pending.pop(k, None)
            try:
                self.post("/logs/agent/changes", {"changes": [{"folder": f, "path": p} for f, p in batch]})
            except urllib.error.HTTPError as e:
                log.error("Backend refused the report (%s) - check ALFRED_LOGS_AGENT_SECRET", e.code)
            except (urllib.error.URLError, OSError) as e:
                log.warning("Backend unreachable (%s) - reconnecting", e)
                self.connected = False
                self.hello()  # its rescan covers the lost report


class Handler(FileSystemEventHandler):
    def __init__(self, reporter, folder, root):
        self.reporter = reporter
        self.folder = folder
        self.root = os.path.abspath(root)

    def _report(self, path):
        rel = os.path.relpath(os.path.abspath(path), self.root).replace("\\", "/")
        if not rel.startswith(".."):
            self.reporter.add(self.folder, rel)

    def on_any_event(self, event):
        if event.is_directory:
            return
        self._report(event.src_path)
        dest = getattr(event, "dest_path", None)
        if dest:
            self._report(dest)  # a rename: both the old and the new name changed


def main():
    env = read_env()
    dirs = parse_dirs(env.get("ALFRED_LOGS_WATCH_DIRS", ""))
    secret = env.get("ALFRED_LOGS_AGENT_SECRET", "")
    port = env.get("BACKEND_PORT", "5000")
    if not dirs or not secret:
        log.error("Nothing to watch (ALFRED_LOGS_WATCH_DIRS) or no ALFRED_LOGS_AGENT_SECRET in .env")
        return 1
    reporter = Reporter(f"http://127.0.0.1:{port}", secret)
    observer = Observer()
    for name, path in dirs:
        root = path if os.path.isabs(path) else os.path.join(ROOT, path)
        if not os.path.isdir(root):
            log.warning("Watched folder %s does not exist: %s", name, root)
            continue
        observer.schedule(Handler(reporter, name, root), root, recursive=True)
        log.info("Watching %s -> %s", name, root)
    observer.start()
    try:
        reporter.run()
    finally:
        observer.stop()
        observer.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
