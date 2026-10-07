#!/usr/bin/env python3
"""
build_dist.py - builds the native installers of the current code (specs/012-server-program research R4,
contracts/installer-and-build.md):

    dist/alfred-setup-<version>-linux-x64.run
    dist/alfred-setup-<version>-windows-x64.exe
    dist/SHA256SUMS

Usage:
    python build_dist.py [--target linux|windows|all] [--skip-tests] [--clean] [--reuse] [--dns 8.8.8.8]

Prerequisites on this machine: Python 3.10+ and Docker. Every build step runs in a container, so the result does not
depend on the JDK, Node or Python on the PATH (a bare `mvn` here silently runs JDK 8 - see CLAUDE.md). Runtimes and
tools are downloaded once into build-cache/downloads, each checked against the sha256 pinned in build-versions.json.
--dns passes a resolver to the containers, for networks whose own DNS does not answer inside Docker
(ALFRED_BUILD_DNS does the same).

The Linux installer is assembled entirely inside a Linux container: its runtimes contain symlinks and executable
bits a Windows checkout cannot hold. The Windows installer is staged on the host and packed by NSIS in a container.
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile

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


def step(number, name, detail=""):
    print(f"[{number}/6] {name:<11} {detail}", flush=True)


def run(command, cwd=ROOT, env=None):
    result = subprocess.run(command, cwd=cwd, env=env)
    if result.returncode != 0:
        raise SystemExit(f"\nFAILED ({result.returncode}): {' '.join(command)}")


def docker(image, script, mounts, dns=None, env=None):
    command = ["docker", "run", "--rm"]
    if dns:
        command += ["--dns", dns]
    for source, target, mode in mounts:
        command += ["-v", f"{source}:{target}:{mode}"]
    for key, value in (env or {}).items():
        command += ["-e", f"{key}={value}"]
    command += [image, "sh", "-c", script]
    run(command, env=dict(os.environ, MSYS_NO_PATHCONV="1"))


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

TAR_SOURCES = ("tar --exclude=./frontend/node_modules --exclude=./mcp-server/node_modules --exclude=./build "
               "--exclude=./build-cache --exclude=./dist --exclude=./.git --exclude='./backend/*/target' "
               "--exclude=./db-agent/target --exclude=./attach-cli/target --exclude=./frontend/dist "
               "--exclude=./frontend/.angular -cf - . | tar -xf - -C /b")


def build_frontend(out, dns):
    os.makedirs(out, exist_ok=True)
    docker(NODE_IMAGE, (
        f"set -e; mkdir -p /b && cd /repo && {TAR_SOURCES} && cd /b/frontend && "
        "npm ci --no-audit --no-fund --loglevel=error && npx ng build --configuration production && "
        "rm -rf /out/browser && cp -r dist/frontend/browser /out/browser && "
        # Same-origin, like the Docker image's entrypoint does: the backend serves the UI and the API on one port.
        "printf 'window.BACKEND_URL = window.location.origin;\\n' > /out/browser/env.js"
    ), [(ROOT, "/repo", "ro"), (out, "/out", "rw")], dns=dns)


def build_java(frontend_dist, out, skip_tests, dns):
    os.makedirs(out, exist_ok=True)
    tests = "-DskipTests" if skip_tests else ""
    docker(MAVEN_IMAGE, (
        f"set -e; mkdir -p /b && cd /repo && {TAR_SOURCES} && "
        f"cd /b/backend && mvn -B -q package {tests} -Dalfred.frontend.dist=/frontend && "
        "cp backend-app/target/backend.jar /out/alfred.jar && "
        f"cd /b/db-agent && mvn -B -q package {tests} && cp target/alfred-db-agent.jar /out/alfred-agent.jar && "
        f"if [ -f /b/attach-cli/pom.xml ]; then cd /b/attach-cli && mvn -B -q package {tests} && "
        "cp target/attach-cli.jar /out/attach-cli.jar; fi"
    ), [(ROOT, "/repo", "ro"), (frontend_dist, "/frontend", "ro"), (out, "/out", "rw"), ("alfred-m2", "/root/.m2", "rw")],
        dns=dns)


def build_mcp(out, dns):
    """app/mcp: dist/mcp-server.mjs beside package.json and production node_modules (docs/mcp.md). --no-bin-links:
    the folder is copied to Windows too, which cannot hold node_modules/.bin symlinks."""
    os.makedirs(out, exist_ok=True)
    docker(NODE_IMAGE, (
        f"set -e; mkdir -p /b && cd /repo && {TAR_SOURCES} && (cd /b/frontend && npm ci --no-audit --no-fund --loglevel=error) && "
        "cd /b/mcp-server && npm ci --no-audit --no-fund --loglevel=error && rm -rf /out/mcp && "
        "node scripts/bundle.mjs /out/mcp/dist/mcp-server.mjs && cp package.json package-lock.json /out/mcp/ && "
        "cd /out/mcp && npm ci --omit=dev --no-bin-links --no-audit --no-fund --loglevel=error"
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
    shutil.rmtree(into, ignore_errors=True)
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
        if os.path.exists(os.path.join(java_out, jar)):
            shutil.copy2(os.path.join(java_out, jar), os.path.join(app, jar))
    shutil.copytree(os.path.join(mcp_out, "mcp"), os.path.join(app, "mcp"), dirs_exist_ok=True, symlinks=True)
    for name in os.listdir(os.path.join(ROOT, "proxy")):
        if name.endswith(".py") and not name.startswith("test_"):
            shutil.copy2(os.path.join(ROOT, "proxy", name), os.path.join(app, "proxy", name))
    shutil.copytree(os.path.join(ROOT, "packaging", "launcher"), os.path.join(app, "launcher"), dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    os.makedirs(os.path.join(app, "log-agent"), exist_ok=True)
    shutil.copy2(os.path.join(ROOT, "log-agent", "agent.py"), os.path.join(app, "log-agent", "agent.py"))
    for name in ("alfred_settings.py", "alfred_logwatch.py"):
        shutil.copy2(os.path.join(ROOT, name), os.path.join(app, name))
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
    jdk = extract(os.path.join("/downloads", jdk_archive), os.path.join(work, "jdk"))
    run(jlink_command(os.path.join(jdk, "bin", "jlink"), os.path.join(jdk, "jmods"), os.path.join(root, "runtime", "java")))
    python = extract(os.path.join("/downloads", python_archive), os.path.join(work, "python"))
    site = os.path.join(python, "lib", f"python{python_minor()}", "site-packages")
    run(["sh", "-c", uv_install_command(site, "linux-x64", [f"mitmproxy=={VERSIONS['mitmproxy']}"])])
    prune_python(python)
    shutil.move(python, os.path.join(root, "runtime", "python"))
    node = extract(os.path.join("/downloads", node_archive), os.path.join(work, "node"))
    shutil.move(node, os.path.join(root, "runtime", "node"))
    stage_app(root, "linux-x64", version_text, "/java", "/mcp")
    write_run(root, os.path.join(ROOT, "packaging", "linux", "installer-header.sh"),
              os.path.join("/dist", f"alfred-setup-{version_text}-linux-x64.run"))


def windows_installer(version_text, java_out, mcp_out, paths, dns):
    root = os.path.join(BUILD, "stage", "windows-x64")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "runtime"))
    work = os.path.join(BUILD, "windows-runtimes")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    # jlink from the Linux JDK with the Windows jmods (same release).
    jdk_win = extract(paths[("jdk", "windows-x64")], os.path.join(work, "jdk-win"))
    docker(PYTHON_IMAGE, (
        "set -e; mkdir -p /j && tar -xzf /downloads/" + os.path.basename(paths[("jdk", "linux-x64")]) + " -C /j && "
        "J=$(ls -d /j/*) && $J/bin/jlink " + " ".join(jlink_command("", "/win-jmods", "/out/java")[1:])
    ), [(DOWNLOADS, "/downloads", "ro"), (os.path.join(jdk_win, "jmods"), "/win-jmods", "ro"), (work, "/out", "rw")], dns=dns)
    shutil.move(os.path.join(work, "java"), os.path.join(root, "runtime", "java"))
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
    shutil.rmtree(nsis, ignore_errors=True)
    os.makedirs(nsis)
    write_text(os.path.join(ROOT, "packaging", "windows", "installer.nsi"), os.path.join(nsis, "installer.nsi"), "\r\n")
    ensure_nsis_image(dns)
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


def checksums(files):
    with open(os.path.join(DIST, "SHA256SUMS"), "w", encoding="utf-8", newline="\n") as f:
        for path in files:
            f.write(f"{sha256(path)}  {os.path.basename(path)}\n")


def main(argv):
    if argv and argv[0] == "--in-container-linux":
        container_linux(*argv[1:5])
        return 0
    parser = argparse.ArgumentParser(description="Build the native Alfred installers from the current code.")
    parser.add_argument("--target", choices=("linux", "windows", "all"), default="all")
    parser.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--clean", action="store_true", help="rebuild from scratch (downloads stay cached)")
    parser.add_argument("--dns", default=os.environ.get("ALFRED_BUILD_DNS"), help="DNS server for the build containers")
    parser.add_argument("--reuse", action="store_true",
                        help="reuse the frontend, jars and MCP bundle of the previous build (installer work only)")
    args = parser.parse_args(argv)
    targets = TARGETS if args.target == "all" else tuple(t for t in TARGETS if t.startswith(args.target))

    if args.clean:
        shutil.rmtree(BUILD, ignore_errors=True)
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
    checksums(outputs)
    for path in outputs + [os.path.join(DIST, "SHA256SUMS")]:
        print(f"  {os.path.relpath(path, ROOT)}  {os.path.getsize(path) // (1024 * 1024)} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
