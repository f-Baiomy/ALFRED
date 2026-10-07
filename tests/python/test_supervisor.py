"""packaging/launcher/supervisor.py: what it would start (pure), and how it supervises (fake children)."""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import supervisor  # noqa: E402
from layout import Layout  # noqa: E402

ENV_MAP = os.path.join(ROOT, "backend", "backend-server", "src", "main", "resources", "settings-env-map.json")
SLEEPER = [sys.executable, "-c", "import time; time.sleep(600)"]
CRASHER = [sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"]
BINDFAIL = [sys.executable, "-c", "import sys; print('OSError: [Errno 98] Address already in use'); sys.exit(1)"]


def make_home(env_lines=()):
    home = tempfile.mkdtemp(prefix="alfred-home-")
    os.makedirs(os.path.join(home, "app"))
    shutil.copy(ENV_MAP, os.path.join(home, "app", "settings-env-map.json"))
    shutil.copy(os.path.join(ROOT, "settings.properties"), os.path.join(home, "settings.properties"))
    with open(os.path.join(home, ".env"), "w", encoding="utf-8") as f:
        f.write("\n".join(env_lines) + "\n")
    layout = Layout(home)
    layout.make_dirs()
    return layout


class ProcessSpecsTest(unittest.TestCase):

    def specs(self, *env_lines):
        layout = make_home(env_lines)
        self.addCleanup(shutil.rmtree, layout.home, True)
        return layout, supervisor.process_specs(layout, layout.settings(), layout.env_map(), 3011)

    def test_defaults_run_backend_outbound_and_mcp_only(self):
        layout, specs = self.specs()
        self.assertIsNotNone(specs["BACKEND"])
        self.assertIsNotNone(specs["OUTBOUND"])
        self.assertIsNotNone(specs["MCP"])
        self.assertIsNone(specs["REVERSE"])
        self.assertIn("regular@127.0.0.2:443", specs["OUTBOUND"]["argv"])

    def test_backend_files_live_under_data_and_settings_reach_their_variables(self):
        layout, specs = self.specs("ALFRED_LOGS_DIR=./logs-drop", "ALFRED_MEMORY=3g", "ALFRED_UI_PORT=3100",
                                   "ALFRED_OUTBOUND_PROXY_LISTEN=127.0.0.2:8443", "INTERNAL_CALLS_RETENTION_ROWS=5000")
        env = specs["BACKEND"]["env"]
        for name in supervisor.APPDATA_FILES:
            self.assertTrue(env[name].startswith(layout.appdata), name)
        self.assertEqual(env["LOGS_ROOT_DIR"], os.path.join(layout.home, "logs-drop"))
        self.assertEqual(env["SERVER_PORT"], "3100")
        self.assertEqual(env["FORWARD_PROXY_DEFAULT_PORT"], "8443")
        self.assertEqual(env["ALFRED_RESEND_FORWARD_PROXY_HOST"], "127.0.0.2")
        self.assertEqual(env["INTERNAL_CALLS_RETENTION_ROWS"], "5000")
        self.assertEqual(env["ALFRED_RUNTIME"], "native")
        self.assertEqual(env["ALFRED_MCP_PORT"], "3011")
        self.assertIn("-Xmx3g", specs["BACKEND"]["argv"])
        self.assertEqual(specs["OUTBOUND"]["env"]["WEBHOOK_URL"], "http://127.0.0.1:3100/calls/webhook")

    def test_reverse_proxy_runs_with_projects_and_inbound_logging_on(self):
        layout, specs = self.specs("REVERSE_PROXY_ENABLED=true",
                                   "INTERNAL_CALL_SERVICES=a:9001:8080:127.0.0.3,b:9002:8081:127.0.0.4")
        self.assertIn("reverse:http://127.0.0.1:8080@9001", specs["REVERSE"]["argv"])
        self.assertEqual(specs["REVERSE"]["env"]["REVERSE_PROXY_UPSTREAM_HOST"], "127.0.0.1")
        self.assertEqual(specs["OUTBOUND"]["env"]["FORWARD_PROXY_PORT_MAP"], "a:127.0.0.3:443,b:127.0.0.4:443")
        self.assertIn("regular@127.0.0.3:443", specs["OUTBOUND"]["argv"])

    def test_log_agent_only_when_folders_exist_and_mode_is_agent(self):
        _, specs = self.specs("ALFRED_LOGS_WATCH_DIRS=app:/var/log/app", "ALFRED_LOGS_WATCH_MODE=agent")
        self.assertIsNotNone(specs["LOG_AGENT"])
        _, specs = self.specs("ALFRED_LOGS_WATCH_DIRS=app:/var/log/app", "ALFRED_LOGS_WATCH_MODE=events")
        self.assertIsNone(specs["LOG_AGENT"])
        _, specs = self.specs("ALFRED_LOGS_WATCH_MODE=agent")
        self.assertIsNone(specs["LOG_AGENT"])


class SupervisionTest(unittest.TestCase):

    def setUp(self):
        self.layout = make_home()
        self.sup = supervisor.Supervisor(self.layout)
        self.fake = {"BACKEND": {"argv": SLEEPER, "env": {}, "listeners": []},
                     "OUTBOUND": {"argv": SLEEPER, "env": {}, "listeners": ["127.0.0.2:443"]},
                     "REVERSE": None, "MCP": None, "LOG_AGENT": None}
        patcher = patch.object(supervisor, "process_specs", lambda *a, **k: {n: (dict(s) if s else None) for n, s in self.fake.items()})
        patcher.start()
        self.addCleanup(patcher.stop)
        no_events = patch.object(supervisor.Supervisor, "changed", lambda self, child: None)
        no_events.start()
        self.addCleanup(no_events.stop)
        fast = patch.object(supervisor, "BACKOFF_SECONDS", [0.05] * 5)
        fast.start()
        self.addCleanup(fast.stop)

    def tearDown(self):
        self.sup.stop_all()
        if self.sup.server:
            self.sup.server.shutdown()
        shutil.rmtree(self.layout.home, True)

    def wait_for(self, predicate, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.05)
        return False

    def test_starts_in_order_and_restarting_proxies_leaves_the_backend_alone(self):
        self.sup.start_all()
        backend_pid = self.sup.children["BACKEND"].proc.pid
        outbound_pid = self.sup.children["OUTBOUND"].proc.pid
        self.assertEqual(list(self.sup.children), ["BACKEND", "OUTBOUND"])

        self.sup.restart(["OUTBOUND", "REVERSE"])

        self.assertEqual(self.sup.children["BACKEND"].proc.pid, backend_pid)
        self.assertNotEqual(self.sup.children["OUTBOUND"].proc.pid, outbound_pid)
        self.assertEqual(self.sup.children["OUTBOUND"].state, "RUNNING")

    def test_a_child_that_keeps_crashing_is_given_up_after_five_crashes(self):
        self.fake["OUTBOUND"] = {"argv": CRASHER, "env": {}, "listeners": []}
        self.sup.start_all()
        child = self.sup.children["OUTBOUND"]
        self.assertTrue(self.wait_for(lambda: child.state == "CRASHED"), child.state)
        self.assertEqual(child.restarts, 4)
        self.assertIn("exited with code 3", child.detail)

    def test_a_bind_failure_names_the_setting_to_change(self):
        self.fake["OUTBOUND"] = {"argv": BINDFAIL, "env": {}, "listeners": ["127.0.0.2:443"]}
        self.sup.start_all()
        child = self.sup.children["OUTBOUND"]
        self.assertTrue(self.wait_for(lambda: "cannot listen" in child.detail), child.detail)
        self.assertIn("ALFRED_OUTBOUND_PROXY_LISTEN", child.detail)

    def test_reload_restarts_only_what_changed(self):
        self.sup.start_all()
        backend_pid = self.sup.children["BACKEND"].proc.pid
        self.fake["REVERSE"] = {"argv": SLEEPER, "env": {"X": "1"}, "listeners": []}
        self.assertEqual(self.sup.reload(), ["REVERSE"])
        self.assertEqual(self.sup.children["BACKEND"].proc.pid, backend_pid)
        self.assertEqual(self.sup.children["REVERSE"].state, "RUNNING")

    def test_the_control_api_needs_the_token(self):
        port = self.sup.serve_control()
        with open(self.layout.control_file, encoding="utf-8") as f:
            token = json.load(f)["token"]

        with self.assertRaises(urllib.error.HTTPError) as refused:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=5)
        self.assertEqual(refused.exception.code, 401)

        request = urllib.request.Request(f"http://127.0.0.1:{port}/status", headers={"X-Alfred-Control-Token": token})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertIn("processes", json.loads(response.read()))
        if os.name == "posix":
            self.assertEqual(os.stat(self.layout.control_file).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
