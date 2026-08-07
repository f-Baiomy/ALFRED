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

echo "=== Step 1: hosts file ==="

while IFS= read -r line || [ -n "$line" ]; do
    domain="$(echo "$line" | sed 's/#.*//' | xargs)"
    [ -z "$domain" ] && continue

    proxy_host="${domain}-proxy"

    if grep -qE "[[:space:]]${proxy_host}([[:space:]]|$)" "$HOSTS_FILE"; then
        echo "  [skip]  ${proxy_host} already present"
    else
        echo "127.0.0.1   ${proxy_host}" >> "$HOSTS_FILE"
        echo "  [added] 127.0.0.1   ${proxy_host}"
    fi
done < "$SUPPLIERS_FILE"

# ---- Step 2: start all services (proxy, backend, frontend) ----

echo ""
echo "=== Step 2: docker compose up (alfred, pennyworth, manor) ==="
cd "$SCRIPT_DIR"
docker compose up -d --build

echo "Waiting for CA certificate ..."
attempts=0
while [ ! -f "$CERT_FILE" ] && [ "$attempts" -lt 15 ]; do
    sleep 1
    attempts=$((attempts + 1))
done

if [ ! -f "$CERT_FILE" ]; then
    echo "Certificate not found at $CERT_FILE after waiting - check 'docker compose logs alfred'."
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

# ---- Step 4: trust the cert in every JDK listed in jdks.txt (idempotent) ----

echo ""
echo "=== Step 4: JDK certificate trust ==="

if [ ! -f "$JDKS_FILE" ]; then
    echo "  jdks.txt not found - skipping JDK trust step"
else
    any_jdk=0
    while IFS= read -r line || [ -n "$line" ]; do
        jdk_home="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -z "$jdk_home" ] && continue
        any_jdk=1

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
    done < "$JDKS_FILE"

    if [ "$any_jdk" -eq 0 ]; then
        echo "  jdks.txt is empty - add JAVA_HOME paths there if your app needs cert trust"
    fi
fi

echo ""
echo "Done. Proxy is up. Tail logs with:"
echo "  tail -f ./logs/calls.log"
echo ""
echo "If you added a new JDK trust just now, restart that app/server"
echo "so its JVM re-reads its truststore."
