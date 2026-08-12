#!/bin/bash
#
# proxy-on.sh - routes an already-running WildFly JVM's HTTPS traffic through Alfred's
# forward-mode proxy (127.0.0.2:443 by default) by adding https.proxyHost/https.proxyPort
# system properties via WildFly's management CLI. No restart, no standalone.xml hand-edit, no
# launch-flag change. Run proxy-off.sh to reverse.
#
# Requires: WILDFLY_HOME set to the WildFly install directory, and its management interface
# reachable (default localhost:9990).
#
# Usage:
#   WILDFLY_HOME=/opt/wildfly ./proxy-on.sh
#   CONTROLLER=localhost:9990 PROXY_HOST=127.0.0.2 PROXY_PORT=443 WILDFLY_HOME=/opt/wildfly ./proxy-on.sh

set -eo pipefail

if [ -z "${WILDFLY_HOME:-}" ]; then
    echo "Set WILDFLY_HOME to your WildFly install directory first, e.g.:"
    echo "  WILDFLY_HOME=/opt/wildfly ./proxy-on.sh"
    exit 1
fi

CONTROLLER="${CONTROLLER:-localhost:9990}"
PROXY_HOST="${PROXY_HOST:-127.0.0.2}"
PROXY_PORT="${PROXY_PORT:-443}"
CLI="$WILDFLY_HOME/bin/jboss-cli.sh"

if [ ! -x "$CLI" ]; then
    echo "Could not find or run $CLI - is WILDFLY_HOME set correctly?"
    exit 1
fi

# Best-effort cleanup first so re-running this script is idempotent - a property that's
# already set would otherwise make :add() fail with "already exists".
"$CLI" --connect --controller="$CONTROLLER" \
    --commands="/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()" \
    >/dev/null 2>&1 || true

OUTPUT="$("$CLI" --connect --controller="$CONTROLLER" \
    --commands="/system-property=https.proxyHost:add(value=$PROXY_HOST),/system-property=https.proxyPort:add(value=$PROXY_PORT)" 2>&1)" && RC=0 || RC=$?

echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "Failed to connect"; then
    echo
    echo "Could not reach WildFly's management interface at $CONTROLLER - is WildFly running?"
    exit 1
fi

if [ "$RC" -ne 0 ]; then
    echo
    echo "Failed to enable the proxy - see output above."
    exit 1
fi

echo
echo "Proxy ON - HTTPS traffic in this WildFly JVM now routes through $PROXY_HOST:$PROXY_PORT"
echo "Run proxy-off.sh to disable."
