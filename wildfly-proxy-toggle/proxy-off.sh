#!/bin/bash
#
# proxy-off.sh - reverses proxy-on.sh: compiles (if needed) and runs WildflyProxyToggle.java to
# remove the https.proxyHost/https.proxyPort system properties from the detected WildFly
# instance. Safe to run even if the proxy was never turned on.

set -eo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"

mkdir -p "$DIR/out"
"$JAVAC" -d "$DIR/out" "$DIR/WildflyProxyToggle.java"
"$JAVA" -cp "$DIR/out" WildflyProxyToggle off
