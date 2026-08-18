@echo off
REM Flips WildFly-traffic logging on/off live - no docker restart, no WildFly restart.
REM
REM wildfly-proxy (see docker-compose.yml) always owns host port 8080 and always
REM forwards to WildFly (WILDFLY_UPSTREAM) - that part never stops, so the frontend
REM keeps working at localhost:8080 either way. This script only flips whether the
REM addon also logs each call to backend, by writing "on"/"off" into
REM proxy\reverse-proxy-enabled.flag, which the addon re-reads (via mtime) on every
REM request - see proxy\log_and_route_reverse.py.
REM
REM Not to be confused with wildfly-proxy-toggle\ (an unrelated Attach-API tool
REM that makes WildFly's own OUTBOUND calls go through the forward proxy). This
REM script only controls the REVERSE proxy in front of WildFly, for the
REM frontend's INBOUND calls to it - see docker-compose.yml's wildfly-proxy
REM service and proxy\log_and_route_reverse.py. Wired into start.py/restart.py's
REM --wildfly-reverse-proxy [on|off] flag; run standalone any other time.
REM
REM Usage: toggle-wildfly-reverse-proxy.bat [on|off|status]

setlocal
cd /d "%~dp0"

set "FLAG_FILE=proxy\reverse-proxy-enabled.flag"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

if /i "%ACTION%"=="on" (
    echo on> "%FLAG_FILE%"
    echo WildFly call logging: ON ^(wildfly-proxy keeps forwarding to WildFly regardless^)
    goto :eof
)
if /i "%ACTION%"=="off" (
    echo off> "%FLAG_FILE%"
    echo WildFly call logging: OFF ^(calls still reach WildFly, just no longer logged^)
    goto :eof
)
if /i "%ACTION%"=="status" (
    set "CURRENT=on (file missing, defaults to on)"
    if exist "%FLAG_FILE%" set /p CURRENT=<"%FLAG_FILE%"
    echo WildFly call logging is currently: %CURRENT%
    goto :eof
)

echo Usage: %~nx0 [on^|off^|status]
exit /b 1
