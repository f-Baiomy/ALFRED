"""install.ps1 and install.sh download the installer over many range requests at once (ALFRED_INSTALL_FETCH_ONLY
runs just that step): the bytes come out whole and in order, an expired link is resolved again, a server without
ranges still works. Each script runs for real, against a local release host (RangeServer from test_update)."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_update import ROOT, RangeServer  # noqa: E402

POWERSHELL = shutil.which("powershell.exe") or shutil.which("powershell")
SH = shutil.which("sh")
HAS_CURL = shutil.which("curl") is not None


class InstallScriptDownloadTest(unittest.TestCase):

    def setUp(self):
        self.data = os.urandom(3 * 1024 * 1024 + 321)
        self.work = tempfile.mkdtemp(prefix="alfred-install-test-")
        self.addCleanup(shutil.rmtree, self.work, True)
        self.out = os.path.join(self.work, "setup.bin")

    def run_script(self, argv, url):
        env = dict(os.environ, ALFRED_INSTALL_FETCH_ONLY=url, ALFRED_INSTALL_FETCH_TO=self.out)
        result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with open(self.out, "rb") as f:
            return f.read()

    def powershell(self, url):
        return self.run_script([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(ROOT, "install.ps1")], url)

    def sh(self, url):
        return self.run_script([SH, os.path.join(ROOT, "install.sh")], url)

    def check(self, runner, overlap=True):
        with self.subTest("in pieces over several connections"):
            server = RangeServer(self.data)
            self.addCleanup(server.close)
            self.assertEqual(self.data, runner(server.url))
            self.assertGreater(len(server.requests), 3)
            if overlap:  # a curl per piece on Windows is spawned slower than this local server answers: no overlap to see
                self.assertGreater(server.most_active, 1)
        with self.subTest("an expired link is resolved again"):
            server = RangeServer(self.data, expire_after=4)
            self.addCleanup(server.close)
            self.assertEqual(self.data, runner(server.url.replace("/alfred-setup-9.9.9-test.bin", "/release")))
            self.assertGreater(server.generation, 1)
        with self.subTest("a server without ranges is read in one stream"):
            server = RangeServer(self.data, ranges=False)
            self.addCleanup(server.close)
            self.assertEqual(self.data, runner(server.url))

    @unittest.skipUnless(POWERSHELL, "no powershell.exe here")
    def test_install_ps1_downloads_in_pieces(self):
        self.check(self.powershell)

    @unittest.skipUnless(SH and HAS_CURL, "no sh + curl here")
    def test_install_sh_downloads_in_pieces(self):
        self.check(self.sh, overlap=False)


if __name__ == "__main__":
    unittest.main()
