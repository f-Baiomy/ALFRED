#!/usr/bin/env python3
"""
setup_mcp.py - registers Alfred's MCP server (mcp-server/) with Claude Code, so Claude in any
project (e.g. odeysys) can read Alfred's cycles, calls and database capture. See docs/mcp.md.

Idempotent: installs what is missing, replaces an existing "alfred" registration in the same
scope, then starts the server once over real stdio to prove it answers. Registers `node` + the
server's own pinned tsx with absolute paths - no npm/npx at start-up, so no `cmd /c` wrapper on
Windows and nothing is downloaded when Claude launches it.

Changes only Claude Code's MCP configuration (via the `claude mcp` CLI) - never Alfred itself.

Usage:
    python setup_mcp.py                         register for every project (user scope)
    python setup_mcp.py --scope project --project-dir C:/projects/odeysys
                                                write odeysys/.mcp.json (shared with that repo)
    python setup_mcp.py --scope local --project-dir C:/projects/odeysys
                                                only you, only in odeysys
    python setup_mcp.py --alfred-url http://host:3000   Alfred not on localhost:3000
    python setup_mcp.py --mask                  start every session with secrets masked in replies
    python setup_mcp.py --remove                unregister (same --scope/--project-dir rules)
    python setup_mcp.py --dry-run               print what would run, change nothing
"""

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MCP_DIR = os.path.join(SCRIPT_DIR, "mcp-server")
FRONTEND_DIR = os.path.join(SCRIPT_DIR, "frontend")
SERVER_NAME = "alfred"
MIN_NODE_MAJOR = 22


def posix(path):
    # Forward slashes: valid on Windows too, and the form docs/mcp.md shows.
    return path.replace("\\", "/")


TSX_CLI = posix(os.path.join(MCP_DIR, "node_modules", "tsx", "dist", "cli.mjs"))
ENTRY = posix(os.path.join(MCP_DIR, "src", "index.ts"))


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def tool(name):
    """Full path of a CLI on PATH - on Windows that resolves npm/claude to their .cmd shims, which subprocess can run."""
    found = shutil.which(name)
    if not found:
        fail(f"'{name}' was not found on PATH.")
    return found


def run(cmd, cwd=None, dry_run=False, check=True):
    shown = " ".join(f'"{c}"' if " " in c else c for c in cmd)
    print(f"$ {shown}" + (f"   (in {cwd})" if cwd else ""))
    if dry_run:
        return 0
    result = subprocess.run(cmd, cwd=cwd)
    if check and result.returncode != 0:
        fail(f"command failed with exit code {result.returncode}")
    return result.returncode


def check_node():
    node = tool("node")
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    try:
        major = int(version.lstrip("v").split(".")[0])
    except ValueError:
        fail(f"could not read the Node version ({version!r}).")
    if major < MIN_NODE_MAJOR:
        fail(f"Node {MIN_NODE_MAJOR}+ is required, found {version}.")
    print(f"node {version}")
    return node


def install_dependencies(dry_run):
    npm = tool("npm")
    if not os.path.isfile(TSX_CLI):
        print("mcp-server dependencies missing - installing.")
        run([npm, "ci"], cwd=MCP_DIR, dry_run=dry_run)
    else:
        print("mcp-server dependencies present.")
    # The server imports the frontend's own utils, which resolve @angular/core and rxjs from here.
    if not os.path.isdir(os.path.join(FRONTEND_DIR, "node_modules", "@angular", "core")):
        print("frontend dependencies missing (the server imports frontend utils) - installing.")
        run([npm, "ci"], cwd=FRONTEND_DIR, dry_run=dry_run)
    else:
        print("frontend dependencies present.")


def check_alfred(url):
    # A warning only: registering works with Alfred down, the tools just answer "unreachable" until it runs.
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/session-cycles", timeout=4) as response:
            print(f"Alfred answers at {url} ({response.status}).")
    except Exception as error:  # noqa: BLE001 - any failure means the same thing here
        print(f"WARNING: Alfred did not answer at {url} ({error}). Start it with `python3 start.py`; registration continues.")


def scope_cwd(args):
    if args.scope == "user":
        return None
    if not args.project_dir:
        fail(f"--scope {args.scope} needs --project-dir (the project Claude Code is opened in, e.g. C:/projects/odeysys).")
    project = os.path.abspath(args.project_dir)
    if not os.path.isdir(project):
        fail(f"not a folder: {project}")
    return project


def is_registered(claude, cwd):
    result = subprocess.run([claude, "mcp", "get", SERVER_NAME], cwd=cwd, capture_output=True, text=True)
    return result.returncode == 0


def remove(claude, args, cwd):
    if not args.dry_run and not is_registered(claude, cwd):
        print(f"'{SERVER_NAME}' is not registered in {args.scope} scope - nothing to remove.")
        return
    run([claude, "mcp", "remove", SERVER_NAME, "-s", args.scope], cwd=cwd, dry_run=args.dry_run, check=False)


def register(claude, node, args, cwd):
    # Replace, never stack: an old registration may point at a moved checkout or an npm-based command.
    if not args.dry_run and is_registered(claude, cwd):
        print(f"Replacing the existing '{SERVER_NAME}' registration ({args.scope} scope).")
        run([claude, "mcp", "remove", SERVER_NAME, "-s", args.scope], cwd=cwd, check=False)
    # Name first, then options, then `--`: -e takes several values and would otherwise swallow the name.
    cmd = [claude, "mcp", "add", SERVER_NAME, "-s", args.scope]
    if args.alfred_url != "http://localhost:3000":
        cmd += ["-e", f"ALFRED_URL={args.alfred_url}"]
    if args.mask:
        cmd += ["-e", "ALFRED_MCP_MASK=1"]
    cmd += ["--", posix(node) if args.node_path else "node", TSX_CLI, ENTRY]
    run(cmd, cwd=cwd, dry_run=args.dry_run)


def verify(node, args):
    # Starts the server exactly as registered (node + tsx, from another folder) and calls a tool over stdio.
    env = dict(os.environ, ALFRED_URL=args.alfred_url)
    check = posix(os.path.join(MCP_DIR, "scripts", "stdio-check.ts"))
    print("Verifying: starting the server over stdio and calling list_cycles ...")
    if args.dry_run:
        print(f"$ {node} {TSX_CLI} {check}")
        return
    result = subprocess.run([node, TSX_CLI, check], cwd=MCP_DIR, env=env, capture_output=True, text=True, timeout=120)
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0 or "connected" not in output:
        fail(f"the server did not start cleanly:\n{output}")
    print(output.splitlines()[-1])


def main():
    parser = argparse.ArgumentParser(description="Register Alfred's MCP server with Claude Code.")
    parser.add_argument("--scope", choices=["user", "project", "local"], default="user",
                        help="user = every project (default); project = writes <project-dir>/.mcp.json; local = only you, only in <project-dir>")
    parser.add_argument("--project-dir", help="project folder for --scope project/local")
    parser.add_argument("--alfred-url", default="http://localhost:3000", help="where Alfred's UI/gateway answers (default http://localhost:3000)")
    parser.add_argument("--mask", action="store_true", help="start every session with secrets masked in tool replies")
    parser.add_argument("--node-path", action="store_true", help="register the absolute path of node instead of plain 'node' (if Claude Code's PATH lacks it)")
    parser.add_argument("--remove", action="store_true", help="unregister instead")
    parser.add_argument("--skip-verify", action="store_true", help="do not start the server once to check it")
    parser.add_argument("--dry-run", action="store_true", help="print the commands, change nothing")
    args = parser.parse_args()

    claude = tool("claude")
    cwd = scope_cwd(args)

    if args.remove:
        remove(claude, args, cwd)
        print("Done. Restart Claude Code sessions for it to take effect.")
        return

    node = check_node()
    install_dependencies(args.dry_run)
    check_alfred(args.alfred_url)
    register(claude, node, args, cwd)
    if not args.skip_verify:
        verify(node, args)
    if not args.dry_run:
        run([claude, "mcp", "get", SERVER_NAME], cwd=cwd, check=False)
    if args.dry_run:
        print("\nDry run: nothing was changed.")
        return
    where = "every project" if args.scope == "user" else cwd
    print(f"\nDone: '{SERVER_NAME}' is registered for {where}. Start a new Claude Code session there and ask "
          "\"list my Alfred cycles\". Details: docs/mcp.md")


if __name__ == "__main__":
    main()
