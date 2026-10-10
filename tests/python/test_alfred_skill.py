"""alfred_skill.py and `alfred skill`: the /alfred-qa Claude Code skill copied where Claude Code finds it."""

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
import alfred_skill  # noqa: E402

SKILL = os.path.join(ROOT, "skills", "alfred-qa", "SKILL.md")


class ShippedSkillTest(unittest.TestCase):
    def test_the_skill_names_itself_and_its_modes(self):
        with open(SKILL, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.startswith("---\nname: alfred-qa\n"))
        self.assertIn("description:", text.split("---")[1])
        for mode in ("## Listen", "## Fix", "## Verify", "## Resume", "## Rules - always", "## What becomes a card"):
            self.assertIn(mode, text)

    def test_the_skill_only_names_tools_alfred_has(self):
        with open(SKILL, encoding="utf-8") as f:
            text = f.read()
        tools = set()
        for path in os.listdir(os.path.join(ROOT, "mcp-server", "src", "tools")):
            with open(os.path.join(ROOT, "mcp-server", "src", "tools", path), encoding="utf-8") as f:
                for line in f:
                    if "registerTool('" in line:
                        tools.add(line.split("registerTool('")[1].split("'")[0])
        import re
        named = set(re.findall(r"`((?:board|get|read|list|search|problem|investigate|wait|call|log|db|exception|locate|endpoint|add|set)_[a-z_]+)`", text))
        self.assertTrue(named, "the skill names no tools")
        self.assertEqual(set(), named - tools, "the skill names tools the MCP server does not have")


class ReleaseArchiveTest(unittest.TestCase):
    def test_the_release_zip_holds_the_skill_folder_ready_to_unzip_into_claude_skills(self):
        import zipfile
        import build_dist
        out = tempfile.mkdtemp(prefix="skill-dist-")
        try:
            with mock.patch.object(build_dist, "DIST", out):
                path = build_dist.skill_archive("1.2.3")
            self.assertTrue(path.endswith("alfred-qa-skill-1.2.3.zip"))
            with zipfile.ZipFile(path) as z:
                self.assertIn("alfred-qa/SKILL.md", z.namelist())
        finally:
            shutil.rmtree(out, ignore_errors=True)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="skill-home-")
        self.env = mock.patch.dict(os.environ, {"HOME": self.home, "USERPROFILE": self.home})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_user_scope_installs_into_the_home_claude_skills_and_updates_in_place(self):
        lines = alfred_skill.install(os.path.join(ROOT, "skills"), version="1.0.0")
        dest = os.path.join(self.home, ".claude", "skills", "alfred-qa")
        self.assertTrue(os.path.isfile(os.path.join(dest, "SKILL.md")))
        self.assertEqual("1.0.0", alfred_skill.installed_version(dest))
        self.assertIn("installed /alfred-qa", lines[0])

        lines = alfred_skill.install(os.path.join(ROOT, "skills"), version="1.1.0")
        self.assertIn("updated /alfred-qa", lines[0])
        self.assertIn("1.0.0 -> 1.1.0", lines[0])
        self.assertIn("Alfred 1.1.0", alfred_skill.status()[0])

    def test_project_scope_goes_into_the_repo(self):
        repo = os.path.join(self.home, "odeysys")
        os.makedirs(repo)
        alfred_skill.install(os.path.join(ROOT, "skills"), "project", repo, "1.0.0")
        self.assertTrue(os.path.isfile(os.path.join(repo, ".claude", "skills", "alfred-qa", "SKILL.md")))
        self.assertIn("removed", alfred_skill.remove("project", repo)[0])
        self.assertFalse(os.path.exists(os.path.join(repo, ".claude", "skills", "alfred-qa")))

    def test_a_skill_of_the_same_name_someone_else_wrote_is_left_alone(self):
        theirs = os.path.join(self.home, ".claude", "skills", "alfred-qa")
        os.makedirs(theirs)
        with open(os.path.join(theirs, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("mine")
        self.assertTrue(alfred_skill.install(os.path.join(ROOT, "skills"))[0].startswith("skipped"))
        self.assertIn("not installed by Alfred", alfred_skill.remove()[0])
        with open(os.path.join(theirs, "SKILL.md"), encoding="utf-8") as f:
            self.assertEqual("mine", f.read())
        alfred_skill.install(os.path.join(ROOT, "skills"), force=True)
        self.assertIsNotNone(alfred_skill.installed_version(theirs))


class AlfredSkillCommandTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="alfred-skill-")
        self.install = os.path.join(self.root, "install")
        os.makedirs(os.path.join(self.install, "data", "run"))
        app = os.path.join(self.install, "app")
        shutil.copytree(os.path.join(ROOT, "skills"), os.path.join(app, "skills"))
        shutil.copy2(os.path.join(ROOT, "alfred_skill.py"), os.path.join(app, "alfred_skill.py"))
        with open(os.path.join(app, "VERSION"), "w", encoding="utf-8") as f:
            f.write("9.9.9\n")
        with open(os.path.join(self.install, ".env"), "w", encoding="utf-8") as f:
            f.write("ALFRED_UI_PORT=3100\n")
        self.user = os.path.join(self.root, "user")
        os.makedirs(self.user)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"ALFRED_HOME": self.install, "HOME": self.user, "USERPROFILE": self.user}), \
                redirect_stdout(out), redirect_stderr(err):
            code = alfred.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_install_copies_the_shipped_skill_with_this_version_and_says_how_to_connect(self):
        code, out, _ = self.run_main(["skill", "install"])
        self.assertEqual(alfred.OK, code)
        dest = os.path.join(self.user, ".claude", "skills", "alfred-qa")
        self.assertEqual("9.9.9", alfred_skill.installed_version(dest))
        self.assertIn("/alfred-qa listen", out)
        self.assertIn("claude mcp add --transport http alfred http://localhost:3100/mcp", out)
        code, out, _ = self.run_main(["skill", "status"])
        self.assertIn("Alfred 9.9.9", out)
        code, out, _ = self.run_main(["skill", "remove"])
        self.assertFalse(os.path.exists(dest))

    def test_project_needs_an_existing_folder_and_bad_options_are_usage_errors(self):
        self.assertEqual(alfred.USAGE, self.run_main(["skill", "install", "--project", os.path.join(self.root, "nope")])[0])
        self.assertEqual(alfred.USAGE, self.run_main(["skill", "install", "--wat"])[0])
        self.assertEqual(alfred.USAGE, self.run_main(["skill"])[0])

    def test_it_needs_no_access_to_data(self):
        self.assertIn("skill", alfred.NO_DATA_NEEDED)


if __name__ == "__main__":
    unittest.main()
