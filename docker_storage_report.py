#!/usr/bin/env python3
"""
docker_storage_report.py - cross-platform (Windows/Linux/WSL) Docker + host storage
diagnostic and safe-cleanup tool. Not specific to Alfred's own stack; it inspects
whatever Docker Desktop / Docker Engine installation is present on the machine.

Two phases, always in this order:

  1. DIAGNOSTIC (always runs, read-only, no flags needed): C: / root drive usage,
     Docker Desktop / WSL2 storage, ext4.vhdx size (Windows only),
     image/container/volume/build-cache breakdown via `docker system df`,
     per-container log sizes, dangling images, stopped containers, dangling
     volumes. Nothing is modified in this phase.

  2. SAFE CLEANUP (asked about interactively right after the report, unless
     --no-clean or --yes is passed): removes stopped containers, dangling
     (untagged) images, unused networks, unused build cache, and truncates
     oversized container logs. Never touches: running containers, images used by
     any container (running or stopped), or any volume - since volumes may hold
     application/database data. Re-runs the diagnostic afterward and prints a
     before/after comparison.

VHDX compaction (Windows/WSL2 only) is never done as part of cleanup; it requires
the separate, explicit --compact-vhdx flag, since it needs to stop Docker Desktop.

Usage:
    python3 docker_storage_report.py                       # report, then asks whether to clean
    python3 docker_storage_report.py --yes                   # report, then cleans immediately, no prompt
    python3 docker_storage_report.py --no-clean               # report only, never asks about cleanup
    python3 docker_storage_report.py --log-threshold-mb 20     # only truncate logs bigger than this (default 10)
    python3 docker_storage_report.py --compact-vhdx            # also offer to compact WSL2's ext4.vhdx (Windows)
"""

import argparse
import glob
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile

IS_WINDOWS = platform.system() == "Windows"
IS_LINUX = platform.system() == "Linux"
IS_WSL = IS_LINUX and "microsoft" in platform.release().lower()


# --------------------------------------------------------------------------- #
# generic helpers
# --------------------------------------------------------------------------- #

def run(cmd, timeout=30):
    """Runs cmd, returns (returncode, stdout, stderr) as text. Never raises."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return 127, "", f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{' '.join(cmd)}: timed out"


def run_ok(cmd, timeout=30):
    rc, out, err = run(cmd, timeout)
    return rc == 0, out, err


def human(num_bytes):
    if num_bytes is None:
        return "unknown"
    n = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.2f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


def parse_docker_size(size_str):
    """Parses sizes like docker prints them, e.g. '1.234GB', '512MB', '0B'."""
    if not size_str:
        return 0
    size_str = size_str.strip()
    units = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    for suffix in sorted(units, key=len, reverse=True):
        if size_str.upper().endswith(suffix):
            number = size_str[: -len(suffix)].strip()
            try:
                return float(number) * units[suffix]
            except ValueError:
                return 0
    try:
        return float(size_str)
    except ValueError:
        return 0


def docker_available():
    ok, _, _ = run_ok(["docker", "version", "--format", "{{.Server.Version}}"])
    return ok


def json_lines(output):
    """docker ... --format '{{json .}}' prints one JSON object per line."""
    rows = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


# --------------------------------------------------------------------------- #
# C: / root drive usage
# --------------------------------------------------------------------------- #

def get_drive_usage():
    path = "C:\\" if IS_WINDOWS else "/"
    total, used, free = shutil.disk_usage(path)
    return {"path": path, "total": total, "used": used, "free": free}


# --------------------------------------------------------------------------- #
# WSL2 / ext4.vhdx (Windows only)
# --------------------------------------------------------------------------- #

def get_wsl_vhdx_info():
    if not IS_WINDOWS:
        return None

    info = {"distros": None, "vhdx_files": []}

    ok, out, _ = run_ok(["wsl", "--list", "--verbose"], timeout=15)
    if ok:
        info["distros"] = out.strip()

    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        search_root = os.path.join(localappdata, "Docker", "wsl")
        for path in glob.glob(os.path.join(search_root, "**", "*.vhdx"), recursive=True):
            try:
                size = os.path.getsize(path)
            except OSError:
                size = None
            info["vhdx_files"].append({"path": path, "size": size})

    return info


# --------------------------------------------------------------------------- #
# docker system df - images / containers / volumes / build cache summary
# --------------------------------------------------------------------------- #

def get_system_df():
    ok, out, err = run_ok(["docker", "system", "df", "--format", "{{json .}}"])
    if ok:
        rows = json_lines(out)
        if rows:
            return rows

    # Fallback for older Docker CLIs that don't support --format on `system df`.
    ok, out, err = run_ok(["docker", "system", "df"])
    rows = []
    if ok:
        lines = out.strip().splitlines()
        for line in lines[1:]:
            parts = line.split()
            if len(parts) >= 5:
                rows.append(
                    {
                        "Type": parts[0],
                        "TotalCount": parts[1],
                        "Active": parts[2],
                        "Size": parts[3],
                        "Reclaimable": " ".join(parts[4:]),
                    }
                )
    return rows


# --------------------------------------------------------------------------- #
# images
# --------------------------------------------------------------------------- #

def get_images():
    ok, out, _ = run_ok(["docker", "images", "--format", "{{json .}}"])
    return json_lines(out) if ok else []


def get_dangling_image_ids():
    ok, out, _ = run_ok(["docker", "images", "-f", "dangling=true", "-q"])
    return [line.strip() for line in out.splitlines() if line.strip()] if ok else []


def get_images_used_by_containers():
    """Images referenced by ANY container, running or stopped - these are never
    safe to remove automatically, since stopping a container doesn't mean its
    image is unused (the container can still be restarted)."""
    ok, out, _ = run_ok(["docker", "ps", "-a", "--format", "{{.Image}}"])
    return set(line.strip() for line in out.splitlines() if line.strip()) if ok else set()


# --------------------------------------------------------------------------- #
# containers
# --------------------------------------------------------------------------- #

def get_containers():
    ok, out, _ = run_ok(["docker", "ps", "-a", "-s", "--format", "{{json .}}"])
    return json_lines(out) if ok else []


def get_stopped_container_ids():
    ok, out, _ = run_ok(["docker", "ps", "-a", "-f", "status=exited", "-q"])
    return [line.strip() for line in out.splitlines() if line.strip()] if ok else []


# --------------------------------------------------------------------------- #
# container logs (json-file driver) - the tricky cross-platform part.
#
# On Linux/WSL the log files under /var/lib/docker/containers/*/*-json.log are
# directly readable from the host. On native Windows with Docker Desktop's
# WSL2 backend, that path lives inside the internal "docker-desktop" WSL
# distro, not on the Windows filesystem - so we shell out to `wsl.exe -d
# docker-desktop` to stat/truncate it there instead. Either way this stays
# read-only in the diagnostic phase.
# --------------------------------------------------------------------------- #

def _container_log_path(container_id):
    ok, out, _ = run_ok(["docker", "inspect", "--format", "{{.LogPath}}", container_id])
    return out.strip() if ok else None


def _log_size_native(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def _log_size_via_wsl(path):
    ok, out, _ = run_ok(["wsl", "-d", "docker-desktop", "--", "stat", "-c%s", path])
    if ok and out.strip().isdigit():
        return int(out.strip())
    return None


def get_container_log_info(container_id, name):
    path = _container_log_path(container_id)
    if not path:
        return {"name": name, "id": container_id, "path": None, "size": None}

    if IS_WINDOWS:
        size = _log_size_via_wsl(path)
    else:
        size = _log_size_native(path)

    return {"name": name, "id": container_id, "path": path, "size": size}


def truncate_container_log(log_info):
    path = log_info["path"]
    if not path:
        return False, "no log path"

    if IS_WINDOWS:
        ok, _, err = run_ok(["wsl", "-d", "docker-desktop", "--", "sh", "-c", f": > '{path}'"])
        return ok, err
    else:
        try:
            with open(path, "w", encoding="utf-8"):
                pass
            return True, ""
        except OSError as exc:
            return False, str(exc)


# --------------------------------------------------------------------------- #
# volumes
# --------------------------------------------------------------------------- #

def get_volumes():
    ok, out, _ = run_ok(["docker", "volume", "ls", "--format", "{{json .}}"])
    return json_lines(out) if ok else []


def get_dangling_volume_names():
    ok, out, _ = run_ok(["docker", "volume", "ls", "-f", "dangling=true", "-q"])
    return [line.strip() for line in out.splitlines() if line.strip()] if ok else []


# --------------------------------------------------------------------------- #
# diagnostic snapshot
# --------------------------------------------------------------------------- #

def collect_snapshot(log_threshold_mb):
    snapshot = {"docker_available": docker_available()}
    snapshot["drive"] = get_drive_usage()

    if IS_WINDOWS:
        snapshot["wsl"] = get_wsl_vhdx_info()
    else:
        snapshot["wsl"] = None

    if not snapshot["docker_available"]:
        return snapshot

    snapshot["df"] = get_system_df()
    snapshot["images"] = get_images()
    snapshot["dangling_image_ids"] = get_dangling_image_ids()
    snapshot["images_in_use"] = get_images_used_by_containers()
    snapshot["containers"] = get_containers()
    snapshot["stopped_container_ids"] = get_stopped_container_ids()
    snapshot["volumes"] = get_volumes()
    snapshot["dangling_volume_names"] = get_dangling_volume_names()

    threshold_bytes = log_threshold_mb * 1024 * 1024
    logs = []
    for c in snapshot["containers"]:
        cid = c.get("ID")
        name = c.get("Names", cid)
        if not cid:
            continue
        info = get_container_log_info(cid, name)
        logs.append(info)
    snapshot["container_logs"] = logs
    snapshot["large_logs"] = [
        entry for entry in logs if entry["size"] and entry["size"] > threshold_bytes
    ]

    return snapshot


# --------------------------------------------------------------------------- #
# report rendering
# --------------------------------------------------------------------------- #

def df_row(snapshot, type_name):
    for row in snapshot.get("df", []):
        if row.get("Type", "").lower() == type_name.lower():
            return row
    return None


def print_report(snapshot, title="DOCKER STORAGE REPORT"):
    print()
    print(title)
    print()

    drive = snapshot["drive"]
    print(f"{drive['path']} Drive:")
    print(f"  Used:  {human(drive['used'])}")
    print(f"  Free:  {human(drive['free'])}")
    print()

    if not snapshot["docker_available"]:
        print("Docker: not available (docker CLI not found or daemon not running).")
        return

    print("Docker:")
    images_row = df_row(snapshot, "Images")
    containers_row = df_row(snapshot, "Containers")
    volumes_row = df_row(snapshot, "Local Volumes") or df_row(snapshot, "Volumes")
    cache_row = df_row(snapshot, "Build Cache")

    def fmt_row(row):
        if not row:
            return "unknown"
        reclaimable_raw = row.get("Reclaimable", "?")
        reclaimable_bytes = parse_docker_size(reclaimable_raw.split()[0]) if reclaimable_raw != "?" else None
        if reclaimable_bytes is not None and reclaimable_bytes < 0:
            # Docker's own display quirk for shared/duplicated image layers.
            reclaimable_display = "~0B (Docker reports a negative value here due to shared image layers)"
        else:
            reclaimable_display = reclaimable_raw
        return f"{row.get('Size', '?')} total, {reclaimable_display} reclaimable"

    print(f"  Images:        {fmt_row(images_row)}  ({len(snapshot['images'])} images, "
          f"{len(snapshot['dangling_image_ids'])} dangling)")
    print(f"  Containers:    {fmt_row(containers_row)}  ({len(snapshot['containers'])} total, "
          f"{len(snapshot['stopped_container_ids'])} stopped)")
    print(f"  Volumes:       {fmt_row(volumes_row)}  ({len(snapshot['volumes'])} total, "
          f"{len(snapshot['dangling_volume_names'])} unused)")
    print(f"  Build Cache:   {fmt_row(cache_row)}")

    total_log_bytes = sum(e["size"] or 0 for e in snapshot["container_logs"])
    print(f"  Container Logs: {human(total_log_bytes)} across {len(snapshot['container_logs'])} containers")
    if snapshot["large_logs"]:
        print(f"    -> {len(snapshot['large_logs'])} container(s) over threshold:")
        for entry in sorted(snapshot["large_logs"], key=lambda e: e["size"] or 0, reverse=True):
            print(f"       {entry['name']}: {human(entry['size'])}")

    wsl = snapshot.get("wsl")
    if wsl is not None:
        print("  WSL / ext4.vhdx:")
        if wsl["vhdx_files"]:
            for vf in wsl["vhdx_files"]:
                label = os.path.relpath(vf["path"], os.environ.get("LOCALAPPDATA", ""))
                print(f"    {label}: {human(vf['size'])} (file size on disk; may be larger than actual data used)")
        else:
            print("    no ext4.vhdx found under %LOCALAPPDATA%\\Docker\\wsl")

    # Docker's own `system df` occasionally reports a negative reclaimable size for
    # Images (a known display quirk caused by shared/duplicated layers) - clamp each
    # component to >= 0 so it can't make the total look negative.
    reclaimable_bytes = 0
    for row in (images_row, containers_row, cache_row):
        if row and row.get("Reclaimable"):
            reclaimable_bytes += max(0, parse_docker_size(row["Reclaimable"].split()[0]))
    reclaimable_bytes += sum(e["size"] or 0 for e in snapshot["large_logs"])

    print()
    print(f"TOTAL POTENTIALLY RECLAIMABLE: ~{human(reclaimable_bytes)}")
    print("(unused build cache + dangling images + stopped-container overhead + oversized logs;")
    print(" excludes volumes, which are never auto-reclaimed since they may hold app/DB data)")


def biggest_sources(snapshot):
    print()
    print("Biggest sources of reclaimable space:")
    candidates = []

    cache_row = df_row(snapshot, "Build Cache")
    if cache_row:
        candidates.append(("Build cache", max(0, parse_docker_size((cache_row.get("Reclaimable") or "0B").split()[0]))))

    images_row = df_row(snapshot, "Images")
    if images_row:
        candidates.append(("Unused images", max(0, parse_docker_size((images_row.get("Reclaimable") or "0B").split()[0]))))

    log_bytes = sum(e["size"] or 0 for e in snapshot["large_logs"])
    candidates.append(("Oversized container logs", log_bytes))

    wsl = snapshot.get("wsl")
    if wsl and wsl["vhdx_files"]:
        vhdx_total = sum(v["size"] or 0 for v in wsl["vhdx_files"])
        candidates.append(("ext4.vhdx file size (host-visible, not all reclaimable without compaction)", vhdx_total))

    candidates.sort(key=lambda c: c[1], reverse=True)
    for label, size in candidates:
        if size:
            print(f"  - {label}: {human(size)}")


# --------------------------------------------------------------------------- #
# safe cleanup
# --------------------------------------------------------------------------- #

def confirm(prompt):
    try:
        answer = input(f"{prompt} [y/N]: ").strip().lower()
    except EOFError:
        return False
    return answer in ("y", "yes")


def safe_cleanup(snapshot, auto_yes, log_threshold_mb):
    results = {"containers": None, "images": None, "networks": None, "cache": None, "logs": []}

    print()
    print("=== Safe cleanup: stopped containers ===")
    print("$ docker container prune -f")
    ok, out, err = run_ok(["docker", "container", "prune", "-f"])
    print(out.strip() or err.strip())
    results["containers"] = out

    print()
    print("=== Safe cleanup: unused networks ===")
    print("$ docker network prune -f")
    ok, out, err = run_ok(["docker", "network", "prune", "-f"])
    print(out.strip() or err.strip())
    results["networks"] = out

    print()
    print("=== Safe cleanup: dangling (untagged) images ===")
    print("$ docker image prune -f")
    ok, out, err = run_ok(["docker", "image", "prune", "-f"])
    print(out.strip() or err.strip())
    results["images"] = out

    print()
    print("=== Safe cleanup: unused build cache ===")
    print("$ docker builder prune -f")
    ok, out, err = run_ok(["docker", "builder", "prune", "-f"])
    print(out.strip() or err.strip())
    results["cache"] = out

    print()
    print(f"=== Safe cleanup: truncating container logs over {log_threshold_mb} MB ===")
    for entry in snapshot["large_logs"]:
        print(f"  truncating log for {entry['name']} ({human(entry['size'])})...")
        ok, err = truncate_container_log(entry)
        if ok:
            print(f"    done.")
        else:
            print(f"    skipped: {err}")
        results["logs"].append({"name": entry["name"], "before": entry["size"], "ok": ok})

    if snapshot["dangling_volume_names"]:
        print()
        print(f"NOTE: {len(snapshot['dangling_volume_names'])} unused volume(s) found but left untouched")
        print("      (volumes may hold application/database data - remove manually if you're sure):")
        for name in snapshot["dangling_volume_names"]:
            print(f"        docker volume rm {name}")

    return results


# --------------------------------------------------------------------------- #
# vhdx compaction (Windows only, explicit opt-in)
# --------------------------------------------------------------------------- #

def compact_vhdx(vhdx_files):
    if not IS_WINDOWS:
        print("VHDX compaction only applies to Windows/WSL2.")
        return

    if not vhdx_files:
        print("No ext4.vhdx files found to compact.")
        return

    print()
    print("VHDX compaction shrinks the *file on disk* to match actual data used.")
    print("This requires shutting down WSL2 (and therefore Docker Desktop) briefly, and")
    print("requires an elevated (Administrator) shell to run 'diskpart'.")
    print()
    for vf in vhdx_files:
        print(f"  {vf['path']} ({human(vf['size'])})")

    if not confirm("Proceed with 'wsl --shutdown' and compact these files now?"):
        print("Skipped VHDX compaction.")
        return

    print("$ wsl --shutdown")
    run_ok(["wsl", "--shutdown"], timeout=30)

    for vf in vhdx_files:
        script = f"select vdisk file=\"{vf['path']}\"\ncompact vdisk\n"
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(script)
            script_path = f.name
        print(f"$ diskpart /s {script_path}   (compacting {vf['path']})")
        ok, out, err = run_ok(["diskpart", "/s", script_path], timeout=120)
        print(out.strip() or err.strip())
        os.unlink(script_path)

    print("Compaction complete. Restart Docker Desktop to bring WSL2 back up.")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description="Docker + host storage diagnostic and safe cleanup.")
    parser.add_argument("--yes", action="store_true", help="skip the interactive confirmation and clean immediately")
    parser.add_argument("--no-clean", action="store_true",
                         help="diagnostic only - don't ask about cleanup afterward (e.g. for scripts/CI)")
    parser.add_argument("--log-threshold-mb", type=int, default=10,
                         help="container logs above this size are considered reclaimable (default: 10)")
    parser.add_argument("--compact-vhdx", action="store_true",
                         help="(Windows only) after everything else, offer to compact ext4.vhdx via diskpart")
    args = parser.parse_args()

    print("Collecting diagnostic snapshot (read-only)...")
    before = collect_snapshot(args.log_threshold_mb)
    print_report(before)
    biggest_sources(before)

    if not before["docker_available"]:
        sys.exit(0)

    if args.no_clean:
        if args.compact_vhdx:
            compact_vhdx(before.get("wsl", {}).get("vhdx_files") if before.get("wsl") else [])
        return

    print()
    print('Option: "Clean Safe Docker Data"')
    print("  Will remove: stopped containers, dangling images, unused networks, unused")
    print("  build cache, and truncate (not delete) oversized container logs.")
    print("  Will NOT touch: running containers, images in use, or any volume.")

    if not args.yes and not confirm("Clean safe Docker data now?"):
        print("Cleanup skipped.")
        if args.compact_vhdx:
            compact_vhdx(before.get("wsl", {}).get("vhdx_files") if before.get("wsl") else [])
        return

    safe_cleanup(before, args.yes, args.log_threshold_mb)

    print("\nRe-collecting diagnostic snapshot after cleanup...")
    after = collect_snapshot(args.log_threshold_mb)
    print_report(after, title="POST-CLEANUP DIAGNOSTIC")

    print()
    print("CLEANUP RESULT")
    print()
    print("Before:")
    print(f"  {before['drive']['path']} Free: {human(before['drive']['free'])}")
    print("Cleaned:")
    print(f"  Build Cache / Images / Containers / Networks: see output above")
    print(f"  Logs truncated: {len(before['large_logs'])}")
    print()
    print("After:")
    print(f"  {after['drive']['path']} Free: {human(after['drive']['free'])}")
    recovered = after["drive"]["free"] - before["drive"]["free"]
    print()
    print(f"Recovered (host free space delta): {human(recovered)}")

    wsl = after.get("wsl")
    if wsl and wsl["vhdx_files"]:
        print()
        print("NOTE: ext4.vhdx does not automatically shrink when Docker data inside it is")
        print("freed - the virtual disk file can stay large even though Docker's usage")
        print("dropped. Run with --compact-vhdx to reclaim that space back to Windows")
        print("(requires an elevated shell and briefly stops WSL2/Docker Desktop).")

    if args.compact_vhdx:
        compact_vhdx(wsl.get("vhdx_files") if wsl else [])


if __name__ == "__main__":
    main()
