"""alfred_skill.py and `alfred skill`: the twelve /alfred-* Claude Code skills (with their shared rules) copied where
Claude Code finds them (specs/015)."""

import io
import os
import re
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

SKILLS_DIR = os.path.join(ROOT, "skills")
RULES = os.path.join(SKILLS_DIR, "_shared", "rules.md")


def mcp_tools():
    tools = set()
    folder = os.path.join(ROOT, "mcp-server", "src", "tools")
    for path in os.listdir(folder):
        with open(os.path.join(folder, path), encoding="utf-8") as f:
            for line in f:
                if "registerTool('" in line:
                    tools.add(line.split("registerTool('")[1].split("'")[0])
    return tools


TOOL_NAME = re.compile(r"`((?:board|get|read|list|search|problem|investigate|wait|call|log|db|exception|locate|endpoint|add|set|compare|"
                       r"suggest|create|start|stop|trace|diff|redis|triage|check)_[a-z_]+)`")


class ShippedSkillsTest(unittest.TestCase):
    def test_every_skill_is_in_the_repo_names_itself_and_points_at_the_shared_rules(self):
        self.assertEqual(12, len(alfred_skill.SKILLS))
        for name in alfred_skill.SKILLS:
            with open(os.path.join(SKILLS_DIR, name, "SKILL.md"), encoding="utf-8") as f:
                text = f.read()
            front = text.split("---")[1]
            self.assertIn(f"name: {name}\n", front, name)
            self.assertIn("description:", front, name)
            self.assertIn("rules.md", text, f"{name} must tell Claude to read the shared rules")

    def test_the_rules_hold_the_journal_the_limits_and_the_flow(self):
        with open(RULES, encoding="utf-8") as f:
            text = f.read()
        for part in ("## 1. The user decides", "## 2. The card journal", "## 3. One card per problem", "## 4. What becomes a card",
                     "## 5. Every run", "waitingOn", "board_session_log", "--dry"):
            self.assertIn(part, text)

    def test_the_skills_and_the_rules_only_name_tools_alfred_has(self):
        tools = mcp_tools()
        for path in [RULES] + [os.path.join(SKILLS_DIR, n, "SKILL.md") for n in alfred_skill.SKILLS]:
            with open(path, encoding="utf-8") as f:
                named = set(TOOL_NAME.findall(f.read()))
            self.assertEqual(set(), named - tools, f"{path} names tools the MCP server does not have")


class ReleaseArchiveTest(unittest.TestCase):
    def test_the_release_zip_holds_every_skill_folder_with_its_rules(self):
        import zipfile
        import build_dist
        out = tempfile.mkdtemp(prefix="skill-dist-")
        try:
            with mock.patch.object(build_dist, "DIST", out):
                path = build_dist.skill_archive("1.2.3")
            self.assertTrue(path.endswith("alfred-skills-1.2.3.zip"))
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
            for name in alfred_skill.SKILLS:
                self.assertIn(f"{name}/SKILL.md", names)
                self.assertIn(f"{name}/rules.md", names)
            self.assertFalse(any(n.startswith("_shared/") for n in names))
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

    def skills_root(self):
        return os.path.join(self.home, ".claude", "skills")

    def test_user_scope_installs_every_skill_with_the_rules_and_updates_in_place(self):
        lines = alfred_skill.install(SKILLS_DIR, version="1.0.0")
        self.assertEqual(12, len([l for l in lines if l.startswith("installed")]))
        for name in alfred_skill.SKILLS:
            dest = os.path.join(self.skills_root(), name)
            self.assertTrue(os.path.isfile(os.path.join(dest, "SKILL.md")))
            self.assertTrue(os.path.isfile(os.path.join(dest, "rules.md")))
            self.assertEqual("1.0.0", alfred_skill.installed_version(dest))
        self.assertFalse(os.path.exists(os.path.join(self.skills_root(), "_shared")))

        lines = alfred_skill.install(SKILLS_DIR, version="1.1.0")
        self.assertIn("1.0.0 -> 1.1.0", lines[0])
        self.assertTrue(all("Alfred 1.1.0" in l for l in alfred_skill.status()))

    def test_install_removes_the_retired_alfred_qa_it_installed_but_not_someone_elses(self):
        old = os.path.join(self.skills_root(), "alfred-qa")
        os.makedirs(old)
        with open(os.path.join(old, alfred_skill.MARKER), "w", encoding="utf-8") as f:
            f.write("3.1.0\n")
        lines = alfred_skill.install(SKILLS_DIR, version="3.2.0")
        self.assertFalse(os.path.exists(old))
        self.assertTrue(any("retired /alfred-qa" in l for l in lines))

        os.makedirs(old)
        with open(os.path.join(old, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("mine")
        alfred_skill.install(SKILLS_DIR, version="3.2.0")
        self.assertTrue(os.path.isfile(os.path.join(old, "SKILL.md")), "a folder Alfred did not install stays")

    def test_project_scope_goes_into_the_repo_and_remove_takes_every_skill_out(self):
        repo = os.path.join(self.home, "odeysys")
        os.makedirs(repo)
        alfred_skill.install(SKILLS_DIR, "project", repo, "1.0.0")
        self.assertTrue(os.path.isfile(os.path.join(repo, ".claude", "skills", "alfred-fix", "rules.md")))
        lines = alfred_skill.remove("project", repo)
        self.assertEqual(12, len([l for l in lines if l.startswith("removed")]))
        self.assertEqual([], os.listdir(os.path.join(repo, ".claude", "skills")))

    def test_a_skill_of_the_same_name_someone_else_wrote_is_left_alone(self):
        theirs = os.path.join(self.skills_root(), "alfred-fix")
        os.makedirs(theirs)
        with open(os.path.join(theirs, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("mine")
        lines = alfred_skill.install(SKILLS_DIR)
        self.assertTrue(any(l.startswith("skipped") and "alfred-fix" in l for l in lines))
        with open(os.path.join(theirs, "SKILL.md"), encoding="utf-8") as f:
            self.assertEqual("mine", f.read())
        alfred_skill.install(SKILLS_DIR, force=True)
        self.assertIsNotNone(alfred_skill.installed_version(theirs))


class AlfredSkillCommandTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="alfred-skill-")
        self.install = os.path.join(self.root, "install")
        os.makedirs(os.path.join(self.install, "data", "run"))
        app = os.path.join(self.install, "app")
        shutil.copytree(SKILLS_DIR, os.path.join(app, "skills"))
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

    def test_install_copies_the_shipped_skills_with_this_version_and_says_how_to_start(self):
        code, out, _ = self.run_main(["skill", "install"])
        self.assertEqual(alfred.OK, code)
        dest = os.path.join(self.user, ".claude", "skills", "alfred-guide")
        self.assertEqual("9.9.9", alfred_skill.installed_version(dest))
        self.assertIn("/alfred-guide", out)
        self.assertIn("claude mcp add --transport http alfred http://localhost:3100/mcp", out)
        code, out, _ = self.run_main(["skill", "status"])
        self.assertIn("Alfred 9.9.9", out)
        self.run_main(["skill", "remove"])
        self.assertFalse(os.path.exists(dest))

    def test_project_needs_an_existing_folder_and_bad_options_are_usage_errors(self):
        self.assertEqual(alfred.USAGE, self.run_main(["skill", "install", "--project", os.path.join(self.root, "nope")])[0])
        self.assertEqual(alfred.USAGE, self.run_main(["skill", "install", "--wat"])[0])
        self.assertEqual(alfred.USAGE, self.run_main(["skill"])[0])

    def test_it_needs_no_access_to_data(self):
        self.assertIn("skill", alfred.NO_DATA_NEEDED)


if __name__ == "__main__":
    unittest.main()
