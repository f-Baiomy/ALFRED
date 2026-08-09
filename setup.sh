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

if command -v docker >/dev/null 2>&1; then
    echo "[ok] Docker already installed"
else
    echo "Docker not found - installing..."
    case "$PKG_FAMILY" in
        debian)
            install_debian docker.io docker-compose-plugin
            systemctl enable --now docker 2>/dev/null || service docker start || true
            ;;
        redhat)
            install_redhat docker docker-compose-plugin
            systemctl enable --now docker 2>/dev/null || service docker start || true
            ;;
        macos)
            if command -v brew >/dev/null 2>&1; then
                brew install --cask docker
                echo "  Open Docker.app once from Applications to finish setup and start the daemon."
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
    echo "[installed] Docker"
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
