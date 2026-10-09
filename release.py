#!/usr/bin/env python3
"""
release.py - cut an Alfred release: an annotated tag v<version> on master, pushed. GitHub Actions
(.github/workflows/release.yml) then builds both installers and publishes them with SHA256SUMS and latest.json;
installed Alfreds see the new version at their next update check (docs/server.md "Updates").

    python release.py                      asks: next version (suggested), release notes, confirmation
    python release.py --version 1.3.0 --notes "..." --yes
    python release.py --here               build the installers on this machine and publish with `gh release create`
                                           instead of waiting for GitHub Actions (needs Docker and `gh auth login`)

Releases are cut from master only: refuses from another branch, with uncommitted changes, when master is not in
sync with origin/master (the release is built from GitHub), when the tag exists, or when the version is not X.Y.Z
above the latest release. The workflow checks the same: a tag that is not on master is not built.
"""

import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO_URL = "https://github.com/f-Baiomy/ALFRED"
VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def git(*args, check=True):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


# ---------------------------------------------------------------------------------------------------------------------
# pure parts (tested)
# ---------------------------------------------------------------------------------------------------------------------

def parse_version(text):
    """"1.2.3" / "v1.2.3" -> (1, 2, 3); None for anything else."""
    m = VERSION.match((text or "").strip())
    return tuple(int(m.group(i)) for i in (1, 2, 3)) if m else None


def latest_release(tags):
    """The highest vX.Y.Z among the tags, as (version tuple, tag) - or None when there was no release yet."""
    releases = [(parse_version(t), t) for t in tags if parse_version(t)]
    return max(releases) if releases else None


def suggest(latest):
    """The next patch version: 1.2.3 -> 1.2.4; the first release is 1.0.0."""
    if latest is None:
        return "1.0.0"
    major, minor, patch = latest
    return f"{major}.{minor}.{patch + 1}"


def bump(latest, part):
    major, minor, patch = latest or (0, 0, 0)
    return {"major": f"{major + 1}.0.0", "minor": f"{major}.{minor + 1}.0", "patch": f"{major}.{minor}.{patch + 1}"}[part]


def validate_version(text, latest, existing_tags):
    """Why `text` cannot be the next release, or None when it can."""
    version = parse_version(text)
    if version is None:
        return f"'{text}' is not a version: use X.Y.Z, e.g. {suggest(latest)}"
    if latest is not None and version <= latest:
        return f"{text} is not above the latest release {'.'.join(map(str, latest))}"
    if f"v{'.'.join(map(str, version))}" in existing_tags:
        return f"tag v{text.lstrip('v')} already exists"
    return None


def preflight(branch, dirty, ahead, behind):
    """The reasons not to release right now, in the order to fix them. Releases are cut from master, pushed and in
    sync with origin/master: the workflow builds the tagged commit on GitHub and refuses a tag that is not on master."""
    problems = []
    if branch != "master":
        problems.append(f"you are on '{branch}' - releases are cut from master: merge there and `git checkout master` first")
    if dirty:
        problems.append("the working tree has uncommitted changes - commit or stash them")
    if behind:
        problems.append(f"master is {behind} commit(s) behind origin/master - git pull first")
    if ahead:
        problems.append(f"master is {ahead} commit(s) ahead of origin/master - git push first (the release is built from GitHub)")
    return problems


def commit_list(log_lines):
    """The one-line commits since the last release, as the default release notes."""
    return "\n".join(f"- {line}" for line in log_lines if line.strip())


# ---------------------------------------------------------------------------------------------------------------------
# the interaction
# ---------------------------------------------------------------------------------------------------------------------

def ask(prompt, default=None):
    answer = input(prompt).strip()
    return answer or default


def ask_notes(default):
    print("Release notes - the text installed Alfreds show next to the update. End with an empty line;")
    print("Enter alone keeps the commit list above.")
    lines = []
    while True:
        line = input("> ")
        if not line:
            break
        lines.append(line)
    return "\n".join(lines) if lines else default


def main(argv):
    parser = argparse.ArgumentParser(description="Cut an Alfred release (tag + push; GitHub Actions builds and publishes).")
    parser.add_argument("--version", help="the version, e.g. 1.3.0 (asked for when omitted)")
    parser.add_argument("--notes", help="release notes (asked for when omitted)")
    parser.add_argument("--yes", action="store_true", help="no confirmation")
    parser.add_argument("--here", action="store_true", help="build and publish from this machine instead of GitHub Actions")
    args = parser.parse_args(argv)

    git("fetch", "--tags", "--quiet", "origin")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    dirty = bool(git("status", "--porcelain"))
    behind = ahead = 0
    if branch == "master":  # the sync check is about master itself; from another branch the first problem says it all
        counts = git("rev-list", "--left-right", "--count", "origin/master...HEAD", check=False) or "0\t0"
        behind, ahead = (int(x) for x in counts.split())
    problems = preflight(branch, dirty, ahead, behind)
    if problems:
        print("Not releasing:")
        for p in problems:
            print("  - " + p)
        return 1

    tags = git("tag", "--list").splitlines()
    latest = latest_release(tags)
    head = git("rev-parse", "--short", "HEAD")
    if latest:
        latest_tuple, latest_tag = latest
        when = git("log", "-1", "--format=%ad", "--date=short", latest_tag)
        since = git("log", "--oneline", "--no-decorate", f"{latest_tag}..HEAD").splitlines()
        print(f"Latest release: {latest_tag} ({when}, {len(since)} commit(s) since)")
    else:
        latest_tuple = None
        since = git("log", "--oneline", "--no-decorate", "-n", "30").splitlines()
        print("No release yet - this will be the first.")
    if since:
        print("Changes:")
        for line in since[:40]:
            print("  - " + line)
        if len(since) > 40:
            print(f"  ... and {len(since) - 40} more")
    default_notes = commit_list(since)

    version = args.version
    if version is None:
        suggested = suggest(latest_tuple)
        hint = f"  (patch; minor would be {bump(latest_tuple, 'minor')}, major {bump(latest_tuple, 'major')})" if latest_tuple else ""
        while True:
            version = ask(f"Next version [{suggested}]{hint}: ", suggested)
            problem = validate_version(version, latest_tuple, tags)
            if problem is None:
                break
            print("  " + problem)
    else:
        problem = validate_version(version, latest_tuple, tags)
        if problem:
            print(problem)
            return 2
    version = version.lstrip("v")
    tag = f"v{version}"

    notes = args.notes if args.notes is not None else ask_notes(default_notes)
    if not notes.strip():
        notes = f"Alfred {version}"

    print()
    print(f"About to tag {tag} on {branch} @ {head} and push it.")
    if args.here:
        print("Then build both installers here (python build_dist.py, ~25 min) and publish them with gh release create.")
    else:
        print(f"GitHub Actions then builds both installers and publishes the release (~25 min): {REPO_URL}/actions")
    if not args.yes and ask("Continue? [y/N] ", "n").lower() not in ("y", "yes"):
        print("Nothing done.")
        return 1

    git("tag", "-a", tag, "-m", notes)
    print(f"  tagged {tag}")
    git("push", "origin", tag)
    print(f"  pushed {tag}")
    if not args.here:
        print(f"Follow the build: {REPO_URL}/actions  -  the release appears at {REPO_URL}/releases/tag/{tag}")
        return 0

    print("Building the installers here...")
    # latest.json lists the releases before this one too, read from the current latest.json (still the previous one).
    env = dict(os.environ, ALFRED_PREVIOUS_MANIFEST=os.environ.get("ALFRED_PREVIOUS_MANIFEST") or f"{REPO_URL}/releases/latest/download/latest.json")
    build = subprocess.run([sys.executable, os.path.join(ROOT, "build_dist.py")], cwd=ROOT, env=env)
    if build.returncode != 0:
        print(f"The build failed - the tag {tag} is pushed; fix the build and run: gh release create {tag} dist/* --notes-from-tag")
        return 1
    dist = os.path.join(ROOT, "dist")
    files = [os.path.join(dist, n) for n in os.listdir(dist) if n.startswith(f"alfred-setup-{version}-") or n in ("SHA256SUMS", "latest.json")]
    publish = subprocess.run(["gh", "release", "create", tag, *files, "--title", f"Alfred {version}", "--notes-from-tag", "--verify-tag"], cwd=ROOT)
    if publish.returncode != 0:
        print(f"Publishing failed - the installers are in dist/. Retry: gh release create {tag} dist/* --notes-from-tag")
        return 1
    print(f"Released: {REPO_URL}/releases/tag/{tag}")
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(errors="replace")
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nNothing done.")
        sys.exit(1)
