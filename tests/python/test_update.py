"""The supervisor's update job (POST /update) and `alfred update`: download, verify, run detached - never an
unverified installer, never a second install while one runs, every failure visible in the status."""

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import alfred  # noqa: E402
import supervisor  # noqa: E402
from layout import Layout  # noqa: E402

ENV_MAP = os.path.join(ROOT, "backend", "backend-server", "src", "main", "resources", "settings-env-map.json")


def make_layout():
    home = tempfile.mkdtemp(prefix="alfred-home-")
    os.makedirs(os.path.join(home, "app"))
    shutil.copy(ENV_MAP, os.path.join(home, "app", "settings-env-map.json"))
    shutil.copy(os.path.join(ROOT, "settings.properties"), os.path.join(home, "settings.properties"))
    with open(os.path.join(home, ".env"), "w", encoding="utf-8") as f:
        f.write("ALFRED_UI_PORT=3100\n")
    layout = Layout(home)
    layout.make_dirs()
    return layout


def wait_for(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class UpdateJobTest(unittest.TestCase):

    def setUp(self):
        self.layout = make_layout()
        self.addCleanup(shutil.rmtree, self.layout.home, True)
        self.sup = supervisor.Supervisor(self.layout)
        self.sup.settings = {}
        self.addCleanup(lambda: self.sup.server and self.sup.server.shutdown())
        no_events = mock.patch.object(supervisor.Supervisor, "_post_event", lambda self, payload: None)
        no_events.start()
        self.addCleanup(no_events.stop)
        self.launched = []
        launcher = mock.patch.object(supervisor, "launch_installer", lambda path, home, log: self.launched.append((path, home, log)))
        launcher.start()
        self.addCleanup(launcher.stop)
        # A "release": a file served over file://, with its real checksum.
        self.installer = os.path.join(self.layout.home, "alfred-setup-9.9.9-test.bin")
        with open(self.installer, "wb") as f:
            f.write(os.urandom(3 * 1024 * 1024 + 17))
        with open(self.installer, "rb") as f:
            self.sha256 = hashlib.sha256(f.read()).hexdigest()
        self.url = "file:///" + self.installer.replace("\\", "/").lstrip("/")

    def control(self, method, path, body=None):
        port = self.sup.serve_control() if not self.sup.server else self.sup.server.server_address[1]
        with open(self.layout.control_file, encoding="utf-8") as f:
            token = json.load(f)["token"]
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                         headers={"X-Alfred-Control-Token": token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_downloads_verifies_and_runs_the_installer_detached(self):
        status, body = self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": self.sha256, "size": 3 * 1024 * 1024 + 17})
        self.assertEqual((status, body), (202, {"accepted": True}))
        self.assertTrue(wait_for(lambda: self.sup.update.status()["state"] == "INSTALLING"), self.sup.update.status())
        final = self.control("GET", "/update")[1]
        self.assertEqual(final["version"], "9.9.9")
        self.assertEqual(final["downloadedBytes"], 3 * 1024 * 1024 + 17)
        self.assertEqual(final["error"], "")
        self.assertEqual(len(self.launched), 1)
        path, home, log = self.launched[0]
        self.assertEqual(os.path.dirname(path), os.path.join(self.layout.data, "updates"))
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(home, self.layout.home)
        self.assertTrue(log.endswith("update.log"))

    def test_a_wrong_checksum_never_runs_the_installer(self):
        status, _ = self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": "00" * 32, "size": 1})
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: self.sup.update.status()["state"] == "FAILED"), self.sup.update.status())
        self.assertIn("checksum", self.sup.update.status()["error"])
        self.assertEqual(self.launched, [])
        self.assertEqual(os.listdir(os.path.join(self.layout.data, "updates")), [])

    def test_a_missing_checksum_or_bad_url_is_refused_up_front(self):
        self.assertEqual(self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": ""})[0], 400)
        self.assertEqual(self.control("POST", "/update", {"version": "9.9.9", "url": "ftp://x/y", "sha256": "ab"})[0], 400)
        self.assertEqual(self.control("POST", "/update", {"url": self.url})[0], 400)
        self.assertEqual(self.sup.update.status()["state"], "IDLE")

    def test_a_download_that_fails_is_reported_and_leaves_no_part_file(self):
        self.control("POST", "/update", {"version": "9.9.9", "url": "file:///C:/no/such/installer.exe", "sha256": "ab", "size": 1})
        self.assertTrue(wait_for(lambda: self.sup.update.status()["state"] == "FAILED"), self.sup.update.status())
        self.assertNotEqual(self.sup.update.status()["error"], "")
        self.assertEqual([n for n in os.listdir(os.path.join(self.layout.data, "updates")) if n.endswith(".part")], [])

    def test_only_one_update_at_a_time(self):
        slow = mock.patch.object(supervisor.UpdateJob, "_download", lambda self, url, part: time.sleep(1))
        slow.start()
        self.addCleanup(slow.stop)
        self.assertEqual(self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": self.sha256})[0], 202)
        status, body = self.control("POST", "/update", {"version": "9.9.8", "url": self.url, "sha256": self.sha256})
        self.assertEqual(status, 409)
        self.assertIn("already in progress", body["error"])


class LaunchCommandTest(unittest.TestCase):
    """What is executed, per OS - the processes themselves are not started."""

    def test_windows_runs_the_exe_silently_outside_the_job(self):
        calls = []
        with mock.patch.object(supervisor, "WINDOWS", True), \
                mock.patch.object(supervisor.subprocess, "Popen", lambda *a, **k: calls.append((a, k))), \
                mock.patch("builtins.open", mock.mock_open()):
            supervisor.launch_installer(r"C:\alfred\data\updates\setup.exe", r"C:\alfred", r"C:\alfred\data\log\update.log")
        (argv,), kwargs = calls[0]
        self.assertEqual(argv, [r"C:\alfred\data\updates\setup.exe", "/S", r"/DIR=C:\alfred"])
        self.assertTrue(kwargs["creationflags"] & 0x01000000)  # CREATE_BREAKAWAY_FROM_JOB
        self.assertTrue(kwargs["creationflags"] & 0x00000008)  # DETACHED_PROCESS

    def test_linux_uses_a_transient_systemd_unit_when_there_is_systemd(self):
        calls = []
        with mock.patch.object(supervisor, "WINDOWS", False), \
                mock.patch.object(supervisor.subprocess, "Popen", lambda *a, **k: calls.append((a, k))), \
                mock.patch.object(supervisor.shutil, "which", lambda name: "/usr/bin/systemd-run"), \
                mock.patch.object(supervisor.os.path, "isdir", lambda p: p == "/run/systemd/system"), \
                mock.patch.object(supervisor.os, "chmod", lambda *a: None), \
                mock.patch("builtins.open", mock.mock_open()):
            supervisor.launch_installer("/opt/alfred/data/updates/setup.run", "/opt/alfred", "/opt/alfred/data/log/update.log")
        (argv,), _ = calls[0]
        self.assertEqual(argv[0], "systemd-run")
        self.assertIn("--collect", argv)
        self.assertEqual(argv[-5:], ["sh", "/opt/alfred/data/updates/setup.run", "--unattended", "--dir", "/opt/alfred"])

    def test_linux_without_systemd_starts_a_new_session(self):
        calls = []
        with mock.patch.object(supervisor, "WINDOWS", False), \
                mock.patch.object(supervisor.subprocess, "Popen", lambda *a, **k: calls.append((a, k))), \
                mock.patch.object(supervisor.shutil, "which", lambda name: None), \
                mock.patch.object(supervisor.os, "chmod", lambda *a: None), \
                mock.patch("builtins.open", mock.mock_open()):
            supervisor.launch_installer("/opt/alfred/data/updates/setup.run", "/opt/alfred", "/opt/alfred/data/log/update.log")
        (argv,), kwargs = calls[0]
        self.assertEqual(argv[:2], ["sh", "/opt/alfred/data/updates/setup.run"])
        self.assertTrue(kwargs["start_new_session"])


class AlfredUpdateCommandTest(unittest.TestCase):

    def setUp(self):
        self.layout = make_layout()
        self.addCleanup(shutil.rmtree, self.layout.home, True)

    def run_update(self, args, answers):
        """answers: {(method, path): json} of this install's backend."""
        calls = []

        def backend_json(layout, method, path, timeout=30):
            calls.append((method, path))
            return answers[(method, path)]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(alfred, "backend_json", backend_json), redirect_stdout(out), redirect_stderr(err):
            code = alfred.cmd_update(self.layout, args)
        return code, out.getvalue(), err.getvalue(), calls

    def test_check_reports_and_installs_nothing(self):
        status = {"mode": "CHECK", "available": True, "latestVersion": "1.5.0", "currentVersion": "1.4.0", "sizeBytes": 150_000_000,
                  "publishedAt": "2026-10-08", "notes": "Faster exports", "canInstall": True, "job": {"state": "IDLE"}, "checkedAt": "now", "feedUrl": "f"}
        code, out, _, calls = self.run_update(["--check"], {("POST", "/server/update/check"): status})
        self.assertEqual(code, alfred.OK)
        self.assertIn("Update available: Alfred 1.5.0 (running 1.4.0, 143 MB)", out)
        self.assertIn("Faster exports", out)
        self.assertEqual(calls, [("POST", "/server/update/check")])

    def test_update_installs_when_one_is_available(self):
        status = {"mode": "CHECK", "available": True, "latestVersion": "1.5.0", "currentVersion": "1.4.0", "canInstall": True, "job": {"state": "IDLE"}}
        code, out, _, calls = self.run_update([], {("POST", "/server/update/check"): status, ("POST", "/server/update/install"): {"accepted": True}})
        self.assertEqual(code, alfred.OK)
        self.assertIn("Installing Alfred 1.5.0", out)
        self.assertEqual(calls[-1], ("POST", "/server/update/install"))

    def test_up_to_date_installs_nothing(self):
        status = {"mode": "CHECK", "available": False, "latestVersion": "1.4.0", "currentVersion": "1.4.0", "job": {"state": "IDLE"}}
        code, out, _, calls = self.run_update([], {("POST", "/server/update/check"): status})
        self.assertEqual(code, alfred.OK)
        self.assertIn("up to date", out)
        self.assertEqual(calls, [("POST", "/server/update/check")])

    def test_a_failed_check_exits_1(self):
        status = {"mode": "CHECK", "available": False, "latestVersion": "", "error": "Could not read https://feed: HTTP 503", "job": {"state": "IDLE"}}
        code, out, _, _ = self.run_update(["--check"], {("POST", "/server/update/check"): status})
        self.assertEqual(code, alfred.ERROR)
        self.assertIn("HTTP 503", out)

    def test_a_stopped_alfred_is_told_to_start_first(self):
        with mock.patch.object(alfred, "own_backend", lambda layout, timeout=2: (False, None)):
            with self.assertRaises(SystemExit) as stop:
                alfred.backend_json(self.layout, "POST", "/server/update/check")
        self.assertIn("alfred start", str(stop.exception))


if __name__ == "__main__":
    unittest.main()
