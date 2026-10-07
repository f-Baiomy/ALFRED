"""Alfred log agent - reports file changes in the watched log folders to Alfred's backend.

Why it exists: Docker Desktop (Windows/macOS) does not pass the host's file-change notifications into
containers, so the backend - which reads the watched folders through read-only mounts - would never be
told a log line was written. This agent receives the OS notifications (ReadDirectoryChangesW on Windows,
FSEvents on macOS, inotify on Linux, through the 'watchdog' package) and reports "this file changed" to
the backend. Only that notification crosses: the backend reads the new bytes itself.

One exception to "only notifications": Windows does not report writes to a file whose writer keeps it
open (every logger does - log4j2, logback) until that file is closed or rotated, so a live log would
arrive in bursts minutes apart. For the files Alfred is following (and only those - the backend lists
them), the agent therefore also checks the size every SIZE_CHECK_SECONDS and reports a change. That is
one metadata query per file, no content read, and nothing is sent while a file is unchanged.

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
# How often the followed files' sizes are checked: a new line reaches Alfred within this time.
SIZE_CHECK_SECONDS = 0.2
# How often the list of followed files is re-read from the backend (a watch added, a file rotated in).
FOLLOWED_REFRESH_SECONDS = 5


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
    # The native install's supervisor (specs/012-server-program) passes these in the environment, from its own .env
    # in the install folder; they win over a .env next to this repo.
    for key in ("ALFRED_LOGS_WATCH_DIRS", "ALFRED_LOGS_AGENT_SECRET", "BACKEND_PORT"):
        if os.environ.get(key):
            env[key] = os.environ[key]
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

    def get(self, endpoint):
        req = urllib.request.Request(self.url + endpoint, headers={"X-Agent-Secret": self.secret})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")

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


class SizeWatcher:
    """Reports the followed files whose size changed - the writes Windows does not notify about."""

    def __init__(self, reporter, roots):
        self.reporter = reporter
        self.roots = roots  # watched folder name -> absolute path on this machine
        self.files = []  # (folder, relative path, absolute path)
        self.sizes = {}  # absolute path -> last size seen (None = missing)
        self.refreshed_at = 0.0

    def refresh(self):
        try:
            listed = self.reporter.get("/logs/agent/followed").get("files", [])
        except (urllib.error.URLError, OSError, ValueError) as e:
            log.debug("Followed files not available (%s)", e)
            return
        files = []
        for f in listed:
            root = self.roots.get(f.get("folder"))
            rel = f.get("path") or ""
            if root is None or not rel:
                continue
            path = os.path.normpath(os.path.join(root, rel))
            if os.path.relpath(path, root).startswith(".."):
                continue  # never outside the watched folder
            files.append((f["folder"], rel, path))
            if path not in self.sizes:
                self.sizes[path] = self._size(path)  # first sight: the backend has already read up to here
        kept = {p for _, _, p in files}
        self.sizes = {p: s for p, s in self.sizes.items() if p in kept}
        if len(files) != len(self.files):
            log.info("Checking the size of %d followed file(s)", len(files))
        self.files = files

    @staticmethod
    def _size(path):
        try:
            return os.stat(path).st_size  # FILE_READ_ATTRIBUTES only: never blocks the writer's rotation
        except OSError:
            return None

    def run(self):
        while True:
            now = time.monotonic()
            if now - self.refreshed_at >= FOLLOWED_REFRESH_SECONDS:
                self.refreshed_at = now
                self.refresh()
            for folder, rel, path in self.files:
                size = self._size(path)
                if size != self.sizes.get(path):
                    self.sizes[path] = size
                    self.reporter.add(folder, rel)
            time.sleep(SIZE_CHECK_SECONDS)


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
    roots = {}
    for name, path in dirs:
        root = path if os.path.isabs(path) else os.path.join(ROOT, path)
        if not os.path.isdir(root):
            log.warning("Watched folder %s does not exist: %s", name, root)
            continue
        observer.schedule(Handler(reporter, name, root), root, recursive=True)
        roots[name] = os.path.abspath(root)
        log.info("Watching %s -> %s", name, root)
    observer.start()
    threading.Thread(target=SizeWatcher(reporter, roots).run, name="size-check", daemon=True).start()
    try:
        reporter.run()
    finally:
        observer.stop()
        observer.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
