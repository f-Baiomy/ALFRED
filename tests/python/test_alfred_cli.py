"""packaging/launcher/alfred.py: a command run by an account that may not read data/ or .env is refused with a clear
message - not answered wrongly ("not running", "No log yet") or with a traceback (FileExistsError on data\\appdata)."""

import io
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
