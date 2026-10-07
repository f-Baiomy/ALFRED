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
        # the agent inside the app is told where this Alfred is on every request it serves
        self.assertEqual(specs["REVERSE"]["env"]["ALFRED_AGENT_URL"], layout.local_url(layout.settings()))
        self.assertEqual(specs["OUTBOUND"]["env"]["FORWARD_PROXY_PORT_MAP"], "a:127.0.0.3:443,b:127.0.0.4:443")
        self.assertIn("regular@127.0.0.3:443", specs["OUTBOUND"]["argv"])

    def test_proxies_find_their_own_modules_from_a_child_process(self):
        # The regex worker is spawned later and imports regex_worker by name - only PYTHONPATH makes that work
        # when the working directory is the install folder rather than the addon folder.
        layout, specs = self.specs("REVERSE_PROXY_ENABLED=true", "INTERNAL_CALL_SERVICES=a:9001:8080")
        for name in ("OUTBOUND", "REVERSE"):
            self.assertEqual(specs[name]["env"]["PYTHONPATH"], os.path.join(layout.app, "proxy"), name)

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

    def test_the_backends_port_clash_names_the_ui_port_setting(self):
        # Spring Boot's wording, not the OS's: "Port 3000 was already in use".
        spring = [sys.executable, "-c", "import sys; print('Web server failed to start. Port 3000 was already in use.'); sys.exit(1)"]
        self.fake["BACKEND"] = {"argv": spring, "env": {}, "listeners": ["0.0.0.0:3000 (UI, API, /mcp)"]}
        self.sup.start_all()
        child = self.sup.children["BACKEND"]
        self.assertTrue(self.wait_for(lambda: "cannot listen" in child.detail), child.detail)
        self.assertIn("ALFRED_UI_PORT", child.detail)
        self.assertIn("Docker", child.detail)

    def test_reload_restarts_only_what_changed(self):
        self.sup.start_all()
        backend_pid = self.sup.children["BACKEND"].proc.pid
        self.fake["REVERSE"] = {"argv": SLEEPER, "env": {"X": "1"}, "listeners": []}
        self.assertEqual(self.sup.reload(), ["REVERSE"])
        self.assertEqual(self.sup.children["BACKEND"].proc.pid, backend_pid)
        self.assertEqual(self.sup.children["REVERSE"].state, "RUNNING")

    def test_the_agent_is_attached_to_the_jvm_on_the_projects_upstream_port(self):
        """POST /agents/attach: the supervisor finds the app by its port, attaches, and reports on /status."""
        import attach_cli
        with open(os.path.join(self.layout.home, ".env"), "a", encoding="utf-8") as f:
            f.write("INTERNAL_CALL_SERVICES=odeysys:8080:9001\n")
        self.sup.refresh_specs()
        attached = []
        events = []
        with patch.object(attach_cli, "listening_pid", lambda port: 68108 if int(port) == 9001 else None), \
                patch.object(attach_cli, "jvm_pids", lambda layout: {68108: {"pid": 68108}}), \
                patch.object(attach_cli, "attach_pid", lambda layout, settings, pid, project, features: (attached.append((pid, project["name"], features)) or (True, "ok"))), \
                patch.object(supervisor.Supervisor, "_post_event", lambda self, payload: events.append(payload)):
            port = self.sup.serve_control()
            with open(self.layout.control_file, encoding="utf-8") as f:
                token = json.load(f)["token"]
            request = urllib.request.Request(f"http://127.0.0.1:{port}/agents/attach", method="POST",
                                             data=json.dumps({"project": "odeysys", "features": ["proxy", "db", "logs", "redis"]}).encode(),
                                             headers={"X-Alfred-Control-Token": token, "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual(202, response.status)
            self.assertTrue(self.wait_for(lambda: any(a["state"] == "ATTACHED" for a in self.sup.agents.status())))
            self.assertEqual([(68108, "odeysys", ["proxy", "db", "logs", "redis"])], attached)
            agent = self.sup.agents.status()[0]
            self.assertEqual(("odeysys", 9001, 68108, "proxy,db,logs,redis", ""), (agent["project"], agent["port"], agent["pid"], agent["features"], agent["detail"]))
            self.assertIn("AGENTS", [e.get("name") for e in events])
            # the same pid with the same features is not attached again within the retry window
            self.sup.agents.ask("odeysys", ["proxy", "db", "logs", "redis"])
            self.assertFalse(self.wait_for(lambda: len(attached) > 1, seconds=0.5))
            # forced, it is
            self.sup.agents.ask("odeysys", ["proxy", "db", "logs", "redis"], force=True)
            self.assertTrue(self.wait_for(lambda: len(attached) == 2))
            # the status answer carries the agents
            request = urllib.request.Request(f"http://127.0.0.1:{port}/status", headers={"X-Alfred-Control-Token": token})
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual("odeysys", json.loads(response.read())["agents"][0]["project"])

    def test_no_jvm_on_the_port_and_an_unknown_project_are_reported_not_retried_forever(self):
        import attach_cli
        with open(os.path.join(self.layout.home, ".env"), "a", encoding="utf-8") as f:
            f.write("INTERNAL_CALL_SERVICES=odeysys:8080:9001\n")
        self.sup.refresh_specs()
        with patch.object(attach_cli, "listening_pid", lambda port: None), \
                patch.object(supervisor.Supervisor, "_post_event", lambda self, payload: None):
            self.assertTrue(self.sup.agents.ask("odeysys", ["db"]))
            self.assertTrue(self.wait_for(lambda: any(a["state"] == "NO_JVM" for a in self.sup.agents.status())))
            self.assertIn("9001", self.sup.agents.status()[0]["detail"])
            self.assertFalse(self.sup.agents.ask("nope", ["db"]))
            self.assertEqual("NO_PROJECT", next(a for a in self.sup.agents.status() if a["project"] == "nope")["state"])

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



class AppWatcherTest(unittest.TestCase):
    """The supervisor notices a project's app starting, restarting and stopping, and tells the backend each time."""

    def setUp(self):
        self.layout = make_home(("INTERNAL_CALL_SERVICES=odeysys:8080:9001,core:8083:9003",))
        self.addCleanup(shutil.rmtree, self.layout.home, True)
        self.sup = supervisor.Supervisor(self.layout)
        self.sup.refresh_specs()
        self.events = []
        self.listening = {9001: False, 9003: False}
        self.pids = {9001: 68108, 9003: 777}
        self.watcher = supervisor.AppWatcher(self.sup, probe=lambda port: self.listening[port], pid_of=lambda port: self.pids[port])
        patcher = patch.object(supervisor.Supervisor, "_post_event", lambda sup, payload: self.events.append(payload))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_an_app_appearing_on_its_port_is_reported_once_with_its_pid(self):
        self.assertEqual(self.watcher.tick(now=100.0), [])
        self.listening[9001] = True
        events = self.watcher.tick(now=102.0)
        self.assertEqual([(e["name"], e["state"], e["project"], e["port"], e["pid"]) for e in events], [("APP", "LISTENING", "odeysys", 9001, 68108)])
        self.assertEqual(self.watcher.tick(now=104.0), [], "still listening, same pid: nothing new")
        self.assertEqual(self.events, events)
        app = next(a for a in self.watcher.status() if a["project"] == "odeysys")
        self.assertEqual((app["listening"], app["pid"], app["port"]), (True, 68108, 9001))

    def test_a_restart_is_a_new_pid_on_the_same_port(self):
        self.listening[9001] = True
        self.watcher.tick(now=100.0)
        self.pids[9001] = 68200
        self.assertEqual(self.watcher.tick(now=105.0), [], "the pid is re-read only every PID_SECONDS")
        events = self.watcher.tick(now=100.0 + supervisor.AppWatcher.PID_SECONDS)
        self.assertEqual([(e["state"], e["pid"]) for e in events], [("LISTENING", 68200)])

    def test_the_app_going_away_is_reported_and_its_return_again(self):
        self.listening[9001] = True
        self.watcher.tick(now=100.0)
        self.listening[9001] = False
        self.assertEqual([e["state"] for e in self.watcher.tick(now=102.0)], ["GONE"])
        self.listening[9001] = True
        self.assertEqual([e["state"] for e in self.watcher.tick(now=104.0)], ["LISTENING"])

    def test_probes_run_every_two_seconds_and_follow_the_project_list(self):
        self.assertTrue(self.watcher.due(now=10.0))
        self.watcher.tick(now=10.0)
        self.assertFalse(self.watcher.due(now=11.0))
        self.assertTrue(self.watcher.due(now=12.0))
        self.assertEqual(sorted(a["project"] for a in self.watcher.status()), ["core", "odeysys"])
        self.sup.settings = {"INTERNAL_CALL_SERVICES": "core:8083:9003"}
        self.watcher.tick(now=14.0)
        self.assertEqual([a["project"] for a in self.watcher.status()], ["core"])

    def test_a_real_probe_tells_a_listening_port_from_a_closed_one(self):
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            self.assertTrue(supervisor._port_listening(port))
        self.assertFalse(supervisor._port_listening(port))

if __name__ == "__main__":
    unittest.main()
