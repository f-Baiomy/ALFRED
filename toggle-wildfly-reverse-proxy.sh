#!/usr/bin/env bash
# Flips ONE named project's reverse-proxy traffic logging on/off live - no docker restart, no
# upstream restart.
#
# reverse-proxy (see docker-compose.yml) always owns its per-project listen ports and always
# forwards each request (by the port it arrived on, per REVERSE_PROXY_PORT_MAP) to that
# project's upstream - that part never stops, so every project it fronts keeps working either
# way. This script only flips whether the addon also logs a given NAME's calls to backend, by
# writing/updating a
# "name=on"/"name=off" line in proxy/reverse-proxy-enabled.flag, which the addon re-reads (via
# mtime) on every request - see proxy/log_and_route_reverse.py. Other names' lines are left
# untouched - there is no single switch for "every project at once" anymore. A request whose
# arrival port matches nothing configured is logged under the reserved name "unknown", which
# can be toggled the same way as any real project name.
#
# Not to be confused with wildfly-proxy-toggle/ (an unrelated Attach-API tool
# that makes a WildFly JVM's own OUTBOUND calls go through the forward proxy). This
# script only controls the REVERSE proxy in front of whatever upstream project(s), for
# INBOUND calls into them - see docker-compose.yml's reverse-proxy service and
# proxy/log_and_route_reverse.py. Assumes reverse-proxy is actually running - whether it runs
# at all is settings.properties's reverse_proxy_enabled (deploy-time; false by default, many
# environments only need OUTBOUND logging and never start this container). Not wired into
# start.py/restart.py (each project's logging is independently runtime-toggleable rather than
# flipped automatically on every start) - run this standalone, or use the Settings UI instead.
#
# Usage: ./toggle-wildfly-reverse-proxy.sh <name> [on|off|status]
#        ./toggle-wildfly-reverse-proxy.sh status              (with no name: show every line)

set -euo pipefail
cd "$(dirname "$0")"

FLAG_FILE="proxy/reverse-proxy-enabled.flag"

usage() {
  echo "Usage: $0 <name> [on|off|status]" >&2
  echo "       $0 status                  (with no name: show every configured line)" >&2
  exit 1
}

# Docker creates a DIRECTORY at a bind-mount's host path if "docker compose up" ever ran before
# this file existed (e.g. a fresh clone - it's gitignored runtime state) - see docker-compose.yml's
# reverse-proxy/backend services. start.py/restart.py now create this file up front to prevent
# that, but self-heal here too in case this script runs standalone against an already-broken host.
if [ -d "$FLAG_FILE" ]; then
  echo "$FLAG_FILE exists as a directory (created by an earlier 'docker compose up' before this" >&2
  echo "file existed) - removing it so it can be a plain file. Restart reverse-proxy/backend" >&2
  echo "afterward if they're already running, so they re-mount the file instead of the old directory." >&2
  rmdir "$FLAG_FILE"
fi
touch "$FLAG_FILE"

if [ "${1:-}" = "" ]; then
  usage
fi

if [ "$1" = "status" ] && [ "${2:-}" = "" ]; then
  echo "Reverse-proxy call logging, per project (a name with no line below defaults to on):"
  cat "$FLAG_FILE"
  exit 0
fi

NAME="$1"
ACTION="${2:-status}"

case "$ACTION" in
  on|off)
    # Read-modify-write: drop any existing line for this name, then (for "on"/"off") append the
    # new one - so re-running never duplicates a line, matching this file's "one line per name"
    # shape that log_and_route_reverse.py/FileLoggingToggleAdapter both parse.
    TMP_FILE="$(mktemp)"
    grep -v "^${NAME}=" "$FLAG_FILE" > "$TMP_FILE" || true
    echo "${NAME}=${ACTION}" >> "$TMP_FILE"
    mv "$TMP_FILE" "$FLAG_FILE"
    if [ "$ACTION" = "on" ]; then
      echo "Reverse-proxy call logging for '$NAME': ON (forwarding to its upstream is unaffected)"
    else
      echo "Reverse-proxy call logging for '$NAME': OFF (calls still reach its upstream, just no longer logged)"
    fi
    ;;
  status)
    current="$(grep "^${NAME}=" "$FLAG_FILE" | tail -1 | cut -d= -f2- || true)"
    echo "Reverse-proxy call logging for '$NAME' is currently: ${current:-on (no line yet, defaults to on)}"
    ;;
  *)
    usage
    ;;
esac
