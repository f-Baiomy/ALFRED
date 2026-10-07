#!/bin/bash
#
# db-capture-on.sh <project> - loads Alfred's database capture agent (db-agent/) into the running WildFly
# (same detection as proxy-on.sh: the Java Attach API, prompting if more than one is found), then switches
# capture on for <project> - the same switch as the ◆ in Live Calls' Sources bar. No restart.
#
# The agent jar is built on first use: with a local Maven if there is one, else with Docker Maven.
# The agent reads WEBHOOK_SECRET from Alfred's .env (secretFile) - the secret never appears on a command line.
# Env: ALFRED_URL (default http://localhost:3000), WILDFLY_PID (skip the prompt).
# Run db-capture-off.sh to stop capturing. An agent cannot be unloaded from a running JVM; "off" stops it
# recording (the reverse proxy stops asking for capture), and a WildFly restart removes it completely.

set -eo pipefail

PROJECT="${1:?usage: db-capture-on.sh <project>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ALFRED_URL="${ALFRED_URL:-http://localhost:3000}"
JAR="$ROOT/db-agent/target/alfred-agent.jar"

. "$DIR/native.sh"
if native_alfred; then
    native_run attach --db --logs --redis --project "$PROJECT"
else
if [ ! -f "$JAR" ]; then
    echo "Building the database capture agent..."
    if command -v mvn >/dev/null 2>&1; then
        (cd "$ROOT/db-agent" && mvn -B -q -DskipTests package)
    else
        MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT:/repo" -v alfred-m2:/root/.m2 -w /repo/db-agent \
            maven:3.9-eclipse-temurin-8 mvn -B -q -DskipTests package
    fi
fi

# Same reason as proxy-on.sh: a loaded jar stays open (locked on Windows) for the JVM's lifetime.
mkdir -p "$DIR/out"
COPY="$DIR/out/alfred-agent-$$.jar"
cp "$JAR" "$COPY"

BOOT_JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
BOOT_JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
"$BOOT_JAVAC" -d "$DIR/out" "$DIR/FindJdk8.java"
JDK8_HOME="${JDK8_HOME:-$("$BOOT_JAVA" -cp "$DIR/out" FindJdk8)}"
if [ -z "$JDK8_HOME" ]; then
    echo "A JDK 8 install is needed for the Attach API (tools.jar). Set JDK8_HOME explicitly."
    exit 1
fi
TOOLS_JAR="$JDK8_HOME/lib/tools.jar"
"$JDK8_HOME/bin/javac" -cp "$TOOLS_JAR" -d "$DIR/out" "$DIR/WildFlyProxyController.java"
"$JDK8_HOME/bin/java" -cp "$DIR/out:$TOOLS_JAR" WildFlyProxyController load-agent "$COPY" \
    "alfredUrl=$ALFRED_URL;project=$PROJECT;secretFile=$ROOT/.env"
fi

echo "Switching database capture on for $PROJECT..."
curl -fsS -X PUT -H 'Content-Type: application/json' -d '{"enabled":true}' \
    "$ALFRED_URL/db-capture/projects/$PROJECT/enabled" >/dev/null \
    && echo "Database capture ON for $PROJECT." \
    || echo "The agent is loaded, but capture could not be switched on (is inbound logging on for $PROJECT?). Use the ◆ switch in Live Calls."
