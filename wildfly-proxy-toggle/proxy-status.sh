#!/bin/bash
#
# proxy-status.sh - reports whether the proxy is currently on/off for the detected WildFly
# instance, by reading its system properties directly over the Attach API connection (no agent
# jar needed for this - see WildFlyProxyController.java's "status" branch).
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
    echo "  JDK8_HOME=/usr/lib/jvm/java-8-openjdk ./proxy-status.sh"
    exit 1
fi
echo "Using JDK 8 at $JDK8_HOME"

JAVAC="$JDK8_HOME/bin/javac"
JAVA="$JDK8_HOME/bin/java"
TOOLS_JAR="$JDK8_HOME/lib/tools.jar"

"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" WildFlyProxyController status
