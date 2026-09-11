#!/bin/sh
# Starts ONE mitmdump process with one reverse-mode listener PER PROJECT, built from
# REVERSE_PROXY_PORT_MAP ("name:listenPort:upstreamPort" triples). Each listener has its own
# fixed upstream, so mitmproxy itself does the routing - log_and_route_reverse.py only has to
# work out which project a flow belongs to (from the port it arrived on) for logging and for
# that project's on/off toggle. Nothing about routing depends on the request's contents.
#
# REVERSE_PROXY_PORT_MAP may be EMPTY (feature enabled but no projects configured yet) - this
# container still has to stay up, so that case just idles instead of failing to start.
set -eu

: "${REVERSE_PROXY_UPSTREAM_HOST:=host.docker.internal}"
REVERSE_PROXY_PORT_MAP="${REVERSE_PROXY_PORT_MAP:-}"

if [ -z "$REVERSE_PROXY_PORT_MAP" ]; then
  echo "reverse-proxy-entrypoint: REVERSE_PROXY_PORT_MAP is empty - no projects configured yet."
  echo "reverse-proxy-entrypoint: idling (add projects to settings.properties's internal_call_services)."
  exec tail -f /dev/null
fi

echo "reverse-proxy-entrypoint: port map = $REVERSE_PROXY_PORT_MAP"

# Deliberately unquoted when passed to mitmdump below - each pair must become its own argv entry.
MODE_ARGS=""
for TRIPLE in $(echo "$REVERSE_PROXY_PORT_MAP" | tr ',' ' '); do
  NAME="${TRIPLE%%:*}"
  REST="${TRIPLE#*:}"
  LISTEN_PORT="${REST%%:*}"
  UPSTREAM_PORT="${REST##*:}"
  echo "reverse-proxy-entrypoint:   $NAME: listening on $LISTEN_PORT -> $REVERSE_PROXY_UPSTREAM_HOST:$UPSTREAM_PORT"
  MODE_ARGS="$MODE_ARGS --mode reverse:http://${REVERSE_PROXY_UPSTREAM_HOST}:${UPSTREAM_PORT}@${LISTEN_PORT}"
done

# keep_host_header=true is LOAD-BEARING: mitmproxy otherwise rewrites the incoming Host header to
# each listener's own upstream (host.docker.internal:<upstreamPort>), and any upstream that builds
# absolute URLs from Host would then hand clients links straight to that address - unreachable
# from the client, and a bypass of this proxy where it does resolve (confirmed live: WildFly's 302
# Location did exactly that). Keeping the client's Host is also just what a reverse proxy should
# forward upstream, same as nginx's "proxy_set_header Host $host".
#
# confdir is LOAD-BEARING for the same reason it is in forward-proxy-entrypoint.sh: pointing
# docker-compose's "entrypoint:" at this script replaces the image's own docker-entrypoint.sh
# (the thing that would otherwise set HOME=/home/mitmproxy and drop to the mitmproxy user), so
# without it mitmdump runs as root, resolves confdir to /root/.mitmproxy rather than the mounted
# ./proxy/certs, and generates a throwaway CA there on every start.
exec mitmdump -q -s log_and_route_reverse.py \
  $MODE_ARGS \
  --set confdir=/home/mitmproxy/.mitmproxy \
  --set connection_strategy=lazy \
  --set keep_host_header=true
