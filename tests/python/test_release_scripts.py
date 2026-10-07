"""release.py and build.py: the version suggestion, the refusals, and the command lines - nothing tagged, pushed or built."""

import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import build  # noqa: E402
import release  # noqa: E402


class ReleaseVersionsTest(unittest.TestCase):

    def test_the_latest_release_is_the_highest_tag_numerically(self):
        self.assertEqual(release.latest_release(["v1.2.3", "v1.10.0", "v1.9.9", "junk", "v2"]), ((1, 10, 0), "v1.10.0"))
        self.assertIsNone(release.latest_release(["junk"]))
        self.assertIsNone(release.latest_release([]))

    def test_the_suggestion_is_the_next_patch_or_the_first_release(self):
        self.assertEqual(release.suggest((1, 2, 3)), "1.2.4")
        self.assertEqual(release.suggest(None), "1.0.0")
        self.assertEqual(release.bump((1, 2, 3), "minor"), "1.3.0")
        self.assertEqual(release.bump((1, 2, 3), "major"), "2.0.0")

    def test_a_version_must_be_x_y_z_above_the_latest_and_untagged(self):
        tags = ["v1.2.3", "v1.2.4"]
        self.assertIsNone(release.validate_version("1.2.5", (1, 2, 4), tags))
        self.assertIsNone(release.validate_version("v2.0.0", (1, 2, 4), tags))
        self.assertIn("not a version", release.validate_version("1.2", (1, 2, 4), tags))
        self.assertIn("not a version", release.validate_version("latest", (1, 2, 4), tags))
        self.assertIn("not above", release.validate_version("1.2.4", (1, 2, 4), tags))
        self.assertIn("not above", release.validate_version("1.0.0", (1, 2, 4), tags))
        # Above the latest by number but the tag exists (someone tagged ahead): refused too.
        self.assertIn("already exists", release.validate_version("1.2.5", (1, 2, 4), tags + ["v1.2.5"]))
        self.assertIsNone(release.validate_version("1.0.0", None, []))

    def test_preflight_names_every_reason_in_fixing_order(self):
        self.assertEqual(release.preflight("master", False, 0, 0), [])
        problems = release.preflight("012-server-program", True, 2, 1)
        self.assertEqual(len(problems), 4)
        self.assertIn("releases are cut from master", problems[0])
        self.assertIn("uncommitted", problems[1])
        self.assertIn("behind", problems[2])
        self.assertIn("ahead", problems[3])

    def test_default_notes_are_the_commit_list(self):
        self.assertEqual(release.commit_list(["abc fix: a", "", "def feat: b"]), "- abc fix: a\n- def feat: b")
        self.assertEqual(release.commit_list([]), "")


class BuildScriptTest(unittest.TestCase):

    def test_the_command_line_follows_the_answers(self):
        argv = build.command_line("windows", True, "8.8.8.8")
        self.assertEqual(argv[1:], [os.path.join(ROOT, "build_dist.py"), "--target", "windows", "--skip-tests", "--dns", "8.8.8.8"])
        self.assertEqual(build.command_line("all", False, "")[2:], ["--target", "all"])

    def test_targets_accept_numbers_and_names(self):
        self.assertEqual(build.TARGETS["1"], "windows")
        self.assertEqual(build.TARGETS["2"], "linux")
        self.assertEqual(build.TARGETS["3"], "all")
        self.assertEqual(build.TARGETS["both"], "all")

    def test_the_dns_answer_is_remembered_in_env_without_touching_other_lines(self):
        folder = tempfile.mkdtemp(prefix="alfred-env-")
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        env = os.path.join(folder, ".env")
        with open(env, "w", encoding="utf-8") as f:
            f.write("# kept\nREVERSE_PROXY_ENABLED=true\nALFRED_BUILD_DNS=1.1.1.1\n")
        build.remember_env_value(env, "ALFRED_BUILD_DNS", "8.8.8.8")
        with open(env, encoding="utf-8") as f:
            self.assertEqual(f.read(), "# kept\nREVERSE_PROXY_ENABLED=true\nALFRED_BUILD_DNS=8.8.8.8\n")
        self.assertEqual(build.read_env_value(env, "ALFRED_BUILD_DNS"), "8.8.8.8")
        build.remember_env_value(env, "ALFRED_BUILD_DNS", "")
        self.assertEqual(build.read_env_value(env, "ALFRED_BUILD_DNS"), "")
        self.assertEqual(build.read_env_value(os.path.join(folder, "missing"), "X"), "")

    def test_install_hints_match_the_target(self):
        self.assertIn("Administrator", build.install_hint("windows"))
        self.assertNotIn("scp", build.install_hint("windows"))
        self.assertIn("scp", build.install_hint("all"))


if __name__ == "__main__":
    unittest.main()
