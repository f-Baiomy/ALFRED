#!/bin/bash
#
# setup.sh - installs Docker and Python 3 on Linux/macOS if either is missing,
# so "sudo python3 start.py" has what it needs. Safe to re-run - already-installed
# prerequisites are skipped.
#
# Uses each distro's own package manager (apt/dnf/yum, or Homebrew on macOS) -
# deliberately not a piped install script - so nothing here downloads and
# executes a remote script.
#
# Run with sudo:
#   sudo ./setup.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ] && [ "$(uname)" != "Darwin" ]; then
    echo "This needs root to install packages. Re-run as: sudo ./setup.sh"
    exit 1
fi

echo "=== Alfred setup: checking prerequisites ==="

PKG_FAMILY=""
if [ -f /etc/debian_version ]; then
    PKG_FAMILY="debian"
elif [ -f /etc/redhat-release ]; then
    PKG_FAMILY="redhat"
elif [ "$(uname)" = "Darwin" ]; then
    PKG_FAMILY="macos"
fi

install_debian() {
    apt-get update
    apt-get install -y "$@"
}

install_redhat() {
    if command -v dnf >/dev/null 2>&1; then
        dnf install -y "$@"
    else
        yum install -y "$@"
    fi
}

# docker-compose.yml, start.sh, start.ps1, and restart.py all invoke `docker compose` (the v2 CLI
# plugin, no dash) - never the older standalone `docker-compose` binary. That v2 plugin only ships
# from Docker's own apt/dnf repo, not the distros' default archives (Ubuntu/Debian/RHEL universe
# only carries the legacy standalone package under a different name) - installing just "docker.io"/
# "docker" leaves `docker compose ...` unrecognized, which makes the base `docker` CLI try to parse
# "compose"'s own arguments as its own flags (confirmed live: "unknown shorthand flag: 'd' in -d").
# So Docker itself has to come from Docker's official repo, not the distro's - this adds that repo's
# signing key via `curl` (a plain file download for signature verification, not a piped install
# script) and its apt/dnf source list entry, exactly per Docker's own documented install steps.
docker_compose_ready() {
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker_debian_official() {
    . /etc/os-release
    # Remove any distro-packaged Docker (e.g. "docker.io" from an earlier run of this script,
    # before this official-repo approach existed) - it conflicts with docker-ce on shared files
    # (dockerd, the docker systemd unit) rather than upgrading cleanly alongside it.
    apt-get remove -y docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null || true
    apt-get update
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_redhat_official() {
    . /etc/os-release
    local repo_os="centos"
    [ "$ID" = "fedora" ] && repo_os="fedora"
    if command -v dnf >/dev/null 2>&1; then
        dnf -y install dnf-plugins-core
        dnf config-manager --add-repo "https://download.docker.com/linux/${repo_os}/docker-ce.repo"
        dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
        yum install -y yum-utils
        yum-config-manager --add-repo "https://download.docker.com/linux/${repo_os}/docker-ce.repo"
        yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
}

if docker_compose_ready; then
    echo "[ok] Docker + docker compose already installed"
else
    echo "Docker / docker compose not found (or incomplete) - installing Docker CE from Docker's official repo..."
    case "$PKG_FAMILY" in
        debian) install_docker_debian_official ;;
        redhat) install_docker_redhat_official ;;
        macos)
            if command -v brew >/dev/null 2>&1; then
                brew install --cask docker
                echo "  Open Docker.app once from Applications to finish setup and start the daemon - it bundles docker compose."
            else
                echo "Homebrew not found - install Docker Desktop manually: https://www.docker.com/products/docker-desktop"
                exit 1
            fi
            ;;
        *)
            echo "Unrecognized distro - install Docker manually: https://docs.docker.com/engine/install/"
            exit 1
            ;;
    esac
    if [ "$PKG_FAMILY" != "macos" ]; then
        systemctl enable --now docker 2>/dev/null || service docker start || true
    fi
    if docker_compose_ready; then
        echo "[installed] Docker + docker compose"
    else
        echo "  [warn] Docker installed but 'docker compose version' still fails - check it manually."
    fi
fi

if command -v python3 >/dev/null 2>&1; then
    echo "[ok] python3 already installed"
else
    echo "python3 not found - installing..."
    case "$PKG_FAMILY" in
        debian) install_debian python3 ;;
        redhat) install_redhat python3 ;;
        macos)
            if command -v brew >/dev/null 2>&1; then
                brew install python3
            else
                echo "Homebrew not found - install Python 3 manually: https://www.python.org/downloads/"
                exit 1
            fi
            ;;
        *)
            echo "Unrecognized distro - install Python 3 manually."
            exit 1
            ;;
    esac
    echo "[installed] python3"
fi

echo ""
echo "=== Done. Next: run 'sudo python3 start.py'. ==="
