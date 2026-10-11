"""alfred_agent_host.py: the Docker install's attacher - its .env lines, its control API, and its Docker layout."""

import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import alfred_agent_host  # noqa: E402


class EnvTest(unittest.TestCase):

    def test_the_token_and_port_are_added_once_and_kept(self):
        folder = tempfile.mkdtemp(prefix="alfred-docker-")
        self.addCleanup(shutil.rmtree, folder, True)
        env_file = os.path.join(folder, ".env")
        with open(env_file, "w", encoding="utf-8") as f:
            f.write("# mine\nBACKEND_PORT=5000\n")
        alfred_agent_host.ensure_env(env_file)
        with open(env_file, encoding="utf-8") as f:
            first = f.read()
        alfred_agent_host.ensure_env(env_file)
        with open(env_file, encoding="utf-8") as f:
            self.assertEqual(f.read(), first, "written once")
        self.assertIn("# mine\nBACKEND_PORT=5000\n", first)
        self.assertRegex(first, r"ALFRED_AGENT_HOST_TOKEN=[0-9a-f]{48}\n")
        self.assertIn("ALFRED_AGENT_HOST_PORT=3098\n", first)


class ControlApiTest(unittest.TestCase):
    """The two calls the Docker backend makes (AgentHostAdapter): the token is required, attach asks the attacher."""

    def setUp(self):
        self.asked = []
        asked = self.asked

        class Agents:
            def status(self):
                return [{"project": "odeysys", "state": "ATTACHED"}]

            def ask(self, *args):
                asked.append(args)
                return True

        class Apps:
            def status(self):
                return []

        class LayoutStub:
            def settings(self):
                return {}

        class HostStub:
            agents, apps, layout = Agents(), Apps(), LayoutStub()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), alfred_agent_host.handler_for(HostStub(), "t0k"))
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def call(self, method, path, body=None, token="t0k"):
        request = urllib.request.Request(self.base + path, method=method,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={"X-Alfred-Control-Token": token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_status_and_attach_need_the_token(self):
        self.assertEqual(self.call("GET", "/status", token="wrong")[0], 401)
        self.assertEqual(self.call("POST", "/agents/attach", {"project": "odeysys"}, token="")[0], 401)
        self.assertEqual(self.asked, [])

    def test_status_lists_the_agents_and_attach_asks_with_the_features(self):
        status, body = self.call("GET", "/status")
        self.assertEqual((status, body["agents"][0]["state"], body["processes"]), (200, "ATTACHED", []))
        status, body = self.call("POST", "/agents/attach", {"project": "odeysys", "features": ["proxy", "db"], "force": True})
        self.assertEqual((status, body), (202, {"accepted": True}))
        self.assertEqual(self.asked, [("odeysys", ["proxy", "db"], True)])
        self.assertEqual(self.call("POST", "/agents/attach", {"project": "odeysys", "features": ["teleport"]})[0], 400)


class DockerLayoutTest(unittest.TestCase):

    def test_the_agent_reports_to_the_docker_alfred_with_its_secret_and_ca(self):
        import attach_cli
        layout = alfred_agent_host.DockerLayout("java")
        settings = {"INTERNAL_CALL_SERVICES": "odeysys:8080:9001", "WEBHOOK_SECRET": "change-me-in-production"}
        with patch.dict(os.environ, {"ALFRED_ATTACH_URL": "http://localhost:3000", "ALFRED_ATTACH_SECRET": "change-me-in-production"}):
            project = attach_cli.projects(settings)[0]
            self.assertEqual(attach_cli.base_args(layout, settings, project),
                             "alfredUrl=http://localhost:3000;project=odeysys;proxy=127.0.0.2:443")
            self.assertEqual(attach_cli.secrets_env(layout, settings)["ALFRED_AGENT_SECRET"], "change-me-in-production")
        self.assertEqual(attach_cli.ca_file(layout), os.path.join(ROOT, "proxy", "certs", "mitmproxy-ca-cert.pem"))

    def test_a_jdk_21_or_newer_is_picked(self):
        with patch.object(alfred_agent_host, "java_major", lambda java: 21 if "good" in java else 8), \
                patch.dict(os.environ, {"ALFRED_ATTACH_JAVA": "/x/good/bin/java"}), \
                patch("os.path.isfile", lambda p: True), patch("glob.glob", lambda p: []):
            self.assertEqual(alfred_agent_host.find_java(), "/x/good/bin/java")
        with patch.object(alfred_agent_host, "java_major", lambda java: 8), patch("glob.glob", lambda p: []):
            self.assertIsNone(alfred_agent_host.find_java())


if __name__ == "__main__":
    unittest.main()


class GoneWatchTest(unittest.TestCase):
    """The host stops by itself only when the Docker Alfred is really gone - never after a sleep or a rebuild."""

    def watch(self, answers, stack_exists=lambda: True):
        self.now = 1000.0
        return alfred_agent_host.GoneWatch(lambda: answers[0], stack_exists, clock=lambda: self.now)

    def run_for(self, watch, seconds):
        for _ in range(int(seconds)):
            self.now += 1
            if watch.gone():
                return True
        return False

    def test_a_long_sleep_is_not_read_as_an_hour_without_an_answer(self):
        answers = [True]
        watch = self.watch(answers, stack_exists=lambda: False)
        self.assertFalse(self.run_for(watch, 30))
        answers[0] = False
        self.now += 3600  # the machine slept; Windows' monotonic clock counted it
        self.assertFalse(watch.gone(), "one failed check right after waking is not 300 s gone")
        self.assertFalse(self.run_for(watch, alfred_agent_host.GONE_SECONDS - 20))

    def test_it_keeps_running_while_the_backend_container_exists(self):
        answers = [True]
        watch = self.watch(answers, stack_exists=lambda: True)
        self.run_for(watch, 20)
        answers[0] = False
        self.assertFalse(self.run_for(watch, 3 * alfred_agent_host.GONE_SECONDS))

    def test_it_stops_once_the_stack_is_down_and_silent(self):
        answers = [True]
        watch = self.watch(answers, stack_exists=lambda: False)
        self.run_for(watch, 20)
        answers[0] = False
        self.assertTrue(self.run_for(watch, alfred_agent_host.GONE_SECONDS + 2 * watch.CHECK_SECONDS))

    def test_it_never_stops_before_the_alfred_answered_once(self):
        watch = self.watch([False], stack_exists=lambda: False)
        self.assertFalse(self.run_for(watch, 3 * alfred_agent_host.GONE_SECONDS))

    def test_docker_not_answering_is_not_a_missing_container(self):
        with patch("subprocess.run", side_effect=OSError("no docker")):
            self.assertTrue(alfred_agent_host.backend_container_exists())
        failed = type("R", (), {"returncode": 1, "stdout": "", "stderr": "error during connect: is the docker daemon running?"})
        with patch("subprocess.run", return_value=failed):
            self.assertTrue(alfred_agent_host.backend_container_exists())
        missing = type("R", (), {"returncode": 1, "stdout": "", "stderr": "Error: No such container: backend"})
        with patch("subprocess.run", return_value=missing):
            self.assertFalse(alfred_agent_host.backend_container_exists())
