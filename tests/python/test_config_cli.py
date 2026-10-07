"""packaging/launcher/config_cli.py: "alfred config" / "alfred project" become ServerConfigCli command lines."""

import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import config_cli  # noqa: E402
from layout import Layout  # noqa: E402


def make_layout(env_lines=("ALFRED_UI_PORT=3100",)):
    home = tempfile.mkdtemp(prefix="alfred-home-")
    shutil.copy(os.path.join(ROOT, "settings.properties"), os.path.join(home, "settings.properties"))
    os.makedirs(os.path.join(home, "app"))
    with open(os.path.join(home, ".env"), "w", encoding="utf-8") as f:
        f.write("\n".join(env_lines) + "\n")
    return Layout(home)


class TranslateTest(unittest.TestCase):

    def test_config_commands_pass_through(self):
        self.assertEqual(config_cli.translate("config", ["set", "ALFRED_MEMORY", "3g"]), ["set", "ALFRED_MEMORY", "3g"])
        self.assertEqual(config_cli.translate("config", ["list", "--changed"]), ["list", "--changed"])
        self.assertIsNone(config_cli.translate("config", ["frobnicate"]))
        self.assertIsNone(config_cli.translate("config", []))

    def test_project_shortcuts(self):
        self.assertEqual(config_cli.translate("project", ["add", "demo", "9001", "8080", "--outbound", "h:1"]),
                         ["project-add", "demo", "9001", "8080", "--outbound", "h:1"])
        self.assertEqual(config_cli.translate("project", ["remove", "demo"]), ["project-remove", "demo"])
        self.assertIsNone(config_cli.translate("project", ["list"]))


class CommandLineTest(unittest.TestCase):

    def test_points_at_the_local_ui_port_and_names_the_os_user(self):
        layout = make_layout()
        sys.path.insert(0, ROOT)  # alfred_settings, found under app/ in an install
        command = config_cli.command_line(layout, "config", ["get", "ALFRED_UI_PORT"])
        self.assertIn("com.fathy.alfred.backend.server.cli.ServerConfigCli", " ".join(command))
        home = command.index("--home")
        self.assertEqual(command[home + 1], layout.home)
        self.assertEqual(command[command.index("--backend") + 1], "http://127.0.0.1:3100")
        self.assertEqual(command[command.index("--user") + 1], config_cli.os_user())
        self.assertEqual(command[-2:], ["get", "ALFRED_UI_PORT"])

    def test_usage_errors_exit_two_before_running_java(self):
        layout = make_layout()
        self.assertEqual(config_cli.main(layout, "config", ["nope"]), config_cli.USAGE)
        self.assertEqual(config_cli.main(layout, "config", []), config_cli.USAGE)
        self.assertEqual(config_cli.main(layout, "config", ["--help"]), config_cli.OK)

    @unittest.skipIf(os.name == "nt", "owner-only .env is a POSIX rule")
    def test_the_owner_of_env_may_edit(self):
        self.assertTrue(config_cli.may_edit(make_layout()))


if __name__ == "__main__":
    unittest.main()
