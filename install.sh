#!/bin/sh
# install.sh - installs (or upgrades) Alfred on a Linux machine that has never seen it, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.sh | sudo sh -s -- --dir /opt/alfred --ui-port 3017
#
# Reads the latest release's latest.json, checks this machine (an install to upgrade, disk space, the UI and proxy
# ports) BEFORE downloading, downloads the Linux installer it names - or takes it from the download cache
# (/var/cache/alfred, sha256 checked again) -, runs it unattended and shows where Alfred answers. Arguments after "--"
# go to the installer (--dir, --user, --ui-port, --import-docker, --no-import).
# ALFRED_RELEASE_URL points at another latest.json (a mirror or a share for a machine without GitHub access).
# Needs only sh, curl or wget, and sha256sum or shasum - the installer brings its own Java, Python and Node.
#
# Output: a step list that ticks off, in colour, with one live line - plain lines (one per finished step, no redraws)
# when stdout is not a terminal, NO_COLOR is set or TERM=dumb. Unicode symbols in a UTF-8 locale, ASCII otherwise.
# This file stays ASCII: every symbol is written as its UTF-8 bytes in octal.
set -eu

MANIFEST_URL="${ALFRED_RELEASE_URL:-https://github.com/f-Baiomy/ALFRED/releases/latest/download/latest.json}"
TARGET="linux-x64"
CACHE=/var/cache/alfred
LW=17   # the label column

# ---- output --------------------------------------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then LIVE=1; else LIVE=0; fi
case "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) UNI=1 ;;
  *) UNI=0 ;;
esac
[ "$LIVE" = 1 ] || UNI=0
if [ "$UNI" = 1 ]; then
  G_OK=$(printf '\342\234\223'); G_FAIL=$(printf '\342\234\227'); G_BRAND=$(printf '\342\227\206'); DOT=$(printf '\302\267')
  G_FULL=$(printf '\342\224\201'); G_EMPTY=$(printf '\342\224\200'); G_ARROW=$(printf '\342\206\222'); G_RETRY=$(printf '\342\206\273')
  SPIN="$(printf '\342\240\213 \342\240\231 \342\240\271 \342\240\270 \342\240\274 \342\240\264 \342\240\246 \342\240\247 \342\240\207 \342\240\217')"
  B_TL=$(printf '\342\225\255'); B_TR=$(printf '\342\225\256'); B_BL=$(printf '\342\225\260'); B_BR=$(printf '\342\225\257')
  B_H=$(printf '\342\224\200'); B_V=$(printf '\342\224\202')
else
  G_OK='+'; G_FAIL='x'; G_BRAND='<>'; DOT='-'; G_FULL='#'; G_EMPTY='-'; G_ARROW='->'; G_RETRY='~'; SPIN='| / - \'
  B_TL='+'; B_TR='+'; B_BL='+'; B_BR='+'; B_H='-'; B_V='|'
fi
FRAME=0

c() { # c STYLE TEXT - STYLE: dim hi ok red warn teal def
  if [ "$LIVE" = 1 ]; then
    case "$1" in dim) s=2 ;; hi) s='1;97' ;; ok) s=32 ;; red) s='1;31' ;; warn) s='1;33' ;; teal) s=36 ;; *) s=0 ;; esac
    printf '\033[%sm%s\033[0m' "$s" "$2"
  else
    printf '%s' "$2"
  fi
}
cols() { w=$(stty size 2>/dev/null </dev/tty | cut -d' ' -f2) || w=""; [ -n "$w" ] && [ "$w" -gt 0 ] 2>/dev/null && echo "$w" || echo 100; }
pad() { printf "%-${LW}s" "$1"; }

# The window title, and in Windows Terminal (WSL) the taskbar icon: OSC 9;4 - 1 percent, 3 busy, 2 error, 0 off.
progress() { # progress STATE PERCENT TITLE
  [ "$LIVE" = 1 ] || return 0
  [ -n "${3:-}" ] && printf '\033]0;%s\007' "$3"
  [ -n "${WT_SESSION:-}" ] && printf '\033]9;4;%s;%s\007' "$1" "$2"
  return 0
}

STEP=""; STEP_T0=0
run() { # run LABEL DETAIL [PERCENT] - the live line (nothing when plain); PERCENT draws a bar before DETAIL.
  [ "$STEP" = "$1" ] || STEP_T0=$(date +%s)
  STEP="$1"
  [ "$LIVE" = 1 ] || return 0
  FRAME=$((FRAME + 1))
  label=$1; detail=$2; percent=${3:-}
  set -- $SPIN
  n=$(( FRAME % $# + 1 ))
  eval "spin=\${$n}"
  # The line must never wrap - a wrapped line is left behind by the next redraw. The bar shrinks first, then the
  # text is cut (by characters, in a UTF-8 sed) to what is left of the window.
  room=$(( $(cols) - LW - 6 )); drawn=""
  if [ -n "$percent" ]; then
    if [ "$room" -ge $((24 + 1 + ${#detail})) ]; then width=24; elif [ "$room" -ge 50 ]; then width=12; else width=0; fi
    [ "$width" -gt 0 ] && { drawn="$(bar "$percent" "$width") "; room=$((room - width - 1 - 2 * (1 - UNI))); }
  fi
  [ "$room" -gt 250 ] && room=250
  [ "$room" -gt 3 ] || room=3
  detail=$(printf '%s' "$detail" | sed -E "s/^(.{$((room - 3))}).{4,}$/\1.../")
  printf '\r\033[2K  %s %s %s%s' "$(c teal "$spin")" "$(c hi "$(pad "$label")")" "$drawn" "$(c dim "$detail")"
}
seconds() { echo $(( $(date +%s) - STEP_T0 )); }
end() { # end MARK STYLE WORD LABEL DETAIL [HINT...]
  mark=$1; style=$2; word=$3; label=$4; detail=$5; shift 5
  STEP=""
  if [ "$LIVE" = 1 ]; then
    if [ "$word" = "ok  " ]; then name=$(pad "$label"); else name=$(c hi "$(pad "$label")"); fi
    case "$style" in ok) dstyle=dim ;; *) dstyle=$style ;; esac
    printf '\r\033[2K  %s %s %s\n' "$(c "$style" "$mark")" "$name" "$(c "$dstyle" "$detail")"
    for h in "$@"; do printf '      %s\n' "$(c dim "$h")"; done
  else
    printf '  %s %s %s\n' "$word" "$(pad "$label")" "$detail"
    for h in "$@"; do printf '         %s\n' "$h"; done
  fi
}
done_() { end "$G_OK" ok "ok  " "$1" "$2"; }
fail_() { l=$1; d=$2; shift 2; end "$G_FAIL" red "FAIL" "$l" "$d" "$@"; progress 2 100; exit 1; }
warn_() { l=$1; d=$2; shift 2; end "!" warn "WARN" "$l" "$d" "$@"; }
sub() { # sub MARK TEXT - a line under the running step (the installer's own steps)
  if [ "$LIVE" = 1 ]; then
    if [ "$1" = "$G_OK" ]; then m=$(c ok "$1"); elif [ "$1" = "$G_FAIL" ]; then m=$(c red "$1"); else m=$1; fi
    printf '\r\033[2K      %s %s\n' "$m" "$(c dim "$2")"
  else
    printf '         %s\n' "$2"
  fi
}
bar() { # bar PERCENT WIDTH
  n=$(( $1 * $2 / 100 )); i=0; full=""; empty=""
  while [ $i -lt "$2" ]; do if [ $i -lt $n ]; then full="$full$G_FULL"; else empty="$empty$G_EMPTY"; fi; i=$((i + 1)); done
  if [ "$UNI" = 1 ]; then printf '%s%s' "$(c teal "$full")" "$(c dim "$empty")"
  else printf '[%s%s]' "$(c teal "$full")" "$(c dim "$empty")"; fi
}
duration() { s=$1; if [ "$s" -lt 60 ]; then echo "$s s"; else echo "$((s / 60)) min $((s % 60)) s"; fi; }
mb() { echo $(( $1 / 1048576 )); }

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    echo "needs curl or wget" > "$WORK/fetch.error"; return 1
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
  [ "$delay" -gt 0 ] && { sleep "$delay"; echo "$START" >> "$PARTS/retries"; }
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
  # The live line: bar, MB, speed and time left from finished pieces, and how many were retried. Nothing when plain.
  ( last=0; t_last=$(date +%s); rate=0
    while [ ! -f "$PARTS/done" ]; do
      got=$(( $(ls "$PARTS" 2>/dev/null | grep -c '^[0-9][0-9]*$' || true) * PIECE_BYTES )); [ "$got" -le "$TOTAL" ] || got=$TOTAL
      now=$(date +%s)
      if [ "$now" -gt "$t_last" ]; then rate=$(( (got - last) / (now - t_last) )); last=$got; t_last=$now; fi
      pct=$(( got * 100 / TOTAL ))
      text="$(printf '%3s%%' "$pct")  $(mb "$got") of $(mb "$TOTAL") MB"
      [ "$rate" -gt 0 ] && text="$text $DOT $(awk -v r="$rate" 'BEGIN { printf "%.1f", r / 1048576 }') MB/s $DOT $(( (TOTAL - got) / rate )) s left"
      again=0; [ -f "$PARTS/retries" ] && again=$(wc -l < "$PARTS/retries")
      [ "$again" -gt 0 ] && text="$text $DOT $G_RETRY $again retried"
      run "Downloading" "$text" "$pct"
      progress 1 "$pct" "$pct% $DOT Downloading Alfred"
      sleep 0.5 2>/dev/null || sleep 1
    done ) &
  PROGRESS=$!
  awk -v piece="$PIECE_BYTES" -v total="$TOTAL" '{ e = $1 + piece - 1; if (e >= total) e = total - 1; print $1, e }' "$PARTS/list" \
    | xargs -P "$CONNECTIONS" -n 2 sh "$PARTS/piece.sh" "$PARTS" || true
  touch "$PARTS/done"; wait "$PROGRESS" 2>/dev/null || true
  [ -f "$PARTS/failed" ] && { head -1 "$PARTS/failed" > "$WORK/fetch.error"; return 1; }
  : > "$2"
  while read -r start; do cat "$PARTS/$start" >> "$2" || return 1; done < "$PARTS/list"
  [ "$(wc -c < "$2")" -eq "$TOTAL" ] || { echo "downloaded $(wc -c < "$2") of $TOTAL bytes" > "$WORK/fetch.error"; return 1; }
  again=0; [ -f "$PARTS/retries" ] && again=$(wc -l < "$PARTS/retries")
  printf '%s connections%s' "$CONNECTIONS" "$([ "$again" -gt 0 ] && echo " $DOT $again pieces retried")" > "$WORK/fetch.note"
  rm -rf "$PARTS"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail_ "Checksum" "needs sha256sum or shasum to check the download"
  fi
}

# ---- this machine --------------------------------------------------------------------------------------------------
arg() { # arg NAME "$@" - the value after --NAME among the installer's arguments
  want=$1; shift
  while [ $# -gt 0 ]; do [ "$1" = "--$want" ] && [ $# -gt 1 ] && { echo "$2"; return; }; shift; done
}
env_value() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1/.env" 2>/dev/null | tail -1; }
port_owner() { # port_owner PORT [ADDRESS...] - "name (pid N)|/proc exe" of who listens there, or nothing
  port=$1; shift
  command -v ss >/dev/null 2>&1 || return 0
  ss -Hltnp "sport = :$port" 2>/dev/null | while read -r _ _ _ local _ users; do
    addr=${local%:*}
    if [ $# -gt 0 ]; then
      hit=0; for a in "$@"; do case "$addr" in "$a"|"0.0.0.0"|"*"|"[::]") hit=1 ;; esac; done
      [ "$hit" = 1 ] || continue
    fi
    name=$(printf '%s' "$users" | sed -n 's/.*(("\([^"]*\)",pid=\([0-9]*\).*/\1 (pid \2)/p')
    pid=$(printf '%s' "$users" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    echo "${name:-a process}|$exe"
    break
  done
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; progress 0 0' EXIT INT TERM

# The test suite runs the download alone (tests/python/test_install_scripts.py): the URL and the file to write.
if [ -n "${ALFRED_INSTALL_FETCH_ONLY:-}" ]; then
  fetch_release "$ALFRED_INSTALL_FETCH_ONLY" "$ALFRED_INSTALL_FETCH_TO"
  exit $?
fi

BEGAN=$(date +%s)
if [ "$LIVE" = 1 ]; then
  printf '\n  %s %s%s\n\n' "$(c teal "$G_BRAND")" "$(c hi Alfred)" "$(c dim "  installer $DOT HTTP traffic in and out of your Java app")"
else
  echo "Alfred installer"
fi

# -- checks that need nothing downloaded ------------------------------------------------------------------------------
run "Root" "checking"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) ;;
  *) fail_ "Root" "only Linux x86_64 has an installer (this is $(uname -s) $(uname -m))" "On Windows use install.ps1." ;;
esac
if [ "$(id -u)" -eq 0 ]; then
  AS_ROOT=""
  done_ "Root" "yes $DOT Linux x86_64"
elif command -v sudo >/dev/null 2>&1; then
  AS_ROOT="sudo"
  [ "$LIVE" = 1 ] && printf '\r\033[2K'
  sudo -v || fail_ "Root" "sudo was refused" "Run it as: curl -fsSL .../install.sh | sudo sh"
  done_ "Root" "through sudo $DOT Linux x86_64"
else
  fail_ "Root" "no - the installer registers a system service" "Run it as: curl -fsSL .../install.sh | sudo sh"
fi

run "Latest release" "reading latest.json"
fetch "$MANIFEST_URL" "$WORK/latest.json" 2>/dev/null || fail_ "Latest release" "could not read $MANIFEST_URL" "Is a release published? Another source: ALFRED_RELEASE_URL=<a latest.json>"
# latest.json: {"version": "...", "assets": {"linux-x64": {"url": "...", "sha256": "...", "size": N}, ...}}
# No jq on a bare machine: flatten it and cut the one object out.
FLAT="$(tr -d '\t\r\n' < "$WORK/latest.json" | sed 's/" *: */":/g; s/, *"/,"/g; s/{ *"/{"/g')"
# The file lists older releases under "releases", each with its own linux-x64 entry: take the first of each (the current release comes first).
VERSION="$(printf '%s' "$FLAT" | sed -n 's/^{"version":"\([^"]*\)".*/\1/p')"
ASSET="$(printf '%s' "$FLAT" | grep -o "\"$TARGET\":{[^}]*}" | head -n 1 || true)"
URL="$(printf '%s' "$ASSET" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$ASSET" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')"
SIZE="$(printf '%s' "$ASSET" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')"
[ -n "$URL" ] && [ -n "$SHA" ] || fail_ "Latest release" "Alfred $VERSION has no $TARGET installer"
done_ "Latest release" "Alfred $VERSION${SIZE:+ $DOT $(mb "$SIZE") MB}"

run "Existing install" "looking for Alfred"
DIR=$(arg dir "$@"); DIR=${DIR:-/opt/alfred}
OLD_VERSION=$(cat "$DIR/app/VERSION" 2>/dev/null | tr -d '[:space:]' || true)
if [ -z "$OLD_VERSION" ]; then
  done_ "Existing install" "none $DOT installing into $DIR"
elif [ "$OLD_VERSION" = "$VERSION" ]; then
  done_ "Existing install" "Alfred $OLD_VERSION in $DIR $G_ARROW the same version: program files put back fresh, settings and data kept"
else
  done_ "Existing install" "Alfred $OLD_VERSION in $DIR $G_ARROW upgrade to $VERSION, settings and data kept"
fi

run "Disk space" "checking"
probe=$DIR; while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
FREE_KB=$(df -Pk "$probe" 2>/dev/null | awk 'NR == 2 { print $4 }')
NEED=$(( ${SIZE:-0} * 5 )); [ "$NEED" -gt 734003200 ] || NEED=734003200   # installer, unpacked runtimes, previous version kept aside
if [ -n "$FREE_KB" ]; then
  free_gb=$(awk -v k="$FREE_KB" 'BEGIN { printf "%.1f", k / 1048576 }'); need_gb=$(awk -v b="$NEED" 'BEGIN { printf "%.1f", b / 1073741824 }')
  [ "$((FREE_KB * 1024))" -ge "$NEED" ] || fail_ "Disk space" "$free_gb GB free on $probe - needs about $need_gb GB" "Free some space, or install elsewhere: ... | sudo sh -s -- --dir /data/alfred"
  done_ "Disk space" "$free_gb GB free on $probe $DOT needs about $need_gb GB"
else
  done_ "Disk space" "could not be read for $probe - continuing"
fi

run "Ports" "who listens on the UI and proxy ports"
UI_PORT=$(arg ui-port "$@"); UI_PORT=${UI_PORT:-$(env_value "$DIR" ALFRED_UI_PORT)}; UI_PORT=${UI_PORT:-3000}
PROXY=$(env_value "$DIR" ALFRED_OUTBOUND_PROXY_LISTEN); PROXY=${PROXY:-127.0.0.2:443}
PROXY_HOST=${PROXY%:*}; PROXY_PORT=${PROXY##*:}
UI_OWNER=$(port_owner "$UI_PORT"); PROXY_OWNER=$(port_owner "$PROXY_PORT" "$PROXY_HOST")
ours() { case "${1#*|}" in "$DIR"/*) return 0 ;; *) return 1 ;; esac; }
if [ -n "$UI_OWNER" ] && ! ours "$UI_OWNER"; then
  fail_ "Ports" "$UI_PORT is in use by ${UI_OWNER%%|*}" "Alfred's UI needs it. Stop that program, or pick another port:" \
    "curl -fsSL .../install.sh | sudo sh -s -- --ui-port 3017" "" "Stopped before downloading - nothing changed on this machine."
fi
NOTE=free; { [ -n "$UI_OWNER" ] || [ -n "$PROXY_OWNER" ]; } && NOTE="held by Alfred $OLD_VERSION $DOT freed during the upgrade"
if [ -n "$PROXY_OWNER" ] && ! ours "$PROXY_OWNER"; then
  warn_ "Ports" "$UI_PORT $NOTE $DOT $PROXY_PORT is in use by ${PROXY_OWNER%%|*}" \
    "The outbound proxy ($PROXY) won't start until it is free, or move it after installing:" \
    "sudo alfred config set ALFRED_OUTBOUND_PROXY_LISTEN 127.0.0.2:8443"
else
  done_ "Ports" "$UI_PORT and $PROXY_PORT $NOTE"
fi

# -- the installer: from the cache, or downloaded into it --------------------------------------------------------------
$AS_ROOT mkdir -p "$CACHE"
FILE="$CACHE/alfred-setup-$VERSION-$TARGET.run"
if [ -f "$FILE" ] && [ "$(sha256_of "$FILE")" = "$SHA" ]; then
  done_ "Downloading" "already here $DOT cached $(date -r "$FILE" '+%Y-%m-%d %H:%M' 2>/dev/null || echo before) $DOT $CACHE"
  done_ "Checksum" "matches the release (checked again)"
else
  run "Downloading" "starting"
  progress 1 0 "0% $DOT Downloading Alfred $VERSION"
  PART="$WORK/alfred-setup-$VERSION-$TARGET.run.part"
  t0=$(date +%s)
  if ! fetch_release "$URL" "$PART"; then
    fail_ "Downloading" "$(cat "$WORK/fetch.error" 2>/dev/null || echo "could not download $URL")" "Nothing was installed. Run the one-liner again; dropped pieces are retried, a stall gives up after 4 tries."
  fi
  RESULT=$(cat "$WORK/fetch.note" 2>/dev/null || true)
  took=$(( $(date +%s) - t0 )); [ "$took" -gt 0 ] || took=1
  bytes=$(wc -c < "$PART")
  rate=$(awk -v b="$bytes" -v s="$took" 'BEGIN { printf "%.1f", b / 1048576 / s }')
  done_ "Downloading" "$(mb "$bytes") MB in $(duration "$took") $DOT $rate MB/s${RESULT:+ $DOT $RESULT}"
  run "Checksum" "sha256"
  progress 3 0 "Checking Alfred $VERSION"
  ACTUAL="$(sha256_of "$PART")"
  if [ "$ACTUAL" != "$SHA" ]; then
    fail_ "Checksum" "does not match the release" "expected $SHA" "got      $ACTUAL" "" \
      "Nothing was installed - the download was deleted. Try again in a minute; if it keeps happening, a proxy may be changing" \
      "the file: ALFRED_RELEASE_URL=<a mirror's latest.json>, then the one-liner again."
  fi
  $AS_ROOT mv -f "$PART" "$FILE"
  done_ "Checksum" "$(printf '%s' "$SHA" | cut -c1-8)...$(printf '%s' "$SHA" | cut -c59-64) matches the release"
  # Keep the newest two installers: a failed install, or the one-liner run again, needs no download.
  ls -t "$CACHE"/alfred-setup-*.run 2>/dev/null | tail -n +3 | while read -r old; do $AS_ROOT rm -f "$old"; done
fi

# -- install: its own steps shown under this one as they happen ------------------------------------------------------
if [ -n "$OLD_VERSION" ]; then DOING="stopping Alfred $OLD_VERSION, replacing its files"; else DOING="unpacking Java, Python and Node, registering the service"; fi
progress 3 0 "Installing Alfred $VERSION"
run "Installing" "$DOING"
( $AS_ROOT sh "$FILE" --unattended "$@" > "$WORK/installer.out" 2>&1; echo $? > "$WORK/installer.rc" ) &
SHOWN=0
show_installer_lines() {
  total=$(wc -l < "$WORK/installer.out" 2>/dev/null || echo 0)
  [ "$total" -gt "$SHOWN" ] || return 0
  sed -n "$((SHOWN + 1)),${total}p" "$WORK/installer.out" | while IFS= read -r line; do
    case "$line" in
      "Alfred setup"|"") ;;
      *"$(printf '\342\234\223') "*) sub "$G_OK" "${line#*$(printf '\342\234\223') }" ;;
      *"$(printf '\342\234\227') "*) sub "$G_FAIL" "${line#*$(printf '\342\234\227') }" ;;
      *) sub " " "$(printf '%s' "$line" | sed 's/^ *//')" ;;
    esac
  done
  SHOWN=$total
}
while [ ! -f "$WORK/installer.rc" ]; do
  show_installer_lines
  run "Installing" "$DOING $DOT $(seconds) s"
  sleep 0.2 2>/dev/null || sleep 1
done
show_installer_lines
RC=$(cat "$WORK/installer.rc")
if [ "$RC" != 0 ]; then
  if [ -n "$OLD_VERSION" ]; then BACK="Alfred $OLD_VERSION was put back and keeps running."; else BACK="Nothing was left installed."; fi
  fail_ "Installing" "the installer stopped with exit code $RC. $BACK" "The installer is kept in $CACHE: running the one-liner again skips the download."
fi
done_ "Installing" "$DIR $DOT $(duration "$(seconds)")"

UI_PORT=$(env_value "$DIR" ALFRED_UI_PORT); UI_PORT=${UI_PORT:-3000}
run "Alfred answers" "http://localhost:$UI_PORT"
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 10 "http://localhost:$UI_PORT/server/status" > "$WORK/status.json" 2>/dev/null; then
  done_ "Alfred answers" "on port $UI_PORT"
else
  warn_ "Alfred answers" "not on port $UI_PORT yet" "sudo alfred status shows what runs; sudo alfred logs supervisor why."
fi
progress 0 0 "Alfred $VERSION installed"

# -- the address -------------------------------------------------------------------------------------------------------
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$VERSION" ]; then HEAD="Alfred $OLD_VERSION $G_ARROW $VERSION is running"; else HEAD="Alfred $VERSION is running"; fi
ROWS="UI       http://localhost:$UI_PORT"
for ip in $(hostname -I 2>/dev/null); do case "$ip" in *:*|127.*) ;; *) ROWS="$ROWS
         http://$ip:$UI_PORT" ;; esac; done
[ -n "$OLD_VERSION" ] && ROWS="$ROWS
Kept     settings and recorded data"
ROWS="$ROWS
Next     alfred status $DOT alfred jvms $DOT alfred attach <pid>
Claude   alfred skill install (as yourself, no sudo) adds the /alfred-qa QA skill
Took     $(duration $(( $(date +%s) - BEGAN )))"
echo
if [ "$LIVE" = 1 ]; then
  width=$(printf '%s\n' "$ROWS" | while IFS= read -r r; do printf '%s' "$r" | wc -m; done | sort -n | tail -1)
  hw=$(printf '%s' "$HEAD" | wc -m); [ $((hw + 4)) -gt "$width" ] && width=$((hw + 4)); width=$((width + 4))
  line() { i=0; out=""; while [ $i -lt "$1" ]; do out="$out$B_H"; i=$((i + 1)); done; printf '%s' "$out"; }
  printf '  %s %s %s\n' "$(c teal "$B_TL$B_H")" "$(c hi "$HEAD")" "$(c teal "$(line $((width - hw - 3)))$B_TR")"
  printf '%s\n' "$ROWS" | while IFS= read -r r; do
    n=$(printf '%s' "$r" | wc -m)
    printf '  %s  %s%s%*s%s\n' "$(c teal "$B_V")" "$(c dim "$(printf '%s' "$r" | cut -c1-9)")" "$(printf '%s' "$r" | cut -c10-)" $((width - 2 - n)) "" "$(c teal "$B_V")"
  done
  printf '  %s\n' "$(c teal "$B_BL$(line "$width")$B_BR")"
else
  echo "$HEAD"
  printf '%s\n' "$ROWS" | sed 's/^/  /'
fi
