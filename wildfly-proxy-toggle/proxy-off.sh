#!/bin/bash
#
# proxy-off.sh - reverses proxy-on.sh: removes the https.proxyHost/https.proxyPort system
# properties from this running WildFly JVM via the management CLI. Safe to run even if the
# proxy was never turned on - a "not found" result just means it was already off, which is the
# desired end state either way (unlike a real connection failure, checked for below).
#
# Usage:
#   WILDFLY_HOME=/opt/wildfly ./proxy-off.sh

set -uo pipefail

if [ -z "${WILDFLY_HOME:-}" ]; then
    echo "Set WILDFLY_HOME to your WildFly install directory first, e.g.:"
    echo "  WILDFLY_HOME=/opt/wildfly ./proxy-off.sh"
    exit 1
fi

CONTROLLER="${CONTROLLER:-localhost:9990}"
CLI="$WILDFLY_HOME/bin/jboss-cli.sh"

if [ ! -x "$CLI" ]; then
    echo "Could not find or run $CLI - is WILDFLY_HOME set correctly?"
    exit 1
fi

OUTPUT="$("$CLI" --connect --controller="$CONTROLLER" \
    --commands="/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()" 2>&1)"
RC=$?

echo "$OUTPUT"

# A "not found" error just means the proxy was already off (nothing to remove) - the desired
# end state either way. Anything else - connection refused, auth failure, a CLI/server
# management-protocol version mismatch, ... - is a real failure and must not be reported as
# success just because it didn't match one specific expected error message.
if [ "$RC" -ne 0 ] && ! echo "$OUTPUT" | grep -qi "not found"; then
    echo
    echo "Failed to disable the proxy - see output above. Is WildFly running, and does this"
    echo "jboss-cli's version match it closely enough to talk to its management interface?"
    exit 1
fi

echo
echo "Proxy OFF - HTTPS traffic in this WildFly JVM goes direct again."
