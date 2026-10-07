"""Database capture's start.py/restart.py step: `--db-capture on|off [project]` (docs/db-capture.md).

`on` loads the database capture agent into the running WildFly and switches capture on for the project
(wildfly-proxy-toggle/db-capture-on.sh|.bat); `off` switches it off (an agent cannot be unloaded from a running
JVM - it stays loaded and records nothing). Opt-in: unlike --wildfly-proxy, nothing happens without the flag.
With no project named, the one configured inbound project is used (INTERNAL_CALL_SERVICES in .env); with several,
the project must be named.
"""

import os
import platform
import subprocess

import alfred_settings

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FLAG = "--db-capture"


def take_flag(argv):
    """Removes `--db-capture [on|off] [project]` from argv. Returns (rest, action or None, project or None).
    A project is only taken when it follows an explicit on|off, so a service name for restart.py is never eaten."""
    rest = []
    action = None
    project = None
    i = 0
    while i < len(argv):
        if argv[i] != FLAG:
            rest.append(argv[i])
            i += 1
            continue
        action = "on"
        i += 1
        if i < len(argv) and argv[i] in ("on", "off"):
            action = argv[i]
            i += 1
            if i < len(argv) and not argv[i].startswith("--"):
                project = argv[i]
                i += 1
    return rest, action, project


def _env_projects():
    env = alfred_settings.read_env_file(os.path.join(SCRIPT_DIR, ".env"))
    return [entry["name"] for entry in alfred_settings.parse_service_entries(env.get("INTERNAL_CALL_SERVICES", ""))]


def toggle(action, project):
    """Non-fatal, like the WildFly proxy step: Alfred's own stack is up either way."""
    if action is None:
        return
    if not project:
        projects = _env_projects()
        if len(projects) != 1:
            print("--db-capture needs a project name (configured: " + (", ".join(projects) or "none") + "),")
            print("e.g. python3 start.py --db-capture on wallet-app")
            return
        project = projects[0]
    toggle_dir = os.path.join(SCRIPT_DIR, "wildfly-proxy-toggle")
    if platform.system() == "Windows":
        cmd = [os.path.join(toggle_dir, f"db-capture-{action}.bat"), project]
    else:
        cmd = ["bash", os.path.join(toggle_dir, f"db-capture-{action}.sh"), project]
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=toggle_dir)
    if result.returncode != 0:
        print("Database capture step failed (see above) - continuing anyway.")
