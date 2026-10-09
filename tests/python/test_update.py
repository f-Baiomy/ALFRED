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

    def test_the_download_reports_its_progress_while_it_runs_not_only_at_the_end(self):
        """The Server card's download bar re-fetches on each event: bytes must be told during the download."""
        seen = []
        events = mock.patch.object(supervisor.Supervisor, "changed_update",
                                   lambda sup: seen.append((sup.update.status()["state"], sup.update.status()["downloadedBytes"])))
        events.start()
        self.addCleanup(events.stop)
        with mock.patch.object(supervisor.UpdateJob, "PROGRESS_EVERY", 0):
            self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": self.sha256, "size": 3 * 1024 * 1024 + 17})
            self.assertTrue(wait_for(lambda: self.sup.update.status()["state"] == "INSTALLING"), self.sup.update.status())
        during = [n for state, n in seen if state == "DOWNLOADING"]
        self.assertEqual([1 << 20, 2 << 20, 3 << 20, 3 * 1024 * 1024 + 17], during)

    def test_on_windows_the_installer_starts_through_wmi_outside_the_services_process_tree(self):
        """WinSW kills the service's process tree on stop; the installer stops the service first - as our child it died."""
        calls = []

        class Ok:
            returncode, stdout, stderr = 0, "", ""
        folder = os.path.join(self.layout.data, "updates")
        os.makedirs(folder, exist_ok=True)
        exe = os.path.join(folder, "alfred-setup-9.9.9-windows-x64.exe")
        log_path = os.path.join(self.layout.logs, "update.log")
        started = supervisor._launch_installer_via_wmi(exe, r"C:\alfred", log_path, run=lambda argv, env: calls.append((argv, env)) or Ok())
        self.assertTrue(started)
        argv, env = calls[0]
        self.assertEqual("powershell.exe", argv[0])
        self.assertIn("Win32_Process", argv[-1])
        script = os.path.join(folder, "run-installer.cmd")
        self.assertEqual(f'cmd.exe /c "{script}"', env["ALFRED_UPDATE_COMMAND"])
        with open(script, encoding="utf-8") as f:
            text = f.read()
        self.assertIn(f'start "" /wait "{exe}" /S /DIR=C:\\alfred', text)
        self.assertIn("exited with %errorlevel%", text)
        self.assertIn(log_path, text)

    def test_when_wmi_refuses_the_installer_is_launched_directly(self):
        class Refused:
            returncode, stdout, stderr = 1, "", "Access denied"
        exe = os.path.join(self.layout.data, "x.exe")
        self.assertFalse(supervisor._launch_installer_via_wmi(exe, r"C:\alfred", os.path.join(self.layout.logs, "u.log"),
                                                               run=lambda argv, env: Refused()))

    def test_a_folder_with_spaces_is_quoted_for_the_installer(self):
        self.assertIn('/S /DIR="C:\\Program Files\\Alfred"', supervisor.installer_script("x.exe", r"C:\Program Files\Alfred", "u.log"))

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
        slow = mock.patch.object(supervisor.UpdateJob, "_download", lambda self, url, part, done: time.sleep(1))
        slow.start()
        self.addCleanup(slow.stop)
        self.assertEqual(self.control("POST", "/update", {"version": "9.9.9", "url": self.url, "sha256": self.sha256})[0], 202)
        status, body = self.control("POST", "/update", {"version": "9.9.8", "url": self.url, "sha256": self.sha256})
        self.assertEqual(status, 409)
        self.assertIn("already in progress", body["error"])


class RangeServer:
    """A release host over HTTP that answers Range requests, like GitHub's CDN. `drop` connections are cut after
    half their bytes; `ranges` set False makes it ignore Range and send the whole file with a 200."""

    def __init__(self, data, ranges=True, drop=0, expire_after=None, pace=0.002):
        import http.server
        import threading
        outer = self
        self.data, self.ranges, self.drop, self.requests, self.active, self.most_active = data, ranges, drop, [], 0, 0
        self.expire_after, self.generation, self.served, self.pace = expire_after, 0, 0, pace
        self.lock = threading.Lock()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                spec = self.headers.get("Range")
                with outer.lock:
                    # /release redirects to a signed-looking link that expires after `expire_after` pieces, like GitHub's
                    if self.path == "/release":
                        self.send_response(302)
                        self.send_header("Location", f"/signed-{outer.generation}/alfred-setup-9.9.9-test.bin")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    if outer.expire_after is not None and self.path.startswith("/signed-"):
                        if self.path.split("/")[1] != f"signed-{outer.generation}":
                            self.send_response(403)
                            self.send_header("Content-Length", "7")
                            self.end_headers()
                            self.wfile.write(b"expired")
                            return
                        outer.served += 1
                        if outer.served % outer.expire_after == 0:
                            outer.generation += 1
                    outer.requests.append(spec)
                    outer.active += 1
                    outer.most_active = max(outer.most_active, outer.active)
                    cut = outer.drop > 0 and spec != "bytes=0-"
                    if cut:
                        outer.drop -= 1
                try:
                    if outer.ranges and spec:
                        start, _, end = spec[len("bytes="):].partition("-")
                        start, end = int(start), int(end) if end else len(outer.data) - 1
                        body = outer.data[start:end + 1]
                        self.send_response(206)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{len(outer.data)}")
                    else:
                        body = outer.data
                        self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if cut:
                        self.wfile.write(body[:len(body) // 2])
                        self.wfile.flush()
                        self.connection.shutdown(2)
                        return
                    for i in range(0, len(body), 1 << 16):
                        self.wfile.write(body[i:i + (1 << 16)])
                        time.sleep(outer.pace)  # slow enough that the pieces overlap
                except (ConnectionError, OSError):
                    pass
                finally:
                    with outer.lock:
                        outer.active -= 1

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/alfred-setup-9.9.9-test.bin"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class PieceDownloadTest(unittest.TestCase):
    """Over HTTP the installer comes down over several range requests at once, each retried where it stopped."""

    def setUp(self):
        self.layout = make_layout()
        self.addCleanup(shutil.rmtree, self.layout.home, True)
        self.sup = supervisor.Supervisor(self.layout)
        self.sup.settings = {}
        for target, name, value in ((supervisor.Supervisor, "_post_event", lambda self, payload: None),
                                    (supervisor, "launch_installer", lambda path, home, log: None),
                                    (supervisor.UpdateJob, "RETRY_DELAYS", (0, 0, 0)),
                                    (supervisor.UpdateJob, "PIECE_BYTES", 256 * 1024)):
            patch = mock.patch.object(target, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.data = os.urandom(5 * 1024 * 1024 + 123)
        self.sha256 = hashlib.sha256(self.data).hexdigest()

    def run_update(self, server):
        self.addCleanup(server.close)
        self.assertTrue(self.sup.update.start("9.9.9", server.url, self.sha256, 0))
        self.assertTrue(wait_for(lambda: self.sup.update.status()["state"] in ("INSTALLING", "FAILED"), 30))
        return self.sup.update.status()

    def installed(self, name="alfred-setup-9.9.9-test.bin"):
        with open(os.path.join(self.layout.data, "updates", name), "rb") as f:
            return f.read()

    def test_the_installer_comes_down_in_pieces_over_several_connections_at_once(self):
        server = RangeServer(self.data)
        status = self.run_update(server)
        self.assertEqual(("INSTALLING", ""), (status["state"], status["error"]))
        self.assertEqual((len(self.data), len(self.data)), (status["downloadedBytes"], status["totalBytes"]))
        self.assertEqual(self.data, self.installed())
        self.assertEqual(1 + -(-len(self.data) // (256 * 1024)), len(server.requests))  # the probe, then each piece once
        self.assertGreater(server.most_active, 1)

    def test_a_dropped_connection_is_retried_from_where_it_stopped(self):
        server = RangeServer(self.data, drop=3)
        status = self.run_update(server)
        self.assertEqual(("INSTALLING", ""), (status["state"], status["error"]))
        self.assertEqual(len(self.data), status["downloadedBytes"])
        self.assertEqual(self.data, self.installed())
        resumed = [r for r in server.requests if r and not r.endswith("-") and int(r[6:].split("-")[0]) % (256 * 1024)]
        self.assertEqual(3, len(resumed), server.requests)

    def test_an_expired_link_is_resolved_again_from_the_release_url(self):
        """GitHub's release URL redirects to a signed link that stops answering within minutes; the long tail of a
        slow download must not fail on it, and never writes the refusal's body into the installer."""
        server = RangeServer(self.data, expire_after=5)
        server.url = server.url.replace("/alfred-setup-9.9.9-test.bin", "/release")
        status = self.run_update(server)
        self.assertEqual(("INSTALLING", ""), (status["state"], status["error"]))
        self.assertEqual(self.data, self.installed("release"))
        self.assertGreater(server.generation, 2)

    def test_a_server_without_ranges_is_read_in_one_stream(self):
        server = RangeServer(self.data, ranges=False)
        status = self.run_update(server)
        self.assertEqual(("INSTALLING", ""), (status["state"], status["error"]))
        self.assertEqual(self.data, self.installed())
        self.assertEqual(["bytes=0-"], server.requests)

    def test_a_piece_that_keeps_failing_fails_the_update_and_leaves_no_part_file(self):
        server = RangeServer(self.data, drop=1000)
        status = self.run_update(server)
        self.assertEqual("FAILED", status["state"])
        self.assertNotEqual("", status["error"])
        self.assertEqual([n for n in os.listdir(os.path.join(self.layout.data, "updates")) if n.endswith(".part")], [])


class LaunchCommandTest(unittest.TestCase):
    """What is executed, per OS - the processes themselves are not started."""

    def test_windows_without_wmi_runs_the_exe_silently_outside_the_job(self):
        calls = []
        with mock.patch.object(supervisor, "WINDOWS", True), \
                mock.patch.object(supervisor, "_launch_installer_via_wmi", lambda *a: False), \
                mock.patch.object(supervisor.subprocess, "Popen", lambda *a, **k: calls.append((a, k))), \
                mock.patch("builtins.open", mock.mock_open()):
            supervisor.launch_installer(r"C:\alfred\data\updates\setup.exe", r"C:\alfred", r"C:\alfred\data\log\update.log")
        (argv,), kwargs = calls[0]
        self.assertEqual(argv, [r"C:\alfred\data\updates\setup.exe", "/S", r"/DIR=C:\alfred"])
        self.assertTrue(kwargs["creationflags"] & 0x01000000)  # CREATE_BREAKAWAY_FROM_JOB
        self.assertTrue(kwargs["creationflags"] & 0x00000008)  # DETACHED_PROCESS

    def test_windows_falls_back_to_a_plain_detached_launch_when_breakaway_is_refused(self):
        calls = []

        def popen(argv, **kwargs):
            calls.append((argv, kwargs))
            if kwargs["creationflags"] & 0x01000000:
                raise PermissionError(5, "Access is denied")
        with mock.patch.object(supervisor, "WINDOWS", True), mock.patch.object(supervisor.subprocess, "Popen", popen), \
                mock.patch.object(supervisor, "_launch_installer_via_wmi", lambda *a: False), \
                mock.patch("builtins.open", mock.mock_open()):
            supervisor.launch_installer(r"C:\alfred\data\updates\setup.exe", r"C:\alfred", r"C:\alfred\data\log\update.log")
        self.assertEqual(len(calls), 2)
        self.assertFalse(calls[1][1]["creationflags"] & 0x01000000)
        self.assertTrue(calls[1][1]["creationflags"] & 0x00000008)
        self.assertEqual(calls[1][0], calls[0][0])

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


class PauseCacheTest(unittest.TestCase):
    """Pause keeps the pieces (and survives a restart), the next start fetches only the missing ones; cancel deletes
    them; a verified installer is reused without a download; a failed start left by the installer shows as FAILED."""

    def setUp(self):
        self.layout = make_layout()
        self.addCleanup(shutil.rmtree, self.layout.home, True)
        for target, name, value in ((supervisor.Supervisor, "_post_event", lambda self, payload: None),
                                    (supervisor, "launch_installer", lambda path, home, log: None),
                                    (supervisor.UpdateJob, "RETRY_DELAYS", (0, 0, 0)),
                                    (supervisor.UpdateJob, "PIECE_BYTES", 256 * 1024),
                                    (supervisor.UpdateJob, "CONNECTIONS", 2)):
            patch = mock.patch.object(target, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.data = os.urandom(5 * 1024 * 1024 + 123)
        self.sha256 = hashlib.sha256(self.data).hexdigest()
        self.updates = os.path.join(self.layout.data, "updates")

    def supervisor(self):
        sup = supervisor.Supervisor(self.layout)
        sup.settings = {}
        return sup

    def server(self, pace=0.01):
        server = RangeServer(self.data, pace=pace)
        self.addCleanup(server.close)
        return server

    def wait_state(self, job, *states):
        self.assertTrue(wait_for(lambda: job.status()["state"] in states, 30), job.status())
        return job.status()

    def paused_halfway(self, server):
        job = self.supervisor().update
        self.assertTrue(job.start("9.9.9", server.url, self.sha256, len(self.data)))
        self.assertTrue(wait_for(lambda: job.status()["downloadedBytes"] > 1024 * 1024, 30), job.status())
        self.assertTrue(job.pause())
        return job, self.wait_state(job, "PAUSED")

    def files(self):
        return sorted(os.listdir(self.updates))

    def test_pause_keeps_the_pieces_and_the_next_start_fetches_only_the_missing_ones(self):
        server = self.server()
        _, paused = self.paused_halfway(server)
        self.assertIn("alfred-setup-9.9.9-test.bin.part.json", self.files())
        done = json.load(open(os.path.join(self.updates, "alfred-setup-9.9.9-test.bin.part.json")))["done"]
        self.assertTrue(done)
        self.assertEqual(paused["downloadedBytes"], sum(min(256 * 1024, len(self.data) - s) for s in done))

        # Alfred restarts: the paused download is still paused.
        job = self.supervisor().update
        self.assertEqual(("PAUSED", "9.9.9", paused["downloadedBytes"]),
                         (job.status()["state"], job.status()["version"], job.status()["downloadedBytes"]))
        before = len(server.requests)
        self.assertTrue(job.start("9.9.9", server.url, self.sha256, len(self.data)))
        final = self.wait_state(job, "INSTALLING", "FAILED")
        self.assertEqual(("INSTALLING", ""), (final["state"], final["error"]))
        self.assertEqual(paused["downloadedBytes"], final["resumedBytes"])
        pieces = -(-len(self.data) // (256 * 1024))
        self.assertEqual(1 + pieces - len(done), len(server.requests) - before)  # the probe, then only what was missing
        with open(os.path.join(self.updates, "alfred-setup-9.9.9-test.bin"), "rb") as f:
            self.assertEqual(self.data, f.read())
        self.assertNotIn("alfred-setup-9.9.9-test.bin.part.json", self.files())

    def test_cancel_deletes_what_was_downloaded(self):
        server = self.server()
        job, _ = self.paused_halfway(server)
        self.assertTrue(job.cancel())
        self.assertEqual("IDLE", job.status()["state"])
        self.assertEqual([], [n for n in self.files() if ".part" in n])
        # and while it runs
        self.assertTrue(job.start("9.9.9", server.url, self.sha256, len(self.data)))
        self.assertTrue(wait_for(lambda: job.status()["downloadedBytes"] > 0, 30))
        self.assertTrue(job.cancel())
        self.assertEqual("IDLE", self.wait_state(job, "IDLE")["state"])
        self.assertEqual([], [n for n in self.files() if ".part" in n])
        self.assertFalse(job.cancel())  # nothing left to cancel

    def test_a_newer_release_drops_the_paused_pieces_of_the_older_one(self):
        server = self.server()
        job, _ = self.paused_halfway(server)
        other = RangeServer(self.data[::-1], pace=0)
        self.addCleanup(other.close)
        other_url = other.url.replace("9.9.9", "9.9.10")
        self.assertTrue(job.start("9.9.10", other_url, hashlib.sha256(self.data[::-1]).hexdigest(), len(self.data)))
        final = self.wait_state(job, "INSTALLING", "FAILED")
        self.assertEqual(("INSTALLING", 0), (final["state"], final["resumedBytes"]))
        self.assertNotIn("alfred-setup-9.9.9-test.bin.part", self.files())

    def test_a_verified_installer_is_installed_again_from_the_cache(self):
        server = self.server(pace=0)
        job = self.supervisor().update
        job.start("9.9.9", server.url, self.sha256, len(self.data))
        self.wait_state(job, "INSTALLING")
        before = len(server.requests)
        job = self.supervisor().update
        job.start("9.9.9", server.url, self.sha256, len(self.data))
        final = self.wait_state(job, "INSTALLING", "FAILED")
        self.assertEqual(("INSTALLING", True), (final["state"], final["cached"]))
        self.assertEqual(before, len(server.requests))

    def test_the_cache_keeps_the_newest_two_installers(self):
        os.makedirs(self.updates, exist_ok=True)
        for i, name in enumerate(("alfred-setup-1.0.0-x.exe", "alfred-setup-1.0.1-x.exe")):
            path = os.path.join(self.updates, name)
            open(path, "wb").close()
            os.utime(path, (1000 + i, 1000 + i))
        server = self.server(pace=0)
        job = self.supervisor().update
        job.start("9.9.9", server.url, self.sha256, len(self.data))
        self.wait_state(job, "INSTALLING")
        self.assertEqual(["alfred-setup-1.0.1-x.exe", "alfred-setup-9.9.9-test.bin"],
                         [n for n in self.files() if n.startswith("alfred-setup-")])

    def test_an_update_the_installer_could_not_install_says_so_and_that_the_old_version_runs(self):
        os.makedirs(self.updates, exist_ok=True)
        with open(os.path.join(self.updates, "failed-start.txt"), "w", encoding="utf-8") as f:
            f.write("9.9.9\r\nits program files were in use - an alfred window was open.\r\nnot-installed\r\n")
        status = self.supervisor().update.status()
        self.assertEqual(("FAILED", "9.9.9"), (status["state"], status["version"]))
        self.assertIn("was not installed: its program files were in use", status["error"])
        self.assertIn("runs again", status["error"])
        self.assertNotIn("not-installed", status["error"])

    def test_a_start_the_installer_gave_up_on_is_failed_with_its_reason_until_the_next_try(self):
        os.makedirs(self.updates, exist_ok=True)
        with open(os.path.join(self.updates, "failed-start.txt"), "w", encoding="utf-8") as f:
            f.write("9.9.9\nport 3000 is in use by node.exe (pid 4410).\n")
        job = self.supervisor().update
        status = job.status()
        self.assertEqual(("FAILED", "9.9.9"), (status["state"], status["version"]))
        self.assertIn("port 3000 is in use by node.exe", status["error"])
        self.assertIn("was put back", status["error"])
        server = self.server(pace=0)
        job.start("9.9.9", server.url, self.sha256, len(self.data))
        self.assertNotIn("failed-start.txt", self.files())


class AlfredUpdateCommandTest(unittest.TestCase):

    def setUp(self):
        self.layout = make_layout()
        self.addCleanup(shutil.rmtree, self.layout.home, True)

    def run_update(self, args, answers):
        """answers: {(method, path): json} of this install's backend."""
        calls = []

        def backend_json(layout, method, path, timeout=30, body=None):
            calls.append((method, path) if body is None else (method, path, body))
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
        self.assertEqual(calls[-1], ("POST", "/server/update/install", {"version": "1.5.0"}))

    def test_with_several_newer_releases_and_nobody_to_ask_the_newest_is_installed(self):
        status = {"mode": "CHECK", "available": True, "latestVersion": "1.6.0", "currentVersion": "1.4.0", "canInstall": True,
                  "job": {"state": "IDLE"}, "releases": [{"version": "1.6.0"}, {"version": "1.5.0"}]}
        answers = {("POST", "/server/update/check"): status, ("POST", "/server/update/install"): {"accepted": True}}
        code, _, _, calls = self.run_update([], answers)
        self.assertEqual(calls[-1], ("POST", "/server/update/install", {"version": "1.6.0"}))
        code, _, _, calls = self.run_update(["--version", "1.5.0"], answers)
        self.assertEqual(calls[-1], ("POST", "/server/update/install", {"version": "1.5.0"}))
        code, out, _, calls = self.run_update(["--version", "1.3.0"], answers)
        self.assertEqual(code, alfred.ERROR)
        self.assertIn("not one of the newer releases", out)

    def test_cancel_discards_the_paused_download(self):
        with mock.patch.object(alfred, "wait_job", return_value={"state": "IDLE"}):
            code, out, _, calls = self.run_update(["--cancel"], {("POST", "/server/update/cancel"): {"accepted": True}})
        self.assertEqual(code, alfred.OK)
        self.assertEqual(calls, [("POST", "/server/update/cancel")])
        self.assertIn("Update cancelled", out)

    def test_a_paused_update_shows_in_status(self):
        payload = json.dumps({"available": True, "latestVersion": "1.5.0", "releases": [{"version": "1.5.0"}],
                              "job": {"state": "PAUSED", "version": "1.5.0", "downloadedBytes": 58, "totalBytes": 100}}).encode()

        class Answer(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        with mock.patch.object(alfred.urllib.request, "urlopen", lambda url, timeout=0: Answer(payload)):
            line = alfred.update_line(self.layout)
        self.assertIn("paused at 58%", line)
        self.assertIn("alfred update --cancel", line)

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

    def test_on_windows_the_cli_lets_go_of_the_runtime_once_the_installer_runs(self):
        # The open CLI window ran on runtime\python\python.exe: the installer could not move it and Alfred stayed stopped.
        status = {"mode": "CHECK", "available": True, "latestVersion": "1.5.0", "currentVersion": "1.4.0", "canInstall": True, "job": {"state": "IDLE"}}
        script = os.path.join(self.layout.home, "follow.ps1")
        jobs = iter([{"state": "VERIFYING", "version": "1.5.0"}, {"state": "INSTALLING", "version": "1.5.0"}])
        with mock.patch.dict(os.environ, {"ALFRED_FOLLOW_SCRIPT": script}), mock.patch.object(alfred, "WINDOWS", True),                 mock.patch.object(alfred, "POLL_SECONDS", 0),                 mock.patch.object(alfred, "call_supervisor", lambda layout, method, path, timeout=2, body=None: next(jobs)):
            code, out, _, _ = self.run_update(["--panel"], {("POST", "/server/update/check"): status,
                                                            ("POST", "/server/update/install"): {"accepted": True}})
        self.assertEqual(code, alfred.HANDED_OFF)
        self.assertIn("lets go of Alfred's files", out)
        with open(script, encoding="utf-8-sig") as f:
            text = f.read()
        self.assertIn("$version = '1.5.0'", text)
        self.assertIn("$reopen = $true", text)
        self.assertIn(self.layout.local_url(), text)

    def test_without_alfred_cmd_the_cli_follows_the_install_itself(self):
        with mock.patch.dict(os.environ, {"ALFRED_FOLLOW_SCRIPT": ""}), mock.patch.object(alfred, "WINDOWS", True):
            self.assertFalse(alfred.can_hand_off())
        with mock.patch.dict(os.environ, {"ALFRED_FOLLOW_SCRIPT": "x.ps1"}), mock.patch.object(alfred, "WINDOWS", False):
            self.assertFalse(alfred.can_hand_off())

    def test_the_follow_script_quotes_its_values_for_powershell(self):
        text = alfred.follow_script("http://127.0.0.1:3000", "1.5.0", "1.4.0", r"C:\Al'fred", reopen=False)
        self.assertIn(r"$alfredHome = 'C:\Al''fred'", text)
        self.assertIn("$reopen = $false", text)
        self.assertIn("Remove-Item -LiteralPath $PSCommandPath", text)

    def test_a_stopped_alfred_is_told_to_start_first(self):
        with mock.patch.object(alfred, "own_backend", lambda layout, timeout=2: (False, None)):
            with self.assertRaises(SystemExit) as stop:
                alfred.backend_json(self.layout, "POST", "/server/update/check")
        self.assertIn("alfred start", str(stop.exception))


if __name__ == "__main__":
    unittest.main()
