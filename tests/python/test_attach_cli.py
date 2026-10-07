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


if __name__ == "__main__":
    unittest.main()
