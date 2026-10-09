"""
attach_cli.py - "alfred jvms", "alfred attach PID ..." and "alfred detach PID ..." (specs/012-server-program
contracts/cli.md, research R12/R16).

The work is done by app/attach-cli.jar on the bundled JDK. This module adds what needs the install: the agent's
arguments from .env (Alfred's address, the project, the forward proxy to use), the webhook secret and Alfred's CA
(passed in the environment, never on a command line), and running the attach step AS THE APP'S OWNER when that is
another user: attaching across users fails and makes the app dump every thread to its console (spike S2). Linux:
runuser/su as root. Windows: the service (LocalSystem) borrows the app process's own token (win_runas.py).
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


def agent_digest(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def attached_agent_jar(layout):
    """The agent jar a JVM is given: a copy named by its content in <install>/agents, never the installed file.

    A JVM keeps loading the agent's classes from the jar it was given for as long as it runs. Pointed at
    app/alfred-agent.jar, an Alfred update replaced that file under it: the classes not loaded yet failed with
    NoClassDefFoundError and the JVM remembers a failed link for good - the agent stayed mute until the app restarted
    (2026-10-08, 3.0.1 installed under a running WildFly). Installers replace app/ and runtime/, never agents/, so
    every JVM keeps the copy it got. agents/ sits next to app/ (readable by every user, like app/), not in data/
    (Administrators and the service only), because the app's own user opens the file. Copies stay: a JVM may run for
    months on an older one. Falls back to the installed file when the copy cannot be made."""
    source = agent_jar(layout)
    try:
        name = f"alfred-agent-{agent_digest(source)}.jar"
        folder = os.path.join(layout.home, "agents")
        target = os.path.join(folder, name)
        if not os.path.isfile(target):
            os.makedirs(folder, exist_ok=True)
            part = target + f".{os.getpid()}.part"
            shutil.copyfile(source, part)
            if posix():
                os.chmod(part, 0o644)
                os.chmod(folder, 0o755)
            os.replace(part, target)
        return target
    except OSError:
        return source


def ca_file(layout):
    return os.path.join(layout.certs, "mitmproxy-ca-cert.pem")


def posix():
    return os.name != "nt"


def owner_of(pid):
    """The user name a process runs as (DOMAIN\\name on Windows), or None when unknown."""
    if not posix():
        import win_runas
        return win_runas.process_user(pid)
    try:
        import pwd
        return pwd.getpwuid(os.stat(f"/proc/{pid}").st_uid).pw_name
    except (OSError, KeyError, ImportError):
        return None


def current_user():
    if not posix():
        import win_runas
        return win_runas.current_user()
    import pwd
    return pwd.getpwuid(os.geteuid()).pw_name


def privileged():
    """May run a command as another user: root, or on Windows LocalSystem / an elevated administrator."""
    if not posix():
        import win_runas
        return win_runas.is_privileged()
    return current_user() == "root"


def other_owner(pid):
    """The owner of {pid} when that is not us, else None."""
    owner = owner_of(pid)
    return owner if owner and owner != current_user() else None


def as_user(owner, command):
    """The command run as {owner} (Linux), keeping the environment (the secret and the CA travel in it)."""
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


def attach_url(layout, settings):
    """The Alfred the agent reports to: this install, unless the caller names another one. The Docker install's
    start.py/restart.py borrow this CLI for their proxy-on step (it needs no JDK 8) and set ALFRED_ATTACH_URL and
    ALFRED_ATTACH_SECRET to the Docker Alfred - otherwise the agent reported to this install's port while it was
    stopped, until an inbound call through the Docker reverse proxy redirected it."""
    return os.environ.get("ALFRED_ATTACH_URL") or layout.local_url(settings)


def base_args(layout, settings, project):
    """alfredUrl, project and proxy; ServerConfigCli-level settings only, nothing secret."""
    proxy = local_address(settings.get("ALFRED_OUTBOUND_PROXY_LISTEN") or "127.0.0.2:443")
    if project is not None and project.get("outbound_host"):
        proxy = f"{project['outbound_host']}:{project.get('outbound_port') or '443'}"
    parts = [f"alfredUrl={attach_url(layout, settings)}"]
    if project is not None:
        parts.append(f"project={project['name']}")
    parts.append(f"proxy={proxy}")
    return ";".join(parts)


def secrets_env(layout, settings):
    env = dict(os.environ)
    env["ALFRED_AGENT_SECRET"] = os.environ.get("ALFRED_ATTACH_SECRET") or settings.get("WEBHOOK_SECRET", "")
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


def listening_pid(port, run=None):
    """The pid listening on TCP {port} on this machine, or None. A project's app IS the JVM bound to its upstream
    port (internal_call_services "name:listenPort:upstreamPort"), which is how the supervisor finds what to attach
    to without being told. Windows: netstat; Linux: ss, then /proc when ss is missing."""
    run = run or (lambda argv: subprocess.run(argv, capture_output=True, text=True, timeout=15).stdout)
    port = int(port)
    try:
        if not posix():
            for line in run(["netstat", "-ano", "-p", "tcp"]).splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING" \
                        and parts[1].rpartition(":")[2] == str(port):
                    return int(parts[4])
            return None
        if shutil.which("ss"):
            for line in run(["ss", "-ltnpH"]).splitlines():
                parts = line.split()
                if len(parts) >= 4 and parts[3].rpartition(":")[2] == str(port) and "pid=" in line:
                    return int(line.split("pid=", 1)[1].split(",", 1)[0])
            return None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return _proc_listening_pid(port)


def _proc_listening_pid(port):
    """/proc/net/tcp{,6}: the socket inode listening on {port}, then the process holding that inode."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="utf-8") as f:
                next(f)
                for line in f:
                    cols = line.split()
                    if len(cols) > 9 and cols[3] == "0A" and int(cols[1].rpartition(":")[2], 16) == port:
                        inodes.add(cols[9])
        except OSError:
            continue
    if not inodes:
        return None
    for pid in (p for p in os.listdir("/proc") if p.isdigit()):
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                link = os.readlink(f"/proc/{pid}/fd/{fd}")
                if link.startswith("socket:[") and link[8:-1] in inodes:
                    return int(pid)
        except OSError:
            continue
    return None


def jvm_pids(layout, owner=None, pid=None):
    """The pids attach-cli can see as Java processes - its own user's, or {owner}'s (whose process {pid} is)."""
    result = run_attach_cli(layout, ["jvms", "--json"], owner=owner, capture=True, pid=pid)
    if result.returncode != 0:
        return None
    try:
        return {int(row["pid"]): row for row in json.loads(result.stdout or "[]")}
    except (ValueError, KeyError, TypeError):
        return None


def jvm_row(layout, pid):
    """What attach-cli says about {pid} ("alfred jvms --json"): features, reportsTo, standby... - None when unknown."""
    mine = jvm_pids(layout)
    if mine is not None and pid in mine:
        return mine[pid]
    owner = other_owner(pid)
    if owner and privileged():
        theirs = jvm_pids(layout, owner=owner, pid=pid)
        return (theirs or {}).get(pid)
    return None


def same_alfred(a, b):
    """True when two Alfred URLs name the same one: same port, and the same host once localhost spellings are one."""
    from urllib.parse import urlparse

    def key(url):
        parsed = urlparse(url or "")
        host = (parsed.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
            host = "loopback"
        return host, parsed.port or (443 if parsed.scheme == "https" else 80)
    return key(a) == key(b)


def visible_jvm(layout, pid):
    """True when {pid} is a JVM attach-cli can attach to - as us, or, privileged, as its owner; False when it is not
    one; None when the list could not be read. A JVM lists only its own user's JVMs, so a service running as
    LocalSystem never sees a developer's app in its own list."""
    mine = jvm_pids(layout)
    if mine is not None and pid in mine:
        return True
    owner = other_owner(pid)
    if owner and privileged():
        theirs = jvm_pids(layout, owner=owner, pid=pid)
        return None if theirs is None else pid in theirs
    return None if mine is None else False


def attach_pid(layout, settings, pid, project, features):
    """Loads the agent into {pid} for {project} with exactly {features} (proxy/db/logs/redis), as "alfred attach"
    does: the install's URL, project and proxy as arguments, the secret and CA in the environment, as the app's
    owner on Linux. Returns (ok, detail) - detail is the CLI's last line when it failed."""
    owner = other_owner(pid)
    command = ["attach", str(pid), "--agent", attached_agent_jar(layout), "--args", base_args(layout, settings, project)]
    if features:
        command += ["--add", ",".join(features)]
    result = run_attach_cli(layout, command, owner=owner, env=secrets_env(layout, settings), capture=True, pid=pid)
    if result.returncode == 0:
        return True, ((result.stdout or "").strip().splitlines() or [""])[-1]
    text = ((result.stderr or "") + "\n" + (result.stdout or "")).strip().splitlines()
    return False, (text[-1] if text else f"attach-cli exited with {result.returncode}")


def run_attach_cli(layout, command, owner=None, env=None, capture=False, pid=None):
    argv = [layout.java, "-jar", attach_jar(layout), *command]
    if not posix():
        if owner and owner != current_user() and pid is not None:
            return _run_as_windows_owner(layout, pid, argv, env, capture)
        full = argv
    else:
        full = as_user(owner, argv)
    if capture:
        return subprocess.run(full, env=env, capture_output=True, text=True)
    return subprocess.run(full, env=env)


def _run_as_windows_owner(layout, pid, argv, env, capture):
    """Windows: as the user {pid} runs as, in that user's own environment plus ours for the agent (ALFRED_AGENT_*)."""
    import win_runas
    extra = {k: v for k, v in (env or {}).items() if k.startswith("ALFRED_AGENT_")}
    try:
        result = win_runas.run_as_owner(pid, argv, extra, cwd=layout.app)
    except OSError as e:
        result = subprocess.CompletedProcess(argv, ERROR, "", f"cannot run attach-cli as the app's owner: {e}\n")
    if result is None:
        result = subprocess.CompletedProcess(argv, NOT_ALLOWED, "", f"cannot act as the owner of pid {pid}: "
                                                                    "run Alfred as a service or from an administrator prompt\n")
    if not capture:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
    return result


def jvms(layout):
    result = run_attach_cli(layout, ["jvms", "--json"], capture=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return result.returncode
    rows = json.loads(result.stdout or "[]")
    me = current_user()
    for i, row in enumerate(rows):
        owner = owner_of(row["pid"])
        if not row["readable"] and owner and owner != me and privileged():
            detail = run_attach_cli(layout, ["info", row["pid"], "--json"], owner=owner, capture=True, pid=row["pid"])
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
    owner = other_owner(pid)
    if owner and not privileged():
        how = f"'sudo alfred {'attach' if attach else 'detach'} ...'" if posix() else "it from an administrator prompt"
        print(f"PID {pid} belongs to {owner}: run {how}.", file=sys.stderr)
        return NOT_ALLOWED
    command = ["attach" if attach else "detach", pid, "--agent", attached_agent_jar(layout), "--args",
               base_args(layout, settings, project)]
    if features:
        command += ["--add" if attach else "--remove", ",".join(features)]
    return run_attach_cli(layout, command, owner=owner, env=secrets_env(layout, settings), pid=pid).returncode


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
