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
    $ProgressPreference = 'SilentlyContinue'   # Invoke-RestMethod is many times slower while drawing its bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    function Save-AlfredRelease {
        # Downloads $Url to $OutFile over many connections at once. Some lines shape each connection to ~16 KB/s
        # (2026-10-09: 146 MB from GitHub's release CDN took over an hour through Invoke-WebRequest); range requests at
        # once add up: on that line 64 runspaces x 512 KB took 231 s, 192 x 256 KB 86 s. Each runspace keeps its
        # connection and reads pieces from a shared queue, so a slow one never holds back the end; a dropped piece is
        # retried from where it stopped; GitHub's signed redirect expires within minutes, so it is resolved once and
        # again on a 4xx. A server without ranges, or a small file, is read in one stream.
        param([string]$Url, [string]$OutFile, [int]$Connections = 192, [long]$PieceBytes = 256KB)

        [Net.ServicePointManager]::DefaultConnectionLimit = [Math]::Max(64, $Connections * 2)
        [Net.ServicePointManager]::Expect100Continue = $false
        $agent = 'alfred-install'

        $probe = [Net.WebRequest]::CreateHttp($Url)
        $probe.UserAgent = $agent
        $probe.AddRange(0, 0)
        $answer = $probe.GetResponse()
        $total = -1
        if ([int]$answer.StatusCode -eq 206 -and $answer.Headers['Content-Range'] -match '/(\d+)$') { $total = [long]$Matches[1] }
        $final = $answer.ResponseUri.AbsoluteUri
        $answer.Close()

        if ($total -lt 2 * $PieceBytes) {
            $whole = [Net.WebRequest]::CreateHttp($Url)
            $whole.UserAgent = $agent
            $response = $whole.GetResponse()
            $in = $response.GetResponseStream()
            $out = [IO.File]::Create($OutFile)
            try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose(); $response.Close() }
            return
        }

        $stream = [IO.File]::Create($OutFile)
        $stream.SetLength($total)
        $stream.Dispose()
        $pieces = New-Object 'System.Collections.Concurrent.ConcurrentQueue[long]'
        for ($start = 0; $start -lt $total; $start += $PieceBytes) { $pieces.Enqueue($start) }
        $counts = New-Object long[] $Connections  # one slot per worker: a shared array needs no lock for one writer per slot
        $state = [Hashtable]::Synchronized(@{ Final = $final; Errors = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]') })

        $worker = {
            param($Url, $OutFile, $PieceBytes, $Total, $Pieces, $State, $Agent, $Counts, $Index)
            $file = New-Object IO.FileStream($OutFile, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
            $buffer = New-Object byte[] 65536
            try {
                $start = [long]0
                while ($State.Errors.Count -eq 0 -and $Pieces.TryDequeue([ref]$start)) {
                    $end = [Math]::Min($start + $PieceBytes, $Total) - 1
                    $at = $start
                    $delays = @(0, 2, 5, 10)
                    for ($attempt = 0; $attempt -lt $delays.Count; $attempt++) {
                        if ($delays[$attempt]) { Start-Sleep -Seconds $delays[$attempt] }
                        $usedLink = $State.Final
                        try {
                            $request = [Net.WebRequest]::CreateHttp($usedLink)
                            $request.UserAgent = $Agent
                            $request.KeepAlive = $true
                            $request.Timeout = 60000
                            $request.ReadWriteTimeout = 60000
                            $request.AddRange($at, $end)
                            try { $response = $request.GetResponse() } catch [Net.WebException] {
                                $response = $_.Exception.Response
                                if (-not $response) { throw }
                            }
                            $code = [int]$response.StatusCode
                            if ($code -ne 206) {
                                $response.Close()
                                if ($code -ge 400 -and $code -lt 500) {
                                    # the signed link expired, or another worker already renewed it
                                    [Threading.Monitor]::Enter($State.SyncRoot)
                                    try {
                                        if ($State.Final -eq $usedLink) {
                                            $renew = [Net.WebRequest]::CreateHttp($Url)
                                            $renew.UserAgent = $Agent
                                            $renew.AddRange(0, 0)
                                            $fresh = $renew.GetResponse()
                                            $State.Final = $fresh.ResponseUri.AbsoluteUri
                                            $fresh.Close()
                                        }
                                    } finally { [Threading.Monitor]::Exit($State.SyncRoot) }
                                    if ($State.Final -ne $usedLink) { $attempt--; continue }
                                }
                                throw "the server answered $code to a request for bytes $at-$end"
                            }
                            $in = $response.GetResponseStream()
                            try {
                                while ($at -le $end) {
                                    $n = $in.Read($buffer, 0, [int][Math]::Min($buffer.Length, $end + 1 - $at))
                                    if ($n -le 0) { break }
                                    $file.Seek($at, [IO.SeekOrigin]::Begin) | Out-Null
                                    $file.Write($buffer, 0, $n)
                                    $at += $n
                                    $Counts[$Index] += $n
                                }
                            } finally { $in.Dispose(); $response.Close() }
                            if ($at -gt $end) { break }
                            throw "the connection closed at byte $at of $start-$end"
                        } catch {
                            if ($attempt -eq $delays.Count - 1) { $State.Errors.Enqueue("$($_.Exception.Message)"); return }
                        }
                    }
                }
            } finally { $file.Dispose() }
        }

        $pool = [RunspaceFactory]::CreateRunspacePool(1, $Connections)
        $pool.Open()
        $jobs = @()
        for ($i = 0; $i -lt $Connections; $i++) {
            $ps = [PowerShell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript($worker).AddArgument($Url).AddArgument($OutFile).AddArgument($PieceBytes).AddArgument($total).AddArgument($pieces).AddArgument($state).AddArgument($agent).AddArgument($counts).AddArgument($i)
            $jobs += @{ Shell = $ps; Handle = $ps.BeginInvoke() }
        }
        $started = [DateTime]::UtcNow
        $told = $started
        try {
            while ($true) {
                $busy = @($jobs | Where-Object { -not $_.Handle.IsCompleted }).Count
                $now = [DateTime]::UtcNow
                if ($busy -eq 0) { break }
                if (($now - $told).TotalSeconds -ge 1) {
                    $told = $now
                    $done = [long]0
                    foreach ($c in $counts) { $done += $c }
                    $rate = $done / [Math]::Max(1, ($now - $started).TotalSeconds) / 1MB
                    Write-Host ("`r   {0} of {1} MB  {2:0.0} MB/s   " -f [int]($done / 1MB), [int]($total / 1MB), $rate) -NoNewline
                }
                Start-Sleep -Milliseconds 200
            }
            Write-Host ''
            foreach ($job in $jobs) { try { $job.Shell.EndInvoke($job.Handle) | Out-Null } catch { $state.Errors.Enqueue("$($_.Exception.Message)") } }
        } finally {
            foreach ($job in $jobs) { $job.Shell.Dispose() }
            $pool.Dispose()
        }
        $first = ''
        if ($state.Errors.TryDequeue([ref]$first)) { throw "download failed: $first" }
        $done = [long]0
        foreach ($c in $counts) { $done += $c }
        if ($done -ne $total) { throw "downloaded $done of $total bytes" }
    }

    $manifestUrl = if ($env:ALFRED_RELEASE_URL) { $env:ALFRED_RELEASE_URL } else { 'https://github.com/f-Baiomy/ALFRED/releases/latest/download/latest.json' }
    $target = 'windows-x64'

    # The test suite runs the download alone (tests/python/test_install_scripts.py): the URL and the file to write.
    if ($env:ALFRED_INSTALL_FETCH_ONLY) {
        Save-AlfredRelease -Url $env:ALFRED_INSTALL_FETCH_ONLY -OutFile $env:ALFRED_INSTALL_FETCH_TO
        return
    }

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
        Save-AlfredRelease -Url $asset.url -OutFile $file

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
