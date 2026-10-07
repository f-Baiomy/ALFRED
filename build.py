#!/usr/bin/env python3
"""
build.py - build the Alfred installers from the current code, asking what to build:

    python build.py                      Windows, Linux or both; tests or not; DNS for the build containers
    python build.py --target windows --skip-tests --yes

A thin front on build_dist.py (which does the work and prints live progress). The DNS answer is remembered in
.env as ALFRED_BUILD_DNS, so it is asked only once per machine.
"""

import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(ROOT, ".env")
TARGETS = {"1": "windows", "2": "linux", "3": "all", "windows": "windows", "linux": "linux", "both": "all", "all": "all"}


def read_env_value(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.strip().split("=", 1)[1]
    except OSError:
        pass
    return ""


def remember_env_value(path, key, value):
    """Sets key=value in .env (adds the line, or replaces an existing one). Keeps everything else as it is."""
    lines = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    lines = [line for line in lines if not line.startswith(key + "=")]
    if value:
        lines.append(f"{key}={value}")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def command_line(target, skip_tests, dns):
    """The build_dist.py invocation for the answers."""
    argv = [sys.executable, os.path.join(ROOT, "build_dist.py"), "--target", target]
    if skip_tests:
        argv.append("--skip-tests")
    if dns:
        argv += ["--dns", dns]
    return argv


def install_hint(target):
    hints = []
    if target in ("windows", "all"):
        hints.append("Windows: run the .exe as Administrator (wizard), or `alfred-setup-<version>-windows-x64.exe /S` - an upgrade keeps .env and data.")
    if target in ("linux", "all"):
        hints.append("Linux:   scp the .run to the server, then `sudo sh alfred-setup-<version>-linux-x64.run [--ui-port 3017]`.")
    return "\n".join(hints)


def ask(prompt, default=None):
    answer = input(prompt).strip()
    return answer or default


def main(argv):
    parser = argparse.ArgumentParser(description="Build the Alfred installers, asking what to build.")
    parser.add_argument("--target", choices=("windows", "linux", "both", "all"))
    parser.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--dns", help="DNS server for the build containers (default: remembered ALFRED_BUILD_DNS)")
    parser.add_argument("--yes", action="store_true", help="ask nothing: defaults are both targets, tests on")
    args = parser.parse_args(argv)

    version = subprocess.run(["git", "describe", "--tags", "--always", "--dirty"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    print(f"Build Alfred installers from the current code ({version or 'unknown version'})")
    if version and "-" in version and not version[0].isdigit():
        print("  (an untagged build: named by commit hash, never offered as an update - python release.py cuts a release)")

    target = TARGETS.get(args.target or "")
    if target is None:
        target = "all" if args.yes else None
    while target is None:
        answer = ask("Target: [1] Windows  [2] Linux  [3] both  -> ", "3").lower()
        target = TARGETS.get(answer)
        if target is None:
            print("  type 1, 2 or 3")

    skip_tests = args.skip_tests
    if not skip_tests and not args.yes:
        skip_tests = ask("Run the test suites first (adds ~10 min)? [Y/n] ", "y").lower() in ("n", "no")

    dns = args.dns or os.environ.get("ALFRED_BUILD_DNS") or read_env_value(ENV_FILE, "ALFRED_BUILD_DNS")
    if not args.yes and args.dns is None:
        answer = ask(f"DNS for the build containers [{dns or 'system'}] (needed where Docker's own DNS fails; e.g. 8.8.8.8): ", dns)
        dns = "" if answer in (None, "system", "-") else answer
        if dns != read_env_value(ENV_FILE, "ALFRED_BUILD_DNS"):
            remember_env_value(ENV_FILE, "ALFRED_BUILD_DNS", dns)

    argv_build = command_line(target, skip_tests, dns)
    print("-> " + " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(argv_build)))
    print()
    result = subprocess.run(argv_build, cwd=ROOT)
    if result.returncode != 0:
        return result.returncode
    print()
    print(install_hint(target))
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(errors="replace")
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(1)
