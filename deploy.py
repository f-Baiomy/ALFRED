#!/usr/bin/env python3
"""
deploy.py - pulls the latest master and restarts the stack.

Runs "git checkout master", "git pull origin master", then delegates to
restart.py (rebuild + restart every service, or just the ones named).
Does NOT touch the hosts file or certificate trust - use start.py for
that (only needed once per machine, not on every deploy).

Usage:
    python3 deploy.py                 pull latest, restart every service
    python3 deploy.py backend      pull latest, restart/rebuild just one service
    python3 deploy.py frontend backend  pull latest, restart/rebuild multiple named services
"""

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(result.returncode)


def warn_if_working_tree_is_dirty():
    """Informational only (never blocks) - a dirty working tree on a deploy target usually means
    a stray local edit (e.g. a config tweak made directly on the server) that "git checkout
    master" won't discard, but "git pull" could still conflict with."""
    result = subprocess.run(
        ["git", "status", "--porcelain"], cwd=SCRIPT_DIR, capture_output=True, text=True
    )
    if result.stdout.strip():
        print("WARNING: working tree has uncommitted changes - pull may fail to merge cleanly:")
        print(result.stdout)


def main():
    warn_if_working_tree_is_dirty()
    run(["git", "checkout", "master"])
    run(["git", "pull", "origin", "master"])

    restart_script = os.path.join(SCRIPT_DIR, "restart.py")
    result = subprocess.run([sys.executable, restart_script] + sys.argv[1:], cwd=SCRIPT_DIR)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
