"""
alfred_skill.py - installs Alfred's Claude Code skills (skills/alfred-*: the QA loop on the task board, see
docs/mcp.md "The /alfred-* skills") where Claude Code finds them. Each skill gets a copy of skills/_shared/rules.md
(the rules all of them follow) as rules.md in its own folder, so the rules cannot drift between skills.

    user scope     ~/.claude/skills/alfred-*/          every project on this machine
    project scope  <project>/.claude/skills/alfred-*/  one repo (commit it to share it with the team)

Shared by the native `alfred skill ...` command (packaging/launcher/alfred.py, files in app/skills), by
setup_mcp.py (a source checkout, files in skills/) and by its own command line (`python alfred_skill.py install`, what
/alfred-update-skills runs in a checkout). An installed copy carries a `.alfred-skill` marker with the version it came
from, so an update replaces it and a folder of the same name that someone else wrote is never overwritten (unless
forced).

The supervisor runs as the service account (LocalSystem / root), whose home is not the developer's, so on start it
calls refresh_installed: every user's home that already holds Alfred-installed skills from an OLDER release gets this
release's. A user who never installed them gets nothing, and a copy from a source checkout ("source") is left alone.
"""

import os
import re
import shutil
import sys

SKILLS = ("alfred-guide", "alfred-connect", "alfred-setup", "alfred-spec", "alfred-listen", "alfred-review", "alfred-triage", "alfred-sync",
          "alfred-live", "alfred-fix", "alfred-verify", "alfred-status", "alfred-report", "alfred-ask", "alfred-update-skills")
SHARED = "_shared"
RULES = "rules.md"
# Skills older versions installed: removed by install when Alfred installed them (never someone else's folder).
RETIRED = ("alfred-qa",)
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
    """Copies every skill from `source_root` (a folder holding alfred-*/ and _shared/) into the scope. One line per skill."""
    return install_into(source_root, target_root(scope, project_dir), version, force)


def install_into(source_root, root, version="dev", force=False):
    """install() for an explicit skills folder (another user's ~/.claude/skills when the supervisor refreshes)."""
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
        rules = os.path.join(source_root, SHARED, RULES)
        if os.path.isfile(rules):
            shutil.copy2(rules, os.path.join(dest, RULES))
        with open(os.path.join(dest, MARKER), "w", encoding="utf-8", newline="\n") as f:
            f.write(version + "\n")
        lines.append(f"{'updated' if was else 'installed'} /{name} in {dest}" + (f" ({was} -> {version})" if was and was != version else ""))
    for name in RETIRED:
        old = os.path.join(root, name)
        if os.path.isdir(old) and installed_version(old) is not None:
            shutil.rmtree(old)
            lines.append(f"removed the retired /{name} (replaced by the skills above)")
    return lines


def release(version):
    """(major, minor, patch) of a release version ("1.4.0", "v1.4.0-rc1"); None for "source", "dev", "unknown"."""
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version or "")
    return tuple(int(p) for p in m.groups()) if m else None


def user_homes():
    """Every user's home on this machine that may hold skills. Windows: the registry's profile list (service and
    system profiles skipped); elsewhere: the password database (uid 0 and >= 1000). Falls back to this user's home."""
    homes = []
    try:
        if os.name == "nt":
            import winreg
            key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as profiles:
                i = 0
                while True:
                    try:
                        sid = winreg.EnumKey(profiles, i)
                    except OSError:
                        break
                    i += 1
                    if not sid.startswith("S-1-5-21-"):  # S-1-5-18/19/20: LocalSystem, LocalService, NetworkService
                        continue
                    with winreg.OpenKey(profiles, sid) as profile:
                        path = os.path.expandvars(winreg.QueryValueEx(profile, "ProfileImagePath")[0])
                    homes.append(path)
        else:
            import pwd
            homes = [p.pw_dir for p in pwd.getpwall() if (p.pw_uid == 0 or p.pw_uid >= 1000) and p.pw_dir not in ("", "/")]
    except (OSError, ImportError):
        pass
    own = os.path.expanduser("~")
    if own not in homes:
        homes.append(own)
    return [h for h in dict.fromkeys(homes) if os.path.isdir(h)]


def _give_back(root, home):
    """Running as root: the copied folders belong to the home's owner, so that user can update or remove them."""
    if os.name == "nt" or not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    st = os.stat(home)
    for name in SKILLS:
        top = os.path.join(root, name)
        if not os.path.isdir(top):
            continue
        for folder, dirs, files in os.walk(top):
            for path in [folder] + [os.path.join(folder, f) for f in files]:
                os.lchown(path, st.st_uid, st.st_gid)


def refresh_installed(source_root, version, homes=None):
    """Brings every user's Alfred-installed skills up to `version`, where they came from an older release. Only homes
    whose ~/.claude/skills already holds an Alfred-installed /alfred-* skill; a home that fails is one line, never the
    end of the others. Returns the log lines."""
    current = release(version)
    if current is None:
        return []
    lines = []
    for home in (homes if homes is not None else user_homes()):
        root = os.path.join(home, ".claude", "skills")
        try:
            if not os.path.isdir(root):
                continue
            found = [installed_version(os.path.join(root, n)) for n in SKILLS + RETIRED]
            found = [release(v) for v in found if v is not None]
            if not found or all(v is None or v >= current for v in found):
                continue  # never installed, already current, or a source checkout's copy
            done = install_into(source_root, root, version)
            _give_back(root, home)
            updated = len([l for l in done if l.startswith(("updated", "installed"))])
            lines.append(f"skills: updated {updated} /alfred-* skills in {root} to {version}")
            lines.extend(f"skills: {l}" for l in done if l.startswith(("skipped", "removed")))
        except (OSError, ValueError) as e:
            lines.append(f"skills: could not update {root}: {e}")
    return lines


def assemble(source_root, out_dir):
    """The skills as they are installed (each with its rules.md), into out_dir - what the release zip holds."""
    for name in SKILLS:
        dest = os.path.join(out_dir, name)
        shutil.copytree(os.path.join(source_root, name), dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", MARKER))
        rules = os.path.join(source_root, SHARED, RULES)
        if os.path.isfile(rules):
            shutil.copy2(rules, os.path.join(dest, RULES))


def remove(scope="user", project_dir=None):
    root = target_root(scope, project_dir)
    lines = []
    for name in SKILLS + RETIRED:
        dest = os.path.join(root, name)
        if not os.path.isdir(dest):
            if name not in RETIRED:
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


USAGE = "python alfred_skill.py install|status|remove [--project <folder>] [--force]"


def main(argv):
    """A source checkout's own `alfred skill` (no native CLI there): the skills in skills/ beside this file."""
    if not argv or argv[0] not in ("install", "status", "remove"):
        print(USAGE, file=sys.stderr)
        return 2
    action, rest, project, force = argv[0], argv[1:], None, False
    while rest:
        if rest[0] == "--project" and len(rest) > 1:
            project, rest = rest[1], rest[2:]
        elif rest[0] == "--force":
            force, rest = True, rest[1:]
        else:
            print(f"unknown option {rest[0]}\n{USAGE}", file=sys.stderr)
            return 2
    if project is not None and not os.path.isdir(project):
        print(f"no folder {project}", file=sys.stderr)
        return 2
    scope = "project" if project else "user"
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
    if action == "install":
        lines = install(source, scope, project, "source", force)
    elif action == "remove":
        lines = remove(scope, project)
    else:
        lines = status(scope, project)
    for line in lines:
        print(line)
    return 3 if any(line.startswith("skipped") for line in lines) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
