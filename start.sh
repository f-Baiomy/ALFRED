#!/bin/bash
#
# start.sh - Linux/macOS entry point.
#
# Idempotent - safe to run every time. On each run it:
#   1. Adds any missing "-proxy" hosts entries from suppliers.txt
#   2. Starts the proxy with "docker compose up -d" (generates the CA
#      cert on first run)
#   3. Trusts that CA cert in the OS certificate store, if not already
#      trusted
#   4. Trusts that CA cert in every JDK listed in jdks.txt, if not
#      already trusted there
#
# Run this INSTEAD OF "docker compose up" directly:
#   sudo ./start.sh
#
# Needs sudo for /etc/hosts and the OS certificate store.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPLIERS_FILE="$SCRIPT_DIR/suppliers.txt"
JDKS_FILE="$SCRIPT_DIR/jdks.txt"
CERT_FILE="$SCRIPT_DIR/proxy/certs/mitmproxy-ca-cert.pem"
HOSTS_FILE="/etc/hosts"

if [ "$(id -u)" -ne 0 ]; then
    echo "This needs root (hosts file + certificate store)."
    echo "Re-run as: sudo ./start.sh"
    exit 1
fi

if [ ! -f "$SUPPLIERS_FILE" ]; then
    echo "suppliers.txt not found at $SUPPLIERS_FILE"
    exit 1
fi

# ---- Step 1: hosts file entries from suppliers.txt ----
#
# 127.0.0.2 (not .1) so Alfred can bind port 443 (the HTTPS default, so
# "-proxy" URLs never need an explicit port) without conflicting with
# anything already using 127.0.0.1:443 on this machine - the whole
# 127.0.0.0/8 range is loopback, so any 127.x.x.x address works the same.

echo "=== Step 1: hosts file ==="
TARGET_IP="127.0.0.2"

while IFS= read -r line || [ -n "$line" ]; do
    domain="$(echo "$line" | sed 's/#.*//' | xargs)"
    [ -z "$domain" ] && continue

    proxy_host="${domain}-proxy"
    # grep exiting 1 (no match - the normal case for a brand-new entry) would otherwise abort the
    # whole script here: with pipefail on, that failure propagates through "| head -n1" even though
    # head itself succeeds, and set -e then kills the script mid-loop with no further output.
    existing_line="$(grep -E "[[:space:]]${proxy_host}([[:space:]]|$)" "$HOSTS_FILE" | head -n1 || true)"

    if [ -n "$existing_line" ] && echo "$existing_line" | grep -qE "^[[:space:]]*${TARGET_IP}[[:space:]]"; then
        echo "  [skip]  ${proxy_host} already present"
    elif [ -n "$existing_line" ]; then
        # A stale entry from before this project switched to $TARGET_IP (or a manual edit) - fix
        # the IP in place rather than leaving a second, shadowing line for the same hostname.
        sed -i "s|^.*[[:space:]]${proxy_host}\([[:space:]]\|\$\)|${TARGET_IP}   ${proxy_host}|" "$HOSTS_FILE"
        echo "  [fixed] ${proxy_host} was pointing elsewhere - now ${TARGET_IP}"
    else
        echo "${TARGET_IP}   ${proxy_host}" >> "$HOSTS_FILE"
        echo "  [added] ${TARGET_IP}   ${proxy_host}"
    fi
done < "$SUPPLIERS_FILE"

# ---- Step 2: start all services (proxy, backend, frontend) ----

echo ""
echo "=== Step 2: docker compose up (proxy, backend, frontend) ==="
cd "$SCRIPT_DIR"
docker compose up -d --build

echo "Waiting for CA certificate ..."
attempts=0
while [ ! -f "$CERT_FILE" ] && [ "$attempts" -lt 15 ]; do
    sleep 1
    attempts=$((attempts + 1))
done

if [ ! -f "$CERT_FILE" ]; then
    echo "Certificate not found at $CERT_FILE after waiting - check 'docker compose logs proxy'."
    exit 1
fi

# ---- Step 3: trust the cert in the OS certificate store (idempotent) ----

echo ""
echo "=== Step 3: OS certificate trust ==="

if [ -f /etc/os-release ] && grep -qi 'ubuntu\|debian' /etc/os-release; then
    DEST="/usr/local/share/ca-certificates/mitmproxy.crt"
    if [ -f "$DEST" ] && cmp -s "$CERT_FILE" "$DEST"; then
        echo "  [skip]  already trusted in system store"
    else
        cp "$CERT_FILE" "$DEST"
        update-ca-certificates > /dev/null
        echo "  [added] trusted in system store"
    fi
elif [ "$(uname)" = "Darwin" ]; then
    # Name-only matching is unsafe: every mitmproxy CA is named "mitmproxy"
    # regardless of which project generated it, so a different project's
    # already-trusted cert would falsely look "already trusted" here even
    # though it's a different key. Always remove and re-add to guarantee
    # the keychain reflects this project's actual current CA.
    sudo security delete-certificate -c mitmproxy /Library/Keychains/System.keychain > /dev/null 2>&1 || true
    security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT_FILE"
    echo "  [synced] trusted in macOS System keychain"
else
    echo "  [warn]  unrecognized OS - trust the cert manually: $CERT_FILE"
fi

# ---- Step 4: trust the cert in every JDK from jdks.txt plus JAVA_HOME (idempotent) ----
#
# jdks.txt is for JDKs that aren't the current environment's default (e.g. a
# server running under a different JAVA_HOME than this interactive shell) -
# JAVA_HOME itself is trusted automatically so the common single-JDK case
# needs no config file entry at all.

echo ""
echo "=== Step 4: JDK certificate trust ==="

JDK_HOMES=()

if [ -f "$JDKS_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        jdk_home="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -z "$jdk_home" ] && continue
        JDK_HOMES+=("$jdk_home")
    done < "$JDKS_FILE"
else
    echo "  jdks.txt not found - only JAVA_HOME (if set) will be trusted"
fi

if [ -n "${JAVA_HOME:-}" ]; then
    already_listed=0
    for h in "${JDK_HOMES[@]:-}"; do
        [ "$h" = "$JAVA_HOME" ] && already_listed=1
    done
    if [ "$already_listed" -eq 0 ]; then
        echo "  [detected] JAVA_HOME environment variable -> $JAVA_HOME"
        JDK_HOMES+=("$JAVA_HOME")
    fi
fi

if [ "${#JDK_HOMES[@]}" -eq 0 ]; then
    echo "  No JDKs found - add a path to jdks.txt or set JAVA_HOME if your app needs cert trust"
else
    for jdk_home in "${JDK_HOMES[@]}"; do
        keytool="$jdk_home/bin/keytool"
        if [ ! -x "$keytool" ]; then
            echo "  [error] keytool not found under $jdk_home - check the path in jdks.txt"
            continue
        fi

        cacerts="$jdk_home/lib/security/cacerts"
        if [ ! -f "$cacerts" ]; then
            cacerts="$jdk_home/jre/lib/security/cacerts"
        fi
        if [ ! -f "$cacerts" ]; then
            echo "  [error] cacerts not found under $jdk_home - check the path in jdks.txt"
            continue
        fi

        # Same issue as above: an existing "mitmproxy" alias might belong
        # to a DIFFERENT project's CA (different key, same friendly name),
        # so merely checking the alias exists isn't enough - always delete
        # then reimport to guarantee this project's actual current cert
        # ends up trusted.
        "$keytool" -delete -alias mitmproxy -keystore "$cacerts" -storepass changeit > /dev/null 2>&1 || true
        if "$keytool" -import -alias mitmproxy -trustcacerts -file "$CERT_FILE" \
            -keystore "$cacerts" -storepass changeit -noprompt > /dev/null 2>&1; then
            echo "  [synced] trusted in $jdk_home"
        else
            echo "  [error] failed to import into $jdk_home - check storepass/permissions"
        fi
    done
fi

echo ""
echo "Done. Proxy is up. Tail logs with:"
echo "  tail -f ./logs/calls.log"
echo ""
echo "If you added a new JDK trust just now, restart that app/server"
echo "so its JVM re-reads its truststore."
