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

"%CLI%" --connect --controller=%CONTROLLER% --commands="/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()" >"%TMP_OUT%" 2>&1
type "%TMP_OUT%"

rem "not recognized"/"cannot find the path" means jboss-cli.bat itself never ran (wrong
rem WILDFLY_HOME) - a real failure, not the benign "already off" case below.
findstr /C:"is not recognized" /C:"cannot find the path" "%TMP_OUT%" >nul
if not errorlevel 1 (
    echo.
    echo Could not run jboss-cli.bat - is WILDFLY_HOME set correctly?
    del "%TMP_OUT%" >nul 2>&1
    exit /b 1
)

findstr /C:"Failed to connect" "%TMP_OUT%" >nul
if not errorlevel 1 (
    echo.
    echo Could not reach WildFly's management interface at %CONTROLLER% - is WildFly running?
    del "%TMP_OUT%" >nul 2>&1
    exit /b 1
)
del "%TMP_OUT%" >nul 2>&1

rem Anything else - including a "not found" error, which just means the proxy was already
rem off - is the desired end state either way, unlike the two hard failures checked above.
echo.
echo Proxy OFF - HTTPS traffic in this WildFly JVM goes direct again.
