#!/bin/sh
# Starts ONE mitmdump process holding the usual DEFAULT forward-mode listener PLUS one extra
# forward-mode listener PER PROJECT that's opted into outbound attribution, built from
# FORWARD_PROXY_PORT_MAP ("name:internalPort" pairs) - mirrors reverse-proxy-entrypoint.sh's
# structure exactly, just for the outbound side: a project's own outbound HTTP client points its
# proxy settings at its own dedicated outboundProxyHost:outboundProxyPort (published to this
# extra internal port via docker-compose.override.yml - see start.py/restart.py), and
# log_and_route.py works out which project a flow belongs to from the internal port it arrived
# on. The default listener is ALWAYS present too, for backward compatibility with any existing
# proxy-aware client not part of this per-project scheme (unattributed, "External" as always).
#
# FORWARD_PROXY_PORT_MAP may be EMPTY (no project has opted into outbound attribution yet) - the
# default listener alone is enough to keep this container doing exactly what it did before this
# feature existed.
set -eu

: "${FORWARD_PROXY_DEFAULT_PORT:=8080}"
FORWARD_PROXY_PORT_MAP="${FORWARD_PROXY_PORT_MAP:-}"

# Deliberately unquoted when passed to mitmdump below - each "--mode ..." pair must become its
# own argv entry.
MODE_ARGS="--mode regular@${FORWARD_PROXY_DEFAULT_PORT}"

if [ -n "$FORWARD_PROXY_PORT_MAP" ]; then
  echo "forward-proxy-entrypoint: port map = $FORWARD_PROXY_PORT_MAP"
  for PAIR in $(echo "$FORWARD_PROXY_PORT_MAP" | tr ',' ' '); do
    NAME="${PAIR%%:*}"
    PORT="${PAIR##*:}"
    echo "forward-proxy-entrypoint:   $NAME: listening on $PORT (outbound attribution)"
    MODE_ARGS="$MODE_ARGS --mode regular@${PORT}"
  done
else
  echo "forward-proxy-entrypoint: FORWARD_PROXY_PORT_MAP is empty - only the default listener on"
  echo "forward-proxy-entrypoint: port $FORWARD_PROXY_DEFAULT_PORT is active (add outboundProxyHost"
  echo "forward-proxy-entrypoint: to settings.properties's internal_call_services entries to opt in)."
fi

exec mitmdump -q -s log_and_route.py \
  $MODE_ARGS \
  --set connection_strategy=lazy
