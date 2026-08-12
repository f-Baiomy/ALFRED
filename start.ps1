# start.ps1 - Windows entry point.
#
# Idempotent - safe to run every time. On each run it:
#   1. Starts the proxy with "docker compose up -d" (generates the CA
#      cert on first run)
#   2. Trusts that CA cert in the Windows Root store, if not already
#      trusted
#   3. Trusts that CA cert in every JDK listed in jdks.txt, if not
#      already trusted there
#
# Run this INSTEAD OF "docker compose up" directly, from an Administrator
# PowerShell window:
#   .\start.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jdksFile = Join-Path $scriptDir "jdks.txt"
$certFile = Join-Path $scriptDir "proxy\certs\mitmproxy-ca-cert.pem"

# ---- Admin check (needed for the Windows cert store) ----

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This needs Administrator rights (certificate store)."
    Write-Host "Re-run this script from an Administrator PowerShell window."
    exit 1
}

# ---- Step 1: start all services (proxy, backend, frontend) ----

Write-Host "=== Step 1: docker compose up (proxy, backend, frontend) ==="
Set-Location $scriptDir
docker compose up -d --build

# Wait for the CA cert to appear (only takes effect on first-ever run)
Write-Host "Waiting for CA certificate ..."
$attempts = 0
while (-not (Test-Path $certFile) -and $attempts -lt 15) {
    Start-Sleep -Seconds 1
    $attempts++
}

if (-not (Test-Path $certFile)) {
    Write-Host "Certificate not found at $certFile after waiting - check 'docker compose logs proxy'."
    exit 1
}

# ---- Step 2: trust the cert in the Windows Root store ----

Write-Host ""
Write-Host "=== Step 2: Windows certificate trust ==="

$previousEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

# Name-only matching is unsafe: every mitmproxy CA is named "mitmproxy"
# regardless of which project/certs folder generated it, so a different
# project's already-trusted cert would falsely look "already trusted"
# here even though it's a different key entirely. Instead of trying to
# compare thumbprints, we just always remove any existing "mitmproxy"
# entries and add this project's cert fresh - cheap, and guarantees the
# store always reflects the CA this specific proxy instance is using.
certutil -delstore ROOT "mitmproxy" 2>$null | Out-Null
certutil -addstore -f "ROOT" $certFile 2>$null | Out-Null
Write-Host "  [synced] Windows Root store now trusts this project's CA"

$ErrorActionPreference = $previousEAP

# ---- Step 3: trust the cert in every JDK from jdks.txt plus JAVA_HOME (idempotent) ----
#
# jdks.txt is for JDKs that aren't the current environment's default (e.g. a
# server running under a different JAVA_HOME than this interactive shell) -
# JAVA_HOME itself is trusted automatically so the common single-JDK case
# needs no config file entry at all.

Write-Host ""
Write-Host "=== Step 3: JDK certificate trust ==="

$jdkHomes = New-Object System.Collections.Generic.List[string]

if (Test-Path $jdksFile) {
    foreach ($line in Get-Content $jdksFile) {
        $jdkHome = ($line -replace '#.*', '').Trim()
        if (-not [string]::IsNullOrWhiteSpace($jdkHome)) {
            $jdkHomes.Add($jdkHome)
        }
    }
} else {
    Write-Host "  jdks.txt not found - only JAVA_HOME (if set) will be trusted"
}

if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME) -and -not ($jdkHomes -contains $env:JAVA_HOME)) {
    Write-Host "  [detected] JAVA_HOME environment variable -> $env:JAVA_HOME"
    $jdkHomes.Add($env:JAVA_HOME)
}

if ($jdkHomes.Count -eq 0) {
    Write-Host "  No JDKs found - add a path to jdks.txt or set JAVA_HOME if your app needs cert trust"
} else {
    foreach ($jdkHome in $jdkHomes) {
        $keytool = Join-Path $jdkHome "bin\keytool.exe"
        if (-not (Test-Path $keytool)) {
            Write-Host "  [error] keytool not found under $jdkHome - check the path in jdks.txt"
            continue
        }

        # cacerts lives at lib\security\cacerts (JDK 9+) or jre\lib\security\cacerts (JDK 8)
        $cacerts = Join-Path $jdkHome "lib\security\cacerts"
        if (-not (Test-Path $cacerts)) {
            $cacerts = Join-Path $jdkHome "jre\lib\security\cacerts"
        }
        if (-not (Test-Path $cacerts)) {
            Write-Host "  [error] cacerts not found under $jdkHome - check the path in jdks.txt"
            continue
        }

        # keytool sometimes writes harmless warnings to stderr (e.g. "use
        # -cacerts option..."). With $ErrorActionPreference = "Stop" set
        # globally, PowerShell can turn that stderr text into a terminating
        # error even though keytool itself exits 0 - so we relax it just
        # for these calls, then restore it.
        $previousEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"

        # Same issue as the Windows store above: an existing "mitmproxy"
        # alias might belong to a DIFFERENT project's CA (different key,
        # same friendly name), so merely checking the alias exists isn't
        # enough - always delete then reimport to guarantee this project's
        # actual current cert is what ends up trusted.
        & $keytool -delete -alias mitmproxy -keystore $cacerts -storepass changeit 2>$null | Out-Null
        & $keytool -import -alias mitmproxy -trustcacerts -file $certFile -keystore $cacerts -storepass changeit -noprompt 2>$null | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [synced] trusted in $jdkHome"
        } else {
            Write-Host "  [error] failed to import into $jdkHome - check storepass/permissions"
        }

        $ErrorActionPreference = $previousEAP
    }
}

Write-Host ""
Write-Host "Done. Proxy is up. Tail logs with:"
Write-Host "  Get-Content .\proxy\logs\calls.log -Wait -Tail 20"
Write-Host ""
Write-Host "If you added a new JDK trust just now, restart that app/server"
Write-Host "so its JVM re-reads its truststore."
