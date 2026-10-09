"""packaging/launcher/attach_cli.py: agent arguments from .env, project choice, and switching to the app's owner."""

import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import attach_cli  # noqa: E402
from layout import Layout  # noqa: E402


def make_layout(env_lines):
    home = tempfile.mkdtemp(prefix="alfred-home-")
    shutil.copy(os.path.join(ROOT, "settings.properties"), os.path.join(home, "settings.properties"))
    os.makedirs(os.path.join(home, "app"))
    os.makedirs(os.path.join(home, "data", "certs"))
    for jar in ("attach-cli.jar", "alfred-agent.jar"):
        open(os.path.join(home, "app", jar), "w").close()
    with open(os.path.join(home, ".env"), "w", encoding="utf-8") as f:
        f.write("\n".join(env_lines) + "\n")
    return Layout(home)


class ArgsTest(unittest.TestCase):

    def test_flags_and_project_are_parsed(self):
        self.assertEqual(attach_cli.parse_load_args(["123"]), ("123", [], None))
        self.assertEqual(attach_cli.parse_load_args(["123", "--db", "--project", "demo", "--proxy"]), ("123", ["db", "proxy"], "demo"))
        self.assertIsNone(attach_cli.parse_load_args(["abc"]))
        self.assertIsNone(attach_cli.parse_load_args(["123", "--teleport"]))
        self.assertIsNone(attach_cli.parse_load_args(["123", "--project"]))

    def test_db_needs_a_project_unless_exactly_one_exists(self):
        two = {"INTERNAL_CALL_SERVICES": "a:9001:8080,b:9002:8081:out.local:8443"}
        with self.assertRaises(LookupError):
            attach_cli.choose_project(two, None, ["db"])
        self.assertIsNone(attach_cli.choose_project(two, None, ["proxy"]))
        self.assertEqual(attach_cli.choose_project(two, "b", ["db"])["name"], "b")
        self.assertEqual(attach_cli.choose_project({"INTERNAL_CALL_SERVICES": "a:9001:8080"}, None, ["logs"])["name"], "a")
        with self.assertRaises(LookupError):
            attach_cli.choose_project(two, "c", [])

    def test_base_args_use_the_ui_port_and_the_projects_own_outbound_address(self):
        layout = make_layout(["ALFRED_UI_PORT=3100", "ALFRED_OUTBOUND_PROXY_LISTEN=0.0.0.0:443",
                              "INTERNAL_CALL_SERVICES=a:9001:8080,b:9002:8081:out.local:8443", "WEBHOOK_SECRET=abc"])
        settings = layout.settings()
        projects = attach_cli.projects(settings)
        self.assertEqual(attach_cli.base_args(layout, settings, None), "alfredUrl=http://127.0.0.1:3100;proxy=127.0.0.1:443")
        self.assertEqual(attach_cli.base_args(layout, settings, projects[0]),
                         "alfredUrl=http://127.0.0.1:3100;project=a;proxy=127.0.0.1:443")
        self.assertEqual(attach_cli.base_args(layout, settings, projects[1]),
                         "alfredUrl=http://127.0.0.1:3100;project=b;proxy=out.local:8443")

    def test_the_docker_scripts_point_the_agent_at_the_docker_alfred(self):
        layout = make_layout(["ALFRED_UI_PORT=3001", "WEBHOOK_SECRET=native"])
        settings = layout.settings()
        with patch.dict(os.environ, {"ALFRED_ATTACH_URL": "http://localhost:3000", "ALFRED_ATTACH_SECRET": "docker"}):
            self.assertTrue(attach_cli.base_args(layout, settings, None).startswith("alfredUrl=http://localhost:3000;"))
            self.assertEqual(attach_cli.secrets_env(layout, settings)["ALFRED_AGENT_SECRET"], "docker")
        env_file = os.path.join(tempfile.mkdtemp(prefix="alfred-docker-"), ".env")
        import alfred_settings
        env = alfred_settings.docker_attach_env(env_file)
        self.assertEqual(env["ALFRED_ATTACH_URL"], os.environ.get("ALFRED_ATTACH_URL", "http://localhost:3000"))
        self.assertEqual(env["ALFRED_ATTACH_SECRET"], os.environ.get("ALFRED_ATTACH_SECRET", "change-me-in-production"))

    def test_secret_and_ca_travel_in_the_environment_only(self):
        layout = make_layout(["WEBHOOK_SECRET=abc"])
        with open(attach_cli.ca_file(layout), "w", encoding="utf-8") as f:
            f.write("PEM")
        settings = layout.settings()
        env = attach_cli.secrets_env(layout, settings)
        self.assertEqual(env["ALFRED_AGENT_SECRET"], "abc")
        self.assertEqual(env["ALFRED_AGENT_CA"], "PEM")
        with patch.object(attach_cli.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertEqual(attach_cli.main(layout, "attach", ["4242", "--proxy"]), 0)
        command = run.call_args[0][0]
        self.assertNotIn("abc", " ".join(command))
        self.assertEqual(command[command.index("--add") + 1], "proxy")
        self.assertEqual(run.call_args[1]["env"]["ALFRED_AGENT_SECRET"], "abc")


class FindTheAppTest(unittest.TestCase):
    """A project's app is the JVM listening on its upstream port - found without being told a pid."""

    NETSTAT = """
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    0.0.0.0:9001           0.0.0.0:0              LISTENING       68108
  TCP    127.0.0.1:9001         127.0.0.1:52000        ESTABLISHED     68108
  TCP    [::]:9001              [::]:0                 LISTENING       68108
"""
    SS = """LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))
LISTEN 0 4096 *:9001 *:* users:(("java",pid=4242,fd=321))
"""

    def test_windows_netstat_names_the_listening_pid(self):
        with patch.object(attach_cli, "posix", lambda: False):
            self.assertEqual(68108, attach_cli.listening_pid(9001, run=lambda argv: self.NETSTAT))
            self.assertIsNone(attach_cli.listening_pid(9002, run=lambda argv: self.NETSTAT))

    def test_linux_ss_names_the_listening_pid(self):
        with patch.object(attach_cli, "posix", lambda: True), patch.object(attach_cli.shutil, "which", lambda name: "/usr/bin/ss"):
            self.assertEqual(4242, attach_cli.listening_pid("9001", run=lambda argv: self.SS))
            self.assertIsNone(attach_cli.listening_pid(22000, run=lambda argv: self.SS))

    def test_windows_netstat_opens_no_window(self):
        # The supervisor has no console: without CREATE_NO_WINDOW each netstat flashed a window every 15 s.
        if os.name != "nt":
            self.skipTest("CREATE_NO_WINDOW exists on Windows only")
        seen = {}

        def fake_run(argv, **kwargs):
            seen.update(kwargs)
            return type("Done", (), {"stdout": self.NETSTAT})()
        with patch.object(attach_cli, "posix", lambda: False), patch.object(attach_cli.subprocess, "run", fake_run):
            self.assertEqual(68108, attach_cli.listening_pid(9001))
        self.assertEqual(attach_cli.subprocess.CREATE_NO_WINDOW, seen.get("creationflags"))

    def test_no_window_adds_nothing_on_posix(self):
        with patch.object(attach_cli, "posix", lambda: True):
            self.assertEqual({}, attach_cli.no_window())

    def test_a_tool_that_fails_means_not_found_not_a_crash(self):
        def boom(argv):
            raise OSError("no netstat")
        with patch.object(attach_cli, "posix", lambda: False):
            self.assertIsNone(attach_cli.listening_pid(9001, run=boom))

    def test_attach_pid_runs_the_cli_like_alfred_attach_does(self):
        layout = make_layout(["ALFRED_UI_PORT=3001", "INTERNAL_CALL_SERVICES=odeysys:8080:9001", "WEBHOOK_SECRET=s3cret"])
        calls = []

        class Done:
            returncode = 0
            stdout = "PID 68108 (java): Alfred proxy,db,logs,redis\n"
            stderr = ""

        def fake_run(argv, env=None, capture_output=False, text=False, timeout=None, creationflags=0):
            calls.append((argv, env))
            return Done()
        with patch.object(attach_cli.subprocess, "run", fake_run), patch.object(attach_cli, "owner_of", lambda pid: None):
            ok, detail = attach_cli.attach_pid(layout, layout.settings(), 68108, {"name": "odeysys"}, ["proxy", "db", "logs", "redis"])
        self.assertTrue(ok)
        self.assertEqual("PID 68108 (java): Alfred proxy,db,logs,redis", detail)
        argv, env = calls[0]
        self.assertEqual(["attach", "68108", "--agent", attach_cli.attached_agent_jar(layout), "--args",
                          "alfredUrl=http://127.0.0.1:3001;project=odeysys;proxy=127.0.0.2:443", "--add", "proxy,db,logs,redis"], argv[3:])
        self.assertEqual("s3cret", env["ALFRED_AGENT_SECRET"])
        self.assertNotIn("s3cret", " ".join(argv))

    def test_a_failed_attach_reports_the_last_line(self):
        layout = make_layout(["INTERNAL_CALL_SERVICES=odeysys:8080:9001"])

        class Failed:
            returncode = 1
            stdout = ""
            stderr = "error: pid 68108: Unable to open socket file\n"

        with patch.object(attach_cli.subprocess, "run", lambda *a, **k: Failed()), patch.object(attach_cli, "owner_of", lambda pid: None):
            ok, detail = attach_cli.attach_pid(layout, layout.settings(), 68108, {"name": "odeysys"}, ["db"])
        self.assertFalse(ok)
        self.assertEqual("error: pid 68108: Unable to open socket file", detail)


@unittest.skipIf(os.name == "nt", "user switching is Linux only")
class OwnerTest(unittest.TestCase):

    def test_another_users_app_is_attached_as_that_user(self):
        with patch.object(attach_cli, "current_user", return_value="root"), patch.object(attach_cli.shutil, "which", return_value="/sbin/runuser"):
            self.assertEqual(attach_cli.as_user("app", ["java", "-jar", "x.jar"]), ["runuser", "-u", "app", "--", "java", "-jar", "x.jar"])
            self.assertEqual(attach_cli.as_user("root", ["java"]), ["java"])
        with patch.object(attach_cli, "current_user", return_value="root"), patch.object(attach_cli.shutil, "which", return_value=None):
            self.assertEqual(attach_cli.as_user("app", ["java", "a b"])[:6], ["su", "-m", "-s", "/bin/sh", "app", "-c"])

    def test_a_non_root_caller_cannot_attach_to_someone_elses_app(self):
        layout = make_layout([])
        with patch.object(attach_cli, "owner_of", return_value="app"), patch.object(attach_cli, "current_user", return_value="bob"):
            self.assertEqual(attach_cli.main(layout, "attach", ["4242"]), attach_cli.NOT_ALLOWED)



class AttachedJarTest(unittest.TestCase):
    """A JVM must never be given the installed jar: an update replacing it under a running agent muted that agent."""

    def test_the_jvm_gets_a_copy_named_by_content_that_an_update_does_not_touch(self):
        layout = make_layout([])
        with open(attach_cli.agent_jar(layout), "wb") as f:
            f.write(b"agent version one")
        first = attach_cli.attached_agent_jar(layout)
        self.assertEqual(os.path.join(layout.home, "agents"), os.path.dirname(first))
        self.assertRegex(os.path.basename(first), r"^alfred-agent-[0-9a-f]{16}\.jar$")
        self.assertEqual(first, attach_cli.attached_agent_jar(layout), "the same content is the same copy")
        # an update replaces the installed jar: the running JVM's copy stays as it was, the next JVM gets a new one
        with open(attach_cli.agent_jar(layout), "wb") as f:
            f.write(b"agent version two")
        second = attach_cli.attached_agent_jar(layout)
        self.assertNotEqual(first, second)
        with open(first, "rb") as f:
            self.assertEqual(b"agent version one", f.read())
        self.assertEqual([], [n for n in os.listdir(os.path.dirname(first)) if n.endswith(".part")])

    def test_without_a_writable_install_folder_the_installed_jar_is_used(self):
        layout = make_layout([])
        with patch.object(attach_cli.os, "makedirs", side_effect=PermissionError("denied")):
            self.assertEqual(attach_cli.agent_jar(layout), attach_cli.attached_agent_jar(layout))


class WindowsOwnerTest(unittest.TestCase):
    """The Windows service runs as LocalSystem; a developer's app runs as them. Attach-cli must run as the app's owner."""

    def test_a_service_attaches_as_the_apps_owner_with_only_the_agents_values_added(self):
        layout = make_layout(["ALFRED_UI_PORT=3001", "INTERNAL_CALL_SERVICES=odeysys:8080:9001", "WEBHOOK_SECRET=s3cret"])
        runs = []

        class FakeRunas:
            @staticmethod
            def run_as_owner(pid, argv, extra_env=None, cwd=None):
                runs.append((pid, argv, extra_env, cwd))
                return attach_cli.subprocess.CompletedProcess(argv, 0, "PID 53628 (java): Alfred db\n", "")

        with patch.object(attach_cli, "posix", lambda: False), patch.dict(sys.modules, {"win_runas": FakeRunas}), \
                patch.object(attach_cli, "owner_of", lambda pid: "DESKTOP\\work"), \
                patch.object(attach_cli, "current_user", lambda: "NT AUTHORITY\\SYSTEM"), \
                patch.object(attach_cli.subprocess, "run", side_effect=AssertionError("not as the service")):
            ok, detail = attach_cli.attach_pid(layout, layout.settings(), 53628, {"name": "odeysys"}, ["db"])
        self.assertTrue(ok)
        pid, argv, extra, cwd = runs[0]
        self.assertEqual(53628, pid)
        self.assertEqual(["attach", "53628"], argv[3:5])
        self.assertEqual("s3cret", extra["ALFRED_AGENT_SECRET"])
        self.assertTrue(all(k.startswith("ALFRED_AGENT_") for k in extra), "the service's own environment stays behind")
        self.assertEqual(layout.app, cwd)

    def test_an_app_missing_from_the_services_jvm_list_is_looked_up_as_its_owner(self):
        layout = make_layout([])
        lists = []

        def jvm_pids(layout, owner=None, pid=None):
            lists.append(owner)
            return {53628: {}} if owner == "DESKTOP\\work" else {}
        with patch.object(attach_cli, "jvm_pids", jvm_pids), patch.object(attach_cli, "owner_of", lambda pid: "DESKTOP\\work"), \
                patch.object(attach_cli, "current_user", lambda: "NT AUTHORITY\\SYSTEM"):
            with patch.object(attach_cli, "privileged", lambda: True):
                self.assertTrue(attach_cli.visible_jvm(layout, 53628))
            self.assertEqual([None, "DESKTOP\\work"], lists)
            with patch.object(attach_cli, "privileged", lambda: False):
                self.assertFalse(attach_cli.visible_jvm(layout, 53628))

    @unittest.skipUnless(os.name == "nt", "Windows tokens")
    def test_this_process_is_owned_by_the_current_user(self):
        import win_runas
        me = win_runas.current_user()
        self.assertTrue(me)
        self.assertEqual(me, win_runas.process_user(os.getpid()))
        self.assertIsInstance(win_runas.is_privileged(), bool)


if __name__ == "__main__":
    unittest.main()
