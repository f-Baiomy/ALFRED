#!/bin/sh
# install.sh - installs (or upgrades) Alfred on a Linux machine that has never seen it, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh -s -- --dir /opt/alfred --ui-port 3017
#
# Reads the latest release's latest.json, downloads the Linux installer it names, checks its sha256 and runs it
# unattended. Arguments after "--" go to the installer (--dir, --user, --ui-port, --import-docker, --no-import).
# ALFRED_RELEASE_URL points at another latest.json (a mirror or a share for a machine without GitHub access).
# Needs only sh, curl or wget, and sha256sum or shasum - the installer brings its own Java, Python and Node.
set -eu

MANIFEST_URL="${ALFRED_RELEASE_URL:-https://github.com/f-Baiomy/ALFRED/releases/latest/download/latest.json}"
TARGET="linux-x64"

say() { printf '>> %s\n' "$*"; }
die() { printf 'alfred install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) ;;
  *) die "only Linux x86_64 has an installer (this is $(uname -s) $(uname -m)). On Windows use install.ps1." ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  AS_ROOT=""
elif command -v sudo >/dev/null 2>&1; then
  AS_ROOT="sudo"
else
  die "run as root (curl ... | sudo sh) - the installer registers a system service"
fi

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "needs curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "needs sha256sum or shasum to check the download"
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

say "reading $MANIFEST_URL"
fetch "$MANIFEST_URL" "$WORK/latest.json" || die "could not read $MANIFEST_URL - is a release published?"

# latest.json: {"version": "...", "assets": {"linux-x64": {"url": "...", "sha256": "...", "size": N}, ...}}
# No jq on a bare machine: flatten it and cut the one object out.
FLAT="$(tr -d ' \t\r\n' < "$WORK/latest.json")"
VERSION="$(printf '%s' "$FLAT" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
ASSET="$(printf '%s' "$FLAT" | grep -o "\"$TARGET\":{[^}]*}" || true)"
URL="$(printf '%s' "$ASSET" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$ASSET" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')"
[ -n "$URL" ] && [ -n "$SHA" ] || die "the release has no $TARGET installer"

FILE="$WORK/alfred-setup-$VERSION-$TARGET.run"
say "downloading Alfred $VERSION"
fetch "$URL" "$FILE" || die "could not download $URL"

ACTUAL="$(sha256_of "$FILE")"
[ "$ACTUAL" = "$SHA" ] || die "checksum mismatch - expected $SHA, got $ACTUAL. Nothing was installed."
say "checksum ok"

say "running the installer"
$AS_ROOT sh "$FILE" --unattended "$@"
