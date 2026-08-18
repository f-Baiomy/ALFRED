#!/usr/bin/env python3
"""
deploy.py - hard-resets the working tree to the latest remote state of the current branch,
then restarts the stack.

Runs "git fetch origin", then "git reset --hard origin/<current branch>" - deliberately a
hard reset rather than a checkout+pull, so a deploy always lands byte-for-byte on what's on
the remote (matching restart.py's own "just tear down and bring back up cleanly"
philosophy) instead of ever needing to merge or being blocked by local drift on the deploy
target. This DISCARDS any local commits/edits on that branch that never made it to the
remote - see warn_if_working_tree_is_dirty(), which still runs first as a heads-up (but
never blocks). Then delegates to restart.py (rebuild + restart every service, or just the
ones named).

IMPORTANT: "python3 deploy.py" with no service names now needs the same elevated
privileges start.py does (Administrator on Windows, sudo on Linux/macOS) - restart.py's
no-args case is now "stop.py, then start.py" (a full teardown/bring-up, including
certificate trust and WildFly's port-offset), not just "docker compose down/up" like
before. An unattended/CI deploy that can't prompt for elevation should pass explicit
service names (e.g. "python3 deploy.py backend frontend") to stay on the original,
no-elevation-needed targeted-rebuild path instead.

Usage:
    python3 deploy.py                 hard-reset to latest, restart everything (stop.py, then start.py)
    python3 deploy.py backend      hard-reset to latest, restart/rebuild just one service (no elevation)
    python3 deploy.py frontend backend  hard-reset to latest, restart/rebuild multiple named services

Any extra args (e.g. --wildfly-proxy off, --wildfly-reverse-proxy off) pass straight through to
restart.py - see its own docstring for what those do.
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
    """Informational only (never blocks) - "git reset --hard" below discards this unconditionally,
    so this is purely a last chance to notice a stray local edit (e.g. a config tweak made
    directly on the server) before it's gone."""
    result = subprocess.run(
        ["git", "status", "--porcelain"], cwd=SCRIPT_DIR, capture_output=True, text=True
    )
    if result.stdout.strip():
        print("WARNING: working tree has uncommitted changes - they will be discarded by the hard reset below:")
        print(result.stdout)


def current_branch():
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=SCRIPT_DIR, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(result.stderr)
        sys.exit(result.returncode)
    return result.stdout.strip()


def main():
    warn_if_working_tree_is_dirty()
    branch = current_branch()
    run(["git", "fetch", "origin"])
    run(["git", "reset", "--hard", f"origin/{branch}"])

    restart_script = os.path.join(SCRIPT_DIR, "restart.py")
    result = subprocess.run([sys.executable, restart_script] + sys.argv[1:], cwd=SCRIPT_DIR)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
