#!/bin/bash
#
# proxy-off.sh - reverses proxy-on.sh: compiles (if needed) and runs
# WildFlyProxyController.java to remove the https.proxyHost/https.proxyPort system properties
# from the detected WildFly instance via the Attach API. Safe to run even if the proxy was never
# turned on.
#
# A JDK 8 install is needed (tools.jar, for the Attach API) - auto-detected via FindJdk8.java
# regardless of what JAVA_HOME currently points at, unless JDK8_HOME is set explicitly.

set -eo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT_JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
BOOT_JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"

mkdir -p "$DIR/out"
"$BOOT_JAVAC" -d "$DIR/out" "$DIR/FindJdk8.java"
JDK8_HOME="$("$BOOT_JAVA" -cp "$DIR/out" FindJdk8)"

if [ -z "$JDK8_HOME" ]; then
    echo "JAVA_HOME is not set, or is not a JDK 8 install (needed for tools.jar / the"
    echo "Attach API). Set JDK8_HOME explicitly, e.g.:"
    echo "  JDK8_HOME=/usr/lib/jvm/java-8-openjdk ./proxy-off.sh"
    exit 1
fi
echo "Using JDK 8 at $JDK8_HOME"

JAVAC="$JDK8_HOME/bin/javac"
JAVA="$JDK8_HOME/bin/java"
JAR_TOOL="$JDK8_HOME/bin/jar"
TOOLS_JAR="$JDK8_HOME/lib/tools.jar"

mkdir -p "$DIR/agent-out"
"$JAVAC" -d "$DIR/agent-out" "$DIR/WildFlyProxyAgent.java"

# Same reasoning as proxy-on.sh - a unique filename avoids colliding with a jar some
# still-running JVM already has locked open from an earlier proxy-on/proxy-off.
AGENT_JAR="$DIR/out/wildfly-agent-$$.jar"
"$JAR_TOOL" cfm "$AGENT_JAR" "$DIR/MANIFEST.MF" -C "$DIR/agent-out" .

"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" -DAGENT_JAR="$AGENT_JAR" WildFlyProxyController off
