"""
attach_cli.py - "alfred jvms", "alfred attach PID ..." and "alfred detach PID ..." (specs/012-server-program
contracts/cli.md, research R12/R16).

The work is done by app/attach-cli.jar on the bundled JDK. This module adds what needs the install: the agent's
arguments from .env (Alfred's address, the project, the forward proxy to use), the webhook secret and Alfred's CA
(passed in the environment, never on a command line), and - on Linux - running the attach step AS THE APP'S OWNER
when that is another user: attaching across users fails and makes the app dump every thread to its console (spike S2).
"""

import json
import os
import shutil
import subprocess
import sys

OK, ERROR, USAGE, REFUSED, CONFLICT, NOT_ALLOWED = 0, 1, 2, 3, 4, 5
FEATURE_FLAGS = ("--proxy", "--db", "--logs", "--redis")

USAGE_TEXT = """usage: alfred jvms
       alfred attach PID [--proxy] [--db] [--logs] [--redis] [--project NAME]   (no flags = --proxy)
       alfred detach PID [--proxy] [--db] [--logs] [--redis]                    (no flags = all)"""


def attach_jar(layout):
    return os.path.join(layout.app, "attach-cli.jar")


def agent_jar(layout):
    return os.path.join(layout.app, "alfred-agent.jar")


def ca_file(layout):
    return os.path.join(layout.certs, "mitmproxy-ca-cert.pem")


def posix():
    return os.name != "nt"


def owner_of(pid):
    """The user name a process runs as (Linux), or None when unknown."""
    if not posix():
        return None
    try:
        import pwd
        return pwd.getpwuid(os.stat(f"/proc/{pid}").st_uid).pw_name
    except (OSError, KeyError, ImportError):
        return None


def current_user():
    if not posix():
        return None
    import pwd
    return pwd.getpwuid(os.geteuid()).pw_name


def as_user(owner, command):
    """The command run as {owner}, keeping the environment (the secret and the CA travel in it)."""
    if owner is None or owner == current_user():
        return command
    if shutil.which("runuser"):
        return ["runuser", "-u", owner, "--", *command]
    import shlex
    return ["su", "-m", "-s", "/bin/sh", owner, "-c", " ".join(shlex.quote(c) for c in command)]


def projects(settings):
    import alfred_settings
    return alfred_settings.parse_service_entries(settings.get("INTERNAL_CALL_SERVICES", ""))


def local_address(listen):
    """The forward proxy's listen address as an app on this machine reaches it."""
    host, _, port = listen.rpartition(":")
    if host in ("", "0.0.0.0", "::", "[::]"):
        host = "127.0.0.1"
    return f"{host}:{port}"


def base_args(layout, settings, project):
    """alfredUrl, project and proxy; ServerConfigCli-level settings only, nothing secret."""
    proxy = local_address(settings.get("ALFRED_OUTBOUND_PROXY_LISTEN") or "127.0.0.2:443")
    if project is not None and project.get("outbound_host"):
        proxy = f"{project['outbound_host']}:{project.get('outbound_port') or '443'}"
    parts = [f"alfredUrl={layout.local_url(settings)}"]
    if project is not None:
        parts.append(f"project={project['name']}")
    parts.append(f"proxy={proxy}")
    return ";".join(parts)


def secrets_env(layout, settings):
    env = dict(os.environ)
    env["ALFRED_AGENT_SECRET"] = settings.get("WEBHOOK_SECRET", "")
    try:
        with open(ca_file(layout), encoding="utf-8") as f:
            env["ALFRED_AGENT_CA"] = f.read()
    except OSError:
        env.pop("ALFRED_AGENT_CA", None)  # not created yet: the proxy writes it on its first start
    return env


def parse_load_args(args):
    """(pid, features, project name or None), or None for a usage error."""
    if not args or not args[0].isdigit():
        return None
    pid, rest = args[0], list(args[1:])
    project = None
    if "--project" in rest:
        i = rest.index("--project")
        if i + 1 >= len(rest):
            return None
        project = rest[i + 1]
        del rest[i:i + 2]
    if any(a not in FEATURE_FLAGS for a in rest):
        return None
    return pid, [a[2:] for a in rest], project


def choose_project(settings, wanted, features):
    """The project the app's db/logs/redis records belong to (FR: needed unless exactly one exists)."""
    known = projects(settings)
    if wanted is not None:
        for p in known:
            if p["name"] == wanted:
                return p
        raise LookupError(f"no project named {wanted}. Projects: {', '.join(p['name'] for p in known) or 'none'}")
    if len(known) == 1:
        return known[0]
    if any(f in ("db", "logs", "redis") for f in features):
        raise LookupError("--db, --logs and --redis need --project NAME"
                          + (f" (one of: {', '.join(p['name'] for p in known)})" if known else
                             " - add a project first: alfred project add NAME LISTEN_PORT APP_PORT"))
    return None


def run_attach_cli(layout, command, owner=None, env=None, capture=False):
    full = as_user(owner, [layout.java, "-jar", attach_jar(layout), *command])
    if capture:
        return subprocess.run(full, env=env, capture_output=True, text=True)
    return subprocess.run(full, env=env)


def jvms(layout):
    result = run_attach_cli(layout, ["jvms", "--json"], capture=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return result.returncode
    rows = json.loads(result.stdout or "[]")
    me = current_user()
    for i, row in enumerate(rows):
        owner = owner_of(row["pid"])
        if not row["readable"] and posix() and owner and owner != me and me == "root":
            detail = run_attach_cli(layout, ["info", row["pid"], "--json"], owner=owner, capture=True)
            if detail.returncode == 0:
                try:
                    rows[i] = json.loads(detail.stdout)[0]
                except (ValueError, IndexError):
                    pass
    if not rows:
        print("No Java applications found.")
        return OK
    print(f"{'PID':<8} {'NAME':<40} {'USER':<12} {'ALFRED':<16} NOTE")
    for row in rows:
        features = row.get("features")
        alfred = ("-" if row.get("readable") else "?") if features is None else (features or "loaded, off")
        name = row.get("name") or ""
        name = name if len(name) <= 40 else "..." + name[-37:]
        print(f"{row['pid']:<8} {name:<40} {(row.get('user') or ''):<12} {alfred:<16} {row.get('note') or ''}")
    return OK


def load(layout, attach, args):
    parsed = parse_load_args(args)
    if parsed is None:
        print(USAGE_TEXT, file=sys.stderr)
        return USAGE
    pid, features, project_name = parsed
    settings = layout.settings()
    try:
        project = choose_project(settings, project_name, features if attach else [])
    except LookupError as e:
        print(f"error: {e}", file=sys.stderr)
        return USAGE
    owner = owner_of(pid)
    me = current_user()
    if posix() and owner and owner != me and me != "root":
        print(f"PID {pid} belongs to {owner}: run 'sudo alfred {'attach' if attach else 'detach'} ...'.", file=sys.stderr)
        return NOT_ALLOWED
    command = ["attach" if attach else "detach", pid, "--agent", agent_jar(layout), "--args",
               base_args(layout, settings, project)]
    if features:
        command += ["--add" if attach else "--remove", ",".join(features)]
    return run_attach_cli(layout, command, owner=owner, env=secrets_env(layout, settings)).returncode


def main(layout, name, args):
    if args and args[0] in ("-h", "--help", "help"):
        print(USAGE_TEXT)
        return OK
    for jar in (attach_jar(layout), agent_jar(layout)):
        if not os.path.exists(jar):
            print(f"error: {jar} is missing - reinstall Alfred.", file=sys.stderr)
            return ERROR
    if name == "jvms":
        return jvms(layout) if not args else USAGE
    return load(layout, name == "attach", args)
