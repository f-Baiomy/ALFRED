#!/usr/bin/env python3
"""
build_dist.py - builds the native installers of the current code (specs/012-server-program research R4,
contracts/installer-and-build.md):

    dist/alfred-setup-<version>-linux-x64.run
    dist/alfred-setup-<version>-windows-x64.exe
    dist/SHA256SUMS
    dist/alfred-qa-skill-<version>.zip   the Claude Code skill on its own (also inside both installers)

Usage:
    python build_dist.py [--target linux|windows|all] [--skip-tests] [--clean] [--reuse] [--dns 8.8.8.8] [--verbose]

Prerequisites on this machine: Python 3.10+ and Docker. Every build step runs in a container, so the result does not
depend on the JDK, Node or Python on the PATH (a bare `mvn` here silently runs JDK 8 - see CLAUDE.md). Runtimes and
tools are downloaded once into build-cache/downloads, each checked against the sha256 pinned in build-versions.json.
--dns passes a resolver to the containers, for networks whose own DNS does not answer inside Docker
(ALFRED_BUILD_DNS does the same).

The Linux installer is assembled entirely inside a Linux container: its runtimes contain symlinks and executable
bits a Windows checkout cannot hold. The Windows installer is staged on the host and packed by NSIS in a container.
"""

import argparse
import collections
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile

# The tools' output is relayed as it comes, and ng build prints characters (❯, ✔) a Windows console in cp1252
# cannot encode - which made the relay itself raise UnicodeEncodeError and kill the build mid-step. Unencodable
# characters are replaced instead of fatal; the tools' own exit codes still decide success.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "build-cache")
DOWNLOADS = os.path.join(CACHE, "downloads")
BUILD = os.path.join(ROOT, "build")
DIST = os.path.join(ROOT, "dist")
VERSIONS = json.load(open(os.path.join(ROOT, "build-versions.json"), encoding="utf-8"))
TARGETS = ("linux-x64", "windows-x64")

NODE_IMAGE = "node:20-alpine"
PYTHON_IMAGE = "python:3.13-slim"
MAVEN_IMAGE = VERSIONS["buildImage"]["base"]
NSIS_IMAGE = "alfred-build-nsis:1"

# Modules the backend and the attach CLI need (jdeps on the Spring Boot jar plus what reflection and the agent use).
JLINK_MODULES = [
    "java.base", "java.compiler", "java.desktop", "java.instrument", "java.logging", "java.management",
    "java.management.rmi", "java.naming", "java.net.http", "java.prefs", "java.rmi", "java.scripting",
    "java.security.jgss", "java.security.sasl", "java.sql", "java.sql.rowset", "java.transaction.xa", "java.xml",
    "java.xml.crypto", "jdk.attach", "jdk.crypto.ec", "jdk.crypto.cryptoki", "jdk.httpserver", "jdk.jfr",
    "jdk.localedata", "jdk.management", "jdk.management.agent", "jdk.naming.dns", "jdk.net", "jdk.unsupported",
    "jdk.zipfs",
]
# Unused parts of the bundled CPython: tests, GUI toolkits, the bundled pip installer.
PYTHON_PRUNE = {"test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "__pycache__"}
EXECUTABLE_PREFIXES = ("runtime/python/bin/", "runtime/java/bin/", "runtime/node/bin/", "runtime/java/lib/jspawnhelper",
                       "runtime/java/lib/jexec")


# --verbose: every line every tool prints (Maven per-module output, npm http log). Otherwise Maven is filtered down
# to its progress lines - the full output is still kept and printed if the step fails.
VERBOSE = False
# Printed while a command has said nothing for this long, so a slow step never looks like a hang.
HEARTBEAT_SECONDS = 15
# Maven lines worth showing without --verbose: which module it is on, test counts, the result, and any problem.
MAVEN_PROGRESS = re.compile(r"Building |Reactor Summary|BUILD |Tests run:|ERROR|FAIL|WARN.*(deprecat|fail)|^>> ")

IN_CONTAINER = False
_build_start = time.monotonic()
_step_start = None


def elapsed(seconds):
    seconds = int(seconds)
    return f"{seconds // 60}m{seconds % 60:02d}s" if seconds >= 60 else f"{seconds}s"


def step(number, name, detail=""):
    global _step_start
    now = time.monotonic()
    if _step_start is not None:
        print(f"        done in {elapsed(now - _step_start)}", flush=True)
    _step_start = now
    print(f"[{number}/6] {name:<11} {detail}   (total {elapsed(now - _build_start)})", flush=True)


def run(command, cwd=ROOT, env=None, show=None):
    """Runs a command, streaming its output as it comes, each line stamped with the time since the step began.

    `show` (a regex) hides lines that do not match - unless --verbose. Hidden lines are not lost: the last ones are
    printed if the command fails. While the command is silent, a heartbeat line says it is still working and what
    it last printed."""
    if IN_CONTAINER:
        # Inside the Linux installer container: the host's run() already stamps and heartbeats every line it relays.
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            raise SystemExit(f"\nFAILED ({result.returncode}): {' '.join(command)}")
        return
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               bufsize=1, text=True, encoding="utf-8", errors="replace")
    state = {"last_output": time.monotonic(), "last_line": "", "done": False}
    tail = collections.deque(maxlen=200)
    lock = threading.Lock()

    def stamp():
        return f"  [+{elapsed(time.monotonic() - started):>6}]"

    def heartbeat():
        while not state["done"]:
            time.sleep(1)
            with lock:
                if state["done"] or time.monotonic() - state["last_output"] < HEARTBEAT_SECONDS:
                    continue
                last = state["last_line"][:110]
                print(f"{stamp()} ... still working" + (f" - last: {last}" if last else ""), flush=True)
                state["last_output"] = time.monotonic()

    beat = threading.Thread(target=heartbeat, daemon=True)
    beat.start()
    try:
        for raw in process.stdout:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            tail.append(line)
            with lock:
                state["last_line"] = line.strip()
                if VERBOSE or show is None or show.search(line):
                    print(f"{stamp()} {line}", flush=True)
                    state["last_output"] = time.monotonic()
        process.wait()
    finally:
        state["done"] = True
    if process.returncode != 0:
        if show is not None and not VERBOSE:
            print("\n--- last output of the failed command ---", flush=True)
            for line in tail:
                print(f"  {line}")
        raise SystemExit(f"\nFAILED ({process.returncode}) after {elapsed(time.monotonic() - started)}: {' '.join(command)}")


def remove_tree(path):
    """shutil.rmtree that works on Windows and says so when it cannot.

    jlink writes the runtime's legal/ files read-only, and on Windows rmtree cannot delete a read-only file. With
    ignore_errors=True it used to give up quietly and leave the previous build's stage behind, so the next
    os.makedirs failed with FileExistsError on build/stage/windows-x64/runtime."""
    def make_writable_and_retry(function, target, _):
        os.chmod(target, stat.S_IWRITE)
        function(target)
    if os.path.exists(path):
        shutil.rmtree(path, onerror=make_writable_and_retry)
    if os.path.exists(path):
        raise SystemExit(f"\nFAILED: could not remove {path} - is a program (Explorer, an editor, a running Alfred) using it?")


def ensure_image(image):
    """Pulls a missing image in its own visible step - otherwise a first build sits silent through the download."""
    if image.startswith("alfred-build-"):
        return
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode != 0:
        print(f"  pulling Docker image {image} (first build only)", flush=True)
        # Docker Hub limits anonymous pulls per IP, and GitHub's runners share IPs: v3.0.8's release build failed three
        # times on "toomanyrequests". The same official images come from Google's and Amazon's public copies of Docker
        # Hub, which have no such limit - Docker Hub itself is only the last resort.
        failures = []
        for source in pull_sources(image):
            pulled = subprocess.run(["docker", "pull", "-q", source], capture_output=True, text=True, errors="replace")
            if pulled.returncode == 0:
                if source != image:
                    run(["docker", "tag", source, image])
                print(f"  pulled {source}", flush=True)
                return
            failures.append(f"{source}: {(pulled.stderr or pulled.stdout).strip()[:160]}")
            print(f"  could not pull {source} - trying the next source", flush=True)
        raise SystemExit("\nFAILED: no source had " + image + ":\n  " + "\n  ".join(failures))


def pull_sources(image):
    """Where an image is pulled from, in order: mirror.gcr.io, public.ecr.aws (official images live under library/
    and docker/library/), then Docker Hub. Images from another registry (a dot in the first part) are pulled as named."""
    first = image.split("/")[0]
    if "/" in image and ("." in first or ":" in first):
        return [image]
    path = image if "/" in image else "library/" + image
    sources = ["mirror.gcr.io/" + path]
    if "/" not in image:
        sources.append("public.ecr.aws/docker/library/" + image)
    return sources + [image]


def docker(image, script, mounts, dns=None, env=None, show=None):
    ensure_image(image)
    command = ["docker", "run", "--rm"]
    if dns:
        command += ["--dns", dns]
    for source, target, mode in mounts:
        command += ["-v", f"{source}:{target}:{mode}"]
    for key, value in (env or {}).items():
        command += ["-e", f"{key}={value}"]
    command += [image, "sh", "-c", owned_by_caller(script, [target for _, target, mode in mounts if mode == "rw"])]
    run(command, env=dict(os.environ, MSYS_NO_PATHCONV="1"), show=show)


def owned_by_caller(script, writable, ids=None):
    """On a Linux host a container writes its rw mounts as root, and the build user can then neither move nor delete
    what it wrote (the release workflow failed moving the Windows jlink runtime out of build/windows-runtimes). The
    container hands them back to the caller's uid:gid on exit - a failed script too. Docker Desktop on Windows/macOS
    has no host ownership to fix: unchanged there."""
    ids = ids if ids is not None else ((os.getuid(), os.getgid()) if hasattr(os, "getuid") else None)
    if not writable or ids is None or ids[0] == 0:
        return script
    return f"trap 'chown -R {ids[0]}:{ids[1]} {' '.join(writable)} 2>/dev/null || true' EXIT; {script}"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version():
    result = subprocess.run(["git", "describe", "--tags", "--always", "--dirty"], cwd=ROOT, capture_output=True, text=True)
    return (result.stdout.strip() or "0.0.0").lstrip("v")


# ---------------------------------------------------------------------------------------------------------------------
# Steps 2-4: frontend, Java, MCP (each copies the sources into its container: never npm ci into the host's
# node_modules, and never let target/ folders or the Maven cache touch the checkout)
# ---------------------------------------------------------------------------------------------------------------------

# Also left out: what a running Alfred or the tools around the checkout keep writing (logs, pid files, the CodeGraph
# index, Claude's worktrees - a second copy of the repo). Docker Desktop's file share answers a read of a file another
# Windows process is writing with "tar: read error: I/O error", which failed a build started right after start.py
# (its log agent and proxies write log-agent/agent.log and proxy/logs/calls.log). A copy that still hits one is
# retried twice from scratch before the step fails.
TAR_EXCLUDES = ("--exclude=./frontend/node_modules --exclude=./mcp-server/node_modules --exclude=./build "
                "--exclude=./build-cache --exclude=./dist --exclude=./.git --exclude='./backend/*/target' "
                "--exclude=./db-agent/target --exclude=./attach-cli/target --exclude=./frontend/dist "
                "--exclude=./frontend/.angular --exclude=./.claude --exclude=./.codegraph --exclude=__pycache__ "
                "--exclude='*.log' --exclude='*.pid'")
TAR_SOURCES = ("(for try in 1 2 3; do rm -rf /b && mkdir -p /b && "
               f"if tar {TAR_EXCLUDES} -cf - . | tar -xf - -C /b; then break; fi; "
               "[ \"$try\" = 3 ] && exit 1; echo \">> copy failed (a file in use?) - trying again\"; sleep 3; done)")


def npm_ci(extra=""):
    """`npm ci`, saying how many packages it added (notice level) - or every request it makes with --verbose."""
    level = "http" if VERBOSE else "notice"
    return f"npm ci {extra} --no-audit --no-fund --loglevel={level}".replace("  ", " ")


def mvn(tests):
    """No -q: its "Building <module> [n/m]" lines are the progress (filtered by MAVEN_PROGRESS unless --verbose).
    -ntp keeps the dependency-download lines out either way."""
    return f"mvn -B -ntp package {tests}"


def say(text):
    """A phase marker printed from inside a container script, so the log says what the container is doing now."""
    return f"echo '>> {text}'"


def build_frontend(out, dns):
    os.makedirs(out, exist_ok=True)
    docker(NODE_IMAGE, (
        f"set -e; {say('copying sources')} && mkdir -p /b && cd /repo && {TAR_SOURCES} && cd /b/frontend && "
        f"{say('npm ci (installing frontend packages - a few minutes on a first build)')} && {npm_ci()} && "
        f"{say('ng build --configuration production')} && npx ng build --configuration production && "
        "rm -rf /out/browser && cp -r dist/frontend/browser /out/browser && "
        # Same-origin, like the Docker image's entrypoint does: the backend serves the UI and the API on one port.
        "printf 'window.BACKEND_URL = window.location.origin;\\n' > /out/browser/env.js"
    ), [(ROOT, "/repo", "ro"), (out, "/out", "rw")], dns=dns)


def build_java(frontend_dist, out, skip_tests, dns):
    os.makedirs(out, exist_ok=True)
    tests = "-DskipTests" if skip_tests else ""
    docker(MAVEN_IMAGE, (
        f"set -e; {say('copying sources')} && mkdir -p /b && cd /repo && {TAR_SOURCES} && "
        f"{say('backend: mvn package')} && cd /b/backend && {mvn(tests)} -Dalfred.frontend.dist=/frontend && "
        "cp backend-app/target/backend.jar /out/alfred.jar && "
        f"{say('db-agent: mvn package')} && cd /b/db-agent && {mvn(tests)} && cp target/alfred-agent.jar /out/alfred-agent.jar && "
        f"{say('attach-cli: mvn package')} && cd /b/attach-cli && {mvn(tests)} && cp target/attach-cli.jar /out/attach-cli.jar"
    ), [(ROOT, "/repo", "ro"), (frontend_dist, "/frontend", "ro"), (out, "/out", "rw"), ("alfred-m2", "/root/.m2", "rw")],
        dns=dns, show=MAVEN_PROGRESS)


def build_mcp(out, dns):
    """app/mcp: dist/mcp-server.mjs beside package.json and production node_modules (docs/mcp.md). --no-bin-links:
    the folder is copied to Windows too, which cannot hold node_modules/.bin symlinks."""
    os.makedirs(out, exist_ok=True)
    docker(NODE_IMAGE, (
        f"set -e; {say('copying sources')} && mkdir -p /b && cd /repo && {TAR_SOURCES} && "
        f"{say('npm ci (frontend packages the bundle imports)')} && (cd /b/frontend && {npm_ci()}) && "
        f"{say('npm ci (mcp-server)')} && cd /b/mcp-server && {npm_ci()} && rm -rf /out/mcp && "
        f"{say('esbuild bundle')} && node scripts/bundle.mjs /out/mcp/dist/mcp-server.mjs && "
        "cp package.json package-lock.json /out/mcp/ && "
        f"{say('npm ci --omit=dev (production node_modules)')} && cd /out/mcp && {npm_ci('--omit=dev --no-bin-links')}"
    ), [(ROOT, "/repo", "ro"), (out, "/out", "rw")], dns=dns)


# ---------------------------------------------------------------------------------------------------------------------
# Step 5: downloads (checked) and runtimes
# ---------------------------------------------------------------------------------------------------------------------

def fetch(url, expected, dns):
    """Download once into build-cache/downloads, inside a container (works where the host's own DNS does not)."""
    os.makedirs(DOWNLOADS, exist_ok=True)
    name = url.rsplit("/", 1)[1].replace("%2B", "+")
    path = os.path.join(DOWNLOADS, name)
    if not os.path.exists(path) or sha256(path) != expected:
        print(f"  downloading {name}", flush=True)
        docker(PYTHON_IMAGE, (
            "python -c \"import sys,urllib.request as u;"
            "r=u.urlopen(u.Request(sys.argv[1],headers={'User-Agent':'alfred-build'}));"
            "open('/out/'+sys.argv[2]+'.part','wb').write(r.read())\" '" + url + "' '" + name + "'"
        ), [(DOWNLOADS, "/out", "rw")], dns=dns)
        os.replace(path + ".part", path)
    actual = sha256(path)
    if actual != expected:
        os.remove(path)
        raise SystemExit(f"\nFAILED: checksum of {name} is {actual}, build-versions.json expects {expected}")
    print(f"  {name}  {os.path.getsize(path) // (1024 * 1024)} MB, checksum ok", flush=True)
    return path


def fetch_all(targets, dns):
    paths = {}
    for target in targets:
        for kind in ("jdk", "python", "node"):
            spec = VERSIONS[kind][target]
            paths[(kind, target)] = fetch(spec["url"], spec["sha256"], dns)
    # jlink always runs from the Linux JDK, whatever the target.
    spec = VERSIONS["jdk"]["linux-x64"]
    paths[("jdk", "linux-x64")] = fetch(spec["url"], spec["sha256"], dns)
    if "windows-x64" in targets:
        paths["winsw"] = fetch(VERSIONS["winsw"]["url"], VERSIONS["winsw"]["sha256"], dns)
    return paths


def extract(archive, into):
    """Unpacks an archive whose content is one top folder and returns that folder."""
    remove_tree(into)
    os.makedirs(into)
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(into)
    else:
        with tarfile.open(archive) as t:
            t.extractall(into, filter="tar")
    entries = os.listdir(into)
    return os.path.join(into, entries[0]) if len(entries) == 1 else into


def python_minor():
    return VERSIONS["python"]["version"].rsplit(".", 1)[0]


def prune_python(root):
    for current, folders, _files in os.walk(root, topdown=True):
        for folder in list(folders):
            if folder in PYTHON_PRUNE:
                shutil.rmtree(os.path.join(current, folder), ignore_errors=True)
                folders.remove(folder)


def uv_install_command(site, target, packages):
    spec = VERSIONS["python"][target]
    return (f"pip install -q --disable-pip-version-check --root-user-action=ignore uv=={VERSIONS['uv']} && "
            f"uv pip install -q --target {site} --python-platform {spec['uvPlatform']} --python-version {python_minor()} "
            f"--only-binary :all: {' '.join(packages)}")


def jlink_command(jlink, jmods, output):
    # --strip-java-debug-attributes, not --strip-debug: the latter also strips native libraries with objcopy, which a
    # build container does not have (and the Windows libraries are not ELF anyway).
    return [jlink, "--module-path", jmods, "--add-modules", ",".join(JLINK_MODULES), "--strip-java-debug-attributes",
            "--no-header-files", "--no-man-pages", "--compress", "zip-6", "--output", output]


# ---------------------------------------------------------------------------------------------------------------------
# Step 6: stage and installers
# ---------------------------------------------------------------------------------------------------------------------

def write_text(source, target, newline):
    with open(source, encoding="utf-8") as f:
        text = f.read().replace("\r\n", "\n")
    with open(target, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace("\n", newline))


def stage_app(root, target, version_text, java_out, mcp_out):
    """Everything except the runtimes - identical for both targets apart from launchers and the service files."""
    app = os.path.join(root, "app")
    os.makedirs(os.path.join(app, "proxy"), exist_ok=True)
    for jar in ("alfred.jar", "alfred-agent.jar", "attach-cli.jar"):
        shutil.copy2(os.path.join(java_out, jar), os.path.join(app, jar))
    shutil.copytree(os.path.join(mcp_out, "mcp"), os.path.join(app, "mcp"), dirs_exist_ok=True, symlinks=True)
    for name in os.listdir(os.path.join(ROOT, "proxy")):
        if name.endswith(".py") and not name.startswith("test_"):
            shutil.copy2(os.path.join(ROOT, "proxy", name), os.path.join(app, "proxy", name))
    shutil.copytree(os.path.join(ROOT, "packaging", "launcher"), os.path.join(app, "launcher"), dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    os.makedirs(os.path.join(app, "log-agent"), exist_ok=True)
    shutil.copy2(os.path.join(ROOT, "log-agent", "agent.py"), os.path.join(app, "log-agent", "agent.py"))
    for name in ("alfred_settings.py", "alfred_logwatch.py", "alfred_skill.py"):
        shutil.copy2(os.path.join(ROOT, name), os.path.join(app, name))
    # The Claude Code skill (/alfred-qa), installed with `alfred skill install` (docs/mcp.md).
    shutil.copytree(os.path.join(ROOT, "skills"), os.path.join(app, "skills"), dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(os.path.join(ROOT, "backend", "backend-server", "src", "main", "resources", "settings-env-map.json"),
                 os.path.join(app, "settings-env-map.json"))
    with open(os.path.join(app, "VERSION"), "w", encoding="utf-8", newline="\n") as f:
        f.write(version_text + "\n")
    shutil.copy2(os.path.join(ROOT, "settings.properties"), os.path.join(root, "settings.properties"))
    service = os.path.join(root, "service")
    os.makedirs(service, exist_ok=True)
    if target.startswith("linux"):
        write_text(os.path.join(ROOT, "packaging", "linux", "alfred"), os.path.join(root, "alfred"), "\n")
        write_text(os.path.join(ROOT, "packaging", "linux", "alfred.service"), os.path.join(service, "alfred.service"), "\n")
    else:
        write_text(os.path.join(ROOT, "packaging", "windows", "alfred.cmd"), os.path.join(root, "alfred.cmd"), "\r\n")
        write_text(os.path.join(ROOT, "packaging", "windows", "alfred-service.xml"),
                   os.path.join(service, "alfred-service.xml"), "\r\n")


def is_executable(relative):
    relative = relative.replace("\\", "/")
    name = relative.rsplit("/", 1)[-1]
    return (relative == "alfred" or relative.startswith(EXECUTABLE_PREFIXES)
            or name.endswith(".so") or ".so." in name)


def write_run(stage_root, header, out):
    """The Linux installer: a POSIX sh header, then a tar.gz of the stage folder. Executable bits are set from
    is_executable() and symlinks are kept, so it does not matter what file system the stage was on."""
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz", compresslevel=6) as tar:
        for current, folders, files in os.walk(stage_root):
            folders.sort()
            for name in sorted(files) + sorted(f for f in folders if os.path.islink(os.path.join(current, f))):
                full = os.path.join(current, name)
                relative = os.path.relpath(full, stage_root).replace("\\", "/")
                info = tar.gettarinfo(full, arcname="alfred/" + relative)
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                if info.isreg():
                    info.mode = 0o755 if is_executable(relative) else 0o644
                    with open(full, "rb") as f:
                        tar.addfile(info, f)
                else:
                    tar.addfile(info)
    with open(header, encoding="utf-8") as f:
        head = f.read().replace("\r\n", "\n")
    if not head.endswith("\n"):
        head += "\n"
    tmp = out + ".part"
    with open(tmp, "wb") as f:
        f.write(head.encode("utf-8"))
        f.write(b"__ARCHIVE_BELOW__\n")
        f.write(payload.getvalue())
    os.chmod(tmp, 0o755)
    os.replace(tmp, out)


def linux_installer(version_text, java_out, mcp_out, paths, dns):
    """Runs this same script inside a Linux container (--in-container-linux): see container_linux()."""
    args =[os.path.basename(paths[("jdk", "linux-x64")]), os.path.basename(paths[("python", "linux-x64")]),
            os.path.basename(paths[("node", "linux-x64")])]
    docker(PYTHON_IMAGE, (
        "set -e; python /repo/build_dist.py --in-container-linux " + version_text + " " + " ".join(args)
    ), [(ROOT, "/repo", "ro"), (DOWNLOADS, "/downloads", "ro"), (java_out, "/java", "ro"), (mcp_out, "/mcp", "ro"),
        (DIST, "/dist", "rw")], dns=dns)
    return os.path.join(DIST, f"alfred-setup-{version_text}-linux-x64.run")


def container_linux(version_text, jdk_archive, python_archive, node_archive):
    """Inside the Linux container: runtimes, stage and the .run, all on the container's own file system."""
    work = "/work"
    root = os.path.join(work, "stage")
    os.makedirs(root)
    print("  linux: jlink Java runtime", flush=True)
    jdk = extract(os.path.join("/downloads", jdk_archive), os.path.join(work, "jdk"))
    run(jlink_command(os.path.join(jdk, "bin", "jlink"), os.path.join(jdk, "jmods"), os.path.join(root, "runtime", "java")))
    print("  linux: Python + mitmproxy (uv)", flush=True)
    python = extract(os.path.join("/downloads", python_archive), os.path.join(work, "python"))
    site = os.path.join(python, "lib", f"python{python_minor()}", "site-packages")
    run(["sh", "-c", uv_install_command(site, "linux-x64", [f"mitmproxy=={VERSIONS['mitmproxy']}"])])
    prune_python(python)
    shutil.move(python, os.path.join(root, "runtime", "python"))
    node = extract(os.path.join("/downloads", node_archive), os.path.join(work, "node"))
    shutil.move(node, os.path.join(root, "runtime", "node"))
    print("  linux: staging app + writing .run", flush=True)
    stage_app(root, "linux-x64", version_text, "/java", "/mcp")
    write_run(root, os.path.join(ROOT, "packaging", "linux", "installer-header.sh"),
              os.path.join("/dist", f"alfred-setup-{version_text}-linux-x64.run"))


def windows_installer(version_text, java_out, mcp_out, paths, dns):
    root = os.path.join(BUILD, "stage", "windows-x64")
    remove_tree(root)
    os.makedirs(os.path.join(root, "runtime"))
    work = os.path.join(BUILD, "windows-runtimes")
    remove_tree(work)
    os.makedirs(work)
    # jlink from the Linux JDK with the Windows jmods (same release).
    print("  windows: jlink Java runtime", flush=True)
    jdk_win = extract(paths[("jdk", "windows-x64")], os.path.join(work, "jdk-win"))
    docker(PYTHON_IMAGE, (
        "set -e; mkdir -p /j && tar -xzf /downloads/" + os.path.basename(paths[("jdk", "linux-x64")]) + " -C /j && "
        "J=$(ls -d /j/*) && $J/bin/jlink " + " ".join(jlink_command("", "/win-jmods", "/out/java")[1:])
    ), [(DOWNLOADS, "/downloads", "ro"), (os.path.join(jdk_win, "jmods"), "/win-jmods", "ro"), (work, "/out", "rw")], dns=dns)
    shutil.move(os.path.join(work, "java"), os.path.join(root, "runtime", "java"))
    print("  windows: Python + mitmproxy (uv)", flush=True)
    python = extract(paths[("python", "windows-x64")], os.path.join(work, "python"))
    rel_site = os.path.relpath(os.path.join(python, "Lib", "site-packages"), work).replace("\\", "/")
    docker(PYTHON_IMAGE, uv_install_command("/work/" + rel_site, "windows-x64",
                                            [f"mitmproxy=={VERSIONS['mitmproxy']}", "watchdog"]),
           [(work, "/work", "rw")], dns=dns)
    prune_python(python)
    shutil.move(python, os.path.join(root, "runtime", "python"))
    node = extract(paths[("node", "windows-x64")], os.path.join(work, "node"))
    shutil.move(node, os.path.join(root, "runtime", "node"))
    stage_app(root, "windows-x64", version_text, java_out, mcp_out)
    shutil.copy2(paths["winsw"], os.path.join(root, "service", "alfred-service.exe"))

    out = os.path.join(DIST, f"alfred-setup-{version_text}-windows-x64.exe")
    nsis = os.path.join(BUILD, "nsis")
    remove_tree(nsis)
    os.makedirs(nsis)
    write_text(os.path.join(ROOT, "packaging", "windows", "installer.nsi"), os.path.join(nsis, "installer.nsi"), "\r\n")
    shutil.copy2(os.path.join(ROOT, "packaging", "windows", "make_way.py"), os.path.join(nsis, "make_way.py"))
    ensure_nsis_image(dns)
    print("  windows: makensis (packing the .exe)", flush=True)
    numeric = ".".join((numeric_version(version_text) + ["0"] * 4)[:4])
    docker(NSIS_IMAGE, (
        f"makensis -V2 -DVERSION={version_text} -DVERSION_NUMERIC={numeric} -DSTAGE=/stage "
        f"-DOUTFILE=/out/{os.path.basename(out)}.part /nsis/installer.nsi"
    ), [(root, "/stage", "ro"), (nsis, "/nsis", "ro"), (DIST, "/out", "rw")], dns=dns)
    os.replace(out + ".part", out)
    return out


def numeric_version(text):
    numbers = [part for part in text.split("-")[0].split(".") if part.isdigit()]
    return numbers or ["0"]


def ensure_nsis_image(dns):
    """A small Debian image with makensis (NSIS builds Windows installers from any OS), made once."""
    if subprocess.run(["docker", "image", "inspect", NSIS_IMAGE], capture_output=True).returncode == 0:
        return
    ensure_image("debian:bookworm-slim")
    print(f"  building {NSIS_IMAGE} (first build only)", flush=True)
    container = "alfred-build-nsis-setup"
    subprocess.run(["docker", "rm", "-f", container], capture_output=True)
    command = ["docker", "run", "--name", container]
    if dns:
        command += ["--dns", dns]
    command += ["debian:bookworm-slim", "sh", "-c",
                "apt-get update -qq && apt-get install -y -qq --no-install-recommends nsis >/dev/null && rm -rf /var/lib/apt/lists/*"]
    run(command)
    run(["docker", "commit", container, NSIS_IMAGE])
    run(["docker", "rm", container])


def skill_archive(version_text):
    """dist/alfred-qa-skill-<version>.zip: the skill on its own, for a Claude Code user who reaches Alfred over the
    network and has no install here - unzip it into ~/.claude/skills (or a repo's .claude/skills)."""
    import zipfile
    path = os.path.join(DIST, f"alfred-qa-skill-{version_text}.zip")
    source = os.path.join(ROOT, "skills")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for current, folders, files in os.walk(source):
            folders[:] = sorted(f for f in folders if f != "__pycache__")
            for name in sorted(files):
                full = os.path.join(current, name)
                z.write(full, os.path.relpath(full, source).replace(os.sep, "/"))
    return path


def checksums(files):
    with open(os.path.join(DIST, "SHA256SUMS"), "w", encoding="utf-8", newline="\n") as f:
        for path in files:
            f.write(f"{sha256(path)}  {os.path.basename(path)}\n")


RELEASE_URL_BASE = "https://github.com/f-Baiomy/ALFRED/releases/download"


def target_of(installer_name):
    """alfred-setup-1.4.0-windows-x64.exe -> windows-x64 (the key an installed Alfred looks itself up by)."""
    for target in TARGETS:
        if target in installer_name:
            return target
    return None


def release_notes(version_text):
    """The tag's annotation when HEAD is tagged (git tag -a ... -m), else empty - the notes an update shows."""
    if not re.match(r"^\d+\.\d+", version_text) or "-" in version_text:
        return ""
    result = subprocess.run(["git", "tag", "-l", "--format=%(contents)", "v" + version_text], cwd=ROOT,
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    return result.stdout.strip() if result.returncode == 0 else ""


def manifest(version_text, files, url_base=RELEASE_URL_BASE, notes="", published=None):
    """latest.json: what an installed Alfred reads to learn about this release (backend-server UpdateService) -
    the version, and per target the installer's URL, sha256 and size. The URL is where the release workflow uploads
    the file; a server without internet gets the same file from a share, with ALFRED_UPDATE_URL pointing there."""
    assets = {}
    for path in files:
        name = os.path.basename(path)
        target = target_of(name)
        if target:
            assets[target] = {"url": f"{url_base}/v{version_text}/{name}", "sha256": sha256(path), "size": os.path.getsize(path)}
    return {"version": version_text, "notes": notes,
            "publishedAt": published or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "assets": assets}


KEEP_RELEASES = 10  # older releases listed in latest.json


def with_history(current, previous, keep=KEEP_RELEASES):
    """`current` plus a "releases" list: the release `previous` (the latest.json this one replaces) and the ones IT
    listed, newest first, `keep` at most, each with its installers and the first line of its notes. An installed Alfred
    several releases behind then sees every release it would skip and can install any of them - the installers stay
    on GitHub. A previous manifest that is missing or not one adds nothing."""
    if not isinstance(previous, dict) or not previous.get("version"):
        return current
    older = [{k: v for k, v in previous.items() if k != "releases"}] + [r for r in previous.get("releases") or [] if isinstance(r, dict)]
    seen, releases = {current["version"]}, []
    for release in older:
        version = release.get("version")
        if not version or version in seen or not release.get("assets"):
            continue
        seen.add(version)
        releases.append({"version": version, "notes": (release.get("notes") or "").strip().split("\n")[0],
                         "publishedAt": release.get("publishedAt", ""), "assets": release["assets"]})
    return {**current, "releases": releases[:keep]} if releases else current


def previous_manifest(source):
    """The latest.json this release replaces (ALFRED_PREVIOUS_MANIFEST: a URL or a file), or None - a build never
    fails over it: it only means the new latest.json lists no older releases."""
    if not source:
        return None
    try:
        if source.startswith(("http://", "https://")):
            request = urllib.request.Request(source, headers={"User-Agent": "alfred-build"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        with open(source, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(f"  (the previous latest.json could not be read from {source}: {e} - listing no older releases)")
        return None


def write_manifest(version_text, files, url_base=RELEASE_URL_BASE):
    path = os.path.join(DIST, "latest.json")
    current = manifest(version_text, files, url_base, release_notes(version_text))
    current = with_history(current, previous_manifest(os.environ.get("ALFRED_PREVIOUS_MANIFEST", "")))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(current, f, indent=2)
        f.write("\n")
    return path


def main(argv):
    if argv and argv[0] == "--in-container-linux":
        global IN_CONTAINER
        IN_CONTAINER = True
        container_linux(*argv[1:5])
        return 0
    parser = argparse.ArgumentParser(description="Build the native Alfred installers from the current code.")
    parser.add_argument("--target", choices=("linux", "windows", "all"), default="all")
    parser.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--clean", action="store_true", help="rebuild from scratch (downloads stay cached)")
    parser.add_argument("--dns", default=os.environ.get("ALFRED_BUILD_DNS"), help="DNS server for the build containers")
    parser.add_argument("--reuse", action="store_true",
                        help="reuse the frontend, jars and MCP bundle of the previous build (installer work only)")
    parser.add_argument("--verbose", action="store_true",
                        help="print every line of every tool (full Maven output, npm http log)")
    parser.add_argument("--release-url-base", default=os.environ.get("ALFRED_RELEASE_URL_BASE", RELEASE_URL_BASE),
                        help="where the installers will be downloadable, for dist/latest.json (default: GitHub Releases)")
    args = parser.parse_args(argv)
    global VERBOSE
    VERBOSE = args.verbose
    targets = TARGETS if args.target == "all" else tuple(t for t in TARGETS if t.startswith(args.target))

    if args.clean:
        remove_tree(BUILD)
    for folder in (BUILD, DIST, DOWNLOADS):
        os.makedirs(folder, exist_ok=True)

    version_text = version()
    step(1, "version", version_text)
    frontend_out = os.path.join(BUILD, "frontend")
    java_out = os.path.join(BUILD, "java")
    mcp_out = os.path.join(BUILD, "mcp-out")
    reuse = args.reuse and all(os.path.exists(p) for p in (os.path.join(frontend_out, "browser"),
                                                           os.path.join(java_out, "alfred.jar"), os.path.join(mcp_out, "mcp")))
    if reuse:
        step(2, "frontend", "reused")
        step(3, "backend", "reused")
        step(4, "mcp", "reused")
    else:
        step(2, "frontend", "npm ci + ng build")
        build_frontend(frontend_out, args.dns)
        step(3, "backend", "mvn package, JDK 21 in Docker" + (" (tests skipped)" if args.skip_tests else ""))
        build_java(os.path.join(frontend_out, "browser"), java_out, args.skip_tests, args.dns)
        step(4, "mcp", "esbuild bundle + production node_modules")
        build_mcp(mcp_out, args.dns)
    step(5, "runtimes", "Java 21 (jlink), Python + mitmproxy (uv), Node - " + ", ".join(targets))
    paths = fetch_all(targets, args.dns)
    step(6, "installers", ", ".join(targets))
    outputs = []
    if "linux-x64" in targets:
        outputs.append(linux_installer(version_text, java_out, mcp_out, paths, args.dns))
    if "windows-x64" in targets:
        outputs.append(windows_installer(version_text, java_out, mcp_out, paths, args.dns))
    skill = skill_archive(version_text)
    checksums(outputs + [skill])
    outputs.append(write_manifest(version_text, outputs, args.release_url_base))
    outputs.append(skill)
    print(f"        done in {elapsed(time.monotonic() - _step_start)}")
    print(f"built in {elapsed(time.monotonic() - _build_start)}:")
    for path in outputs + [os.path.join(DIST, "SHA256SUMS")]:
        print(f"  {os.path.relpath(path, ROOT)}  {os.path.getsize(path) // (1024 * 1024)} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
