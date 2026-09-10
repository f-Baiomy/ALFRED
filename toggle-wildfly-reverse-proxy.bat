@echo off
REM Flips ONE named project's reverse-proxy traffic logging on/off live - no docker restart,
REM no upstream restart.
REM
REM reverse-proxy (see docker-compose.yml) always owns its per-project listen ports and always
REM forwards each request (by the port it arrived on, per REVERSE_PROXY_PORT_MAP) to that
REM project's upstream - that part never stops, so every project it fronts keeps working either
REM way. This script only flips whether the addon also logs a given NAME's calls to backend, by
REM writing/updating a
REM "name=on"/"name=off" line in proxy\reverse-proxy-enabled.flag, which the addon re-reads (via
REM mtime) on every request - see proxy\log_and_route_reverse.py. Other names' lines are left
REM untouched - there is no single switch for "every project at once" anymore. A request whose
REM arrival port matches nothing configured is logged under the reserved name "unknown", which
REM can be toggled the same way as any real project name.
REM
REM Not to be confused with wildfly-proxy-toggle\ (an unrelated Attach-API tool
REM that makes a WildFly JVM's own OUTBOUND calls go through the forward proxy). This
REM script only controls the REVERSE proxy in front of whatever upstream project(s), for
REM INBOUND calls into them - see docker-compose.yml's reverse-proxy service and
REM proxy\log_and_route_reverse.py. Assumes reverse-proxy is actually running - whether it runs
REM at all is settings.properties's reverse_proxy_enabled (deploy-time; false by default, many
REM environments only need OUTBOUND logging and never start this container). Not wired into
REM start.py/restart.py (each project's logging is independently runtime-toggleable rather than
REM flipped automatically on every start) - run this standalone, or use the Settings UI instead.
REM
REM Usage: toggle-wildfly-reverse-proxy.bat <name> [on|off|status]
REM        toggle-wildfly-reverse-proxy.bat status              (with no name: show every line)

setlocal
cd /d "%~dp0"

set "FLAG_FILE=proxy\reverse-proxy-enabled.flag"

REM Docker creates a DIRECTORY at a bind-mount's host path if "docker compose up" ever ran before
REM this file existed (e.g. a fresh clone - it's gitignored runtime state) - see docker-compose.yml's
REM reverse-proxy/backend services. start.py/restart.py now create this file up front to prevent
REM that, but self-heal here too in case this script runs standalone against an already-broken host.
if exist "%FLAG_FILE%\" (
    echo %FLAG_FILE% exists as a directory ^(created by an earlier "docker compose up" before this
    echo file existed^) - removing it so it can be a plain file. Restart reverse-proxy/backend
    echo afterward if they're already running, so they re-mount the file instead of the old directory.
    rd "%FLAG_FILE%"
)
if not exist "%FLAG_FILE%" type nul > "%FLAG_FILE%"

if "%~1"=="" goto usage

if /i "%~1"=="status" if "%~2"=="" (
    echo Reverse-proxy call logging, per project ^(a name with no line below defaults to on^):
    type "%FLAG_FILE%"
    goto :eof
)

set "NAME=%~1"
set "ACTION=%~2"
if "%ACTION%"=="" set "ACTION=status"

if /i "%ACTION%"=="on" goto set_value
if /i "%ACTION%"=="off" goto set_value
if /i "%ACTION%"=="status" goto show_status
goto usage

:set_value
REM Read-modify-write: drop any existing line for this name (findstr /v inverts the match, /b
REM anchors it at line-start, /c takes the search string literally), then append the new one -
REM so re-running never duplicates a line, matching this file's "one line per name" shape that
REM log_and_route_reverse.py/FileLoggingToggleAdapter both parse.
set "TMP_FILE=%TEMP%\reverse-proxy-toggle-%RANDOM%.tmp"
type nul > "%TMP_FILE%"
findstr /v /b /i /c:"%NAME%=" "%FLAG_FILE%" >> "%TMP_FILE%"
echo %NAME%=%ACTION%>> "%TMP_FILE%"
move /y "%TMP_FILE%" "%FLAG_FILE%" >nul
if /i "%ACTION%"=="on" (
    echo Reverse-proxy call logging for '%NAME%': ON ^(forwarding to its upstream is unaffected^)
) else (
    echo Reverse-proxy call logging for '%NAME%': OFF ^(calls still reach its upstream, just no longer logged^)
)
goto :eof

:show_status
set "CURRENT="
for /f "usebackq tokens=1,* delims==" %%A in ("%FLAG_FILE%") do (
    if /i "%%A"=="%NAME%" set "CURRENT=%%B"
)
if "%CURRENT%"=="" set "CURRENT=on (no line yet, defaults to on)"
echo Reverse-proxy call logging for '%NAME%' is currently: %CURRENT%
goto :eof

:usage
echo Usage: %~nx0 ^<name^> [on^|off^|status] 1>&2
echo        %~nx0 status                  ^(with no name: show every configured line^) 1>&2
exit /b 1
