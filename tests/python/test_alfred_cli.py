"""packaging/launcher/alfred.py: a command run by an account that may not read data/ or .env is refused with a clear
message - not answered wrongly ("not running", "No log yet") or with a traceback (FileExistsError on data\\appdata)."""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import alfred  # noqa: E402
from layout import Layout  # noqa: E402


def make_home():
    home = tempfile.mkdtemp(prefix="alfred-home-")
    os.makedirs(os.path.join(home, "data", "run"))
    os.makedirs(os.path.join(home, "app"))
    with open(os.path.join(home, ".env"), "w", encoding="utf-8") as f:
        f.write("ALFRED_UI_PORT=3100\n")
    with open(os.path.join(home, "app", "VERSION"), "w", encoding="utf-8") as f:
        f.write("9.9.9\n")
    return home


def run_main(home, argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, {"ALFRED_HOME": home}), redirect_stdout(out), redirect_stderr(err):
        code = alfred.main(argv)
    return code, out.getvalue(), err.getvalue()


def locked(path_to_lock):
    """os.listdir / open raising PermissionError for one path, as a locked folder does for a non-admin account."""
    real_listdir, real_open = os.listdir, open

    def listdir(path="."):
        if os.path.abspath(path) == os.path.abspath(path_to_lock):
            raise PermissionError(13, "Access is denied", path)
        return real_listdir(path)

    def opener(path, *args, **kwargs):
        if isinstance(path, str) and os.path.abspath(path) == os.path.abspath(path_to_lock):
            raise PermissionError(13, "Access is denied", path)
        return real_open(path, *args, **kwargs)

    return mock.patch.multiple(alfred.os, listdir=listdir), mock.patch("builtins.open", opener)


class AccessTest(unittest.TestCase):

    def setUp(self):
        self.home = make_home()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def test_a_readable_install_has_no_problem(self):
        self.assertIsNone(alfred.access_problem(Layout(self.home), "status"))

    def test_status_from_an_account_that_cannot_read_data_is_refused_not_reported_as_stopped(self):
        listdir_patch, open_patch = locked(os.path.join(self.home, "data"))
        with listdir_patch, open_patch:
            code, out, err = run_main(self.home, ["status"])
        self.assertEqual(code, alfred.NOT_ALLOWED)
        self.assertNotIn("not running", out)
        self.assertIn("alfred status needs", err)
        self.assertIn(os.path.join(self.home, "data"), err)

    def test_an_unreadable_env_is_refused_too(self):
        listdir_patch, open_patch = locked(os.path.join(self.home, ".env"))
        with listdir_patch, open_patch:
            code, _, err = run_main(self.home, ["config", "list"])
        self.assertEqual(code, alfred.NOT_ALLOWED)
        self.assertIn("alfred config needs", err)

    def test_the_message_names_the_way_to_run_it(self):
        listdir_patch, open_patch = locked(os.path.join(self.home, "data"))
        with listdir_patch, open_patch:
            problem = alfred.access_problem(Layout(self.home), "start")
        self.assertIn("Run as administrator" if alfred.WINDOWS else "sudo alfred start", problem)

    def test_version_and_help_need_no_access(self):
        listdir_patch, open_patch = locked(os.path.join(self.home, "data"))
        with listdir_patch, open_patch:
            code, out, _ = run_main(self.home, ["version"])
            self.assertEqual((code, out.strip()), (alfred.OK, "9.9.9"))
            code, out, _ = run_main(self.home, ["--help"])
            self.assertEqual(code, alfred.OK)

    def test_a_permission_error_inside_a_command_is_a_refusal_not_a_traceback(self):
        def denied(layout, args):
            raise PermissionError(13, "Access is denied", os.path.join(self.home, "data", "log", "backend.log"))
        with mock.patch.dict(alfred.COMMANDS, {"logs": denied}):
            code, _, err = run_main(self.home, ["logs"])
        self.assertEqual(code, alfred.NOT_ALLOWED)
        self.assertIn("backend.log", err)


class ContractNamesTest(unittest.TestCase):
    """contracts/cli.md: `alfred logs proxy` is the outbound proxy's log; status shows uptime."""

    def test_logs_proxy_reads_the_outbound_log(self):
        home = make_home()
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        os.makedirs(os.path.join(home, "data", "log"))
        with open(os.path.join(home, "data", "log", "outbound.log"), "w", encoding="utf-8") as f:
            f.write("outbound line\n")
        code, out, _ = run_main(home, ["logs", "proxy"])
        self.assertEqual((code, out), (alfred.OK, "outbound line\n"))

    def test_uptime_is_read_from_the_iso_start_time(self):
        from datetime import datetime, timedelta, timezone
        started = (datetime.now(timezone.utc) - timedelta(days=1, hours=2, minutes=3, seconds=4)).isoformat()
        self.assertRegex(alfred.uptime(started), r"^1d 02:03:0[45]$")
        self.assertEqual(alfred.uptime(None), "-")
        self.assertEqual(alfred.uptime("not a time"), "-")

    def test_installer_helpers_exist(self):
        self.assertIn("_wait-health", alfred.COMMANDS)
        self.assertIn("_record-upgrade", alfred.COMMANDS)
        home = make_home()
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        code, _, err = run_main(home, ["_record-upgrade", "only-one"])
        self.assertEqual(code, alfred.USAGE)
        self.assertIn("OLD_VERSION NEW_VERSION", err)


class OwnBackendTest(unittest.TestCase):
    """Whatever answers on the UI port is not necessarily this install: /server/status must name this home."""

    def setUp(self):
        self.home = make_home()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def answering(self, payload):
        import io as _io
        body = json.dumps(payload).encode()

        class Response(_io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return mock.patch.object(alfred.urllib.request, "urlopen", lambda url, timeout=0: Response(body))

    def test_this_installs_backend_is_recognised_by_its_install_folder(self):
        with self.answering({"installDir": self.home, "processes": []}):
            self.assertEqual(alfred.own_backend(Layout(self.home)), (True, None))
            self.assertTrue(alfred.wait_for_health(Layout(self.home), seconds=2))

    def test_another_install_on_the_port_is_not_this_one(self):
        with self.answering({"installDir": r"C:\other-alfred", "processes": []}):
            ok, other = alfred.own_backend(Layout(self.home))
            self.assertFalse(ok)
            self.assertEqual(other, r"C:\other-alfred")
            self.assertFalse(alfred.wait_for_health(Layout(self.home), seconds=1))
            explanation = alfred.explain_not_answering(Layout(self.home))
            self.assertIn("another Alfred", explanation)
            self.assertIn(r"C:\other-alfred", explanation)

    def test_a_docker_backend_without_an_install_folder_is_not_this_one_either(self):
        with self.answering({"installDir": "", "processes": []}):
            ok, other = alfred.own_backend(Layout(self.home))
            self.assertFalse(ok)
            self.assertIn("Docker", other)

    def test_nothing_answering(self):
        def refuse(url, timeout=0):
            raise alfred.urllib.error.URLError("refused")
        with mock.patch.object(alfred.urllib.request, "urlopen", refuse):
            self.assertEqual(alfred.own_backend(Layout(self.home)), (False, None))


class StartReportsWhyTest(unittest.TestCase):

    def test_a_start_that_does_not_answer_prints_the_crashed_processes_reason(self):
        home = make_home()
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        status = {"processes": [
            {"name": "BACKEND", "state": "CRASHED", "detail": "cannot listen on 0.0.0.0:3000: address in use. Change ALFRED_UI_PORT",
             "listeners": ["0.0.0.0:3000 (UI, API, /mcp)"]},
            {"name": "OUTBOUND", "state": "RUNNING", "detail": "", "listeners": ["127.0.0.2:443"]},
        ]}
        with mock.patch.object(alfred, "ensure_env"), mock.patch.object(alfred, "service_installed", return_value=True), \
                mock.patch.object(alfred, "service", return_value=(0, "")), mock.patch.object(alfred, "own_backend", return_value=(False, None)), \
                mock.patch.object(alfred, "call_supervisor", return_value=status):
            code, out, _ = run_main(home, ["start"])
        self.assertEqual(code, alfred.ERROR)
        # Plain output (not a terminal): one line per finished row, the crashed one with its reason - and no wait for the
        # 60 s limit, because CRASHED is the supervisor giving up.
        self.assertIn("FAIL backend", out)
        self.assertIn("cannot listen on 0.0.0.0:3000", out)
        self.assertIn("ALFRED_UI_PORT", out)
        self.assertIn("ok   outbound", out)
        self.assertNotIn("FAIL outbound", out)
        self.assertIn("Alfred did not start", out)


class FollowTest(unittest.TestCase):
    """update and stop show each step; piped, that is one line per finished step."""

    def setUp(self):
        self.home = make_home()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.layout = Layout(self.home)
        poll = mock.patch.object(alfred, "POLL_SECONDS", 0)
        poll.start()
        self.addCleanup(poll.stop)

    def follow(self, jobs, answers=True):
        """jobs: the supervisor's /update answers in order (None = the supervisor is gone, the installer runs)."""
        queue = list(jobs)

        def supervisor(layout, method, path, timeout=10):
            return queue.pop(0) if len(queue) > 1 else queue[0]

        def version():
            return "1.5.0" if not queue or queue[0] is None else "1.4.0"
        out = io.StringIO()
        with mock.patch.object(alfred, "call_supervisor", supervisor), \
                mock.patch.object(alfred, "own_backend", lambda layout, timeout=2: (answers and queue[0] is None, None)), \
                mock.patch.object(self.layout, "version", version), redirect_stdout(out):
            result = alfred.follow_update(self.layout, alfred.ui(), "1.5.0", 150 * 1048576)
        return result, out.getvalue()

    def test_an_update_is_followed_until_the_new_version_answers(self):
        result, out = self.follow([
            {"state": "DOWNLOADING", "downloadedBytes": 50 * 1048576, "totalBytes": 150 * 1048576},
            {"state": "DOWNLOADING", "downloadedBytes": 150 * 1048576, "totalBytes": 150 * 1048576},
            {"state": "VERIFYING", "downloadedBytes": 150 * 1048576, "totalBytes": 150 * 1048576},
            {"state": "INSTALLING"},
            None,
        ])
        self.assertEqual(result, "ok")
        self.assertIn("Installing Alfred 1.5.0", out)
        for row in ("ok   Downloading    150 MB", "ok   Checksum       matches the release", "ok   Installing", "ok   Alfred 1.5.0   answers"):
            self.assertIn(row, out)

    def test_a_failed_job_marks_the_step_it_failed_on(self):
        result, out = self.follow([
            {"state": "DOWNLOADING", "downloadedBytes": 1, "totalBytes": 10},
            {"state": "FAILED", "error": "the downloaded installer's checksum is 00…, the release says ab…"},
        ])
        self.assertEqual(result, "failed")
        self.assertIn("FAIL Downloading", out)
        self.assertIn("checksum is 00", out)
        self.assertIn("keeps running the version it had", out)

    def test_a_pause_from_elsewhere_ends_the_watch_as_paused(self):
        result, out = self.follow([
            {"state": "DOWNLOADING", "version": "1.5.0", "downloadedBytes": 50 * 1048576, "totalBytes": 150 * 1048576},
            {"state": "PAUSED", "version": "1.5.0", "downloadedBytes": 60 * 1048576, "totalBytes": 150 * 1048576},
        ])
        self.assertEqual(result, "paused")
        self.assertIn("WARN Downloading    paused at 60 of 150 MB", out)

    def test_an_installer_from_the_cache_says_so(self):
        result, out = self.follow([
            {"state": "VERIFYING", "version": "1.5.0", "downloadedBytes": 150 * 1048576, "totalBytes": 150 * 1048576, "cached": True},
            {"state": "INSTALLING", "version": "1.5.0", "cached": True},
            None,
        ])
        self.assertEqual(result, "ok")
        self.assertIn("already here", out)

    def test_a_new_version_that_did_not_start_is_reported_with_the_installers_reason(self):
        queue = [{"state": "INSTALLING", "version": "1.5.0"}, None, None,
                 {"state": "FAILED", "version": "1.5.0", "error": "Alfred 1.5.0 was installed but did not start: port 3000 is "
                                                                   "in use by node.exe (pid 4410). Alfred 1.4.0 was put back."}]

        def supervisor(layout, method, path, timeout=10):
            return queue.pop(0) if len(queue) > 1 else queue[0]
        out = io.StringIO()
        with mock.patch.object(alfred, "call_supervisor", supervisor), \
                mock.patch.object(alfred, "own_backend", lambda layout, timeout=2: (queue[0] is None or queue[0].get("state") == "FAILED", None)), \
                mock.patch.object(self.layout, "version", lambda: "1.4.0"), redirect_stdout(out):
            result = alfred.follow_update(self.layout, alfred.ui(), "1.5.0", 1, "1.4.0")
        self.assertEqual(result, "failed")
        self.assertIn("FAIL Alfred 1.5.0   did not start", out.getvalue())
        self.assertIn("node.exe (pid 4410)", out.getvalue())

    def test_without_a_supervisor_to_follow_it_says_so(self):
        result, _ = self.follow([None])
        self.assertIsNone(result)

    def test_stop_ticks_off_each_process(self):
        running = {"processes": [{"name": n, "state": "RUNNING", "listeners": []} for n in ("BACKEND", "OUTBOUND")]}
        out = io.StringIO()
        with mock.patch.object(alfred, "call_supervisor", side_effect=[running] + [None] * 50), \
                mock.patch.object(alfred, "service_installed", return_value=True), \
                mock.patch.object(alfred, "service", return_value=(0, "")), redirect_stdout(out):
            code = alfred.cmd_stop(self.layout, [])
        self.assertEqual(code, alfred.OK)
        text = out.getvalue()
        self.assertIn("ok   outbound   stopped", text)
        self.assertIn("ok   backend    stopped", text)
        self.assertIn("Alfred stopped", text)
        self.assertLess(text.index("outbound"), text.index("backend"))  # the order the supervisor stops them in


class DoctorTest(unittest.TestCase):
    """alfred doctor: one pass over what people troubleshoot one at a time, each problem with its fix; exit 1 only for
    problems, warnings alone are 0; --json for scripts."""

    def setUp(self):
        self.home = make_home()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.layout = Layout(self.home)

    def run_doctor(self, args=(), supervisor=None, own=(True, None), settings=None, disk=None, backend=None, answers=()):
        def call(layout, method, path, timeout=10):
            return (supervisor or {}).get(path)

        def backend_json(layout, method, path, timeout=30, body=None):
            return (backend or {})[path]
        usage = disk or shutil.disk_usage(self.home)
        out = io.StringIO()
        with mock.patch.object(alfred, "call_supervisor", call), mock.patch.object(alfred, "own_backend", lambda layout, timeout=2: own), \
                mock.patch.object(self.layout, "settings", lambda: settings or {}), mock.patch.object(alfred, "backend_json", backend_json), \
                mock.patch.object(alfred, "tcp_answers", lambda host, port, timeout=1.5: int(port) in answers), \
                mock.patch.object(alfred, "port_owner", lambda port, layout=None: None), \
                mock.patch.object(alfred.shutil, "disk_usage", lambda path: usage), redirect_stdout(out):
            code = alfred.cmd_doctor(self.layout, list(args))
        return code, out.getvalue()

    HEALTHY = {"/status": {"processes": [{"name": "BACKEND", "state": "RUNNING", "pid": 1, "startedAt": None, "restarts": 0, "detail": "", "listeners": []}]},
               "/agents": [{"project": "odeysys", "state": "ATTACHED", "pid": 7720, "features": "db,logs", "detail": ""}]}
    BACKEND = {"/database/stats": {"files": [{"name": "calls.db", "rows": 10, "sizeBytes": 2 * 1073741824}]},
               "/server/update": {"currentVersion": "3.0.5", "latestVersion": "3.0.6", "available": True, "job": {"state": "IDLE"}}}

    def test_a_healthy_install_is_all_ok_with_exit_code_0(self):
        code, out = self.run_doctor(supervisor=self.HEALTHY, backend=self.BACKEND, answers=(443, 8081, 8080),
                                    settings={"INTERNAL_CALL_SERVICES": "odeysys:8081:8080", "REVERSE_PROXY_ENABLED": "true"})
        self.assertEqual(code, alfred.OK, out)
        for row in ("ok   Alfred runs", "ok   UI port 3000", "ok   Outbound :443", "ok   Reverse :8081", "ok   Agent odeysys",
                    "ok   Storage", "ok   Updates", "ok   Settings"):
            self.assertIn(row, out)
        self.assertIn("3.0.6 available", out)
        self.assertIn("0 problems", out)

    def test_a_projects_app_that_does_not_answer_is_a_problem_with_its_fix(self):
        code, out = self.run_doctor(supervisor=self.HEALTHY, backend=self.BACKEND, answers=(443, 8081),
                                    settings={"INTERNAL_CALL_SERVICES": "billing:8082:9090"})
        self.assertEqual(code, alfred.ERROR)
        self.assertIn("FAIL Reverse :8082", out)
        self.assertIn("billing :9090: nothing answers", out)
        self.assertIn("alfred project remove billing", out)

    def test_little_disk_left_is_a_warning_and_warnings_alone_exit_0(self):
        import collections
        usage = collections.namedtuple("usage", "total used free")(100 * 1073741824, 92 * 1073741824, 8 * 1073741824)
        code, out = self.run_doctor(supervisor=self.HEALTHY, backend=self.BACKEND, answers=(443,), disk=usage)
        self.assertIn("WARN Disk", out)
        self.assertIn("8.0 GB free (8%)", out)
        self.assertEqual(code, alfred.OK)

    def test_a_stopped_alfred_says_how_to_start_it(self):
        code, out = self.run_doctor(supervisor={}, own=(False, None))
        self.assertEqual(code, alfred.ERROR)
        self.assertIn("FAIL Alfred runs", out)
        self.assertIn("alfred start", out)

    def test_json_for_scripts(self):
        code, out = self.run_doctor(["--json"], supervisor=self.HEALTHY, backend=self.BACKEND, answers=(443,))
        rows = json.loads(out)
        self.assertEqual({"check", "status", "detail", "fix"}, set(rows[0]))
        self.assertIn("Alfred runs", [r["check"] for r in rows])
        self.assertNotIn("\x1b", out)
        self.assertEqual(code, alfred.OK)


class EnsureEnvTest(unittest.TestCase):

    def test_a_failed_env_creation_says_what_failed(self):
        home = make_home()
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        os.remove(os.path.join(home, ".env"))
        failed = mock.Mock(returncode=1, stdout="", stderr="error: UnsupportedOperationException")
        err = io.StringIO()
        with mock.patch.object(alfred, "server_config_cli", return_value=failed), redirect_stderr(err):
            with self.assertRaises(SystemExit):
                alfred.ensure_env(Layout(home))
        self.assertIn("Could not create", err.getvalue())
        self.assertIn("UnsupportedOperationException", err.getvalue())


if __name__ == "__main__":
    unittest.main()
