#!/bin/bash
#
# proxy-off.sh - reverses proxy-on.sh: compiles (if needed) and runs
# WildFlyProxyController.java to remove the https.proxyHost/https.proxyPort system properties
# from the detected WildFly instance via the Attach API. Safe to run even if the proxy was never
# turned on.
#
# Requires JAVA_HOME set to a JDK 8 install (needs tools.jar for the Attach API).

set -eo pipefail

if [ -z "${JAVA_HOME:-}" ]; then
    echo "Set JAVA_HOME to a JDK 8 install first (needed for tools.jar / the Attach API), e.g.:"
    echo "  JAVA_HOME=/opt/jdk1.8.0_XXX ./proxy-off.sh"
    exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"
JAR_TOOL="$JAVA_HOME/bin/jar"
TOOLS_JAR="$JAVA_HOME/lib/tools.jar"

if [ ! -f "$TOOLS_JAR" ]; then
    echo "Could not find $TOOLS_JAR - is JAVA_HOME a JDK 8 install, not a JRE?"
    exit 1
fi

mkdir -p "$DIR/out" "$DIR/agent-out"
"$JAVAC" -d "$DIR/agent-out" "$DIR/WildFlyProxyAgent.java"

# Same reasoning as proxy-on.sh - a unique filename avoids colliding with a jar some
# still-running JVM already has locked open from an earlier proxy-on/proxy-off.
AGENT_JAR="$DIR/out/wildfly-agent-$$.jar"
"$JAR_TOOL" cfm "$AGENT_JAR" "$DIR/MANIFEST.MF" -C "$DIR/agent-out" .

"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" -DAGENT_JAR="$AGENT_JAR" WildFlyProxyController off
