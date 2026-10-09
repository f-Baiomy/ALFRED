"""build_dist.py packaging pieces that run on any OS: the .run file, executable bits, line endings, versions."""

import hashlib
import io
import os
import shutil
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import build_dist  # noqa: E402


def write(path, text, newline="\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline=newline) as f:
        f.write(text)


class PullSourcesTest(unittest.TestCase):
    """Docker Hub's pull limit stopped the v3.0.8 release build three times: images come from Google's and Amazon's
    copies first, Docker Hub last."""

    def test_official_images_come_from_google_then_amazon_then_docker_hub(self):
        self.assertEqual(["mirror.gcr.io/library/node:20-alpine", "public.ecr.aws/docker/library/node:20-alpine",
                          "node:20-alpine"], build_dist.pull_sources("node:20-alpine"))

    def test_every_image_the_build_uses_tries_docker_hub_only_last(self):
        for image in (build_dist.NODE_IMAGE, build_dist.PYTHON_IMAGE, build_dist.MAVEN_IMAGE, "debian:bookworm-slim"):
            sources = build_dist.pull_sources(image)
            self.assertTrue(sources[0].startswith("mirror.gcr.io/library/"), sources)
            self.assertEqual(image, sources[-1])

    def test_other_docker_hub_images_keep_their_namespace(self):
        self.assertEqual(["mirror.gcr.io/someone/tool:1", "someone/tool:1"], build_dist.pull_sources("someone/tool:1"))

    def test_an_image_of_another_registry_is_pulled_as_named(self):
        self.assertEqual(["ghcr.io/someone/tool:1"], build_dist.pull_sources("ghcr.io/someone/tool:1"))

    def test_a_refused_source_falls_through_to_the_next(self):
        calls = []

        def fake(argv, **kwargs):
            calls.append(argv)
            code = 1 if argv[:2] == ["docker", "image"] or argv[-1].startswith("mirror.gcr.io") else 0
            return mock.Mock(returncode=code, stdout="", stderr="toomanyrequests")
        with mock.patch.object(build_dist.subprocess, "run", fake), mock.patch.object(build_dist, "run") as run, \
                redirect_stdout(io.StringIO()):
            build_dist.ensure_image("node:20-alpine")
        pulls = [c[-1] for c in calls if c[:2] == ["docker", "pull"]]
        self.assertEqual(["mirror.gcr.io/library/node:20-alpine", "public.ecr.aws/docker/library/node:20-alpine"], pulls)
        run.assert_called_once_with(["docker", "tag", "public.ecr.aws/docker/library/node:20-alpine", "node:20-alpine"])


class ContainerOwnershipTest(unittest.TestCase):
    """On a Linux host (the release workflow) a container's root-owned output could not be moved by the build user."""

    def test_rw_mounts_are_handed_back_to_the_caller_even_when_the_script_fails(self):
        script = build_dist.owned_by_caller("set -e; jlink", ["/out", "/dist"], ids=(1001, 121))
        self.assertEqual("trap 'chown -R 1001:121 /out /dist 2>/dev/null || true' EXIT; set -e; jlink", script)

    def test_unchanged_without_host_ownership_or_writable_mounts(self):
        self.assertEqual("x", build_dist.owned_by_caller("x", ["/out"], ids=None))   # Docker Desktop on Windows
        self.assertEqual("x", build_dist.owned_by_caller("x", ["/out"], ids=(0, 0)))  # already root
        self.assertEqual("x", build_dist.owned_by_caller("x", [], ids=(1001, 121)))


class RunFileTest(unittest.TestCase):

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix="alfred-build-")
        self.addCleanup(shutil.rmtree, self.work, True)
        self.stage = os.path.join(self.work, "stage")
        write(os.path.join(self.stage, "alfred"), "#!/bin/sh\necho hi\n")
        write(os.path.join(self.stage, "runtime", "python", "bin", "python3"), "binary")
        write(os.path.join(self.stage, "runtime", "java", "bin", "java"), "binary")
        write(os.path.join(self.stage, "runtime", "java", "lib", "libjvm.so"), "binary")
        write(os.path.join(self.stage, "runtime", "python", "lib", "libpython3.13.so.1.0"), "binary")
        write(os.path.join(self.stage, "app", "launcher", "alfred.py"), "print('x')\n")
        self.header = os.path.join(self.work, "header.sh")
        write(self.header, "#!/bin/sh\r\necho header\r\nexit 0\r\n", newline="")

    def build(self):
        out = os.path.join(self.work, "alfred.run")
        build_dist.write_run(self.stage, self.header, out)
        with open(out, "rb") as f:
            data = f.read()
        head, _, payload = data.partition(b"__ARCHIVE_BELOW__\n")
        return out, head, tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz")

    def test_the_header_has_lf_endings_and_the_payload_follows_the_marker(self):
        _, head, tar = self.build()
        self.assertNotIn(b"\r", head)
        self.assertTrue(head.startswith(b"#!/bin/sh\n"))
        self.assertIn("alfred/alfred", tar.getnames())

    def test_launchers_runtimes_and_libraries_are_executable_and_the_rest_is_not(self):
        _, _, tar = self.build()
        modes = {m.name: m.mode for m in tar.getmembers()}
        self.assertEqual(modes["alfred/alfred"], 0o755)
        self.assertEqual(modes["alfred/runtime/python/bin/python3"], 0o755)
        self.assertEqual(modes["alfred/runtime/java/bin/java"], 0o755)
        self.assertEqual(modes["alfred/runtime/java/lib/libjvm.so"], 0o755)
        self.assertEqual(modes["alfred/runtime/python/lib/libpython3.13.so.1.0"], 0o755)
        self.assertEqual(modes["alfred/app/launcher/alfred.py"], 0o644)
        self.assertTrue(all(m.uid == 0 and m.uname == "root" for m in tar.getmembers()))

    def test_a_failed_write_leaves_no_file(self):
        out = os.path.join(self.work, "never.run")
        with self.assertRaises(FileNotFoundError):
            build_dist.write_run(self.stage, os.path.join(self.work, "missing-header.sh"), out)
        self.assertFalse(os.path.exists(out))

    @unittest.skipUnless(hasattr(os, "symlink") and os.name == "posix", "symlinks need POSIX")
    def test_symlinks_are_kept(self):
        os.symlink("python3", os.path.join(self.stage, "runtime", "python", "bin", "python"))
        _, _, tar = self.build()
        link = tar.getmember("alfred/runtime/python/bin/python")
        self.assertTrue(link.issym())
        self.assertEqual(link.linkname, "python3")


class VersionTest(unittest.TestCase):

    def test_the_version_comes_from_git(self):
        self.assertTrue(build_dist.version())
        self.assertNotIn("\n", build_dist.version())

    def test_numeric_versions_for_the_windows_file_version(self):
        self.assertEqual(build_dist.numeric_version("1.4.0-12-g87159af"), ["1", "4", "0"])
        self.assertEqual(build_dist.numeric_version("87159af-dirty"), ["0"])

    def test_the_manifest_names_each_installer_by_target_with_its_checksum_and_release_url(self):
        folder = tempfile.mkdtemp(prefix="alfred-dist-")
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        win = os.path.join(folder, "alfred-setup-1.4.0-windows-x64.exe")
        lin = os.path.join(folder, "alfred-setup-1.4.0-linux-x64.run")
        sums = os.path.join(folder, "SHA256SUMS")
        for path, content in ((win, b"win"), (lin, b"linux!"), (sums, b"x")):
            with open(path, "wb") as f:
                f.write(content)
        m = build_dist.manifest("1.4.0", [win, lin, sums], "https://example/dl", "Faster exports", "2026-10-08T10:00:00+00:00")
        self.assertEqual(m["version"], "1.4.0")
        self.assertEqual(m["notes"], "Faster exports")
        self.assertEqual(m["publishedAt"], "2026-10-08T10:00:00+00:00")
        self.assertEqual(sorted(m["assets"]), ["linux-x64", "windows-x64"])
        self.assertEqual(m["assets"]["windows-x64"]["url"], "https://example/dl/v1.4.0/alfred-setup-1.4.0-windows-x64.exe")
        self.assertEqual(m["assets"]["windows-x64"]["size"], 3)
        self.assertEqual(m["assets"]["linux-x64"]["sha256"], hashlib.sha256(b"linux!").hexdigest())
        # SHA256SUMS is no installer and names no target.
        self.assertIsNone(build_dist.target_of("SHA256SUMS"))

    def test_the_manifest_lists_the_releases_before_it_newest_first(self):
        asset = {"windows-x64": {"url": "u", "sha256": "s", "size": 1}}
        current = {"version": "1.5.0", "notes": "n", "publishedAt": "p", "assets": asset}
        previous = {"version": "1.4.5", "notes": "Fixes only\n\nlong details", "publishedAt": "2026-10-05", "assets": asset,
                    "releases": [{"version": "1.4.2", "notes": "x", "assets": asset},
                                 {"version": "1.5.0", "assets": asset},            # the current one again: not listed twice
                                 {"version": "1.4.1", "assets": {}},              # no installers: nothing to install
                                 "junk"]}
        m = build_dist.with_history(current, previous)
        self.assertEqual([r["version"] for r in m["releases"]], ["1.4.5", "1.4.2"])
        self.assertEqual(m["releases"][0]["notes"], "Fixes only")
        self.assertNotIn("releases", m["releases"][0])
        self.assertEqual(m["version"], "1.5.0")
        # at most KEEP_RELEASES, and nothing when there is no previous manifest
        many = {"version": "1.4.99", "assets": asset, "releases": [{"version": f"1.4.{i}", "assets": asset} for i in range(30)]}
        self.assertEqual(len(build_dist.with_history(current, many)["releases"]), build_dist.KEEP_RELEASES)
        self.assertEqual(build_dist.with_history(current, None), current)
        self.assertIsNone(build_dist.previous_manifest(os.path.join(tempfile.gettempdir(), "no-such-latest.json")))

    def test_release_notes_only_for_a_tagged_release_version(self):
        self.assertEqual(build_dist.release_notes("87159af-dirty"), "")
        self.assertEqual(build_dist.release_notes("1.4.0-12-g87159af"), "")

    def test_every_pinned_download_has_a_checksum(self):
        for kind in ("python", "jdk", "node"):
            for target in build_dist.TARGETS:
                self.assertRegex(build_dist.VERSIONS[kind][target]["sha256"], "^[0-9a-f]{64}$")
        self.assertRegex(build_dist.VERSIONS["winsw"]["sha256"], "^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
