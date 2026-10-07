"""packaging/launcher/docker_import.py with a fake Docker install and a stubbed docker command."""

import hashlib
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import docker_import  # noqa: E402
from layout import Layout  # noqa: E402


def tree_digest(folder):
    digest = hashlib.sha256()
    for current, folders, files in sorted(os.walk(folder)):
        folders.sort()
        for name in sorted(files):
            path = os.path.join(current, name)
            digest.update(os.path.relpath(path, folder).encode())
            with open(path, "rb") as f:
                digest.update(f.read())
    return digest.hexdigest()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class DockerImportTest(unittest.TestCase):

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="alfred-docker-")
        self.home = tempfile.mkdtemp(prefix="alfred-native-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.addCleanup(shutil.rmtree, self.home, True)
        write(os.path.join(self.repo, "docker-compose.yml"), "services: {}\n")
        write(os.path.join(self.repo, "start.py"), "\n")
        write(os.path.join(self.repo, ".env"), "REVERSE_PROXY_ENABLED=true\nBACKEND_PORT=5000\n")
        write(os.path.join(self.repo, "backend", "data", "calls.db"), "calls")
        write(os.path.join(self.repo, "backend", "data", "session-cycles", "c1.json"), "[]")
        write(os.path.join(self.repo, "proxy", "db-capture-enabled.flag"), "odeysys=on\n")
        write(os.path.join(self.repo, "proxy", "interception", "rules.json"), "[]")
        write(os.path.join(self.repo, "proxy", "certs", "mitmproxy-ca-cert.pem"), "CA")
        self.layout = Layout(self.home)
        self.compose_calls = []

    def stub_docker(self, fail_on_merge=False):
        def fake_docker(*args, capture=True):
            if args[:2] == ("inspect", "backend"):
                return "alfred"
            if args[0] == "run":
                target = [a for a in args if a.endswith(":/out")][0][:-len(":/out")]
                volume = [a for a in args if a.endswith(":/v:ro")][0].split(":")[0].split("_", 1)[1]
                write(os.path.join(target, docker_import.VOLUMES[volume]), volume)
            return ""

        class Done:
            returncode = 0
            stdout = "Imported 1 settings"
            stderr = ""

        def fake_run(command, **kwargs):
            if command[:2] == [docker_import.DOCKER, "compose"]:
                self.compose_calls.append(command[2])
                return Done()
            if fail_on_merge:
                raise docker_import.ImportFailed("settings could not be merged")
            return Done()

        return patch.object(docker_import, "docker", fake_docker), patch.object(docker_import.subprocess, "run", fake_run)

    def test_imports_data_into_the_native_layout_and_leaves_the_docker_folder_alone(self):
        before = tree_digest(self.repo)
        docker_patch, run_patch = self.stub_docker()
        with docker_patch, run_patch:
            docker_import.import_docker(self.layout, self.repo)

        self.assertEqual(tree_digest(self.repo), before)
        self.assertTrue(os.path.isfile(os.path.join(self.layout.appdata, "calls.db")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.appdata, "session-cycles", "c1.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.data, "logs.db")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.data, "db-capture.db")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.proxy_data, "db-capture-enabled.flag")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.interception, "rules.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.layout.certs, "mitmproxy-ca-cert.pem")))
        self.assertFalse(os.path.exists(os.path.join(self.layout.data, ".import-tmp")))
        self.assertEqual(self.compose_calls, ["stop"])

    def test_a_failure_removes_the_copy_and_starts_docker_again(self):
        before = tree_digest(self.repo)
        docker_patch, run_patch = self.stub_docker(fail_on_merge=True)
        with docker_patch, run_patch, self.assertRaises(docker_import.ImportFailed):
            docker_import.import_docker(self.layout, self.repo)

        self.assertEqual(tree_digest(self.repo), before)
        self.assertFalse(os.path.exists(os.path.join(self.layout.data, ".import-tmp")))
        self.assertFalse(os.path.exists(os.path.join(self.layout.appdata, "calls.db")))
        self.assertEqual(self.compose_calls, ["stop", "start"])

    def test_existing_native_data_is_moved_aside_not_deleted(self):
        write(os.path.join(self.layout.appdata, "old.db"), "old")
        docker_patch, run_patch = self.stub_docker()
        with docker_patch, run_patch:
            docker_import.import_docker(self.layout, self.repo)
        aside = [d for d in os.listdir(self.layout.data) if d.startswith(".before-import-")]
        self.assertEqual(len(aside), 1)
        self.assertTrue(os.path.isfile(os.path.join(self.layout.data, aside[0], "appdata", "old.db")))

    def test_a_folder_that_is_not_alfred_is_refused(self):
        with self.assertRaises(docker_import.ImportFailed):
            docker_import.import_docker(self.layout, self.home)

    def test_the_second_pass_copies_only_what_changed(self):
        target = os.path.join(self.home, "copy")
        source = os.path.join(self.repo, "backend", "data")
        self.assertEqual(docker_import.copy_changed(source, target), 2)
        self.assertEqual(docker_import.copy_changed(source, target), 0)
        write(os.path.join(source, "calls.db"), "calls and one more")
        self.assertEqual(docker_import.copy_changed(source, target), 1)


if __name__ == "__main__":
    unittest.main()
