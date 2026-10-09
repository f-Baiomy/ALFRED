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

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "needs curl or wget"
  fi
}

# fetch_release URL FILE: the installer over many connections at once. Some lines shape each connection to ~16 KB/s
# (2026-10-09: 146 MB from GitHub's release CDN took over an hour on one stream); range requests at once add up:
# on that line 128 curls x 512 KB took 136 s (192 x 256 KB 351 s: a process per piece has its own cost). Pieces
# through xargs -P, each curl straight to the redirect target
# (resolved once, again by whichever piece first meets its expiry: GitHub's signed links last minutes), joined in
# order at the end. wget-only machines, and servers without ranges, get the one stream.
CONNECTIONS=128
PIECE_BYTES=$((512 * 1024))
fetch_release() {
  command -v curl >/dev/null 2>&1 && command -v xargs >/dev/null 2>&1 || { fetch "$1" "$2"; return; }
  PARTS="$WORK/parts"; mkdir -p "$PARTS"
  # One range request tells the size (206 + Content-Range) and where the redirects end
  FINAL="$(curl -sSL -r 0-0 -D "$PARTS/head" -o /dev/null -w '%{url_effective}' "$1")" || { fetch "$1" "$2"; return; }
  TOTAL="$(tr -d '\r' < "$PARTS/head" | grep -i '^content-range:' | tail -1 | sed -n 's|.*/\([0-9][0-9]*\)$|\1|p' || true)"
  if [ -z "$TOTAL" ] || [ "$TOTAL" -le $((2 * PIECE_BYTES)) ]; then fetch "$1" "$2"; return; fi
  printf '%s' "$FINAL" > "$PARTS/final"
  printf '%s' "$1" > "$PARTS/release"
  awk -v total="$TOTAL" -v piece="$PIECE_BYTES" 'BEGIN { for (s = 0; s < total; s += piece) print s }' > "$PARTS/list"
  cat > "$PARTS/piece.sh" <<'PIECE'
#!/bin/sh
# piece.sh PARTS START END: bytes START..END into PARTS/START, retried whole, the link renewed on a 4xx.
PARTS="$1"; START="$2"; END="$3"
for delay in 0 2 5 10; do
  [ "$delay" -gt 0 ] && sleep "$delay"
  used="$(cat "$PARTS/final")"
  code="$(curl -sS -r "$START-$END" -o "$PARTS/$START.tmp" -w '%{http_code}' --connect-timeout 30 --max-time 300 "$used" 2>/dev/null || echo 000)"
  if [ "$code" = "206" ] && [ "$(wc -c < "$PARTS/$START.tmp")" -eq $((END - START + 1)) ]; then
    mv "$PARTS/$START.tmp" "$PARTS/$START"; exit 0
  fi
  rm -f "$PARTS/$START.tmp"
  case "$code" in 4??)
    # the signed link expired: ONE piece resolves the release URL again (mkdir is atomic), the others wait for it
    if [ "$(cat "$PARTS/final")" = "$used" ]; then
      if mkdir "$PARTS/renew.lock" 2>/dev/null; then
        if [ "$(cat "$PARTS/final")" = "$used" ]; then
          fresh="$(curl -sSL -r 0-0 -o /dev/null -w '%{url_effective}' "$(cat "$PARTS/release")" 2>/dev/null)" || true
          [ -n "$fresh" ] && printf '%s' "$fresh" > "$PARTS/final.$$" && mv -f "$PARTS/final.$$" "$PARTS/final"
        fi
        rmdir "$PARTS/renew.lock"
      else
        while [ -d "$PARTS/renew.lock" ]; do sleep 1; done
      fi
    fi
    [ "$(cat "$PARTS/final")" != "$used" ] && continue ;;
  esac
done
echo "bytes $START-$END failed ($code)" >> "$PARTS/failed"; exit 1
PIECE
  ( while [ ! -f "$PARTS/done" ]; do
      got="$(ls "$PARTS" 2>/dev/null | grep -c '^[0-9][0-9]*$' || true)"
      printf '\r   %s of %s MB   ' "$((got * PIECE_BYTES / 1048576))" "$((TOTAL / 1048576))"
      sleep 1
    done ) &
  PROGRESS=$!
  awk -v piece="$PIECE_BYTES" -v total="$TOTAL" '{ e = $1 + piece - 1; if (e >= total) e = total - 1; print $1, e }' "$PARTS/list" \
    | xargs -P "$CONNECTIONS" -n 2 sh "$PARTS/piece.sh" "$PARTS" || true
  touch "$PARTS/done"; wait "$PROGRESS" 2>/dev/null || true; printf '\r                          \r'
  [ -f "$PARTS/failed" ] && { head -1 "$PARTS/failed"; return 1; }
  : > "$2"
  while read -r start; do cat "$PARTS/$start" >> "$2" || return 1; done < "$PARTS/list"
  [ "$(wc -c < "$2")" -eq "$TOTAL" ] || { echo "downloaded $(wc -c < "$2") of $TOTAL bytes"; return 1; }
  rm -rf "$PARTS"
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

# The test suite runs the download alone (tests/python/test_install_scripts.py): the URL and the file to write.
if [ -n "${ALFRED_INSTALL_FETCH_ONLY:-}" ]; then
  fetch_release "$ALFRED_INSTALL_FETCH_ONLY" "$ALFRED_INSTALL_FETCH_TO"
  exit $?
fi

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
fetch_release "$URL" "$FILE" || die "could not download $URL"

ACTUAL="$(sha256_of "$FILE")"
[ "$ACTUAL" = "$SHA" ] || die "checksum mismatch - expected $SHA, got $ACTUAL. Nothing was installed."
say "checksum ok"

say "running the installer"
$AS_ROOT sh "$FILE" --unattended "$@"
