@echo off
setlocal enabledelayedexpansion

rem proxy-off.bat - reverses proxy-on.bat: removes the https.proxyHost/https.proxyPort system
rem properties from this running WildFly JVM via the management CLI. Safe to run even if the
rem proxy was never turned on.
rem
rem Usage:
rem   set WILDFLY_HOME=C:\wildfly-30.0.0.Final
rem   proxy-off.bat

if "%WILDFLY_HOME%"=="" (
    echo Set WILDFLY_HOME to your WildFly install directory first, e.g.:
    echo   set WILDFLY_HOME=C:\wildfly-30.0.0.Final
    exit /b 1
)
if "%CONTROLLER%"=="" set CONTROLLER=localhost:9990

set "CLI=%WILDFLY_HOME%\bin\jboss-cli.bat"
set "TMP_OUT=%TEMP%\alfred-proxy-toggle-%RANDOM%.log"

if not exist "%CLI%" (
    echo Could not find %CLI% - is WILDFLY_HOME set correctly?
    exit /b 1
)

"%CLI%" --connect --controller=%CONTROLLER% --commands="/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()" >"%TMP_OUT%" 2>&1
set RC=%ERRORLEVEL%
type "%TMP_OUT%"

if "%RC%"=="0" goto :success

rem A "not found" error just means the proxy was already off (nothing to remove) - the desired
rem end state either way. Anything else - connection refused, auth failure, a CLI/server
rem management-protocol version mismatch, ... - is a real failure and must not be reported as
rem success just because it wasn't one of the two specific failures start.py/restart.py's
rem callers might otherwise expect.
findstr /I /C:"not found" "%TMP_OUT%" >nul
if errorlevel 1 (
    echo.
    echo Failed to disable the proxy - see output above. Is WildFly running, and does this
    echo jboss-cli's version match it closely enough to talk to its management interface?
    del "%TMP_OUT%" >nul 2>&1
    exit /b 1
)

:success
del "%TMP_OUT%" >nul 2>&1
echo.
echo Proxy OFF - HTTPS traffic in this WildFly JVM goes direct again.
pause
