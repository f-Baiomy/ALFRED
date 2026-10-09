# install.ps1 - installs (or upgrades) Alfred on a Windows machine that has never seen it, in one command, from an
# administrator PowerShell:
#
#   irm https://raw.githubusercontent.com/f-Baiomy/ALFRED/master/install.ps1 | iex
#
# Reads the latest release's latest.json, checks this machine (an install to upgrade, disk space, the UI and proxy
# ports) BEFORE downloading, downloads the Windows installer it names - or takes it from the download cache
# (C:\ProgramData\Alfred\downloads, sha256 checked again) -, runs it silently (/S) and shows where Alfred answers.
# Installer options go in $env:ALFRED_INSTALL_ARGS, e.g. '/DIR=D:\alfred /UIPORT=3017'.
# $env:ALFRED_RELEASE_URL points at another latest.json (a mirror or a share for a machine without GitHub access).
# Works on Windows PowerShell 5.1; the installer brings its own Java, Python and Node.
#
# Output: a step list that ticks off, in colour, with one live line - plain lines (one per finished step, no redraws)
# when the output is redirected, NO_COLOR is set or TERM=dumb. Unicode symbols in Windows Terminal and VS Code, ASCII in
# the classic console (its font has no spinner glyphs). This file stays ASCII: every symbol is built from its code
# point, so it reads the same however `irm` decodes it.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-RestMethod is many times slower while drawing its bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    # Before the FIRST request: .NET allows 2 connections per host by default, and a host's limit is fixed when it is
    # first contacted. latest.json redirects to the same file server as the installer, so raising the limit later (in
    # Save-AlfredRelease) left the download on 2-3 connections: 0.2 MB/s instead of 2 MB/s (3.0.6, 2026-10-09). Tests
    # missed it - their hosts were 127.0.0.1, which .NET never limits, or they skipped reading latest.json.
    [Net.ServicePointManager]::DefaultConnectionLimit = 512

    # ---- output ------------------------------------------------------------------------------------------------
    $plain = [Console]::IsOutputRedirected -or [bool]$env:NO_COLOR -or $env:TERM -eq 'dumb'
    $modern = [bool]($env:WT_SESSION -or $env:TERM_PROGRAM)
    function Sym([int]$code) { [string][char]$code }
    if ($modern -and -not $plain) {
        $G = @{ ok = (Sym 0x2713); fail = (Sym 0x2717); warn = '!'; wait = (Sym 0x25CB); brand = (Sym 0x25C6); dot = (Sym 0x00B7)
                full = (Sym 0x2501); empty = (Sym 0x2500); retry = (Sym 0x21BB); arrow = (Sym 0x2192); more = (Sym 0x2026)
                spin = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F | ForEach-Object { [string][char]$_ })
                tl = (Sym 0x256D); tr = (Sym 0x256E); bl = (Sym 0x2570); br = (Sym 0x256F); h = (Sym 0x2500); v = (Sym 0x2502) }
    } else {
        $G = @{ ok = '+'; fail = 'x'; warn = '!'; wait = 'o'; brand = '<>'; dot = '-'; full = '#'; empty = '-'; retry = '~'; arrow = '->'; more = '...'
                spin = @('|', '/', '-', '\'); tl = '+'; tr = '+'; bl = '+'; br = '+'; h = '-'; v = '|' }
    }
    $esc = [string][char]27
    $bel = [string][char]7
    $labelWidth = 17
    $script:frame = 0
    $script:windowTitle = try { $Host.UI.RawUI.WindowTitle } catch { '' }
    # Text is written with colour markers: '{dim}', '{hi}', '{ok}', '{red}', '{warn}', '{cyan}', '{def}'.
    $colors = @{ dim = 'DarkGray'; hi = 'White'; ok = 'Green'; red = 'Red'; warn = 'Yellow'; cyan = 'Cyan'; def = '' }
    $marker = '\{(dim|hi|ok|red|warn|cyan|def)\}'

    function Get-Width { try { [Math]::Max(40, $Host.UI.RawUI.WindowSize.Width) } catch { 120 } }
    function Strip([string]$text) { $text -replace $marker, '' }

    # One line of marked-up text. -Live rewrites the current line (`r) and is cut to the window, so it never wraps.
    function Write-Line([string]$text, [switch]$Live) {
        if ($plain) { if (-not $Live) { Write-Host (Strip $text) }; return }
        $room = (Get-Width) - 1
        if ($Live) { Write-Host "`r" -NoNewline }
        $color = ''
        foreach ($part in ([regex]::Split($text, $marker))) {
            if ($colors.ContainsKey($part)) { $color = $colors[$part]; continue }
            if ($Live) {
                if ($room -le 0) { break }
                if ($part.Length -gt $room) { $part = $part.Substring(0, [Math]::Max(0, $room - 3)) + '...' }
                $room -= $part.Length
            }
            if ($color) { Write-Host $part -NoNewline -ForegroundColor $color } else { Write-Host $part -NoNewline }
        }
        if ($Live) { Write-Host (' ' * [Math]::Max(0, $room)) -NoNewline } else { Write-Host '' }
    }

    # The window title, and in Windows Terminal the taskbar icon (OSC 9;4: 1 = percent, 3 = busy, 2 = error, 0 = off).
    function Set-Progress([int]$state, [int]$percent = 0, [string]$text = '') {
        if ($plain) { return }
        if ($text) { try { $Host.UI.RawUI.WindowTitle = $text } catch { } }
        if ($env:WT_SESSION) { [Console]::Write("$esc]9;4;$state;$percent$bel") }
    }
    function Reset-Progress {
        if ($plain) { return }
        try { $Host.UI.RawUI.WindowTitle = $script:windowTitle } catch { }
        if ($env:WT_SESSION) { [Console]::Write("$esc]9;4;0;0$bel") }
    }

    function Step-Run([string]$label, [string]$detail) {
        if ($script:stepLabel -ne $label) { $script:stepStarted = [DateTime]::UtcNow }
        $script:stepLabel = $label
        $script:frame++
        Write-Line -Live "{cyan}  $($G.spin[$script:frame % $G.spin.Count]) {hi}$($label.PadRight($labelWidth)) {dim}$detail"
    }
    function Step-Seconds { ([DateTime]::UtcNow - $script:stepStarted).TotalSeconds }
    function Step-End([string]$mark, [string]$color, [string]$word, [string]$label, [string]$detail, [string[]]$hints) {
        $script:stepLabel = ''
        if ($plain) {
            Write-Host ('  {0} {1} {2}' -f $word, $label.PadRight($labelWidth), (Strip $detail)).TrimEnd()
            foreach ($h in $hints) { Write-Host "         $(Strip $h)" }
            return
        }
        Write-Host "`r$(' ' * ((Get-Width) - 1))`r" -NoNewline
        $name = if ($word -eq 'ok  ') { "{def}$($label.PadRight($labelWidth))" } else { "{hi}$($label.PadRight($labelWidth))" }
        Write-Line "{$color}  $mark $name {dim}$detail"
        foreach ($h in $hints) { Write-Line "      {dim}$h" }
    }
    function Step-Done([string]$label, [string]$detail) { Step-End $G.ok 'ok' 'ok  ' $label $detail @() }
    function Step-Fail([string]$label, [string]$detail, [string[]]$hints) { Step-End $G.fail 'red' 'FAIL' $label $detail $hints; Set-Progress 2 100 }
    function Step-Warn([string]$label, [string]$detail, [string[]]$hints) { Step-End $G.warn 'warn' 'WARN' $label $detail $hints }

    function Format-Bar([double]$fraction, [int]$width = 24) {
        $n = [int][Math]::Round([Math]::Max(0, [Math]::Min(1, $fraction)) * $width)
        if ($G.full -eq '#') { return '{cyan}[' + ('#' * $n) + '{dim}' + ('-' * ($width - $n)) + ']' }
        return '{cyan}' + ($G.full * $n) + '{dim}' + ($G.empty * ($width - $n))
    }
    function Format-Duration([double]$s) {
        if ($s -lt 10) { return ('{0:0.0} s' -f $s) }
        if ($s -lt 60) { return ('{0:0} s' -f $s) }
        return ('{0} min {1} s' -f [int][Math]::Floor($s / 60), [int]($s % 60))
    }
    function Format-MB([long]$bytes) { '{0:0}' -f ($bytes / 1MB) }
    function Write-Box([string]$heading, [string[]]$rows) {
        $w = (@($heading.Length + 4) + @($rows | ForEach-Object { (Strip $_).Length }) | Measure-Object -Maximum).Maximum + 4
        Write-Line "{cyan}  $($G.tl)$($G.h) {hi}$heading{cyan} $($G.h * ($w - $heading.Length - 3))$($G.tr)"
        foreach ($r in $rows) { Write-Line "{cyan}  $($G.v)  {def}$r$(' ' * ($w - 2 - (Strip $r).Length)){cyan}$($G.v)" }
        Write-Line "{cyan}  $($G.bl)$($G.h * $w)$($G.br)"
    }

    # ---- download -----------------------------------------------------------------------------------------------
    function Save-AlfredRelease {
        # Downloads $Url to $OutFile over many connections at once. Some lines shape each connection to ~16 KB/s
        # (2026-10-09: 146 MB from GitHub's release CDN took over an hour through Invoke-WebRequest); range requests at
        # once add up: on that line 64 runspaces x 512 KB took 231 s, 192 x 256 KB 86 s. Each runspace keeps its
        # connection and reads pieces from a shared queue, so a slow one never holds back the end; a dropped piece is
        # retried from where it stopped; GitHub's signed redirect expires within minutes, so it is resolved once and
        # again on a 4xx. A server without ranges, or a small file, is read in one stream.
        # -OnProgress is called a few times a second with (bytes done, total, pieces retried). Returns
        # @{ Bytes; Connections; Retries }.
        param([string]$Url, [string]$OutFile, [scriptblock]$OnProgress, [int]$Connections = 192, [long]$PieceBytes = 256KB)

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
        # And on the pools themselves: a host already contacted keeps the limit it had then (see the top of the script).
        foreach ($uri in @($Url, $final)) {
            $point = [Net.ServicePointManager]::FindServicePoint([Uri]$uri)
            if ($point.ConnectionLimit -lt $Connections * 2) { $point.ConnectionLimit = $Connections * 2 }
        }

        if ($total -lt 2 * $PieceBytes) {
            $whole = [Net.WebRequest]::CreateHttp($Url)
            $whole.UserAgent = $agent
            $response = $whole.GetResponse()
            $length = $response.ContentLength
            $in = $response.GetResponseStream()
            $out = [IO.File]::Create($OutFile)
            $buffer = New-Object byte[] 65536
            $got = [long]0
            $told = [DateTime]::UtcNow
            try {
                while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $out.Write($buffer, 0, $n)
                    $got += $n
                    if ($OnProgress -and ([DateTime]::UtcNow - $told).TotalMilliseconds -ge 150) { $told = [DateTime]::UtcNow; & $OnProgress $got $length 0 }
                }
            } finally { $out.Dispose(); $in.Dispose(); $response.Close() }
            return @{ Bytes = $got; Connections = 1; Retries = 0 }
        }

        $stream = [IO.File]::Create($OutFile)
        $stream.SetLength($total)
        $stream.Dispose()
        $pieces = New-Object 'System.Collections.Concurrent.ConcurrentQueue[long]'
        for ($start = 0; $start -lt $total; $start += $PieceBytes) { $pieces.Enqueue($start) }
        $counts = New-Object long[] $Connections  # one slot per worker: a shared array needs no lock for one writer per slot
        $retried = New-Object long[] $Connections
        $state = [Hashtable]::Synchronized(@{ Final = $final; Errors = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]') })

        $worker = {
            param($Url, $OutFile, $PieceBytes, $Total, $Pieces, $State, $Agent, $Counts, $Index, $Retried)
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
                            $Retried[$Index] += 1
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
            [void]$ps.AddScript($worker).AddArgument($Url).AddArgument($OutFile).AddArgument($PieceBytes).AddArgument($total).AddArgument($pieces).AddArgument($state).AddArgument($agent).AddArgument($counts).AddArgument($i).AddArgument($retried)
            $jobs += @{ Shell = $ps; Handle = $ps.BeginInvoke() }
        }
        try {
            while (@($jobs | Where-Object { -not $_.Handle.IsCompleted }).Count) {
                if ($OnProgress) {
                    $done = [long]0
                    foreach ($c in $counts) { $done += $c }
                    $again = [long]0
                    foreach ($r in $retried) { $again += $r }
                    & $OnProgress $done $total $again
                }
                Start-Sleep -Milliseconds 150
            }
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
        $again = [long]0
        foreach ($r in $retried) { $again += $r }
        return @{ Bytes = $done; Connections = $Connections; Retries = $again }
    }

    # ---- this machine --------------------------------------------------------------------------------------------
    function Get-InstallArg([string]$name) {
        if ($env:ALFRED_INSTALL_ARGS -match "(?i)/$name=(`"[^`"]*`"|\S+)") { return $Matches[1].Trim('"') }
        return ''
    }
    function Get-EnvValue([string]$dir, [string]$key) {
        $file = Join-Path $dir '.env'
        try {
            foreach ($line in [IO.File]::ReadAllLines($file)) { if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim() } }
        } catch { }
        return ''
    }
    # Who listens on a TCP port (on one of $addresses, or any): @{ Name; Pid; Path } or $null.
    function Get-PortOwner([int]$port, [string[]]$addresses) {
        try {
            $listen = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
                Where-Object { -not $addresses -or $addresses -contains $_.LocalAddress } | Select-Object -First 1
        } catch { return $null }
        if (-not $listen) { return $null }
        $proc = Get-Process -Id $listen.OwningProcess -ErrorAction SilentlyContinue
        $path = try { $proc.Path } catch { '' }
        return @{ Name = $(if ($proc) { "$($proc.ProcessName).exe" } else { 'a process' }); Pid = $listen.OwningProcess; Path = "$path" }
    }
    function Get-Addresses([int]$port) {
        $list = @("http://localhost:$port")
        try {
            Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
                ForEach-Object { $list += "http://$($_.IPAddress):$port" }
        } catch { }
        return $list
    }

    $manifestUrl = if ($env:ALFRED_RELEASE_URL) { $env:ALFRED_RELEASE_URL } else { 'https://github.com/f-Baiomy/ALFRED/releases/latest/download/latest.json' }
    $target = 'windows-x64'

    # The test suite runs the download alone (tests/python/test_install_scripts.py): the URL and the file to write.
    if ($env:ALFRED_INSTALL_FETCH_ONLY) {
        Save-AlfredRelease -Url $env:ALFRED_INSTALL_FETCH_ONLY -OutFile $env:ALFRED_INSTALL_FETCH_TO | Out-Null
        return
    }

    $began = [DateTime]::UtcNow
    Write-Line ''
    Write-Line "  {cyan}$($G.brand) {hi}Alfred{dim}  installer $($G.dot) HTTP traffic in and out of your Java app"
    Write-Line ''
    try {
        # -- checks that need nothing downloaded ----------------------------------------------------------------
        Step-Run 'Administrator' 'checking'
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Step-Fail 'Administrator' 'no - the installer registers a Windows service' @('Open PowerShell with "Run as administrator" and run the one-liner again.')
            return
        }
        if (-not [Environment]::Is64BitOperatingSystem) {
            Step-Fail 'Administrator' 'yes, but only 64-bit Windows has an installer' @()
            return
        }
        Step-Done 'Administrator' "yes $($G.dot) 64-bit Windows $($G.dot) PowerShell $($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)"

        Step-Run 'Latest release' 'reading latest.json'
        try {
            $manifest = Invoke-RestMethod -UseBasicParsing $manifestUrl
        } catch {
            Step-Fail 'Latest release' "could not read $manifestUrl" @("$($_.Exception.Message)", 'Is a release published? Another source: $env:ALFRED_RELEASE_URL = <a latest.json>')
            return
        }
        $asset = $manifest.assets.$target
        if (-not $asset -or -not $asset.url -or -not $asset.sha256) {
            Step-Fail 'Latest release' "Alfred $($manifest.version) has no $target installer" @()
            return
        }
        $size = [long]$(if ($asset.size) { $asset.size } else { 0 })
        Step-Done 'Latest release' ("{hi}Alfred $($manifest.version){dim}" + $(if ($manifest.publishedAt) { " $($G.dot) released $($manifest.publishedAt)" } else { '' }) + $(if ($size) { " $($G.dot) $(Format-MB $size) MB" } else { '' }))

        Step-Run 'Existing install' 'looking for Alfred'
        $key = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Alfred'
        $old = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        $dir = Get-InstallArg 'DIR'
        if (-not $dir) { $dir = if ($old -and $old.InstallLocation) { $old.InstallLocation } else { 'C:\alfred' } }
        $oldVersion = if ($old) { "$($old.DisplayVersion)" } else { '' }
        if (-not $oldVersion) {
            Step-Done 'Existing install' "none $($G.dot) installing into $dir"
        } elseif ($oldVersion -eq "$($manifest.version)") {
            Step-Done 'Existing install' "{hi}Alfred $oldVersion{dim} in $dir $($G.arrow) the same version: its program files are put back fresh, settings and data kept"
        } else {
            Step-Done 'Existing install' "{hi}Alfred $oldVersion{dim} in $dir $($G.arrow) {cyan}upgrade{dim} to $($manifest.version), settings and data kept"
        }

        Step-Run 'Disk space' 'checking'
        $drive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($dir))
        $need = [Math]::Max(700MB, $size * 5)  # the installer, its unpacked runtimes, the previous version kept aside
        try { $free = (New-Object IO.DriveInfo $drive).AvailableFreeSpace } catch { $free = -1 }
        if ($free -ge 0 -and $free -lt $need) {
            Step-Fail 'Disk space' ('{0:0.0} GB free on {1} - needs about {2:0.0} GB' -f ($free / 1GB), $drive.TrimEnd('\'), ($need / 1GB)) @('Free some space, or install on another drive: $env:ALFRED_INSTALL_ARGS = ''/DIR=D:\alfred''')
            return
        }
        Step-Done 'Disk space' $(if ($free -ge 0) { '{0:0.0} GB free on {1} {3} needs about {2:0.0} GB' -f ($free / 1GB), $drive.TrimEnd('\'), ($need / 1GB), $G.dot } else { "could not be read for $drive - continuing" })

        $uiPort = [int]$(if (Get-InstallArg 'UIPORT') { Get-InstallArg 'UIPORT' } elseif (Get-EnvValue $dir 'ALFRED_UI_PORT') { Get-EnvValue $dir 'ALFRED_UI_PORT' } else { 3000 })
        $proxyListen = Get-EnvValue $dir 'ALFRED_OUTBOUND_PROXY_LISTEN'
        if (-not $proxyListen) { $proxyListen = '127.0.0.2:443' }
        $proxyHost, $proxyPort = $proxyListen -split ':(?=\d+$)'
        Step-Run 'Ports' "who listens on $uiPort (UI) and $proxyPort (outbound proxy)"
        $ours = { param($owner) $owner.Path -and $owner.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
        $uiOwner = Get-PortOwner $uiPort @()
        $proxyOwner = Get-PortOwner ([int]$proxyPort) @($proxyHost, '0.0.0.0', '::')
        if ($uiOwner -and -not (& $ours $uiOwner)) {
            Step-Fail 'Ports' "{red}$uiPort is in use by {hi}$($uiOwner.Name) (pid $($uiOwner.Pid)){red}" @(
                "{dim}Alfred's UI needs it. Stop that program, or pick another port:",
                "{cyan}`$env:ALFRED_INSTALL_ARGS = '/UIPORT=3017'{dim}; then the one-liner again",
                '', '{hi}Stopped before downloading{dim} - nothing changed on this machine.')
            return
        }
        $portNote = if ($uiOwner -or $proxyOwner) { "held by Alfred $oldVersion $($G.dot) freed during the upgrade" } else { 'free' }
        if ($proxyOwner -and -not (& $ours $proxyOwner)) {
            Step-Warn 'Ports' "$uiPort $portNote $($G.dot) {warn}$proxyPort is in use by $($proxyOwner.Name) (pid $($proxyOwner.Pid))" @(
                "The outbound proxy ($proxyListen) won't start until it is free, or move it after installing:",
                "{cyan}alfred config set ALFRED_OUTBOUND_PROXY_LISTEN 127.0.0.2:8443")
        } else {
            Step-Done 'Ports' "$uiPort and $proxyPort $portNote"
        }

        # -- the installer: from the cache, or downloaded into it ------------------------------------------------
        $cache = Join-Path $env:ProgramData 'Alfred\downloads'
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $file = Join-Path $cache "alfred-setup-$($manifest.version)-$target.exe"
        $expected = "$($asset.sha256)".ToLowerInvariant()
        $cached = (Test-Path $file) -and ((Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant() -eq $expected)
        if ($cached) {
            $age = [int]([DateTime]::Now - (Get-Item $file).LastWriteTime).TotalMinutes
            Step-Done 'Downloading' ("{cyan}already here{dim} $($G.dot) cached " + $(if ($age -lt 90) { "$age min ago" } else { (Get-Item $file).LastWriteTime.ToString('yyyy-MM-dd') }) + " $($G.dot) $cache")
            Step-Done 'Checksum' 'matches the release (checked again)'
        } else {
            $part = "$file.part"
            Step-Run 'Downloading' 'starting'
            Set-Progress 1 0 "0% $($G.dot) Downloading Alfred $($manifest.version)"
            $script:samples = New-Object System.Collections.Generic.List[object]
            $progress = {
                param($done, $total, $retries)
                $now = [DateTime]::UtcNow
                $script:samples.Add(@($now, $done))
                while ($script:samples.Count -gt 2 -and ($now - $script:samples[0][0]).TotalSeconds -gt 5) { $script:samples.RemoveAt(0) }
                $span = ($now - $script:samples[0][0]).TotalSeconds
                $rate = if ($span -gt 0.5) { ($done - $script:samples[0][1]) / $span } else { 0 }
                $f = if ($total -gt 0) { $done / $total } else { 0 }
                $text = (Format-Bar $f) + '{hi} ' + ('{0,3:0}%' -f ($f * 100)) + '{dim}  ' + ('{0} of {1} MB' -f (Format-MB $done), (Format-MB $total))
                if ($rate -gt 0) { $text += " $($G.dot) {0:0.0} MB/s $($G.dot) {1} s left" -f ($rate / 1MB), [int](($total - $done) / $rate) }
                if ($retries -gt 0) { $text += " $($G.dot) {warn}$($G.retry) $retries retried" }
                Step-Run 'Downloading' $text
                Set-Progress 1 ([int]($f * 100)) ("{0:0}% $($G.dot) Downloading Alfred $($manifest.version)" -f ($f * 100))
            }
            try {
                $result = Save-AlfredRelease -Url $asset.url -OutFile $part -OnProgress $progress
            } catch {
                Remove-Item -Force $part -ErrorAction SilentlyContinue
                Step-Fail 'Downloading' "$($_.Exception.Message)" @('Nothing was installed. Run the one-liner again; dropped pieces are retried, a stall gives up after 4 tries.')
                return
            }
            $took = Step-Seconds
            Step-Done 'Downloading' ("$(Format-MB $result.Bytes) MB in $(Format-Duration $took)" + $(if ($took -gt 0) { " $($G.dot) {0:0.0} MB/s" -f ($result.Bytes / 1MB / $took) } else { '' }) +
                                     $(if ($result.Connections -gt 1) { " $($G.dot) $($result.Connections) connections" } else { '' }) +
                                     $(if ($result.Retries) { " $($G.dot) $($result.Retries) pieces retried" } else { '' }))
            Step-Run 'Checksum' 'sha256'
            Set-Progress 3 0 "Checking Alfred $($manifest.version)"
            $actual = (Get-FileHash -Algorithm SHA256 -Path $part).Hash.ToLowerInvariant()
            if ($actual -ne $expected) {
                Remove-Item -Force $part -ErrorAction SilentlyContinue
                Step-Fail 'Checksum' 'does not match the release' @("expected {hi}$expected", "got      {red}$actual", '',
                    '{hi}Nothing was installed{dim} - the download was deleted. Try again in a minute; if it keeps happening, a proxy or',
                    'antivirus may be changing the file: $env:ALFRED_RELEASE_URL = a mirror''s latest.json, then the one-liner again.')
                return
            }
            Move-Item -Force $part $file
            Step-Done 'Checksum' "$($expected.Substring(0, 8))$($G.more)$($expected.Substring($expected.Length - 6)) matches the release"
            # Keep the newest two installers: a failed install, or the one-liner run again, needs no download.
            Get-ChildItem $cache -Filter 'alfred-setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }

        # -- install ---------------------------------------------------------------------------------------------
        $installerArgs = @('/S')
        if ($env:ALFRED_INSTALL_ARGS) { $installerArgs += $env:ALFRED_INSTALL_ARGS -split '\s+' | Where-Object { $_ } }
        $doing = if ($oldVersion) { "stopping Alfred $oldVersion, replacing its files" } else { 'unpacking Java, Python and Node, registering the service' }
        Set-Progress 3 0 "Installing Alfred $($manifest.version)"
        Step-Run 'Installing' $doing
        $process = Start-Process -FilePath $file -ArgumentList $installerArgs -PassThru
        while (-not $process.HasExited) {
            Start-Sleep -Milliseconds 120
            if (-not $plain) { Step-Run 'Installing' "$doing $($G.dot) $([int](Step-Seconds)) s" }
        }
        $process.WaitForExit()
        $installed = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($installed -and $installed.InstallLocation) { $dir = $installed.InstallLocation }
        $uiPort = [int]$(if (Get-EnvValue $dir 'ALFRED_UI_PORT') { Get-EnvValue $dir 'ALFRED_UI_PORT' } else { $uiPort })
        if ($process.ExitCode -eq 1) {
            Step-Done 'Installing' "$dir $($G.dot) $(Format-Duration (Step-Seconds))"
            Step-Fail 'Alfred answers' "no - its service started, but it did not answer on port $uiPort within 60 s" @(
                'From an Administrator prompt: {cyan}alfred status{dim}, {cyan}alfred logs supervisor')
            return
        }
        if ($process.ExitCode -ne 0) {
            $back = if ($oldVersion) { " Alfred $oldVersion was put back and keeps running." } else { ' Nothing was left installed.' }
            Step-Fail 'Installing' "the installer stopped with exit code $($process.ExitCode).$back" @(
                "The installer is kept in the cache: running the one-liner again skips the download.")
            return
        }
        Step-Done 'Installing' "$dir $($G.dot) $(Format-Duration (Step-Seconds))"

        Step-Run 'Alfred answers' "http://localhost:$uiPort"
        try {
            $status = Invoke-RestMethod -UseBasicParsing "http://localhost:$uiPort/server/status" -TimeoutSec 10
            Step-Done 'Alfred answers' "on port $uiPort $($G.dot) $(@($status.processes).Count) processes"
        } catch {
            Step-Warn 'Alfred answers' "the installer saw it answer, this check did not ($($_.Exception.Message))" @('{cyan}alfred status{dim} shows what runs.')
        }
        Reset-Progress
        Set-Progress 0 0 "$($G.ok) Alfred $($manifest.version) installed"

        Write-Line ''
        $heading = if ($oldVersion -and $oldVersion -ne "$($manifest.version)") { "Alfred $oldVersion $($G.arrow) $($manifest.version) is running" } else { "Alfred $($manifest.version) is running" }
        $addresses = Get-Addresses $uiPort
        $rows = @("{dim}UI       {cyan}$($addresses[0])")
        foreach ($a in ($addresses | Select-Object -Skip 1)) { $rows += "         {cyan}$a" }
        if ($oldVersion) { $rows += '{dim}Kept     {def}settings and recorded data' }
        $rows += "{dim}Next     {hi}alfred status{dim} $($G.dot) {hi}alfred jvms{dim} $($G.dot) {hi}alfred attach <pid>"
        $rows += "{dim}Took     {def}$(Format-Duration ([DateTime]::UtcNow - $began).TotalSeconds)"
        Write-Box $heading $rows

        # Enter opens the UI - only when someone is there to press it (and never longer than a minute).
        if (-not $plain -and -not [Console]::IsInputRedirected) {
            Write-Line ''
            Write-Line "  {hi}Enter{dim} opens the UI in your browser $($G.dot) any other key finishes"
            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            while ([DateTime]::UtcNow -lt $deadline -and -not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 100 }
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq 'Enter') {
                    Start-Process $addresses[0]
                    Write-Line "  {ok}$($G.ok){dim} opened $($addresses[0])"
                }
            }
        }
    } finally {
        Reset-Progress
    }
}
