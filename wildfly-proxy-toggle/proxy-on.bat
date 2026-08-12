@echo off
setlocal enabledelayedexpansion

rem proxy-on.bat - routes an already-running WildFly JVM's HTTPS traffic through Alfred's
rem forward-mode proxy (127.0.0.2:443 by default) by adding https.proxyHost/https.proxyPort
rem system properties via WildFly's management CLI. No restart, no standalone.xml hand-edit,
rem no IntelliJ run-config change. Run proxy-off.bat to reverse.
rem
rem Requires: WILDFLY_HOME set to the WildFly install directory, and its management interface
rem reachable (default localhost:9990).
rem
rem Usage:
rem   set WILDFLY_HOME=C:\wildfly-30.0.0.Final
rem   proxy-on.bat

if "%WILDFLY_HOME%"=="" (
    echo Set WILDFLY_HOME to your WildFly install directory first, e.g.:
    echo   set WILDFLY_HOME=C:\wildfly-30.0.0.Final
    exit /b 1
)
if "%CONTROLLER%"=="" set CONTROLLER=localhost:9990
if "%PROXY_HOST%"=="" set PROXY_HOST=127.0.0.2
if "%PROXY_PORT%"=="" set PROXY_PORT=443

set "CLI=%WILDFLY_HOME%\bin\jboss-cli.bat"
set "TMP_OUT=%TEMP%\alfred-proxy-toggle-%RANDOM%.log"

if not exist "%CLI%" (
    echo Could not find %CLI% - is WILDFLY_HOME set correctly?
    exit /b 1
)

rem Best-effort cleanup first so re-running this script is idempotent - a property that's
rem already set would otherwise make :add() fail with "already exists".
"%CLI%" --connect --controller=%CONTROLLER% --commands="/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()" >nul 2>&1

"%CLI%" --connect --controller=%CONTROLLER% --commands="/system-property=https.proxyHost:add(value=%PROXY_HOST%),/system-property=https.proxyPort:add(value=%PROXY_PORT%)" >"%TMP_OUT%" 2>&1
set RC=%ERRORLEVEL%
type "%TMP_OUT%"

findstr /C:"Failed to connect" "%TMP_OUT%" >nul
if not errorlevel 1 (
    echo.
    echo Could not reach WildFly's management interface at %CONTROLLER% - is WildFly running?
    del "%TMP_OUT%" >nul 2>&1
    exit /b 1
)
del "%TMP_OUT%" >nul 2>&1

if not "%RC%"=="0" (
    echo.
    echo Failed to enable the proxy - see output above.
    exit /b 1
)

echo.
echo Proxy ON - HTTPS traffic in this WildFly JVM now routes through %PROXY_HOST%:%PROXY_PORT%
echo Run proxy-off.bat to disable.
