"""make_way.py (run by the Windows installer before it moves runtime\\ and app\\ aside): which processes it stops."""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "packaging", "windows"))

import make_way  # noqa: E402


class InTheWayTest(unittest.TestCase):

    def test_only_programs_of_this_install_s_runtime_and_app_and_never_itself(self):
        home = os.path.join(os.sep, "alfred")
        rows = [
            (10, os.path.join(home, "runtime", "java", "bin", "java.exe")),     # attach-cli, outlived the service
            (11, os.path.join(home, "runtime", "python", "python.exe")),        # an alfred window
            (12, os.path.join(home, "runtime", "python", "python.exe")),        # make_way itself
            (13, os.path.join(home, "service", "alfred-service.exe")),          # stopped by the installer, not here
            (14, os.path.join(os.sep, "alfred2", "runtime", "python", "python.exe")),  # another install
            (15, os.path.join(home, "runtime2", "python.exe")),                 # only a name that starts the same
            (16, os.path.join(os.sep, "Program Files", "Java", "bin", "java.exe")),     # the user's own app
        ]
        found = make_way.in_the_way(rows, home, me=12)
        self.assertEqual([10, 11], [pid for pid, _ in found])

    @unittest.skipUnless(os.name == "nt", "Windows paths are not case-sensitive")
    def test_case_and_separators_do_not_matter_on_windows(self):
        found = make_way.in_the_way([(20, r"C:\ALFRED\Runtime\Java\bin\java.exe")], "c:/alfred", me=1)
        self.assertEqual([20], [pid for pid, _ in found])

    def test_a_bad_call_is_not_an_error_for_the_installer(self):
        self.assertEqual(0, make_way.main([]))


if __name__ == "__main__":
    unittest.main()
