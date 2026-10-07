#!/bin/sh
# Alfred installer for Linux x64 (specs/012-server-program, contracts/installer-and-build.md).
# This file is a POSIX sh script followed by a tar.gz payload; it needs only sh, tar, gzip and awk on the server.
#
#   sudo ./alfred-setup-<version>-linux-x64.run [--dir /opt/alfred] [--user root] [--ui-port 3000]
#                                              [--import-docker <folder> | --no-import]
#                                              [--unattended] [--no-start] [--allow-downgrade]
#
# Exit codes: 0 ok, 1 failed (an existing install is left as it was), 2 usage, 5 not root, 6 refused downgrade.
set -eu

DIR=/opt/alfred
SERVICE_USER=root
UI_PORT=
IMPORT_FROM=
NO_IMPORT=0
UNATTENDED=0
NO_START=0
ALLOW_DOWNGRADE=0

say() { printf '%s\n' "$*"; }
ok() { printf '  \342\234\223 %s\n' "$*"; }
fail() { printf '  \342\234\227 %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --user) SERVICE_USER=$2; shift 2 ;;
    --ui-port) UI_PORT=$2; shift 2 ;;
    --import-docker) IMPORT_FROM=$2; shift 2 ;;
    --no-import) NO_IMPORT=1; shift ;;
    --unattended) UNATTENDED=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    -h|--help) usage ;;
    *) say "Unknown option: $1"; usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Run as root (sudo $0) - Alfred installs a system service." 5

ask() {  # ask "Question" default -> answer on stdout
  if [ "$UNATTENDED" -eq 1 ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  printf '  %s [%s]: ' "$1" "$2" >&2
  read -r answer || answer=
  printf '%s' "${answer:-$2}"
}

say "Alfred setup"
DIR=$(ask "Install folder" "$DIR")
SERVICE_USER=$(ask "Run as user" "$SERVICE_USER")
id "$SERVICE_USER" >/dev/null 2>&1 || fail "No such user: $SERVICE_USER" 2

# ---- extract to a temp folder first: an interrupted install never touches the existing one -------------------------
TMP=$(mktemp -d /tmp/alfred-setup.XXXXXX)
ROLLBACK=0
UPGRADE=0
cleanup() {
  status=$?
  if [ "$ROLLBACK" -eq 1 ] && [ "$status" -ne 0 ]; then
    for d in runtime app service; do
      rm -rf "${DIR:?}/$d"
      if [ -d "$DIR/$d.previous" ]; then mv "$DIR/$d.previous" "$DIR/$d"; fi
    done
    if [ -f "$DIR/settings.properties.previous" ]; then
      mv "$DIR/settings.properties.previous" "$DIR/settings.properties"
    elif [ "$UPGRADE" -eq 0 ]; then
      rm -f "$DIR/settings.properties" "$DIR/alfred"
    fi
    if [ "$UPGRADE" -eq 1 ]; then
      say "  Setup failed - the previous install was put back."
    else
      say "  Setup failed - nothing was left installed (recorded data, if any, is untouched)."
    fi
    if [ "${WAS_RUNNING:-0}" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then systemctl start alfred || true; fi
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT INT TERM

LINE=$(awk '/^__ARCHIVE_BELOW__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$LINE" "$0" | tar -xzf - -C "$TMP" || fail "The installer file is damaged (could not unpack it)."
NEW_VERSION=$(cat "$TMP/alfred/app/VERSION")
ok "unpacked Alfred $NEW_VERSION"

# ---- upgrade or fresh install ---------------------------------------------------------------------------------------
UPGRADE=0
if [ -f "$DIR/app/VERSION" ]; then
  OLD_VERSION=$(cat "$DIR/app/VERSION")
  UPGRADE=1
  if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
    NEWEST=$(printf '%s\n%s\n' "$OLD_VERSION" "$NEW_VERSION" | sort -V | tail -n 1)
    if [ "$NEWEST" = "$OLD_VERSION" ] && [ "$ALLOW_DOWNGRADE" -ne 1 ]; then
      fail "Installed version $OLD_VERSION is newer than $NEW_VERSION. Use --allow-downgrade to install it anyway." 6
    fi
    say "  Upgrading $OLD_VERSION -> $NEW_VERSION (settings and recorded data are kept)"
  else
    say "  Alfred $NEW_VERSION is already installed - reinstalling the program files (settings and data are kept)"
  fi
fi

WAS_RUNNING=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet alfred 2>/dev/null; then
  WAS_RUNNING=1
  systemctl stop alfred
  ok "stopped the running service"
elif [ -x "$DIR/alfred" ] && [ "$UPGRADE" -eq 1 ]; then
  "$DIR/alfred" stop >/dev/null 2>&1 || true
fi

mkdir -p "$DIR"
ROLLBACK=1
for d in runtime app service; do
  rm -rf "${DIR:?}/$d.previous"
  [ -d "$DIR/$d" ] && mv "$DIR/$d" "$DIR/$d.previous"
  mv "$TMP/alfred/$d" "$DIR/$d"
done
[ -f "$DIR/settings.properties" ] && cp -p "$DIR/settings.properties" "$DIR/settings.properties.previous"
cp "$TMP/alfred/settings.properties" "$DIR/settings.properties"
cp "$TMP/alfred/alfred" "$DIR/alfred"
chmod 755 "$DIR/alfred"
ok "program files in $DIR"

# ---- settings: .env is created once and never overwritten ---------------------------------------------------------
# Output is kept and shown on failure: with >/dev/null a failed .env said only "Could not create", never why.
if [ ! -f "$DIR/.env" ]; then
  if INIT_OUT=$("$DIR/alfred" _init-env 2>&1); then
    ok ".env created with defaults"
  else
    printf '%s\n' "$INIT_OUT" >&2
    fail "Could not create $DIR/.env (see above)"
  fi
fi
if [ -n "$UI_PORT" ]; then
  # A refused port (in use, not a number) used to be skipped without a word.
  if PORT_OUT=$("$DIR/alfred" config set ALFRED_UI_PORT "$UI_PORT" 2>&1); then
    ok "UI port $UI_PORT"
  else
    printf '%s\n' "$PORT_OUT" >&2
    say "  UI port $UI_PORT was refused (see above) - Alfred keeps its current port. Change it later: sudo alfred config set ALFRED_UI_PORT <port>"
  fi
fi

# ---- importing an existing Docker install (FR-002d) ---------------------------------------------------------------
if [ "$NO_IMPORT" -eq 0 ]; then
  PYTHON="$DIR/runtime/python/bin/python3"
  if [ -z "$IMPORT_FROM" ]; then
    IMPORT_FROM=$("$PYTHON" "$DIR/app/launcher/docker_import.py" --detect 2>/dev/null || true)
    if [ -n "$IMPORT_FROM" ]; then
      ANSWER=$(ask "Import settings and data from the Docker install in $IMPORT_FROM? (y/n)" "y")
      [ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ] || IMPORT_FROM=
      [ "$UNATTENDED" -eq 1 ] && IMPORT_FROM=  # unattended installs import only when --import-docker is given
    fi
  fi
  if [ -n "$IMPORT_FROM" ]; then
    "$PYTHON" "$DIR/app/launcher/docker_import.py" --home "$DIR" --from "$IMPORT_FROM" || \
      say "  Docker import failed (see above) - continuing with an empty install; the Docker install is unchanged."
  fi
fi

# ---- ownership: the service account owns everything, secrets are owner-only ---------------------------------------
mkdir -p "$DIR/data"
if [ "$SERVICE_USER" != root ]; then chown -R "$SERVICE_USER": "$DIR"; fi
chmod 700 "$DIR/data"
chmod 600 "$DIR/.env"
ok "owned by $SERVICE_USER"

ROLLBACK=0
for d in runtime app service; do rm -rf "${DIR:?}/$d.previous"; done
rm -f "$DIR/settings.properties.previous"

# ---- the upgrade in the settings history (contracts/installer-and-build.md) -------------------------------------
if [ "$UPGRADE" -eq 1 ] && [ "${OLD_VERSION:-}" != "$NEW_VERSION" ]; then
  if UPGRADE_OUT=$("$DIR/alfred" _record-upgrade "$OLD_VERSION" "$NEW_VERSION" 2>&1); then
    ok "upgrade recorded in the settings history"
  else
    printf '%s\n' "$UPGRADE_OUT" >&2
    say "  (the upgrade could not be recorded in the settings history - Alfred works regardless)"
  fi
fi

# ---- service ------------------------------------------------------------------------------------------------------
ln -sf "$DIR/alfred" /usr/local/bin/alfred
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  CAPS=
  [ "$SERVICE_USER" != root ] && CAPS="AmbientCapabilities=CAP_NET_BIND_SERVICE"
  sed -e "s|@HOME@|$DIR|g" -e "s|@USER@|$SERVICE_USER|g" -e "s|@CAPS@|$CAPS|g" "$DIR/service/alfred.service" \
    > /etc/systemd/system/alfred.service
  systemctl daemon-reload
  systemctl enable alfred >/dev/null 2>&1
  ok "service \"alfred\" installed (starts at boot)"
  if [ "$NO_START" -eq 0 ]; then systemctl restart alfred; fi
else
  say "  No systemd here: Alfred will not start at boot. Start it with: alfred start"
  if [ "$NO_START" -eq 0 ]; then "$DIR/alfred" start >/dev/null 2>&1 & fi
fi

if [ "$NO_START" -eq 0 ]; then
  # The launcher's own wait: THIS install's backend must answer (another Alfred on the port does not count), and on
  # failure it says why. "started" only when it did - this used to print "started" right after saying it had not.
  if HEALTH_OUT=$("$DIR/alfred" _wait-health 2>&1); then
    ok "started. $HEALTH_OUT"
  else
    printf '%s\n' "$HEALTH_OUT" >&2
    say "  Alfred did not answer within 60 s - see: sudo alfred logs supervisor"
  fi
fi
say "  Next: 'alfred jvms' lists Java apps, 'alfred attach <pid>' logs one. 'alfred status' shows what runs."
exit 0
