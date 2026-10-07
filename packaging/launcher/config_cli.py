"""
config_cli.py - "alfred config ..." and "alfred project ..." (specs/012-server-program contracts/cli.md).

Every command is carried out by ServerConfigCli, the Java settings engine (research R7), so the rules, the messages
and the history are the ones the UI uses. It is given the running Alfred's local address: when that answers, a change
goes through the backend and applies live; when Alfred is stopped, ServerConfigCli writes .env itself and the change
takes effect at the next start. HTTP calls carry X-Alfred-Cli-User, so the history says which OS user made them.
"""

import getpass
import os
import subprocess
import sys

OK, ERROR, USAGE, REFUSED, CONFLICT, NOT_ALLOWED = 0, 1, 2, 3, 4, 5

CONFIG_COMMANDS = {"list", "get", "set", "reset", "add", "remove", "add-missing", "check", "diff", "history", "revert",
                   "import"}

USAGE_TEXT = """usage: alfred config list [--changed] | get KEY | set KEY VALUE | reset KEY
       alfred config add KEY ITEM | remove KEY ITEM | add-missing | check | diff
       alfred config history | revert ID [--yes] | import FILE [--yes]
       alfred project add NAME LISTEN_PORT APP_PORT [--outbound HOST[:PORT]] | project remove NAME"""


def os_user():
    try:
        return getpass.getuser()
    except Exception:  # noqa: BLE001 - no login name (a service, a container): say so rather than fail
        return "unknown"


def may_edit(layout):
    """.env is readable only by its owner (FR-063): root / Administrator or the service account."""
    if os.name == "nt" or not os.path.exists(layout.env_file):
        return True
    return os.geteuid() == 0 or os.stat(layout.env_file).st_uid == os.geteuid()


def translate(name, args):
    """The ServerConfigCli command for "alfred config ..." / "alfred project ...", or None for a usage error."""
    if not args:
        return None
    if name == "config":
        return list(args) if args[0] in CONFIG_COMMANDS else None
    if args[0] == "add":
        return ["project-add", *args[1:]]
    if args[0] == "remove":
        return ["project-remove", *args[1:]]
    return None


def command_line(layout, name, args, settings=None):
    command = translate(name, args)
    if command is None:
        return None
    try:
        backend = layout.local_url(settings)
    except Exception:  # noqa: BLE001 - an unreadable .env: ServerConfigCli reports it on the files
        backend = None
    options = ["--user", os_user()] + (["--backend", backend] if backend else [])
    return layout.config_cli(*options, *command)


def main(layout, name, args):
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE_TEXT)
        return OK if args else USAGE
    command = command_line(layout, name, args)
    if command is None:
        print(USAGE_TEXT, file=sys.stderr)
        return USAGE
    if not may_edit(layout):
        print("alfred config needs root (sudo alfred config ...) or the account Alfred runs as: .env holds secrets "
              "and is readable only by its owner.", file=sys.stderr)
        return NOT_ALLOWED
    if not os.path.exists(layout.jar):
        print("error: " + layout.jar + " is missing - reinstall Alfred.", file=sys.stderr)
        return ERROR
    return subprocess.run(command).returncode
