"""
docker_import.py - brings an existing Docker install of Alfred into a native one (FR-002d, research R17).

    docker_import.py --detect                       print the Docker install's folder (exit 1 when there is none)
    docker_import.py --home <install> --from <repo folder>

Copies, never moves: the Docker folder and its volumes are never changed or deleted, so a failed or abandoned
native install never costs recorded data. Order: check free disk, copy everything into data/.import-tmp while
Docker still runs, stop the containers, copy again what changed meanwhile, then move into data/. Any failure
deletes the temp folder and starts the containers again. Settings go through ServerConfigCli merge-docker-env -
the Java settings engine - so Python never writes .env.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from layout import Layout  # noqa: E402

DOCKER = os.environ.get("ALFRED_DOCKER", "docker")
VOLUMES = {"logs-db": "logs.db", "db-capture-db": "db-capture.db"}
FLAGS = ("reverse-proxy-enabled.flag", "db-capture-enabled.flag", "log-link-enabled.flag", "redis-capture-enabled.flag")


class ImportFailed(Exception):
    pass


def docker(*args, capture=True):
    result = subprocess.run([DOCKER, *args], capture_output=capture, text=True)
    if result.returncode != 0:
        raise ImportFailed(f"docker {' '.join(args)} failed: {(result.stderr or '').strip()}")
    return (result.stdout or "").strip()


def is_alfred_repo(folder):
    return bool(folder) and all(os.path.exists(os.path.join(folder, name)) for name in ("docker-compose.yml", "start.py"))


def detect():
    """The working folder of a running (or stopped) "backend" container created by docker compose for Alfred."""
    try:
        folder = docker("inspect", "backend", "--format", '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
    except (ImportFailed, OSError):
        return None
    return folder if is_alfred_repo(folder) else None


def compose_project(folder):
    try:
        return docker("inspect", "backend", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}') or \
            os.path.basename(os.path.abspath(folder)).lower()
    except (ImportFailed, OSError):
        return os.path.basename(os.path.abspath(folder)).lower()


def folder_size(path):
    total = 0
    for current, _folders, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(current, name))
            except OSError:
                pass
    return total


def copy_changed(source, target):
    """Copies files that are new or differ in size or modification time - the second pass after the containers stop
    only copies what was written while the first pass ran."""
    if not os.path.exists(source):
        return 0
    copied = 0
    for current, _folders, files in os.walk(source):
        relative = os.path.relpath(current, source)
        destination = os.path.normpath(os.path.join(target, relative))
        os.makedirs(destination, exist_ok=True)
        for name in files:
            src, dst = os.path.join(current, name), os.path.join(destination, name)
            stat = os.stat(src)
            if os.path.exists(dst):
                existing = os.stat(dst)
                if existing.st_size == stat.st_size and int(existing.st_mtime) == int(stat.st_mtime):
                    continue
            shutil.copy2(src, dst)
            copied += 1
    return copied


def copy_volume(project, volume, target):
    """A named volume's files, through a throwaway container (volumes are not host folders on Docker Desktop)."""
    os.makedirs(target, exist_ok=True)
    try:
        docker("run", "--rm", "-v", f"{project}_{volume}:/v:ro", "-v", f"{os.path.abspath(target)}:/out",
               "alpine", "sh", "-c", "cp -a /v/. /out/")
    except ImportFailed as e:
        print(f"  (volume {project}_{volume} not copied: {e})")


def copy_pass(repo, project, tmp):
    copy_changed(os.path.join(repo, "backend", "data"), os.path.join(tmp, "appdata"))
    for volume in VOLUMES:
        copy_volume(project, volume, os.path.join(tmp, "volumes", volume))
    proxy = os.path.join(repo, "proxy")
    os.makedirs(os.path.join(tmp, "proxy"), exist_ok=True)
    for flag in FLAGS:
        if os.path.isfile(os.path.join(proxy, flag)):
            shutil.copy2(os.path.join(proxy, flag), os.path.join(tmp, "proxy", flag))
    copy_changed(os.path.join(proxy, "interception"), os.path.join(tmp, "proxy", "interception"))
    copy_changed(os.path.join(proxy, "certs"), os.path.join(tmp, "certs"))


def place(layout, tmp):
    """Moves the copy into data/. Anything already there is moved aside, never deleted."""
    aside = os.path.join(layout.data, f".before-import-{time.strftime('%Y%m%d-%H%M%S')}")
    moves = [
        (os.path.join(tmp, "appdata"), layout.appdata),
        (os.path.join(tmp, "proxy"), layout.proxy_data),
        (os.path.join(tmp, "certs"), layout.certs),
    ]
    for volume, file_name in VOLUMES.items():
        moves.append((os.path.join(tmp, "volumes", volume, file_name), os.path.join(layout.data, file_name)))
    for source, target in moves:
        if not os.path.exists(source):
            continue
        if os.path.exists(target):
            os.makedirs(aside, exist_ok=True)
            shutil.move(target, os.path.join(aside, os.path.basename(target)))
        shutil.move(source, target)


def merge_settings(layout, repo):
    result = subprocess.run(layout.config_cli("merge-docker-env", repo), capture_output=True, text=True)
    # Both streams: "stdout or stderr" dropped the error text whenever the command had printed anything first.
    output = "\n".join(part for part in (result.stdout.strip(), result.stderr.strip()) if part)
    if output:
        print("  " + output.replace("\n", "\n  "))
    if result.returncode != 0:
        raise ImportFailed("settings could not be merged")


def import_docker(layout, repo):
    repo = os.path.abspath(repo)
    if not is_alfred_repo(repo):
        raise ImportFailed(f"{repo} is not an Alfred folder (no docker-compose.yml and start.py)")
    project = compose_project(repo)
    needed = folder_size(os.path.join(repo, "backend", "data")) + folder_size(os.path.join(repo, "proxy"))
    free = shutil.disk_usage(layout.home).free
    if needed * 2 > free:
        raise ImportFailed(f"not enough free disk: {needed // (1 << 20)} MB to copy, {free // (1 << 20)} MB free")

    layout.make_dirs()
    tmp = os.path.join(layout.data, ".import-tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    stopped = False
    try:
        print(f"  Copying recorded data from {repo} ...")
        copy_pass(repo, project, tmp)
        print("  Stopping the Docker containers ...")
        stop = subprocess.run([DOCKER, "compose", "stop"], cwd=repo, capture_output=True, text=True)
        if stop.returncode != 0:
            # Copying the databases of containers that are still writing them can give a torn copy - and this
            # used to go on regardless and then report the containers as stopped.
            raise ImportFailed("could not stop the Docker containers: "
                               + ((stop.stderr or stop.stdout).strip() or f"exit {stop.returncode}"))
        stopped = True
        copy_pass(repo, project, tmp)
        merge_settings(layout, repo)
        place(layout, tmp)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        if stopped:
            subprocess.run([DOCKER, "compose", "start"], cwd=repo, capture_output=True)
            print("  The Docker containers were started again.")
        raise
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"  Imported. The Docker folder {repo} is unchanged; its containers are stopped "
          f"(start them again with: docker compose start, in that folder).")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--detect", action="store_true")
    parser.add_argument("--home")
    parser.add_argument("--from", dest="repo")
    args = parser.parse_args(argv)
    if args.detect:
        folder = detect()
        if folder:
            print(folder)
            return 0
        return 1
    if not args.home or not args.repo:
        parser.print_usage()
        return 2
    try:
        import_docker(Layout(args.home), args.repo)
    except (ImportFailed, OSError) as e:
        print(f"  Docker import failed: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
