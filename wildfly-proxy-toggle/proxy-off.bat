@echo off
setlocal enabledelayedexpansion

rem proxy-off.bat - reverses proxy-on.bat: compiles (if needed) and runs
rem WildFlyProxyController.java to remove the https.proxyHost/https.proxyPort system properties
rem from the detected WildFly instance via the Attach API. Safe to run even if the proxy was
rem never turned on.
rem
rem Requires JAVA_HOME set to a JDK 8 install (needs tools.jar for the Attach API).

if "%JAVA_HOME%"=="" (
    echo Set JAVA_HOME to a JDK 8 install first ^(needed for tools.jar / the Attach API^), e.g.:
    echo   set JAVA_HOME=C:\Program Files\Java\jdk1.8.0_XXX
    exit /b 1
)

set "DIR=%~dp0"
set "JAVAC=%JAVA_HOME%\bin\javac.exe"
set "JAVA=%JAVA_HOME%\bin\java.exe"
set "JAR=%JAVA_HOME%\bin\jar.exe"
set "TOOLS_JAR=%JAVA_HOME%\lib\tools.jar"

if not exist "%TOOLS_JAR%" (
    echo Could not find %TOOLS_JAR% - is JAVA_HOME a JDK 8 install, not a JRE?
    exit /b 1
)

if not exist "%DIR%out" mkdir "%DIR%out"
if not exist "%DIR%agent-out" mkdir "%DIR%agent-out"

"%JAVAC%" -d "%DIR%agent-out" "%DIR%WildFlyProxyAgent.java"
if errorlevel 1 exit /b 1

rem Same reasoning as proxy-on.bat - a unique filename avoids colliding with a jar some
rem still-running JVM already has locked open from an earlier proxy-on/proxy-off.
set "AGENT_JAR=%DIR%out\wildfly-agent-%RANDOM%.jar"
"%JAR%" cfm "%AGENT_JAR%" "%DIR%MANIFEST.MF" -C "%DIR%agent-out" .
if errorlevel 1 exit /b 1

"%JAVAC%" -cp "%TOOLS_JAR%" -d "%DIR%out" "%DIR%WildFlyProxyController.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out;%TOOLS_JAR%" -DAGENT_JAR="%AGENT_JAR%" WildFlyProxyController off
exit /b %ERRORLEVEL%
