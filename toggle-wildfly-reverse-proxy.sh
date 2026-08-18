#!/usr/bin/env bash
# Flips WildFly-traffic logging on/off live - no docker restart, no WildFly restart.
#
# wildfly-proxy (see docker-compose.yml) always owns host port 8080 and always
# forwards to WildFly (WILDFLY_UPSTREAM) - that part never stops, so the frontend
# keeps working at localhost:8080 either way. This script only flips whether the
# addon also logs each call to backend, by writing "on"/"off" into
# proxy/reverse-proxy-enabled.flag, which the addon re-reads (via mtime) on every
# request - see proxy/log_and_route_reverse.py.
#
# Not to be confused with wildfly-proxy-toggle/ (an unrelated Attach-API tool
# that makes WildFly's own OUTBOUND calls go through the forward proxy). This
# script only controls the REVERSE proxy in front of WildFly, for the
# frontend's INBOUND calls to it - see docker-compose.yml's wildfly-proxy
# service and proxy/log_and_route_reverse.py. Wired into start.py/restart.py's
# --wildfly-reverse-proxy [on|off] flag; run standalone any other time.
#
# Usage: ./toggle-wildfly-reverse-proxy.sh [on|off|status]

set -euo pipefail
cd "$(dirname "$0")"

FLAG_FILE="proxy/reverse-proxy-enabled.flag"
ACTION="${1:-status}"

case "$ACTION" in
  on)
    echo "on" > "$FLAG_FILE"
    echo "WildFly call logging: ON (wildfly-proxy keeps forwarding to WildFly regardless)"
    ;;
  off)
    echo "off" > "$FLAG_FILE"
    echo "WildFly call logging: OFF (calls still reach WildFly, just no longer logged)"
    ;;
  status)
    current="$(cat "$FLAG_FILE" 2>/dev/null || echo "on (file missing, defaults to on)")"
    echo "WildFly call logging is currently: $current"
    ;;
  *)
    echo "Usage: $0 [on|off|status]" >&2
    exit 1
    ;;
esac
