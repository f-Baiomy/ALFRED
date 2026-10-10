"""
alfred_skill.py - installs Alfred's Claude Code skill (skills/alfred-qa: QA a flow with the task board, see
docs/mcp.md "The /alfred-qa skill") where Claude Code finds it.

    user scope     ~/.claude/skills/alfred-qa/          every project on this machine
    project scope  <project>/.claude/skills/alfred-qa/  one repo (commit it to share it with the team)

Shared by the native `alfred skill ...` command (packaging/launcher/alfred.py, files in app/skills) and by
setup_mcp.py (a source checkout, files in skills/). An installed copy carries a `.alfred-skill` marker with the
version it came from, so an update replaces it and a folder of the same name that someone else wrote is never
overwritten (unless forced).
"""

import os
import shutil

SKILLS = ("alfred-qa",)
MARKER = ".alfred-skill"


def target_root(scope, project_dir=None):
    if scope == "project":
        if not project_dir:
            raise ValueError("--project needs the project folder")
        return os.path.join(os.path.abspath(project_dir), ".claude", "skills")
    return os.path.join(os.path.expanduser("~"), ".claude", "skills")


def installed_version(folder):
    """The version an Alfred-installed copy came from; None when the folder is not Alfred's (or is missing)."""
    marker = os.path.join(folder, MARKER)
    if not os.path.isfile(marker):
        return None
    with open(marker, encoding="utf-8") as f:
        return f.read().strip() or "unknown"


def install(source_root, scope="user", project_dir=None, version="dev", force=False):
    """Copies every skill from `source_root` (a folder holding alfred-qa/) into the scope. Returns one line per skill."""
    root = target_root(scope, project_dir)
    lines = []
    for name in SKILLS:
        src = os.path.join(source_root, name)
        if not os.path.isfile(os.path.join(src, "SKILL.md")):
            raise FileNotFoundError(f"{src} has no SKILL.md - this install does not carry the skill")
        dest = os.path.join(root, name)
        if os.path.isdir(dest) and installed_version(dest) is None and not force:
            lines.append(f"skipped {dest}: a skill of that name exists and was not installed by Alfred (--force replaces it)")
            continue
        was = installed_version(dest) if os.path.isdir(dest) else None
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", MARKER))
        with open(os.path.join(dest, MARKER), "w", encoding="utf-8", newline="\n") as f:
            f.write(version + "\n")
        lines.append(f"{'updated' if was else 'installed'} /{name} in {dest}" + (f" ({was} -> {version})" if was and was != version else ""))
    return lines


def remove(scope="user", project_dir=None):
    root = target_root(scope, project_dir)
    lines = []
    for name in SKILLS:
        dest = os.path.join(root, name)
        if not os.path.isdir(dest):
            lines.append(f"/{name} is not installed in {root}")
        elif installed_version(dest) is None:
            lines.append(f"left {dest}: it was not installed by Alfred")
        else:
            shutil.rmtree(dest)
            lines.append(f"removed /{name} from {root}")
    return lines


def status(scope="user", project_dir=None):
    root = target_root(scope, project_dir)
    lines = []
    for name in SKILLS:
        dest = os.path.join(root, name)
        if not os.path.isdir(dest):
            lines.append(f"/{name}: not installed ({root})")
        else:
            v = installed_version(dest)
            lines.append(f"/{name}: {'Alfred ' + v if v else 'present, not from Alfred'} ({dest})")
    return lines
