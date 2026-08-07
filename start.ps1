# start.ps1 - Windows entry point.
#
# Idempotent - safe to run every time. On each run it:
#   1. Adds any missing "-proxy" hosts entries from suppliers.txt
#   2. Starts the proxy with "docker compose up -d" (generates the CA
#      cert on first run)
#   3. Trusts that CA cert in the Windows Root store, if not already
#      trusted
#   4. Trusts that CA cert in every JDK listed in jdks.txt, if not
#      already trusted there
#
# Run this INSTEAD OF "docker compose up" directly, from an Administrator
# PowerShell window:
#   .\start.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suppliersFile = Join-Path $scriptDir "suppliers.txt"
$jdksFile = Join-Path $scriptDir "jdks.txt"
$certFile = Join-Path $scriptDir "proxy\certs\mitmproxy-ca-cert.pem"
$hostsFile = "$env:windir\System32\drivers\etc\hosts"

# ---- Admin check (needed for hosts file + Windows cert store) ----

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This needs Administrator rights (hosts file + certificate store)."
    Write-Host "Re-run this script from an Administrator PowerShell window."
    exit 1
}

# ---- Step 1: hosts file entries from suppliers.txt ----

if (-not (Test-Path $suppliersFile)) {
    Write-Host "suppliers.txt not found at $suppliersFile"
    exit 1
}

Write-Host "=== Step 1: hosts file ==="
$hostsContent = Get-Content $hostsFile

foreach ($line in Get-Content $suppliersFile) {
    $domain = ($line -replace '#.*', '').Trim()
    if ([string]::IsNullOrWhiteSpace($domain)) { continue }

    $proxyHost = "$domain-proxy"
    $alreadyPresent = $hostsContent | Where-Object { $_ -match "\s$([regex]::Escape($proxyHost))(\s|$)" }

    if ($alreadyPresent) {
        Write-Host "  [skip]  $proxyHost already present"
    } else {
        Add-Content -Path $hostsFile -Value "127.0.0.1   $proxyHost"
        Write-Host "  [added] 127.0.0.1   $proxyHost"
    }
}

# ---- Step 2: start all services (proxy, backend, frontend) ----

Write-Host ""
Write-Host "=== Step 2: docker compose up (alfred, pennyworth, manor) ==="
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
    Write-Host "Certificate not found at $certFile after waiting - check 'docker compose logs alfred'."
    exit 1
}

# ---- Step 3: trust the cert in the Windows Root store ----

Write-Host ""
Write-Host "=== Step 3: Windows certificate trust ==="

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

# ---- Step 4: trust the cert in every JDK listed in jdks.txt (idempotent) ----

Write-Host ""
Write-Host "=== Step 4: JDK certificate trust ==="

if (-not (Test-Path $jdksFile)) {
    Write-Host "  jdks.txt not found - skipping JDK trust step"
} else {
    $anyJdk = $false
    foreach ($line in Get-Content $jdksFile) {
        $jdkHome = ($line -replace '#.*', '').Trim()
        if ([string]::IsNullOrWhiteSpace($jdkHome)) { continue }
        $anyJdk = $true

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
    if (-not $anyJdk) {
        Write-Host "  jdks.txt is empty - add JAVA_HOME paths there if your app needs cert trust"
    }
}

Write-Host ""
Write-Host "Done. Proxy is up. Tail logs with:"
Write-Host "  Get-Content .\proxy\logs\calls.log -Wait -Tail 20"
Write-Host ""
Write-Host "If you added a new JDK trust just now, restart that app/server"
Write-Host "so its JVM re-reads its truststore."
