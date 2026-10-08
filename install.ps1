# install.ps1 - installs (or upgrades) Alfred on a Windows machine that has never seen it, in one command, from an
# administrator PowerShell:
#
#   irm https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.ps1 | iex
#
# Reads the latest release's latest.json, downloads the Windows installer it names, checks its sha256 and runs it
# silently (/S). Installer options go in $env:ALFRED_INSTALL_ARGS, e.g. '/DIR=D:\alfred /UIPORT=3017'.
# $env:ALFRED_RELEASE_URL points at another latest.json (a mirror or a share for a machine without GitHub access).
# Works on Windows PowerShell 5.1; the installer brings its own Java, Python and Node.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower while drawing its bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $manifestUrl = if ($env:ALFRED_RELEASE_URL) { $env:ALFRED_RELEASE_URL } else { 'https://github.com/f-Baiomy/ALFRED/releases/latest/download/latest.json' }
    $target = 'windows-x64'

    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'alfred install: run this from an administrator PowerShell - the installer registers a Windows service.' -ForegroundColor Red
        return
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        Write-Host 'alfred install: only 64-bit Windows has an installer.' -ForegroundColor Red
        return
    }

    Write-Host ">> reading $manifestUrl"
    try {
        $manifest = Invoke-RestMethod -UseBasicParsing $manifestUrl
    } catch {
        Write-Host "alfred install: could not read $manifestUrl - is a release published? ($($_.Exception.Message))" -ForegroundColor Red
        return
    }
    $asset = $manifest.assets.$target
    if (-not $asset -or -not $asset.url -or -not $asset.sha256) {
        Write-Host "alfred install: the release has no $target installer." -ForegroundColor Red
        return
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('alfred-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $file = Join-Path $work "alfred-setup-$($manifest.version)-$target.exe"
        Write-Host ">> downloading Alfred $($manifest.version)"
        Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $file

        $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
        if ($actual -ne $asset.sha256.ToLowerInvariant()) {
            Write-Host "alfred install: checksum mismatch - expected $($asset.sha256), got $actual. Nothing was installed." -ForegroundColor Red
            return
        }
        Write-Host '>> checksum ok'

        $installerArgs = @('/S')
        if ($env:ALFRED_INSTALL_ARGS) { $installerArgs += $env:ALFRED_INSTALL_ARGS -split '\s+' | Where-Object { $_ } }
        Write-Host '>> running the installer'
        $process = Start-Process -FilePath $file -ArgumentList $installerArgs -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            Write-Host "alfred install: the installer exited with $($process.ExitCode)." -ForegroundColor Red
            return
        }
        Write-Host '>> Alfred is installed. Run "alfred status" in a new terminal for its address.' -ForegroundColor Green
    } finally {
        Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
    }
}
