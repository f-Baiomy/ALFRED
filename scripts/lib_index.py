"""Write frontend/public/lib/index.json - the library shelf snippets can use (specs/017 R25).

The shelf is defined once, in frontend/src/app/shared/utils/snippet-libs.ts; angular.json copies each file from
node_modules into /lib/<id>/<major>/. This script reads both, checks they agree and that every file exists, and writes
the index Claude and the editor read (name, version, file, size, what it provides). tests/python/test_snippet_libs.py
fails when the index is stale, so run this after changing a library:

    python scripts/lib_index.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
LIBS_TS = os.path.join(FRONTEND, "src", "app", "shared", "utils", "snippet-libs.ts")
ANGULAR = os.path.join(FRONTEND, "angular.json")
INDEX = os.path.join(FRONTEND, "public", "lib", "index.json")
PYTHON_TS = os.path.join(FRONTEND, "src", "app", "shared", "utils", "snippet-python.ts")
PACKAGE_JSON = os.path.join(FRONTEND, "package.json")


def python():
    """Python for ```python live``` (specs/017 R27): the pinned Pyodide version and where the shelf keeps it."""
    version = json.load(open(PACKAGE_JSON, encoding="utf-8"))["devDependencies"]["pyodide"]
    folder = re.search(r"PYODIDE_DIR = '([^']+)'", open(PYTHON_TS, encoding="utf-8").read()).group(1)
    return {"version": version, "url": f"/lib/{folder}/", "packages": ["numpy", "pandas", "matplotlib"],
            "about": "```python live``` runs Python " + "3.12 (Pyodide " + version + ") in the locked frame: await alfred.calls(...) is a pandas "
                     "DataFrame, the last line is shown, matplotlib figures are drawn. Fetched and checksummed when Alfred is built."}

ENTRY = re.compile(r"\{ id: '([^']+)', name: '([^']+)', version: '([^']+)', file: '([^']+)', kind: '([^']+)', "
                   r"provides: '([^']+)', about: '([^']+)'(, heavy: true)? \}")


def shelf():
    """The SNIPPET_LIBS entries, as written in snippet-libs.ts."""
    text = open(LIBS_TS, encoding="utf-8").read()
    return [{"id": m[0], "name": m[1], "version": m[2], "file": m[3], "kind": m[4], "provides": m[5], "about": m[6],
             "heavy": bool(m[7])} for m in ENTRY.findall(text)]


def copy_rules(target="build"):
    """angular.json's lib asset rules: published path under lib/ -> node_modules source file."""
    cfg = json.load(open(ANGULAR, encoding="utf-8"))
    project = next(iter(cfg["projects"].values()))
    rules = {}
    for a in project["architect"][target]["options"]["assets"]:
        if isinstance(a, dict) and str(a.get("output", "")).startswith("lib/"):
            rules[a["output"][len("lib/"):] + "/" + a["glob"]] = os.path.join(FRONTEND, a["input"], a["glob"])
    return rules


def problems():
    """Everything that does not agree, as sentences; empty when the shelf is whole."""
    out = []
    libs = shelf()
    if not libs:
        out.append("no SNIPPET_LIBS entries found in snippet-libs.ts")
    py = python()
    if py["url"] != "/lib/pyodide/" + ".".join(py["version"].split(".")[:2]) + "/":
        out.append(f"snippet-python.ts PYODIDE_DIR ({py['url']}) is not the pinned pyodide {py['version']}'s folder")
    for target in ("build", "test"):
        rules = copy_rules(target)
        for lib in libs:
            if lib["file"] not in rules:
                out.append(f"angular.json {target}: no asset rule publishes lib/{lib['file']}")
        for path in rules:
            if path not in {l["file"] for l in libs}:
                out.append(f"angular.json {target}: lib/{path} is not on the shelf in snippet-libs.ts")
    return out


def index():
    rules = copy_rules()
    entries = []
    for lib in shelf():
        src = rules.get(lib["file"])
        entries.append({**lib, "url": "/lib/" + lib["file"], "size": os.path.getsize(src) if src and os.path.isfile(src) else None})
    return {"about": "Alfred's library shelf: snippets run with no network and load only these. "
                     "kind script = a global (provides), module = import from the name in provides (an import map gives it), "
                     "css = a stylesheet. Ask for them with libs=\"id id\" on the snippet or alfred.lib(id).",
            "libs": entries,
            "python": python()}


def main():
    bad = problems()
    if bad:
        print("\n".join(bad), file=sys.stderr)
        return 1
    missing = [l["file"] for l in index()["libs"] if l["size"] is None]
    if missing:
        print("node_modules is missing " + ", ".join(missing) + " - run npm install in frontend/ first", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    with open(INDEX, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index(), f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.relpath(INDEX, ROOT)} ({len(index()['libs'])} libraries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
