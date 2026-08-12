#!/bin/bash
#
# proxy-on.sh - thin wrapper: compiles (if needed) and runs WildFlyProxyController.java, which
# does the actual work - detects the running WildFly instance via the Java Attach API (prompting
# if more than one is found), then loads WildFlyProxyAgent into it to set
# https.proxyHost/https.proxyPort system properties. No restart, no standalone.xml touched even
# transiently, no launch-config change. Run proxy-off.sh to reverse. See
# WildFlyProxyController.java/WildFlyProxyAgent.java and README.md for details.
#
# Requires JAVA_HOME set to a JDK 8 install (needs tools.jar for the Attach API).

set -eo pipefail

if [ -z "${JAVA_HOME:-}" ]; then
    echo "Set JAVA_HOME to a JDK 8 install first (needed for tools.jar / the Attach API), e.g.:"
    echo "  JAVA_HOME=/opt/jdk1.8.0_XXX ./proxy-on.sh"
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

# Once loaded into a target JVM, this jar's file handle stays open (and locked, on Windows) for
# that JVM's remaining lifetime - a fixed filename would fail to rebuild on a later run against
# the same still-running instance. $$ (this script's own PID) sidesteps that entirely.
AGENT_JAR="$DIR/out/wildfly-agent-$$.jar"
"$JAR_TOOL" cfm "$AGENT_JAR" "$DIR/MANIFEST.MF" -C "$DIR/agent-out" .

"$JAVAC" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JAVA" -cp "$DIR/out:$TOOLS_JAR" -DAGENT_JAR="$AGENT_JAR" WildFlyProxyController on
