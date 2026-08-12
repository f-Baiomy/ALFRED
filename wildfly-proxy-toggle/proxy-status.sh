#!/bin/bash
#
# proxy-status.sh - reports whether the proxy is currently on/off for the detected WildFly
# instance, by reading its system properties directly over the Attach API connection (no agent
# jar needed for this - see WildFlyProxyController.java's "status" branch).
#
# Requires JAVA_HOME set to a JDK 8 install (needs tools.jar for the Attach API).

set -eo pipefail

if [ -z "${JAVA_HOME:-}" ]; then
    echo "Set JAVA_HOME to a JDK 8 install first (needed for tools.jar / the Attach API), e.g.:"
    echo "  JAVA_HOME=/opt/jdk1.8.0_XXX ./proxy-status.sh"
    exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"
TOOLS_JAR="$JAVA_HOME/lib/tools.jar"

if [ ! -f "$TOOLS_JAR" ]; then
    echo "Could not find $TOOLS_JAR - is JAVA_HOME a JDK 8 install, not a JRE?"
    exit 1
fi

mkdir -p "$DIR/out"
"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" WildFlyProxyController status
