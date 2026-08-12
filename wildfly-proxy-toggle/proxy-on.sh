#!/bin/bash
#
# proxy-on.sh - thin wrapper: compiles (if needed) and runs WildFlyProxyController.java, which
# does the actual work - detects the running WildFly instance via the Java Attach API (prompting
# if more than one is found), then loads WildFlyProxyAgent into it to set
# https.proxyHost/https.proxyPort system properties. No restart, no standalone.xml touched even
# transiently, no launch-config change. Run proxy-off.sh to reverse. See
# WildFlyProxyController.java/WildFlyProxyAgent.java and README.md for details.
#
# A JDK 8 install is needed (tools.jar, for the Attach API) - auto-detected via FindJdk8.java
# regardless of what JAVA_HOME currently points at (a machine's default JAVA_HOME is commonly a
# newer JDK for everything else), unless JDK8_HOME is set explicitly.

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
    echo "  JDK8_HOME=/usr/lib/jvm/java-8-openjdk ./proxy-on.sh"
    exit 1
fi
echo "Using JDK 8 at $JDK8_HOME"

JAVAC="$JDK8_HOME/bin/javac"
JAVA="$JDK8_HOME/bin/java"
JAR_TOOL="$JDK8_HOME/bin/jar"
TOOLS_JAR="$JDK8_HOME/lib/tools.jar"

mkdir -p "$DIR/agent-out"
"$JAVAC" -d "$DIR/agent-out" "$DIR/WildFlyProxyAgent.java"

# Once loaded into a target JVM, this jar's file handle stays open (and locked, on Windows) for
# that JVM's remaining lifetime - a fixed filename would fail to rebuild on a later run against
# the same still-running instance. $$ (this script's own PID) sidesteps that entirely.
AGENT_JAR="$DIR/out/wildfly-agent-$$.jar"
"$JAR_TOOL" cfm "$AGENT_JAR" "$DIR/MANIFEST.MF" -C "$DIR/agent-out" .

"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" -DAGENT_JAR="$AGENT_JAR" WildFlyProxyController on
