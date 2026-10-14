"""The library shelf (specs/017 R25): snippet-libs.ts, angular.json's copy rules and /lib/index.json agree."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import lib_index  # noqa: E402


class SnippetLibsTest(unittest.TestCase):
    def test_every_shelf_entry_is_published_by_both_builds_and_nothing_else_is(self):
        self.assertEqual(lib_index.problems(), [])
        self.assertGreaterEqual(len(lib_index.shelf()), 15)

    def test_the_index_lists_the_shelf_as_written(self):
        written = json.load(open(lib_index.INDEX, encoding="utf-8"))
        fields = ("id", "name", "version", "file", "kind", "provides")
        self.assertEqual([{k: l[k] for k in fields} for l in written["libs"]],
                         [{k: l[k] for k in fields} for l in lib_index.shelf()],
                         "public/lib/index.json is stale - run python scripts/lib_index.py")

    def test_versions_match_the_installed_packages(self):
        packages = os.path.join(lib_index.FRONTEND, "node_modules")
        if not os.path.isdir(packages):
            self.skipTest("node_modules not installed")
        pinned = json.load(open(os.path.join(lib_index.FRONTEND, "package.json"), encoding="utf-8"))["devDependencies"]
        names = {"chartjs": "chart.js", "echarts": "echarts", "d3": "d3", "plotly": "plotly.js-dist-min", "mermaid": "mermaid",
                 "three": "three", "preact": "preact", "htm": "htm", "alpine": "alpinejs", "tailwind": "@tailwindcss/browser",
                 "marked": "marked", "highlight": "@highlightjs/cdn-assets", "papaparse": "papaparse", "dayjs": "dayjs",
                 "lodash": "lodash"}
        for lib in lib_index.shelf():
            package = names.get(lib["id"].split("-")[0])
            self.assertIsNotNone(package, lib["id"])
            self.assertEqual(pinned.get(package), lib["version"], f"{package} in package.json is not pinned to {lib['version']}")


if __name__ == "__main__":
    unittest.main()
