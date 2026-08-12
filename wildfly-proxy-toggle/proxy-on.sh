#!/bin/bash
#
# proxy-on.sh - thin wrapper: compiles (if needed) and runs WildflyProxyToggle.java, which does
# the actual work - detects the running WildFly instance (prompting if more than one is found),
# and adds https.proxyHost/https.proxyPort system properties to it via the management CLI. No
# restart, no standalone.xml hand-edit, no launch-config change. Run proxy-off.sh to reverse. See
# WildflyProxyToggle.java and README.md for details and optional env var overrides.

set -eo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"

mkdir -p "$DIR/out"
"$JAVAC" -d "$DIR/out" "$DIR/WildflyProxyToggle.java"
"$JAVA" -cp "$DIR/out" WildflyProxyToggle on
